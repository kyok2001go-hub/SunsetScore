import { compare } from '../dataset/lib/common.mjs';

const field = (name, type = 'string', nullable = false, range = null, values = null) =>
  ({ name, type, nullable, range, enum: values, unit: null });
const count = name => field(name, 'integer', false, [0, Number.MAX_SAFE_INTEGER]);

// Frozen package file list: manifest.json itself is recorded separately by the manifest.
export const EXPORT_FILES = Object.freeze([
  'baseline_comparison.csv',
  'confusion_matrix.csv',
  'error_cases.csv',
  'overall_metrics.json',
  'policy.json',
  'reports/summary.json',
  'reports/warnings.csv',
  'schema.json',
  'score_distribution.csv',
  'slice_metrics.csv'
].sort(compare));

export const BENCHMARK_MODES = ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'];
export const REPORT_SPLITS = ['TRAIN', 'VALIDATION', 'TRAIN_VALIDATION'];
export const GT_LABELS = ['poor', 'fair', 'good', 'very_good', 'excellent'];
export const LEAD_TIME_BUCKETS = ['T_0_30M', 'T_30_60M', 'T_1_3H', 'T_3_6H', 'T_6H_PLUS'];
export const COMPARATOR = 'stored_internal_baseline_score';
export const SLICE_DIMENSIONS = [
  'lead_time_bucket',
  'city',
  'gt_label',
  'gt_status',
  'gt_basis',
  'model_version',
  'engine_build_sha',
  'config_hash',
  'regime_label',
  'sky_evolution_state',
  'scheduled_slot',
  'snapshot_source',
  'tile_radar_available',
  'tile_sat_available'
];

export const CONFUSION_MATRIX_FIELDS = [
  field('benchmark_mode', 'string', false, null, BENCHMARK_MODES),
  field('split', 'string', false, null, REPORT_SPLITS),
  field('gt_ordinal', 'integer', false, [0, 4]),
  field('gt_label', 'string', false, null, GT_LABELS),
  field('predicted_ordinal', 'integer', false, [0, 4]),
  field('predicted_label', 'string', false, null, GT_LABELS),
  count('sample_count'),
  field('weight_sum', 'number', false, [0, Number.MAX_SAFE_INTEGER])
];

export const SLICE_METRICS_FIELDS = [
  field('benchmark_mode', 'string', false, null, BENCHMARK_MODES),
  field('split', 'string', false, null, REPORT_SPLITS),
  field('slice_dimension', 'string', false, null, SLICE_DIMENSIONS),
  field('slice_value', 'string', true),
  field('slice_value_is_null', 'boolean'),
  field('city', 'string', true),
  field('country', 'string', true),
  field('admin1', 'string', true),
  count('sample_count'),
  count('event_count'),
  count('date_count'),
  field('weight_sum', 'number', false, [0, Number.MAX_SAFE_INTEGER]),
  field('low_support', 'boolean'),
  field('limited_date_coverage', 'boolean'),
  field('weighted_mae', 'number', true, [0, 4]),
  field('weighted_mae_reason_code', 'string', true),
  field('weighted_bias', 'number', true, [-4, 4]),
  field('weighted_bias_reason_code', 'string', true),
  field('weighted_exact_accuracy', 'number', true, [0, 1]),
  field('weighted_exact_accuracy_reason_code', 'string', true),
  field('weighted_within_1_accuracy', 'number', true, [0, 1]),
  field('weighted_within_1_accuracy_reason_code', 'string', true),
  field('weighted_severe_error_rate', 'number', true, [0, 1]),
  field('weighted_severe_error_rate_reason_code', 'string', true),
  field('weighted_overprediction_rate', 'number', true, [0, 1]),
  field('weighted_overprediction_rate_reason_code', 'string', true),
  field('weighted_underprediction_rate', 'number', true, [0, 1]),
  field('weighted_underprediction_rate_reason_code', 'string', true)
];

export const SCORE_DISTRIBUTION_FIELDS = [
  field('benchmark_mode', 'string', false, null, BENCHMARK_MODES),
  field('split', 'string', false, null, REPORT_SPLITS),
  field('weighting', 'string', false, null, ['unweighted']),
  field('gt_label', 'string', false, null, GT_LABELS),
  field('gt_ordinal', 'integer', false, [0, 4]),
  count('sample_count'),
  count('event_count'),
  field('mean', 'number', true, [0, 100]),
  field('mean_reason_code', 'string', true),
  field('median', 'number', true, [0, 100]),
  field('median_reason_code', 'string', true),
  field('p25', 'number', true, [0, 100]),
  field('p25_reason_code', 'string', true),
  field('p75', 'number', true, [0, 100]),
  field('p75_reason_code', 'string', true),
  field('min', 'integer', true, [0, 100]),
  field('min_reason_code', 'string', true),
  field('max', 'integer', true, [0, 100]),
  field('max_reason_code', 'string', true)
];

