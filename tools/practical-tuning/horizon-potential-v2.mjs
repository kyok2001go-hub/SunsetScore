// V2.5.5.18 horizon conditioning, second version (Practical Tuning Schema/Policy 15): frozen plan and pure evaluation.
// PRD: ref_docs/PRD/V2.5.5.18--地平线条件化第二版与评估口径调整方案.md
// One fixed candidate (f 0.7, k 5) against a lines-only recalibration (L0). Differences from Policy 14: no parameter
// selection inside folds; the ≥2 recall floor is counted on cloud-type good sunsets (Events the photo review tagged as
// clear-sky glow are exempt); an overall ≥2 recall floor of 0.60 is added; a line-free Brier comparison backs up G1.
import { productPolicy } from '../product-evaluation/policy.mjs';
import { fail } from '../dataset/lib/common.mjs';
import { P0_POOLED_POLICY } from './p0-features.mjs';
import { primaryLast, aucEvaluator, bootstrapInterval } from './p0-diagnostics.mjs';
import { fitLogistic } from './p0-probe.mjs';
import { digest } from './policy.mjs';
import { grade, summarize, foldsOf } from './horizon-potential.mjs';

const freeze = value => Object.freeze(value);
export const HP2_POLICY = freeze({
  practical_tuning_schema_version: 15, practical_tuning_policy_version: 15, search_space: 'horizon-potential-v2',
  usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  pools: P0_POOLED_POLICY.pools, h3_first_date: P0_POOLED_POLICY.h3_first_date, live_parity_model_versions: P0_POOLED_POLICY.live_parity_model_versions,
  baseline: 'RELEASE_LINE_2.5.5.11',
  candidate: freeze({ f: 0.7, k: 5 }), radius_km: 100,
  // Report-only point estimates; none of them may replace the candidate.
  sensitivity: freeze([freeze({ f: 0.7, k: 3 }), freeze({ f: 0.7, k: 8 }), freeze({ f: 0.5, k: 5 })]),
  lines: freeze({ current: freeze([19, 49, 66, 90]), a: freeze([10, 35]), b: freeze([35, 65]), c: freeze([55, 80]), d: 90,
    ge2_recall_floor: 0.65, ge2_recall_scope: 'CLOUD_TYPE', ge3_recall_floor: 0.20, overall_ge2_recall_floor: 0.60 }),
  folds: freeze([5, 11]),
  bootstrap: P0_POOLED_POLICY.bootstrap,
  auc_drop_tolerance: 0.02, clear_sky_t_avg_below: 20, low_potential_below: 5,
  // Photo review of 2026-11-17 (44 Events). Not ground truth: labels are untouched, the table only scopes the ≥2 recall floor.
  review: freeze({ file: 'tools/practical-tuning/data/clear-sky-review-v1.json', content_sha256: '4e2691102c5426460cb8958bb2cf9cb1b650d69af2c845816f8b289e8bb7105f',
    events: 44, kinds: freeze(['LIT_CLOUD', 'FAR_HORIZON', 'CLEAR_GLOW']), exempt_kind: 'CLEAR_GLOW' }),
  brier: freeze({ cohort: 'PRIMARY_LAST', weights: 'GT_CONFIDENCE', target: 'GT_GE2', model: 'LOGISTIC_ON_TRAIN_STANDARDIZED_SCORE',
    logistic: freeze({ lambda: 0, max_iterations: 100, tolerance: 1e-10 }) }),
  // §4.1: where g(C) does not depend on k (C = 0 or C ≥ 15) the candidate must equal the V2.5.5.17 Run's HA_f0.7_k15 score.
  reference: freeze({ run_id: 'practical_tuning_v14_1e9a94ef82985c4b19c0', f: 0.7, k: 15, k_independent_at_or_above: 15,
    signature_sha256: '35fa343b41510e94200e56b65b267ed1ef338b2b1773b36360a131fc706c4a28' }),
  decision_rules_version: 1
});

export const keyOf = ({ f, k }) => `HA_f${f}_k${k}`;
export function variantConfig(base, { f, k }, policy = HP2_POLICY) {
  const config = structuredClone(base);
  config.horizonCloudPotential = { f, k, radiusKm: policy.radius_km };
  return config;
}

