#!/usr/bin/env node
import path from 'node:path';
import { readSafe, inventory, hash, canonicalJson, compare, fail, errorCode, isMain } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import {
  evaluationSchema,
  validateManifestStructure,
  validateOverallMetricsStructure,
  validateSummaryStructure
} from './evaluation-schema.mjs';
import { evaluationPolicy } from './evaluation-policy.mjs';
import { formatMetric } from './metrics.mjs';
import { EXPORT_FILES, identity } from './lib/package.mjs';
import { loadModelEvaluationInput } from './lib/input.mjs';
import { evaluate } from './lib/core.mjs';
import { runCli } from './lib/cli.mjs';
import { checkInternalConsistency } from './lib/internal-checks.mjs';

export const parseJson = bytes => {
  const result = JSON.parse(bytes.toString('utf8'));
  if (!Buffer.from(canonicalJson(result)).equals(bytes)) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL' });
  }
  return result;
};

export async function inspectEvaluation(directory, options = {}) {
  try {
    return await inspect(directory, options);
  } catch (error) {
    if (['UNSAFE_PATH', 'UNSUPPORTED_EVALUATION_SCHEMA', 'UNSUPPORTED_EVALUATION_POLICY', 'INVALID_ARGUMENTS', 'EVALUATION_VALIDATION_FAILED', 'MODEL_DATASET_VALIDATION_FAILED', 'SOURCE_DATASET_MISMATCH'].includes(errorCode(error))) {
      throw error;
    }
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: errorCode(error) });
  }
}

