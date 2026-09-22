/**
 * Phase 6 Optimization Policy. Kept separate from the Sensitivity Policy so V2.5.2 packages
 * stay byte-identical while V2.5.3 gains its own search contract, gates and package layout.
 *
 * Every number here is part of `optimization_input_id`: changing one changes the campaign.
 */

export const OPTIMIZATION_SCHEMA_VERSION = 1;
export const OPTIMIZATION_POLICY_VERSION = 1;

export const OPTIMIZATION_MODES = Object.freeze(['EXPLORATORY_SEARCH', 'FORMAL_OPTIMIZATION']);
export const OPTIMIZATION_OUTCOMES = Object.freeze([
  'EXPLORATORY_POINTS_GENERATED', 'NO_EXPLORATORY_POINT',
  'CANDIDATES_PROMOTED', 'NO_PROMOTABLE_CANDIDATE'
]);
export const SEARCH_STAGES = Object.freeze(['CONTROL', 'COARSE_SEED', 'BEAM', 'REFINEMENT']);
export const TRACE_OUTCOMES = Object.freeze(['ACCEPTED', 'DUPLICATE', 'INFEASIBLE', 'UNEVALUABLE']);
export const GATE_STATUSES = Object.freeze(['PASS', 'FAIL', 'NOT_APPLICABLE']);
export const DATE_SCOPES = Object.freeze(['PER_DATE', 'LODO']);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * GLOBAL_CORE_V1 declaration order. The vector order, the budget truncation order and the
 * deterministic tie-breaks all read this list, so it must never be re-sorted at runtime.
 */
export const GLOBAL_CORE_V1_UNITS = Object.freeze([
  'component_weights',
  'atmosphere_quality_base',
  'atmosphere_quality_scale',
  'high_cloud_center',
  'high_cloud_width'
]);

export const SEARCH_SPACES = Object.freeze({
  GLOBAL_CORE_V1: Object.freeze({ declared_units: GLOBAL_CORE_V1_UNITS })
});

/** Objective and guardrail terms are copied into objective_policy.json / guardrail_policy.json. */
const OBJECTIVE_POLICY = Object.freeze({
  primary: { metric: 'mae', weighting: 'weighted', direction: 'MINIMIZE' },
  tie_breakers: Object.freeze([
    { metric: 'severe_error_rate', weighting: 'weighted', direction: 'MINIMIZE' },
    { metric: 'within_1_accuracy', weighting: 'weighted', direction: 'MAXIMIZE' },
    { metric: 'bias', weighting: 'weighted', direction: 'MINIMIZE_ABSOLUTE' },
    { metric: 'qwk', weighting: 'weighted', direction: 'MAXIMIZE' }
  ])
});

const GUARDRAIL_POLICY = Object.freeze({
  no_skill_comparator: 'TRAIN_WEIGHTED_MEDIAN_ORDINAL',
  control_relative_gates: Object.freeze([
    'WEIGHTED_MAE_STRICTLY_BETTER',
    'SEVERE_ERROR_RATE_NOT_WORSE',
    'WITHIN_1_ACCURACY_NOT_WORSE',
    'ABSOLUTE_BIAS_NOT_WORSE',
    'QWK_NOT_WORSE'
  ]),
  formal_only_gates: Object.freeze([
    'NO_SKILL_MAE_STRICTLY_BETTER',
    'DATE_ROBUSTNESS',
    'LODO_ROBUSTNESS',
    'SLICE_REGRESSION'
  ])
});

const OPTIMIZATION_SELECTION_RULE = Object.freeze({
  evaluated_split: 'VALIDATION',
  metric_compare_epsilon: 1e-12,
  eligibility: Object.freeze([
    'candidate_control_coverage_rate = 1.0',
    'weighted_mae < control weighted_mae',
    'severe_error_rate <= control',
    'within_1_accuracy >= control',
    'abs(weighted_bias) <= abs(control weighted_bias)',
    'QWK uses the section 13 null rule',
    'weighted_mae < same-cohort fixed no-skill MAE'
  ]),
  ranking: Object.freeze([
    'weighted_mae ASC',
    'severe_error_rate ASC',
    'within_1_accuracy DESC',
    'abs(weighted_bias) ASC',
    'QWK DESC, null last',
    'TRAIN changed_unit_count ASC',
    'TRAIN normalized_parameter_distance ASC',
    'candidate_id ASC'
  ]),
  on_no_validation_pass: 'FAIL_NO_VALIDATION_CANDIDATE'
});

