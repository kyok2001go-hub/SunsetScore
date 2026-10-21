import { canonicalJson, compare, fail, hash, unique } from '../dataset/lib/common.mjs';
import { formatMetric } from '../evaluation/metrics.mjs';
import { prepareCandidateRun, evaluateCandidateDetailed } from '../tuning/lib/candidate.mjs';
import { canonicalizeCandidate, candidateKey } from '../optimization/lib/candidate.mjs';
import { coarseProposals } from '../optimization/lib/generator.mjs';
import { runBeamSearch } from '../optimization/lib/beam.mjs';
import { rankRecords } from '../optimization/lib/finalist.mjs';
import { evaluateGuardrails } from '../optimization/lib/guardrails.mjs';
import { candidateQuality, objectiveRank, paretoLayers } from '../optimization/lib/selection.mjs';
import { dateRobustness, noSkillMae, pairMetrics, renormalizeEventWeights, sliceAnalysis, weightedHeadline } from '../optimization/lib/metrics.mjs';
import { diagnosticPolicy } from './policy.mjs';
import { selectNoSkillReference } from '../evaluation/v2/no-skill.mjs';

export const digest = value => hash(canonicalJson(value));
export const members = rows => [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id)).map(r => ({
  snapshot_id: r.snapshot_id, event_id: r.event_id, location_key: r.location_key, event_date_local: r.event_date_local }));
export const cohortDigest = rows => digest([...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id)).map(({ replay, ...r }) =>
  ({ ...r, replay_sha256: digest(replay) })));

/** Lower weighted median; each Event contributes its confidence once, regardless of Snapshot count. */
export function estimateNoSkill(rows) {
  return selectNoSkillReference(rows).reference_ordinal;
}

export function dateFolds(rows, policy = diagnosticPolicy()) {
  const events = new Map(), snapshots = new Set();
  for (const row of rows) {
    if (snapshots.has(row.snapshot_id)) fail('DUPLICATE_SNAPSHOT');
    snapshots.add(row.snapshot_id);
    const prior = events.get(row.event_id);
    if (prior && (prior.event_date_local !== row.event_date_local || prior.location_key !== row.location_key ||
      prior.gt_ordinal !== row.gt_ordinal || prior.gt_confidence !== row.gt_confidence)) fail('EVENT_GT_INCONSISTENCY');
    events.set(row.event_id, row);
  }
  const dates = unique(rows.map(r => r.event_date_local)).sort(compare);
  if (dates.length < policy.folds.minimum_dates) return { status: 'INNER_CV_INSUFFICIENT', reason_codes: ['TRAIN_DATES_BELOW_19'], folds: [] };
  let offset = dates.length - 10;
  const folds = policy.folds.holdout_date_counts.map((count, index) => {
    const trainDates = dates.slice(0, offset), heldDates = dates.slice(offset, offset + count);
    offset += count;
    const training = rows.filter(r => trainDates.includes(r.event_date_local));
    const held = rows.filter(r => heldDates.includes(r.event_date_local));
    const ready = new Set(training.map(r => r.event_id)).size >= policy.folds.minimum_train_events && trainDates.length >= policy.folds.minimum_train_dates;
    return { fold: index + 1, status: ready ? 'READY' : 'INNER_CV_INSUFFICIENT', train_dates: trainDates,
      held_dates: heldDates, train_members: members(training), held_members: members(held) };
  });
  return { status: folds.every(f => f.status === 'READY') ? 'READY' : 'INNER_CV_INSUFFICIENT', folds };
}

export function fixedMatrix(searchSpace, limit = 40) {
  const proposals = [{ label: 'CONTROL', vector: {} },
    ...[0.595, 0.49].map(value => ({ label: `ATMOSPHERE_BASE_${value}`, vector: { atmosphere_quality_base: value } })),
    { label: 'ATMOSPHERE_SCALE_0.21', vector: { atmosphere_quality_scale: 0.21 } },
    { label: 'ATMOSPHERE_COMBINATION', vector: { atmosphere_quality_base: 0.595, atmosphere_quality_scale: 0.21 } },
    { label: 'AGGRESSIVE_NEGATIVE_CONTROL', vector: { atmosphere_quality_base: 0.4375, atmosphere_quality_scale: 0.21 } },
    ...[42, 51, 69, 78].map(value => ({ label: `HIGH_CLOUD_CENTER_${value}`, vector: { high_cloud_center: value } })),
    ...[18, 21, 29, 33].map(value => ({ label: `HIGH_CLOUD_WIDTH_${value}`, vector: { high_cloud_width: value } })),
    ...coarseProposals(searchSpace).filter(p => p.parameter_id === 'component_weights').map(p => ({ label: 'COMPONENT_WEIGHTS_PROBE', vector: p.vector }))];
  const seen = new Set(), matrix = [];
  for (const proposal of proposals) {
    const candidate = canonicalizeCandidate({ vector: proposal.vector, searchSpace, baseConfig: searchSpace.base_config,
      optimizationInputId: 'diagnostic_matrix' });
    if (!candidate.ok) fail('DIAGNOSTIC_MATRIX_INVALID', { reason_code: candidate.reason_code });
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    matrix.push({ label: proposal.label, canonical_vector: candidate.canonical_vector,
      effective_config_sha256: candidate.effective_config_sha256 });
  }
  if (matrix.length > limit) fail('PLAN_BUDGET_EXCEEDED');
  // Control first; all probes, including expanded SIMPLEX vectors, have a canonical order.
  return [matrix.find(m => m.label === 'CONTROL'), ...matrix.filter(m => m.label !== 'CONTROL')
    .sort((a, b) => compare(canonicalJson(a.canonical_vector), canonicalJson(b.canonical_vector)))];
}

