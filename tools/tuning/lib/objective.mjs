import { compare, fail } from '../../dataset/lib/common.mjs';
import { assertObjectivePolicy, candidatePolicy } from '../candidate-policy.mjs';

/** Reads one objective term out of a headline metric group. */
export function objectiveTermValue(metrics, term) {
  const group = metrics && metrics[term.weighting];
  if (!group || !(term.metric in group)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'OBJECTIVE_METRIC_MISSING', detail: term });
  }
  return group[term.metric];
}

/**
 * Objective descriptor for one evaluated candidate: the ordered terms with their raw values,
 * so a caller can both rank candidates and show why one won.
 */
export function objectiveFor(metrics, objective = candidatePolicy().objective) {
  assertObjectivePolicy(objective);
  const terms = [objective.primary, ...(objective.tie_breakers || [])];
  return {
    primary: { ...objective.primary, value: objectiveTermValue(metrics, objective.primary) },
    tie_breakers: terms.slice(1).map(term => ({ ...term, value: objectiveTermValue(metrics, term) }))
  };
}

function rankTerm(a, b, term) {
  const left = objectiveTermValue(a, term), right = objectiveTermValue(b, term);
  if (left === right) return 0;
  if (left === null || !Number.isFinite(left)) return 1;
  if (right === null || !Number.isFinite(right)) return -1;
  const better = term.direction === 'MINIMIZE' ? Math.min(left, right) : Math.max(left, right);
  return left === better ? -1 : 1;
}

/**
 * Deterministic comparator: better candidate first, primary term before tie-breakers. Returns
 * a negative number when `a` ranks ahead of `b`, matching Array.prototype.sort.
 */
export function compareCandidates(a, b, objective = candidatePolicy().objective) {
  const statusRank = result => result.status === 'FEASIBLE' ? 0 : 1;
  if (statusRank(a) !== statusRank(b)) return statusRank(a) - statusRank(b);
  if (a.status !== 'FEASIBLE') {
    // Among non-feasible candidates, a constraint violation is a stronger signal than a
    // coverage shortfall, and both keep a stable order by candidate id.
    const order = result => result.status === 'INFEASIBLE' ? 0 : 1;
    if (order(a) !== order(b)) return order(a) - order(b);
    return compare(a.candidate_id, b.candidate_id);
  }
  const terms = [objective.primary, ...(objective.tie_breakers || [])];
  for (const term of terms) {
    const verdict = rankTerm(a.metrics, b.metrics, term);
    if (verdict) return verdict;
  }
  // Equal objective values fall back to the candidate id so ranking never depends on the
  // order the caller happened to submit vectors in.
  return compare(a.candidate_id, b.candidate_id);
}

export function rankCandidates(results, objective = candidatePolicy().objective) {
  return [...results].sort((a, b) => compareCandidates(a, b, objective));
}
