import {validationPolicy} from './validation-policy.mjs';
const field = (name, type = 'string', nullable = false) =>
  ({ name, type, nullable, range: null, enum: null, unit: null });
const number = (name, nullable = true) => field(name, 'number', nullable);
const integer = (name, nullable = false) => field(name, 'integer', nullable);

export const CSV_TABLES = Object.freeze({
  'candidate_sample_predictions.csv': [
    field('candidate_id'), field('snapshot_id'), field('event_id'), field('event_date_local'),
    field('location_key'), field('lead_time_bucket'), number('lead_time_minutes', false),
    integer('prediction_time_epoch'), field('city'), field('gt_label'),
    field('gt_status', 'string', true), field('gt_basis', 'string', true),
    field('regime_label', 'string', true), field('sky_evolution_state', 'string', true),
    field('scheduled_slot', 'string', true), field('snapshot_source', 'string', true),
    field('tile_radar_available', 'boolean', true), field('tile_sat_available', 'boolean', true),
    integer('gt_ordinal'), number('gt_confidence', false), number('event_normalized_weight', false),
    integer('control_score'), integer('candidate_score'), integer('control_ordinal'), integer('candidate_ordinal')
  ],
  'candidate_validation_metrics.csv': [
    field('candidate_id'), integer('sample_count'), integer('event_count'), integer('cohort_sample_count'),
    integer('control_success_count'), integer('candidate_success_count'),
    number('control_source_coverage_rate'), number('candidate_control_coverage_rate'),
    number('control_mae'), number('candidate_mae'), number('delta_mae'), number('no_skill_mae'),
    number('severe_error_rate'), number('within_1_accuracy'), number('abs_bias'), number('qwk'),
    integer('closest_sample_count'), integer('closest_event_count'),
    number('closest_control_mae'), number('closest_candidate_mae'), number('closest_delta_mae')
  ],
  'candidate_guardrails.csv': [
    field('candidate_id'), field('classification'), field('reason_codes_json')
  ],
  'candidate_slice_metrics.csv': [
    field('candidate_id'), field('slice_dimension'), field('slice_value', 'string', true),
    field('slice_value_is_null', 'boolean'), integer('sample_count'), integer('event_count'),
    integer('date_count'), field('supported', 'boolean'), number('delta_mae'),
    number('delta_severe_error_rate'), field('regression', 'boolean')
  ],
  'candidate_date_stability.csv': [
    field('candidate_id'), field('scope'), field('event_date_local'), integer('sample_count'),
    integer('event_count'), number('control_mae'), number('candidate_mae'),
    number('delta_mae'), field('direction')
  ],
  'candidate_bootstrap.csv': [
    field('candidate_id'), field('benchmark'), field('cohort_sha256', 'string', true),
    integer('date_count'), integer('replicate_count', true), integer('seed'), field('algorithm', 'string', true),
    number('point_delta_mae'), number('ci_lower'), number('ci_upper'), field('status'),
    field('reason_code', 'string', true)
  ],
  'replay_reference_parity.csv': [
    field('snapshot_id'), field('event_id'), field('split'), field('engine_build_sha'),
    field('pass', 'boolean'), integer('actual_score', true), integer('reference_score', true),
    number('score_delta'), field('issue_codes', 'string', true)
  ],
  'control_alignment.csv': [
    field('snapshot_id'), field('event_id'), integer('historical_score'),
    integer('control_score', true), number('score_delta'), field('status')
  ],
  'replay_failures.csv': [
    field('candidate_id', 'string', true), field('snapshot_id'), field('event_id'),
    field('phase'), field('error_code')
  ],
  'candidate_comparison.csv': [
    field('candidate_id'), field('classification'), integer('rank', true),
    number('mae'), number('severe_error_rate'), number('within_1_accuracy'),
    number('abs_bias'), number('qwk'), integer('changed_unit_count'),
    number('normalized_parameter_distance')
  ],
  'reports/warnings.csv': [field('warning_code'), field('candidate_id', 'string', true)],
  'reports/error_cases.csv': [field('candidate_id'), field('snapshot_id'), number('abs_error_delta')]
});

export const CORE_JSON_FILES = Object.freeze([
  'schema.json', 'policy.json', 'validation_plan.json', 'verified_source_identities.json',
  'validation_disclosure_evidence.json', 'selection_result.json'
]);

export const RESULT_FILES = Object.freeze([
  ...CORE_JSON_FILES, ...Object.keys(CSV_TABLES), 'reports/summary.json'
]);

export const SELECTED_FILES = Object.freeze([
  'selected_candidate.json', 'selected_effective_config.json'
]);

export function validationResultFiles(version = 1) {
  if(version===5)return [...validationPolicy(5).result_files];
  return version === 3 ? [...RESULT_FILES, 'gt_level_support.json', 'formal_context.json'] : [2, 4].includes(version) ? [...RESULT_FILES, 'gt_level_support.json'] : RESULT_FILES;
}

export function validationSchema({ includeSelected = false, policyVersion = 1 } = {}) {
  if(policyVersion===5){if(includeSelected)throw Object.assign(new Error('POLICY_5_SELECTED_FORBIDDEN'),{code:'POLICY_5_SELECTED_FORBIDDEN'});return {validation_schema_version:2,validation_policy_version:5,files:validationResultFiles(5)};}
  if (policyVersion === 4 && includeSelected) throw Object.assign(new Error('POLICY_4_SELECTED_FORBIDDEN'), { code: 'POLICY_4_SELECTED_FORBIDDEN' });
  if (policyVersion >= 2) return { validation_schema_version: [3, 4].includes(policyVersion) ? 2 : 1, validation_policy_version: policyVersion,
    tables: CSV_TABLES, json_files: [...CORE_JSON_FILES, 'gt_level_support.json', ...(policyVersion === 3 ? ['formal_context.json'] : []), ...(includeSelected ? SELECTED_FILES : [])],
    result_files: [...validationResultFiles(policyVersion), ...(includeSelected ? SELECTED_FILES : [])],
    required_diagnostics: { plan: ['gt_level_support', 'gt_level_support_sha256', 'gt_level_support_cohort', 'upstream_train_support'],
      summary: ['gt_level_support', 'gt_level_support_sha256', 'upstream_train_support', 'rare_level_audit'],
      support: ['cohort', 'cohort_sha256', 'gt_level_support', 'gt_level_support_sha256', 'rare_level_audit'] } };
  return { validation_schema_version: 1, tables: CSV_TABLES,
    json_files: includeSelected ? [...CORE_JSON_FILES, ...SELECTED_FILES] : CORE_JSON_FILES,
    result_files: includeSelected ? [...RESULT_FILES, ...SELECTED_FILES] : RESULT_FILES };
}
