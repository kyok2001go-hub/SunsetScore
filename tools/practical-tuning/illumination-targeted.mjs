import { fail, errorCode } from '../dataset/lib/common.mjs';
import { weightedRows } from '../product-evaluation/metrics.mjs';
import { registryUnit } from '../tuning/parameter-registry.mjs';
import { digest, q, POLICY } from './policy.mjs';
import { MECHANISM_POLICY, selectMechanism } from './mechanism-targeted.mjs';
import { compareHighCloud, meetsHighCloudRecognition, rankHighCloud } from './high-cloud.mjs';
export const ILLUMINATION_POLICY = Object.freeze({ ...MECHANISM_POLICY, practical_tuning_schema_version: 6, practical_tuning_policy_version: 6,
  search_space: 'illumination-targeted', budget: 17, target_limit: 2, probe_limit_per_parameter: 5, refinement_interior_points: 8, max_effective_configurations: 17,
  target_rule: 'ALL_SUPPORTED_INTERNAL_ENTRIES; ACTUAL_MISSED_COMPONENT_RESPONSE_AT_FROZEN_PROBES', precision: 12 });
export const ILLUMINATION_PARAMETERS = Object.freeze([
  { parameter_id: 'illumination_bank_share', canonical_path: 'illuminationModel.bankShare', field: 'bankShare', default_value: .5, range: [0, 1], probes: [.25, .375, .5, .625, .75] },
  { parameter_id: 'illumination_twilight_saturation', canonical_path: 'illuminationModel.twilightSaturationMinutes', field: 'twilightSaturationMinutes', default_value: 35, range: [10, 90], probes: [25, 30, 35, 40, 45] }
]);
const clip = v => Math.max(0, Math.min(100, v));
const sum = rs => rs.reduce((s, r) => s + r.weight, 0);
const support = rs => ({ snapshot_count: rs.length, event_count: new Set(rs.map(r => r.event_id)).size,
  date_count: new Set(rs.map(r => r.event_date_local)).size, full_pool_weighted_amount: q(sum(rs)) });
const metrics = { solar_angle: t => t.solar.score, twilight_minutes: t => t.solar.twilight_minutes, bank_score: t => t.bank.value,
  spatial_compat: t => t.spatial.value, bank_minus_spatial: t => t.bank.value - t.spatial.value, data_factor: t => t.spatial.data_factor,
  contrast: t => t.bank.contrast_score_normalized, illumination: t => t.formula.value };
