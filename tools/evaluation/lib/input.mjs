import path from 'node:path';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode } from '../../dataset/lib/common.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
import { modelSchema } from '../../model-dataset/model-dataset-schema.mjs';
import { modelPolicy } from '../../model-dataset/model-dataset-policy.mjs';
import { LABEL_TO_ORDINAL, computeLeadTimeBucket } from '../metrics.mjs';
import { CSV_TABLES } from '../../model-dataset/lib/package.mjs';
import { silentProgress } from '../../progress.mjs';

export const WHITELIST_FILES = Object.freeze([
  'manifest.json',
  'schema.json',
  'policy.json',
  'splits/train.csv',
  'splits/validation.csv'
]);

export async function outside(destination, roots) {
  if (destination.split(/[\\/]/).includes('..')) fail('UNSAFE_PATH');
  const resolved = await safePath(destination);
  for (const root of roots.filter(Boolean)) {
    if (within(await safePath(root), resolved)) fail('UNSAFE_PATH');
  }
  return resolved;
}

export async function readRestrictedModelFile(modelDir, relativeFile) {
  const normalized = relativeFile.replaceAll('\\', '/');
  if (!WHITELIST_FILES.includes(normalized)) {
    fail('MODEL_DATASET_VALIDATION_FAILED', {
      reason_code: 'TEST_ACCESS_FORBIDDEN',
      attempted_file: normalized
    });
  }
  await safePath(modelDir);
  return readSafe(path.join(modelDir, relativeFile));
}

export async function captureWhitelistFingerprints(modelDir) {
  const result = {};
  for (const f of WHITELIST_FILES) {
    result[f] = hash(await readRestrictedModelFile(modelDir, f));
  }
  return result;
}

