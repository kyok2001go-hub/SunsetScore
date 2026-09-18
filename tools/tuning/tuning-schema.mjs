import { GT_LABELS, LEAD_TIME_BUCKETS } from '../evaluation/evaluation-schema.mjs';
import {
  TUNING_SCHEMA_VERSION,
  TUNING_POLICY_VERSION,
  REPLAY_CLASSES,
  WIRED_STATUSES,
  CONSTRAINT_TYPES,
  PARAMETER_STATES,
  GLOBAL_STATES,
  OBSERVABILITY_STATES,
  EXPERIMENT_KINDS,
  ABLATION_LAYERS,
  tuningPolicy
} from './tuning-policy.mjs';

const field = (name, type = 'string', nullable = false, range = null, values = null) =>
  ({ name, type, nullable, range, enum: values, unit: null });
const count = name => field(name, 'integer', false, [0, Number.MAX_SAFE_INTEGER]);

export const SPLITS = ['TRAIN'];
export const SLICE_DIMENSIONS = [
  'lead_time_bucket', 'city', 'gt_label', 'gt_status', 'gt_basis',
  'regime_label', 'sky_evolution_state', 'scheduled_slot', 'snapshot_source',
  'tile_radar_available', 'tile_sat_available'
];
export const FIXED_SLICE_ENUMS = {
  lead_time_bucket: LEAD_TIME_BUCKETS,
  gt_label: GT_LABELS,
  gt_status: ['STRONG', 'MEDIUM', 'WEAK', 'DISPUTED', 'UNLABELED'],
  gt_basis: ['OBSERVATION_AGGREGATED', 'ADMIN_ADJUDICATED'],
  snapshot_source: ['github_schedule', 'github_manual', 'user_feedback'],
  tile_radar_available: ['false', 'true'],
  tile_sat_available: ['false', 'true']
};

const error = (detail, reason = 'INVALID_JSON_STRUCTURE') =>
  Object.assign(new Error(reason), { code: 'TUNING_VALIDATION_FAILED', reason_code: reason, detail });

