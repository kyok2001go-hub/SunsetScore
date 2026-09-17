import { BENCHMARK_MODES, REPORT_SPLITS, GT_LABELS, LEAD_TIME_BUCKETS, COMPARATOR, SLICE_DIMENSIONS } from './evaluation-schema.mjs';

export const SNAPSHOT_SOURCES = Object.freeze([
  'github_schedule',
  'github_manual',
  'user_feedback'
]);

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const prop of Object.getOwnPropertyNames(obj)) {
    deepFreeze(obj[prop]);
  }
  return Object.freeze(obj);
}

export const POLICY_V1 = deepFreeze({
  benchmark_modes: BENCHMARK_MODES,
  comparator: COMPARATOR,
  evaluation_policy_version: 1,
  fixed_slice_enums: {
    gt_basis: ['OBSERVATION_AGGREGATED', 'ADMIN_ADJUDICATED'],
    gt_label: GT_LABELS,
    gt_status: ['STRONG', 'MEDIUM', 'WEAK', 'DISPUTED', 'UNLABELED'],
    lead_time_bucket: LEAD_TIME_BUCKETS,
    tile_radar_available: ['false', 'true'],
    tile_sat_available: ['false', 'true']
  },
  high_confidence_rule: {
    gt_status: 'STRONG'
  },
  labels: GT_LABELS,
  lead_time_buckets: LEAD_TIME_BUCKETS,
  numeric_specification: {
    decimal_places: 12,
    weight_tolerance_factor: 1e-12
  },
  report_splits: REPORT_SPLITS,
  score_to_ordinal_bands: {
    excellent: [90, 100],
    fair: [20, 39],
    good: [40, 59],
    poor: [0, 19],
    very_good: [60, 89]
  },
  severe_error_threshold: 2,
  slice_dimensions: SLICE_DIMENSIONS,
  splits: ['TRAIN', 'VALIDATION'],
  support_thresholds: {
    min_date_count: 2,
    min_event_count: 5
  },
  supported_model_versions: [
    { policy_version: 1, schema_version: 1 },
    { policy_version: 2, schema_version: 2 },
    { policy_version: 3, schema_version: 2 }
  ],
  test_access_policy: 'UPSTREAM_VALIDATION_ONLY',
  weightings: ['weighted', 'unweighted'],
  worst_cases_limit: 20,
  worst_slices_dimensions: ['lead_time_bucket', 'gt_label', 'regime_label', 'city'],
  worst_slices_limit: 5,
  semantics: {
    accumulation_order: 'snapshot_id_unicode_codepoint_asc',
    closest_selection: ['lead_time_minutes_ASC', 'prediction_time_epoch_DESC', 'snapshot_id_ASC'],
    selection_order: ['split', 'benchmark', 'paired_if_applicable', 'slice_if_applicable', 'weight'],
    weights: { all_primary: 'stored_event_normalized_weight', closest: 'gt_confidence',
      paired_and_slice: 'gt_confidence/event_row_count_in_final_subset', unweighted: 'one_per_snapshot' },
    headline: { mae: 'weighted_mean(abs(pred-gt))', bias: 'weighted_mean(pred-gt)', exact_accuracy: 'weighted_mean(error==0)',
      within_1_accuracy: 'weighted_mean(abs(error)<=1)', severe_error_rate: 'weighted_mean(abs(error)>=2)',
      overprediction_rate: 'weighted_mean(error>0)', underprediction_rate: 'weighted_mean(error<0)' },
    qwk: '1-sum(D*O)/sum(D*outer(row_marginal,column_marginal)/weight_sum); D=(a-b)^2/16; fixed levels 0..4',
    spearman: 'unweighted_Pearson_of_average_tied_ranks',
    quantile: 'linear_h=(n-1)*p',
    distribution: 'unweighted_per_gt_label',
    null_sort: 'before_non_null_preserve_empty_string',
    error_sort: ['absolute_error_DESC', 'gt_confidence_DESC', 'event_date_local_ASC', 'snapshot_id_ASC'],
    worst_slice_sort: ['mae_DESC', 'severe_error_rate_DESC', 'event_count_DESC', 'slice_value_ASC'],
    undefined_metrics: 'null_with_reason',
    internal_rounding_tolerance: '1e-10 for statistics reconstructed from rounded matrix cells'
  }
});

export function evaluationPolicy(version = 1) {
  if (version !== 1) throw Object.assign(new Error('UNSUPPORTED_EVALUATION_POLICY'), { code: 'UNSUPPORTED_EVALUATION_POLICY' });
  return POLICY_V1;
}
