// V2.5.5.22 weather-penalty scale and component weights (Practical Tuning Schema/Policy 17): frozen plan and pure evaluation.
// PRD: ref_docs/PRD/V2.5.5.22--天气扣分幅度与组件权重评估方案.md
// Two candidate families (P: penaltyScale, W: skyCanvas / horizon / illumination weights), each selected inside the training
// folds together with its own grade lines and compared with a lines-only recalibration (L0). Same line rule, gates and
// recall scope as Policy 15 (V2.5.5.18). The combination is evaluated only when both families pass.
import { productPolicy } from '../product-evaluation/policy.mjs';
import { fail } from '../dataset/lib/common.mjs';
import { primaryLast, aucEvaluator, bootstrapInterval } from './p0-diagnostics.mjs';
import { fitLogistic } from './p0-probe.mjs';
import { grade, foldsOf } from './horizon-potential.mjs';
import { HP2_POLICY, selectLines, summarize2 } from './horizon-potential-v2.mjs';

const freeze = value => Object.freeze(value);
const BASE_WEIGHTS = freeze({ skyCanvas: 0.2, horizon: 0.375, illumination: 0.4 });
export const PW_POLICY = freeze({
  practical_tuning_schema_version: 17, practical_tuning_policy_version: 17, search_space: 'penalty-weights',
  usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  pools: HP2_POLICY.pools, h3_first_date: HP2_POLICY.h3_first_date, live_parity_model_versions: HP2_POLICY.live_parity_model_versions,
  baseline: 'RELEASE_LINE_2.5.5.19',
  baseline_reference: freeze({ run_id: 'practical_tuning_v15_462a4c08949a2e9bba34', key: 'HA_f0.7_k5',
    signature_sha256: 'ae1ded3b0eceb491c1d7fd54679befd5f5239cc8c12730250038fc78de730f1c' }),
  penalty_grid: freeze([0.5, 0.75, 1]),
  weight_grid: freeze({ base: BASE_WEIGHTS, step: 0.05, offsets: freeze([-3, -2, -1, 0, 1, 2, 3]), illumination_range: freeze([0.25, 0.55]), fixed_sum: 0.975 }),
  // Line rule, recall scope, review table, folds, bootstrap, AUC tolerance and floors: identical to Policy 15.
  lines: HP2_POLICY.lines, review: HP2_POLICY.review, brier: HP2_POLICY.brier, folds: HP2_POLICY.folds,
  bootstrap: HP2_POLICY.bootstrap, auc_drop_tolerance: HP2_POLICY.auc_drop_tolerance, low_potential_below: HP2_POLICY.low_potential_below,
  max_combination_members: 16,
  decision_rules_version: 1
});

// ---------- candidate keys and configs ----------
const r3 = v => Number(v.toFixed(3));
export const penaltyKey = s => s === 1 ? 'C0' : `P${s}`;
export const weightKey = w => (r3(w.skyCanvas) === BASE_WEIGHTS.skyCanvas && r3(w.horizon) === BASE_WEIGHTS.horizon) ? 'C0' : `W_s${r3(w.skyCanvas)}_h${r3(w.horizon)}`;
export const comboKey = (s, w) => { const p = penaltyKey(s), q = weightKey(w); return p === 'C0' ? q : q === 'C0' ? p : `${p}+${q}`; };
export function weightGrid(policy = PW_POLICY) {
  const g = policy.weight_grid, out = [];
  for (const i of g.offsets) for (const j of g.offsets) {
    const skyCanvas = r3(g.base.skyCanvas + g.step * i), horizon = r3(g.base.horizon + g.step * j), illumination = r3(g.fixed_sum - skyCanvas - horizon);
    if (skyCanvas <= 0 || illumination < g.illumination_range[0] - 1e-9 || illumination > g.illumination_range[1] + 1e-9) continue;
    out.push(freeze({ skyCanvas, horizon, illumination }));
  }
  return out;
}
export const parseWeightKey = key => { const m = /^W_s([\d.]+)_h([\d.]+)$/.exec(key); if (!m) return null; const skyCanvas = Number(m[1]), horizon = Number(m[2]); return { skyCanvas, horizon, illumination: r3(PW_POLICY.weight_grid.fixed_sum - skyCanvas - horizon) }; };
export const parsePenaltyKey = key => { const m = /^P([\d.]+)$/.exec(key); return m ? Number(m[1]) : null; };
/** Scoring config: penaltyScale (absent when 1) and/or new base weights; nothing else changes. */
export function candidateConfig(base, { penaltyScale = 1, weights = null } = {}) {
  const config = structuredClone(base);
  if (penaltyScale !== 1) config.penaltyScale = penaltyScale;
  if (weights) { config.weights.skyCanvas = weights.skyCanvas; config.weights.horizon = weights.horizon; config.weights.illumination = weights.illumination; }
  return config;
}
const familyChooser = (keys, policy) => trainRows => { const x = selectMember(trainRows, keys, policy); if (!x) fail('PW_NO_FEASIBLE_LINES'); return x.key; };
/** Family members with the current setting (C0) first, so a tie in training loss keeps the current value. */
export const familyKeys = (family, policy = PW_POLICY) => { const keys = family === 'P' ? policy.penalty_grid.map(penaltyKey) : weightGrid(policy).map(weightKey);
  return ['C0', ...new Set(keys.filter(k => k !== 'C0'))]; };

