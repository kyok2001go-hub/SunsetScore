import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { canonicalJson, hash, readSafe, safePath, within, fail, compare, unique } from '../../dataset/lib/common.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
import { modelSchema } from '../../model-dataset/model-dataset-schema.mjs';
import { modelPolicy } from '../../model-dataset/model-dataset-policy.mjs';
import { LABEL_TO_ORDINAL, computeLeadTimeBucket } from '../../evaluation/metrics.mjs';
import { inspectModelDataset } from '../../model-dataset/validate-model-dataset.mjs';
import { silentProgress } from '../../progress.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';
import { loadReplayCohort } from './replay-cohort.mjs';

export async function outside(destination, roots) {
  if (destination.split(/[\\/]/).includes('..')) fail('UNSAFE_PATH');
  const resolved = await safePath(destination);
  for (const root of roots.filter(Boolean)) {
    if (within(await safePath(root), resolved)) fail('UNSAFE_PATH');
  }
  return resolved;
}

export const SPLIT_FILE = Object.freeze({ TRAIN: 'splits/train.csv', VALIDATION: 'splits/validation.csv' });
/** TEST is deliberately absent: no caller can widen the allowlist to reach it. */
export const FORBIDDEN_FILES = Object.freeze(['splits/test.csv', 'model_samples.csv', 'event_splits.csv',
  'diagnostic_samples.csv', 'excluded_samples.csv',
  'reports/statistics.json', 'reports/split-balance.json', 'reports/errors.csv']);

/**
 * Phase B reader. Every caller states which files it may reach; the default is the TRAIN-only
 * tuning whitelist and `splits/test.csv` is never a legal entry.
 */
export async function readRestrictedFile(modelDir, relativeFile, options = {}) {
  const allowFiles = options.allowFiles || tuningPolicy().whitelist_files;
  const normalized = String(relativeFile).replaceAll('\\', '/');
  if (!allowFiles.includes(normalized)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'TEST_ACCESS_FORBIDDEN', attempted_file: normalized });
  }
  if (FORBIDDEN_FILES.includes(normalized)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'TEST_ACCESS_FORBIDDEN', attempted_file: normalized });
  }
  await safePath(modelDir);
  return readSafe(path.join(modelDir, relativeFile));
}

export async function captureWhitelistFingerprints(modelDir, files) {
  const result = {};
  for (const file of files || tuningPolicy().whitelist_files) {
    result[file] = hash(await readRestrictedFile(modelDir, file, files ? { allowFiles: files } : {}));
  }
  return result;
}

export function candidateAllowFiles(split) {
  const file = SPLIT_FILE[split];
  if (!file) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_SPLIT', detail: split });
  }
  return ['manifest.json', 'schema.json', 'policy.json', file];
}

const SUPPORTED_MODEL_VERSIONS = [{ schema: 1, policy: 1 }, { schema: 2, policy: 2 }, { schema: 2, policy: 3 }];

function normalizeRow(row, schemaVersion, expectedSplit) {
  if (row.split !== expectedSplit) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'SPLIT_MISMATCH', detail: { snapshot_id: row.snapshot_id, expected: expectedSplit, actual: row.split } });
  }
  if (row.eligibility !== 'PRIMARY') fail('TUNING_VALIDATION_FAILED', { reason_code: 'ELIGIBILITY_NOT_PRIMARY', detail: row.snapshot_id });
  if (LABEL_TO_ORDINAL[row.gt_label] !== row.gt_ordinal) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'GT_LABEL_ORDINAL_MISMATCH', detail: row.snapshot_id });
  }
  if (!['STRONG', 'MEDIUM'].includes(row.gt_status)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'INVALID_GT_STATUS', detail: row.snapshot_id });
  }
  if (!Number.isInteger(row.predicted_score) || row.predicted_score < 0 || row.predicted_score > 100) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'INVALID_PREDICTED_SCORE', detail: row.snapshot_id });
  }
  if (row.baseline_score != null && (!Number.isInteger(row.baseline_score) || row.baseline_score < 0 || row.baseline_score > 100)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'INVALID_BASELINE_SCORE', detail: row.snapshot_id });
  }
  if (typeof row.lead_time_minutes !== 'number' || !Number.isFinite(row.lead_time_minutes) || row.lead_time_minutes < 0) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'NEGATIVE_LEAD_TIME', detail: row.snapshot_id });
  }
  if (row.lead_time_bucket !== computeLeadTimeBucket(row.lead_time_minutes)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'LEAD_TIME_BUCKET_MISMATCH', detail: row.snapshot_id });
  }
  if (!Number.isFinite(row.gt_confidence) || row.gt_confidence <= 0 || row.gt_confidence > 1) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'INVALID_CONFIDENCE', detail: row.snapshot_id });
  }
  if (!Number.isFinite(row.event_normalized_weight) || row.event_normalized_weight < 0) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'INVALID_WEIGHT', detail: row.snapshot_id });
  }
  if (typeof row.replay_path !== 'string' || !row.replay_path) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'REPLAY_PATH_MISSING', detail: row.snapshot_id });
  }
  const mapped = schemaVersion === 1 ? { ...row, gt_basis: 'OBSERVATION_AGGREGATED' } : row;
  return mapped;
}