export const REPLAY_PARITY_FIELDS = [
  field('snapshot_id'), field('event_id'), field('split', 'string', false, null, SPLITS),
  field('event_date_local'), field('city', 'string', true),
  field('lead_time_bucket', 'string', true, null, LEAD_TIME_BUCKETS),
  field('engine_build_sha'), field('config_hash'),
  field('pass', 'boolean'),
  field('actual_score', 'integer', false, [0, 100]),
  field('reference_score', 'integer', false, [0, 100]),
  field('score_delta', 'integer', true),
  field('max_component_abs_delta', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  field('issue_codes', 'string', true)
];

export const EXPERIMENT_PLAN_FIELDS = [
  count('experiment_order'), field('experiment_id'),
  field('experiment_kind', 'string', false, null, EXPERIMENT_KINDS),
  field('parameter_id', 'string', true), field('group_id', 'string', true),
  field('canonical_path', 'string', true),
  field('probe_index', 'integer', true, [0, Number.MAX_SAFE_INTEGER]),
  field('probe_value', 'number', true),
  field('ablation', 'string', true), field('ablation_layer', 'string', true, null, ABLATION_LAYERS),
  count('replay_count')
];

const metricTriplet = name => [
  field('control_' + name, 'number', true), field('experiment_' + name, 'number', true), field('delta_' + name, 'number', true)
];

/**
 * Paired cohort accounting. `sample_count` / `event_count` / `date_count` remain the metric
 * basis, which is exactly the paired subset; these fields make the drop visible and let the
 * validator cross-check the two spellings instead of trusting either one.
 */
const coverageFields = () => [
  count('cohort_sample_count'),
  count('paired_sample_count'),
  count('paired_event_count'),
  field('coverage_rate', 'number', true, [0, 1]),
  count('failure_count'),
  count('control_failure_count'),
  count('experiment_failure_count')
];

export const EXPERIMENT_METRICS_FIELDS = [
  field('experiment_id'), field('experiment_kind', 'string', false, null, EXPERIMENT_KINDS),
  field('parameter_id', 'string', true), field('group_id', 'string', true),
  field('canonical_path', 'string', true), field('probe_value', 'number', true),
  field('ablation', 'string', true),
  count('sample_count'), count('event_count'), count('date_count'),
  ...coverageFields(),
  field('weight_sum', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  field('changed_score_rate', 'number', true, [0, 1]),
  field('changed_ordinal_rate', 'number', true, [0, 1]),
  field('mean_score_delta', 'number', true), field('median_score_delta', 'number', true),
  field('mean_abs_score_delta', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  field('p95_abs_score_delta', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  ...metricTriplet('mae'), ...metricTriplet('bias'), ...metricTriplet('exact_accuracy'),
  ...metricTriplet('within_1_accuracy'), ...metricTriplet('severe_error_rate'),
  field('control_overprediction_rate', 'number', true, [0, 1]),
  field('experiment_overprediction_rate', 'number', true, [0, 1]),
  field('control_underprediction_rate', 'number', true, [0, 1]),
  field('experiment_underprediction_rate', 'number', true, [0, 1]),
  ...metricTriplet('qwk'),
  // Leave-one-date-out folds for this single experiment. Kept per experiment so the
  // parameter level summary never has to mix folds from different probes.
  field('lodo_fold_count', 'integer', false, [0, Number.MAX_SAFE_INTEGER]),
  field('lodo_improved_count', 'integer', false, [0, Number.MAX_SAFE_INTEGER]),
  field('lodo_degraded_count', 'integer', false, [0, Number.MAX_SAFE_INTEGER]),
  field('lodo_stability_ratio', 'number', true, [0, 1]),
  field('lodo_reason_code', 'string', true),
  field('limited_date_coverage', 'boolean'),
  field('effective_composition_json', 'string', true)
];

export const SAMPLE_DELTA_FIELDS = [
  field('experiment_id'), field('snapshot_id'), field('event_id'), field('event_date_local'),
  field('city', 'string', true),
  field('lead_time_bucket', 'string', true, null, LEAD_TIME_BUCKETS),
  field('gt_label', 'string', false, null, GT_LABELS),
  field('gt_ordinal', 'integer', false, [0, 4]),
  field('gt_confidence', 'number', false, [0, 1]),
  field('event_normalized_weight', 'number', false, [0, Number.MAX_SAFE_INTEGER]),
  field('control_score', 'integer', false, [0, 100]),
  field('experiment_score', 'integer', false, [0, 100]),
  field('score_delta', 'integer'),
  field('control_ordinal', 'integer', false, [0, 4]),
  field('experiment_ordinal', 'integer', false, [0, 4]),
  field('ordinal_delta', 'integer'),
  field('control_abs_error', 'integer', false, [0, 4]),
  field('experiment_abs_error', 'integer', false, [0, 4]),
  field('abs_error_delta', 'integer')
];

export const SLICE_DELTA_FIELDS = [
  field('experiment_id'),
  field('parameter_id', 'string', true),
  field('parameter_value', 'number', true),
  field('slice_dimension', 'string', false, null, SLICE_DIMENSIONS),
  field('slice_value', 'string', true), field('slice_value_is_null', 'boolean'),
  count('sample_count'), count('event_count'), count('date_count'),
  field('weight_sum', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  field('changed_score_rate', 'number', true, [0, 1]),
  field('mean_score_delta', 'number', true), field('mean_abs_score_delta', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  field('control_mae', 'number', true), field('experiment_mae', 'number', true), field('delta_mae', 'number', true),
  field('improved_sample_rate', 'number', true, [0, 1]), field('degraded_sample_rate', 'number', true, [0, 1])
];

export const ABLATION_METRICS_FIELDS = [
  field('experiment_id'), field('ablation'), field('ablation_layer', 'string', false, null, ABLATION_LAYERS),
  count('sample_count'), count('event_count'), count('date_count'),
  ...coverageFields(),
  field('weight_sum', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  count('affected_sample_count'),
  field('changed_score_rate', 'number', true, [0, 1]),
  field('changed_ordinal_rate', 'number', true, [0, 1]),
  field('mean_score_delta', 'number', true), field('median_score_delta', 'number', true),
  field('mean_abs_score_delta', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  field('p95_abs_score_delta', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  ...metricTriplet('mae'), ...metricTriplet('bias'), ...metricTriplet('exact_accuracy'),
  ...metricTriplet('within_1_accuracy'), ...metricTriplet('severe_error_rate'),
  ...metricTriplet('qwk')
];

export const PARAMETER_SUMMARY_FIELDS = [
  field('parameter_id'), field('group_id', 'string', true), field('canonical_path', 'string', true),
  field('unit_category'),
  field('replay_class', 'string', false, null, REPLAY_CLASSES),
  field('wired_status', 'string', false, null, WIRED_STATUSES),
  field('optimizable', 'boolean'), field('ablation_supported', 'boolean'),
  field('activation_condition', 'string', true),
  field('constraint_types', 'string', true),
  field('parameter_readiness', 'string', false, null, PARAMETER_STATES),
  field('observability_status', 'string', false, null, OBSERVABILITY_STATES),
  field('reason_code', 'string', true),
  count('support_samples'), count('support_events'), count('support_dates'),
  count('probe_count'), count('evaluated_probe_count'),
  field('max_changed_score_rate', 'number', true, [0, 1]),
  field('max_mean_abs_score_delta', 'number', true, [0, Number.MAX_SAFE_INTEGER]),
  field('min_delta_mae', 'number', true), field('max_delta_mae', 'number', true),
  field('best_delta_mae', 'number', true),
  count('date_count'), count('improved_date_count'), count('degraded_date_count'),
  field('direction_stability_ratio', 'number', true, [0, 1]),
  field('limited_date_coverage', 'boolean'),
  // Which probe supplies the parameter level stability numbers (largest |delta_mae|).
  field('stability_representative_experiment_id', 'string', true)
];

export const WARNING_FIELDS = [
  field('warning_code'), field('scope', 'string', true),
  field('parameter_id', 'string', true), field('experiment_id', 'string', true),
  field('slice_dimension', 'string', true, null, SLICE_DIMENSIONS),
  field('slice_value', 'string', true), field('slice_value_is_null', 'boolean', true)
];

export const EXPERIMENT_FAILURE_FIELDS = [
  field('stage', 'string', false, null, ['CONTROL', 'EXPERIMENT']),
  // CONTROL failures affect every experiment, so they carry no experiment id.
  field('experiment_id', 'string', true),
  field('parameter_id', 'string', true),
  field('probe_value', 'number', true),
  field('snapshot_id'), field('event_id', 'string', true), field('event_date_local', 'string', true),
  field('error_code')
];

export const MANIFEST_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'tuning_schema_version', 'tuning_policy_version', 'sensitivity_id',
    'descriptor_sha256', 'descriptor',
    'model_dataset_id', 'model_dataset_manifest_sha256', 'model_dataset_schema_version', 'model_dataset_policy_version',
    'source_dataset_id', 'ground_truth_id',
    'evaluation_id', 'evaluation_manifest_sha256',
    'engine_runtime_sha256', 'tuning_base_config_sha256',
    'observed_engine_build_shas', 'observed_config_hashes',
    'parameter_registry_version', 'parameter_registry_sha256',
    'evaluated_splits', 'validation_evaluated', 'test_evaluated',
    'source_validation_scope', 'computation_access_policy', 'result_usage',
    'sample_count', 'event_count', 'date_count', 'experiment_count',
    'schema_sha256', 'policy_sha256', 'files'
  ]
});

export const READINESS_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'global_readiness', 'reasons', 'metrics', 'thresholds', 'cohort',
    'parameter_readiness', 'warnings'
  ]
});

export const SUMMARY_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'sensitivity_id', 'model_dataset_id', 'evaluation_id',
    'global_readiness', 'result_usage',
    'cohort', 'experiment_count', 'replay_parity', 'parameter_summary', 'ablation_summary', 'warnings_summary'
  ]
});

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireKeys(value, keys, name) {
  if (!isObject(value)) throw error(name + '_NOT_OBJECT');
  for (const key of keys) if (!(key in value)) throw error(name + '.' + key);
}

