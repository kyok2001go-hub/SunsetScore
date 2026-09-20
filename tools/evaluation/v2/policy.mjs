import { evaluationPolicy } from '../evaluation-policy.mjs';

export const MAPPING = Object.freeze({
  mapping_basis: 'ORDER_PRESERVING_PROXY',
  mapping_status: 'PROVISIONAL',
  interpretation_scope: 'PROXY_ORDINAL_ONLY'
});

export const NO_SKILL_COMPARATOR = 'TRAIN_WEIGHTED_MEDIAN_ORDINAL';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function evaluationPolicyV2() {
  const policy = structuredClone(evaluationPolicy(1));
  delete policy.comparator;
  policy.evaluation_policy_version = 2;
  policy.report_splits = ['TRAIN'];
  policy.splits = ['TRAIN'];
  policy.internal_comparator = 'stored_internal_baseline_score';
  policy.no_skill_comparator = NO_SKILL_COMPARATOR;
  policy.computation_access_policy = 'TRAIN_ONLY';
  policy.validation_access_policy = 'UPSTREAM_VALIDATION_ONLY';
  policy.mapping = {
    ...MAPPING,
    prediction_levels: ['很差', '较差', '一般', '很好', '极佳'],
    observation_labels: policy.labels,
    validation_evidence_id: null
  };
  policy.no_skill_reference = {
    source_split: 'TRAIN', unit: 'distinct_primary_event',
    weight: 'gt_confidence', objective: 'min_weighted_absolute_ordinal_error',
    tie_break: 'lowest_ordinal', reuse_on_validation: true
  };
  policy.semantics = {
    ...policy.semantics,
    metric_interpretation: MAPPING.interpretation_scope,
    no_skill_reference: 'weighted_median_of_distinct_TRAIN_events_then_fixed_for_all_benchmarks'
  };
  return deepFreeze(policy);
}
