import { fail, compare, errorCode } from '../dataset/lib/common.mjs';
import { weightedRows } from '../product-evaluation/metrics.mjs';
import { registryUnit } from '../tuning/parameter-registry.mjs';
import { digest, q, POLICY } from './policy.mjs';
import { MECHANISM_POLICY, selectMechanism } from './mechanism-targeted.mjs';
import { compareHighCloud, meetsHighCloudRecognition, rankHighCloud } from './high-cloud.mjs';
export const SKY_POLICY = Object.freeze({ ...MECHANISM_POLICY, practical_tuning_schema_version: 5, practical_tuning_policy_version: 5,
  search_space: 'sky-branch', budget: 13, target_limit: 1, probe_limit_per_parameter: 5, refinement_interior_points: 8, max_effective_configurations: 13,
  target_rule: 'MISS_CROSS60_FULL_POOL_WEIGHT_DESC; MISS_SUPPRESSION_WEIGHTED_TOTAL_DESC; LOW_BRANCH_WEIGHT_ASC; FIXED_BRANCH_ORDER',
  parameter_id: 'sky_arrival_risk_slope', branch_id: 'CLOUD_ARRIVING', precision: 12 });
export const BRANCHES = ['CLOUD_ARRIVING', 'CLOSING', 'UNCERTAIN', 'STABLE_OVERCAST', 'STABLE_OTHER', 'CLEAR', 'OPENING', 'STABLE_MODERATE', 'MISSING_SUMMARY'];
const contracts = { CLOUD_ARRIVING: { parameter_id: 'sky_arrival_risk_slope', canonical_path: 'skyState.factorCoefficients.arrivalRiskSlope', default_value: .3, range: [0, 1], probes: [.18, .24, .3, .36, .42] },
  CLOSING: { range: [0, 1] }, UNCERTAIN: { range: [.65, 1.15] }, STABLE_OVERCAST: { range: [.65, 1.15] }, STABLE_OTHER: { range: [.65, 1.15] } };
