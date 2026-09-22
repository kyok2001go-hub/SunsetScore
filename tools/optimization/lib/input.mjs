import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { canonicalJson, compare, fail, hash, inventory, readSafe, safePath, unique } from '../../dataset/lib/common.mjs';
import { silentProgress } from '../../progress.mjs';
import { loadModelHeader, readRestrictedFile, readSplitRows, verifyUpstreamSources } from '../../tuning/lib/input.mjs';
import { loadReplayCohort } from '../../tuning/lib/replay-cohort.mjs';
import { runtimeDocument } from '../../tuning/lib/engine-runtime.mjs';
import { inspectEvaluation } from '../../evaluation/validate-evaluation.mjs';
import { inspectSensitivity } from '../../tuning/validate-sensitivity.mjs';

/**
 * Phase 6 access boundary.
 *
 * Phase A (`verifyUpstreamSources`) may open the whole Model / Raw / GT tree to prove source
 * linkage and split legality. Phase B never goes through that path: it reads the Model through
 * the TRAIN-only allowlist and the Sensitivity package through the fixed list below, so
 * VALIDATION / TEST rows and effect reports are unreachable from the search engine.
 */
export const MODEL_ALLOW_FILES = Object.freeze(['manifest.json', 'schema.json', 'policy.json', 'splits/train.csv']);
export const SENSITIVITY_ALLOW_FILES = Object.freeze([
  'manifest.json', 'schema.json', 'policy.json', 'readiness.json',
  'parameter_registry.json', 'tuning_base_config.json', 'engine_runtime.json'
]);

export async function assertDirectory(target, reasonCode) {
  const resolved = await safePath(target);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: reasonCode, detail: resolved });
    throw error;
  }
  if (!info.isDirectory()) fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: reasonCode, detail: resolved });
  return resolved;
}

/**
 * Every Sensitivity read states the file it wants. Anything outside the frozen list fails with
 * `OPTIMIZATION_ACCESS_FORBIDDEN`, so an Optimization process cannot widen into Sensitivity
 * sample rows, VALIDATION data or TEST data.
 */
export async function readSensitivityFile(directory, relativeFile) {
  const normalized = String(relativeFile).replaceAll('\\', '/');
  if (!SENSITIVITY_ALLOW_FILES.includes(normalized)) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'OPTIMIZATION_ACCESS_FORBIDDEN', attempted_file: normalized });
  }
  await safePath(directory);
  return readSafe(path.join(directory, relativeFile));
}

function parseCanonical(bytes, file) {
  const text = bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'JSON_INVALID', detail: file });
  }
  if (canonicalJson(value) !== text) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL', detail: file });
  }
  return value;
}

async function fingerprintSensitivity(directory) {
  const result = {};
  for (const file of SENSITIVITY_ALLOW_FILES) result[file] = hash(await readSensitivityFile(directory, file));
  return result;
}

/** Full immutable-package fingerprint used before and after the potentially long search. */
export async function fingerprintSourcePackage(directory) {
  await assertDirectory(directory, 'SOURCE_PACKAGE_NOT_FOUND');
  const files = (await inventory(directory)).sort(compare);
  const fingerprints = {};
  for (const file of files) fingerprints[file] = hash(await readSafe(path.join(directory, file)));
  return fingerprints;
}

async function inspectForwardCompatiblePackage(directory, manifest, label) {
  const expected = [...Object.keys(manifest.files || {}), 'manifest.json'].sort(compare);
  const actual = (await inventory(directory)).sort(compare);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: `${label}_INVENTORY_MISMATCH` });
  }
  for (const file of Object.keys(manifest.files).sort(compare)) {
    const bytes = await readSafe(path.join(directory, file));
    const entry = manifest.files[file];
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: `${label}_FILE_HASH`, detail: file });
    }
  }
  if (hash(canonicalJson(manifest.descriptor)) !== manifest.descriptor_sha256) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: `${label}_DESCRIPTOR_SHA_MISMATCH` });
  }
  return manifest;
}

async function inspectForwardCompatibleSensitivity(directory, manifest) {
  if (!Number.isInteger(manifest.tuning_schema_version) || manifest.tuning_schema_version < 2 ||
      !Number.isInteger(manifest.tuning_policy_version) || manifest.tuning_policy_version < 3) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_VERSION_UNSUPPORTED' });
  }
  return inspectForwardCompatiblePackage(directory, manifest, 'SENSITIVITY');
}