function describe(rs, fn, W) {
  const a = rs.filter(r => Number.isFinite(fn(r.i))), w = sum(a), sorted = [...a].sort((a, b) => fn(a.i) - fn(b.i) || a.snapshot_id.localeCompare(b.snapshot_id));
  const quantile = p => { let cumulative = 0; for (const r of sorted) { cumulative += r.weight; if (cumulative >= w * p) return q(fn(r.i)); } return null; };
  const numerator = a.reduce((s, r) => s + r.weight * fn(r.i), 0);
  return { ...support(a), conditional_weighted_mean: w ? q(numerator / w) : null, full_pool_contribution: W ? q(numerator / W) : null,
    p10: quantile(.1), p50: quantile(.5), p90: quantile(.9), zero: support(a.filter(r => fn(r.i) === 0)) };
}
function affected(t, p) {
  const i = t.illumination_internal;
  return p.probes.some(value => {
    const solar = p.field === 'twilightSaturationMinutes' ? 30 + 70 * Math.max(0, Math.min(1, i.solar.twilight_minutes / value)) : i.solar.score;
    const bank = p.field === 'bankShare' ? value * i.bank.value + (1 - value) * i.spatial.value : i.formula.cloud_bank_potential;
    return Math.abs(clip(solar * bank / 100 * i.spatial.data_factor) - i.formula.value) > 1e-8;
  });
}
export function summarizeIllumination(rows, traces) {
  const ts = new Map(traces.map(t => [t.snapshot_id, t])), all = weightedRows(rows).map(r => ({ ...r, t: ts.get(r.snapshot_id), i: ts.get(r.snapshot_id)?.illumination_internal }));
  if (traces.length !== rows.length || ts.size !== rows.length || all.some(r => !r.i)) fail('ILLUMINATION_TRACE_COHORT_MISMATCH');
  const W = sum(all), missed = r => r.gt_ordinal >= 3 && r.t.predicted_ordinal < 3;
  const definitions = [['all', () => true], ['high_all', r => r.gt_ordinal >= 3], ['high_missed', missed], ['high_hit', r => r.gt_ordinal >= 3 && r.t.predicted_ordinal >= 3],
    ['low_control', r => r.gt_ordinal <= 2], ...[0, 1, 2].map(y => [`low_actual_${y}`, r => r.gt_ordinal === y]),
    ...[0, 1, 2].map(y => [`high_missed_predicted_${y}`, r => missed(r) && r.t.predicted_ordinal === y]),
    ...[[0, 19], [20, 39], [40, 49], [50, 59]].map(([a, b]) => [`high_missed_score_${a}_${b}`, r => missed(r) && r.t.predicted_score >= a && r.t.predicted_score <= b])];
  const describeGroup = rs => ({ ...support(rs), distributions: Object.fromEntries(Object.entries(metrics).map(([k, fn]) => [k, describe(rs, fn, W)])),
    spatial_fallback: support(rs.filter(r => r.i.spatial.fallback)), bank_fallback: support(rs.filter(r => r.i.bank.fallback)),
    contrast_missing: support(rs.filter(r => r.i.bank.contrast_raw == null)), contrast_nonpositive_valid: support(rs.filter(r => Number.isFinite(r.i.bank.contrast_raw) && r.i.bank.contrast_raw <= 0)),
    contrast_capped: support(rs.filter(r => r.i.bank.contrast_raw >= r.i.bank.contrast_full)), snapshot_ids: rs.map(r => r.snapshot_id) });
  const groups = definitions.map(([group, fn]) => ({ group, ...describeGroup(all.filter(fn)) }));
  const highs = all.filter(missed), lows = all.filter(r => r.gt_ordinal <= 2);
  const separation = Object.fromEntries(['bank_score', 'spatial_compat', 'solar_angle', 'illumination'].map(k => {
    let concordant = 0, total = 0; const fn = metrics[k];
    for (const h of highs) for (const l of lows) { const a = fn(h.i), b = fn(l.i); if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const w = h.weight * l.weight; total += w; concordant += w * (a > b ? 1 : a === b ? .5 : 0); }
    return [k, { weighted_pair_concordance: total ? q(concordant / total) : null, pair_weight_denominator: q(total),
      interpretation: 'ASSOCIATION_OF_MISSES_VS_ALL_LOW_CONTROLS_NOT_CAUSAL_OR_INDEPENDENT_VALIDATION' }];
  }));
  return { illumination_trace_schema_version: 1, trace_rows_sha256: digest(traces), weight_basis: 'FULL_POOL_EVENT_WEIGHTS; CONDITIONAL_MEANS_USE_AVAILABLE_GROUP_WEIGHT',
    groups, separation, slices: ['regime_label', 'lead_time_bucket'].flatMap(dimension => [...new Set(all.map(r => r.t[dimension] ?? null))].sort().map(value => ({ dimension, value,
      high_missed: describeGroup(all.filter(r => missed(r) && (r.t[dimension] ?? null) === value)), low_control: describeGroup(all.filter(r => r.gt_ordinal <= 2 && (r.t[dimension] ?? null) === value)) }))),
    dependency_graph: ['HIGH_MID_CLOUD_CURVES -> BANK_SCORE_AND_SPATIAL_COMPAT', 'BANK_SCORE -> SKY_CANVAS_AND_ILLUMINATION', 'DISTANCE_AND_CONFIDENCE -> SPATIAL_COMPAT_NORMALIZATION',
      'CONTRAST_BONUS_MAX_POSITIVE_MULTIPLY_DIVIDE_CANCELS', 'DISTANCE_RELIABILITY_IS_DIAGNOSTIC_ONLY'], causal_claim: false };
}
export function buildIlluminationPlan(rows, traces, summary, current) {
  const missed = traces.filter(t => t.gt_ordinal >= 3 && t.predicted_ordinal < 3), low = traces.filter(t => t.gt_ordinal <= 2);
  const entries = ILLUMINATION_PARAMETERS.map(p => {
    const value = current.illuminationModel?.[p.field] ?? p.default_value;
    if (value !== p.default_value) fail('ILLUMINATION_BASELINE_DEFAULT_DIFFERENT');
    const ids = missed.filter(t => affected(t, p)).map(t => t.snapshot_id), lowIds = low.filter(t => affected(t, p)).map(t => t.snapshot_id);
    return { ...p, current_value: value, probe_values: p.probes, wired_status: registryUnit(p.parameter_id).wired_status,
      active: ids.length > 0, reason: ids.length ? 'ACTUAL_MISSED_COMPONENT_CAN_CHANGE_AT_FROZEN_PROBES' : 'NO_MISSED_COMPONENT_RESPONSE_AT_FROZEN_PROBES',
      evidence: { high_missed_snapshot_ids: ids, low_control_snapshot_ids: lowIds } };
  });
  return { illumination_plan_schema_version: 1, baseline_config_sha256: digest(current), trace_rows_sha256: digest(traces), stage_summary_sha256: digest(summary),
    selected: entries.filter(p => p.active), inactive: entries.filter(p => !p.active), diagnostic_status: entries.some(p => p.active) ? 'SUPPORTED_INTERNAL_PARAMETERS_SELECTED' : 'NO_ACTIONABLE_PARAMETER',
    maximum_configurations: 17, refinement_interior_points: 8, response_is_scheduling_only_not_simulated_predictions: true };
}
export function installIllumination(current, parameters) {
  if (!parameters || Object.keys(parameters).length !== 2) fail('INVALID_ILLUMINATION_PARAMETERS');
  if (parameters.parameter_id === null && parameters.value === null) return structuredClone(current);
  const p = ILLUMINATION_PARAMETERS.find(p => p.parameter_id === parameters.parameter_id), value = parameters.value;
  if (!p || !Number.isFinite(value) || value < p.range[0] || value > p.range[1]) fail('INVALID_ILLUMINATION_PARAMETERS');
  const next = structuredClone(current);
  if (value !== p.default_value) next.illuminationModel = { ...next.illuminationModel, [p.field]: q(value) };
  return next;
}
export function illuminationCandidate(parameters, ctx) {
  installIllumination(ctx.current, parameters);
  const p = ILLUMINATION_PARAMETERS.find(p => p.parameter_id === parameters.parameter_id), normalized = !p || parameters.value === p.default_value ? { parameter_id: null, value: null } : { parameter_id: p.parameter_id, value: q(parameters.value) };
  return { candidate_id: `practical_candidate_v6_${digest({ parameters: normalized, current: digest(ctx.current), original: digest(ctx.original), engine_sha256: ctx.engine_sha256,
    illumination_plan_sha256: ctx.target_plan_sha256, policy: ILLUMINATION_POLICY }).slice(0, 20)}`, parameters: normalized,
    parameter_distance: normalized.parameter_id ? q(Math.abs(normalized.value - p.default_value) / (p.range[1] - p.range[0])) : 0 };
}
export function refineIllumination(records, baselineId, original) {
  const baseline = records.find(r => r.candidate_id === baselineId), probes = records.filter(r => r.status === 'EVALUATED' && r.stage === 'PROBE');
  const improvements = probes.filter(r => meetsHighCloudRecognition(r, original) && r.metrics.product_loss < baseline.metrics.product_loss - POLICY.epsilon).sort(compareHighCloud);
  const recovered = probes.filter(r => r.paired_migrations.net_recovered_weight > POLICY.epsilon).sort(compareHighCloud), point = improvements[0] ?? recovered[0];
  if (!point) return { status: 'STOP_NO_IMPROVEMENT_OR_NET_RECOVERY', parameter_id: null, values: [] };
  const p = ILLUMINATION_PARAMETERS.find(p => p.parameter_id === point.parameters.parameter_id);
  return { status: improvements.length ? 'REFINE_BEST_QUALIFIED_IMPROVEMENT' : 'REFINE_LOWEST_LOSS_POSITIVE_NET_RECOVERY', parameter_id: p.parameter_id,
    parent_candidate: point.candidate_id, current_value: p.default_value, probe_value: point.parameters.value,
    values: [...new Set(Array.from({ length: 8 }, (_, i) => q(p.default_value + (point.parameters.value - p.default_value) * (i + 1) / 9)))] };
}
export async function searchIllumination({ current, original, engine_sha256, plan, originalMetrics, evaluate, restored = [], save = async () => {}, saveRefinement = async () => {},
  frozenRefinement = null, maxCandidates = 17, progress = () => {} }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 17) fail('INVALID_CANDIDATE_BUDGET');
  const ctx = { current, original, engine_sha256, target_plan_sha256: digest(plan) }, old = new Map(restored.map(r => [r.candidate_id, r])), seen = new Set(), records = [], audit = []; let hit = false;
  const propose = async (parameters, stage) => {
    const c = illuminationCandidate(parameters, ctx); if (seen.has(c.candidate_id)) { audit.push({ stage, candidate_id: c.candidate_id, status: 'DUPLICATE' }); return; }
    if (records.length >= maxCandidates) { hit = true; return; } seen.add(c.candidate_id);
    let r = old.get(c.candidate_id); if (r && (digest(r.parameters) !== digest(c.parameters) || r.stage !== stage || r.parameter_distance !== c.parameter_distance)) fail('RESUME_CANDIDATE_MISMATCH');
    if (!r) { try { r = { ...c, stage, status: 'EVALUATED', ...await evaluate(c) }; } catch (e) { r = { ...c, stage, status: 'ERROR', metrics: null, reason_code: errorCode(e) }; } await save(r); }
    records.push(r); audit.push({ stage, candidate_id: c.candidate_id, status: r.status }); progress({ count: records.length, stage, candidate: r, best: rankHighCloud(records, originalMetrics)[0] });
  };
  await propose({ parameter_id: null, value: null }, 'C_BASELINE'); if (records[0].status !== 'EVALUATED') fail('NO_VALID_BASELINE');
  for (const p of plan.selected) for (const value of p.probe_values) await propose({ parameter_id: p.parameter_id, value }, 'PROBE');
  const refinement = hit ? { status: 'STOP_BUDGET_REACHED', parameter_id: null, values: [] } : refineIllumination(records, records[0].candidate_id, originalMetrics);
  if (frozenRefinement && digest(frozenRefinement) !== digest(refinement)) fail('RESUME_REFINEMENT_PLAN_MISMATCH'); await saveRefinement(refinement);
  for (const value of refinement.values) await propose({ parameter_id: refinement.parameter_id, value }, 'REFINEMENT');
  return { records, audit, refinement, baseline_id: records[0].candidate_id, budget: { maximum: maxCandidates, evaluated_unique: records.length,
    errors: records.filter(r => r.status === 'ERROR').length, duplicates: audit.filter(r => r.status === 'DUPLICATE').length, invalid: 0,
    termination: hit ? 'BUDGET_REACHED' : 'SUPPORTED_PROBES_AND_SINGLE_REFINEMENT_COMPLETE', exhaustive_parameter_space: false } };
}
export function selectIllumination(records, baselineId, original) {
  const result = selectMechanism(records, baselineId, original), classes = new Map();
  for (const r of records.filter(r => r.status === 'EVALUATED')) { const k = r.predictions_sha256; if (!classes.has(k)) classes.set(k, []); classes.get(k).push(r.candidate_id); }
  return { ...result, practical_tuning_schema_version: 6, practical_tuning_policy_version: 6, search_space: 'illumination-targeted',
    same_prediction_groups: [...classes.values()].filter(g => g.length > 1), precision_limitation: 'GRID_PRECISION_AND_SCORE_ROUNDING_NOT_PHYSICAL_CONSTANT_PRECISION' };
}