// ---------- selection and cross-validation ----------
const LOSS = productPolicy().loss_matrix;
const q = v => Number.isFinite(v) ? Number(v.toFixed(6)) : null;
/** The family member with the lowest training loss after its own line selection (ties → grid order, so C0 first). */
export function selectMember(rows, keys, policy = PW_POLICY) {
  let best = null;
  for (const key of keys) { const s = selectLines(rows, key, policy); if (s && (!best || s.train_loss < best.train_loss - 1e-12)) best = { key, ...s }; }
  return best;
}
export function crossValidate(rows, k, keys, policy = PW_POLICY) {
  const folds = [], assign = new Map();
  for (const fold of foldsOf(rows, k)) {
    const held = new Set(fold), train = rows.filter(r => !held.has(r.event_date_local));
    const l0 = selectLines(train, 'C0', policy), x = selectMember(train, keys, policy);
    if (!l0 || !x) fail('PW_NO_FEASIBLE_LINES');
    folds.push({ dates: [fold[0], fold.at(-1)], L0_lines: l0.lines, member: x.key, member_lines: x.lines });
    for (const d of fold) assign.set(d, { L0: l0.lines, key: x.key, lines: x.lines });
  }
  const list = rows.map(r => { const a = assign.get(r.event_date_local);
    return { ...r, ordL0: grade(r.scores.C0, a.L0), ordX: grade(r.scores[a.key], a.lines), scoreX: r.scores[a.key], keyX: a.key }; });
  return { folds, list };
}
const rate = (list, den, num) => w => { let d = 0, n = 0; list.forEach((r, i) => { if (den(r)) { d += w[i]; if (num(r)) n += w[i]; } }); return d ? n / d : null; };
const lossOf = (list, field) => w => { let n = 0, d = 0; list.forEach((r, i) => { n += w[i] * LOSS[r[field]][r.gt_ordinal]; d += w[i]; }); return d ? n / d : null; };
const diff = (f, g) => x => { const u = f(x), v = g(x); return u == null || v == null ? null : u - v; };
export function compareCv(cv, label, policy = PW_POLICY) {
  const list = cv.list, w = list.map(r => r.weight), boot = (n, fn) => bootstrapInterval(list, w, `V25522|${label}|${n}`, fn, policy.bootstrap);
  const cloud = f => rate(list, r => r.gt_ordinal >= 2 && !r.recall_exempt, r => r[f] >= 2), all = f => rate(list, r => r.gt_ordinal >= 2, r => r[f] >= 2);
  return { candidate: summarize2(list, r => r.ordX), reference: summarize2(list, r => r.ordL0),
    loss_delta: boot('loss', diff(lossOf(list, 'ordX'), lossOf(list, 'ordL0'))),
    ge2_recall_cloud_type_delta: boot('r2c', diff(cloud('ordX'), cloud('ordL0'))), ge2_recall_delta: boot('r2', diff(all('ordX'), all('ordL0'))) };
}
/** Ranking without lines: out-of-fold candidate score vs C0, PRIMARY_LAST, GT-confidence weights. */
export function aucDelta(cv, label, policy = PW_POLICY) {
  const pl = primaryLast(cv.list), w = pl.map(r => r.gt_confidence), out = {};
  for (const t of [2, 3]) {
    const pos = pl.map(r => r.gt_ordinal >= t), x = aucEvaluator(pl.map(r => r.scoreX), pos), c = aucEvaluator(pl.map(r => r.scores.C0), pos);
    out[`auc_ge${t}`] = { candidate: q(x(w)), C0: q(c(w)), delta: bootstrapInterval(pl, w, `V25522|${label}|auc${t}`, diff(x, c), policy.bootstrap) };
  }
  return out;
}
const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
/** Line-free comparison: per fold, logistic P(GT≥2) on the training dates for the fold's chosen member and for C0; Brier on held-out dates. */
export function brierCv(rows, k, chooser, label, policy = PW_POLICY) {
  const pl = primaryLast(rows), index = new Map(pl.map((r, i) => [r.snapshot_id, i])), err = { X: Array(pl.length).fill(null), C0: Array(pl.length).fill(null) };
  foldsOf(rows, k).forEach((fold, foldIndex) => {
    const held = new Set(fold), trainRows = rows.filter(r => !held.has(r.event_date_local)), chosen = { key: chooser(trainRows, foldIndex) };
    const train = pl.filter(r => !held.has(r.event_date_local)), test = pl.filter(r => held.has(r.event_date_local));
    for (const [slot, key] of [['X', chosen.key], ['C0', 'C0']]) {
      const v = train.map(r => r.scores[key]), mean = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
      if (!(sd > 0)) fail('PW_BRIER_CONSTANT_SCORE');
      const fit = fitLogistic(train.map(r => [(r.scores[key] - mean) / sd]), train.map(r => r.gt_ordinal >= 2 ? 1 : 0), train.map(r => r.gt_confidence), policy.brier.logistic);
      if (!fit.converged) fail('PW_BRIER_LOGISTIC_NOT_CONVERGED');
      for (const r of test) err[slot][index.get(r.snapshot_id)] = (sigmoid(fit.beta[0] + fit.beta[1] * (r.scores[key] - mean) / sd) - (r.gt_ordinal >= 2 ? 1 : 0)) ** 2;
    }
  });
  const w = pl.map(r => r.gt_confidence), mean = e => x => { let n = 0, d = 0; e.forEach((v, i) => { n += x[i] * v; d += x[i]; }); return d ? n / d : null; };
  return { events: pl.length, candidate: q(mean(err.X)(w)), C0: q(mean(err.C0)(w)), delta: bootstrapInterval(pl, w, `V25522|${label}|brier`, diff(mean(err.X), mean(err.C0)), policy.bootstrap) };
}
export function crossPeriod(rows, trainPools, testPools, keys, policy = PW_POLICY) {
  const train = rows.filter(r => trainPools.includes(r.pool)), test = rows.filter(r => testPools.includes(r.pool));
  const l0 = selectLines(train, 'C0', policy), x = selectMember(train, keys, policy);
  if (!l0 || !x) return { train: trainPools, test: testPools, feasible: false };
  return { train: trainPools, test: testPools, feasible: true, L0_lines: l0.lines, member: x.key, member_lines: x.lines,
    L0: summarize2(test, r => grade(r.scores.C0, l0.lines)), candidate: summarize2(test, r => grade(r.scores[x.key], x.lines)) };
}
export function gatesOf(A, policy = PW_POLICY) {
  const upperBelow0 = x => x.status === 'COMPUTED' && x.ci95[1] < 0, floors = (field, floor) => A.cv5.candidate[field] >= floor && A.cv11.candidate[field] >= floor;
  const g1a = upperBelow0(A.cv5.loss_delta), g1b = A.cv5.loss_delta.point < 0 && A.cv11.loss_delta.point < 0 && upperBelow0(A.brier.cv5.delta);
  return { paths: { loss_interval_upper_below_0: g1a, both_points_below_0_and_brier_upper_below_0: g1b }, gates: {
    G1_better_than_L0: g1a || g1b,
    G2_cloud_type_ge2_recall_cv5_cv11_at_floor: floors('ge2_recall_cloud_type', policy.lines.ge2_recall_floor),
    G3_cross_period_both_lower: A.cross_period.every(c => c.feasible && c.candidate.product_loss < c.L0.product_loss),
    G4_auc_ge2_lower_above_minus_tolerance: A.auc.auc_ge2.delta.status === 'COMPUTED' && A.auc.auc_ge2.delta.ci95[0] > -policy.auc_drop_tolerance,
    G5_overall_ge2_recall_cv5_cv11_at_floor: floors('ge2_recall', policy.lines.overall_ge2_recall_floor) } };
}
/** One family (or the combination): cross-validation, AUC, Brier, cross-period, gates and decision. */
export function evaluateFamily(rows, keys, label, current, policy = PW_POLICY) {
  const cv5 = crossValidate(rows, 5, keys, policy), cv11 = crossValidate(rows, 11, keys, policy);
  const A = { cv5: { folds: cv5.folds, ...compareCv(cv5, label + '5', policy) }, cv11: { folds: cv11.folds, ...compareCv(cv11, label + '11', policy) },
    auc: aucDelta(cv5, label, policy), brier: { cv5: brierCv(rows, 5, familyChooser(keys, policy), label + '5', policy), cv11: brierCv(rows, 11, familyChooser(keys, policy), label + '11', policy) },
    cross_period: [crossPeriod(rows, ['DEV'], ['H1', 'H2'], keys, policy), crossPeriod(rows, ['H1', 'H2'], ['DEV'], keys, policy)],
    full_data_choice: selectMember(rows, keys, policy) };
  const { gates, paths } = gatesOf(A, policy), worth = Object.values(gates).every(Boolean);
  const linesHelp = A.cv5.reference.product_loss < current.product_loss;
  return { ...A, gates, G1_paths: paths, decision: worth ? 'WORTH_H4' : !gates.G1_better_than_L0 && linesHelp ? 'LINES_SUFFICIENT' : 'NO_GAIN',
    chosen_members: { cv5: cv5.folds.map(f => f.member), cv11: cv11.folds.map(f => f.member) }, report: breakdowns(cv5, policy) };
}
export function breakdowns(cv, policy = PW_POLICY) {
  const list = cv.list, pair = s => ({ snapshots: s.length, L0: summarize2(s, r => r.ordL0), candidate: summarize2(s, r => r.ordX) });
  const by = fn => Object.fromEntries([...new Set(list.map(fn))].sort().map(k => [k, pair(list.filter(r => fn(r) === k))]));
  const penalised = list.filter(r => r.weather_penalty > 0), miss = (s, f) => s.filter(r => r.gt_ordinal >= 2 && r[f] <= 1).length, fa = (s, f) => s.filter(r => r.gt_ordinal <= 1 && r[f] >= 2).length;
  return { by_pool: by(r => r.pool), by_slot: by(r => r.slot),
    penalised: { snapshots: penalised.length, gt_ge2_snapshots: penalised.filter(r => r.gt_ordinal >= 2).length,
      L0: { ...summarize2(penalised, r => r.ordL0), false_alarm_snapshots: fa(penalised, 'ordL0'), missed_ge2_snapshots: miss(penalised, 'ordL0') },
      candidate: { ...summarize2(penalised, r => r.ordX), false_alarm_snapshots: fa(penalised, 'ordX'), missed_ge2_snapshots: miss(penalised, 'ordX') } } };
}
/** Combination members needed when both families pass: every (P, W) pair a fold, a cross-period direction or the full data picks. */
export function combinationPairs(P, W) {
  const pairs = [];
  for (const k of ['cv5', 'cv11']) P[k].folds.forEach((f, i) => pairs.push([f.member, W[k].folds[i].member]));
  P.cross_period.forEach((c, i) => c.feasible && W.cross_period[i].feasible && pairs.push([c.member, W.cross_period[i].member]));
  if (P.full_data_choice && W.full_data_choice) pairs.push([P.full_data_choice.key, W.full_data_choice.key]);
  const seen = new Map();
  for (const [p, w] of pairs) { const s = p === 'C0' ? 1 : parsePenaltyKey(p), weights = w === 'C0' ? BASE_WEIGHTS : parseWeightKey(w); seen.set(comboKey(s, weights), { penaltyScale: s, weights }); }
  return seen;
}
/**
 * Combination rows: in each fold the member is the pair of the fold's own P and W choices (no new search). Keys must exist on rows.
 */