export function validateManifestStructure(manifest) {
  requireKeys(manifest, MANIFEST_JSON_SCHEMA.required, 'manifest');
  if (manifest.tuning_schema_version !== TUNING_SCHEMA_VERSION) throw error('tuning_schema_version');
  if (manifest.tuning_policy_version !== TUNING_POLICY_VERSION) throw error('tuning_policy_version');
  if (typeof manifest.evaluation_id !== 'string' || !manifest.evaluation_id) throw error('evaluation_id');
  if (manifest.validation_evaluated !== false) throw error('validation_evaluated');
  if (manifest.test_evaluated !== false) throw error('test_evaluated');
  if (JSON.stringify(manifest.evaluated_splits) !== JSON.stringify(SPLITS)) throw error('evaluated_splits');
  if (manifest.computation_access_policy !== 'TRAIN_ONLY') throw error('computation_access_policy');
  if (manifest.source_validation_scope !== 'SOURCE_LINKED') throw error('source_validation_scope');
  if (!['EXPLORATORY_ONLY', 'FORMAL'].includes(manifest.result_usage)) throw error('result_usage');
  if (!/^[a-f0-9]{64}$/.test(manifest.engine_runtime_sha256 || '')) throw error('engine_runtime_sha256');
  if (!/^[a-f0-9]{64}$/.test(manifest.tuning_base_config_sha256 || '')) throw error('tuning_base_config_sha256');
  if (!/^[a-f0-9]{64}$/.test(manifest.parameter_registry_sha256 || '')) throw error('parameter_registry_sha256');
  if (!Array.isArray(manifest.observed_engine_build_shas) || !manifest.observed_engine_build_shas.length) throw error('observed_engine_build_shas');
  if (!Array.isArray(manifest.observed_config_hashes) || !manifest.observed_config_hashes.length) throw error('observed_config_hashes');
  for (const key of ['sample_count', 'event_count', 'date_count', 'experiment_count']) {
    if (!Number.isInteger(manifest[key]) || manifest[key] < 0) throw error(key);
  }
}

