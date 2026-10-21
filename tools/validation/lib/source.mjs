import path from 'node:path';
import { canonicalJson, compare, fail, hash, readSafe, safePath, within } from '../../dataset/lib/common.mjs';
import { inspectOptimization } from '../../optimization/validate-optimization.mjs';
import { fingerprintSourcePackage, loadEvaluationIdentity, loadSensitivityPackage } from '../../optimization/lib/input.mjs';
import { buildSearchSpace, publicSearchSpace } from '../../optimization/lib/search-space.mjs';
import { canonicalizeCandidate } from '../../optimization/lib/candidate.mjs';
import { loadModelHeader, readSplitRows } from '../../tuning/lib/input.mjs';
import { runtimeDocument, APP_ROOT } from '../../tuning/lib/engine-runtime.mjs';
import { loadReplayCohort } from '../../tuning/lib/replay-cohort.mjs';
import { validationSupport } from '../validation-policy.mjs';
import { assertFormalModelRows, inspectFormalContext, formalContextIdentity } from '../../formal/context.mjs';

export const SOURCE_KEYS = Object.freeze(['raw', 'gt', 'model', 'baseline', 'sensitivity', 'optimization']);
export const EXPERIMENT_PATH_KEYS = Object.freeze([...SOURCE_KEYS, 'campaign', 'metricEvidence', 'runtimeBundle', 'historyLedgers', 'accessLedger',
  'diagnosticPlan', 'diagnosticResult', 'optimizationPlan', 'sources']);
export const MODEL_ALLOW_FILES = Object.freeze([
  'manifest.json', 'schema.json', 'policy.json', 'splits/validation.csv'
]);

function assert(condition, reason) {
  if (!condition) fail('VALIDATION_VALIDATION_FAILED', { reason_code: reason });
}

async function canonicalFile(directory, file) {
  const bytes = await readSafe(path.join(directory, file));
  const value = JSON.parse(bytes.toString('utf8'));
  assert(canonicalJson(value) === bytes.toString('utf8'), 'JSON_NOT_CANONICAL');
  return { value, sha256: hash(bytes) };
}

/** Full Phase A attestation; the Phase B reader below has a separate VALIDATION-only allowlist. */
export async function auditSources(paths, options = {}) {
  for (const key of SOURCE_KEYS) assert(typeof paths[key] === 'string' && paths[key], 'SOURCE_PATH_MISSING');
  const initialFingerprints = {};
  for (const key of SOURCE_KEYS) initialFingerprints[key] = await fingerprintSourcePackage(paths[key]);
  const { value: manifest, sha256: manifestSha256 } = await canonicalFile(paths.optimization, 'manifest.json');
  const currentRuntime = await runtimeDocument(options.root || APP_ROOT);
  assert(currentRuntime.engine_runtime_sha256 === manifest.engine_runtime_sha256,
    'RUNTIME_MISMATCH');
  const verified = await inspectOptimization(paths.optimization, {
    ...options,
    model: paths.model, raw: paths.raw, gt: paths.gt,
    baseline: paths.baseline, sensitivity: paths.sensitivity,
    progress: options.progress, root: options.root
  });
  assert(verified.validation_scope === 'SOURCE_LINKED_RECOMPUTED', 'OPTIMIZATION_SOURCE_NOT_RECOMPUTED');
  const { value: finalists } = await canonicalFile(paths.optimization, 'finalists.json');
  const { value: searchSpace } = await canonicalFile(paths.optimization, 'search_space.json');
  const { value: frozenPolicy } = await canonicalFile(paths.optimization, 'policy.json');
  const sourceFingerprints = {};
  const sourceManifestHashes = {};
  const sourceDescriptorHashes = {};
  for (const key of SOURCE_KEYS) {
    sourceFingerprints[key] = await fingerprintSourcePackage(paths[key]);
    sourceManifestHashes[key] = sourceFingerprints[key]['manifest.json'];
    const { value: sourceManifest } = await canonicalFile(paths[key], 'manifest.json');
    sourceDescriptorHashes[key] = sourceManifest.descriptor_sha256 ?? null;
  }
  assert(manifestSha256 === sourceManifestHashes.optimization, 'OPTIMIZATION_MANIFEST_CHANGED');
  assert(canonicalJson(initialFingerprints) === canonicalJson(sourceFingerprints), 'SOURCE_CHANGED_DURING_ATTESTATION');
  assert(manifest.model_dataset_manifest_sha256 === sourceManifestHashes.model &&
    manifest.evaluation_manifest_sha256 === sourceManifestHashes.baseline &&
    manifest.sensitivity_manifest_sha256 === sourceManifestHashes.sensitivity, 'SOURCE_MANIFEST_MISMATCH');
  const formalContext = manifest.optimization_policy_version === 3 ? inspectFormalContext((await canonicalFile(paths.optimization, 'formal_context.json')).value) : null;
  return { manifest, manifestSha256, finalists, searchSpace, frozenPolicy, formalContext,
    sourceFingerprints, sourceManifestHashes, sourceDescriptorHashes };
}