export function crossValidateCombination(rows, k, P, W, policy = PW_POLICY) {
  const pf = P[`cv${k}`].folds, wf = W[`cv${k}`].folds, assign = new Map(), folds = [];
  foldsOf(rows, k).forEach((fold, i) => {
    const held = new Set(fold), train = rows.filter(r => !held.has(r.event_date_local));
    const s = pf[i].member === 'C0' ? 1 : parsePenaltyKey(pf[i].member), w = wf[i].member === 'C0' ? BASE_WEIGHTS : parseWeightKey(wf[i].member);
    const key = comboKey(s, w), l0 = selectLines(train, 'C0', policy), x = selectLines(train, key, policy);
    if (!l0 || !x) fail('PW_NO_FEASIBLE_LINES');
    folds.push({ dates: [fold[0], fold.at(-1)], L0_lines: l0.lines, member: key, member_lines: x.lines });
    for (const d of fold) assign.set(d, { L0: l0.lines, key, lines: x.lines });
  });
  const list = rows.map(r => { const a = assign.get(r.event_date_local);
    return { ...r, ordL0: grade(r.scores.C0, a.L0), ordX: grade(r.scores[a.key], a.lines), scoreX: r.scores[a.key], keyX: a.key }; });
  return { folds, list };
}
export function evaluateCombination(rows, P, W, current, policy = PW_POLICY) {
  const cv5 = crossValidateCombination(rows, 5, P, W, policy), cv11 = crossValidateCombination(rows, 11, P, W, policy);
  const period = (i, trainPools, testPools) => {
    const pk = P.cross_period[i].member, wk = W.cross_period[i].member;
    const key = comboKey(pk === 'C0' ? 1 : parsePenaltyKey(pk), wk === 'C0' ? BASE_WEIGHTS : parseWeightKey(wk));
    return crossPeriod(rows, trainPools, testPools, [key], policy);
  };
  // Brier: each fold uses its own combination member (the pair of that fold's P and W choices).
  const brierFor = (k, cv) => brierCv(rows, k, (trainRows, i) => cv.folds[i].member, `C${k}`, policy);
  const A = { cv5: { folds: cv5.folds, ...compareCv(cv5, 'C5', policy) }, cv11: { folds: cv11.folds, ...compareCv(cv11, 'C11', policy) },
    auc: aucDelta(cv5, 'C', policy), brier: { cv5: brierFor(5, cv5), cv11: brierFor(11, cv11) },
    cross_period: [period(0, ['DEV'], ['H1', 'H2']), period(1, ['H1', 'H2'], ['DEV'])] };
  const { gates, paths } = gatesOf(A, policy), worth = Object.values(gates).every(Boolean);
  return { ...A, gates, G1_paths: paths, decision: worth ? 'WORTH_H4' : 'NO_GAIN' };
}
export function evaluateFamilies(rows, policy = PW_POLICY) {
  const current = summarize2(rows, r => grade(r.scores.C0, policy.lines.current));
  return { current, P: evaluateFamily(rows, familyKeys('P', policy), 'P', current, policy), W: evaluateFamily(rows, familyKeys('W', policy), 'W', current, policy) };
}
export const needsCombination = ({ P, W }) => P.decision === 'WORTH_H4' && W.decision === 'WORTH_H4';
/** Final decision. combinationRows (rows carrying the combination members' scores) is required only when both families pass. */
export function evaluateAll(rows, policy = PW_POLICY, families = evaluateFamilies(rows, policy), combinationRows = null) {
  const { current, P, W } = families;
  let combination = null;
  if (needsCombination(families)) {
    if (!combinationRows) fail('PW_COMBINATION_ROWS_MISSING');
    combination = evaluateCombination(combinationRows, P, W, current, policy);
  }
  const worth = [['P', P], ['W', W]].filter(([, f]) => f.decision === 'WORTH_H4');
  const best = worth.length ? worth.reduce((a, b) => b[1].cv5.candidate.product_loss < a[1].cv5.candidate.product_loss ? b : a)[0] : null;
  const recommended = combination && combination.decision === 'WORTH_H4' && combination.cv5.candidate.product_loss < (best === 'P' ? P : W).cv5.candidate.product_loss ? 'P+W' : best;
  // Report only: every weight member on all rows without lines (ranking), and both families at the current lines.
  const pl = primaryLast(rows), w = pl.map(r => r.gt_confidence);
  const aucOf = (key, t) => q(aucEvaluator(pl.map(r => r.scores[key]), pl.map(r => r.gt_ordinal >= t))(w));
  const weightSensitivity = weightGrid(policy).map(g => ({ ...g, key: weightKey(g), auc_ge2: aucOf(weightKey(g), 2), auc_ge3: aucOf(weightKey(g), 3) }));
  const atCurrent = Object.fromEntries([...familyKeys('P', policy), ...familyKeys('W', policy)].filter((k, i, a) => a.indexOf(k) === i)
    .map(k => [k, summarize2(rows, r => grade(r.scores[k], policy.lines.current))]));
  const linesFull = { L0: selectLines(rows, 'C0', policy)?.lines ?? null };
  return { current_lines_C0: current, P, W, combination, recommended, decision: recommended ? 'WORTH_H4' : (P.decision === 'LINES_SUFFICIENT' || W.decision === 'LINES_SUFFICIENT') ? 'LINES_SUFFICIENT' : 'NO_GAIN',
    report_only: { weight_sensitivity: weightSensitivity, at_current_lines: atCurrent, full_data_lines: linesFull },
    rules_version: policy.decision_rules_version, requires_owner_confirmation: true, role: 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE' };
}
