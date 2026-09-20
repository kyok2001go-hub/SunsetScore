import path from 'node:path';
import { canonicalJson, compare, fail, hash, inventory, readSafe } from '../../dataset/lib/common.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
import { GT_LABELS } from '../evaluation-schema.mjs';
import { fromMatrix } from '../lib/internal-checks.mjs';
import { loadModelEvaluationInput } from '../lib/input.mjs';
import { formatMetric } from '../metrics.mjs';
import { evaluateV2 } from './core.mjs';
import { evaluationSchemaV2, V2_EXPORT_FILES } from './schema.mjs';
import { evaluationPolicyV2, MAPPING, NO_SKILL_COMPARATOR } from './policy.mjs';

const METRICS = ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate',
  'overprediction_rate', 'underprediction_rate', 'qwk'];
const check = (ok, reason) => { if (!ok) fail('EVALUATION_VALIDATION_FAILED', { reason_code: reason }); };
const equal = (a, b, reason) => check(canonicalJson(a) === canonicalJson(b), reason);
const close = (a, b, reason) => check(a === null || b === null ? a === b :
  typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) &&
  Math.abs(a - b) <= 1e-10, reason);

function parseJson(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  check(Buffer.from(canonicalJson(value)).equals(bytes), 'JSON_NOT_CANONICAL');
  return value;
}

function table(schema, file) {
  return schema.tables[file.replace('reports/', '').replace('.csv', '')];
}

function checkHeadline(actual, expected, sampleCount, weightSum, weighting) {
  for (const key of METRICS) {
    close(actual[key], expected[key], 'METRIC_TAMPER_DETECTED');
    const reason = expected[key] !== null ? null : sampleCount === 0 ? 'NO_SAMPLES' :
      weighting === 'weighted' && weightSum === 0 ? 'ZERO_WEIGHT' : 'QWK_ZERO_EXPECTED_DISAGREEMENT';
    equal(actual.metric_reasons?.[key], reason, 'METRIC_REASON');
  }
}

