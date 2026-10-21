import { runReplay } from '../replay/replay-runner.mjs';
import { buildModelConfig } from '../tuning/lib/base-config.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { productMetrics, weightedRows } from '../product-evaluation/metrics.mjs';
import { digest, installWeights, MEMBERS, POLICY, q } from './policy.mjs';
import { fail, errorCode } from '../dataset/lib/common.mjs';
export function replayCalculator(engineHash, runner = runReplay) {
  const cache = new Map(), configs = new WeakMap(); let hits = 0, misses = 0;
  const compiled = config => {
    if (!configs.has(config)) configs.set(config, { sha256: digest(config), model: buildModelConfig(structuredClone(config)) });
    return configs.get(config);
  };
  const assertConfig = config => { const c = compiled(config); if (digest(config) !== c.sha256 || digest(c.model.scoring) !== c.sha256) fail('REPLAY_MUTATED_CONFIG'); };
  return { assertConfig, stats: () => ({ entries: cache.size, hits, misses }),
    async calculate(row, config, trace = false) {
      const c = compiled(config);
      const key = `${row.input_sha256 ?? digest(row.replay)}|${c.sha256}|${engineHash}|${trace}`;
      if (cache.has(key)) { hits++; return cache.get(key); }
      misses++;
      const result = await runner(row.replay, { modelConfig: c.model, trace });
      const score = result.actual?.score;
      if (!Number.isInteger(score) || score < 0 || score > 100) fail('INVALID_REPLAY_SCORE');
      const value = { score, ordinal: scoreToOrdinal(score), ...(trace ? { trace: result.trace } : {}) };
      cache.set(key, value); return value;
    } };
}
export async function preflight(loaded, control, calculator, progress = () => {}) {
  const included = [], exclusions = [...loaded.exclusions], reference = [];
  for (const row of loaded.rows) {
    try {
      const actual = await calculator.calculate(row, control);
      included.push({ ...row, control_score: actual.score, control_ordinal: actual.ordinal });
      reference.push({ snapshot_id: row.snapshot_id, historical_score: row.predicted_score,
        current_control_score: actual.score, delta: actual.score - row.predicted_score });
    } catch (e) {
      exclusions.push({ snapshot_id: row.snapshot_id, event_id: row.event_id, historical_splits: row.historical_splits,
        reason_code: 'CONTROL_REPLAY_UNAVAILABLE', detail: errorCode(e) });
    }
    if ((included.length + exclusions.length) % 100 === 0) progress(`Control 预检：已纳入 ${included.length}，已排除 ${exclusions.length}`);
  }
  if (!included.length) fail('NO_VALID_CONTROL_SAMPLES');
  calculator.assertConfig(control);
  // Recompute Event confidence weights after exclusions, never reuse split-local weights.
  const normalized = weightedRows(included);
  return { rows: normalized, exclusions, reference,
    included: normalized.map(({ replay, ...r }) => r) };
}
export async function evaluateWeights(rows, control, weights, calculator) {
  return evaluateConfig(rows, installWeights(control, weights), calculator);
}
export async function evaluateConfig(rows, config, calculator) {
  const scores = [];
  for (const row of rows) scores.push((await calculator.calculate(row, config)).score);
  if (scores.length !== rows.length) fail('CANDIDATE_INCOMPLETE');
  calculator.assertConfig(config);
  const predicted = rows.map((r, i) => ({ ...r, predicted_score: scores[i], predicted_ordinal: scoreToOrdinal(scores[i]) }));
  return { scores, metrics: productMetrics(predicted), predictions_sha256: digest(rows.map((r, i) => [r.snapshot_id, scores[i], scoreToOrdinal(scores[i])])) };
}
export async function wiringCheck(rows, control, calculator, maxProbes = POLICY.budget - 1) {
  const base = await evaluateWeights(rows, control, control.weights, calculator);
  if (rows.some((r, i) => r.control_score !== base.scores[i])) fail('EMPTY_VECTOR_CONTROL_MISMATCH');
  const perturbations = [], probes = []; let effect = false;
  for (const from of MEMBERS) for (const to of MEMBERS) {
    if (from === to || control.weights[from] <= 0) continue;
    const delta = Math.min(0.1, control.weights[from], 1 - control.weights[to]);
    if (delta <= 0) continue;
    const w = { ...control.weights, [from]: q(control.weights[from] - delta), [to]: q(control.weights[to] + delta) };
    probes.push(w);
  }
  for (const member of MEMBERS) probes.push(Object.fromEntries(MEMBERS.map(k => [k, Number(k === member)])));
  for (const w of probes.slice(0, maxProbes)) {
    try {
      const record = await evaluateWeights(rows, control, w, calculator);
      const changed = record.scores.filter((v, i) => v !== base.scores[i]).length;
      perturbations.push({ weights: w, status: 'EVALUATED', changed_snapshot_count: changed });
      if (changed) { effect = true; break; }
    } catch (e) { perturbations.push({ weights: w, status: 'ERROR', reason_code: errorCode(e) }); }
  }
  const traces = [];
  const examples = [...new Map(rows.map(r => [r.regime_label, r])).values()].slice(0, 5);
  for (const row of examples) {
    const value = await calculator.calculate(row, control, true);
    traces.push({ snapshot_id: row.snapshot_id, regime_label: row.regime_label, base_weights: control.weights,
      actual_dynamic_weights: value.trace?.dynamic_weights ?? null, P: value.trace?.P ?? null, trace: value.trace ?? null });
  }
  return { status: effect ? 'EFFECTIVE' : perturbations.some(p => p.status === 'ERROR') ? 'PROBE_EXECUTION_ERRORS' :
    probes.length > maxProbes ? 'PROBE_BUDGET_REACHED' : 'WEIGHTS_NOT_EFFECTIVE', empty_vector_matches_control: true,
    effect_definition: 'ANY_CHANGED_FINAL_SCORE_ON_FIXED_POOL', perturbations, traces,
    explanation: '基础权重按天气型乘数和强度调整；weather 施加下限，整体归一后计算 P；其他乘数、门限及公式保持 Control。' };
}
export function constantComparisons(rows) {
  const all = Array.from({ length: 5 }, (_, ordinal) => ({ ordinal,
    metrics: productMetrics(rows.map(r => ({ ...r, predicted_ordinal: ordinal }))) }));
  return { fixed1: all[1], fixed2: all[2], pool_optimal: [...all].sort((a, b) => a.metrics.product_loss - b.metrics.product_loss || a.ordinal - b.ordinal)[0],
    selected_on: 'REUSED_DEVELOPMENT_POOL_INFORMATION_ONLY', all };
}
export function sliceComparisons(rows, scores) {
  const predicted = rows.map((r, i) => ({ ...r, predicted_ordinal: scoreToOrdinal(scores[i]) }));
  return ['event_date_local', 'city', 'lead_time_bucket', 'scheduled_slot'].flatMap(dimension =>
    [...new Set(rows.map(r => r[dimension] ?? null))].sort().map(value => {
      const subset = predicted.filter(r => (r[dimension] ?? null) === value);
      return { dimension, value, metrics: productMetrics(subset), control: productMetrics(subset, 'control_ordinal') };
    }));
}