export function qualityRecord(detailed, candidate, referenceOrdinal, policy = diagnosticPolicy().search_policy) {
  if (detailed.status !== 'EVALUABLE') return { candidate, status: detailed.status === 'INFEASIBLE' ? 'INFEASIBLE' : 'UNEVALUABLE',
    coverage: detailed.coverage, metrics: null, control: null, deltas: null, gates: [], rows: detailed.rows || [],
    promotable: false, basic_guards_pass: false, train_all_guards_pass: false, quality: 'SEARCH_DIAGNOSTIC_ONLY',
    reason_codes: [detailed.reason_code], reason_code: detailed.reason_code,
    failures: [...(detailed.controlFailures || []), ...(detailed.experimentFailures || [])] };
  const pair = pairMetrics(detailed.rows), dates = dateRobustness(detailed.rows, policy.numeric.metric_compare_epsilon);
  const slices = sliceAnalysis(detailed.rows, policy.numeric.metric_compare_epsilon, policy.slice_support);
  const noSkill = noSkillMae(detailed.rows, referenceOrdinal);
  const guards = evaluateGuardrails({ candidate, coverage: detailed.coverage, control: pair.control, metrics: pair.candidate,
    noSkill, dateStats: dates, slices, mode: 'FORMAL_OPTIMIZATION', policy });
  const full = detailed.coverage.control_source_coverage_rate === 1 && detailed.coverage.candidate_control_coverage_rate === 1;
  const quality = candidateQuality(guards);
  return { candidate, status: full ? 'FEASIBLE' : 'UNEVALUABLE', coverage: detailed.coverage, coverage_pass: full,
    ...quality, basic_guards_pass: full && quality.basic_guards_pass, train_all_guards_pass: full && quality.train_all_guards_pass,
    metrics: pair.candidate, control: pair.control, deltas: pair.deltas, date_stats: dates, slices,
    no_skill_mae: noSkill, reference_ordinal: referenceOrdinal, gates: guards.gates, reason_codes: guards.reason_codes,
    rows: pair.reweighted, promotable: false, search_eligible: full,
    failures: [...(detailed.controlFailures || []), ...(detailed.experimentFailures || [])] };
}

export async function evaluator({ cohort, searchSpace, runReplay, progress, scopeId, noSkillReference }) {
  const referenceOrdinal = noSkillReference === undefined ? estimateNoSkill(cohort) : noSkillReference;
  const prepared = await prepareCandidateRun({ cohort, config: searchSpace.base_config.config,
    units: Object.values(searchSpace.registry_units), runReplay, progress });
  return { referenceOrdinal, prepared, evaluate: async candidate => qualityRecord(
    { ...await evaluateCandidateDetailed({ prepared, vector: candidate.canonical_vector }), controlFailures: prepared.controlFailures }, candidate, referenceOrdinal),
    space: { ...searchSpace, optimization_input_id: scopeId || `diagnostic_scope_${digest({
      cohort: cohortDigest(cohort), space: searchSpace.units.map(({ sensitivity_evidence, ...unit }) => unit),
      config: searchSpace.base_config.sha256 }).slice(0, 16)}` } };
}

export async function searchCohort(options) {
  const ev = await evaluator(options);
  const search = await runBeamSearch({ searchSpace: ev.space, policy: diagnosticPolicy().search_policy,
    mode: 'EXPLORATORY_SEARCH', evaluate: ev.evaluate, rank: rankRecords,
    onProgress: message => options.progress?.update(message) });
  return { ...search, reference_ordinal: ev.referenceOrdinal, cohort_sha256: cohortDigest(options.cohort),
    input_members: members(options.cohort) };
}

