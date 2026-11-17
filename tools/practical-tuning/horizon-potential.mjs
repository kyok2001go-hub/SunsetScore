// V2.5.5.17 horizon contribution conditioned on cloud potential (Practical Tuning Schema/Policy 14): frozen plan and pure
// evaluation. PRD: ref_docs/PRD/V2.5.5.17--地平线贡献按云潜力条件化方案.md
// The candidate must beat a lines-only recalibration (L0): both sides select their own grade lines in each training fold.
import { productPolicy } from '../product-evaluation/policy.mjs';
import { P0_POOLED_POLICY } from './p0-features.mjs';
import { primaryLast, aucEvaluator, bootstrapInterval } from './p0-diagnostics.mjs';

const freeze = value => Object.freeze(value);
export const HP_POLICY = freeze({
  practical_tuning_schema_version: 14, practical_tuning_policy_version: 14, search_space: 'horizon-potential',
  usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  pools: P0_POOLED_POLICY.pools, h3_first_date: P0_POOLED_POLICY.h3_first_date, live_parity_model_versions: P0_POOLED_POLICY.live_parity_model_versions,
  baseline: 'RELEASE_LINE_2.5.5.11',
  grid: freeze({ f: freeze([0.3, 0.5, 0.7]), k: freeze([15, 25, 35]) }), radius_km: 100, canvas_zero_floor_ramp_pct: 10,
  lines: freeze({ current: freeze([19, 49, 66, 90]), a: freeze([10, 35]), b: freeze([35, 65]), c: freeze([55, 80]), d: 90,
    ge2_recall_floor: 0.65, ge3_recall_floor: 0.20 }),
  folds: freeze([5, 11]),
  bootstrap: P0_POOLED_POLICY.bootstrap,
  auc_drop_tolerance: 0.02, clear_sky_t_avg_below: 20,
  families: freeze({ A: 'HA', B: 'HB', C: 'HC' }),
  decision_rules_version: 1
});

export const gridKeys = (family, policy = HP_POLICY) => policy.grid.f.flatMap(f => policy.grid.k.map(k => `${family}_f${f}_k${k}`));
export const gridParams = key => { const m = /_f([\d.]+)_k(\d+)$/.exec(key); return { f: Number(m[1]), k: Number(m[2]) }; };
/** Scoring config for a variant (HA / HB); HC is a post-process of HA (golden-window factor capped at 1 when g < 1). */
export function variantConfig(base, family, f, k, policy = HP_POLICY) {
  const config = structuredClone(base);
  config.horizonCloudPotential = { f, k, radiusKm: policy.radius_km };
  if (family === 'HB') config.canvasZeroFloor = { rampPct: policy.canvas_zero_floor_ramp_pct };
  return config;
}