async function inspectForwardCompatibleEvaluation(directory, manifest) {
  if (!Number.isInteger(manifest.evaluation_schema_version) || manifest.evaluation_schema_version < 2 ||
      !Number.isInteger(manifest.evaluation_policy_version) || manifest.evaluation_policy_version < 3) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'EVALUATION_VERSION_UNSUPPORTED' });
  }
  await inspectForwardCompatiblePackage(directory, manifest, 'EVALUATION');
  const schema = parseCanonical(await readSafe(path.join(directory, 'schema.json')), 'schema.json');
  const sourcePolicy = parseCanonical(await readSafe(path.join(directory, 'policy.json')), 'policy.json');
  if (schema.evaluation_schema_version !== manifest.evaluation_schema_version ||
      sourcePolicy.evaluation_policy_version !== manifest.evaluation_policy_version) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'EVALUATION_VERSION_MISMATCH' });
  }
  return manifest;
}

/**
 * Phase B Sensitivity reader. The frozen Registry, Base Config and Runtime identity all come
 * from the package, never from the present repository, so a campaign can be re-derived later.
 */
export async function loadSensitivityPackage(directory, options = {}) {
  const progress = options.progress || silentProgress;
  await assertDirectory(directory, 'SENSITIVITY_PACKAGE_NOT_FOUND');
  progress.stage('读取 Sensitivity 冻结身份');
  const before = await fingerprintSensitivity(directory);
  const manifestBytes = await readSensitivityFile(directory, 'manifest.json');
  const manifest = parseCanonical(manifestBytes, 'manifest.json');
  if (!Number.isInteger(manifest.tuning_schema_version) || manifest.tuning_schema_version < 2 ||
      !Number.isInteger(manifest.tuning_policy_version) || manifest.tuning_policy_version < 2) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_VERSION_UNSUPPORTED' });
  }
  if (!options.staging && path.basename(path.resolve(directory)) !== manifest.sensitivity_id) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_DIRECTORY_ID_MISMATCH' });
  }
  if (hash(canonicalJson(manifest.descriptor)) !== manifest.descriptor_sha256) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_DESCRIPTOR_SHA_MISMATCH' });
  }
  for (const file of SENSITIVITY_ALLOW_FILES) {
    if (file === 'manifest.json') continue;
    const entry = manifest.files?.[file];
    if (!entry) fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_FILE_UNDECLARED', detail: file });
    const bytes = await readSensitivityFile(directory, file);
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_FILE_HASH', detail: file });
    }
  }
  const registry = parseCanonical(await readSensitivityFile(directory, 'parameter_registry.json'), 'parameter_registry.json');
  const baseConfig = parseCanonical(await readSensitivityFile(directory, 'tuning_base_config.json'), 'tuning_base_config.json');
  const runtime = parseCanonical(await readSensitivityFile(directory, 'engine_runtime.json'), 'engine_runtime.json');
  const readiness = parseCanonical(await readSensitivityFile(directory, 'readiness.json'), 'readiness.json');
  const schema = parseCanonical(await readSensitivityFile(directory, 'schema.json'), 'schema.json');
  const sourcePolicy = parseCanonical(await readSensitivityFile(directory, 'policy.json'), 'policy.json');
  if (schema.tuning_schema_version !== manifest.tuning_schema_version ||
      sourcePolicy.tuning_policy_version !== manifest.tuning_policy_version) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_VERSION_MISMATCH' });
  }
  if (hash(canonicalJson(registry)) !== manifest.parameter_registry_sha256) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'PARAMETER_REGISTRY_SHA_MISMATCH' });
  }
  if (!Array.isArray(registry.units) || !registry.units.length) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'PARAMETER_REGISTRY_EMPTY' });
  }
  if (hash(canonicalJson(baseConfig.config)) !== baseConfig.sha256 ||
      baseConfig.sha256 !== manifest.tuning_base_config_sha256) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'TUNING_BASE_CONFIG_SHA_MISMATCH' });
  }
  if (manifest.source_validation_scope !== 'SOURCE_LINKED' || manifest.computation_access_policy !== 'TRAIN_ONLY') {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_ACCESS_SCOPE_UNSUPPORTED' });
  }
  if (canonicalJson(manifest.evaluated_splits) !== canonicalJson(['TRAIN']) ||
      manifest.validation_evaluated !== false || manifest.test_evaluated !== false) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_HOLDOUT_CONTRACT' });
  }
  const after = await fingerprintSensitivity(directory);
  if (canonicalJson(before) !== canonicalJson(after)) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SENSITIVITY_CHANGED_DURING_READ' });
  }
  return {
    manifest,
    manifestSha256: after['manifest.json'],
    registry,
    baseConfig,
    runtime,
    readiness,
    linkage: {
      sensitivity_id: manifest.sensitivity_id,
      tuning_schema_version: manifest.tuning_schema_version,
      tuning_policy_version: manifest.tuning_policy_version,
      sensitivity_manifest_sha256: after['manifest.json'],
      sensitivity_descriptor_sha256: manifest.descriptor_sha256,
      parameter_registry_version: manifest.parameter_registry_version,
      parameter_registry_sha256: manifest.parameter_registry_sha256,
      tuning_base_config_sha256: manifest.tuning_base_config_sha256,
      engine_runtime_sha256: manifest.engine_runtime_sha256,
      model_dataset_id: manifest.model_dataset_id,
      model_dataset_manifest_sha256: manifest.model_dataset_manifest_sha256,
      model_dataset_descriptor_sha256: manifest.model_dataset_descriptor_sha256,
      source_dataset_id: manifest.source_dataset_id,
      ground_truth_id: manifest.ground_truth_id,
      evaluation_id: manifest.evaluation_id,
      evaluation_manifest_sha256: manifest.evaluation_manifest_sha256,
      engineering_readiness: manifest.engineering_readiness,
      data_readiness: manifest.data_readiness,
      metric_readiness: manifest.metric_readiness,
      result_usage: manifest.result_usage,
      mapping_status: manifest.mapping_status,
      interpretation_scope: manifest.interpretation_scope,
      no_skill_reference_ordinal: manifest.no_skill_reference_ordinal,
      validation_disclosure_status: manifest.validation_disclosure_status === 'NOT_ATTESTED'
        ? 'DEVELOPMENT_EXPOSED' : manifest.validation_disclosure_status,
      validation_disclosure_evidence_id: manifest.validation_disclosure_evidence_id ?? null,
      validation_disclosure_evidence_sha256: manifest.validation_disclosure_evidence_sha256 ?? null,
      validation_access_ledger_sha256: manifest.validation_access_ledger_sha256 ?? null
    },
    fingerprints: after
  };
}

