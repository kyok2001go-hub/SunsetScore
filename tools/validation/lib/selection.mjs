import { compare } from '../../dataset/lib/common.mjs';
import { validationPolicy } from '../validation-policy.mjs';

function compareNumber(a, b, direction, epsilon) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (Math.abs(a - b) <= epsilon) return 0;
  return (a < b ? -1 : 1) * direction;
}

export function compareEligible(a, b, epsilon = validationPolicy().numeric.epsilon) {
  for (const [key, direction] of [['mae', 1], ['severe_error_rate', 1],
    ['within_1_accuracy', -1], ['abs_bias', 1], ['qwk', -1],
    ['changed_unit_count', 1], ['normalized_parameter_distance', 1]]) {
    const verdict = compareNumber(a[key], b[key], direction, epsilon);
    if (verdict) return verdict;
  }
  return compare(a.candidate_id, b.candidate_id);
}

export function rankEligible(records, epsilon = validationPolicy().numeric.epsilon) {
  const sorted = [...records].sort((a, b) => compare(a.candidate_id, b.candidate_id));
  const ranked = [];
  for (const item of sorted) {
    let position = 0;
    while (position < ranked.length && compareEligible(ranked[position], item, epsilon) <= 0) position++;
    ranked.splice(position, 0, item);
  }
  return ranked;
}

export function classifyCandidate({ coverage, control, candidate, noSkill, slices, bootstrap }, epsilon = validationPolicy().numeric.epsilon) {
  const failures = [];
  if (!coverage || coverage.cohort_sample_count <= 0 ||
      coverage.control_success_count !== coverage.cohort_sample_count ||
      coverage.candidate_success_count !== coverage.control_success_count) failures.push('FORMAL_COVERAGE_NOT_FULL');
  if (candidate.mae == null || control.mae == null || !(candidate.mae < control.mae - epsilon)) failures.push('MAE_NOT_BETTER');
  if (candidate.severe_error_rate == null || control.severe_error_rate == null ||
      candidate.severe_error_rate > control.severe_error_rate + epsilon) failures.push('SEVERE_WORSE');
  if (candidate.within_1_accuracy == null || control.within_1_accuracy == null ||
      candidate.within_1_accuracy < control.within_1_accuracy - epsilon) failures.push('WITHIN_1_WORSE');
  if (candidate.bias == null || control.bias == null || Math.abs(candidate.bias) > Math.abs(control.bias) + epsilon) failures.push('BIAS_WORSE');
  if (control.qwk != null && (candidate.qwk == null || candidate.qwk < control.qwk - epsilon)) failures.push('QWK_WORSE');
  if (noSkill == null || candidate.mae == null || !(candidate.mae < noSkill - epsilon)) failures.push('NO_SKILL_NOT_BEATEN');
  if ((slices || []).some(row => row.regression === true)) failures.push('SLICE_REGRESSION');
  if (failures.length) return { status: 'INELIGIBLE', reason_codes: failures };
  if (!bootstrap || bootstrap.status !== 'COMPUTED' || bootstrap.ci_upper == null ||
      !(bootstrap.ci_upper < -epsilon)) return { status: 'STATISTICALLY_INCONCLUSIVE', reason_codes: ['BOOTSTRAP_NOT_DECISIVE'] };
  return { status: 'ELIGIBLE', reason_codes: [] };
}

export function selectOutcome(records, mode) {
  if (mode === 'DEVELOPMENT_VALIDATION') return { outcome: 'DEVELOPMENT_ONLY', selected_candidate_id: null };
  const eligible = rankEligible(records.filter(record => record.classification === 'ELIGIBLE'));
  if (eligible.length) return { outcome: 'SELECTED', selected_candidate_id: eligible[0].candidate_id };
  return {
    outcome: records.some(record => record.classification === 'STATISTICALLY_INCONCLUSIVE')
      ? 'INCONCLUSIVE' : 'NO_ELIGIBLE_CANDIDATE',
    selected_candidate_id: null
  };
}
