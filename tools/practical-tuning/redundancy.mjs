// V2.5.5.21 three single-parameter redundancy checks (Practical Tuning Schema/Policy 16): frozen plan and pure evaluation.
// PRD: ref_docs/PRD/V2.5.5.21--三项单参数去冗余评估方案.md
// Fixed candidates against the released 2.5.5.19 (C0) at the current grade lines: no fitted parameter, so no cross-validation;
// paired comparisons on all rows with date-block bootstrap intervals.
import { P0_POOLED_POLICY } from './p0-features.mjs';
import { primaryLast, aucEvaluator, bootstrapInterval } from './p0-diagnostics.mjs';
import { productPolicy } from '../product-evaluation/policy.mjs';
import { grade, summarize, selectLines } from './horizon-potential.mjs';

const freeze = value => Object.freeze(value);
export const RD_POLICY = freeze({
  practical_tuning_schema_version: 16, practical_tuning_policy_version: 16, search_space: 'redundancy',
  usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  pools: P0_POOLED_POLICY.pools, h3_first_date: P0_POOLED_POLICY.h3_first_date,
  baseline: 'RELEASE_LINE_2.5.5.19',
  // C0 must equal the V2.5.5.18 Run member HA_f0.7_k5 on all 1377 rows (pinned before development).
  baseline_reference: freeze({ run_id: 'practical_tuning_v15_462a4c08949a2e9bba34', key: 'HA_f0.7_k5',
    signature_sha256: 'ae1ded3b0eceb491c1d7fd54679befd5f5239cc8c12730250038fc78de730f1c' }),
  candidates: freeze({
    T0: freeze({ change: 'weatherRegime.transitionBonusLimit = 0' }),
    W0: freeze({ change: 'weatherRegime.minimumWeatherWeight = 0' }),
    G1: freeze({ change: 'golden-window factor min(F, 1), offline post-process of the traced score' })
  }),
  candidate_order: freeze(['T0', 'W0', 'G1']),
  report_only: freeze({ W0_02: 0.02, GREF_reference: 0.839856, gref_rule: 'MEAN_PRE_REFERENCE_FACTOR_OF_ACTIVE_ROWS_ROUND_6' }),
  lines: freeze({ current: freeze([19, 49, 66, 90]), a: freeze([10, 35]), b: freeze([35, 65]), c: freeze([55, 80]), d: 90,
    ge2_recall_floor: 0.65, ge3_recall_floor: 0.20 }),
  gates: freeze({ overall_ge2_recall_floor: 0.60, auc_drop_tolerance: 0.02, period_split: freeze([freeze(['DEV']), freeze(['H1', 'H2'])]) }),
  bootstrap: P0_POOLED_POLICY.bootstrap,
  decision_rules_version: 1
});

/** Scoring config for a candidate (T0 / W0 / combinations); G1 is a post-process and never changes the config. */
export function candidateConfig(base, parts, extra = {}) {
  const config = structuredClone(base);
  if (parts.includes('T0')) config.weatherRegime.transitionBonusLimit = 0;
  if (parts.includes('W0')) config.weatherRegime.minimumWeatherWeight = 0;
  if (extra.minimumWeatherWeight != null) config.weatherRegime.minimumWeatherWeight = extra.minimumWeatherWeight;
  if (extra.reference != null) config.goldenWindow.reference = extra.reference;
  return config;
}
export const keyOf = parts => parts.length ? [...parts].sort((a, b) => RD_POLICY.candidate_order.indexOf(a) - RD_POLICY.candidate_order.indexOf(b)).join('') : 'C0';
/** Golden window only penalises: round(clamp(sky-stage score × min(F, 1))). */
export const capGoldenWindow = (skyScore, appliedFactor) => Math.round(Math.min(100, Math.max(0, skyScore * Math.min(appliedFactor, 1))));
/** The V2.5.5.2 reference rule: mean of floor + (1 − floor) × P_open over active rows, 6 decimals. */
export function referenceByRule(openProbabilities, floor) {
  const v = openProbabilities.filter(Number.isFinite);
  return v.length ? Number((v.reduce((s, p) => s + floor + (1 - floor) * p, 0) / v.length).toFixed(6)) : null;
}

// ---------- metrics ----------
const LOSS = productPolicy().loss_matrix;
const q = v => Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const rate = (list, den, num) => w => { let d = 0, n = 0; list.forEach((r, i) => { if (den(r)) { d += w[i]; if (num(r)) n += w[i]; } }); return d ? n / d : null; };
export function metricsOf(list, key, lines = RD_POLICY.lines.current) {
  const ord = r => grade(r.scores[key], lines), w = list.map(r => r.weight);
  return { ...summarize(list, ord), false_alarm_rate: q(rate(list, r => r.gt_ordinal <= 1, r => ord(r) >= 2)(w)) };
}
const lossFn = (list, key, lines) => w => { let n = 0, d = 0; list.forEach((r, i) => { n += w[i] * LOSS[grade(r.scores[key], lines)][r.gt_ordinal]; d += w[i]; }); return d ? n / d : null; };
const recallFn = (list, key, lines) => rate(list, r => r.gt_ordinal >= 2, r => grade(r.scores[key], lines) >= 2);
const diff = (f, g) => x => { const u = f(x), v = g(x); return u == null || v == null ? null : u - v; };