export const BASELINE_COMPARISON_FIELDS = [
  field('benchmark_mode', 'string', false, null, BENCHMARK_MODES),
  field('split', 'string', false, null, REPORT_SPLITS),
  field('weighting', 'string', false, null, ['weighted', 'unweighted']),
  field('comparator', 'string', false, null, [COMPARATOR]),
  count('benchmark_sample_count'),
  count('benchmark_event_count'),
  count('paired_sample_count'),
  count('paired_event_count'),
  count('missing_baseline_sample_count'),
  field('paired_sample_coverage', 'number', true, [0, 1]),
  field('paired_sample_coverage_reason_code', 'string', true),
  field('paired_event_coverage', 'number', true, [0, 1]),
  field('paired_event_coverage_reason_code', 'string', true),
  field('weight_sum', 'number', false, [0, Number.MAX_SAFE_INTEGER]),
  field('final_mae', 'number', true, [0, 4]),
  field('final_mae_reason_code', 'string', true),
  field('baseline_mae', 'number', true, [0, 4]),
  field('baseline_mae_reason_code', 'string', true),
  field('delta_mae', 'number', true, [-4, 4]),
  field('delta_mae_reason_code', 'string', true),
  field('final_bias', 'number', true, [-4, 4]),
  field('final_bias_reason_code', 'string', true),
  field('baseline_bias', 'number', true, [-4, 4]),
  field('baseline_bias_reason_code', 'string', true),
  field('final_exact_accuracy', 'number', true, [0, 1]),
  field('final_exact_accuracy_reason_code', 'string', true),
  field('baseline_exact_accuracy', 'number', true, [0, 1]),
  field('baseline_exact_accuracy_reason_code', 'string', true),
  field('final_within_1_accuracy', 'number', true, [0, 1]),
  field('final_within_1_accuracy_reason_code', 'string', true),
  field('baseline_within_1_accuracy', 'number', true, [0, 1]),
  field('baseline_within_1_accuracy_reason_code', 'string', true),
  field('final_severe_error_rate', 'number', true, [0, 1]),
  field('final_severe_error_rate_reason_code', 'string', true),
  field('baseline_severe_error_rate', 'number', true, [0, 1]),
  field('baseline_severe_error_rate_reason_code', 'string', true),
  field('final_win_rate', 'number', true, [0, 1]),
  field('final_win_rate_reason_code', 'string', true),
  field('tie_rate', 'number', true, [0, 1]),
  field('tie_rate_reason_code', 'string', true),
  field('baseline_win_rate', 'number', true, [0, 1]),
  field('baseline_win_rate_reason_code', 'string', true)
];

export const ERROR_CASES_FIELDS = [
  field('snapshot_id'),
  field('event_id'),
  field('event_date_local'),
  field('split', 'string', false, null, ['TRAIN', 'VALIDATION']),
  field('location_key'),
  field('city'),
  field('country'),
  field('admin1', 'string', true),
  field('lead_time_minutes', 'number', false, [0, Number.MAX_SAFE_INTEGER]),
  field('lead_time_bucket', 'string', false, null, LEAD_TIME_BUCKETS),
  field('selected_in_closest', 'boolean'),
  field('predicted_score', 'integer', false, [0, 100]),
  field('predicted_ordinal', 'integer', false, [0, 4]),
  field('gt_label', 'string', false, null, GT_LABELS),
  field('gt_ordinal', 'integer', false, [0, 4]),
  field('gt_confidence', 'number', false, [0, 1]),
  field('gt_status'),
  field('gt_basis'),
  field('ordinal_error', 'integer', false, [-4, 4]),
  field('absolute_error', 'integer', false, [1, 4]),
  field('is_high_confidence', 'boolean'),
  field('is_severe', 'boolean'),
  field('baseline_score', 'integer', true, [0, 100]),
  field('baseline_ordinal', 'integer', true, [0, 4]),
  field('baseline_absolute_error', 'integer', true, [0, 4]),
  field('paired_outcome', 'string', true, null, ['FINAL_WIN', 'TIE', 'BASELINE_WIN']),
  field('regime_label', 'string', true),
  field('sky_evolution_state', 'string', true),
  field('gw_factor', 'number', true, [0, 10]),
  field('tile_radar_available', 'boolean'),
  field('tile_sat_available', 'boolean'),
  field('model_version'),
  field('engine_build_sha'),
  field('config_hash')
];

