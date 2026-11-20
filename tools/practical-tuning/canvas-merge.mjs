// V2.5.5.31 sky-canvas / illumination merge (Practical Tuning Schema/Policy 19): frozen plan and pure evaluation.
// PRD: ref_docs/PRD/V2.5.5.31--云幕与光照组件合并方案.md
// One default-off engine key, canvasMerge = { skyCanvasShare: s, scale: k, twilightFloor: null | f }:
//   Canvas = k × [s × SkyCanvas + (1 − s) × cloudBankPotential × dataFactor]  (× f + (1 − f) × twilight ratio when f is set),
//   weight = the sum of the two dynamic weights; illumination weight 0.
// The primary member M1 is compared with C0 (2.5.5.19) at the current lines 19 / 49 / 66 / 90 by a non-inferiority rule (N1–N4);
// no lines are selected and no parameter is tuned. Everything else is report only.
import { fail } from '../dataset/lib/common.mjs';
import { primaryLast, aucEvaluator, bootstrapInterval } from './p0-diagnostics.mjs';
import { grade, foldsOf } from './horizon-potential.mjs';
import { HP2_POLICY, selectLines, summarize2 } from './horizon-potential-v2.mjs';
import { compareCv } from './penalty-weights.mjs';
import { SD_POLICY } from './structure-direction.mjs';
import { productPolicy } from '../product-evaluation/policy.mjs';

const freeze = value => Object.freeze(value);
const member = (role, skyCanvasShare, scale, twilightFloor = null) => freeze({ role, canvasMerge: freeze({ skyCanvasShare, scale, twilightFloor }) });
export const CM_POLICY = freeze({
  practical_tuning_schema_version: 19, practical_tuning_policy_version: 19, search_space: 'canvas-merge',
  usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  pools: HP2_POLICY.pools, h3_first_date: HP2_POLICY.h3_first_date, live_parity_model_versions: HP2_POLICY.live_parity_model_versions,
  baseline: 'RELEASE_LINE_2.5.5.19', baseline_reference: SD_POLICY.baseline_reference,
  members: freeze({
    M1: member('PRIMARY', 1 / 3, 0.885),
    M1L: member('REPORT_ONLY', 1 / 3, 0.855),
    M2: member('REPORT_ONLY', 1 / 3, 1),
    M3: member('REPORT_ONLY', 1 / 3, 1, 0.53),
    M4: member('REPORT_ONLY', 0, 0.885)
  }),
  primary: 'M1',
  // Non-inferiority at the current lines (§6). Recall floors are the V2.5.5.24 G5 / G2 floors.
  rule: freeze({ lines: HP2_POLICY.lines.current, n1_auc_ge2_lower_above: -0.01, n2_auc_ge3_lower_above: -0.02,
    n3_loss_point_at_most: 0.03, n3_loss_upper_below: 0.05, n4_recall_drop_at_most: 0.01,
    n4_overall_ge2_recall_floor: 0.60, n4_cloud_type_ge2_recall_floor: 0.65 }),
  // Report-only re-lining uses the V2.5.5.18 line rule and date-block folds.
  lines: HP2_POLICY.lines, review: HP2_POLICY.review, folds: HP2_POLICY.folds, bootstrap: HP2_POLICY.bootstrap,
  south_cities: freeze(['广州', '深圳', '香港', '厦门', '南宁', '昆明']),
  weight_tolerance: 1e-12,
  decision_rules_version: 1
});
export const MEMBER_KEYS = freeze(Object.keys(CM_POLICY.members));
/** Scoring config: 2.5.5.19 plus only the member's canvasMerge key. */
export function memberConfig(base, key, policy = CM_POLICY) {
  const m = policy.members[key]; if (!m) fail('CM_BAD_MEMBER_KEY', { detail: key });
  return { ...structuredClone(base), canvasMerge: { ...m.canvasMerge } };
}

const q = v => typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const LOSS = productPolicy().loss_matrix;
const rate = (list, den, num) => w => { let d = 0, n = 0; list.forEach((r, i) => { if (den(r)) { d += w[i]; if (num(r)) n += w[i]; } }); return d ? n / d : null; };
const lossOf = (list, ord) => w => { let n = 0, d = 0; list.forEach((r, i) => { n += w[i] * LOSS[ord(r)][r.gt_ordinal]; d += w[i]; }); return d ? n / d : null; };
const diff = (f, g) => x => { const u = f(x), v = g(x); return u == null || v == null ? null : u - v; };