// ---------- metrics on (row, predicted ordinal) with Event-normalized weights ----------
const LOSS = productPolicy().loss_matrix;
export const grade = (score, lines) => lines.filter(v => score >= v).length;
function cube(rows, key) {
  const H = Array.from({ length: 102 }, () => new Float64Array(5));
  for (const r of rows) H[r.scores[key] + 1][r.gt_ordinal] += r.weight;
  for (let s = 1; s < 102; s++) for (let g = 0; g < 5; g++) H[s][g] += H[s - 1][g];
  return H;
}
function fast(H, [a, b, c, d]) {
  const edges = [0, a, b, c, d, 101];
  let loss = 0, W = 0, tp2 = 0, pos2 = 0, tp3 = 0, pos3 = 0;
  for (let o = 0; o < 5; o++) for (let g = 0; g < 5; g++) {
    const w = H[edges[o + 1]][g] - H[edges[o]][g];
    W += w; loss += w * LOSS[o][g];
    if (g >= 2) { pos2 += w; if (o >= 2) tp2 += w; }
    if (g >= 3) { pos3 += w; if (o >= 3) tp3 += w; }
  }
  return { loss: loss / W, ge2_recall: pos2 ? tp2 / pos2 : null, ge3_recall: pos3 ? tp3 / pos3 : null };
}
/** V2.5.5.11 rule: lowest product loss with ≥2 recall ≥ floor and ≥3 recall ≥ floor; ties → closest to the current lines. */
export function selectLines(rows, key, policy = HP_POLICY) {
  const H = cube(rows, key), L = policy.lines, cur = L.current;
  let best = null;
  for (let a = L.a[0]; a <= L.a[1]; a++) for (let b = Math.max(L.b[0], a + 1); b <= L.b[1]; b++) for (let c = Math.max(L.c[0], b + 1); c <= L.c[1]; c++) {
    const m = fast(H, [a, b, c, L.d]);
    if (m.ge2_recall == null || m.ge2_recall < L.ge2_recall_floor || m.ge3_recall == null || m.ge3_recall < L.ge3_recall_floor) continue;
    const dist = Math.abs(a - cur[0]) + Math.abs(b - cur[1]) + Math.abs(c - cur[2]);
    if (!best || m.loss < best.loss - 1e-12 || (Math.abs(m.loss - best.loss) <= 1e-12 && dist < best.dist)) best = { lines: [a, b, c, L.d], loss: m.loss, dist };
  }
  return best ? { lines: best.lines, train_loss: best.loss } : null;
}
/** Pick the grid member with the lowest training loss after its own line selection (ties → grid order). */
export function selectVariant(rows, keys, policy = HP_POLICY) {
  let best = null;
  for (const key of keys) {
    const s = selectLines(rows, key, policy);
    if (s && (!best || s.train_loss < best.train_loss - 1e-12)) best = { key, ...s };
  }
  return best;
}
export function summarize(list, ord) {
  const W = list.reduce((s, r) => s + r.weight, 0), sum = fn => list.reduce((s, r) => s + r.weight * fn(r), 0);
  const tp = t => sum(r => Number(r.gt_ordinal >= t && ord(r) >= t)), pos = t => sum(r => Number(r.gt_ordinal >= t)), pred = t => sum(r => Number(ord(r) >= t));
  const q = v => Number.isFinite(v) ? Number(v.toFixed(6)) : null;
  return { product_loss: q(sum(r => LOSS[ord(r)][r.gt_ordinal]) / W), ge2_recall: q(tp(2) / pos(2)), ge2_precision: q(tp(2) / pred(2)),
    ge3_recall: q(tp(3) / pos(3)), ge3_precision: q(tp(3) / pred(3)), bias: q(sum(r => ord(r) - r.gt_ordinal) / W), predicted_ge2_share: q(pred(2) / W) };
}