export const WARNING_FIELDS = [
  field('warning_code'),
  field('benchmark_mode', 'string', true, null, BENCHMARK_MODES),
  field('split', 'string', true, null, REPORT_SPLITS),
  field('slice_dimension', 'string', true, null, SLICE_DIMENSIONS),
  field('slice_value', 'string', true),
  field('slice_value_is_null', 'boolean', true)
];

export const MANIFEST_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'evaluation_schema_version', 'evaluation_policy_version', 'evaluation_id',
    'descriptor_sha256', 'descriptor', 'model_dataset_id', 'model_dataset_manifest_sha256',
    'model_dataset_schema_version', 'model_dataset_policy_version', 'model_dataset_descriptor_sha256',
    'evaluated_splits', 'test_evaluated', 'test_evaluation_sample_count',
    'upstream_validation_scope', 'test_access_policy', 'benchmark_modes',
    'sample_count', 'event_count', 'date_count', 'benchmark_counts',
    'evaluated_versions', 'schema_sha256', 'policy_sha256', 'files'
  ]
});

export const OVERALL_METRICS_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: ['evaluation_schema_version', 'evaluation_policy_version', 'benchmark_modes', 'splits', 'benchmarks']
});

export const SUMMARY_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'model_dataset_id', 'evaluation_schema_version', 'evaluation_policy_version',
    'evaluated_splits', 'test_evaluated', 'benchmark_modes', 'evaluated_versions',
    'groups', 'warnings_summary'
  ]
});

export function validateManifestStructure(m) {
  if (!m || typeof m !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'manifest_not_object' });
  if (m.evaluation_schema_version !== 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluation_schema_version' });
  if (m.evaluation_policy_version !== 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluation_policy_version' });
  if (typeof m.evaluation_id !== 'string' || !/^baseline_v1_[a-f0-9]{12}_[a-f0-9]{12}$/.test(m.evaluation_id)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluation_id' });
  if (typeof m.descriptor_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.descriptor_sha256)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'descriptor_sha256' });
  if (typeof m.model_dataset_id !== 'string' || !m.model_dataset_id) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'model_dataset_id' });
  if (typeof m.model_dataset_manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.model_dataset_manifest_sha256)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'model_dataset_manifest_sha256' });
  if (!Number.isInteger(m.model_dataset_schema_version) || m.model_dataset_schema_version < 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'model_dataset_schema_version' });
  if (!Number.isInteger(m.model_dataset_policy_version) || m.model_dataset_policy_version < 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'model_dataset_policy_version' });
  if (typeof m.model_dataset_descriptor_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.model_dataset_descriptor_sha256)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'model_dataset_descriptor_sha256' });
  if (!Array.isArray(m.evaluated_splits) || m.evaluated_splits.join(',') !== 'TRAIN,VALIDATION') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluated_splits' });
  if (m.test_evaluated !== false || m.test_evaluation_sample_count !== 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'test_evaluated' });
  if (m.upstream_validation_scope !== 'SOURCE_LINKED') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'upstream_validation_scope' });
  if (m.test_access_policy !== 'UPSTREAM_VALIDATION_ONLY') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'test_access_policy' });
  if (!Array.isArray(m.benchmark_modes) || m.benchmark_modes.join(',') !== BENCHMARK_MODES.join(',')) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'benchmark_modes' });
  if (!Number.isInteger(m.sample_count) || m.sample_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'sample_count' });
  if (!Number.isInteger(m.event_count) || m.event_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'event_count' });
  if (!Number.isInteger(m.date_count) || m.date_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'date_count' });
  if (!m.benchmark_counts || typeof m.benchmark_counts !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'benchmark_counts' });
  if (!m.evaluated_versions || typeof m.evaluated_versions !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluated_versions' });
  for (const k of ['config_hashes', 'engine_build_shas', 'model_versions']) {
    if (!Array.isArray(m.evaluated_versions[k])) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `evaluated_versions.${k}` });
  }
  if (typeof m.schema_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.schema_sha256)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'schema_sha256' });
  if (typeof m.policy_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.policy_sha256)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'policy_sha256' });
  if (!m.files || typeof m.files !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'files' });
  for (const [fn, finfo] of Object.entries(m.files)) {
    if (typeof finfo?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(finfo.sha256)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `files.${fn}.sha256` });
    if (!Number.isInteger(finfo.bytes) || finfo.bytes < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `files.${fn}.bytes` });
    if (fn.endsWith('.csv') && (!Number.isInteger(finfo.rows) || finfo.rows < 0)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `files.${fn}.rows` });
  }
  if (!m.descriptor || typeof m.descriptor !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'descriptor' });
}