/** Only four Model files can be opened in Phase B. TEST and aggregate sample tables stay unreachable. */
export async function readValidationInput(paths, audited, options = {}) {
  const version = options.validationPolicyVersion ?? 1;
  assert(audited.manifest.optimization_policy_version === version, 'OPTIMIZATION_VALIDATION_POLICY_COMBINATION_UNSUPPORTED');
  const header = await loadModelHeader(paths.model, { allowFiles: MODEL_ALLOW_FILES, progress: options.progress });
  const rows = await readSplitRows(paths.model, { manifest: header.manifest,
    schemaVersion: header.schemaVersion, split: 'VALIDATION',
    allowFiles: MODEL_ALLOW_FILES, progress: options.progress });
  assert(audited.manifest.model_dataset_id === header.manifest.model_dataset_id &&
    audited.sourceManifestHashes.model === hash(await readSafe(path.join(paths.model, 'manifest.json'))),
  'MODEL_IDENTITY_MISMATCH');
  const { sha256: validationCsvSha256 } = await (async () => {
    const bytes = await readSafe(path.join(paths.model, 'splits/validation.csv'));
    return { sha256: hash(bytes) };
  })();
  assert(validationCsvSha256 === header.manifest.files['splits/validation.csv']?.sha256,
    'VALIDATION_CSV_HASH_MISMATCH');
  const sensitivity = await loadSensitivityPackage(paths.sensitivity, { progress: options.progress });
  const evaluation = await loadEvaluationIdentity(paths.baseline);
  assert(sensitivity.linkage.model_dataset_id === header.manifest.model_dataset_id &&
    sensitivity.linkage.evaluation_id === evaluation.evaluation_id &&
    sensitivity.linkage.engine_runtime_sha256 === audited.manifest.engine_runtime_sha256,
  'SENSITIVITY_LINKAGE_MISMATCH');
  const currentRuntime = await runtimeDocument(options.root || APP_ROOT);
  assert(currentRuntime.engine_runtime_sha256 === audited.manifest.engine_runtime_sha256,
    'RUNTIME_MISMATCH');
  const searchSpaceBase = buildSearchSpace({
    mode: audited.manifest.optimization_mode, registry: sensitivity.registry,
    readiness: sensitivity.readiness, baseConfig: sensitivity.baseConfig,
    linkage: sensitivity.linkage, policyVersion: audited.manifest.optimization_policy_version
  });
  assert(canonicalJson(publicSearchSpace(searchSpaceBase)) === canonicalJson(audited.searchSpace),
    'SEARCH_SPACE_MISMATCH');
  const searchSpace = { ...searchSpaceBase, optimization_input_id: audited.manifest.optimization_input_id };
  const formal = options.mode === 'FORMAL_VALIDATION';
  const finalists = audited.finalists.finalists.filter(item =>
    item.selection_status === (version === 4 ? 'TRAIN_QUALIFIED_DEVELOPMENT_CANDIDATE' : formal ? 'FORMAL_FINALIST' : 'TOP_SEARCH_POINT'));
  assert(finalists.length === audited.finalists.finalists.length && finalists.length <= 5,
    'CANDIDATE_SET_INVALID');
  const candidateIds = new Set();
  const candidates = finalists.map(item => {
    const resolved = canonicalizeCandidate({ vector: item.canonical_vector,
      searchSpace, baseConfig: sensitivity.baseConfig,
      optimizationInputId: audited.manifest.optimization_input_id });
    assert(resolved.ok && resolved.candidate_id === item.candidate_id &&
      resolved.effective_config_sha256 === item.effective_config_sha256,
    'CANDIDATE_ID_MISMATCH');
    assert(!candidateIds.has(item.candidate_id), 'DUPLICATE_CANDIDATE');
    candidateIds.add(item.candidate_id);
    return { ...item, resolved };
  });
  const support = validationSupport(rows, version);
  if (version === 3) {
    assertFormalModelRows(audited.formalContext, rows, 'VALIDATION');
    const identity = formalContextIdentity(audited.formalContext);
    for (const [key, value] of Object.entries(identity)) assert(sensitivity.linkage[key] === value && audited.manifest[key] === value, 'FORMAL_SOURCE_CONTEXT_MISMATCH');
  }
  let cohort = null;
  if (options.loadReplay) {
    for (const row of rows) {
      const replayFile = await safePath(path.join(paths.raw, row.replay_path));
      assert(within(paths.raw, replayFile), 'REPLAY_PATH_OUTSIDE_RAW');
    }
    cohort = await loadReplayCohort({ rows, rawDir: paths.raw, progress: options.progress });
  }
  return { header, rows, cohort, support, candidates, sensitivity,
    evaluation, currentRuntime, validationCsvSha256, searchSpace };
}

export function sourceIdentity(audited) {
  return Object.fromEntries(SOURCE_KEYS.map(key => [key, {
    id: key === 'raw' ? audited.manifest.source_dataset_id
      : key === 'gt' ? audited.manifest.ground_truth_id
        : key === 'model' ? audited.manifest.model_dataset_id
          : key === 'baseline' ? audited.manifest.evaluation_id
            : key === 'sensitivity' ? audited.manifest.sensitivity_id
              : audited.manifest.optimization_id,
    manifest_sha256: audited.sourceManifestHashes[key],
    descriptor_sha256: audited.sourceDescriptorHashes[key]
  }]));
}

export async function assertSourcesUnchanged(paths, fingerprints) {
  for (const key of SOURCE_KEYS) {
    const now = await fingerprintSourcePackage(paths[key]);
    if (canonicalJson(now) !== canonicalJson(fingerprints[key])) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'SOURCE_CHANGED_DURING_VALIDATION', source: key });
    }
  }
}
