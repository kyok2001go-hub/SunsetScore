import { fail } from '../dataset/lib/common.mjs';
export function scorePolicy(version = 1) {
  if (version === 2) return boundaryPolicy();
  if (version !== 1) fail('UNSUPPORTED_SCORE_DIAGNOSTIC_POLICY');
  return { score_diagnostic_policy_version: 1, result_usage: 'DEVELOPMENT_ONLY', computation_split: 'TRAIN',
    forbidden_effect_splits: ['VALIDATION', 'TEST'], control: 'FROZEN_V2545_CONTROL', trace_contract: 'OFFLINE_OBSERVER_V1',
    benchmarks: ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'], ordinal_labels: ['poor', 'fair', 'good', 'very_good', 'excellent'],
    score_type: 'rounded_score', weights: 'GT_CONFIDENCE_DIVIDED_BY_COHORT_EVENT_SNAPSHOTS',
    required_trace_stages: ['weighted_components','atmosphere_quality','horizon_gate','structure_bonus','transition_bonus',
      'weather_penalty','core_clamp','hard_gate','core_round','sky_evolution','golden_window','final_clamp','final_round'],
    quantiles: 'SORT_SCORE_THEN_SNAPSHOT_ID_FIRST_CUMULATIVE_WEIGHT_GE_TARGET', bin_width: 10,
    pair_metrics: 'PRODUCT_WEIGHTS_TIE_HALF_ORDINAL_EXCLUDES_SAME_EVENT',
    support: { main_events: 30, main_dates: 7, binary_events: 10, binary_dates: 3, slice_events: 5, slice_dates: 2 },
    calibration: { algorithm: 'WEIGHTED_PAVA_V1', target: 'GT_ORDINAL', ties: 'AGGREGATE_SCORE_BEFORE_PAVA',
      interpolation: 'LINEAR_ENDPOINT_CONSTANT', rounding: 'CLAMP_FLOOR_Y_PLUS_HALF', minimum_levels: 2,
      full_train_fit_allowed: false, folds: 'FROZEN_PARENT_MEMBERS' },
    bootstrap: { algorithm: 'DATE_BLOCK_PERCENTILE', prng: 'xorshift32-v1', replicates: 2000,
      minimum_valid: 1900, lower: 0.025, upper: 0.975, seed_algorithm: 'PHASE7_BOOTSTRAP_V1_SHA256_PLAN_CORE_UINT32BE' },
    routing: { auc_min: 0.60, auc_ci_lower_strict: 0.50, ordered_strict: 0.50, epsilon: 1e-12,
      module_evidence: 'COMPLETE_TRACE_SUPPORTED_COHORT_RANK_OR_COMPRESSION_CHANGE_CASES_CONFOUNDERS',
      maximum_module_hypotheses: 2, null_rule: 'CONTROL_QWK_NULL_NOT_APPLICABLE_OTHER_NULL_COMPARISONS_FAIL' },
    module_localization: { minimum_rank_drop: 0.05, maximum_p10_p90_compression_ratio: 0.7,
      minimum_affected_events: 5, minimum_affected_dates: 2, requires_fair_and_high_supported: true,
      exclude_partial_internal_stages: ['sky_evolution', 'golden_window'] },
    budget: { control_models: 1, fold_fits: 3, parameter_search: 0, bootstrap_replicates: 2000 },
    case_rule: 'GRADE_DIRECTION_WEIGHTED_ABS_ERROR_DESC_EVENT_UNIQUE_TOP3_AND_GRADE_MIN_ERROR_CONTROL',
    formal_promotion_allowed: false, selected_allowed: false };
}
export function scoreSchema(version = 1) {
  if (version !== 1 && version !== 2) fail('UNSUPPORTED_SCORE_DIAGNOSTIC_SCHEMA');
  const plan = ['schema.json', 'policy.json', 'plan.json', 'source_manifest.json'];
  if (version === 2) return { score_diagnostic_schema_version: 2, result_usage: 'DEVELOPMENT_ONLY', plan_files: plan,
    result_files: [...plan, 'boundary_metrics.json', 'ordinal_pair_contributions.json', 'fold_mapping_audit.json',
      'calibration_error_routes.json', 'lead_time_metrics.json', 'paired_event_comparisons.json', 'temporal_contract.json',
      'temporal_audit.json', 'target_alignment.json', 'evidence_gaps.json', 'next_experiments.json', 'decision.json',
      'access_scope.json', 'parent_binding.json', 'reports/summary.md'] };
  return { score_diagnostic_schema_version: 1, result_usage: 'DEVELOPMENT_ONLY', plan_files: plan,
    result_files: [...plan, 'reference_parity.json', 'trace_compatibility.json', 'input_quality.json',
      'score_distribution.json', 'discrimination.json', 'confusion.json', 'stage_trace.json', 'stage_summary.json',
      'case_manifest.json', 'fold_assignments.json', 'fold_calibrators.json', 'oof_predictions.json',
      'oof_metrics.json', 'bootstrap.json', 'decision.json', 'reports/summary.md'] };
}

