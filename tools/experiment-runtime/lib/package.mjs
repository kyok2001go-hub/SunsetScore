import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { canonicalJson, compare, fail, hash, inventory, readSafe, removeOwned, runId, safePath } from '../../dataset/lib/common.mjs';
import { withOptimizationLock } from '../../optimization/lib/publish.mjs';

export const GOVERNANCE_KINDS = Object.freeze({ replay_quality_plan: 'replay_quality_plan_id',
  replay_quality_report: 'replay_quality_report_id', runtime_execution: 'execution_receipt_id',
  metric_rubric: 'rubric_id', metric_pilot: 'pilot_id', metric_review_plan: 'review_plan_id',
  semantic_evidence: 'semantic_evidence_id', campaign: 'campaign_id' });

/** Verify embedded, self-contained sources using the same canonical package identity as disk. */
export function inspectGovernanceSnapshot({ manifest, files }) {
  const kind = manifest?.descriptor?.package_kind, idField = GOVERNANCE_KINDS[kind];
  if (!idField || manifest.id_field !== idField) fail('GOVERNANCE_PACKAGE_INVALID');
  const entries = Object.fromEntries(Object.entries(files || {}).map(([name, value]) => {
    if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/.test(name)) fail('UNSAFE_PATH');
    const bytes = canonicalJson(value); return [name, { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }];
  }));
  if (canonicalJson(entries) !== canonicalJson(manifest.files)) fail('GOVERNANCE_FILE_MISMATCH');
  const { governance_schema_version, package_kind, files: declared, ...links } = manifest.descriptor;
  const digest = hash(canonicalJson(manifest.descriptor));
  const expected = { governance_schema_version: 1, id_field: idField,
    [idField]: `${kind}_v1_${digest.slice(0, 16)}`, ...links, descriptor: manifest.descriptor,
    descriptor_sha256: digest, files: declared };
  if (governance_schema_version !== 1 || canonicalJson(expected) !== canonicalJson(manifest) ||
      canonicalJson(entries) !== canonicalJson(declared)) fail('GOVERNANCE_PACKAGE_INVALID');
  return { manifest, files, status: 'PASS', validation_scope: 'PACKAGE_INTERNAL' };
}

export async function inspectGovernancePackage(directory) {
  const bytes = await readSafe(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  const kinds = GOVERNANCE_KINDS;
  if (kinds[manifest.descriptor?.package_kind] !== manifest.id_field) fail('GOVERNANCE_PACKAGE_INVALID');
  const digest = hash(canonicalJson(manifest.descriptor));
  const { governance_schema_version, package_kind, files: declared, ...links } = manifest.descriptor;
  const expected = { governance_schema_version: 1, id_field: kinds[package_kind],
    [kinds[package_kind]]: `${package_kind}_v1_${digest.slice(0, 16)}`, ...links,
    descriptor: manifest.descriptor, descriptor_sha256: digest, files: declared };
  if (canonicalJson(expected) !== canonicalJson(manifest)) fail('GOVERNANCE_PACKAGE_INVALID');
  if (canonicalJson(manifest) !== bytes.toString('utf8') || manifest.descriptor_sha256 !== digest ||
      manifest[manifest.id_field] !== `${manifest.descriptor.package_kind}_v1_${digest.slice(0, 16)}` ||
      manifest.governance_schema_version !== 1 ||
      canonicalJson(manifest.files) !== canonicalJson(manifest.descriptor.files)) fail('GOVERNANCE_PACKAGE_INVALID');
  if (canonicalJson(await inventory(directory)) !== canonicalJson(['manifest.json', ...Object.keys(manifest.files)].sort(compare))) fail('GOVERNANCE_INVENTORY_MISMATCH');
  const files = {};
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/.test(name)) fail('UNSAFE_PATH');
    const content = await readSafe(path.join(directory, name));
    if (hash(content) !== entry.sha256 || content.length !== entry.bytes ||
        canonicalJson(JSON.parse(content)) !== content.toString('utf8')) fail('GOVERNANCE_FILE_MISMATCH');
    files[name] = JSON.parse(content);
  }
  return inspectGovernanceSnapshot({ manifest, files });
}
export async function publishGovernancePackage({ output, kind, idField, payloads, links = {}, sourceCheck = async () => {}, validateStaging = async () => {} }) {
  for (const name of Object.keys(payloads)) if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.json$/.test(name)) fail('UNSAFE_PATH');
  const files = Object.fromEntries(Object.entries(payloads).map(([name, value]) => [name, canonicalJson(value)]));
  const entries = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { sha256: hash(value), bytes: Buffer.byteLength(value) }]));
  const descriptor = { governance_schema_version: 1, package_kind: kind, ...links, files: entries };
  const digest = hash(canonicalJson(descriptor)), id = `${kind}_v1_${digest.slice(0, 16)}`;
  const manifest = { governance_schema_version: 1, id_field: idField, [idField]: id, ...links,
    descriptor, descriptor_sha256: digest, files: entries };
  const stagingRoot = await safePath(path.join(output, 'staging'));
  await mkdir(stagingRoot, { recursive: true });
  const staging = path.join(stagingRoot, runId());
  await mkdir(staging);
  for (const [name, value] of Object.entries({ ...files, 'manifest.json': canonicalJson(manifest) })) {
    const file = await safePath(path.join(staging, name));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value, { flag: 'wx' });
  }
  await inspectGovernancePackage(staging);
  await validateStaging(staging);
  const target = await safePath(path.join(output, 'exports', id));
  await mkdir(path.dirname(target), { recursive: true });
  return withOptimizationLock(target + '.lock', async () => {
    await sourceCheck();
    try {
      const old = await inspectGovernancePackage(target);
      if (canonicalJson(old.manifest) !== canonicalJson(manifest)) fail('GOVERNANCE_ID_CONFLICT');
      await removeOwned(stagingRoot, staging);
      return { status: 'DEDUPLICATED', directory: target, [idField]: id };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staging, target);
    return { status: 'EXPORTED', directory: target, [idField]: id };
  });
}