// ---------- photo review table ----------
/** Validates the frozen table against the loaded rows and tags every row with its Event's review kind. */
export function attachReview(rows, table, policy = HP2_POLICY) {
  if (!table || digest(table) !== policy.review.content_sha256) fail('HP2_REVIEW_TABLE_HASH_MISMATCH');
  const events = new Map();
  for (const r of rows) if (!events.has(r.event_id)) events.set(r.event_id, r);
  const kinds = new Map();
  for (const e of table.events) {
    const row = events.get(e.event_id);
    if (!policy.review.kinds.includes(e.kind) || kinds.has(e.event_id)) fail('HP2_REVIEW_TABLE_INVALID', { detail: e.event_id });
    if (!row || row.event_date_local !== e.event_date_local || row.gt_ordinal !== e.gt_ordinal || !(row.gt_ordinal >= 2)) fail('HP2_REVIEW_EVENT_MISMATCH', { detail: e.event_id });
    kinds.set(e.event_id, e.kind);
  }
  if (kinds.size !== policy.review.events) fail('HP2_REVIEW_TABLE_INVALID');
  return rows.map(r => { const kind = kinds.get(r.event_id) ?? null; return { ...r, review_kind: kind, recall_exempt: kind === policy.review.exempt_kind }; });
}

// ---------- line selection ----------
const LOSS = productPolicy().loss_matrix;
function cubes(rows, key) {
  const make = () => Array.from({ length: 102 }, () => new Float64Array(5)), all = make(), cloud = make();
  for (const r of rows) { all[r.scores[key] + 1][r.gt_ordinal] += r.weight; if (!r.recall_exempt) cloud[r.scores[key] + 1][r.gt_ordinal] += r.weight; }
  for (const H of [all, cloud]) for (let s = 1; s < 102; s++) for (let g = 0; g < 5; g++) H[s][g] += H[s - 1][g];
  return { all, cloud };
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
/**
 * V2.5.5.11 rule (lowest product loss with the recall floors; ties → closest to the current lines). `scope` chooses which
 * Events the ≥2 recall floor counts: 'CLOUD_TYPE' leaves out recall-exempt rows, 'ALL' is the Policy 14 rule.
 * Loss and the ≥3 floor always use every row.
 */
export function selectLines(rows, key, policy = HP2_POLICY, scope = policy.lines.ge2_recall_scope) {
  const { all, cloud } = cubes(rows, key), L = policy.lines, cur = L.current;
  let best = null;
  for (let a = L.a[0]; a <= L.a[1]; a++) for (let b = Math.max(L.b[0], a + 1); b <= L.b[1]; b++) for (let c = Math.max(L.c[0], b + 1); c <= L.c[1]; c++) {
    const lines = [a, b, c, L.d], m = fast(all, lines), ge2 = scope === 'ALL' ? m.ge2_recall : fast(cloud, lines).ge2_recall;
    if (ge2 == null || ge2 < L.ge2_recall_floor || m.ge3_recall == null || m.ge3_recall < L.ge3_recall_floor) continue;
    const dist = Math.abs(a - cur[0]) + Math.abs(b - cur[1]) + Math.abs(c - cur[2]);
    if (!best || m.loss < best.loss - 1e-12 || (Math.abs(m.loss - best.loss) <= 1e-12 && dist < best.dist)) best = { lines, loss: m.loss, dist };
  }
  return best ? { lines: best.lines, train_loss: best.loss } : null;
}

// ---------- metrics ----------
const q = v => Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const rate = (list, den, num) => w => { let d = 0, n = 0; list.forEach((r, i) => { if (den(r)) { d += w[i]; if (num(r)) n += w[i]; } }); return d ? n / d : null; };
const weights = list => list.map(r => r.weight);
/** Policy 14 summary plus the cloud-type ≥2 recall (floor scope) and the false-alarm rate P(predicted ≥ 2 | GT ≤ 1). */
export function summarize2(list, ord) {
  const w = weights(list);
  return { ...summarize(list, ord), ge2_recall_cloud_type: q(rate(list, r => r.gt_ordinal >= 2 && !r.recall_exempt, r => ord(r) >= 2)(w)),
    false_alarm_rate: q(rate(list, r => r.gt_ordinal <= 1, r => ord(r) >= 2)(w)) };
}
const lossOf = (list, field) => w => { let n = 0, d = 0; list.forEach((r, i) => { n += w[i] * LOSS[r[field]][r.gt_ordinal]; d += w[i]; }); return d ? n / d : null; };
const diff = (f, g) => x => { const u = f(x), v = g(x); return u == null || v == null ? null : u - v; };

// ---------- cross-validation ----------
/** Per fold, on the training dates only: lines for L0 (C0 score), the candidate, L0 under the Policy 14 rule, and each sensitivity member. */
export function crossValidate(rows, k, policy = HP2_POLICY) {
  const cand = keyOf(policy.candidate), sens = policy.sensitivity.map(keyOf), folds = [], assign = new Map();
  for (const fold of foldsOf(rows, k)) {
    const held = new Set(fold), train = rows.filter(r => !held.has(r.event_date_local));
    const pick = (key, scope) => { const s = selectLines(train, key, policy, scope); if (!s) throw Object.assign(new Error('HP2_NO_FEASIBLE_LINES'), { code: 'HP2_NO_FEASIBLE_LINES' }); return s.lines; };
    const a = { L0: pick('C0'), A2: pick(cand), L0old: pick('C0', 'ALL'), S: Object.fromEntries(sens.map(key => [key, pick(key)])) };
    folds.push({ dates: [fold[0], fold.at(-1)], L0_lines: a.L0, A2_lines: a.A2, L0_old_rule_lines: a.L0old, sensitivity_lines: a.S });
    for (const d of fold) assign.set(d, a);
  }
  const list = rows.map(r => { const a = assign.get(r.event_date_local);
    return { ...r, ordL0: grade(r.scores.C0, a.L0), ordA2: grade(r.scores[cand], a.A2), ordL0old: grade(r.scores.C0, a.L0old),
      ordS: Object.fromEntries(sens.map(key => [key, grade(r.scores[key], a.S[key])])) }; });
  return { folds, list };
}
export function compareCv(cv, label, policy = HP2_POLICY) {
  const list = cv.list, w = weights(list), boot = (name, fn) => bootstrapInterval(list, w, `V25518|${label}|${name}`, fn, policy.bootstrap);
  const cloud = field => rate(list, r => r.gt_ordinal >= 2 && !r.recall_exempt, r => r[field] >= 2), overall = field => rate(list, r => r.gt_ordinal >= 2, r => r[field] >= 2);
  return { candidate: summarize2(list, r => r.ordA2), reference: summarize2(list, r => r.ordL0),
    loss_delta: boot('loss', diff(lossOf(list, 'ordA2'), lossOf(list, 'ordL0'))),
    ge2_recall_cloud_type_delta: boot('r2c', diff(cloud('ordA2'), cloud('ordL0'))),
    ge2_recall_delta: boot('r2', diff(overall('ordA2'), overall('ordL0'))) };
}
/** Ranking without lines: candidate score vs C0 score, PRIMARY_LAST, GT-confidence weights. */
export function aucDelta(rows, label, policy = HP2_POLICY) {
  const cand = keyOf(policy.candidate), pl = primaryLast(rows), w = pl.map(r => r.gt_confidence), out = {};
  for (const t of [2, 3]) {
    const pos = pl.map(r => r.gt_ordinal >= t), x = aucEvaluator(pl.map(r => r.scores[cand]), pos), c = aucEvaluator(pl.map(r => r.scores.C0), pos);
    out[`auc_ge${t}`] = { candidate: x(w), C0: c(w), delta: bootstrapInterval(pl, w, `V25518|${label}|auc${t}`, diff(x, c), policy.bootstrap) };
  }
  return out;
}
const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
/**
 * Line-free comparison: per fold, P(GT ≥ 2) = logistic(a + b·score) is fitted on the training dates (PRIMARY_LAST Events,
 * GT-confidence weights, score standardized on the training fold) and scored on the held-out dates by Brier = mean (p − y)².
 */
export function brierCv(rows, k, label, policy = HP2_POLICY) {
  const cand = keyOf(policy.candidate), pl = primaryLast(rows), index = new Map(pl.map((r, i) => [r.snapshot_id, i]));
  const error = { C0: Array(pl.length).fill(null), [cand]: Array(pl.length).fill(null) };
  for (const fold of foldsOf(rows, k)) {
    const held = new Set(fold), train = pl.filter(r => !held.has(r.event_date_local)), test = pl.filter(r => held.has(r.event_date_local));
    for (const key of ['C0', cand]) {
      const v = train.map(r => r.scores[key]), mean = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
      if (!(sd > 0)) fail('HP2_BRIER_CONSTANT_SCORE');
      const fit = fitLogistic(train.map(r => [(r.scores[key] - mean) / sd]), train.map(r => r.gt_ordinal >= 2 ? 1 : 0), train.map(r => r.gt_confidence), policy.brier.logistic);
      if (!fit.converged) fail('HP2_BRIER_LOGISTIC_NOT_CONVERGED');
      for (const r of test) error[key][index.get(r.snapshot_id)] = (sigmoid(fit.beta[0] + fit.beta[1] * (r.scores[key] - mean) / sd) - (r.gt_ordinal >= 2 ? 1 : 0)) ** 2;
    }
  }
  const w = pl.map(r => r.gt_confidence), mean = values => x => { let n = 0, d = 0; values.forEach((e, i) => { n += x[i] * e; d += x[i]; }); return d ? n / d : null; };
  const a = mean(error[cand]), c = mean(error.C0);
  return { events: pl.length, candidate: q(a(w)), C0: q(c(w)), delta: bootstrapInterval(pl, w, `V25518|${label}|brier`, diff(a, c), policy.bootstrap) };
}
export function crossPeriod(rows, trainPools, testPools, policy = HP2_POLICY) {
  const cand = keyOf(policy.candidate), train = rows.filter(r => trainPools.includes(r.pool)), test = rows.filter(r => testPools.includes(r.pool));
  const l0 = selectLines(train, 'C0', policy), x = selectLines(train, cand, policy);
  if (!l0 || !x) return { train: trainPools, test: testPools, feasible: false };
  return { train: trainPools, test: testPools, feasible: true, L0_lines: l0.lines, A2_lines: x.lines,
    L0: summarize2(test, r => grade(r.scores.C0, l0.lines)), candidate: summarize2(test, r => grade(r.scores[cand], x.lines)) };
}

// ---------- report-only breakdowns of an out-of-fold list (§6) ----------
export function breakdowns(cv, policy = HP2_POLICY) {
  const list = cv.list, pair = s => ({ snapshots: s.length, events: new Set(s.map(r => r.event_id)).size, L0: summarize2(s, r => r.ordL0), candidate: summarize2(s, r => r.ordA2) });
  const by = fn => Object.fromEntries([...new Set(list.map(fn))].sort().map(k => [k, pair(list.filter(r => fn(r) === k))]));
  const missed = (s, f) => s.filter(r => r.gt_ordinal >= 2 && r[f] <= 1).length, fa = (s, f) => s.filter(r => r.gt_ordinal <= 1 && r[f] >= 2).length;
  const sub = s => ({ snapshots: s.length, events: new Set(s.map(r => r.event_id)).size, gt_ge2_snapshots: s.filter(r => r.gt_ordinal >= 2).length,
    L0: { ...summarize2(s, r => r.ordL0), false_alarm_snapshots: fa(s, 'ordL0'), missed_ge2_snapshots: missed(s, 'ordL0') },
    candidate: { ...summarize2(s, r => r.ordA2), false_alarm_snapshots: fa(s, 'ordA2'), missed_ge2_snapshots: missed(s, 'ordA2') } });
  // Review groups are Event-level; the unreviewed group is GT ≥ 2 Events whose decision Snapshot has C below the threshold.
  const lowLast = new Set(primaryLast(list).filter(r => r.gt_ordinal >= 2 && r.review_kind === null && Number.isFinite(r.cloud_potential) && r.cloud_potential < policy.low_potential_below).map(r => r.event_id));
  const group = s => { const w = weights(s), recall = f => q(rate(s, () => true, r => r[f] >= 2)(w));
    return { events: new Set(s.map(r => r.event_id)).size, snapshots: s.length, L0_ge2_recall: recall('ordL0'), candidate_ge2_recall: recall('ordA2'),
      L0_missed_snapshots: missed(s, 'ordL0'), candidate_missed_snapshots: missed(s, 'ordA2') }; };
  return { by_pool: by(r => r.pool), by_slot: by(r => r.slot),
    low_potential: sub(list.filter(r => Number.isFinite(r.cloud_potential) && r.cloud_potential < policy.low_potential_below)),
    clear_sky: sub(list.filter(r => Number.isFinite(r.t_avg) && r.t_avg < policy.clear_sky_t_avg_below)),
    by_review: { ...Object.fromEntries(policy.review.kinds.map(k => [k, group(list.filter(r => r.review_kind === k))])),
      UNREVIEWED_LOW_POTENTIAL_GOOD: group(list.filter(r => lowLast.has(r.event_id))) } };
}

// ---------- full evaluation and §5 decision ----------
export function evaluateAll(rows, policy = HP2_POLICY) {
  const cand = keyOf(policy.candidate), L = policy.lines;
  const current = summarize2(rows, r => grade(r.scores.C0, L.current));
  const cv5 = crossValidate(rows, 5, policy), cv11 = crossValidate(rows, 11, policy);
  const A = { cv5: { folds: cv5.folds, ...compareCv(cv5, 'A5', policy) }, cv11: { folds: cv11.folds, ...compareCv(cv11, 'A11', policy) },
    auc: aucDelta(rows, 'A', policy), brier: { cv5: brierCv(rows, 5, 'A5', policy), cv11: brierCv(rows, 11, 'A11', policy) },
    cross_period: [crossPeriod(rows, ['DEV'], ['H1', 'H2'], policy), crossPeriod(rows, ['H1', 'H2'], ['DEV'], policy)],
    report: breakdowns(cv5, policy),
    full_data_lines: { L0: selectLines(rows, 'C0', policy)?.lines ?? null, A2: selectLines(rows, cand, policy)?.lines ?? null, L0_old_rule: selectLines(rows, 'C0', policy, 'ALL')?.lines ?? null } };
  const upperBelow0 = x => x.status === 'COMPUTED' && x.ci95[1] < 0, floors = (field, floor) => A.cv5.candidate[field] >= floor && A.cv11.candidate[field] >= floor;
  const g1a = upperBelow0(A.cv5.loss_delta), g1b = A.cv5.loss_delta.point < 0 && A.cv11.loss_delta.point < 0 && upperBelow0(A.brier.cv5.delta);
  const gates = {
    G1_better_than_L0: g1a || g1b,
    G2_cloud_type_ge2_recall_cv5_cv11_at_floor: floors('ge2_recall_cloud_type', L.ge2_recall_floor),
    G3_cross_period_both_lower: A.cross_period.every(c => c.feasible && c.candidate.product_loss < c.L0.product_loss),
    G4_auc_ge2_lower_above_minus_tolerance: A.auc.auc_ge2.delta.status === 'COMPUTED' && A.auc.auc_ge2.delta.ci95[0] > -policy.auc_drop_tolerance,
    G5_overall_ge2_recall_cv5_cv11_at_floor: floors('ge2_recall', L.overall_ge2_recall_floor)
  };
  const worth = Object.values(gates).every(Boolean), linesHelp = A.cv5.reference.product_loss < current.product_loss;
  // §6, report only.
  const reportOnly = {
    A2_current_lines: summarize2(rows, r => grade(r.scores[cand], L.current)),
    L0_old_rule: { cv5: summarize2(cv5.list, r => r.ordL0old), cv11: summarize2(cv11.list, r => r.ordL0old) },
    sensitivity: Object.fromEntries(policy.sensitivity.map(keyOf).map(key => {
      const s5 = summarize2(cv5.list, r => r.ordS[key]), s11 = summarize2(cv11.list, r => r.ordS[key]);
      return [key, { cv5: s5, cv11: s11, cv5_loss_delta_vs_L0: q(s5.product_loss - A.cv5.reference.product_loss), cv11_loss_delta_vs_L0: q(s11.product_loss - A.cv11.reference.product_loss) }];
    }))
  };
  return { current_lines_C0: current, A, gates, G1_paths: { loss_interval_upper_below_0: g1a, both_points_below_0_and_brier_upper_below_0: g1b },
    decision: worth ? 'WORTH_H3' : !gates.G1_better_than_L0 && linesHelp ? 'LINES_SUFFICIENT' : 'NO_GAIN', report_only: reportOnly,
    rules_version: policy.decision_rules_version, requires_owner_confirmation: true, role: 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE' };
}
