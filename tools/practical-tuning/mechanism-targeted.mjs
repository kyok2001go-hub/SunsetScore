import { fail, errorCode, compare } from '../dataset/lib/common.mjs';
import { registryUnit } from '../tuning/parameter-registry.mjs';
import { resolvePath, writePath } from '../tuning/lib/base-config.mjs';
import { weightedRows } from '../product-evaluation/metrics.mjs';
import { digest, q, POLICY } from './policy.mjs';
import { MID_CLOUD_POLICY } from './mid-cloud.mjs';
import { compareHighCloud, rankHighCloud, selectHighCloud, meetsHighCloudRecognition } from './high-cloud.mjs';
export const MECHANISM_POLICY = Object.freeze({ ...MID_CLOUD_POLICY, practical_tuning_schema_version: 4, practical_tuning_policy_version: 4,
  search_space: 'mechanism-targeted', parameter_id: 'EVIDENCE_SELECTED_SCALAR', canonical_paths: 'FROZEN_TARGET_PLAN',
  coarse_centers: undefined, coarse_widths: undefined, local_steps: undefined, local_parents: undefined,
  budget: 32, target_limit: 3, probe_limit_per_parameter: 4, refinement_interior_points: 12,
  distance: 'abs(new-current)/registry_range_width', trace_tolerance: 1e-8,
  target_rule: 'OBSERVED_INTERVENTION_SUPPORT_AND_MISS_TO_LOW_LOCAL_RESPONSE_RATIO; DISTINCT_STAGES_FIRST; ID_TIES',
  refinement_rule: 'BEST_FLOOR_PASSING_LOSS_IMPROVEMENT_ELSE_MIN_LOSS_POSITIVE_NET_RECOVERY_ELSE_STOP',
  no_joint_search: true, max_effective_configurations: 25 });
