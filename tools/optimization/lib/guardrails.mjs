import { fail } from '../../dataset/lib/common.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';

/**
 * Guardrail evaluation for one Candidate. `FEASIBLE` only means the Candidate replayed on the
 * full paired cohort; `PROMOTABLE` additionally means it cleared every gate the run mode
 * requires. Formal-only gates are reported as NOT_APPLICABLE in EXPLORATORY_SEARCH so the
 * leaderboard still shows what a formal run would have asked of the same point.
 */

const GATE = Object.freeze({
  coverageControlSource: 'COVERAGE_CONTROL_SOURCE',
  coverageCandidateControl: 'COVERAGE_CANDIDATE_CONTROL',
  partialCoverage: 'PARTIAL_COVERAGE',
  mae: 'WEIGHTED_MAE_STRICTLY_BETTER',
  severe: 'SEVERE_ERROR_RATE_NOT_WORSE',
  within1: 'WITHIN_1_ACCURACY_NOT_WORSE',
  bias: 'ABSOLUTE_BIAS_NOT_WORSE',
  qwk: 'QWK_NOT_WORSE',
  noSkill: 'NO_SKILL_MAE_STRICTLY_BETTER',
  date: 'DATE_ROBUSTNESS',
  lodo: 'LODO_ROBUSTNESS',
  slice: 'SLICE_REGRESSION'
});

function gate(candidateId, name, status, observed, threshold, reasonCode = null) {
  return {
    candidate_id: candidateId,
    gate: name,
    status,
    observed: observed === undefined ? null : observed,
    threshold: threshold === undefined ? null : threshold,
    reason_code: reasonCode
  };
}

function coverageThresholds(mode, policy) {
  return mode === 'FORMAL_OPTIMIZATION'
    ? {
      control: policy.coverage.formal_min_control_source_coverage_rate,
      candidate: policy.coverage.formal_min_candidate_control_coverage_rate
    }
    : {
      control: policy.coverage.exploratory_min_control_source_coverage_rate,
      candidate: policy.coverage.exploratory_min_candidate_control_coverage_rate
    };
}

