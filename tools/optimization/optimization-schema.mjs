import { SLICE_DIMENSIONS } from '../tuning/tuning-schema.mjs';
import {
  OPTIMIZATION_SCHEMA_VERSION,
  OPTIMIZATION_POLICY_VERSION,
  OPTIMIZATION_MODES,
  OPTIMIZATION_OUTCOMES,
  SEARCH_STAGES,
  TRACE_OUTCOMES,
  GATE_STATUSES,
  DATE_SCOPES,
  optimizationPolicy
} from './optimization-policy.mjs';

const field = (name, type = 'string', nullable = false, range = null, values = null) =>
  ({ name, type, nullable, range, enum: values, unit: null });
const count = name => field(name, 'integer', false, [0, Number.MAX_SAFE_INTEGER]);
const metric = name => field(name, 'number', true);

export const SEARCH_SPACE_UNIT_FIELDS = [
  field('unit_order', 'integer', false, [1, Number.MAX_SAFE_INTEGER]),
  field('parameter_id'),
  field('group_id', 'string', true),
  field('unit_category', 'string', false, null, ['OAT', 'SIMPLEX']),
  field('canonical_path'),
  field('baseline_value'),
  field('included', 'boolean'),
  field('exclusion_reason', 'string', true),
  field('observability_status', 'string', true),
  field('parameter_readiness', 'string', true),
  field('wired_status', 'string', true),
  field('replay_class', 'string', true),
  field('constraint_type', 'string', true),
  field('support_events', 'integer', true, [0, Number.MAX_SAFE_INTEGER]),
  field('support_dates', 'integer', true, [0, Number.MAX_SAFE_INTEGER])
];

export const CANDIDATE_TRACE_FIELDS = [
  field('trace_order', 'integer', false, [1, Number.MAX_SAFE_INTEGER]),
  field('stage', 'string', false, null, SEARCH_STAGES),
  field('round', 'integer', true, [0, Number.MAX_SAFE_INTEGER]),
  field('parent_candidate_id', 'string', true),
  field('parameter_id', 'string', true),
  field('change_json', 'string', true),
  field('candidate_id', 'string', true),
  field('outcome', 'string', false, null, TRACE_OUTCOMES),
  field('reason_code', 'string', true),
  field('budget_index', 'integer', true, [0, Number.MAX_SAFE_INTEGER])
];

export const CANDIDATE_METRICS_FIELDS = [
  field('candidate_id'),
  field('candidate_label', 'string', true),
  field('stage', 'string', false, null, SEARCH_STAGES),
  field('status', 'string', false, null, ['FEASIBLE', 'INFEASIBLE', 'UNEVALUABLE']),
  field('promotable', 'boolean'),
  field('changed_unit_count', 'integer', false, [0, Number.MAX_SAFE_INTEGER]),
  metric('normalized_parameter_distance'),
  count('cohort_sample_count'),
  count('control_success_count'),
  count('candidate_success_count'),
  metric('control_source_coverage_rate'),
  metric('candidate_control_coverage_rate'),
  field('coverage_pass', 'boolean'),
  metric('control_mae'),
  metric('candidate_mae'),
  metric('delta_mae'),
  metric('paired_no_skill_mae'),
  metric('candidate_mae_gap_to_no_skill'),
  metric('control_mae_gap_to_no_skill'),
  metric('control_severe_error_rate'),
  metric('candidate_severe_error_rate'),
  metric('delta_severe_error_rate'),
  metric('control_within_1_accuracy'),
  metric('candidate_within_1_accuracy'),
  metric('control_abs_bias'),
  metric('candidate_abs_bias'),
  metric('control_qwk'),
  metric('candidate_qwk'),
  count('date_count'),
  count('per_date_improved_count'),
  count('per_date_degraded_count'),
  count('per_date_neutral_count'),
  metric('date_improvement_rate'),
  metric('median_date_delta_mae'),
  metric('worst_date_delta_mae'),
  count('lodo_fold_count'),
  count('lodo_improved_count'),
  count('lodo_degraded_count'),
  count('lodo_neutral_count'),
  metric('lodo_improvement_rate'),
  metric('median_lodo_delta_mae'),
  metric('worst_lodo_delta_mae'),
  field('canonical_vector_json')
];

export const CANDIDATE_GUARDRAIL_FIELDS = [
  field('candidate_id'),
  field('gate'),
  field('status', 'string', false, null, GATE_STATUSES),
  metric('observed'),
  metric('threshold'),
  field('reason_code', 'string', true)
];

export const CANDIDATE_SLICE_FIELDS = [
  field('candidate_id'),
  field('slice_dimension', 'string', false, null, SLICE_DIMENSIONS),
  field('slice_value', 'string', true),
  field('slice_value_is_null', 'boolean'),
  count('sample_count'),
  count('event_count'),
  count('date_count'),
  field('supported', 'boolean'),
  field('support_reason', 'string', true),
  metric('control_mae'),
  metric('candidate_mae'),
  metric('delta_mae'),
  metric('delta_severe_error_rate'),
  field('regression', 'boolean')
];

