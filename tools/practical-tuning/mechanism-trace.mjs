import { fail } from '../dataset/lib/common.mjs';
import { weightedRows } from '../product-evaluation/metrics.mjs';
import { digest, q, MEMBERS } from './policy.mjs';

export const TRACE_TOLERANCE = 1e-8;
const STAGE_ORDER = ['weighted_components', 'atmosphere_quality', 'horizon_gate', 'structure_bonus', 'transition_bonus', 'weather_penalty',
  'core_clamp', 'hard_gate', 'core_round', 'sky_evolution', 'golden_window', 'final_clamp', 'final_round'];
export const STAGE_LOCATIONS = Object.freeze({ weighted_components: 'js/engine.js:735', atmosphere_quality: 'js/engine.js:740',
  horizon_gate: 'js/engine.js:742', structure_bonus: 'js/engine.js:389', transition_bonus: 'js/engine.js:681', weather_penalty: 'js/engine.js:710',
  core_clamp: 'js/engine.js:741', hard_gate: 'js/engine.js:743', core_round: 'js/engine.js:745',
  sky_evolution: 'tools/replay/replay-runner.mjs:246', golden_window: 'js/evolution.js:298',
  final_clamp: 'tools/replay/replay-runner.mjs:246', final_round: 'tools/replay/replay-runner.mjs:246' });
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TRACE_TOLERANCE;
export function decomposeTrace(row, value, config) {
  const t = value.trace;
  if (!t || !Array.isArray(t.stages) || !Number.isFinite(t.P) || !MEMBERS.every(k => Number.isFinite(t.components?.[k]) && Number.isFinite(t.dynamic_weights?.[k]) &&
      close(t.components[k] * t.dynamic_weights[k], t.contributions?.[k]))) fail('MECHANISM_TRACE_COMPONENTS_INVALID');
  if (digest(t.stages.map(s => s.stage)) !== digest(STAGE_ORDER)) fail('MECHANISM_TRACE_STAGE_COVERAGE_INVALID');
  const sum = MEMBERS.reduce((s, k) => s + t.contributions[k], 0);
  if (!close(sum, t.P) || !close(MEMBERS.reduce((s, k) => s + t.dynamic_weights[k], 0), 1)) fail('MECHANISM_TRACE_P_NOT_CONSERVED');
  let previous = t.P, delta = 0;
  const stages = t.stages.map((s, i) => {
    const origin = s.stage === 'weighted_components';
    if (origin ? i !== 0 || s.input_score !== null || !close(s.output_score, t.P) : !close(s.input_score, previous)) fail('MECHANISM_TRACE_CHAIN_BROKEN');
    const difference = origin ? null : s.output_score - s.input_score;
    if (!origin) delta += difference; previous = s.output_score;
    const inactive = s.stage === 'golden_window' && !t.golden_window_active;
    if (inactive && !close(difference, 0)) fail('INACTIVE_GOLDEN_WINDOW_CHANGED_SCORE');
    const partial = s.stage === 'golden_window' || s.stage === 'sky_evolution' && !t.sky_branch;
    return { ...s, delta_score: difference, status: inactive ? 'NOT_EXECUTED' : partial ? 'PARTIAL_TRACE' : 'EXECUTED',
      triggered: inactive ? false : s.stage === 'hard_gate' ? Boolean(t.hard_gate_reasons?.length) : !origin && Math.abs(difference) > TRACE_TOLERANCE,
      reason_code: inactive ? 'OUTSIDE_GOLDEN_WINDOW' : s.stage === 'hard_gate' ? t.hard_gate_reasons?.join('|') || 'NO_HARD_GATE_TRIGGER' : s.reason_code,
      code_location: STAGE_LOCATIONS[s.stage] ?? null };
  });
  if (!close(previous, value.score) || !close(t.P + delta, value.score) || t.final_score !== value.score) fail('MECHANISM_TRACE_FINAL_NOT_CONSERVED');
  return { snapshot_id: row.snapshot_id, event_id: row.event_id, event_date_local: row.event_date_local, location_key: row.location_key,
    gt_ordinal: row.gt_ordinal, gt_confidence: row.gt_confidence, event_normalized_weight: row.event_normalized_weight,
    predicted_score: value.score, predicted_ordinal: value.ordinal, regime_label: t.executed_regime?.label ?? null,
    regime_strength: t.executed_regime?.strength ?? null, scheduled_slot: row.scheduled_slot, lead_time_bucket: row.lead_time_bucket,
    base_weights: config.weights, components: t.components, dynamic_weights: t.dynamic_weights, contributions: t.contributions,
    P: t.P, Q: t.Q, horizon_gate: t.horizon_gate, hard_gate_reasons: t.hard_gate_reasons,
    golden_window_observation: t.golden_window_observation ?? { status: 'PARTIAL_TRACE', reason_code: 'INTERNAL_OBSERVATION_UNAVAILABLE' },
    stages, nowcast: t.nowcast, internal_trace_limits: t.internal_trace_limits, status: 'PARTIAL_TRACE',
    ...(t.sky_branch ? { sky_branch: t.sky_branch } : {}),
    ...(t.illumination_internal ? { illumination_internal: t.illumination_internal } : {}),
    score_gap_to_ge3: 60 - value.score,
    conservation: { status: 'PASS', tolerance: TRACE_TOLERANCE, component_sum: sum, total_stage_delta: delta, final_reconstructed: t.P + delta,
      trace_off_score_and_ordinal_equal: true } };
}
export async function collectMechanismTraces(rows, config, scores, calculator, { restored = new Map(), save = async () => {}, progress = () => {} } = {}) {
  const traces = [];
  for (const [i, row] of rows.entries()) {
    let result = restored.get(row.snapshot_id);
    if (!result) {
      const off = await calculator.calculate(row, config), on = await calculator.calculate(row, config, true);
      if (on.score !== off.score || on.ordinal !== off.ordinal || on.score !== scores[i]) fail('MECHANISM_TRACE_SWITCH_CHANGED_PREDICTION');
      result = decomposeTrace(row, on, config); await save(result);
    }
    if (result.snapshot_id !== row.snapshot_id || result.event_id !== row.event_id || result.predicted_score !== scores[i] ||
        result.gt_ordinal !== row.gt_ordinal || result.gt_confidence !== row.gt_confidence || result.event_normalized_weight !== row.event_normalized_weight ||
        digest(result.base_weights) !== digest(config.weights) || result.conservation?.status !== 'PASS') fail('RESTORED_TRACE_BINDING_MISMATCH');
    traces.push(result); if ((i + 1) % 100 === 0 || i + 1 === rows.length) progress(`全池Trace ${i + 1}/${rows.length}，开关分数/等级及守恒一致`);
  }
  calculator.assertConfig(config); return traces;
}
const sum = rs => rs.reduce((s, r) => s + r.weight, 0);
const support = rs => ({ snapshot_count: rs.length, event_count: new Set(rs.map(r => r.event_id)).size,
  date_count: new Set(rs.map(r => r.event_date_local)).size, full_pool_weighted_amount: q(sum(rs)) });