function boundaryPolicy() {
  return { score_diagnostic_policy_version: 2, result_usage: 'DEVELOPMENT_ONLY', computation_split: 'TRAIN',
    forbidden_effect_splits: ['VALIDATION', 'TEST'], control: 'INHERITED_PARENT_FINAL_ROUNDED_SCORE',
    primary_cohort: 'PARENT_OOF', descriptive_cohorts: ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'],
    adjacent_pairs: [[0,1],[1,2],[2,3],[3,4]], cumulative_thresholds: [1,2,3,4],
    ordinal_pairs: [[0,1],[0,2],[0,3],[0,4],[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]],
    weights: 'GT_CONFIDENCE_DIVIDED_BY_COHORT_EVENT_SNAPSHOTS', pairs: 'CROSS_EVENT_PRODUCT_WEIGHT_TIE_HALF',
    quantiles: [0.1,0.25,0.5,0.75,0.9], support: { class_events:10, class_dates:3, paired_events:10, paired_dates:3 },
    bootstrap: { algorithm:'DATE_BLOCK_PERCENTILE', prng:'xorshift32-v1', replicates:2000, minimum_valid:1900,
      lower:0.025, upper:0.975, seed:'PHASE7_BOOTSTRAP_V1_OF_SHA256_PLAN_CORE_METRIC_SLICE', repeated_dates:'MULTIPLY_ORIGINAL_WEIGHTS' },
    boundary_signal: { auc_min:0.60, lower_strict:0.50, inverse_upper_strict:0.50 }, epsilon:1e-12,
    reconstruction_tolerance:1e-10, mapping: { mode:'APPLY_FROZEN_ONLY', rounding:'CLAMP_FLOOR_Y_PLUS_HALF',
      high_grade_threshold:1.5, crossings:[1.5,2.5,3.5], refit_allowed:false },
    lead_buckets:['T_0_30M','T_30_60M','T_1_3H','T_3_6H','T_6H_PLUS'], near_bucket:'T_0_30M',
    earlier_buckets:['T_1_3H','T_3_6H','T_6H_PLUS'], pair_selection:'MIN_POSITIVE_LEAD_THEN_SNAPSHOT_ID',
    temporal_rules_version:2, temporal_statuses:['PASS','PROVEN_MISMATCH','UNKNOWN','NOT_APPLICABLE'],
    missing_historical_times:'UNKNOWN_NO_BACKFILL', observation_window:'UNKNOWN_UNLESS_EXPLICITLY_CAPTURED',
    module_rule:'INHERITED_COMPLETE_STAGE_RANK_LOSS_AFFECTED_SUPPORT_AND_FIXED_CASE_EVIDENCE',
    routing_priority:['BLOCKED','INPUT_CONTRACT_REPAIR','CALIBRATION_HYPOTHESIS','MODULE_HYPOTHESIS','EVIDENCE_COLLECTION','UNRESOLVED'],
    maximum_actions:2, maximum_experiments:2, engine_replay_allowed:false, calibration_fits:0, parameter_search:0,
    formal_promotion_allowed:false, selected_allowed:false };
}