export const CANDIDATE_DATE_FIELDS = [
  field('candidate_id'),
  field('scope', 'string', false, null, DATE_SCOPES),
  field('event_date_local', 'string', true),
  count('sample_count'),
  count('event_count'),
  metric('control_mae'),
  metric('candidate_mae'),
  metric('delta_mae'),
  field('direction', 'string', true, null, ['IMPROVED', 'DEGRADED', 'NEUTRAL', 'UNAVAILABLE'])
];

export const LEADERBOARD_FIELDS = [
  field('rank', 'integer', false, [1, Number.MAX_SAFE_INTEGER]),
  field('candidate_id'),
  field('status', 'string', false, null, ['FEASIBLE', 'INFEASIBLE', 'UNEVALUABLE']),
  field('promotable', 'boolean'),
  metric('objective_value'),
  metric('candidate_mae'),
  metric('delta_mae'),
  metric('severe_error_rate'),
  metric('within_1_accuracy'),
  metric('abs_bias'),
  metric('qwk'),
  field('changed_unit_count', 'integer', false, [0, Number.MAX_SAFE_INTEGER]),
  metric('normalized_parameter_distance')
];

export const WARNING_FIELDS = [
  field('warning_code'),
  field('scope', 'string', true),
  field('candidate_id', 'string', true),
  field('detail', 'string', true)
];

const MANIFEST_JSON_SCHEMA = {
  required: [
    'optimization_schema_version', 'optimization_policy_version', 'optimization_id',
    'descriptor_sha256', 'descriptor', 'optimization_mode', 'optimization_outcome',
    'candidate_freeze_allowed', 'validation_promotion_allowed', 'search_space_id',
    'model_dataset_id', 'model_dataset_manifest_sha256', 'evaluation_id', 'sensitivity_id',
    'engine_runtime_sha256', 'tuning_base_config_sha256', 'parameter_registry_sha256',
    'evaluated_splits', 'validation_evaluated', 'test_evaluated', 'computation_access_policy',
    'result_usage', 'cohort_sample_count', 'cohort_event_count', 'cohort_date_count',
    'validation_disclosure_status', 'validation_disclosure_evidence_id',
    'validation_disclosure_evidence_sha256', 'validation_access_ledger_sha256',
    'candidate_count', 'feasible_candidate_count', 'finalist_count', 'files'
  ]
};

const SUMMARY_JSON_SCHEMA = {
  required: [
    'optimization_id', 'optimization_mode', 'optimization_outcome',
    'candidate_freeze_allowed', 'validation_promotion_allowed', 'search_space_id',
    'candidate_count', 'feasible_candidate_count', 'finalist_count',
    'cohort', 'engineering_readiness', 'data_readiness', 'metric_readiness',
    'global_readiness', 'reasons', 'warnings_summary'
  ]
};

const READINESS_JSON_SCHEMA = {
  required: [
    'optimization_mode', 'optimization_readiness', 'engineering_readiness',
    'data_readiness', 'metric_readiness', 'label_concentration', 'reasons'
  ]
};

export function optimizationSchema(version = OPTIMIZATION_SCHEMA_VERSION) {
  if (version !== OPTIMIZATION_SCHEMA_VERSION) {
    throw Object.assign(new Error('UNSUPPORTED_OPTIMIZATION_SCHEMA'), { code: 'UNSUPPORTED_OPTIMIZATION_SCHEMA' });
  }
  const files = [...optimizationPolicy().package.export_files].sort();
  return {
    optimization_schema_version: version,
    optimization_policy_version: OPTIMIZATION_POLICY_VERSION,
    modes: OPTIMIZATION_MODES,
    outcomes: OPTIMIZATION_OUTCOMES,
    files: { manifest: 'manifest.json', freeze: 'candidate_freeze.json', export: files },
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
      candidate_trace: CANDIDATE_TRACE_FIELDS,
      candidate_metrics: CANDIDATE_METRICS_FIELDS,
      candidate_guardrails: CANDIDATE_GUARDRAIL_FIELDS,
      candidate_slice_regressions: CANDIDATE_SLICE_FIELDS,
      candidate_date_stability: CANDIDATE_DATE_FIELDS,
      leaderboard: LEADERBOARD_FIELDS,
      warnings: WARNING_FIELDS
    },
    search_space_units: SEARCH_SPACE_UNIT_FIELDS
  };
}

export const CSV_TABLES = Object.freeze({
  'candidate_trace.csv': CANDIDATE_TRACE_FIELDS,
  'candidate_metrics.csv': CANDIDATE_METRICS_FIELDS,
  'candidate_guardrails.csv': CANDIDATE_GUARDRAIL_FIELDS,
  'candidate_slice_regressions.csv': CANDIDATE_SLICE_FIELDS,
  'candidate_date_stability.csv': CANDIDATE_DATE_FIELDS,
  'leaderboard.csv': LEADERBOARD_FIELDS,
  'reports/warnings.csv': WARNING_FIELDS
});

export const FILES = Object.freeze([...optimizationPolicy().package.export_files].sort());
export const MANIFEST_FILE = optimizationPolicy().package.manifest_file;
export const FREEZE_FILE = optimizationPolicy().package.freeze_file;
export const SCHEMA = optimizationSchema();