// ---------- fixed-line comparison (§5.2, §6) ----------
/** Member vs C0 at the given lines: summaries, AUC and date-block intervals of the differences. */
export function fixedCompare(rows, key, policy = CM_POLICY, lines = policy.rule.lines) {
  const w = rows.map(r => r.weight), boot = (name, fn) => bootstrapInterval(rows, w, `V25531|${key}|${name}`, fn, policy.bootstrap);
  const X = r => grade(r.scores[key], lines), C = r => grade(r.scores.C0, lines);
  const cloud = ord => rate(rows, r => r.gt_ordinal >= 2 && !r.recall_exempt, r => ord(r) >= 2), all = ord => rate(rows, r => r.gt_ordinal >= 2, r => ord(r) >= 2);
  const ge3 = ord => rate(rows, r => r.gt_ordinal >= 3, r => ord(r) >= 3), prec = ord => rate(rows, r => ord(r) >= 2, r => r.gt_ordinal >= 2);
  const pl = primaryLast(rows), pw = pl.map(r => r.gt_confidence), auc = {};
  for (const t of [2, 3]) {
    const pos = pl.map(r => r.gt_ordinal >= t), x = aucEvaluator(pl.map(r => r.scores[key]), pos), c = aucEvaluator(pl.map(r => r.scores.C0), pos);
    auc[`auc_ge${t}`] = { candidate: q(x(pw)), C0: q(c(pw)), delta: bootstrapInterval(pl, pw, `V25531|${key}|auc${t}`, diff(x, c), policy.bootstrap) };
  }
  return { lines: [...lines], candidate: summarize2(rows, X), C0: summarize2(rows, C), ...auc,
    loss_delta: boot('loss', diff(lossOf(rows, X), lossOf(rows, C))),
    ge2_recall_delta: boot('r2', diff(all(X), all(C))), ge2_recall_cloud_type_delta: boot('r2c', diff(cloud(X), cloud(C))),
    ge3_recall_delta: boot('r3', diff(ge3(X), ge3(C))), ge2_precision_delta: boot('p2', diff(prec(X), prec(C))),
    grade_changes: rows.filter(r => X(r) !== C(r)).length };
}
/** §6: N1–N4 on the fixed-line comparison of the primary member. */
export function decide(F, policy = CM_POLICY) {
  const R = policy.rule, ok = x => x && x.status === 'COMPUTED';
  const N = {
    N1_auc_ge2_lower_above_minus_0_01: ok(F.auc_ge2.delta) && F.auc_ge2.delta.ci95[0] > R.n1_auc_ge2_lower_above,
    N2_auc_ge3_lower_above_minus_0_02: ok(F.auc_ge3.delta) && F.auc_ge3.delta.ci95[0] > R.n2_auc_ge3_lower_above,
    N3_loss_point_at_most_0_03_and_upper_below_0_05: ok(F.loss_delta) && F.loss_delta.point <= R.n3_loss_point_at_most && F.loss_delta.ci95[1] < R.n3_loss_upper_below,
    N4_recall_not_lower_by_more_than_0_01_and_floors: F.candidate.ge2_recall != null && F.candidate.ge2_recall_cloud_type != null &&
      F.candidate.ge2_recall >= F.C0.ge2_recall - R.n4_recall_drop_at_most - 1e-12 &&
      F.candidate.ge2_recall_cloud_type >= F.C0.ge2_recall_cloud_type - R.n4_recall_drop_at_most - 1e-12 &&
      F.candidate.ge2_recall >= R.n4_overall_ge2_recall_floor && F.candidate.ge2_recall_cloud_type >= R.n4_cloud_type_ge2_recall_floor
  };
  return { conditions: N, decision: Object.values(N).every(Boolean) ? 'NON_INFERIOR' : 'INFERIOR', failed: Object.keys(N).filter(k => !N[k]) };
}