export function validateReadinessStructure(readiness) {
  requireKeys(readiness, READINESS_JSON_SCHEMA.required, 'readiness');
  if (!GLOBAL_STATES.includes(readiness.global_readiness)) throw error('global_readiness');
  if (!Array.isArray(readiness.reasons)) throw error('reasons');
  requireKeys(readiness.metrics, ['primary_events', 'unique_dates', 'samples', 'replay_usable_rate', 'gt_levels', 'gt_level_event_counts', 'max_date_event_share', 'max_city_event_share'], 'readiness.metrics');
  if (!Array.isArray(readiness.parameter_readiness)) throw error('readiness.parameter_readiness');
}

export function validateSummaryStructure(summary) {
  requireKeys(summary, SUMMARY_JSON_SCHEMA.required, 'summary');
  if (!GLOBAL_STATES.includes(summary.global_readiness)) throw error('summary.global_readiness');
  if (!Array.isArray(summary.parameter_summary)) throw error('summary.parameter_summary');
  if (!Array.isArray(summary.ablation_summary)) throw error('summary.ablation_summary');
}

export function tuningSchema(version = TUNING_SCHEMA_VERSION) {
  if (version !== TUNING_SCHEMA_VERSION) {
    throw Object.assign(new Error('UNSUPPORTED_TUNING_SCHEMA'), { code: 'UNSUPPORTED_TUNING_SCHEMA' });
  }
  return {
    tuning_schema_version: version,
    files: { manifest: 'manifest.json', export: [...POLICY_FILES].sort() },
    csv: {
      encoding: 'UTF-8 BOM',
      record_separator: 'CRLF',
      final_record_separator: true,
      null: 'unquoted empty',
      boolean: '0/1'
    },
    json: {
      manifest: MANIFEST_JSON_SCHEMA,
      readiness: READINESS_JSON_SCHEMA,
      summary: SUMMARY_JSON_SCHEMA
    },
    tables: {
      replay_parity: REPLAY_PARITY_FIELDS,
      experiment_plan: EXPERIMENT_PLAN_FIELDS,
      experiment_metrics: EXPERIMENT_METRICS_FIELDS,
      sample_deltas: SAMPLE_DELTA_FIELDS,
      slice_deltas: SLICE_DELTA_FIELDS,
      ablation_metrics: ABLATION_METRICS_FIELDS,
      experiment_failures: EXPERIMENT_FAILURE_FIELDS,
      parameter_summary: PARAMETER_SUMMARY_FIELDS,
      warnings: WARNING_FIELDS
    }
  };
}

export const CSV_TABLES = Object.freeze({
  'replay_parity.csv': REPLAY_PARITY_FIELDS,
  'experiment_plan.csv': EXPERIMENT_PLAN_FIELDS,
  'experiment_metrics.csv': EXPERIMENT_METRICS_FIELDS,
  'sample_deltas.csv': SAMPLE_DELTA_FIELDS,
  'slice_deltas.csv': SLICE_DELTA_FIELDS,
  'ablation_metrics.csv': ABLATION_METRICS_FIELDS,
  'experiment_failures.csv': EXPERIMENT_FAILURE_FIELDS,
  'parameter_summary.csv': PARAMETER_SUMMARY_FIELDS,
  'reports/warnings.csv': WARNING_FIELDS
});

// Single source of truth: the package file list lives in the policy, not in two places.
export const POLICY_FILES = Object.freeze([...tuningPolicy().package.export_files]);

export const SCHEMA = tuningSchema();