export async function loadModelEvaluationInput(modelDir, options = {}) {
  const progress = options?.progress || (options?.stage ? options : silentProgress);
  try {
    await safePath(modelDir);
    progress.stage('读取 Model manifest 与 Schema/Policy');
    const manifestBytes = await readRestrictedModelFile(modelDir, 'manifest.json');
    let manifestJson;
    try {
      manifestJson = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'JSON_INVALID' });
    }
    if (!Buffer.from(canonicalJson(manifestJson)).equals(manifestBytes)) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL' });
    }

    const schemaVersion = manifestJson.model_dataset_schema_version;
    const policyVersion = manifestJson.model_dataset_policy_version;
    if (!((schemaVersion === 1 && policyVersion === 1) || (schemaVersion === 2 && [2, 3].includes(policyVersion)))) {
      fail('UNSUPPORTED_MODEL_DATASET_VERSION', { reason_code: 'UNSUPPORTED_MODEL_DATASET_VERSION' });
    }

    progress.stage('读取 Model 白名单文件指纹');
    const fingerprintsBefore = await captureWhitelistFingerprints(modelDir);
    if (fingerprintsBefore['manifest.json'] !== hash(manifestBytes)) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'SOURCE_CHANGED_DURING_READ' });
    }

    // Verify directory name matches model_dataset_id (unless staging)
    if (!options?.staging) {
      const dirBase = path.basename(path.resolve(modelDir));
      if (dirBase !== manifestJson.model_dataset_id) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DIRECTORY_ID_MISMATCH' });
      }
    }

    // Reconstruct and verify Model manifest descriptor and ID
    if (!manifestJson.descriptor || typeof manifestJson.descriptor !== 'object') {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_MISSING' });
    }
    const descriptorSha = hash(canonicalJson(manifestJson.descriptor));
    if (descriptorSha !== manifestJson.descriptor_sha256) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_SHA_MISMATCH' });
    }
    const expectedModelId = `model_v${manifestJson.descriptor.model_dataset_schema_version}_${manifestJson.descriptor.source_descriptor_sha256.slice(0, 12)}_${manifestJson.descriptor.ground_truth_descriptor_sha256.slice(0, 12)}_${descriptorSha.slice(0, 12)}`;
    if (manifestJson.model_dataset_id !== expectedModelId) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_ID_MISMATCH' });
    }
    const sourceKeys = ['source_dataset_id', 'ground_truth_id', 'source_dataset_manifest_sha256',
      'ground_truth_manifest_sha256', 'source_descriptor_sha256', 'ground_truth_descriptor_sha256'];
    const expectedDescriptor = {
      model_dataset_schema_version: schemaVersion, model_dataset_policy_version: policyVersion,
      schema_sha256: manifestJson.files['schema.json'].sha256,
      policy_sha256: manifestJson.files['policy.json'].sha256, selection: manifestJson.selection,
      ...Object.fromEntries(sourceKeys.map(k => [k, manifestJson[k]])),
      csv_sha256: Object.fromEntries(Object.keys(CSV_TABLES).map(f => [f, manifestJson.files[f].sha256]))
    };
    if (canonicalJson(expectedDescriptor) !== canonicalJson(manifestJson.descriptor) ||
        manifestJson.schema_sha256 !== expectedDescriptor.schema_sha256 ||
        manifestJson.policy_sha256 !== expectedDescriptor.policy_sha256 ||
        manifestJson.test_set_policy !== 'final_evaluation_only') {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_MISMATCH' });
    }

    const schemaBytes = await readRestrictedModelFile(modelDir, 'schema.json');
    const policyBytes = await readRestrictedModelFile(modelDir, 'policy.json');
    if (hash(schemaBytes) !== manifestJson.files['schema.json'].sha256 || schemaBytes.length !== manifestJson.files['schema.json'].bytes) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'FILE_HASH' });
    }
    if (hash(policyBytes) !== manifestJson.files['policy.json'].sha256 || policyBytes.length !== manifestJson.files['policy.json'].bytes) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'FILE_HASH' });
    }

    // Check schema.json and policy.json canonical runtime conformance
    const parsedSchema = JSON.parse(schemaBytes.toString('utf8'));
    const parsedPolicy = JSON.parse(policyBytes.toString('utf8'));
    if (!Buffer.from(canonicalJson(parsedSchema)).equals(schemaBytes) ||
        !Buffer.from(canonicalJson(parsedPolicy)).equals(policyBytes)) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL' });
    }
    const expectedSchema = modelSchema(schemaVersion);
    const expectedPolicy = modelPolicy(policyVersion);
    if (canonicalJson(parsedSchema) !== canonicalJson(expectedSchema)) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'SCHEMA_MISMATCH' });
    }
    if (canonicalJson(parsedPolicy) !== canonicalJson(expectedPolicy)) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'POLICY_MISMATCH' });
    }

    progress.stage('受限读取 TRAIN 与 VALIDATION 数据集');
    const trainBytes = await readRestrictedModelFile(modelDir, 'splits/train.csv');
    const valBytes = await readRestrictedModelFile(modelDir, 'splits/validation.csv');

    if (hash(trainBytes) !== manifestJson.files['splits/train.csv'].sha256 ||
        trainBytes.length !== manifestJson.files['splits/train.csv'].bytes) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'FILE_HASH' });
    }
    if (hash(valBytes) !== manifestJson.files['splits/validation.csv'].sha256 ||
        valBytes.length !== manifestJson.files['splits/validation.csv'].bytes) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'FILE_HASH' });
    }

    const schema = modelSchema(schemaVersion);
    const rawTrain = readCsv(schema.tables.samples, trainBytes);
    const rawVal = readCsv(schema.tables.samples, valBytes);

    // Verify row counts match manifest
    if (manifestJson.files['splits/train.csv'].rows !== rawTrain.length ||
        manifestJson.files['splits/validation.csv'].rows !== rawVal.length) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'CSV_ROWS_MISMATCH' });
    }

    const warnings = [];
    let mapLegacyGtBasis = false;
    if (schemaVersion === 1) {
      mapLegacyGtBasis = true;
      warnings.push({
        warning_code: 'LEGACY_GT_BASIS_MAPPING',
        benchmark_mode: null,
        split: null,
        slice_dimension: null,
        slice_value: null,
        slice_value_is_null: null
      });
    }

    const normalizeRow = (r, expectedSplit) => {
      if (r.split !== expectedSplit) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'SPLIT_MISMATCH' });
      }
      if (r.eligibility !== 'PRIMARY') {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'ELIGIBILITY_NOT_PRIMARY' });
      }
      if (!['STRONG', 'MEDIUM'].includes(r.gt_status)) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INVALID_GT_STATUS' });
      }
      if (LABEL_TO_ORDINAL[r.gt_label] !== r.gt_ordinal) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'GT_LABEL_ORDINAL_MISMATCH' });
      }
      if (typeof r.predicted_score !== 'number' || !Number.isInteger(r.predicted_score) || r.predicted_score < 0 || r.predicted_score > 100) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INVALID_PREDICTED_SCORE' });
      }
      if (r.baseline_score != null && (typeof r.baseline_score !== 'number' || !Number.isInteger(r.baseline_score) || r.baseline_score < 0 || r.baseline_score > 100)) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INVALID_BASELINE_SCORE' });
      }
      if (typeof r.lead_time_minutes !== 'number' || !Number.isFinite(r.lead_time_minutes) || r.lead_time_minutes < 0) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'NEGATIVE_LEAD_TIME' });
      }
      const sunsetEpoch = Date.parse(r.sunset_time_utc);
      if (Number.isNaN(sunsetEpoch) || typeof r.prediction_time_epoch !== 'number' || !Number.isFinite(r.prediction_time_epoch)) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INVALID_TIMESTAMP' });
      }
      const expectedMinutes = (sunsetEpoch - r.prediction_time_epoch) / 60000;
      if (r.lead_time_minutes !== expectedMinutes || Date.parse(r.prediction_time_utc) !== r.prediction_time_epoch) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'LEAD_TIME_INCONSISTENT' });
      }
      if (r.lead_time_bucket !== computeLeadTimeBucket(r.lead_time_minutes)) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'LEAD_TIME_BUCKET_MISMATCH' });
      }
      if (r.gt_weight !== r.gt_confidence || r.exclusion_reason !== null || r.diagnostic_reason !== null) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'PRIMARY_METADATA_MISMATCH' });
      }
      if (typeof r.event_normalized_weight !== 'number' || !Number.isFinite(r.event_normalized_weight) || r.event_normalized_weight < 0) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INVALID_WEIGHT' });
      }
      if (typeof r.gt_confidence !== 'number' || !Number.isFinite(r.gt_confidence) || r.gt_confidence <= 0 || r.gt_confidence > 1) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INVALID_CONFIDENCE' });
      }
      const gtBasis = mapLegacyGtBasis ? 'OBSERVATION_AGGREGATED' : r.gt_basis;
      return { ...r, gt_basis: gtBasis };
    };

    const trainRows = rawTrain.map(r => normalizeRow(r, 'TRAIN'));
    const validationRows = rawVal.map(r => normalizeRow(r, 'VALIDATION'));
    const allEvaluated = [...trainRows, ...validationRows];

    // Check unique snapshot IDs
    const seenSnapshots = new Set();
    for (const r of allEvaluated) {
      if (seenSnapshots.has(r.snapshot_id)) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DUPLICATE_SNAPSHOT_ID' });
      }
      seenSnapshots.add(r.snapshot_id);
    }

    // Check disjoint Event splits
    const trainEventIds = new Set(trainRows.map(r => r.event_id));
    const valEventIds = new Set(validationRows.map(r => r.event_id));
    for (const eid of trainEventIds) {
      if (valEventIds.has(eid)) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'EVENT_SPLIT_OVERLAP' });
      }
    }

    // Check GT consistency & weight validity per Event
    const eventGroups = new Map();
    for (const r of allEvaluated) {
      if (!eventGroups.has(r.event_id)) eventGroups.set(r.event_id, []);
      eventGroups.get(r.event_id).push(r);
    }

    for (const [eid, rows] of eventGroups.entries()) {
      const first = rows[0];
      const k = rows.length;
      let totalWeight = 0;
      for (const r of rows) {
        if (r.gt_label !== first.gt_label ||
            r.gt_ordinal !== first.gt_ordinal ||
            r.gt_confidence !== first.gt_confidence ||
            r.gt_status !== first.gt_status ||
            r.gt_basis !== first.gt_basis) {
          fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'EVENT_GT_INCONSISTENCY' });
        }
        const expectedWeight = first.gt_confidence / k;
        if (Math.abs(r.event_normalized_weight - expectedWeight) > 1e-12) {
          fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'WEIGHT_MISMATCH' });
        }
        totalWeight += r.event_normalized_weight;
      }
      if (Math.abs(totalWeight - first.gt_confidence) > 1e-12 * Math.max(1, k)) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'WEIGHT_SUM_MISMATCH' });
      }
    }

    progress.stage('复核 Model 白名单文件指纹');
    const fingerprintsAfter = await captureWhitelistFingerprints(modelDir);
    if (canonicalJson(fingerprintsBefore) !== canonicalJson(fingerprintsAfter)) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'SOURCE_CHANGED_DURING_READ' });
    }

    return {
      modelManifest: manifestJson,
      modelManifestSha256: fingerprintsAfter['manifest.json'],
      trainRows,
      validationRows,
      warnings,
      fingerprints: fingerprintsAfter
    };
  } catch (error) {
    if (['MODEL_DATASET_VALIDATION_FAILED', 'UNSAFE_PATH', 'UNSUPPORTED_MODEL_DATASET_VERSION'].includes(errorCode(error))) {
      throw error;
    }
    fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: errorCode(error) });
  }
}

export async function recheckEvaluationInputs(modelDir, capturedFingerprints) {
  try {
    const current = await captureWhitelistFingerprints(modelDir);
    if (canonicalJson(current) !== canonicalJson(capturedFingerprints)) {
      fail('SOURCE_CHANGED_DURING_EVALUATION');
    }
  } catch {
    fail('SOURCE_CHANGED_DURING_EVALUATION');
  }
}