export function diagnosticMetrics(rows) {
  const pair = pairMetrics(rows), weighted = pair.reweighted;
  const sum = (list, f = () => 1) => list.reduce((s, r) => s + r.event_normalized_weight * f(r), 0);
  const confusion = key => Array.from({ length: 5 }, (_, truth) => Array.from({ length: 5 }, (_, pred) =>
    formatMetric(sum(weighted.filter(r => r.gt_ordinal === truth && r[key] === pred)))));
  const grades = Array.from({ length: 5 }, (_, ordinal) => {
    // MAE within a GT subset is re-normalized, consistent with all Slice metrics.
    const subset = renormalizeEventWeights(rows.filter(r => r.gt_ordinal === ordinal));
    const denominator = sum(subset);
    return { gt_ordinal: ordinal, sample_count: subset.length, event_count: new Set(subset.map(r => r.event_id)).size,
      support_weight: formatMetric(denominator), reason_code: denominator ? null : 'NO_GT_SUPPORT',
      control_mae: weightedHeadline(subset, 'control_ordinal').mae,
      candidate_mae: weightedHeadline(subset, 'experiment_ordinal').mae,
      control_recall: denominator ? formatMetric(sum(subset, r => Number(r.control_ordinal === ordinal)) / denominator) : null,
      candidate_recall: denominator ? formatMetric(sum(subset, r => Number(r.experiment_ordinal === ordinal)) / denominator) : null };
  });
  const high = weighted.filter(r => r.gt_ordinal >= 2), denominator = sum(high);
  return { control: pair.control, candidate: pair.candidate, deltas: pair.deltas,
    confusion: { control: confusion('control_ordinal'), candidate: confusion('experiment_ordinal') }, grades,
    prediction_distribution: Array.from({ length: 5 }, (_, ordinal) => ({ ordinal,
      control_weight: formatMetric(sum(weighted, r => Number(r.control_ordinal === ordinal))),
      candidate_weight: formatMetric(sum(weighted, r => Number(r.experiment_ordinal === ordinal))),
      control_count: weighted.filter(r => r.control_ordinal === ordinal).length,
      candidate_count: weighted.filter(r => r.experiment_ordinal === ordinal).length })),
    high_grade_recall: { denominator: formatMetric(denominator), reason_code: denominator ? null : 'NO_HIGH_GRADE_SUPPORT',
      control: denominator ? formatMetric(sum(high, r => Number(r.control_ordinal >= 2)) / denominator) : null,
      candidate: denominator ? formatMetric(sum(high, r => Number(r.experiment_ordinal >= 2)) / denominator) : null } };
}

export function summarizeSearch(search) {
  const ranked = objectiveRank(search.records.filter(r => r.status === 'FEASIBLE'));
  return { mae_best: ranked[0]?.candidate.candidate_id || null,
    basic_guard_candidates: ranked.filter(r => r.basic_guards_pass).map(r => r.candidate.candidate_id),
    train_qualified_candidates: ranked.filter(r => r.train_all_guards_pass).slice(0, 5).map(r => r.candidate.candidate_id),
    pareto_front: (paretoLayers(ranked)[0] || []).map(r => r.candidate.candidate_id) };
}

export function procedureDecision(folds, oofRows) {
  if (folds.length !== 3 || folds.some(f => f.status !== 'EVALUATED') || !oofRows.length) return { status: 'INCONCLUSIVE', reason_codes: ['MISSING_VALID_FOLD_OR_COVERAGE'] };
  const pair = pairMetrics(oofRows);
  const noSkillRows = pair.reweighted.map(r => ({ ...r, fixed_no_skill: r.fold_reference_ordinal }));
  const noSkill = weightedHeadline(noSkillRows, 'fixed_no_skill').mae;
  const candidate = { candidate_id: 'procedure_oof' };
  const guards = evaluateGuardrails({ candidate, coverage: { control_source_coverage_rate: 1, candidate_control_coverage_rate: 1 },
    control: pair.control, metrics: pair.candidate, noSkill, dateStats: dateRobustness(oofRows, 1e-12),
    slices: sliceAnalysis(oofRows, 1e-12, diagnosticPolicy().search_policy.slice_support),
    mode: 'FORMAL_OPTIMIZATION', policy: diagnosticPolicy().search_policy });
  const deltas = folds.map(f => f.held_metrics.deltas.delta_mae).sort((a, b) => a - b);
  const supported = deltas.filter(d => d < -1e-12).length >= 2 && deltas[1] < -1e-12 &&
    candidateQuality(guards).basic_guards_pass && noSkill !== null && pair.candidate.mae < noSkill - 1e-12;
  return { status: supported ? 'PROCEDURE_SUPPORTED' : 'PROCEDURE_NOT_SUPPORTED', median_fold_delta_mae: deltas[1],
    improved_fold_count: deltas.filter(d => d < -1e-12).length,
    oof: { ...diagnosticMetrics(oofRows), no_skill_mae: noSkill, gates: guards.gates },
    reason_codes: supported ? [] : ['FROZEN_PROCEDURE_STABILITY_RULE_FAILED'],
    interpretation: 'OOF_EVALUATES_THREE_DIFFERENT_FOLD_CANDIDATES_NOT_ONE_FIXED_CANDIDATE' };
}