async function readModelLinkage(modelManifest) {
  return {
    model_dataset_id: modelManifest.model_dataset_id,
    model_dataset_manifest_sha256: null,
    model_dataset_schema_version: modelManifest.model_dataset_schema_version,
    model_dataset_policy_version: modelManifest.model_dataset_policy_version,
    model_dataset_descriptor_sha256: modelManifest.descriptor_sha256,
    source_dataset_id: modelManifest.source_dataset_id,
    ground_truth_id: modelManifest.ground_truth_id
  };
}

/** Row-level contract shared by every split a caller is allowed to read. */
function assertRowContract(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.snapshot_id)) fail('TUNING_VALIDATION_FAILED', { reason_code: 'DUPLICATE_SNAPSHOT_ID' });
    seen.add(row.snapshot_id);
  }
  const byEvent = new Map();
  for (const row of rows) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row);
  }
  for (const [eventId, group] of byEvent) {
    const first = group[0];
    let total = 0;
    for (const row of group) {
      if (row.gt_label !== first.gt_label || row.gt_ordinal !== first.gt_ordinal ||
          row.gt_confidence !== first.gt_confidence || row.gt_status !== first.gt_status ||
          row.gt_basis !== first.gt_basis) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'EVENT_GT_INCONSISTENCY', detail: eventId });
      }
      const expected = first.gt_confidence / group.length;
      if (Math.abs(row.event_normalized_weight - expected) > 1e-12) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'WEIGHT_MISMATCH', detail: row.snapshot_id });
      }
      total += row.event_normalized_weight;
    }
    if (Math.abs(total - first.gt_confidence) > 1e-12 * Math.max(1, group.length)) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'WEIGHT_SUM_MISMATCH', detail: eventId });
    }
  }
}

/**
 * Header checks shared by the TRAIN-only sensitivity path and the candidate evaluator:
 * manifest identity, version support, descriptor hash and schema/policy conformance over
 * exactly the files the caller was allowed to read.
 */
export async function loadModelHeader(modelDir, options = {}) {
  const allowFiles = options.allowFiles || tuningPolicy().whitelist_files;
  const progress = options.progress || silentProgress;
  await safePath(modelDir);
  progress.stage('读取 Model 白名单文件指纹');
  const fingerprintsBefore = await captureWhitelistFingerprints(modelDir, allowFiles);
  const manifestBytes = await readRestrictedFile(modelDir, 'manifest.json', { allowFiles });
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!Buffer.from(canonicalJson(manifest)).equals(manifestBytes)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL', detail: 'manifest.json' });
  }
  const schemaVersion = manifest.model_dataset_schema_version;
  const policyVersion = manifest.model_dataset_policy_version;
  if (!SUPPORTED_MODEL_VERSIONS.some(v => v.schema === schemaVersion && v.policy === policyVersion)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_MODEL_DATASET_VERSION', detail: { schemaVersion, policyVersion } });
  }
  if (!options.staging && path.basename(path.resolve(modelDir)) !== manifest.model_dataset_id) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'DIRECTORY_ID_MISMATCH' });
  }
  const descriptorSha = hash(canonicalJson(manifest.descriptor));
  if (descriptorSha !== manifest.descriptor_sha256) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_SHA_MISMATCH' });
  }
  for (const file of ['schema.json', 'policy.json']) {
    const bytes = await readRestrictedFile(modelDir, file, { allowFiles });
    if (hash(bytes) !== manifest.files[file].sha256 || bytes.length !== manifest.files[file].bytes) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'FILE_HASH', detail: file });
    }
  }
  const schemaBytes = await readRestrictedFile(modelDir, 'schema.json', { allowFiles });
  const policyBytes = await readRestrictedFile(modelDir, 'policy.json', { allowFiles });
  if (!Buffer.from(canonicalJson(modelSchema(schemaVersion))).equals(schemaBytes) ||
      !Buffer.from(canonicalJson(modelPolicy(policyVersion))).equals(policyBytes)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'SCHEMA_POLICY_CONFORMANCE' });
  }
  return { manifest, schemaVersion, policyVersion, allowFiles, fingerprintsBefore };
}