/** Phase B Evaluation reader: identity fields only, never the Evaluation sample tables. */
export async function loadEvaluationIdentity(directory) {
  await assertDirectory(directory, 'BASELINE_PACKAGE_NOT_FOUND');
  const bytes = await readSafe(path.join(directory, 'manifest.json'));
  const manifest = parseCanonical(bytes, 'manifest.json');
  if (path.basename(path.resolve(directory)) !== manifest.evaluation_id) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'EVALUATION_DIRECTORY_ID_MISMATCH' });
  }
  if (manifest.test_evaluated !== false || manifest.test_evaluation_sample_count !== 0) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'EVALUATION_EVALUATED_TEST' });
  }
  return {
    evaluation_id: manifest.evaluation_id,
    evaluation_manifest_sha256: hash(bytes),
    evaluation_schema_version: manifest.evaluation_schema_version,
    evaluation_policy_version: manifest.evaluation_policy_version,
    evaluation_validation_scope: manifest.upstream_validation_scope ?? manifest.validation_scope ?? null,
    evaluation_evaluated_splits: manifest.evaluated_splits,
    model_dataset_id: manifest.model_dataset_id,
    model_dataset_manifest_sha256: manifest.model_dataset_manifest_sha256,
    model_dataset_descriptor_sha256: manifest.model_dataset_descriptor_sha256,
    mapping_status: manifest.mapping_status,
    interpretation_scope: manifest.interpretation_scope,
    no_skill_reference_ordinal: manifest.no_skill_reference?.reference_ordinal ?? null,
    no_skill_reference_gt_label: manifest.no_skill_reference?.reference_gt_label ?? null
  };
}

