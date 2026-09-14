// Policy changes require a new version, not a silent edit to existing packages.
const freeze = value => { Object.values(value).forEach(x => { if (x && typeof x === 'object') freeze(x); }); return Object.freeze(value); };
export const POLICY = freeze({
  gt_policy_version: 1,
  labels: ['poor', 'fair', 'good', 'very_good', 'excellent'],
  source_weights: { user: 1, rednote_agent: 1, rednote_manual: 1 },
  observation_confidence: { missing: 1, base: 0.75, multiplier: 0.25 },
  evidence_count: 'audit_only',
  invalid_observation: 'fail',
  median: 'first_ordinal_with_Q_cumulative_ratio_gte_half',
  consensus: 'weight_at_gt_ordinal_over_total',
  entropy: 'natural_log_divided_by_ln_5',
  mad: 'weighted_lower_median_absolute_distance_from_gt',
  effective_n: 'sum_weight_squared_over_sum_squared_weights',
  status_order: ['UNLABELED', 'DISPUTED', 'WEAK', 'STRONG', 'MEDIUM'],
  thresholds: { disputed_spread: 3, disputed_consensus: 0.5, weak_effective_n: 1.5,
    strong_effective_n: 2, strong_consensus: 0.75, strong_spread: 1 },
  confidence: { support_n: 3, consensus: 0.5, entropy: 0.25, spread: 0.25,
    caps: { STRONG: 1, MEDIUM: 0.75, WEAK: 0.35, DISPUTED: 0.2 } },
  source_pairs: [['user', 'rednote_agent'], ['user', 'rednote_manual'], ['rednote_agent', 'rednote_manual']],
  source_agreement: 'per_source_weighted_median_then_equal_event_weight_B_minus_A',
  numeric: { decimals: 12, rounding: 'Number(x.toFixed(12))', negative_zero: 0,
    accumulation: 'event_id_observation_id_codepoint_order_no_intermediate_rounding',
    thresholds: 'compare_quantized_metrics_without_epsilon' },
  aggregation_inputs: ['id', 'event_id', 'source', 'rating', 'confidence', 'evidence_count']
});
export const LABELS = POLICY.labels;
export const SOURCES = Object.keys(POLICY.source_weights);
export const Q = x => Number(x.toFixed(POLICY.numeric.decimals)) || 0;
export const clamp = x => Math.max(0, Math.min(1, x));