function validateHeadlineMetrics(h, path) {
  if (!h || typeof h !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: path });
  const metricKeys = ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate', 'overprediction_rate', 'underprediction_rate', 'qwk'];
  if (!h.metric_reasons || typeof h.metric_reasons !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.metric_reasons` });
  for (const k of metricKeys) {
    const val = h[k];
    const r = h.metric_reasons[k];
    if (val !== null && (typeof val !== 'number' || !Number.isFinite(val))) {
      throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.${k}` });
    }
    if (val === null && (typeof r !== 'string' || !r)) {
      throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.metric_reasons.${k}` });
    }
    if (val !== null && r !== null) {
      throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.metric_reasons.${k}_must_be_null` });
    }
  }
}

function validateLeadTimeCoverage(cov, path) {
  if (!cov || typeof cov !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: path });
  for (const k of ['min', 'median', 'p25', 'p75', 'max']) {
    const val = cov[k];
    if (val !== null && (typeof val !== 'number' || !Number.isFinite(val))) {
      throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.${k}` });
    }
  }
  if (!cov.buckets || typeof cov.buckets !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.buckets` });
  for (const b of LEAD_TIME_BUCKETS) {
    const bkt = cov.buckets[b];
    if (!bkt || !Number.isInteger(bkt.sample_count) || bkt.sample_count < 0 || !Number.isInteger(bkt.event_count) || bkt.event_count < 0) {
      throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.buckets.${b}` });
    }
  }
  if (cov.coverage_reasons && typeof cov.coverage_reasons === 'object') {
    for (const k of ['min', 'median', 'p25', 'p75', 'max']) {
      const val = cov[k];
      const r = cov.coverage_reasons[k];
      if (val === null && (typeof r !== 'string' || !r)) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.coverage_reasons.${k}` });
      if (val !== null && r !== null) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.coverage_reasons.${k}_must_be_null` });
    }
  }
}

function validateRankingDiagnostics(diag, path) {
  if (!diag || typeof diag !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: path });
  if (diag.weighting !== 'unweighted') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.weighting` });
  const corr = diag.spearman_correlation;
  if (corr !== null && (typeof corr !== 'number' || !Number.isFinite(corr) || corr < -1 || corr > 1)) {
    throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.spearman_correlation` });
  }
  if (corr === null && (typeof diag.spearman_reason_code !== 'string' || !diag.spearman_reason_code)) {
    throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.spearman_reason_code` });
  }
  if (corr !== null && diag.spearman_reason_code !== null) {
    throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `${path}.spearman_reason_code_must_be_null` });
  }
}

export function validateOverallMetricsStructure(o) {
  if (!o || typeof o !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'overall_metrics_not_object' });
  if (o.evaluation_schema_version !== 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluation_schema_version' });
  if (o.evaluation_policy_version !== 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluation_policy_version' });
  if (!Array.isArray(o.benchmark_modes) || o.benchmark_modes.join(',') !== BENCHMARK_MODES.join(',')) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'benchmark_modes' });
  if (!Array.isArray(o.splits) || o.splits.join(',') !== REPORT_SPLITS.join(',')) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'splits' });
  if (!o.benchmarks || typeof o.benchmarks !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'benchmarks' });

  for (const mode of BENCHMARK_MODES) {
    if (!o.benchmarks[mode] || typeof o.benchmarks[mode] !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `benchmarks.${mode}` });
    for (const split of REPORT_SPLITS) {
      const g = o.benchmarks[mode][split];
      if (!g || typeof g !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `benchmarks.${mode}.${split}` });
      if (!Number.isInteger(g.sample_count) || g.sample_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `benchmarks.${mode}.${split}.sample_count` });
      if (!Number.isInteger(g.event_count) || g.event_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `benchmarks.${mode}.${split}.event_count` });
      if (!Number.isInteger(g.date_count) || g.date_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `benchmarks.${mode}.${split}.date_count` });
      if (typeof g.weight_sum !== 'number' || !Number.isFinite(g.weight_sum) || g.weight_sum < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `benchmarks.${mode}.${split}.weight_sum` });
      validateHeadlineMetrics(g.weighted, `benchmarks.${mode}.${split}.weighted`);
      validateHeadlineMetrics(g.unweighted, `benchmarks.${mode}.${split}.unweighted`);
      validateLeadTimeCoverage(g.lead_time_coverage, `benchmarks.${mode}.${split}.lead_time_coverage`);
      validateRankingDiagnostics(g.ranking_diagnostics, `benchmarks.${mode}.${split}.ranking_diagnostics`);
    }
  }
}