function describe(rs, value, fullWeight) {
  const available = rs.filter(r => Number.isFinite(value(r))), total = sum(available), sorted = [...available].sort((a, b) => value(a) - value(b) || a.snapshot_id.localeCompare(b.snapshot_id));
  const quantile = p => { if (!total) return null; let s = 0; for (const r of sorted) { s += r.weight; if (s >= p * total) return q(value(r)); } return q(value(sorted.at(-1))); };
  const weighted = available.reduce((s, r) => s + r.weight * value(r), 0);
  return { ...support(available), group_conditional_weighted_mean: total ? q(weighted / total) : null,
    full_pool_weighted_mean_contribution: fullWeight ? q(weighted / fullWeight) : null, p10: quantile(.1), p50: quantile(.5), p90: quantile(.9) };
}
export function summarizeMechanismTraces(rows, traces) {
  const byId = new Map(traces.map(t => [t.snapshot_id, t]));
  if (byId.size !== rows.length || traces.length !== rows.length) fail('TRACE_SUMMARY_COHORT_MISMATCH');
  const all = weightedRows(rows).map(r => ({ ...r, t: byId.get(r.snapshot_id) }));
  if (all.some(r => !r.t)) fail('TRACE_SUMMARY_COHORT_MISMATCH');
  const W = sum(all), missed = r => r.gt_ordinal >= 3 && r.t.predicted_ordinal < 3;
  const definitions = [['all', () => true], ['high_missed', missed], ['high_hit', r => r.gt_ordinal >= 3 && r.t.predicted_ordinal >= 3], ['low_control', r => r.gt_ordinal <= 2],
    ...[0, 1, 2].map(n => [`high_missed_predicted_${n}`, r => missed(r) && r.t.predicted_ordinal === n]),
    ['high_missed_score_50_59', r => missed(r) && r.t.predicted_score >= 50],
    ...[[0, 19], [20, 39], [40, 49]].map(([a, b]) => [`high_missed_score_${a}_${b}`, r => missed(r) && r.t.predicted_score >= a && r.t.predicted_score <= b]),
    ...[0, 1, 2].map(n => [`low_actual_${n}`, r => r.gt_ordinal === n])];
  const stageNames = traces[0]?.stages.map(s => s.stage) ?? [];
  const groups = definitions.map(([group, filter]) => {
    const rs = all.filter(filter);
    return { group, ...support(rs), P: describe(rs, r => r.t.P, W), score: describe(rs, r => r.t.predicted_score, W),
      components: MEMBERS.map(component => ({ component, raw: describe(rs, r => r.t.components[component], W),
        dynamic_weight: describe(rs, r => r.t.dynamic_weights[component], W), contribution_to_P: describe(rs, r => r.t.contributions[component], W) })),
      stages: stageNames.map(stage => {
        const pairs = rs.map(r => ({ ...r, s: r.t.stages.find(s => s.stage === stage) }));
        const executed = pairs.filter(r => r.s?.status !== 'NOT_EXECUTED'), triggered = executed.filter(r => r.s.triggered);
        return { stage, code_location: STAGE_LOCATIONS[stage], ...support(pairs), executed: support(executed), triggered: support(triggered),
          not_executed: support(pairs.filter(r => r.s?.status === 'NOT_EXECUTED')), partial_trace: support(pairs.filter(r => r.s?.status === 'PARTIAL_TRACE')),
          input: describe(executed, r => r.s.input_score, W), output: describe(executed, r => r.s.output_score, W), delta: describe(executed, r => r.s.delta_score, W),
          downward_crossing_60: support(executed.filter(r => r.s.input_score >= 60 && r.s.output_score < 60)),
          upward_crossing_60: support(executed.filter(r => r.s.input_score < 60 && r.s.output_score >= 60)),
          triggering_snapshot_ids: triggered.map(r => r.snapshot_id) };
      }) };
  });
  return { trace_schema_version: 1, trace_rows_sha256: digest(traces), conservation_tolerance: TRACE_TOLERANCE,
    weight_basis: 'FIXED_FULL_POOL_EVENT_NORMALIZED_WEIGHTS; GROUP_MEANS_DIVIDE_GROUP_WEIGHT; FULL_POOL_CONTRIBUTIONS_DIVIDE_POOL_WEIGHT',
    causal_claim: false, crossing_claim: 'EXECUTION_STAGE_CROSSING_ONLY_NOT_REMOVAL_COUNTERFACTUAL',
    component_limitation: 'DISTANCE_TO_COMPONENT_MAXIMUM_IS_NOT_RECOVERABLE_SCORE', groups,
    unconfigured_mechanisms: ['horizon_gate', 'weather_penalty'].map(stage => ({ stage, code_location: STAGE_LOCATIONS[stage],
      missed_triggering_snapshot_ids: groups.find(g => g.group === 'high_missed').stages.find(s => s.stage === stage).triggering_snapshot_ids,
      status: 'NO_SELECTED_REGISTERED_SCALAR', minimum_change: 'Isolate one existing rule scalar, preserve current default, register and replay all paired controls before any semantic change.' })) };
}