/** Candidate vs C0 at the current lines: point metrics, loss and recall deltas with date-block intervals, AUC deltas, pool split. */
export function compare(rows, key, policy = RD_POLICY) {
  const lines = policy.lines.current, w = rows.map(r => r.weight), boot = (name, fn, list = rows, weights = w) => bootstrapInterval(list, weights, `V25521|${key}|${name}`, fn, policy.bootstrap);
  const pl = primaryLast(rows), pw = pl.map(r => r.gt_confidence), auc = {};
  for (const t of [2, 3]) {
    const pos = pl.map(r => r.gt_ordinal >= t), x = aucEvaluator(pl.map(r => r.scores[key]), pos), c = aucEvaluator(pl.map(r => r.scores.C0), pos);
    auc[`auc_ge${t}`] = { candidate: q(x(pw)), C0: q(c(pw)), delta: boot(`auc${t}`, diff(x, c), pl, pw) };
  }
  const periods = policy.gates.period_split.map(pools => {
    const sub = rows.filter(r => pools.includes(r.pool));
    return { pools, snapshots: sub.length, loss_delta_point: q(metricsOf(sub, key).product_loss - metricsOf(sub, 'C0').product_loss) };
  });
  return { key, candidate: metricsOf(rows, key), C0: metricsOf(rows, 'C0'),
    loss_delta: boot('loss', diff(lossFn(rows, key, lines), lossFn(rows, 'C0', lines))),
    ge2_recall_delta: boot('r2', diff(recallFn(rows, key, lines), recallFn(rows, 'C0', lines))), ...auc, periods };
}
export function gatesOf(cmp, policy = RD_POLICY) {
  return {
    G1_loss_upper_below_0: cmp.loss_delta.status === 'COMPUTED' && cmp.loss_delta.ci95[1] < 0,
    G2_auc_ge2_lower_above_minus_tolerance: cmp.auc_ge2.delta.status === 'COMPUTED' && cmp.auc_ge2.delta.ci95[0] > -policy.gates.auc_drop_tolerance,
    G3_overall_ge2_recall_at_floor: cmp.candidate.ge2_recall >= policy.gates.overall_ge2_recall_floor,
    G4_both_periods_lower: cmp.periods.every(p => p.loss_delta_point != null && p.loss_delta_point < 0)
  };
}
/** Report-only: rows whose score / grade changed, and in which direction. */
export function changes(rows, key, lines = RD_POLICY.lines.current) {
  const d = rows.map(r => [r.scores[key] - r.scores.C0, grade(r.scores[key], lines) - grade(r.scores.C0, lines)]);
  return { score_up: d.filter(x => x[0] > 0).length, score_down: d.filter(x => x[0] < 0).length,
    grade_up: d.filter(x => x[1] > 0).length, grade_down: d.filter(x => x[1] < 0).length };
}
export function bySlot(rows, keys) {
  const groups = [...new Set(rows.map(r => r.slot))].sort();
  return Object.fromEntries(groups.map(g => { const s = rows.filter(r => r.slot === g);
    return [g, { snapshots: s.length, ...Object.fromEntries(keys.map(k => { const m = metricsOf(s, k); return [k, { bias: m.bias, false_alarm_rate: m.false_alarm_rate, product_loss: m.product_loss }]; })) }]; }));
}

// ---------- full evaluation and §5 decision ----------
export function evaluateAll(rows, policy = RD_POLICY) {
  const singles = {};
  for (const key of policy.candidate_order) { const cmp = compare(rows, key, policy), gates = gatesOf(cmp, policy);
    singles[key] = { ...cmp, gates, decision: Object.values(gates).every(Boolean) ? 'ADOPT_CANDIDATE' : 'NO_GAIN', changes: changes(rows, key) }; }
  const adopted = policy.candidate_order.filter(k => singles[k].decision === 'ADOPT_CANDIDATE');
  let combination = null, recommended = null;
  if (adopted.length >= 2) {
    const key = keyOf(adopted), cmp = compare(rows, key, policy), gates = gatesOf(cmp, policy);
    combination = { ...cmp, parts: adopted, gates, decision: Object.values(gates).every(Boolean) ? 'ADOPT_CANDIDATE' : 'NO_GAIN', changes: changes(rows, key) };
  }
  if (adopted.length) {
    const bestSingle = adopted.reduce((a, b) => singles[b].candidate.product_loss < singles[a].candidate.product_loss ? b : a);
    recommended = combination && combination.decision === 'ADOPT_CANDIDATE' && combination.candidate.product_loss < singles[bestSingle].candidate.product_loss ? combination.key : bestSingle;
  }
  const extraKeys = ['W0_02', 'GREF'].filter(k => rows.every(r => Number.isInteger(r.scores[k])));
  const reportOnly = {
    extra: Object.fromEntries(extraKeys.map(k => [k, { ...compare(rows, k, policy), changes: changes(rows, k) }])),
    combinations_all: Object.fromEntries(['T0W0', 'T0G1', 'W0G1', 'T0W0G1'].map(k => [k, { candidate: metricsOf(rows, k), loss_delta_point: q(metricsOf(rows, k).product_loss - metricsOf(rows, 'C0').product_loss) }])),
    by_slot: bySlot(rows, ['C0', ...policy.candidate_order, ...(combination ? [combination.key] : [])]),
    full_data_lines: Object.fromEntries(['C0', ...policy.candidate_order].map(k => [k, selectLines(rows, k, policy)?.lines ?? null]))
  };
  return { C0: metricsOf(rows, 'C0'), singles, adopted, combination, recommended,
    decision: recommended ? 'ADOPT_CANDIDATE' : 'NO_GAIN', report_only: reportOnly,
    multiple_comparisons: 'THREE_CANDIDATES_EACH_AT_95_PERCENT_NO_CORRECTION; RESULT_ONLY_SELECTS_FOR_THE_NEXT_FORWARD_HOLDOUT',
    rules_version: policy.decision_rules_version, requires_owner_confirmation: true, role: 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE' };
}
