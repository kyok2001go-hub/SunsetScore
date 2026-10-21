import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { canonicalJson, fail, hash } from '../../dataset/lib/common.mjs';
import { readValidationInput, assertSourcesUnchanged, sourceIdentity } from './source.mjs';
import { buildValidationResult } from './build.mjs';
import { packageManifest } from './package.mjs';
import { APP_ROOT } from '../../tuning/lib/engine-runtime.mjs';
import { cleanEnvironment, fingerprintExecutionRoot } from '../../experiment-runtime/lib/bundle.mjs';

/** Internal pure calculation: no publication, no RUN_COMPLETED requirement. */
export async function recomputeValidation({ plan, paths, audited, root = APP_ROOT, legacy = false }) {
  await assertSourcesUnchanged(paths, audited.sourceFingerprints);
  if (canonicalJson(sourceIdentity(audited)) !== canonicalJson(plan.plan_core.source)) fail('VALIDATION_PLAN_SOURCE_CHANGED');
  const input = await readValidationInput(paths, audited, { root, mode: plan.plan_core.mode,
    validationPolicyVersion: plan.plan_core.validation_policy_version, loadReplay: true });
  if (input.validationCsvSha256 !== plan.plan_core.validation_csv_sha256) fail('VALIDATION_COHORT_CHANGED');
  const runner = (await import('../../replay/replay-runner.mjs')).runReplay;
  const built = await buildValidationResult({ plan, input, audited,
    runReplay: (replay, options) => runner(replay, { ...options, engineRoot: root }) });
  const manifest = packageManifest(built.files, plan.plan_id, { legacy });
  await assertSourcesUnchanged(paths, audited.sourceFingerprints);
  return { files: built.files, manifest };
}
export async function isolatedRecompute(job) {
  const executionRoot = job.plan?.plan_core?.validation_policy_version === 3 ? job.root || APP_ROOT : APP_ROOT;
  const script = job.plan?.plan_core?.validation_policy_version === 3 ? path.join(executionRoot, 'tools/validation/lib/recompute-worker.mjs') : fileURLToPath(new URL('./recompute-worker.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: executionRoot, env: cleanEnvironment(),
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.resume(); child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', code => {
      try {
        const result = JSON.parse(Buffer.concat(chunks));
        if (code || result.error_code) fail(result.error_code || 'ISOLATED_RECOMPUTE_FAILED', { reason_code: result.reason_code });
        resolve(result);
      } catch (error) { reject(error.code ? error : Object.assign(new Error('ISOLATED_RECOMPUTE_FAILED'), { code: 'ISOLATED_RECOMPUTE_FAILED' })); }
    });
    child.stdin.end(canonicalJson(job));
  });
}
export function compareRecompute(files, manifest, rebuilt) {
  const other = rebuilt.recomputed_file_inventory || rebuilt.files;
  const names = [...new Set([...Object.keys(files), ...Object.keys(other)])].sort();
  const differences = names.filter(name => rebuilt.recomputed_file_inventory ?
    typeof files[name] !== 'string' || other[name]?.sha256 !== hash(files[name]) || other[name]?.bytes !== Buffer.byteLength(files[name]) : files[name] !== other[name]);
  if (canonicalJson(manifest) !== canonicalJson(rebuilt.manifest)) differences.push('manifest.json');
  if (differences.length) fail('VALIDATION_RECOMPUTE_MISMATCH', { differing_files: differences });
  return { status: 'PASS', compared_file_count: names.length + 1, descriptor_sha256: manifest.descriptor_sha256 };
}
export async function validationFingerprint(paths, audited, protectedFiles = {}, root = APP_ROOT) {
  const execution = await fingerprintExecutionRoot(root);
  const dependencies = audited.manifest.optimization_policy_version === 4 ?
    await (await import('../../optimization-diagnostics/plan-binding.mjs')).developmentDependencyCheck(paths, audited.manifest) : async () => {};
  return async () => {
    const { hash, readSafe } = await import('../../dataset/lib/common.mjs');
    await assertSourcesUnchanged(paths, audited.sourceFingerprints);
    await dependencies();
    if (audited.formalContext) await (await import('../../formal/context.mjs')).validateFormalSourceContext(audited.formalContext, { ...paths, root }, { validateModel: false });
    if (canonicalJson(await fingerprintExecutionRoot(root)) !== canonicalJson(execution)) fail('VALIDATION_EXECUTION_SOURCE_CHANGED');
    for (const [file, digest] of Object.entries(protectedFiles)) {
      if (hash(await readSafe(file)) !== digest) fail('VALIDATION_PROTECTED_SOURCE_CHANGED');
    }
  };
}