export function cohortSummary(rows) {
  return {
    sample_count: rows.length,
    event_count: unique(rows.map(row => row.event_id)).length,
    date_count: unique(rows.map(row => row.event_date_local)).length
  };
}

/**
 * The one entry point the Optimization pipeline uses. It performs Phase A, then Phase B with
 * frozen identities, and refuses to continue when the frozen Runtime no longer matches the
 * engine that would actually replay the candidates.
 */
export async function loadOptimizationInput({ model, raw, gt, baseline, sensitivity, progress = silentProgress, root }) {
  progress.stage('Phase A：上游来源关联验收');
  const upstream = await verifyUpstreamSources(model, raw, gt, progress);
  const evaluationManifest = parseCanonical(await readSafe(path.join(baseline, 'manifest.json')), 'manifest.json');
  if ([1, 2].includes(evaluationManifest.evaluation_schema_version) &&
      [1, 2].includes(evaluationManifest.evaluation_policy_version)) {
    await inspectEvaluation(baseline, { model, progress });
  } else {
    await inspectForwardCompatibleEvaluation(baseline, evaluationManifest);
  }
  const sensitivityManifest = parseCanonical(await readSafe(path.join(sensitivity, 'manifest.json')), 'manifest.json');
  if (sensitivityManifest.tuning_schema_version === 2 && sensitivityManifest.tuning_policy_version === 2) {
    await inspectSensitivity(sensitivity, { model, raw, gt, baseline, progress, root });
  } else {
    await inspectForwardCompatibleSensitivity(sensitivity, sensitivityManifest);
  }
  const sourceFingerprints = {};
  for (const [name, directory] of Object.entries({ model, raw, gt, baseline, sensitivity })) {
    sourceFingerprints[name] = await fingerprintSourcePackage(directory);
  }
  await assertDirectory(model, 'MODEL_PACKAGE_NOT_FOUND');

  progress.stage('Phase B：读取 TRAIN-only Model 白名单');
  const header = await loadModelHeader(model, { allowFiles: MODEL_ALLOW_FILES, progress });
  const rows = await readSplitRows(model, {
    manifest: header.manifest, schemaVersion: header.schemaVersion,
    split: 'TRAIN', allowFiles: MODEL_ALLOW_FILES, progress
  });
  const modelFingerprints = {};
  for (const file of MODEL_ALLOW_FILES) {
    modelFingerprints[file] = hash(await readRestrictedFile(model, file, { allowFiles: MODEL_ALLOW_FILES }));
  }
  if (canonicalJson(header.fingerprintsBefore) !== canonicalJson(modelFingerprints)) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'MODEL_CHANGED_DURING_READ' });
  }

  const sensitivityInput = await loadSensitivityPackage(sensitivity, { progress });
  const evaluation = await loadEvaluationIdentity(baseline);

  const modelDatasetId = header.manifest.model_dataset_id;
  const evaluationId = evaluation.evaluation_id;
  const linkage = sensitivityInput.linkage;
  const checks = [
    ['MODEL_DATASET_MISMATCH', linkage.model_dataset_id === modelDatasetId],
    ['MODEL_MANIFEST_SHA_MISMATCH', linkage.model_dataset_manifest_sha256 === modelFingerprints['manifest.json']],
    ['MODEL_DESCRIPTOR_SHA_MISMATCH', linkage.model_dataset_descriptor_sha256 === header.manifest.descriptor_sha256],
    ['EVALUATION_ID_MISMATCH', linkage.evaluation_id === evaluationId],
    ['EVALUATION_MANIFEST_SHA_MISMATCH', linkage.evaluation_manifest_sha256 === evaluation.evaluation_manifest_sha256],
    ['EVALUATION_MODEL_MISMATCH', evaluation.model_dataset_id === modelDatasetId],
    ['EVALUATION_HOLDOUT_CONTRACT', canonicalJson(evaluation.evaluation_evaluated_splits) === canonicalJson(['TRAIN'])]
  ];
  for (const [reason, ok] of checks) {
    if (!ok) fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: reason });
  }

  progress.stage('校验冻结 Runtime 与 Base Config');
  const runtime = await runtimeDocument(root);
  if (runtime.engine_runtime_sha256 !== sensitivityInput.linkage.engine_runtime_sha256) {
    fail('OPTIMIZATION_VALIDATION_FAILED', {
      reason_code: 'RUNTIME_MISMATCH',
      detail: { frozen: sensitivityInput.linkage.engine_runtime_sha256, current: runtime.engine_runtime_sha256 }
    });
  }

  progress.stage('读取 TRAIN Replay 载荷并绑定身份');
  const cohort = await loadReplayCohort({ rows, rawDir: raw, progress });

  return {
    upstream,
    sourceFingerprints,
    model: {
      manifest: header.manifest,
      manifestSha256: modelFingerprints['manifest.json'],
      schemaVersion: header.schemaVersion,
      policyVersion: header.policyVersion,
      rows,
      fingerprints: modelFingerprints
    },
    evaluation,
    sensitivity: sensitivityInput,
    runtime,
    cohort,
    summary: cohortSummary(rows)
  };
}