export function evaluateGuardrails({ candidate, coverage, control, metrics, noSkill, dateStats, slices, mode, policy }) {
  if (mode !== 'EXPLORATORY_SEARCH' && mode !== 'FORMAL_OPTIMIZATION') {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'UNKNOWN_OPTIMIZATION_MODE', detail: mode });
  }
  const epsilon = policy.numeric.metric_compare_epsilon;
  const formal = mode === 'FORMAL_OPTIMIZATION';
  const candidateId = candidate.candidate_id;
  const thresholds = coverageThresholds(mode, policy);
  const gates = [];

  const controlRate = coverage.control_source_coverage_rate;
  const coverageControlPass = controlRate !== null && controlRate >= thresholds.control - epsilon;
  gates.push(gate(candidateId, GATE.coverageControlSource, controlRate === null ? 'FAIL' : (coverageControlPass ? 'PASS' : 'FAIL'),
    controlRate, thresholds.control, coverageControlPass ? null : 'CONTROL_SOURCE_COVERAGE_BELOW_MINIMUM'));

  const candidateRate = coverage.candidate_control_coverage_rate;
  const coverageCandidatePass = candidateRate !== null && candidateRate >= thresholds.candidate - epsilon;
  gates.push(gate(candidateId, GATE.coverageCandidateControl, candidateRate === null ? 'FAIL' : (coverageCandidatePass ? 'PASS' : 'FAIL'),
    candidateRate, thresholds.candidate, coverageCandidatePass ? null : 'CANDIDATE_COVERAGE_BELOW_MINIMUM'));

  // Reaching the mode floor is not the same as losing nothing: a Candidate that already drops a
  // Snapshot the Control could score stays eligible for the exploratory Leaderboard only.
  const partial = (controlRate !== null && controlRate < 1 - epsilon) ||
    (candidateRate !== null && candidateRate < 1 - epsilon);
  gates.push(gate(candidateId, GATE.partialCoverage, partial ? 'FAIL' : 'PASS',
    candidateRate, 1, partial ? 'PARTIAL_COVERAGE' : null));

  const maePass = control.mae !== null && metrics.mae !== null && metrics.mae < control.mae - epsilon;
  gates.push(gate(candidateId, GATE.mae, maePass ? 'PASS' : 'FAIL',
    metrics.mae, control.mae === null ? null : formatMetric(control.mae), maePass ? null : 'CANDIDATE_MAE_NOT_BETTER_THAN_CONTROL'));

  const severePass = control.severe_error_rate !== null && metrics.severe_error_rate !== null &&
    metrics.severe_error_rate <= control.severe_error_rate + epsilon;
  gates.push(gate(candidateId, GATE.severe, severePass ? 'PASS' : 'FAIL',
    metrics.severe_error_rate, control.severe_error_rate, severePass ? null : 'SEVERE_ERROR_RATE_WORSE_THAN_CONTROL'));

  const within1Pass = control.within_1_accuracy !== null && metrics.within_1_accuracy !== null &&
    metrics.within_1_accuracy >= control.within_1_accuracy - epsilon;
  gates.push(gate(candidateId, GATE.within1, within1Pass ? 'PASS' : 'FAIL',
    metrics.within_1_accuracy, control.within_1_accuracy, within1Pass ? null : 'WITHIN_1_ACCURACY_WORSE_THAN_CONTROL'));

  const controlBias = control.bias === null ? null : Math.abs(control.bias);
  const candidateBias = metrics.bias === null ? null : Math.abs(metrics.bias);
  const biasPass = controlBias !== null && candidateBias !== null && candidateBias <= controlBias + epsilon;
  gates.push(gate(candidateId, GATE.bias, biasPass ? 'PASS' : 'FAIL',
    candidateBias, controlBias, biasPass ? null : 'ABSOLUTE_BIAS_WORSE_THAN_CONTROL'));

  let qwkStatus, qwkReason;
  if (control.qwk === null) {
    qwkStatus = 'NOT_APPLICABLE';
    qwkReason = 'CONTROL_QWK_UNAVAILABLE';
  } else if (metrics.qwk === null) {
    qwkStatus = 'FAIL';
    qwkReason = 'CANDIDATE_QWK_UNAVAILABLE';
  } else {
    qwkStatus = metrics.qwk >= control.qwk - epsilon ? 'PASS' : 'FAIL';
    qwkReason = qwkStatus === 'PASS' ? null : 'QWK_WORSE_THAN_CONTROL';
  }
  gates.push(gate(candidateId, GATE.qwk, qwkStatus, metrics.qwk, control.qwk, qwkReason));

  const noSkillPass = noSkill !== null && metrics.mae !== null && metrics.mae < noSkill - epsilon;
  gates.push(gate(candidateId, GATE.noSkill, formal ? (noSkillPass ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE',
    metrics.mae, noSkill, formal && !noSkillPass ? 'CANDIDATE_NOT_BETTER_THAN_NO_SKILL' : (noSkill === null ? 'NO_SKILL_REFERENCE_UNAVAILABLE' : null)));

  const datePolicy = policy.date_robustness;
  const perDate = dateStats.per_date_summary;
  const datePass = dateStats.date_count >= datePolicy.ready_dates &&
    perDate.improved_count >= datePolicy.min_per_date_improved_count;
  gates.push(gate(candidateId, GATE.date, formal ? (datePass ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE',
    dateStats.date_count, datePolicy.ready_dates,
    formal && !datePass ? 'DATE_ROBUSTNESS_NOT_SATISFIED' : null));

  const lodo = dateStats.lodo_summary;
  const lodoPass = (!datePolicy.require_full_lodo_coverage || lodo.evaluated_count === dateStats.date_count) &&
    lodo.improvement_rate !== null && lodo.improvement_rate >= datePolicy.required_lodo_improvement_rate &&
    (!datePolicy.require_worst_lodo_strictly_better || (lodo.worst_delta_mae !== null && lodo.worst_delta_mae < -epsilon));
  gates.push(gate(candidateId, GATE.lodo, formal ? (lodoPass ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE',
    lodo.improvement_rate, datePolicy.required_lodo_improvement_rate,
    formal && !lodoPass ? 'LODO_ROBUSTNESS_NOT_SATISFIED' : null));

  const regressions = slices.filter(slice => slice.regression);
  gates.push(gate(candidateId, GATE.slice, formal ? (regressions.length ? 'FAIL' : 'PASS') : 'NOT_APPLICABLE',
    regressions.length, 0, formal && regressions.length ? 'SLICE_REGRESSION' : null));

  const blocking = gates.filter(item => item.status === 'FAIL');
  const coveragePass = coverageControlPass && coverageCandidatePass;
  return {
    gates,
    coverage_pass: coveragePass,
    search_eligible: coveragePass,
    promotable: formal && blocking.length === 0,
    reason_codes: [...new Set(blocking.map(item => item.reason_code).filter(Boolean))].sort()
  };
}
