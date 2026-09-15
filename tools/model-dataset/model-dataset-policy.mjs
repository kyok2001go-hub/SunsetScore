const freeze = value => { Object.values(value).forEach(v => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(value); };
export const POLICY_V1 = freeze({
  model_dataset_policy_version: 1,
  source_versions: { raw_schema: [1], gt_schema: [1, 2], gt_policy: [1] },
  labels: ['poor', 'fair', 'good', 'very_good', 'excellent'],
  statuses: ['UNLABELED', 'DISPUTED', 'WEAK', 'STRONG', 'MEDIUM'],
  eligibility: ['PRIMARY', 'DIAGNOSTIC', 'EXCLUDED'],
  primary_statuses: ['STRONG', 'MEDIUM'],
  row_priority: ['MODEL_VERSION_FILTERED', 'DISPUTED_GT', 'UNLABELED', 'WEAK_GT', 'POST_SUNSET', 'PRIMARY'],
  event_priority: ['PRIMARY', 'DIAGNOSTIC', 'EXCLUDED'],
  diagnostic_reasons: ['WEAK_GT', 'POST_SUNSET'],
  exclusion_reasons: ['MODEL_VERSION_FILTERED', 'DISPUTED_GT', 'UNLABELED'],
  model_filter: { matching: 'exact_storage_value', max_items: 100, normalization: 'trim_unique_codepoint', stage: 'before_eligibility_weights_split' },
  lead_buckets: ['POST_SUNSET', 'T_0_30M', 'T_30_60M', 'T_1_3H', 'T_3_6H', 'T_6H_PLUS'],
  lead_boundaries: [0, 30, 60, 180, 360],
  splits: ['TRAIN', 'VALIDATION', 'TEST'],
  percentages: [70, 15, 15], minimum_events: [30, 10, 10],
  split_strategy: 'complete_primary_local_date_blocks_prefix_counts_exhaustive',
  split_objective: 'sum_abs_100_count_minus_percentage_total',
  tie_break: 'earliest_validation_then_test_boundary', max_date_blocks: 10000,
  weights: 'confidence_divided_by_all_selected_primary_snapshots_per_event_other_rows_zero',
  numeric: { decimals: 12, weight_tolerance: 1e-12, weights: 'String(Number)_no_rounding', accumulation: 'snapshot_id_codepoint', median: 'middle_or_mean_of_middle_two' },
  sample_sort: ['event_date_local', 'event_id', 'prediction_time_epoch', 'snapshot_id'],
  event_sort: ['event_date_local', 'event_id'],
  statistics: { event_denominator: 'one_per_event', sample_denominator: 'one_per_snapshot', null_bucket: true, fixed_enum_zero_buckets: true },
  test_set_policy: 'final_evaluation_only'
});
export const POLICY_V2 = freeze({ ...POLICY_V1, model_dataset_policy_version: 2,
  source_versions: { raw_schema: [1], gt_schema: [1, 2, 3], gt_policy: [1, 2] },
  source_combinations: [[1, 1, 1], [1, 2, 1], [1, 3, 2]],
  basis_order: ['ADMIN_ADJUDICATED', 'OBSERVATION_AGGREGATED'],
  legacy_gt_basis: 'OBSERVATION_AGGREGATED', basis_role: 'target_metadata_not_prediction_feature',
  statistics: { ...POLICY_V1.statistics, basis: 'one_per_event_including_splits' }
});
export const POLICY = freeze({ ...POLICY_V2, model_dataset_policy_version: 3, minimum_events: [15, 5, 5], minimum_total_events: 30 });
export function modelPolicy(version) {
  if (version === 1) return POLICY_V1;
  if (version === 2) return POLICY_V2;
  if (version === 3) return POLICY;
  throw new Error('UNSUPPORTED_MODEL_DATASET_POLICY');
}
export const Q = x => Number(x.toFixed(POLICY.numeric.decimals)) || 0;