async function inspect(directory, options) {
  const manifestBytes = await readSafe(path.join(directory, 'manifest.json'));
  const manifest = parseJson(manifestBytes);

  const schemaVersion = manifest.evaluation_schema_version;
  const policyVersion = manifest.evaluation_policy_version;
  if (schemaVersion !== 1) fail('UNSUPPORTED_EVALUATION_SCHEMA');
  if (policyVersion !== 1) fail('UNSUPPORTED_EVALUATION_POLICY');

  const schema = evaluationSchema(schemaVersion);
  const policy = evaluationPolicy(policyVersion);

  if (manifest.test_evaluated !== false || manifest.test_evaluation_sample_count !== 0) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'TEST_EVALUATED_NOT_ALLOWED' });
  }
  if (manifest.test_access_policy !== 'UPSTREAM_VALIDATION_ONLY') {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'INVALID_TEST_ACCESS_POLICY' });
  }
  if (manifest.upstream_validation_scope !== 'SOURCE_LINKED') {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'INVALID_UPSTREAM_VALIDATION_SCOPE' });
  }

  // Check inventory
  const expectedFiles = [...EXPORT_FILES, 'manifest.json'].sort(compare);
  const actualInventory = (await inventory(directory)).sort(compare);
  if (canonicalJson(actualInventory) !== canonicalJson(expectedFiles)) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'INVENTORY_MISMATCH' });
  }

  // Check manifest files keys
  const manifestFileKeys = Object.keys(manifest.files).sort(compare);
  if (canonicalJson(manifestFileKeys) !== canonicalJson([...EXPORT_FILES].sort(compare))) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'MANIFEST_FILES_MISMATCH' });
  }

  const loadedFiles = {};
  for (const f of EXPORT_FILES) {
    const bytes = await readSafe(path.join(directory, f));
    if (hash(bytes) !== manifest.files[f].sha256 || bytes.length !== manifest.files[f].bytes) {
      fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'FILE_HASH' });
    }
    loadedFiles[f] = bytes;
  }

  // Verify schema and policy
  const fileSchema = parseJson(loadedFiles['schema.json']);
  const filePolicy = parseJson(loadedFiles['policy.json']);
  if (canonicalJson(fileSchema) !== canonicalJson(schema)) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'SCHEMA_MISMATCH' });
  }
  if (canonicalJson(filePolicy) !== canonicalJson(policy)) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'POLICY_MISMATCH' });
  }

  // Verify CSV canonical formats
  const confMatrixRows = readCsv(schema.tables.confusion_matrix, loadedFiles['confusion_matrix.csv']);
  const sliceRows = readCsv(schema.tables.slice_metrics, loadedFiles['slice_metrics.csv']);
  const scoreDistRows = readCsv(schema.tables.score_distribution, loadedFiles['score_distribution.csv']);
  const baselineRows = readCsv(schema.tables.baseline_comparison, loadedFiles['baseline_comparison.csv']);
  const errorCasesRows = readCsv(schema.tables.error_cases, loadedFiles['error_cases.csv']);
  const warningsRows = readCsv(schema.tables.warnings, loadedFiles['reports/warnings.csv']);

  // Verify rows match manifest
  if (manifest.files['confusion_matrix.csv'].rows !== confMatrixRows.length ||
      manifest.files['slice_metrics.csv'].rows !== sliceRows.length ||
      manifest.files['score_distribution.csv'].rows !== scoreDistRows.length ||
      manifest.files['baseline_comparison.csv'].rows !== baselineRows.length ||
      manifest.files['error_cases.csv'].rows !== errorCasesRows.length ||
      manifest.files['reports/warnings.csv'].rows !== warningsRows.length) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'CSV_ROWS_MISMATCH' });
  }

  // Verify overall_metrics.json and summary.json
  const overallMetrics = parseJson(loadedFiles['overall_metrics.json']);
  const summary = parseJson(loadedFiles['reports/summary.json']);

  // Validate JSON structures
  validateManifestStructure(manifest);
  validateOverallMetricsStructure(overallMetrics);
  validateSummaryStructure(summary);
  checkInternalConsistency({ manifest, overall: overallMetrics, summary, matrix: confMatrixRows,
    slices: sliceRows, distributions: scoreDistRows, paired: baselineRows, errors: errorCasesRows, warnings: warningsRows });

  // Reconstruct and verify descriptor and ID
  const rebuiltDescriptor = {
    benchmark_modes: manifest.benchmark_modes,
    evaluated_splits: manifest.evaluated_splits,
    evaluation_policy_version: manifest.evaluation_policy_version,
    evaluation_schema_version: manifest.evaluation_schema_version,
    files_sha256: Object.fromEntries(EXPORT_FILES.map(f => [f, manifest.files[f].sha256])),
    model_dataset_descriptor_sha256: manifest.model_dataset_descriptor_sha256,
    model_dataset_id: manifest.model_dataset_id,
    model_dataset_manifest_sha256: manifest.model_dataset_manifest_sha256,
    policy_sha256: manifest.files['policy.json'].sha256,
    schema_sha256: manifest.files['schema.json'].sha256,
    test_access_policy: manifest.test_access_policy
  };
  if (canonicalJson(manifest.descriptor) !== canonicalJson(rebuiltDescriptor)) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_MISMATCH' });
  }

  const id = identity(rebuiltDescriptor);
  if (manifest.descriptor_sha256 !== id.descriptor_sha256 || manifest.evaluation_id !== id.evaluation_id) {
    fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_ID_MISMATCH' });
  }

  if (!options.staging) {
    const dirBase = path.basename(path.resolve(directory));
    if (dirBase !== manifest.evaluation_id) {
      fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'DIRECTORY_ID_MISMATCH' });
    }
  }

  // Verify confusion matrix 25 unique coordinate pairs, cell count, totals, and recalculate metrics
  for (const mode of policy.benchmark_modes) {
    for (const split of policy.report_splits) {
      const matrixGroup = confMatrixRows.filter(r => r.benchmark_mode === mode && r.split === split);
      if (matrixGroup.length !== 25) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'CONFUSION_MATRIX_CELL_COUNT' });
      }

      const coords = new Set();
      let totalSamples = 0;
      let totalWeight = 0;
      const cellWeights = Array.from({ length: 5 }, () => new Float64Array(5));

      for (const r of matrixGroup) {
        const coordKey = `${r.gt_ordinal},${r.predicted_ordinal}`;
        if (coords.has(coordKey)) {
          fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'CONFUSION_MATRIX_DUPLICATE_CELL' });
        }
        coords.add(coordKey);
        totalSamples += r.sample_count;
        totalWeight += r.weight_sum;
        cellWeights[r.gt_ordinal][r.predicted_ordinal] = r.weight_sum;
      }

      const metricsGroup = overallMetrics.benchmarks[mode][split];
      if (totalSamples !== metricsGroup.sample_count) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'CONFUSION_MATRIX_SUM_MISMATCH' });
      }
      const expectedWeightSum = metricsGroup.weight_sum;
      const formattedTotalWeight = formatMetric(totalWeight) ?? 0;
      if (Math.abs(formattedTotalWeight - expectedWeightSum) > 1e-12 * Math.max(1, totalSamples)) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'CONFUSION_MATRIX_WEIGHT_SUM_MISMATCH' });
      }

      // Recalculate exact accuracy, severe error rate, and QWK from the 25 cells
      const W = totalWeight;
      let exactAccuracy = null;
      let severeErrorRate = null;
      let qwk = null;

      if (W > 0) {
        let sumExact = 0;
        let sumSevere = 0;
        const R = new Float64Array(5), C = new Float64Array(5);

        for (let a = 0; a < 5; a++) {
          for (let b = 0; b < 5; b++) {
            const w = cellWeights[a][b];
            if (a === b) sumExact += w;
            if (Math.abs(a - b) >= 2) sumSevere += w;
            R[a] += w;
            C[b] += w;
          }
        }

        exactAccuracy = formatMetric(sumExact / W);
        severeErrorRate = formatMetric(sumSevere / W);

        let num = 0, denom = 0;
        for (let a = 0; a < 5; a++) {
          for (let b = 0; b < 5; b++) {
            const D = ((a - b) * (a - b)) / 16;
            const E = (R[a] * C[b]) / W;
            num += D * cellWeights[a][b];
            denom += D * E;
          }
        }

        if (denom !== 0) {
          qwk = formatMetric(1 - num / denom);
        }
      }

      const weighted = metricsGroup.weighted;
      const close = (a, b) => a === null || b === null ? a === b : Math.abs(a - b) <= 1e-10;
      if (!close(weighted.exact_accuracy, exactAccuracy) ||
          !close(weighted.severe_error_rate, severeErrorRate) ||
          !close(weighted.qwk, qwk)) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'METRIC_TAMPER_DETECTED' });
      }

      const summaryWeighted = summary.groups[`${mode}.${split}`].weighted;
      if (!close(summaryWeighted.exact_accuracy, exactAccuracy) ||
          !close(summaryWeighted.severe_error_rate, severeErrorRate) ||
          !close(summaryWeighted.qwk, qwk)) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'METRIC_TAMPER_DETECTED' });
      }
    }
  }

  // Verify slice_metrics.csv: dimension uniqueness and valid reason codes
  const seenSlices = new Set();
  const sliceMetricNames = [
    'weighted_mae', 'weighted_bias', 'weighted_exact_accuracy',
    'weighted_within_1_accuracy', 'weighted_severe_error_rate',
    'weighted_overprediction_rate', 'weighted_underprediction_rate'
  ];

  for (const r of sliceRows) {
    const sliceKey = canonicalJson([r.benchmark_mode, r.split, r.slice_dimension, r.slice_value_is_null, r.slice_value]);
    if (seenSlices.has(sliceKey)) {
      fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'DUPLICATE_SLICE_ROW' });
    }
    seenSlices.add(sliceKey);

    for (const mName of sliceMetricNames) {
      const val = r[mName];
      const code = r[`${mName}_reason_code`];
      if (val === null && (typeof code !== 'string' || !code)) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'INVALID_METRIC_REASON_CODE' });
      }
      if (val !== null && code !== null) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'INVALID_METRIC_REASON_CODE' });
      }
    }
  }

  // Verify error cases: all rows must have absolute_error > 0 and correct canonical order
  for (let i = 0; i < errorCasesRows.length; i++) {
    const r = errorCasesRows[i];
    if (typeof r.absolute_error !== 'number' || r.absolute_error <= 0 || !Number.isInteger(r.absolute_error)) {
      fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'ERROR_CASES_NON_ERROR_ROW' });
    }
    if (i > 0) {
      const prev = errorCasesRows[i - 1];
      let cmp = 0;
      if (prev.absolute_error !== r.absolute_error) {
        cmp = r.absolute_error - prev.absolute_error;
      } else if (prev.gt_confidence !== r.gt_confidence) {
        cmp = r.gt_confidence - prev.gt_confidence;
      } else {
        const dateComp = compare(prev.event_date_local, r.event_date_local);
        if (dateComp !== 0) {
          cmp = dateComp;
        } else {
          cmp = compare(prev.snapshot_id, r.snapshot_id);
        }
      }
      if (cmp > 0) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'ERROR_CASES_SORT_ORDER' });
      }
    }
  }

  // MODEL_LINKED validation
  if (options.model) {
    const modelInput = await loadModelEvaluationInput(options.model, options.progress);

    if (manifest.model_dataset_id !== modelInput.modelManifest.model_dataset_id ||
        manifest.model_dataset_manifest_sha256 !== modelInput.modelManifestSha256 ||
        manifest.model_dataset_descriptor_sha256 !== modelInput.modelManifest.descriptor_sha256 ||
        manifest.model_dataset_schema_version !== modelInput.modelManifest.model_dataset_schema_version ||
        manifest.model_dataset_policy_version !== modelInput.modelManifest.model_dataset_policy_version) {
      fail('SOURCE_DATASET_MISMATCH');
    }

    const rebuilt = evaluate(
      modelInput.modelManifest,
      modelInput.modelManifestSha256,
      modelInput.trainRows,
      modelInput.validationRows,
      modelInput.warnings,
      options.progress
    );

    // Verify all 10 files byte-for-byte
    for (const f of EXPORT_FILES) {
      if (!loadedFiles[f].equals(Buffer.from(rebuilt.files[f]))) {
        fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'RECOMPUTED_FILE_MISMATCH', file: f });
      }
    }

    // Verify manifest
    if (canonicalJson(manifest) !== canonicalJson(rebuilt.manifest)) {
      fail('EVALUATION_VALIDATION_FAILED', { reason_code: 'MANIFEST_MISMATCH' });
    }
  }

  return {
    status: 'PASS',
    validation_scope: options.model ? 'MODEL_LINKED' : 'PACKAGE_INTERNAL',
    evaluation_id: manifest.evaluation_id,
    manifest,
    summary
  };
}

if (isMain(import.meta.url)) await runCli('validate', o => inspectEvaluation(o.path, o));