function checkInternal(manifest, overall, summary, csv) {
  check(manifest.evaluation_schema_version === 2 && manifest.evaluation_policy_version === 2,
    'VERSION_MISMATCH');
  check(overall.evaluation_schema_version === 2 && overall.evaluation_policy_version === 2 &&
    summary.evaluation_schema_version === 2 && summary.evaluation_policy_version === 2,
  'VERSION_MISMATCH');
  equal(manifest.evaluated_splits, ['TRAIN'], 'EVALUATED_SPLITS');
  check(manifest.validation_evaluated === false && manifest.validation_evaluation_sample_count === 0 &&
    manifest.test_evaluated === false && manifest.test_evaluation_sample_count === 0,
  'HOLDOUT_EVALUATED');
  check(manifest.upstream_validation_scope === 'SOURCE_LINKED' &&
    manifest.computation_access_policy === 'TRAIN_ONLY' &&
    manifest.validation_access_policy === 'UPSTREAM_VALIDATION_ONLY' &&
    manifest.test_access_policy === 'UPSTREAM_VALIDATION_ONLY', 'ACCESS_POLICY');
  for (const [key, value] of Object.entries(MAPPING)) {
    equal(manifest[key], value, 'MAPPING_CONTRACT');
    equal(summary[key], value, 'MAPPING_CONTRACT');
  }
  equal(summary.no_skill_reference, manifest.no_skill_reference, 'REFERENCE_CONTRACT');
  equal(summary.model_dataset_id, manifest.model_dataset_id, 'SUMMARY_SOURCE');
  equal(summary.evaluated_splits, ['TRAIN'], 'SUMMARY_SPLITS');
  equal(summary.benchmark_modes, ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'], 'SUMMARY_BENCHMARKS');
  check(summary.validation_evaluated === false && summary.test_evaluated === false, 'SUMMARY_HOLDOUT');
  equal(summary.evaluated_versions, manifest.evaluated_versions, 'SUMMARY_VERSIONS');
  equal(overall.splits, ['TRAIN'], 'OVERALL_SPLITS');
  equal(overall.benchmark_modes, ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'], 'BENCHMARK_MODES');
  equal(Object.keys(overall.benchmarks).sort(compare), ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'], 'BENCHMARK_KEYS');
  equal(Object.keys(summary.groups).sort(compare),
    ['ALL_PRIMARY.TRAIN', 'CLOSEST_PRE_SUNSET.TRAIN'], 'SUMMARY_GROUP_KEYS');
  equal(Object.keys(manifest.benchmark_counts).sort(compare),
    ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'], 'BENCHMARK_COUNTS');
  equal(manifest.schema_sha256, manifest.files['schema.json'].sha256, 'SCHEMA_HASH');
  equal(manifest.policy_sha256, manifest.files['policy.json'].sha256, 'POLICY_HASH');
  equal(manifest.sample_count, overall.benchmarks.ALL_PRIMARY.TRAIN.sample_count, 'MANIFEST_COUNTS');
  equal(manifest.event_count, overall.benchmarks.ALL_PRIMARY.TRAIN.event_count, 'MANIFEST_COUNTS');
  equal(manifest.date_count, overall.benchmarks.ALL_PRIMARY.TRAIN.date_count, 'MANIFEST_COUNTS');
  check(csv['confusion_matrix.csv'].length === 50 && csv['score_distribution.csv'].length === 10 &&
    csv['baseline_comparison.csv'].length === 4 && csv['no_skill_comparison.csv'].length === 4,
  'TABLE_GROUP_COUNTS');

  const reference = manifest.no_skill_reference;
  check(reference?.comparator === NO_SKILL_COMPARATOR, 'REFERENCE_COMPARATOR');
  for (const mode of ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET']) {
    const group = overall.benchmarks[mode].TRAIN;
    const summarized = summary.groups[`${mode}.TRAIN`];
    equal(Object.keys(overall.benchmarks[mode]), ['TRAIN'], 'SPLIT_KEYS');
    equal(Object.keys(manifest.benchmark_counts[mode]), ['TRAIN'], 'BENCHMARK_COUNTS');
    equal(manifest.benchmark_counts[mode].TRAIN,
      Object.fromEntries(['sample_count', 'event_count', 'date_count', 'weight_sum']
        .map(k => [k, group[k]])), 'BENCHMARK_COUNTS');
    check(group.date_count <= group.event_count && group.event_count <= group.sample_count,
      'SUPPORT_ORDER');
    if (mode === 'CLOSEST_PRE_SUNSET') equal(group.sample_count, group.event_count, 'CLOSEST_SUPPORT');
    for (const key of ['sample_count', 'event_count', 'date_count', 'weight_sum', 'weighted', 'unweighted',
      'lead_time_coverage', 'ranking_diagnostics']) equal(summarized[key], group[key], 'SUMMARY_OVERALL');

    const cells = csv['confusion_matrix.csv'].filter(r => r.benchmark_mode === mode);
    equal(cells.map(r => [r.gt_ordinal, r.predicted_ordinal]),
      Array.from({ length: 25 }, (_, i) => [Math.floor(i / 5), i % 5]), 'MATRIX_COORDINATES');
    equal(cells.reduce((sum, r) => sum + r.sample_count, 0), group.sample_count, 'MATRIX_COUNT');
    close(formatMetric(cells.reduce((sum, r) => sum + r.weight_sum, 0)), group.weight_sum,
      'MATRIX_WEIGHT');
    for (const cell of cells) {
      equal(cell.gt_label, GT_LABELS[cell.gt_ordinal], 'MATRIX_LABEL');
      equal(cell.predicted_label, ['很差', '较差', '一般', '很好', '极佳'][cell.predicted_ordinal],
        'MATRIX_LABEL');
    }
    for (const weighting of ['weighted', 'unweighted']) {
      checkHeadline(group[weighting], fromMatrix(cells, weighting), group.sample_count,
        group.weight_sum, weighting);
      const row = csv['no_skill_comparison.csv'].find(r => r.benchmark_mode === mode && r.weighting === weighting);
      check(Boolean(row), 'NO_SKILL_ROW');
      equal(row.split, 'TRAIN', 'NO_SKILL_SPLIT');
      equal(row.comparator, NO_SKILL_COMPARATOR, 'NO_SKILL_COMPARATOR');
      equal(row.reference_ordinal, reference.reference_ordinal, 'NO_SKILL_REFERENCE');
      equal(row.reference_gt_label, reference.reference_gt_label, 'NO_SKILL_REFERENCE');
      equal(row.sample_count, group.sample_count, 'NO_SKILL_SUPPORT');
      equal(row.event_count, group.event_count, 'NO_SKILL_SUPPORT');
      close(row.weight_sum, weighting === 'unweighted' ? group.sample_count : group.weight_sum,
        'NO_SKILL_SUPPORT');
      const refCells = cells.map(cell => ({ ...cell, predicted_ordinal: reference.reference_ordinal }));
      const expectedRef = reference.reference_ordinal === null ? null : fromMatrix(refCells, weighting);
      for (const key of METRICS) {
        close(row[`final_${key}`], group[weighting][key], 'NO_SKILL_FINAL_METRIC');
        close(row[`reference_${key}`], expectedRef?.[key] ?? null, 'NO_SKILL_REFERENCE_METRIC');
        equal(row[`final_${key}_reason_code`], group[weighting].metric_reasons[key], 'NO_SKILL_REASON');
        const refReason = expectedRef?.[key] != null ? null : reference.reason_code ||
          (group.sample_count === 0 ? 'NO_SAMPLES' : 'QWK_ZERO_EXPECTED_DISAGREEMENT');
        equal(row[`reference_${key}_reason_code`], refReason, 'NO_SKILL_REASON');
      }
      const delta = group[weighting].mae === null || expectedRef?.mae == null ? null :
        group[weighting].mae - expectedRef.mae;
      close(row.delta_mae, delta, 'NO_SKILL_DELTA');
      equal(row.delta_mae_reason_code, row.delta_mae === null ?
        (reference.reason_code || group[weighting].metric_reasons.mae || 'NO_SAMPLES') : null,
      'NO_SKILL_REASON');
      equal(summarized.no_skill_comparison?.[weighting], row, 'SUMMARY_NO_SKILL');
    }
    const distribution = csv['score_distribution.csv'].filter(r => r.benchmark_mode === mode);
    equal(distribution.map(r => r.gt_label), GT_LABELS, 'DISTRIBUTION_LEVELS');
    for (const label of GT_LABELS) {
      const fromCells = cells.filter(r => r.gt_label === label).reduce((sum, r) => sum + r.sample_count, 0);
      equal(distribution.find(r => r.gt_label === label)?.sample_count, fromCells, 'DISTRIBUTION_COUNT');
    }
    const paired = csv['baseline_comparison.csv'].filter(r => r.benchmark_mode === mode);
    equal(paired.map(r => r.weighting), ['weighted', 'unweighted'], 'PAIRED_ROWS');
    for (const row of paired) {
      equal(row.benchmark_sample_count, group.sample_count, 'PAIRED_SUPPORT');
      equal(row.benchmark_event_count, group.event_count, 'PAIRED_SUPPORT');
      equal(row.paired_sample_count + row.missing_baseline_sample_count, group.sample_count,
        'PAIRED_SUPPORT');
      close(row.paired_sample_coverage,
        group.sample_count ? row.paired_sample_count / group.sample_count : null, 'PAIRED_COVERAGE');
      close(row.paired_event_coverage,
        group.event_count ? row.paired_event_count / group.event_count : null, 'PAIRED_COVERAGE');
    }
  }

  const allCells = csv['confusion_matrix.csv'].filter(r => r.benchmark_mode === 'ALL_PRIMARY');
  const byGt = Array.from({ length: 5 }, (_, i) => allCells.filter(r => r.gt_ordinal === i)
    .reduce((sum, r) => sum + r.weight_sum, 0));
  let best = Infinity;
  const total = byGt.reduce((sum, weight) => sum + weight, 0);
  const losses = [];
  if (total > 0) for (let candidate = 0; candidate < 5; candidate++) {
    const loss = byGt.reduce((sum, weight, ordinal) => sum + weight * Math.abs(candidate - ordinal), 0);
    losses.push(loss);
    if (loss < best) best = loss;
  }
  // Published matrix cells are rounded to 12 places. MODEL_LINKED checks the exact TRAIN
  // tie break; the package-only check allows that rounding error in the marginal loss.
  check(total <= 0 ? reference.reference_ordinal === null :
    Number.isInteger(reference.reference_ordinal) && reference.reference_ordinal >= 0 &&
    reference.reference_ordinal <= 4 && losses[reference.reference_ordinal] <= best + 1e-10,
  'REFERENCE_SELECTION');
  equal(reference.reference_gt_label, reference.reference_ordinal === null ? null :
    GT_LABELS[reference.reference_ordinal],
    'REFERENCE_SELECTION');
  equal(reference.train_event_count, manifest.event_count, 'REFERENCE_SUPPORT');
  close(reference.train_weight_sum, manifest.benchmark_counts.ALL_PRIMARY.TRAIN.weight_sum,
    'REFERENCE_SUPPORT');
  equal(reference.reason_code, reference.reference_ordinal === null ?
    (manifest.event_count === 0 ? 'NO_TRAIN_EVENTS' : 'ZERO_TRAIN_WEIGHT') : null,
  'REFERENCE_REASON');
  for (const file of ['slice_metrics.csv', 'error_cases.csv']) {
    for (const row of csv[file]) equal(row.split, 'TRAIN', 'HOLDOUT_ROW');
  }
  const sliceKeys = csv['slice_metrics.csv'].map(r => canonicalJson([
    r.benchmark_mode, r.split, r.slice_dimension, r.slice_value, r.slice_value_is_null
  ]));
  equal(new Set(sliceKeys).size, sliceKeys.length, 'DUPLICATE_SLICE');
  const errorIds = csv['error_cases.csv'].map(r => r.snapshot_id);
  equal(new Set(errorIds).size, errorIds.length, 'DUPLICATE_ERROR');
  for (const row of csv['error_cases.csv']) {
    check(row.absolute_error > 0 && row.absolute_error === Math.abs(row.ordinal_error) &&
      row.ordinal_error === row.predicted_ordinal - row.gt_ordinal, 'ERROR_CASE_VALUE');
  }
  const warningCounts = {};
  const warningKeys = csv['reports/warnings.csv'].map(canonicalJson);
  equal(new Set(warningKeys).size, warningKeys.length, 'DUPLICATE_WARNING');
  for (const row of csv['reports/warnings.csv']) {
    check(row.split === null || row.split === 'TRAIN', 'HOLDOUT_WARNING');
    warningCounts[row.warning_code] = (warningCounts[row.warning_code] || 0) + 1;
  }
  equal(summary.warnings_summary, warningCounts, 'WARNING_COUNTS');
}

export async function inspectEvaluationV2(directory, options = {}) {
  const manifestBytes = await readSafe(path.join(directory, 'manifest.json'));
  const manifest = parseJson(manifestBytes);
  check(manifest.evaluation_schema_version === 2, 'SCHEMA_VERSION');
  check(manifest.evaluation_policy_version === 2, 'POLICY_VERSION');
  const schema = evaluationSchemaV2();
  const policy = evaluationPolicyV2();
  const expectedFiles = [...V2_EXPORT_FILES, 'manifest.json'].sort(compare);
  equal((await inventory(directory)).sort(compare), expectedFiles, 'INVENTORY_MISMATCH');
  equal(Object.keys(manifest.files).sort(compare), [...V2_EXPORT_FILES], 'MANIFEST_FILES');
  const loaded = {};
  const csv = {};
  for (const file of V2_EXPORT_FILES) {
    const bytes = await readSafe(path.join(directory, file));
    check(hash(bytes) === manifest.files[file]?.sha256 && bytes.length === manifest.files[file]?.bytes,
      'FILE_HASH');
    loaded[file] = bytes;
    if (file.endsWith('.csv')) {
      csv[file] = readCsv(table(schema, file), bytes);
      equal(csv[file].length, manifest.files[file].rows, 'CSV_ROWS');
    } else parseJson(bytes);
  }
  equal(parseJson(loaded['schema.json']), schema, 'SCHEMA_MISMATCH');
  equal(parseJson(loaded['policy.json']), policy, 'POLICY_MISMATCH');
  const overall = parseJson(loaded['overall_metrics.json']);
  const summary = parseJson(loaded['reports/summary.json']);
  const descriptor = {
    benchmark_modes: manifest.benchmark_modes, evaluated_splits: manifest.evaluated_splits,
    evaluation_schema_version: 2, evaluation_policy_version: 2,
    model_dataset_id: manifest.model_dataset_id,
    model_dataset_manifest_sha256: manifest.model_dataset_manifest_sha256,
    model_dataset_descriptor_sha256: manifest.model_dataset_descriptor_sha256,
    schema_sha256: manifest.files['schema.json'].sha256,
    policy_sha256: manifest.files['policy.json'].sha256,
    computation_access_policy: manifest.computation_access_policy,
    validation_access_policy: manifest.validation_access_policy,
    test_access_policy: manifest.test_access_policy,
    mapping_basis: manifest.mapping_basis, mapping_status: manifest.mapping_status,
    interpretation_scope: manifest.interpretation_scope,
    no_skill_reference: manifest.no_skill_reference,
    files_sha256: Object.fromEntries(V2_EXPORT_FILES.map(file => [file, manifest.files[file].sha256]))
  };
  equal(manifest.descriptor, descriptor, 'DESCRIPTOR_MISMATCH');
  const digest = hash(canonicalJson(descriptor));
  equal(manifest.descriptor_sha256, digest, 'DESCRIPTOR_HASH');
  const expectedId = `baseline_v2_${manifest.model_dataset_descriptor_sha256.slice(0, 12)}_${digest.slice(0, 12)}`;
  equal(manifest.evaluation_id, expectedId, 'EVALUATION_ID');
  if (!options.staging) equal(path.basename(path.resolve(directory)), expectedId, 'DIRECTORY_ID');
  checkInternal(manifest, overall, summary, csv);

  if (options.model) {
    const source = await loadModelEvaluationInput(options.model, { trainOnly: true, progress: options.progress });
    equal(manifest.model_dataset_id, source.modelManifest.model_dataset_id, 'SOURCE_DATASET_MISMATCH');
    equal(manifest.model_dataset_manifest_sha256, source.modelManifestSha256, 'SOURCE_DATASET_MISMATCH');
    const rebuilt = evaluateV2(source.modelManifest, source.modelManifestSha256,
      source.trainRows, source.warnings, options.progress);
    for (const file of V2_EXPORT_FILES) {
      check(loaded[file].equals(Buffer.from(rebuilt.files[file])), 'RECOMPUTED_FILE_MISMATCH');
    }
    equal(manifest, rebuilt.manifest, 'MANIFEST_MISMATCH');
  }
  return { status: 'PASS', validation_scope: options.model ? 'MODEL_LINKED' : 'PACKAGE_INTERNAL',
    evaluation_id: manifest.evaluation_id, manifest, summary };
}