export async function readSplitRows(modelDir, { manifest, schemaVersion, split, allowFiles, progress = silentProgress }) {
  const file = SPLIT_FILE[split];
  if (!file) fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_SPLIT', detail: split });
  progress.stage(`读取 ${split} 样本`);
  const bytes = await readRestrictedFile(modelDir, file, { allowFiles });
  if (hash(bytes) !== manifest.files[file].sha256 || bytes.length !== manifest.files[file].bytes) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'FILE_HASH', detail: file });
  }
  const rows = readCsv(modelSchema(schemaVersion).tables.samples, bytes).map(row => normalizeRow(row, schemaVersion, split));
  assertRowContract(rows);
  return [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
}

/**
 * Phase B: reads the four whitelisted Model files, verifies identity and row contracts,
 * and returns the TRAIN cohort. VALIDATION / TEST are never opened here.
 */
export async function loadTuningInput(modelDir, options = {}) {
  const progress = options.progress || silentProgress;
  try {
    const header = await loadModelHeader(modelDir, { ...options, progress });
    const rows = await readSplitRows(modelDir, {
      manifest: header.manifest, schemaVersion: header.schemaVersion, split: 'TRAIN', allowFiles: header.allowFiles, progress
    });
    const after = await captureWhitelistFingerprints(modelDir, header.allowFiles);
    if (canonicalJson(header.fingerprintsBefore) !== canonicalJson(after)) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'SOURCE_CHANGED_DURING_READ' });
    }
    return {
      manifest: header.manifest,
      manifestSha256: after['manifest.json'],
      linkage: await readModelLinkage(header.manifest),
      rows,
      fingerprints: after
    };
  } catch (error) {
    if (['TUNING_VALIDATION_FAILED', 'UNSAFE_PATH'].includes(error.code)) throw error;
    fail('TUNING_VALIDATION_FAILED', { reason_code: error.code || 'MODEL_INPUT_FAILED' });
  }
}

/**
 * Candidate evaluation cohort. Same header and row contracts as the sensitivity path, but the
 * caller may name VALIDATION for candidate selection. TEST stays unreachable because
 * `candidateAllowFiles` never offers `splits/test.csv`.
 */
export async function loadCandidateCohort({ modelDir, rawDir, split, progress = silentProgress }) {
  const allowFiles = candidateAllowFiles(split);
  try {
    const header = await loadModelHeader(modelDir, { allowFiles, progress });
    const rows = await readSplitRows(modelDir, {
      manifest: header.manifest, schemaVersion: header.schemaVersion, split, allowFiles, progress
    });
    const cohort = await loadReplayCohort({ rows, rawDir, progress });
    const after = await captureWhitelistFingerprints(modelDir, allowFiles);
    if (canonicalJson(header.fingerprintsBefore) !== canonicalJson(after)) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'SOURCE_CHANGED_DURING_READ' });
    }
    return {
      manifest: header.manifest,
      manifestSha256: after['manifest.json'],
      schemaVersion: header.schemaVersion,
      split,
      allowFiles,
      rows,
      cohort,
      linkage: await readModelLinkage(header.manifest),
      fingerprints: after
    };
  } catch (error) {
    if (['TUNING_VALIDATION_FAILED', 'UNSAFE_PATH'].includes(error.code)) throw error;
    fail('TUNING_VALIDATION_FAILED', { reason_code: error.code || 'MODEL_INPUT_FAILED' });
  }
}

/** Phase A: full source validation. This stage may read VALIDATION / TEST for integrity only. */
export async function verifyUpstreamSources(modelDir, rawDir, gtDir, progress = silentProgress) {
  progress.stage('上游验收：Model / Raw / GT 来源关联');
  const upstream = await inspectModelDataset(modelDir, { raw: rawDir, gt: gtDir });
  if (upstream.status !== 'PASS' || upstream.validation_scope !== 'SOURCE_LINKED') {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'UPSTREAM_SOURCE_LINKED_FAILED' });
  }
  return { status: upstream.status, validation_scope: upstream.validation_scope };
}

export async function loadEvaluationLinkage(evaluationDir, linkage) {
  const manifestPath = await safePath(path.join(evaluationDir, 'manifest.json'));
  const bytes = await readSafe(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!Buffer.from(canonicalJson(manifest)).equals(bytes)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'EVALUATION_MANIFEST_NOT_CANONICAL' });
  }
  if (manifest.model_dataset_id !== linkage.model_dataset_id) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'EVALUATION_MODEL_MISMATCH' });
  }
  if (manifest.test_evaluated !== false || manifest.test_evaluation_sample_count !== 0) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'EVALUATION_EVALUATED_TEST' });
  }
  return {
    evaluation_id: manifest.evaluation_id,
    evaluation_manifest_sha256: hash(bytes),
    evaluated_splits: manifest.evaluated_splits,
    model_dataset_id: manifest.model_dataset_id
  };
}

export function cohortSummary(rows) {
  return {
    sample_count: rows.length,
    event_count: unique(rows.map(r => r.event_id)).length,
    date_count: unique(rows.map(r => r.event_date_local)).length
  };
}
