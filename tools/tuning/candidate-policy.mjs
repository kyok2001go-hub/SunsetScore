import { tuningPolicy } from './tuning-policy.mjs';

export const CANDIDATE_POLICY_VERSION = 1;
export const CANDIDATE_STATUSES = Object.freeze(['FEASIBLE', 'INFEASIBLE', 'UNEVALUABLE']);
export const OBJECTIVE_DIRECTIONS = Object.freeze(['MINIMIZE', 'MAXIMIZE']);
export const OBJECTIVE_WEIGHTINGS = Object.freeze(['weighted', 'unweighted']);
/** Objective terms address the same headline metrics the Sensitivity package reports. */
export const OBJECTIVE_METRICS = Object.freeze([
  'mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate',
  'overprediction_rate', 'underprediction_rate', 'qwk'
]);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Candidate evaluation policy. Kept separate from the Sensitivity Policy on purpose: V2.5.2
 * packages stay byte-identical while V2.5.3 gains its own objective and access rules.
 */
export const CANDIDATE_POLICY_V1 = deepFreeze({
  candidate_policy_version: CANDIDATE_POLICY_VERSION,
  statuses: CANDIDATE_STATUSES,
  // TEST is listed as forbidden rather than merely absent so a caller cannot widen into it.
  allowed_splits: ['TRAIN', 'VALIDATION'],
  forbidden_splits: ['TEST'],
  default_split: 'TRAIN',
  objective: {
    primary: { metric: 'mae', weighting: 'weighted', direction: 'MINIMIZE' },
    tie_breakers: [
      { metric: 'severe_error_rate', weighting: 'weighted', direction: 'MINIMIZE' },
      { metric: 'qwk', weighting: 'weighted', direction: 'MAXIMIZE' }
    ]
  },
  infeasibility: {
    // Registry, constraint and SIMPLEX violations never reach the replay stage.
    constraint_violation: 'INFEASIBLE',
    // The candidate was replayed but its paired cohort fell below the floor.
    coverage_below_minimum: 'UNEVALUABLE',
    min_coverage_rate: tuningPolicy().coverage_policy.min_coverage_rate,
    // A vector equal to the frozen base is legal: its objective equals the Control's.
    allow_control_parity_candidate: true
  }
});

export function candidatePolicy(version = CANDIDATE_POLICY_VERSION) {
  if (version !== CANDIDATE_POLICY_VERSION) {
    throw Object.assign(new Error('UNSUPPORTED_CANDIDATE_POLICY'), { code: 'UNSUPPORTED_CANDIDATE_POLICY' });
  }
  return CANDIDATE_POLICY_V1;
}

export function assertObjectivePolicy(objective) {
  const terms = [objective.primary, ...(objective.tie_breakers || [])];
  for (const term of terms) {
    if (!OBJECTIVE_METRICS.includes(term.metric)) {
      throw Object.assign(new Error('INVALID_OBJECTIVE_METRIC'), { code: 'INVALID_OBJECTIVE_METRIC', detail: term.metric });
    }
    if (!OBJECTIVE_WEIGHTINGS.includes(term.weighting)) {
      throw Object.assign(new Error('INVALID_OBJECTIVE_WEIGHTING'), { code: 'INVALID_OBJECTIVE_WEIGHTING', detail: term.weighting });
    }
    if (!OBJECTIVE_DIRECTIONS.includes(term.direction)) {
      throw Object.assign(new Error('INVALID_OBJECTIVE_DIRECTION'), { code: 'INVALID_OBJECTIVE_DIRECTION', detail: term.direction });
    }
  }
  return true;
}