// ---------- report only (§7) ----------
/** Re-lined comparison by date-block folds: per fold, lines selected on the training dates for C0 (L0) and for the member. */
export function relinedCv(rows, k, key, policy = CM_POLICY) {
  const folds = [], assign = new Map();
  for (const fold of foldsOf(rows, k)) {
    const held = new Set(fold), train = rows.filter(r => !held.has(r.event_date_local));
    const l0 = selectLines(train, 'C0', policy), x = selectLines(train, key, policy);
    if (!l0 || !x) fail('CM_NO_FEASIBLE_LINES');
    folds.push({ dates: [fold[0], fold.at(-1)], L0_lines: l0.lines, member_lines: x.lines });
    for (const d of fold) assign.set(d, { L0: l0.lines, X: x.lines });
  }
  const list = rows.map(r => { const a = assign.get(r.event_date_local); return { ...r, ordL0: grade(r.scores.C0, a.L0), ordX: grade(r.scores[key], a.X) }; });
  const c = compareCv({ folds, list }, `V25531|${key}|cv${k}`, policy);
  return { folds, candidate: c.candidate, reference: c.reference, loss_delta: c.loss_delta, ge2_recall_delta: c.ge2_recall_delta };
}
const quantile = (sorted, p) => sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null;
export function distribution(values) {
  const s = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return { n: s.length, p10: quantile(s, 0.1), p50: quantile(s, 0.5), p90: quantile(s, 0.9), min: s[0] ?? null, max: s.at(-1) ?? null };
}
/** Member and C0 at the current lines within one subgroup. */
function subgroup(list, key, lines) {
  return { snapshots: list.length, gt_ge2_snapshots: list.filter(r => r.gt_ordinal >= 2).length,
    C0: summarize2(list, r => grade(r.scores.C0, lines)), candidate: summarize2(list, r => grade(r.scores[key], lines)),
    mean_score_change: list.length ? q(list.reduce((a, r) => a + (r.scores[key] - r.scores.C0), 0) / list.length) : null };
}
export function breakdowns(rows, key, policy = CM_POLICY) {
  const lines = policy.rule.lines, by = fn => Object.fromEntries([...new Set(rows.map(fn))].sort().map(v => [v, subgroup(rows.filter(r => fn(r) === v), key, lines)]));
  return { by_pool: by(r => r.pool), by_slot: by(r => r.slot), by_region: by(r => policy.south_cities.includes(r.city) ? 'SOUTH' : 'OTHER') };
}
/** Snapshots whose grade at the current lines differs between the member and C0. */
export function gradeChanges(rows, key, policy = CM_POLICY) {
  const lines = policy.rule.lines;
  return rows.map(r => ({ r, a: grade(r.scores.C0, lines), b: grade(r.scores[key], lines) })).filter(x => x.a !== x.b)
    .map(({ r, a, b }) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, city: r.city, pool: r.pool,
      C0_score: r.scores.C0, member_score: r.scores[key], C0_grade: a, member_grade: b, gt_ordinal: r.gt_ordinal, recall_exempt: r.recall_exempt }))
    .sort((x, y) => x.event_date_local.localeCompare(y.event_date_local) || x.snapshot_id.localeCompare(y.snapshot_id));
}
export function evaluateAll(rows, policy = CM_POLICY) {
  const primary = fixedCompare(rows, policy.primary, policy), verdict = decide(primary, policy);
  const others = Object.fromEntries(MEMBER_KEYS.filter(k => k !== policy.primary).map(k => [k, fixedCompare(rows, k, policy)]));
  const relined = Object.fromEntries(['M1', 'M2'].map(k => [k, Object.fromEntries(policy.folds.map(n => [`cv${n}`, relinedCv(rows, n, k, policy)]))]));
  const crossPeriod = Object.fromEntries([['DEV', ['DEV']], ['H1_H2', ['H1', 'H2']]].map(([name, pools]) => {
    const part = rows.filter(r => pools.includes(r.pool)), F = fixedCompare(part, policy.primary, policy);
    return [name, { snapshots: part.length, candidate: F.candidate, C0: F.C0, loss_delta: F.loss_delta, ge2_recall_delta: F.ge2_recall_delta, auc_ge2: F.auc_ge2 }];
  }));
  return { primary: policy.primary, at_current_lines: primary, ...verdict, rules_version: policy.decision_rules_version,
    report_only: { members_at_current_lines: others, relined_cv: relined, cross_period: crossPeriod,
      full_data_lines: Object.fromEntries(['C0', ...MEMBER_KEYS].map(k => [k, selectLines(rows, k, policy)?.lines ?? null])),
      grade_changes: gradeChanges(rows, policy.primary, policy), breakdowns: breakdowns(rows, policy.primary, policy),
      score_distribution: Object.fromEntries(['C0', ...MEMBER_KEYS].map(k => [k, distribution(rows.map(r => r.scores[k]))])),
      m3_minus_m1l: (() => { const d = rows.map(r => r.scores.M3 - r.scores.M1L);
        return { ...distribution(d), within_1_share: q(d.filter(v => Math.abs(v) <= 1).length / d.length) }; })() },
    requires_owner_confirmation: true, role: 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE' };
}