export const POLICY_V1 = deepFreeze({
  optimization_schema_version: OPTIMIZATION_SCHEMA_VERSION,
  optimization_policy_version: OPTIMIZATION_POLICY_VERSION,
  modes: OPTIMIZATION_MODES,
  outcomes: OPTIMIZATION_OUTCOMES,
  // Optimization never reads TEST; VALIDATION effects are reserved for V2.5.4.
  computation_split: 'TRAIN',
  evaluation_split: 'VALIDATION',
  forbidden_splits: ['TEST'],
  search_space: { id: 'GLOBAL_CORE_V1', declared_units: GLOBAL_CORE_V1_UNITS },
  algorithm: {
    name: 'DETERMINISTIC_CONSTRAINED_BEAM_COORDINATE_SEARCH',
    beam_width: 8,
    max_rounds: 4,
    max_unique_candidates: 500,
    stage_a_b_budget: 400,
    stage_c_budget: 100,
    refinement_rounds: 2,
    refinement_step_factor: 0.5,
    seed_includes_control: true
  },
  numeric: {
    numeric_precision_decimal_places: 12,
    metric_output_decimal_places: 12,
    metric_compare_epsilon: 1e-12
  },
  coverage: {
    exploratory_min_control_source_coverage_rate: 0.95,
    exploratory_min_candidate_control_coverage_rate: 0.95,
    formal_min_control_source_coverage_rate: 1,
    formal_min_candidate_control_coverage_rate: 1
  },
  // Sensitivity V2 remains PROVISIONAL_PROXY / EXPLORATORY_ONLY, so a real FORMAL run needs a
  // newer upstream Policy. Nothing here can be overridden from the command line.
  formal_preconditions: {
    engineering_readiness: 'READY',
    data_readiness: 'READY',
    metric_readiness: 'READY',
    sensitivity_result_usage: 'FORMAL'
  },
  readiness_thresholds: {
    min_train_primary_events: 100,
    min_train_unique_dates: 14,
    required_replay_usable_rate: 1,
    min_gt_levels: 3,
    min_events_per_gt_level: 5,
    max_single_date_event_share: 0.5,
    max_single_city_event_share: 0.5,
    max_single_gt_level_event_share: 0.6
  },
  date_robustness: {
    ready_dates: 14,
    min_per_date_improved_count: 2,
    require_full_lodo_coverage: true,
    required_lodo_improvement_rate: 1,
    require_worst_lodo_strictly_better: true
  },
  slice_support: {
    min_event_count: 5,
    min_date_count: 2
  },
  objective: OBJECTIVE_POLICY,
  guardrails: GUARDRAIL_POLICY,
  finalist_count_max: 5,
  validation_selection_rule: OPTIMIZATION_SELECTION_RULE,
  package: {
    manifest_file: 'manifest.json',
    freeze_file: 'candidate_freeze.json',
    export_files: [
      'candidate_date_stability.csv',
      'candidate_guardrails.csv',
      'candidate_metrics.csv',
      'candidate_slice_regressions.csv',
      'candidate_trace.csv',
      'finalists.json',
      'guardrail_policy.json',
      'leaderboard.csv',
      'objective_policy.json',
      'optimization_plan.json',
      'policy.json',
      'readiness.json',
      'reports/summary.json',
      'reports/warnings.csv',
      'schema.json',
      'search_points.json',
      'search_space.json',
      'verified_source_identities.json'
    ]
  }
});

export function optimizationPolicy(version = OPTIMIZATION_POLICY_VERSION) {
  if (version !== OPTIMIZATION_POLICY_VERSION) {
    throw Object.assign(new Error('UNSUPPORTED_OPTIMIZATION_POLICY'), { code: 'UNSUPPORTED_OPTIMIZATION_POLICY' });
  }
  return POLICY_V1;
}

export function objectivePolicyDocument() {
  return {
    optimization_policy_version: OPTIMIZATION_POLICY_VERSION,
    ...POLICY_V1.objective,
    metric_compare_epsilon: POLICY_V1.numeric.metric_compare_epsilon
  };
}

export function guardrailPolicyDocument() {
  return {
    optimization_policy_version: OPTIMIZATION_POLICY_VERSION,
    ...POLICY_V1.guardrails,
    coverage: POLICY_V1.coverage,
    date_robustness: POLICY_V1.date_robustness,
    slice_support: POLICY_V1.slice_support,
    readiness_thresholds: POLICY_V1.readiness_thresholds,
    finalist_count_max: POLICY_V1.finalist_count_max
  };
}