// ---------- cross-validation ----------
const datesOf = rows => [...new Set(rows.map(r => r.event_date_local))].sort();
export const foldsOf = (rows, k) => { const d = datesOf(rows); return Array.from({ length: k }, (_, i) => d.slice(Math.floor(i * d.length / k), Math.floor((i + 1) * d.length / k))); };
/** For each fold: L0 = C0 with lines chosen on the training dates; X = family grid member + its lines chosen on the training dates. */
export function crossValidate(rows, k, familyKeys, policy = HP_POLICY) {
  const folds = [], assign = new Map();
  for (const fold of foldsOf(rows, k)) {
    const held = new Set(fold), train = rows.filter(r => !held.has(r.event_date_local));
    const l0 = selectLines(train, 'C0', policy), x = selectVariant(train, familyKeys, policy);
    if (!l0 || !x) throw Object.assign(new Error('HP_NO_FEASIBLE_LINES'), { code: 'HP_NO_FEASIBLE_LINES' });
    folds.push({ dates: [fold[0], fold.at(-1)], L0_lines: l0.lines, variant: x.key, variant_lines: x.lines });
    for (const d of fold) assign.set(d, { L0: l0.lines, key: x.key, lines: x.lines });
  }
  const list = rows.map(r => { const a = assign.get(r.event_date_local);
    return { ...r, ordL0: grade(r.scores.C0, a.L0), ordX: grade(r.scores[a.key], a.lines), scoreX: r.scores[a.key], keyX: a.key }; });
  return { folds, list };
}
const lossOf = (list, field) => w => { let n = 0, d = 0; list.forEach((r, i) => { n += w[i] * LOSS[r[field]][r.gt_ordinal]; d += w[i]; }); return d ? n / d : null; };
const recallOf = (list, field) => w => { let n = 0, d = 0; list.forEach((r, i) => { if (r.gt_ordinal >= 2) { d += w[i]; if (r[field] >= 2) n += w[i]; } }); return d ? n / d : null; };
export function compareCv(cv, label, policy = HP_POLICY, a = 'ordX', b = 'ordL0') {
  const list = cv.list, w = list.map(r => r.weight), diff = (f, g) => x => { const u = f(x), v = g(x); return u == null || v == null ? null : u - v; };
  return { candidate: summarize(list, r => r[a]), reference: summarize(list, r => r[b]),
    loss_delta: bootstrapInterval(list, w, `V25517|${label}|loss`, diff(lossOf(list, a), lossOf(list, b)), policy.bootstrap),
    ge2_recall_delta: bootstrapInterval(list, w, `V25517|${label}|r2`, diff(recallOf(list, a), recallOf(list, b)), policy.bootstrap) };
}
/** Ranking without lines: out-of-fold candidate score vs C0 score, PRIMARY_LAST, GT-confidence weights. */
export function aucDelta(cv, label, policy = HP_POLICY) {
  const pl = primaryLast(cv.list), w = pl.map(r => r.gt_confidence), out = {};
  for (const t of [2, 3]) {
    const pos = pl.map(r => r.gt_ordinal >= t), x = aucEvaluator(pl.map(r => r.scoreX), pos), c = aucEvaluator(pl.map(r => r.scores.C0), pos);
    out[`auc_ge${t}`] = { candidate: x(w), C0: c(w), delta: bootstrapInterval(pl, w, `V25517|${label}|auc${t}`, v => { const p = x(v), q = c(v); return p == null || q == null ? null : p - q; }, policy.bootstrap) };
  }
  return out;
}
export function crossPeriod(rows, trainPools, testPools, familyKeys, policy = HP_POLICY) {
  const train = rows.filter(r => trainPools.includes(r.pool)), test = rows.filter(r => testPools.includes(r.pool));
  const l0 = selectLines(train, 'C0', policy), x = selectVariant(train, familyKeys, policy);
  if (!l0 || !x) return { train: trainPools, test: testPools, feasible: false };
  return { train: trainPools, test: testPools, feasible: true, L0_lines: l0.lines, variant: x.key, variant_lines: x.lines,
    L0: summarize(test, r => grade(r.scores.C0, l0.lines)), candidate: summarize(test, r => grade(r.scores[x.key], x.lines)) };
}
// Report-only breakdowns of an out-of-fold list.
export function breakdowns(cv, policy = HP_POLICY) {
  const by = (key, fn) => Object.fromEntries([...new Set(cv.list.map(fn))].sort().map(k => { const s = cv.list.filter(r => fn(r) === k);
    return [k, { snapshots: s.length, L0: summarize(s, r => r.ordL0), candidate: summarize(s, r => r.ordX) }]; }));
  const clear = cv.list.filter(r => Number.isFinite(r.t_avg) && r.t_avg < policy.clear_sky_t_avg_below);
  const ge2Missed = (s, f) => s.filter(r => r.gt_ordinal >= 2 && r[f] <= 1).length, fa = (s, f) => s.filter(r => r.gt_ordinal <= 1 && r[f] >= 2).length;
  return { by_pool: by('pool', r => r.pool), by_slot: by('slot', r => r.slot),
    clear_sky: { snapshots: clear.length, events: new Set(clear.map(r => r.event_id)).size, gt_ge2: clear.filter(r => r.gt_ordinal >= 2).length,
      L0: { ...summarize(clear, r => r.ordL0), false_alarm_snapshots: fa(clear, 'ordL0'), missed_ge2_snapshots: ge2Missed(clear, 'ordL0') },
      candidate: { ...summarize(clear, r => r.ordX), false_alarm_snapshots: fa(clear, 'ordX'), missed_ge2_snapshots: ge2Missed(clear, 'ordX') } },
    chosen_variants: cv.list.reduce((m, r) => (m[r.keyX] = (m[r.keyX] || 0) + 1, m), {}) };
}

