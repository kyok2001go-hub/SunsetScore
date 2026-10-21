import path from 'node:path';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { canonicalJson, compare, fail, hash, inventory, readSafe, removeOwned, runId, safePath, within } from '../../dataset/lib/common.mjs';
import { APP_ROOT } from '../../tuning/lib/engine-runtime.mjs';
import { withBuildLease } from '../../maintenance/lib/lease.mjs';
import { withOptimizationLock } from '../../optimization/lib/publish.mjs';

const exec = promisify(execFile);
// Explicit source families; no arbitrary config, payload, credentials or node_modules.
const FAMILIES = ['tools', 'server'];
export const MAPPING_EVIDENCE_FILES=Object.freeze(['index.html','admin/backfill.html']);
export function allowedSource(name) {
  return ['package.json', 'package-lock.json',...MAPPING_EVIDENCE_FILES].includes(name) ||
    /^js\/[a-zA-Z0-9_-]+\.js$/.test(name) ||
    /^(tools|server)\/[a-zA-Z0-9_./-]+\.(mjs|js|cjs)$/.test(name) &&
      !name.split('/').some(part => part.startsWith('.') || part === '..');
}
export function executionEnvironment() {
  return { node: process.version, platform: process.platform, architecture: process.arch };
}
export function cleanEnvironment() {
  return Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
}
export async function nodeProcess(script, args = [], { cwd = APP_ROOT, bundleSha256 } = {}) {
  try {
    const { stdout } = await exec(process.execPath, [script, ...args], {
      cwd, env: { ...cleanEnvironment(), ...(bundleSha256 ? { SUNSETSCORE_RUNTIME_BUNDLE_SHA256: bundleSha256 } : {}) },
      windowsHide: true, maxBuffer: 64 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    let result;
    try { result = JSON.parse(String(error.stdout || '').trim().split('\n').at(-1)); } catch {}
    fail(result?.error_code || 'ISOLATED_EXECUTION_FAILED', result?.reason_code ? { reason_code: result.reason_code } : {});
  }
}
async function sourceNames(root) {
  const names = ['package.json', 'package-lock.json'];
  // Optional for archived pre-product runtimes; exact public mapping evidence for new bundles.
  for(const name of MAPPING_EVIDENCE_FILES){try{await readSafe(path.join(root,name));names.push(name);}catch(error){if(error.code!=='ENOENT')throw error;}}
  for (const family of FAMILIES) {
    names.push(...(await inventory(path.join(root, family))).map(name => `${family}/${name}`).filter(allowedSource));
  }
  names.push(...(await readdir(path.join(root, 'js'))).map(name => `js/${name}`).filter(allowedSource));
  return names.sort(compare);
}
async function sourceInventory(root, names) {
  const result = {};
  for (const name of names) {
    if (!allowedSource(name) || !within(root, path.join(root, name))) fail('RUNTIME_SOURCE_NOT_ALLOWED');
    const bytes = await readSafe(path.join(root, name));
    result[name] = { sha256: hash(bytes), bytes: bytes.length };
  }
  return result;
}
export function auditImports(names, sources) {
  const declared = new Set(names);
  for (const name of names.filter(name => /\.(mjs|js|cjs)$/.test(name))) {
    const text = sources[name].toString('utf8');
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        if (spec !== 'jose') fail('RUNTIME_UNKNOWN_DEPENDENCY', { detail: `${name}:${spec}` });
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec));
      if (!declared.has(target)) fail('RUNTIME_IMPORT_NOT_ARCHIVED', { detail: name });
    }
  }
}
export async function fingerprintExecutionRoot(root = APP_ROOT) {
  return sourceInventory(root, await sourceNames(root));
}
async function identities(root) {
  // Import archived policies/registry, never the host checkout's versions.
  const code = `import {runtimeDocument} from ${JSON.stringify(pathToFileURL(path.join(root, 'tools/tuning/lib/engine-runtime.mjs')).href)};
    import {registryDocument} from ${JSON.stringify(pathToFileURL(path.join(root, 'tools/tuning/parameter-registry.mjs')).href)};
    import {canonicalJson,hash} from ${JSON.stringify(pathToFileURL(path.join(root, 'tools/dataset/lib/common.mjs')).href)};
    console.log(canonicalJson({runtime:await runtimeDocument(${JSON.stringify(root)}),registry_sha256:hash(canonicalJson(registryDocument()))}));`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code], {
    env: cleanEnvironment(), windowsHide: true, maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(stdout.trim());
}
async function gitEvidence(root) {
  try {
    const base = ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root];
    const head = (await exec('git', [...base, 'rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim();
    const status = (await exec('git', [...base, 'status', '--porcelain', '--untracked-files=all'], { windowsHide: true })).stdout;
    return { commit: /^[a-f0-9]{40}$/.test(head) ? head : null, worktree_clean: !status.trim() };
  } catch { return { commit: null, worktree_clean: null }; }
}
export async function verifyBundle(directory, { requireEnvironment = false } = {}) {
  const manifestBytes = await readSafe(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const descriptor = JSON.parse(await readSafe(path.join(directory, 'runtime_descriptor.json')));
  const files = JSON.parse(await readSafe(path.join(directory, 'file_inventory.json')));
  if (canonicalJson(Object.keys(manifest.files || {}).sort(compare)) !==
      canonicalJson(['file_inventory.json', 'reports/verification.json', 'runtime_descriptor.json'])) fail('RUNTIME_BUNDLE_INVALID');
  const digest = hash(canonicalJson(descriptor));
  const protocol = descriptor.experiment_runtime_protocol_version;
  const id = `experiment_runtime_v${protocol}_${digest.slice(0, 16)}`;
  if (![1, 2].includes(protocol) || manifest.experiment_runtime_protocol_version !== protocol ||
      descriptor.result_usage !== (protocol === 2 ? 'FORMAL_EXECUTION_CAPABLE' : 'DEVELOPMENT_ONLY') ||
      (protocol === 2 && descriptor.formal_contract_revision !== 1) ||
      manifest.runtime_bundle_id !== id || manifest.descriptor_sha256 !== digest ||
      canonicalJson(manifest.descriptor) !== canonicalJson(descriptor) ||
      hash(canonicalJson(files)) !== descriptor.file_inventory_sha256 ||
      canonicalJson(manifest) !== manifestBytes.toString('utf8')) fail('RUNTIME_BUNDLE_INVALID');
  const source = await safePath(path.join(directory, 'source'));
  const names = Object.keys(files).sort(compare);
  if (protocol === 2 && (!names.includes('tools/formal/context.mjs') ||
      !(await readSafe(path.join(source, 'tools/formal/contracts.mjs'))).toString('utf8').includes('export const FORMAL_CONTRACT_REVISION = 1;'))) fail('FORMAL_RUNTIME_PROTOCOL_UNSUPPORTED');
  if (canonicalJson(await inventory(source)) !== canonicalJson(names) ||
      canonicalJson(await sourceInventory(source, names)) !== canonicalJson(files)) fail('RUNTIME_BUNDLE_FILE_MISMATCH');
  for (const [name, info] of Object.entries(manifest.files)) {
    const bytes = await readSafe(path.join(directory, name));
    if (hash(bytes) !== info.sha256 || bytes.length !== info.bytes) fail('RUNTIME_BUNDLE_FILE_MISMATCH');
    if (canonicalJson(JSON.parse(bytes)) !== bytes.toString('utf8')) fail('RUNTIME_BUNDLE_INVALID');
  }
  if (canonicalJson(await inventory(directory)) !== canonicalJson([
    'manifest.json', ...Object.keys(manifest.files), ...names.map(name => `source/${name}`)
  ].sort(compare))) fail('RUNTIME_BUNDLE_INVENTORY_MISMATCH');
  const evaluator = names.filter(name => !name.startsWith('js/'));
  if (hash(canonicalJson(evaluator.map(name => [name, files[name].sha256]))) !== descriptor.evaluator_sha256 ||
      files['package-lock.json']?.sha256 !== descriptor.lockfile_sha256) fail('RUNTIME_BUNDLE_INVALID');
  const archived = Object.fromEntries(await Promise.all(names.filter(name => /\.(mjs|js|cjs)$/.test(name))
    .map(async name => [name, await readSafe(path.join(source, name))])));
  auditImports(names, archived);
  const identity = await identities(source);
  const report = JSON.parse(await readSafe(path.join(directory, 'reports/verification.json')));
  if (canonicalJson(report) !== canonicalJson({ status: 'PASS', protocol_version: protocol, identity })) fail('RUNTIME_BUNDLE_INVALID');
  if (identity.runtime.engine_runtime_sha256 !== descriptor.engine_runtime_sha256 ||
      identity.registry_sha256 !== descriptor.parameter_registry_sha256) fail('RUNTIME_BUNDLE_IDENTITY_MISMATCH');
  if (requireEnvironment && canonicalJson(executionEnvironment()) !== canonicalJson(descriptor.environment)) {
    fail('RUNTIME_EXECUTION_ENVIRONMENT_MISMATCH');
  }
  return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL', runtime_bundle_id: id,
    runtime_bundle_sha256: digest, manifest_sha256: hash(manifestBytes), source, descriptor };
}
export async function freezeRuntime({ sourceRoot = APP_ROOT, output = path.join(APP_ROOT, 'dataset/experiment_runtime'), protocolVersion = 1 } = {}) {
  if (![1, 2].includes(protocolVersion)) fail('INVALID_ARGUMENTS');
  const root = await safePath(sourceRoot), out = await safePath(output);
  if (within(out, root)) fail('UNSAFE_PATH');
  return withBuildLease('experiment_runtime', async () => {
    const names = await sourceNames(root);
    const before = await sourceInventory(root, names);
    const stagingRoot = await safePath(path.join(out, 'staging'));
    await mkdir(stagingRoot, { recursive: true });
    const staging = path.join(stagingRoot, runId());
    await mkdir(staging);
    const sources = {};
    for (const name of names) {
      const bytes = await readSafe(path.join(root, name));
      sources[name] = bytes;
      const file = path.join(staging, 'source', name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: 'wx' });
    }
    auditImports(names, sources);
    const identity = await identities(path.join(staging, 'source'));
    const descriptor = { experiment_runtime_protocol_version: protocolVersion,
      ...(protocolVersion === 2 ? { formal_contract_revision: 1 } : {}),
      engine_runtime_sha256: identity.runtime.engine_runtime_sha256,
      parameter_registry_sha256: identity.registry_sha256,
      evaluator_sha256: hash(canonicalJson(names.filter(name => !name.startsWith('js/')).map(name => [name, before[name].sha256]))),
      file_inventory_sha256: hash(canonicalJson(before)), environment: executionEnvironment(),
      lockfile_sha256: before['package-lock.json'].sha256, git: await gitEvidence(root),
      result_usage: protocolVersion === 2 ? 'FORMAL_EXECUTION_CAPABLE' : 'DEVELOPMENT_ONLY' };
    const digest = hash(canonicalJson(descriptor)), id = `experiment_runtime_v${protocolVersion}_${digest.slice(0, 16)}`;
    const payloads = { 'runtime_descriptor.json': canonicalJson(descriptor),
      'file_inventory.json': canonicalJson(before),
      'reports/verification.json': canonicalJson({ status: 'PASS', protocol_version: protocolVersion, identity }) };
    for (const [name, value] of Object.entries(payloads)) {
      await mkdir(path.dirname(path.join(staging, name)), { recursive: true });
      await writeFile(path.join(staging, name), value, { flag: 'wx' });
    }
    const manifest = { experiment_runtime_protocol_version: protocolVersion, runtime_bundle_id: id,
      descriptor, descriptor_sha256: digest, files: Object.fromEntries(Object.entries(payloads)
        .map(([name, value]) => [name, { sha256: hash(value), bytes: Buffer.byteLength(value) }])) };
    await writeFile(path.join(staging, 'manifest.json'), canonicalJson(manifest), { flag: 'wx' });
    await verifyBundle(staging);
    const target = await safePath(path.join(out, 'exports', id));
    await mkdir(path.dirname(target), { recursive: true });
    return withOptimizationLock(target + '.lock', async () => {
      if (canonicalJson(await sourceInventory(root, await sourceNames(root))) !== canonicalJson(before)) fail('RUNTIME_SOURCE_CHANGED');
      try {
        const existing = await verifyBundle(target);
        if (existing.runtime_bundle_sha256 !== digest) fail('RUNTIME_BUNDLE_ID_CONFLICT');
        await removeOwned(stagingRoot, staging);
        return { status: 'DEDUPLICATED', runtime_bundle_id: id, directory: target };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(staging, target);
      return { status: 'EXPORTED', runtime_bundle_id: id, directory: target };
    });
  }, { datasetRoot: path.dirname(out) });
}
