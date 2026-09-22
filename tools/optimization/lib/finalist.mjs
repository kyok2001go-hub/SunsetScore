import { canonicalJson, compare, hash } from '../../dataset/lib/common.mjs';
import { CANDIDATE_POLICY_VERSION } from '../../tuning/candidate-policy.mjs';
import { optimizationPolicy, objectivePolicyDocument, guardrailPolicyDocument } from '../optimization-policy.mjs';

/**
 * Candidate ranking and Finalist selection.
 *
 * Ranking is a two-level rule: PROMOTABLE first, then the frozen objective order, and finally
 * the complexity tie-break so that, between equivalent effects, the Candidate that moves fewer
 * Units and sits closer to production wins deterministically.
 */

const STATUS_RANK = Object.freeze({ FEASIBLE: 0, UNEVALUABLE: 1, INFEASIBLE: 2 });

function numeric(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

function compareAscending(a, b, epsilon) {
  const left = numeric(a), right = numeric(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (Math.abs(left - right) <= epsilon) return 0;
  return left < right ? -1 : 1;
}

function compareDescending(a, b, epsilon) {
  return -compareAscending(a, b, epsilon);
}

/** `null` QWK sorts last; a real value always outranks a missing one. */
function compareQwk(a, b, epsilon) {
  const left = numeric(a), right = numeric(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareDescending(left, right, epsilon);
}

export function compareRecords(a, b, epsilon = optimizationPolicy().numeric.metric_compare_epsilon) {
  const statusDelta = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (statusDelta) return statusDelta;
  if (a.status !== 'FEASIBLE') return compare(a.candidate.candidate_id, b.candidate.candidate_id);
  if (a.promotable !== b.promotable) return a.promotable ? -1 : 1;
  const metricsA = a.metrics, metricsB = b.metrics;
  let verdict = compareAscending(metricsA.mae, metricsB.mae, epsilon);
  if (verdict) return verdict;
  verdict = compareAscending(metricsA.severe_error_rate, metricsB.severe_error_rate, epsilon);
  if (verdict) return verdict;
  verdict = compareDescending(metricsA.within_1_accuracy, metricsB.within_1_accuracy, epsilon);
  if (verdict) return verdict;
  verdict = compareAscending(Math.abs(metricsA.bias ?? NaN), Math.abs(metricsB.bias ?? NaN), epsilon);
  if (verdict) return verdict;
  verdict = compareQwk(metricsA.qwk, metricsB.qwk, epsilon);
  if (verdict) return verdict;
  verdict = compareAscending(a.candidate.changed_unit_count, b.candidate.changed_unit_count, 0);
  if (verdict) return verdict;
  verdict = compareAscending(a.candidate.normalized_parameter_distance, b.candidate.normalized_parameter_distance, epsilon);
  if (verdict) return verdict;
  return compare(a.candidate.candidate_id, b.candidate.candidate_id);
}

export function rankRecords(records, epsilon) {
  return [...records].sort((a, b) => compareRecords(a, b, epsilon));
}

/**
 * `finalist_count_max` means "at most". A Candidate that failed any gate is never promoted to
 * fill the quota, and a run with no qualifying Candidate reports NO_PROMOTABLE_CANDIDATE.
 */
export function selectFinalists(records, { maxCount, epsilon, mode = 'FORMAL_OPTIMIZATION' }) {
  const eligible = records.filter(record => record.status === 'FEASIBLE' &&
    (mode === 'FORMAL_OPTIMIZATION' ? record.promotable === true : record.search_eligible !== false));
  return rankRecords(eligible, epsilon).slice(0, maxCount);
}

export function validationSelectionRuleDocument(policy = optimizationPolicy()) {
  return {
    optimization_policy_version: policy.optimization_policy_version,
    ...policy.validation_selection_rule,
    eligibility: [...policy.validation_selection_rule.eligibility],
    ranking: [...policy.validation_selection_rule.ranking]
  };
}

/**
 * `candidate_freeze.json` deliberately excludes the final `optimization_id` and its own hash, so
 * the package identity chain stays acyclic: inputs -> search -> freeze -> descriptor -> id.
 */
export function buildFreezeDocument({ optimizationInputId, searchResultId, candidateSetId, finalists, source, searchSpace, searchSpaceSha256 }) {
  const policy = optimizationPolicy();
  return {
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    candidate_policy_version: CANDIDATE_POLICY_VERSION,
    optimization_input_id: optimizationInputId,
    search_result_id: searchResultId,
    candidate_set_id: candidateSetId,
    candidate_ids: finalists.map(record => record.candidate.candidate_id),
    canonical_candidate_vectors: finalists.map(record => record.candidate.canonical_vector),
    candidate_effective_config_sha256s: finalists.map(record => record.candidate.effective_config_sha256),
    candidate_order: finalists.map((record, index) => ({
      order: index + 1,
      candidate_id: record.candidate.candidate_id,
      train_objective_value: record.metrics.mae,
      train_delta_mae: record.deltas.delta_mae,
      changed_unit_count: record.candidate.changed_unit_count,
      normalized_parameter_distance: record.candidate.normalized_parameter_distance
    })),
    search_space_id: searchSpace.search_space_id,
    search_space_sha256: searchSpaceSha256,
    objective_policy_sha256: hash(canonicalJson(objectivePolicyDocument())),
    guardrail_policy_sha256: hash(canonicalJson(guardrailPolicyDocument())),
    model_dataset_id: source.model_dataset_id,
    evaluation_id: source.evaluation_id,
    sensitivity_id: source.sensitivity_id,
    engine_runtime_sha256: source.engine_runtime_sha256,
    tuning_base_config_sha256: source.tuning_base_config_sha256,
    parameter_registry_sha256: source.parameter_registry_sha256,
    evaluated_split: policy.computation_split,
    validation_selection_rule: validationSelectionRuleDocument(policy)
  };
}