const sum = rs => rs.reduce((s, r) => s + r.weight, 0), support = rs => ({ snapshot_count: rs.length, event_count: new Set(rs.map(r => r.event_id)).size,
  date_count: new Set(rs.map(r => r.event_date_local)).size, full_pool_weighted_amount: q(sum(rs)) });
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function parameterChangesFactor(t) {
  const s = t.sky_branch, c = contracts[s.branch_id]; if (!c || !s.internal_range) return false;
  const possible = c.range.map(v => {
    const raw = s.branch_id === 'CLOUD_ARRIVING' ? .9 - s.formula.terms.risk60m * v : s.branch_id === 'CLOSING' ? .95 - s.formula.terms.growthRatio * v : v;
    const inner = s.formula.branch_floor == null ? raw : Math.max(s.formula.branch_floor, raw);
    return clip(clip(Number(inner.toFixed(3)), ...s.internal_range), .65, 1.15);
  });
  return possible.some(v => Number.isFinite(v) && Math.abs(v - s.fusion.applied_factor) > POLICY.epsilon);
}
export function summarizeSkyBranches(rows, traces) {
  const ts = new Map(traces.map(t => [t.snapshot_id, t])), all = weightedRows(rows).map(r => ({ ...r, t: ts.get(r.snapshot_id) }));
  if (all.some(r => !r.t?.sky_branch) || ts.size !== rows.length) fail('SKY_TRACE_COHORT_MISMATCH');
  const W = sum(all), defs = [['all', () => true], ['high_missed', r => r.gt_ordinal >= 3 && r.t.predicted_ordinal < 3],
    ['high_hit', r => r.gt_ordinal >= 3 && r.t.predicted_ordinal >= 3], ['low_control', r => r.gt_ordinal <= 2], ...[0, 1, 2].map(y => [`low_actual_${y}`, r => r.gt_ordinal === y])];
  return { sky_branch_schema_version: 1, trace_rows_sha256: digest(traces), weight_basis: 'FULL_POOL_EVENT_WEIGHTS; CONDITIONAL_MEANS_DIVIDE_BRANCH_GROUP_WEIGHT; CONTRIBUTIONS_DIVIDE_FULL_POOL_WEIGHT',
    causal_claim: false, crossing_is_not_counterfactual_recovery: true,
    groups: defs.map(([group, filter]) => { const rs = all.filter(filter); return { group, ...support(rs), branches: BRANCHES.map(branch_id => {
      const subset = rs.filter(r => r.t.sky_branch.branch_id === branch_id), w = sum(subset), sky = r => r.t.sky_branch;
      const delta = r => sky(r).fusion.score_after_sky - sky(r).fusion.score_engine;
      const mean = fn => w ? q(subset.reduce((s, r) => s + r.weight * fn(r), 0) / w) : null;
      return { branch_id, ...support(subset), applied_factor_distribution: [...new Set(subset.map(r => sky(r).fusion.applied_factor))].sort((a, b) => a - b).map(factor => ({ factor, ...support(subset.filter(r => sky(r).fusion.applied_factor === factor)) })),
        mean_applied_factor: mean(r => sky(r).fusion.applied_factor), conditional_mean_delta: mean(delta),
        weighted_suppression_total: q(subset.reduce((s, r) => s + r.weight * Math.max(0, -delta(r)), 0)),
        full_pool_delta_contribution: W ? q(subset.reduce((s, r) => s + r.weight * delta(r), 0) / W) : null,
        crossing_down_60: support(subset.filter(r => sky(r).fusion.score_engine >= 60 && sky(r).fusion.score_after_sky < 60)),
        crossing_up_60: support(subset.filter(r => sky(r).fusion.score_engine < 60 && sky(r).fusion.score_after_sky >= 60)),
        internal_clamp: support(subset.filter(r => sky(r).internal_clamp_status === 'EXECUTED' && sky(r).rounded_factor !== sky(r).returned_factor)),
        external_clamp: support(subset.filter(r => sky(r).returned_factor !== sky(r).fusion.applied_factor)),
        actionable_misses: support(subset.filter(r => r.gt_ordinal >= 3 && r.t.predicted_ordinal < 3 && sky(r).fusion.applied_factor < 1 && parameterChangesFactor(r.t))),
        fallback_reasons: [...new Set(subset.flatMap(r => sky(r).fallbacks))].map(reason => ({ reason, ...support(subset.filter(r => sky(r).fallbacks.includes(reason))) })),
        snapshot_ids: subset.map(r => r.snapshot_id) };
    }) }; }) };
}
export function rankSkyBranches(summary) {
  const missed = summary.groups.find(g => g.group === 'high_missed'), low = summary.groups.find(g => g.group === 'low_control');
  return missed.branches.filter(b => b.actionable_misses.snapshot_count > 0).map(b => ({ ...b,
    low_control: low.branches.find(l => l.branch_id === b.branch_id) })).sort((a, b) =>
    b.crossing_down_60.full_pool_weighted_amount - a.crossing_down_60.full_pool_weighted_amount || b.weighted_suppression_total - a.weighted_suppression_total ||
    a.low_control.full_pool_weighted_amount - b.low_control.full_pool_weighted_amount || BRANCHES.indexOf(a.branch_id) - BRANCHES.indexOf(b.branch_id));
}
export function buildBranchPlan(rows, traces, summary, current) {
  const ranking = rankSkyBranches(summary), chosen = ranking[0];
  if (chosen && chosen.branch_id !== SKY_POLICY.branch_id) fail('SELECTED_SKY_BRANCH_REQUIRES_ITS_OWN_SHARED_COEFFICIENT_IMPLEMENTATION');
  const c = contracts.CLOUD_ARRIVING, unit = registryUnit(c.parameter_id);
  const value = current.skyState.factorCoefficients?.arrivalRiskSlope ?? c.default_value;
  if (value !== c.default_value) fail('SKY_BASELINE_DEFAULT_COEFFICIENT_DIFFERENT');
  return { branch_plan_schema_version: 1, baseline_config_sha256: digest(current), trace_rows_sha256: digest(traces), stage_summary_sha256: digest(summary),
    diagnostic_status: chosen ? 'ONE_BRANCH_ONE_COEFFICIENT_SELECTED' : 'NO_ACTIONABLE_BRANCH', target_rule: SKY_POLICY.target_rule,
    selected: chosen ? [{ parameter_id: c.parameter_id, canonical_path: c.canonical_path, branch_id: chosen.branch_id, current_value: value,
      default_value: c.default_value, range: unit.range, probe_values: c.probes, evidence: chosen, wired_status: unit.wired_status }] : [],
    ranking, non_targets: BRANCHES.filter(id => !chosen || id !== chosen.branch_id), refinement_interior_points: 8, maximum_configurations: 13,
    limitation: 'RANKING_SCHEDULES_EXPERIMENT_NOT_A_RULE_ERROR_OR_CAUSAL_GAIN_CLAIM', coefficients_not_extracted: Object.keys(contracts).filter(id => id !== 'CLOUD_ARRIVING') };
}
export function installSky(current, p) {
  if (p.parameter_id === null && p.value === null || p.parameter_id === 'sky_arrival_risk_slope' && p.value === .3) return structuredClone(current);
  if (p.parameter_id !== 'sky_arrival_risk_slope' || !Number.isFinite(p.value) || p.value < 0 || p.value > 1) fail('INVALID_SKY_COEFFICIENT');
  const next = structuredClone(current); next.skyState.factorCoefficients = { ...next.skyState.factorCoefficients, arrivalRiskSlope: q(p.value) }; return next;
}
export function skyCandidate(parameters, ctx) {
  installSky(ctx.current, parameters);
  const p = parameters.parameter_id === null || parameters.value === .3 ? { parameter_id: null, value: null } : { parameter_id: parameters.parameter_id, value: q(parameters.value) };
  return { candidate_id: `practical_candidate_v5_${digest({ parameters: p, current: digest(ctx.current), original: digest(ctx.original), engine_sha256: ctx.engine_sha256,
    branch_plan_sha256: ctx.target_plan_sha256, policy: SKY_POLICY }).slice(0, 20)}`, parameters: p, parameter_distance: p.value == null ? 0 : q(Math.abs(p.value - .3)) };
}
export function refineSky(records, baselineId, original, current, plan) {
  const baseline = records.find(r => r.candidate_id === baselineId), points = records.filter(r => r.status === 'EVALUATED' && r.stage === 'PROBE');
  const improved = points.filter(r => meetsHighCloudRecognition(r, original) && r.metrics.product_loss < baseline.metrics.product_loss - POLICY.epsilon).sort(compareHighCloud);
  const recovered = points.filter(r => r.paired_migrations.net_recovered_weight > POLICY.epsilon).sort(compareHighCloud), point = improved[0] ?? recovered[0];
  if (!point) return { status: 'STOP_NO_IMPROVEMENT_OR_NET_RECOVERY', parameter_id: null, values: [] };
  return { status: improved.length ? 'REFINE_BEST_QUALIFIED_IMPROVEMENT' : 'REFINE_LOWEST_LOSS_POSITIVE_NET_RECOVERY', parameter_id: point.parameters.parameter_id,
    parent_candidate: point.candidate_id, current_value: .3, probe_value: point.parameters.value,
    values: [...new Set(Array.from({ length: 8 }, (_, i) => q(.3 + (point.parameters.value - .3) * (i + 1) / 9)))] };
}
export async function searchSky({ current, original, engine_sha256, plan, originalMetrics, evaluate, restored = [], save = async () => {}, saveRefinement = async () => {}, frozenRefinement = null, maxCandidates = 13, progress = () => {} }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 13) fail('INVALID_CANDIDATE_BUDGET');
  const context = { current, original, engine_sha256, target_plan_sha256: digest(plan) }, old = new Map(restored.map(r => [r.candidate_id, r])), seen = new Set(), records = [], audit = []; let hit = false;
  const propose = async (p, stage) => {
    const c = skyCandidate(p, context); if (seen.has(c.candidate_id)) { audit.push({ stage, candidate_id: c.candidate_id, status: 'DUPLICATE' }); return; }
    if (records.length >= maxCandidates) { hit = true; return; } seen.add(c.candidate_id);
    let r = old.get(c.candidate_id); if (r && (digest(r.parameters) !== digest(c.parameters) || r.stage !== stage || r.parameter_distance !== c.parameter_distance)) fail('RESUME_CANDIDATE_MISMATCH');
    if (!r) { try { r = { ...c, stage, status: 'EVALUATED', ...await evaluate(c) }; } catch (e) { r = { ...c, stage, status: 'ERROR', metrics: null, reason_code: errorCode(e) }; } await save(r); }
    records.push(r); audit.push({ stage, candidate_id: c.candidate_id, status: r.status }); progress({ count: records.length, stage, candidate: r, best: rankHighCloud(records, originalMetrics)[0] });
  };
  await propose({ parameter_id: null, value: null }, 'C_BASELINE'); if (records[0].status !== 'EVALUATED') fail('NO_VALID_BASELINE');
  for (const p of plan.selected) for (const value of p.probe_values) await propose({ parameter_id: p.parameter_id, value }, 'PROBE');
  const refinement = hit ? { status: 'STOP_BUDGET_REACHED', parameter_id: null, values: [] } : refineSky(records, records[0].candidate_id, originalMetrics, current, plan);
  if (frozenRefinement && digest(frozenRefinement) !== digest(refinement)) fail('RESUME_REFINEMENT_PLAN_MISMATCH'); await saveRefinement(refinement);
  for (const value of refinement.values) await propose({ parameter_id: refinement.parameter_id, value }, 'REFINEMENT');
  return { records, audit, refinement, baseline_id: records[0].candidate_id, budget: { maximum: maxCandidates, evaluated_unique: records.length, errors: records.filter(r => r.status === 'ERROR').length,
    duplicates: audit.filter(r => r.status === 'DUPLICATE').length, invalid: 0, termination: hit ? 'BUDGET_REACHED' : 'FIVE_PROBES_AND_SINGLE_EIGHT_POINT_REFINEMENT_COMPLETE', exhaustive_parameter_space: false } };
}
export function selectSky(records, baselineId, original) {
  const result = selectMechanism(records, baselineId, original), classes = new Map();
  for (const r of records.filter(r => r.status === 'EVALUATED')) { const id = r.predictions_sha256; if (!classes.has(id)) classes.set(id, []); classes.get(id).push(r.candidate_id); }
  return { ...result, practical_tuning_schema_version: 5, practical_tuning_policy_version: 5, search_space: 'sky-branch',
    same_prediction_groups: [...classes.values()].filter(g => g.length > 1), precision_limitation: 'COEFFICIENT_GRID_AND_THREE_DECIMAL_FACTOR_ROUNDING_NOT_A_HIGH_PRECISION_PHYSICAL_CONSTANT' };
}
