import path from 'node:path';
import { canonicalJson, fail, hash, readSafe } from '../dataset/lib/common.mjs';
import { loadOptimizationInput, fingerprintSourcePackage } from '../optimization/lib/input.mjs';
import { buildSearchSpace } from '../optimization/lib/search-space.mjs';
import { verifyBundle, fingerprintExecutionRoot } from '../experiment-runtime/lib/bundle.mjs';
import { historySnapshots, withHistoryLocks } from '../campaign/campaign.mjs';
import { appendLedger, ledgerPrefixMatches } from '../validation/lib/disclosure.mjs';
import { APP_ROOT } from '../tuning/lib/engine-runtime.mjs';
import { digest, members } from './engine.mjs';

export const SOURCE_KEYS = ['raw', 'gt', 'model', 'baseline', 'sensitivity'];
export async function readSources(file) {
  const doc = JSON.parse(await readSafe(file));
  const required = [...SOURCE_KEYS, 'runtimeBundle', 'historyLedgers', 'accessLedger'];
  if (doc.sources_schema_version !== 1 || required.some(key => typeof doc[key] !== 'string' || !doc[key]) ||
      Object.keys(doc).some(key => !['sources_schema_version', ...required].includes(key))) fail('INVALID_DIAGNOSTIC_SOURCES');
  return Object.fromEntries(required.map(key => [key, path.resolve(path.dirname(file), doc[key])]));
}
export async function loadDiagnosticSources(options) {
  const paths = options.sources ? await readSources(options.sources) : options;
  const root = options.root || APP_ROOT;
  const runtime = await verifyBundle(paths.runtimeBundle, { requireEnvironment: true });
  const inventory = await fingerprintExecutionRoot(root);
  const archivedInventory = JSON.parse(await readSafe(path.join(paths.runtimeBundle, 'file_inventory.json')));
  if (canonicalJson(inventory) !== canonicalJson(archivedInventory)) fail('DIAGNOSTIC_RUNTIME_SOURCE_MISMATCH');
  if (!archivedInventory['tools/optimization-diagnostics/engine.mjs']) fail('DIAGNOSTIC_RUNTIME_UNSUPPORTED');
  const input = await loadOptimizationInput({ ...paths, root, progress: options.progress, optimizationPolicyVersion: 4 });
  if (input.sensitivity.linkage.engineering_readiness?.status !== 'READY' ||
      input.sensitivity.readiness.global_readiness === 'NOT_READY') fail('DIAGNOSTIC_ENGINEERING_NOT_READY');
  const searchSpace = { ...buildSearchSpace({ mode: 'EXPLORATORY_SEARCH', registry: input.sensitivity.registry,
    readiness: input.sensitivity.readiness, baseConfig: input.sensitivity.baseConfig,
    linkage: input.sensitivity.linkage, policyVersion: 4 }), base_config: input.sensitivity.baseConfig };
  const ids = { raw: 'dataset_id', gt: 'ground_truth_id', model: 'model_dataset_id', baseline: 'evaluation_id', sensitivity: 'sensitivity_id' };
  const identities = {};
  for (const key of SOURCE_KEYS) {
    const bytes = await readSafe(path.join(paths[key], 'manifest.json'));
    identities[key] = { id: JSON.parse(bytes)[ids[key]], manifest_sha256: hash(bytes),
      package_fingerprint_sha256: digest(input.sourceFingerprints[key]) };
  }
  const history = await historySnapshots(paths);
  const sourceManifest = { sources_schema_version: 1, source_ids: identities,
    runtime: { id: runtime.runtime_bundle_id, manifest_sha256: runtime.manifest_sha256,
      engine_runtime_sha256: runtime.descriptor.engine_runtime_sha256, evaluator_sha256: runtime.descriptor.evaluator_sha256 },
    history_registry_sha256: hash(await readSafe(paths.historyLedgers)),
    history_prefixes: history.history.map(({ key, sequence, sha256 }) => ({ key, sequence, sha256 })) };
  return { paths, input, searchSpace, cohort: input.cohort, sourceManifest, runtime, root, history };
}
export async function checkDiagnosticSources(loaded, frozen) {
  for (const key of SOURCE_KEYS) if (digest(await fingerprintSourcePackage(loaded.paths[key])) !== frozen.source_ids[key].package_fingerprint_sha256) fail('DIAGNOSTIC_SOURCE_CHANGED');
  const runtime = await verifyBundle(loaded.paths.runtimeBundle, { requireEnvironment: true });
  if (runtime.manifest_sha256 !== frozen.runtime.manifest_sha256 ||
      canonicalJson(await fingerprintExecutionRoot(loaded.root)) !== canonicalJson(JSON.parse(await readSafe(path.join(loaded.paths.runtimeBundle, 'file_inventory.json'))))) fail('DIAGNOSTIC_RUNTIME_SOURCE_MISMATCH');
  if (hash(await readSafe(loaded.paths.historyLedgers)) !== frozen.history_registry_sha256) fail('DIAGNOSTIC_HISTORY_CHANGED');
  const histories = await historySnapshots(loaded.paths);
  if (canonicalJson(histories.history.map(h => h.key)) !== canonicalJson(frozen.history_prefixes.map(h => h.key))) fail('DIAGNOSTIC_HISTORY_CHANGED');
  for (const prefix of frozen.history_prefixes) if (!ledgerPrefixMatches(histories.history.find(h => h.key === prefix.key), prefix)) fail('DIAGNOSTIC_HISTORY_CHANGED');
}
export async function recordDiagnosticAccess(loaded, planId, stage, purpose = 'OPTIMIZATION_DIAGNOSTICS_TRAIN_ONLY') {
  const histories = await historySnapshots(loaded.paths);
  return withHistoryLocks(histories.roots, async () => {
    const roots = new Map(Object.values(histories.roots).map(root => [process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root), root]));
    for (const root of roots.values()) await appendLedger(root, { action: 'TRAIN_EFFECT_ACCESS', stage, plan_id: planId,
      model_dataset_id: loaded.input.model.manifest.model_dataset_id, result_usage: 'DEVELOPMENT_ONLY',
      members: members(loaded.cohort), purpose });
  });
}