export function validateSummaryStructure(s) {
  if (!s || typeof s !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'summary_not_object' });
  if (typeof s.model_dataset_id !== 'string' || !s.model_dataset_id) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'model_dataset_id' });
  if (s.evaluation_schema_version !== 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluation_schema_version' });
  if (s.evaluation_policy_version !== 1) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluation_policy_version' });
  if (!Array.isArray(s.evaluated_splits) || s.evaluated_splits.join(',') !== 'TRAIN,VALIDATION') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluated_splits' });
  if (s.test_evaluated !== false) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'test_evaluated' });
  if (!Array.isArray(s.benchmark_modes) || s.benchmark_modes.join(',') !== BENCHMARK_MODES.join(',')) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'benchmark_modes' });
  if (!s.evaluated_versions || typeof s.evaluated_versions !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'evaluated_versions' });
  if (!s.groups || typeof s.groups !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'groups' });

  for (const mode of BENCHMARK_MODES) {
    for (const split of REPORT_SPLITS) {
      const key = `${mode}.${split}`;
      const g = s.groups[key];
      if (!g || typeof g !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}` });
      if (g.benchmark_mode !== mode || g.split !== split) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.identity` });
      if (!Number.isInteger(g.sample_count) || g.sample_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.sample_count` });
      if (!Number.isInteger(g.event_count) || g.event_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.event_count` });
      if (!Number.isInteger(g.date_count) || g.date_count < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.date_count` });
      if (typeof g.weight_sum !== 'number' || !Number.isFinite(g.weight_sum) || g.weight_sum < 0) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.weight_sum` });
      validateHeadlineMetrics(g.weighted, `groups.${key}.weighted`);
      validateHeadlineMetrics(g.unweighted, `groups.${key}.unweighted`);
      validateLeadTimeCoverage(g.lead_time_coverage, `groups.${key}.lead_time_coverage`);
      validateRankingDiagnostics(g.ranking_diagnostics, `groups.${key}.ranking_diagnostics`);

      if (!g.baseline_comparison || typeof g.baseline_comparison !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.baseline_comparison` });
      if (!g.worst_slices || typeof g.worst_slices !== 'object') {
        throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.worst_slices` });
      }
      for (const [dim, ws] of Object.entries(g.worst_slices)) {
        if (!ws || typeof ws !== 'object' || !Array.isArray(ws.supported) || !Array.isArray(ws.limited_support)) {
          throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.worst_slices.${dim}` });
        }
      }
      if (!Array.isArray(g.worst_cases) || g.worst_cases.length > 20) throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: `groups.${key}.worst_cases` });
    }
  }
  if (!s.warnings_summary || typeof s.warnings_summary !== 'object') throw Object.assign(new Error('INVALID_JSON_STRUCTURE'), { code: 'EVALUATION_VALIDATION_FAILED', reason_code: 'INVALID_JSON_STRUCTURE', detail: 'warnings_summary' });
}

export function evaluationSchema(version = 1) {
  if (version !== 1) throw Object.assign(new Error('UNSUPPORTED_EVALUATION_SCHEMA'), { code: 'UNSUPPORTED_EVALUATION_SCHEMA' });
  return {
    evaluation_schema_version: version,
    files: { manifest: 'manifest.json', export: EXPORT_FILES },
    csv: {
      encoding: 'UTF-8 BOM',
      record_separator: 'CRLF',
      final_record_separator: true,
      null: 'unquoted empty',
      empty_string: 'quoted empty',
      boolean: '0/1'
    },
    json: {
      manifest: MANIFEST_JSON_SCHEMA,
      overall_metrics: OVERALL_METRICS_JSON_SCHEMA,
      summary: SUMMARY_JSON_SCHEMA
    },
    tables: {
      confusion_matrix: CONFUSION_MATRIX_FIELDS,
      slice_metrics: SLICE_METRICS_FIELDS,
      score_distribution: SCORE_DISTRIBUTION_FIELDS,
      baseline_comparison: BASELINE_COMPARISON_FIELDS,
      error_cases: ERROR_CASES_FIELDS,
      warnings: WARNING_FIELDS
    }
  };
}
export const SCHEMA = evaluationSchema();