/** Source identity material that enters `optimization_input_id` and verified_source_identities.json. */
export function sourceIdentity(input) {
  return {
    model_dataset_id: input.model.manifest.model_dataset_id,
    model_dataset_manifest_sha256: input.model.manifestSha256,
    model_dataset_descriptor_sha256: input.model.manifest.descriptor_sha256,
    model_dataset_schema_version: input.model.schemaVersion,
    model_dataset_policy_version: input.model.policyVersion,
    source_dataset_id: input.model.manifest.source_dataset_id,
    ground_truth_id: input.model.manifest.ground_truth_id,
    evaluation_id: input.evaluation.evaluation_id,
    evaluation_manifest_sha256: input.evaluation.evaluation_manifest_sha256,
    evaluation_schema_version: input.evaluation.evaluation_schema_version,
    evaluation_policy_version: input.evaluation.evaluation_policy_version,
    evaluation_validation_scope: input.evaluation.evaluation_validation_scope,
    sensitivity_id: input.sensitivity.linkage.sensitivity_id,
    tuning_schema_version: input.sensitivity.linkage.tuning_schema_version,
    tuning_policy_version: input.sensitivity.linkage.tuning_policy_version,
    sensitivity_manifest_sha256: input.sensitivity.linkage.sensitivity_manifest_sha256,
    sensitivity_descriptor_sha256: input.sensitivity.linkage.sensitivity_descriptor_sha256,
    parameter_registry_version: input.sensitivity.linkage.parameter_registry_version,
    parameter_registry_sha256: input.sensitivity.linkage.parameter_registry_sha256,
    tuning_base_config_sha256: input.sensitivity.linkage.tuning_base_config_sha256,
    engine_runtime_sha256: input.sensitivity.linkage.engine_runtime_sha256,
    mapping_status: input.sensitivity.linkage.mapping_status,
    interpretation_scope: input.sensitivity.linkage.interpretation_scope,
    no_skill_reference_ordinal: input.sensitivity.linkage.no_skill_reference_ordinal,
    validation_disclosure_status: input.sensitivity.linkage.validation_disclosure_status,
    validation_disclosure_evidence_id: input.sensitivity.linkage.validation_disclosure_evidence_id,
    validation_disclosure_evidence_sha256: input.sensitivity.linkage.validation_disclosure_evidence_sha256,
    validation_access_ledger_sha256: input.sensitivity.linkage.validation_access_ledger_sha256
  };
}

export function verifiedSourceIdentities(input) {
  return {
    optimization_schema_version: 1,
    verification_phase: 'PHASE_A_SOURCE_LINKED',
    upstream_status: input.upstream.status,
    upstream_validation_scope: input.upstream.validation_scope,
    computation_access_policy: 'TRAIN_ONLY',
    model_allow_files: [...MODEL_ALLOW_FILES],
    sensitivity_allow_files: [...SENSITIVITY_ALLOW_FILES],
    identities: sourceIdentity(input),
    model_file_sha256: Object.fromEntries(Object.keys(input.model.fingerprints).sort(compare)
      .map(file => [file, input.model.fingerprints[file]])),
    sensitivity_file_sha256: input.sensitivity.fingerprints,
    replay_payload_sample_count: input.cohort.length
  };
}