// ---------- full evaluation and §5 / §6 decision ----------
export function evaluateAll(rows, policy = HP_POLICY) {
  const keysA = gridKeys('HA', policy), keysB = gridKeys('HB', policy), keysC = gridKeys('HC', policy);
  const current = summarize(rows, r => grade(r.scores.C0, policy.lines.current));
  const cvA5 = crossValidate(rows, 5, keysA, policy), cvA11 = crossValidate(rows, 11, keysA, policy);
  const A = { cv5: { folds: cvA5.folds, ...compareCv(cvA5, 'A5', policy) }, cv11: { folds: cvA11.folds, ...compareCv(cvA11, 'A11', policy) },
    auc: aucDelta(cvA5, 'A5', policy),
    cross_period: [crossPeriod(rows, ['DEV'], ['H1', 'H2'], keysA, policy), crossPeriod(rows, ['H1', 'H2'], ['DEV'], keysA, policy)],
    report: breakdowns(cvA5, policy), full_data_choice: selectVariant(rows, keysA, policy), L0_full_data_lines: selectLines(rows, 'C0', policy)?.lines ?? null };
  const g = {
    G1_loss_vs_L0_upper_below_0: A.cv5.loss_delta.status === 'COMPUTED' && A.cv5.loss_delta.ci95[1] < 0,
    G2_ge2_recall_cv5_cv11_at_floor: A.cv5.candidate.ge2_recall >= policy.lines.ge2_recall_floor && A.cv11.candidate.ge2_recall >= policy.lines.ge2_recall_floor,
    G3_cross_period_both_lower: A.cross_period.every(c => c.feasible && c.candidate.product_loss < c.L0.product_loss),
    G4_auc_ge2_lower_above_minus_tolerance: A.auc.auc_ge2.delta.status === 'COMPUTED' && A.auc.auc_ge2.delta.ci95[0] > -policy.auc_drop_tolerance
  };
  const worth = Object.values(g).every(Boolean);
  const linesHelp = A.cv5.reference.product_loss < current.product_loss;
  // §6: secondary variants against H-A, same 5-fold procedure; only decisive when H-A is WORTH_H3.
  const secondary = {};
  for (const [name, keys] of [['B', keysB], ['C', keysC]]) {
    const cv = crossValidate(rows, 5, keys, policy), cvA = cvA5;
    const list = cv.list.map((r, i) => ({ ...r, ordA: cvA.list[i].ordX }));
    const cmp = compareCv({ list }, `${name}vsA5`, policy, 'ordX', 'ordA');
    secondary[name] = { folds: cv.folds, versus_A: cmp, versus_L0: compareCv(cv, `${name}5`, policy),
      further_improvement: worth && cmp.loss_delta.status === 'COMPUTED' && cmp.loss_delta.ci95[1] < 0 };
  }
  const recommended = !worth ? null : secondary.B.further_improvement && secondary.C.further_improvement
    ? (secondary.B.versus_A.candidate.product_loss <= secondary.C.versus_A.candidate.product_loss ? 'H-A+B' : 'H-A+C')
    : secondary.B.further_improvement ? 'H-A+B' : secondary.C.further_improvement ? 'H-A+C' : 'H-A';
  return { current_lines_C0: current, A, gates: g,
    decision: worth ? 'WORTH_H3' : linesHelp ? 'LINES_SUFFICIENT' : 'NO_GAIN', recommended_combination: recommended, secondary,
    rules_version: policy.decision_rules_version, requires_owner_confirmation: true, role: 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE' };
}