const CATALOG = Object.freeze([
  ['atmosphere_quality_base', 'atmosphere_quality'], ['atmosphere_quality_scale', 'atmosphere_quality'],
  ['golden_window_floor', 'golden_window'], ['minimum_weather_weight', 'weighted_components'], ['hard_gate_score_cap', 'hard_gate']
]);
export function scalarUnit(id) {
  if (!CATALOG.some(([key]) => key === id)) fail('MECHANISM_PARAMETER_NOT_ALLOWED');
  const u = registryUnit(id);
  if (u.wired_status !== 'WIRED' || u.unit_category !== 'OAT' || !u.optimizable || !Array.isArray(u.range) || u.range[1] <= u.range[0]) fail('MECHANISM_PARAMETER_NOT_WIRED_SCALAR');
  return u;
}
export function probeValues(unit, current) {
  const range = unit.range[1] - unit.range[0];
  const values = unit.probe_absolute ?? [-.1, -.05, .05, .1].map(offset => current + (unit.integer ? Math.sign(offset) * Math.max(1, Math.round(Math.abs(offset) * range)) : offset * range));
  return [...new Set(values.map(v => unit.integer ? Math.round(v) : q(v)).filter(v => Number.isFinite(v) && v >= unit.range[0] && v <= unit.range[1] && Math.abs(v - current) > POLICY.epsilon))]
    .sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b).slice(0, 4).sort((a, b) => a - b);
}
function localResponse(id, t, config) {
  if (id === 'atmosphere_quality_base') return t.P;
  if (id === 'atmosphere_quality_scale') return t.P * t.components.atmosphere / 100;
  if (id === 'golden_window_floor') {
    const o = t.golden_window_observation, stage = t.stages.find(s => s.stage === 'golden_window');
    return stage?.status !== 'NOT_EXECUTED' && Number.isFinite(o?.sunset_open_probability) && o.sunset_open_probability >= 0 && o.sunset_open_probability <= 1
      ? stage.input_score * (1 - o.sunset_open_probability) : 0;
  }
  if (id === 'minimum_weather_weight') return config.weights.weather === 0 && config.weatherRegime.minimumWeatherWeight > 0
    ? (t.components.weather - t.P) * t.dynamic_weights.weather / config.weatherRegime.minimumWeatherWeight : 0;
  if (id === 'hard_gate_score_cap') { const s = t.stages.find(s => s.stage === 'hard_gate'); return s.triggered && s.input_score > s.output_score ? 1 : 0; }
  return 0;
}
// Historical V4 plans bind source locations as well as numeric evidence. Preserve
// those exact registered locations only for this pinned old engine/registry pair;
// current V4 runs continue using the live, audited registry.
const LEGACY_V4_ANCHORS = Object.freeze({
  atmosphere_quality_base: [{ file: 'js/engine.js', line: 740, token: 'atmosphereQuality' }],
  atmosphere_quality_scale: [{ file: 'js/engine.js', line: 740, token: 'atmosphereQuality' }],
  minimum_weather_weight: [{ file: 'js/engine.js', line: 671, token: 'minimumWeatherWeight' }],
  golden_window_floor: [{ file: 'js/prediction_service.js', line: 335, token: 'goldenWindow.floor' }, { binding: 'goldenWindow', file: 'js/evolution.js', line: 298, token: 'goldenWindow' }],
  hard_gate_score_cap: [{ file: 'js/engine.js', line: 727, token: 'hardGate' }]
});
export function buildTargetPlan(rows, traces, summary, current, spec = null) {
  const historicalAnchors = spec?.code?.engine_sha256 === 'db7043ef4d58b35fd1b866d3d6b23c4c5e4c26140d35135329b06cb8fc093e15' &&
    spec.code.files?.['tools/tuning/parameter-registry.mjs'] === '13e6469fd4973f21ab39f3bccc816e1ff13be8d7bbf88a9141ff4ba9dcb13eda';
  const ts = new Map(traces.map(t => [t.snapshot_id, t])), weighted = weightedRows(rows).map(r => ({ ...r, t: ts.get(r.snapshot_id) }));
  if (weighted.some(r => !r.t)) fail('TARGET_PLAN_COHORT_MISMATCH');
  const sum = rs => rs.reduce((s, r) => s + r.weight, 0), missed = weighted.filter(r => r.gt_ordinal >= 3 && r.t.predicted_ordinal < 3), low = weighted.filter(r => r.gt_ordinal <= 2);
  const candidates = CATALOG.map(([parameter_id, stage]) => {
    const unit = scalarUnit(parameter_id), value = resolvePath(current, unit.canonical_path).value, probes = probeValues(unit, value);
    if (!Number.isFinite(value) || value < unit.range[0] || value > unit.range[1] || unit.integer && !Number.isInteger(value)) fail('MECHANISM_CURRENT_VALUE_MISSING_OR_INVALID');
    const evidence = rs => {
      const affected = rs.filter(r => Math.abs(localResponse(parameter_id, r.t, current)) > POLICY.epsilon), W = sum(rs), aW = sum(affected);
      return { total_snapshots: rs.length, total_full_pool_weight: q(W), affected_snapshots: affected.length,
        affected_events: new Set(affected.map(r => r.event_id)).size, affected_full_pool_weight: q(aW), affected_share: W ? q(aW / W) : 0,
        mean_absolute_local_response_per_range: W ? q(rs.reduce((s, r) => s + r.weight * Math.abs(localResponse(parameter_id, r.t, current)) * (unit.range[1] - unit.range[0]), 0) / W) : 0,
        near_60_affected_snapshot_ids: affected.filter(r => r.t.predicted_score >= 50 && r.t.predicted_score < 60).map(r => r.snapshot_id),
        affected_snapshot_ids: affected.map(r => r.snapshot_id) };
    };
    const high = evidence(missed), control = evidence(low), actionable = high.affected_full_pool_weight > 0 && probes.length > 0;
    return { parameter_id, canonical_path: unit.canonical_path, current_value: value, range: unit.range, integer: unit.integer, wired_status: unit.wired_status,
      stage, code_locations: historicalAnchors ? LEGACY_V4_ANCHORS[parameter_id] : unit.wiring_evidence.read_at, probe_values: probes,
      evidence: { high_missed: high, low_control: control, interpretation: 'OBSERVED_LOCAL_STAGE_RESPONSE_ONLY_NOT_A_REPLAY_EFFECT_OR_ERROR_DIAGNOSIS' },
      priority: actionable ? q(high.affected_share * high.mean_absolute_local_response_per_range / Math.max(control.mean_absolute_local_response_per_range, POLICY.epsilon)) : 0,
      actionable, selection_reason: actionable ? 'ACTUAL_TARGET_EXECUTION_AND_WIRED_SCALAR; CONTROL_COST_MUST_BE_MEASURED' : 'NO_OBSERVED_TARGET_INTERVENTION_OR_NO_LEGAL_PROBES' };
  }).sort((a, b) => b.priority - a.priority || compare(a.parameter_id, b.parameter_id));
  const selected = [], stages = new Set();
  for (const c of candidates.filter(c => c.actionable)) if (!stages.has(c.stage) && selected.length < 3) { selected.push(c); stages.add(c.stage); }
  for (const c of candidates.filter(c => c.actionable)) if (!selected.includes(c) && selected.length < 3) selected.push(c);
  return { target_plan_schema_version: 1, search_space: 'mechanism-targeted', baseline_config_sha256: digest(current), trace_rows_sha256: digest(traces),
    stage_summary_sha256: digest(summary), target_rule: MECHANISM_POLICY.target_rule,
    response_limit: 'LOCAL_STAGE_DERIVATIVES_ONLY; NO_SCORES_MODIFIED; FULL_POOL_REPLAY_IS_REQUIRED_FOR_CAUSAL_CONFIG_EFFECT',
    selected: selected.map((c, i) => ({ ...c, rank: i + 1 })),
    not_selected: [...candidates.filter(c => !selected.includes(c)).map(c => ({ ...c, selection_reason: c.actionable ? 'LOWER_PRIORITY_OR_REDUNDANT_STAGE_WITHIN_THREE_TARGET_BUDGET' : c.selection_reason })),
      { parameter_id: 'evolution_background_weight', stage: 'golden_window', selection_reason: 'INTERNAL_BLEND_REMAINS_PARTIAL_TRACE; DIRECT_OBSERVED_FLOOR_ENTRY_PRIORITIZED', code_location: 'js/evolution.js:225' },
      { parameter_id: 'skyState.factorRange', stage: 'sky_evolution', selection_reason: 'PARTIALLY_WIRED_HARDCODED_RUNNER_CLAMP_NOT_AN_EFFECTIVE_SCALAR_TRIAL', code_location: 'tools/replay/replay-runner.mjs:246' }],
    unconfigured_mechanisms: summary.unconfigured_mechanisms, refinement_rule: MECHANISM_POLICY.refinement_rule,
    refinement_interior_points: 12, maximum_configurations: 25, hard_budget: 32,
    diagnostic_status: selected.length ? 'ACTIONABLE_PARAMETERS_SELECTED' : 'NO_ACTIONABLE_PARAMETER' };
}
export function normalizeMechanismParameters(parameters) {
  if (!parameters || Object.keys(parameters).length !== 2 || !('parameter_id' in parameters) || !('value' in parameters)) fail('INVALID_MECHANISM_PARAMETERS');
  if (parameters.parameter_id === null && parameters.value === null) return { parameter_id: null, value: null };
  const unit = scalarUnit(parameters.parameter_id), value = parameters.value;
  if (!Number.isFinite(value) || value < unit.range[0] || value > unit.range[1] || unit.integer && !Number.isInteger(value)) fail('INVALID_MECHANISM_PARAMETERS');
  return { parameter_id: parameters.parameter_id, value: q(value) };
}
export function installMechanism(current, parameters) {
  const p = normalizeMechanismParameters(parameters), next = structuredClone(current);
  if (p.parameter_id === null) return next;
  const unit = scalarUnit(p.parameter_id), old = resolvePath(current, unit.canonical_path);
  if (!old.exists || !Number.isFinite(old.value)) fail('MECHANISM_CURRENT_VALUE_MISSING');
  writePath(next, unit.canonical_path, p.value);
  const check = structuredClone(next); writePath(check, unit.canonical_path, old.value);
  if (digest(check) !== digest(current)) fail('NON_TARGET_MECHANISM_CONFIG_CHANGED');
  return next;
}
export function mechanismCandidate(parameters, context) {
  parameters = normalizeMechanismParameters(parameters);
  const unit = parameters.parameter_id === null ? null : scalarUnit(parameters.parameter_id);
  return { candidate_id: `practical_candidate_v4_${digest({ parameters, current: digest(context.current), original: digest(context.original),
    engine_sha256: context.engine_sha256, policy: MECHANISM_POLICY, target_plan_sha256: context.target_plan_sha256 }).slice(0, 20)}`, parameters,
    parameter_distance: unit ? q(Math.abs(parameters.value - resolvePath(context.current, unit.canonical_path).value) / (unit.range[1] - unit.range[0])) : 0 };
}
export function chooseRefinement(records, baselineId, originalMetrics, current, plan) {
  const probes = records.filter(r => r.status === 'EVALUATED' && r.candidate_id !== baselineId && r.stage === 'PROBE'), baseline = records.find(r => r.candidate_id === baselineId);
  const improved = probes.filter(r => meetsHighCloudRecognition(r, originalMetrics) && r.metrics.product_loss < baseline.metrics.product_loss - POLICY.epsilon).sort(compareHighCloud);
  const recovered = probes.filter(r => r.paired_migrations?.net_recovered_weight > POLICY.epsilon).sort(compareHighCloud);
  const point = improved[0] ?? recovered[0];
  if (!point) return { status: 'STOP_NO_IMPROVEMENT_OR_NET_RECOVERY', parameter_id: null, values: [] };
  const id = point.parameters.parameter_id, target = plan.selected.find(p => p.parameter_id === id), unit = scalarUnit(id), c = resolvePath(current, unit.canonical_path).value;
  if (!target) fail('REFINEMENT_PARAMETER_OUTSIDE_PLAN');
  const values = [...new Set(Array.from({ length: 12 }, (_, i) => c + (point.parameters.value - c) * (i + 1) / 13)
    .map(v => unit.integer ? Math.round(v) : q(v)).filter(v => v >= unit.range[0] && v <= unit.range[1] && Math.abs(v - c) > POLICY.epsilon && Math.abs(v - point.parameters.value) > POLICY.epsilon))];
  return { status: improved.length ? 'REFINE_BEST_QUALIFIED_IMPROVEMENT' : 'REFINE_LOWEST_LOSS_POSITIVE_NET_RECOVERY',
    parameter_id: id, parent_candidate: point.candidate_id, current_value: c, probe_value: point.parameters.value, values };
}
export async function searchMechanisms({ current, original, engine_sha256, plan, originalMetrics, evaluate, restored = [], save = async () => {},
  saveRefinement = async () => {}, frozenRefinement = null, maxCandidates = 32, progress = () => {} }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 32) fail('INVALID_CANDIDATE_BUDGET');
  const context = { current, original, engine_sha256, target_plan_sha256: digest(plan) }, old = new Map(restored.map(r => [r.candidate_id, r])), seen = new Set(), records = [], audit = []; let budgetHit = false;
  const propose = async (parameters, stage) => {
    let c; try { c = mechanismCandidate(parameters, context); } catch (e) { audit.push({ stage, parameters, status: 'INVALID', reason_code: errorCode(e) }); return; }
    if (seen.has(c.candidate_id)) { audit.push({ stage, candidate_id: c.candidate_id, status: 'DUPLICATE' }); return; }
    if (records.length >= maxCandidates) { budgetHit = true; return; } seen.add(c.candidate_id);
    let r = old.get(c.candidate_id);
    if (r && (digest(r.parameters) !== digest(c.parameters) || r.parameter_distance !== c.parameter_distance || r.stage !== stage)) fail('RESUME_CANDIDATE_MISMATCH');
    if (!r) { try { r = { ...c, stage, status: 'EVALUATED', ...await evaluate(c) }; } catch (e) { r = { ...c, stage, status: 'ERROR', reason_code: errorCode(e), metrics: null }; } await save(r); }
    records.push(r); audit.push({ stage, candidate_id: c.candidate_id, status: r.status });
    progress({ count: records.length, stage, candidate: r, best: rankHighCloud(records, originalMetrics)[0] });
  };
  await propose({ parameter_id: null, value: null }, 'C_BASELINE'); if (records[0]?.status !== 'EVALUATED') fail('NO_VALID_BASELINE');
  for (const p of plan.selected) for (const value of p.probe_values) await propose({ parameter_id: p.parameter_id, value }, 'PROBE');
  const refinement = budgetHit ? { status: 'STOP_BUDGET_REACHED', parameter_id: null, values: [] } : chooseRefinement(records, records[0].candidate_id, originalMetrics, current, plan);
  if (frozenRefinement && digest(frozenRefinement) !== digest(refinement)) fail('RESUME_REFINEMENT_PLAN_MISMATCH');
  await saveRefinement(refinement);
  for (const value of refinement.values) await propose({ parameter_id: refinement.parameter_id, value }, 'REFINEMENT');
  return { records, audit, refinement, baseline_id: records[0].candidate_id, budget: { maximum: maxCandidates, evaluated_unique: records.length,
    errors: records.filter(r => r.status === 'ERROR').length, duplicates: audit.filter(r => r.status === 'DUPLICATE').length,
    invalid: audit.filter(r => r.status === 'INVALID').length, termination: budgetHit ? 'BUDGET_REACHED' : 'PLANNED_PROBES_AND_SINGLE_REFINEMENT_COMPLETE', exhaustive_parameter_space: false } };
}
export function selectMechanism(records, baselineId, originalMetrics) {
  const result = selectHighCloud(records, baselineId, originalMetrics), selected = records.find(r => r.candidate_id === result.selected_candidate), current = records.find(r => r.candidate_id === baselineId);
  const { metrics_vs_baseline, tradeoffs_vs_B1, ...rest } = result;
  return { ...rest, practical_tuning_schema_version: 4, practical_tuning_policy_version: 4, search_space: 'mechanism-targeted',
    control_means: 'C_LATEST_PARENT_SELECTED_CONFIG', metrics_vs_current: metrics_vs_baseline, tradeoffs_vs_C: tradeoffs_vs_B1,
    high_grade_recognition_improved: selected.metrics.target_ge3.recall != null && current.metrics.target_ge3.recall != null && selected.metrics.target_ge3.recall > current.metrics.target_ge3.recall + POLICY.epsilon };
}
