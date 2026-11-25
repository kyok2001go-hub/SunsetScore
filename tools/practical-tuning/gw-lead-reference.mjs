// V2.5.5.35 golden-window reference by lead time (Practical Tuning Schema/Policy 20): frozen plan and pure evaluation.
// PRD: ref_docs/PRD/V2.5.5.35--晚间黄金窗口分数水平修正方案.md
// One default-off engine key, goldenWindow.referenceByLead = [{ maxLeadMinutes, reference }, ...]:
//   factor = (floor + (1 − floor) · P_open) / r(t), legal range [floor, 1] / r(t), t = minutes to sunset (after sunset counted as 0).
// r_b was calibrated once without labels (§3.2): the mean un-normalised factor over every pre-sunset Snapshot with the window
// active in the DEV + H1 + H2 Raw packages (1572 rows, labelled and unlabelled). The primary member K1 is compared with C0 (2.5.5.19)
// at the current lines 19 / 49 / 66 / 90 by N1–N4 plus the target T1 (§6); no lines are selected, nothing is tuned.
import { fail } from '../dataset/lib/common.mjs';
import { primaryLast, aucEvaluator, bootstrapInterval } from './p0-diagnostics.mjs';
import { grade } from './horizon-potential.mjs';
import { HP2_POLICY, summarize2 } from './horizon-potential-v2.mjs';
import { SD_POLICY } from './structure-direction.mjs';
import { productPolicy } from '../product-evaluation/policy.mjs';

const freeze = value => Object.freeze(value);
const table = pairs => freeze(pairs.map(([maxLeadMinutes, reference]) => freeze({ maxLeadMinutes, reference })));
export const GL_POLICY = freeze({
  practical_tuning_schema_version: 20, practical_tuning_policy_version: 20, search_space: 'gw-lead-reference',
  usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  pools: HP2_POLICY.pools, h3_first_date: HP2_POLICY.h3_first_date, live_parity_model_versions: HP2_POLICY.live_parity_model_versions,
  baseline: 'RELEASE_LINE_2.5.5.19', baseline_reference: SD_POLICY.baseline_reference,
  // §3.2 calibration, frozen before any label was read (.tmp/gw-lead-reference/calibrate.mjs on the 2.5.5.19 replay of all 2771 Snapshots,
  // source rows SHA-256 e5357cc3…; 1572 active pre-sunset rows, 392 / 296 / 318 / 319 / 247 per bucket; factor rebuilt exactly on all rows).
  calibration: freeze({ source_rows_sha256: 'e5357cc36473e4012f5ad5a1c8deb1a8c71224b757af870228af118275342c19', active_presunset_rows: 1572,
    single_reference_check: 0.823417, bucket_rows: freeze({ K1: freeze([392, 296, 318, 319, 247]), K1P: freeze([1325, 247]) }) }),
  members: freeze({
    K1: freeze({ role: 'PRIMARY', referenceByLead: table([[30, 0.851567], [60, 0.845156], [90, 0.828776], [120, 0.824235], [180, 0.744737]]) }),
    K1P: freeze({ role: 'REPORT_ONLY', referenceByLead: table([[120, 0.838085], [180, 0.744737]]) })
  }),
  primary: 'K1',
  // §6. N3 uses the upper bound only; N4 compares point estimates with C0 (no absolute floors in this PRD).
  rule: freeze({ lines: HP2_POLICY.lines.current, n1_auc_ge2_lower_above: -0.01, n2_auc_ge3_lower_above: -0.02, n3_loss_upper_at_most: 0.02,
    n4_recall_drop_at_most: 0.01, t1_evening_minus_1613_at_most: 1.0 }),
  lead_buckets: freeze([30, 60, 90, 120, 180]),
  review: HP2_POLICY.review, bootstrap: HP2_POLICY.bootstrap,
  south_cities: freeze(['广州', '深圳', '香港', '厦门', '南宁', '昆明']),
  factor_tolerance: 1e-9,
  decision_rules_version: 1
});
export const MEMBER_KEYS = freeze(Object.keys(GL_POLICY.members));
/** Scoring config: 2.5.5.19 with only goldenWindow.referenceByLead added. */
export function memberConfig(base, key, policy = GL_POLICY) {
  const m = policy.members[key]; if (!m) fail('GL_BAD_MEMBER_KEY', { detail: key });
  const c = structuredClone(base); c.goldenWindow = { ...c.goldenWindow, referenceByLead: m.referenceByLead.map(b => ({ ...b })) }; return c;
}
/** r(t) as the engine applies it. */
export function referenceAt(tableRows, minutes) {
  const m = Math.max(0, minutes); for (const b of tableRows) if (m <= b.maxLeadMinutes) return b.reference; return tableRows.at(-1).reference;
}
/** Expected engine factor for a member: rounded to 0.001 like evolution.js. */
export function expectedFactor(probability, minutes, floor, tableRows) {
  const r = referenceAt(tableRows, minutes), f = (floor + (1 - floor) * probability) / r;
  return Math.round(Math.min(1 / r, Math.max(floor / r, f)) * 1000) / 1000;
}

const q = v => typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const LOSS = productPolicy().loss_matrix;
const rate = (list, den, num) => w => { let d = 0, n = 0; list.forEach((r, i) => { if (den(r)) { d += w[i]; if (num(r)) n += w[i]; } }); return d ? n / d : null; };
const lossOf = (list, ord) => w => { let n = 0, d = 0; list.forEach((r, i) => { n += w[i] * LOSS[ord(r)][r.gt_ordinal]; d += w[i]; }); return d ? n / d : null; };
const diff = (f, g) => x => { const u = f(x), v = g(x); return u == null || v == null ? null : u - v; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

/** Member vs C0 at the current lines (same quantities as Policy 19, seeds prefixed V25535). */
export function fixedCompare(rows, key, policy = GL_POLICY, lines = policy.rule.lines) {
  const w = rows.map(r => r.weight), boot = (name, fn) => bootstrapInterval(rows, w, `V25535|${key}|${name}`, fn, policy.bootstrap);
  const X = r => grade(r.scores[key], lines), C = r => grade(r.scores.C0, lines);
  const cloud = ord => rate(rows, r => r.gt_ordinal >= 2 && !r.recall_exempt, r => ord(r) >= 2), all = ord => rate(rows, r => r.gt_ordinal >= 2, r => ord(r) >= 2);
  const ge3 = ord => rate(rows, r => r.gt_ordinal >= 3, r => ord(r) >= 3), over = ord => rate(rows, () => true, r => ord(r) > r.gt_ordinal);
  const pl = primaryLast(rows), pw = pl.map(r => r.gt_confidence), auc = {};
  for (const t of [2, 3]) {
    const pos = pl.map(r => r.gt_ordinal >= t), x = aucEvaluator(pl.map(r => r.scores[key]), pos), c = aucEvaluator(pl.map(r => r.scores.C0), pos);
    auc[`auc_ge${t}`] = { candidate: q(x(pw)), C0: q(c(pw)), delta: bootstrapInterval(pl, pw, `V25535|${key}|auc${t}`, diff(x, c), policy.bootstrap) };
  }
  return { lines: [...lines], candidate: summarize2(rows, X), C0: summarize2(rows, C), ...auc,
    loss_delta: boot('loss', diff(lossOf(rows, X), lossOf(rows, C))),
    ge2_recall_delta: boot('r2', diff(all(X), all(C))), ge2_recall_cloud_type_delta: boot('r2c', diff(cloud(X), cloud(C))),
    ge3_recall_delta: boot('r3', diff(ge3(X), ge3(C))), over_rate: { C0: q(over(C)(w)), candidate: q(over(X)(w)) },
    grade_changes: rows.filter(r => X(r) !== C(r)).length };
}
/** T1: per Event with a 16:13 Snapshot and an evening Snapshot, latest evening score − 16:13 score; unweighted mean over Events. */
export function eveningGap(rows, key) {
  const by = new Map(); for (const r of rows) { if (!by.has(r.event_id)) by.set(r.event_id, []); by.get(r.event_id).push(r); }
  const gaps = { C0: [], X: [] };
  for (const list of by.values()) {
    const s16 = list.find(r => r.slot === '1613'), eve = list.filter(r => r.slot === 'EVENING').sort((a, b) => a.lead_time_minutes - b.lead_time_minutes)[0];
    if (!s16 || !eve) continue; gaps.C0.push(eve.scores.C0 - s16.scores.C0); gaps.X.push(eve.scores[key] - s16.scores[key]);
  }
  const abs5 = a => a.filter(v => Math.abs(v) >= 5).length;
  return { events: gaps.C0.length, C0_mean: q(mean(gaps.C0)), candidate_mean: q(mean(gaps.X)), C0_abs_ge5: abs5(gaps.C0), candidate_abs_ge5: abs5(gaps.X) };
}
export function decide(F, T, policy = GL_POLICY) {
  const R = policy.rule, ok = x => x && x.status === 'COMPUTED';
  const N = {
    N1_auc_ge2_lower_above_minus_0_01: ok(F.auc_ge2.delta) && F.auc_ge2.delta.ci95[0] > R.n1_auc_ge2_lower_above,
    N2_auc_ge3_lower_above_minus_0_02: ok(F.auc_ge3.delta) && F.auc_ge3.delta.ci95[0] > R.n2_auc_ge3_lower_above,
    N3_loss_upper_at_most_0_02: ok(F.loss_delta) && F.loss_delta.ci95[1] <= R.n3_loss_upper_at_most,
    N4_recall_not_lower_by_more_than_0_01: F.candidate.ge2_recall != null && F.candidate.ge2_recall_cloud_type != null &&
      F.candidate.ge2_recall >= F.C0.ge2_recall - R.n4_recall_drop_at_most - 1e-12 &&
      F.candidate.ge2_recall_cloud_type >= F.C0.ge2_recall_cloud_type - R.n4_recall_drop_at_most - 1e-12
  };
  const t1 = T.candidate_mean != null && T.candidate_mean <= R.t1_evening_minus_1613_at_most;
  const failed = Object.keys(N).filter(k => !N[k]);
  const decision = !t1 ? 'NOT_EFFECTIVE' : failed.length ? 'LEVEL_FIXED_BUT_COSTLY' : 'RELEASE_CANDIDATE';
  return { conditions: { ...N, T1_evening_minus_1613_at_most_1_0: t1 }, decision, failed: [...failed, ...(t1 ? [] : ['T1_evening_minus_1613_at_most_1_0'])] };
}
/** Report only: per lead bucket (and inactive rows), mean score, mean applied factor and over-rate. */
export function byLead(rows, key, factors, policy = GL_POLICY) {
  const edges = policy.lead_buckets, lines = policy.rule.lines, label = t => { if (t > edges.at(-1)) return `>${edges.at(-1)}`; const i = edges.findIndex(e => t <= e); return `${i ? edges[i - 1] : 0}-${edges[i]}`; };
  const groups = new Map(); rows.forEach((r, i) => { const k = label(r.lead_time_minutes); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  return Object.fromEntries([...groups.entries()].sort((a, b) => parseFloat(a[0].replace('>', '')) - parseFloat(b[0].replace('>', ''))).map(([k, idx]) => {
    const list = idx.map(i => rows[i]), w = list.map(r => r.weight), ov = s => rate(list, () => true, r => grade(r.scores[s], lines) > r.gt_ordinal)(w);
    return [k, { snapshots: list.length, mean_score_C0: q(mean(list.map(r => r.scores.C0))), mean_score_candidate: q(mean(list.map(r => r.scores[key]))),
      mean_factor_C0: q(mean(idx.map(i => factors[i].C0))), mean_factor_candidate: q(mean(idx.map(i => factors[i][key]))), over_rate_C0: q(ov('C0')), over_rate_candidate: q(ov(key)) }];
  }));
}
function subgroup(list, key, lines) {
  return { snapshots: list.length, gt_ge2_snapshots: list.filter(r => r.gt_ordinal >= 2).length,
    C0: summarize2(list, r => grade(r.scores.C0, lines)), candidate: summarize2(list, r => grade(r.scores[key], lines)),
    mean_score_change: list.length ? q(mean(list.map(r => r.scores[key] - r.scores.C0))) : null };
}
export function evaluateAll(rows, factors, policy = GL_POLICY) {
  const key = policy.primary, F = fixedCompare(rows, key, policy), T = eveningGap(rows, key), verdict = decide(F, T, policy), lines = policy.rule.lines;
  const by = fn => Object.fromEntries([...new Set(rows.map(fn))].sort().map(v => [v, subgroup(rows.filter(r => fn(r) === v), key, lines)]));
  const decisionEvening = (() => { const pl = primaryLast(rows).filter(r => r.slot === 'EVENING'), w = pl.map(r => r.gt_confidence), ov = s => rate(pl, () => true, r => grade(r.scores[s], lines) > r.gt_ordinal)(w);
    return { events: pl.length, over_rate_C0: q(ov('C0')), over_rate_candidate: q(ov(key)) }; })();
  const others = Object.fromEntries(MEMBER_KEYS.filter(k => k !== key).map(k => [k, { at_current_lines: fixedCompare(rows, k, policy), evening_gap: eveningGap(rows, k) }]));
  const crossPeriod = Object.fromEntries([['DEV', ['DEV']], ['H1_H2', ['H1', 'H2']]].map(([name, pools]) => {
    const part = rows.filter(r => pools.includes(r.pool)), X = fixedCompare(part, key, policy);
    return [name, { snapshots: part.length, candidate: X.candidate, C0: X.C0, loss_delta: X.loss_delta, ge2_recall_delta: X.ge2_recall_delta, auc_ge2: X.auc_ge2 }];
  }));
  const cloudy = fn => { const part = rows.filter(fn); return part.length ? subgroup(part, key, lines) : null; };
  return { primary: key, at_current_lines: F, evening_gap: T, ...verdict, rules_version: policy.decision_rules_version,
    report_only: { members: others, by_lead: byLead(rows, key, factors, policy), decision_evening_over_rate: decisionEvening, cross_period: crossPeriod,
      breakdowns: { by_pool: by(r => r.pool), by_slot: by(r => r.slot), by_region: by(r => policy.south_cities.includes(r.city) ? 'SOUTH' : 'OTHER') },
      by_clear_sky: { C_lt5: cloudy(r => r.C != null && r.C < 5), C_ge5: cloudy(r => r.C != null && r.C >= 5) } },
    requires_owner_confirmation: true, role: 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE' };
}
