// V2.5.5.3 P0 diagnostics (PRD §4, §6–§9): D1 mechanism-group errors, D2 golden-window semantics, D3 signal review,
// and the mechanical mapping to P1/P2 priorities. Reads collected rows only; never runs the engine.
import { hash, compare } from '../dataset/lib/common.mjs';
import { computeLinearQuantile, gradeScore } from '../evaluation/metrics.mjs';
import { bootstrapIndices } from '../validation/lib/stability.mjs';
import { productMetrics, weightedRows } from '../product-evaluation/metrics.mjs';
import { P0_POLICY, mechanismGroups } from './p0-features.mjs';
import { looDatePredictions } from './p0-probe.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const r6 = v => finite(v) ? Number(v.toFixed(6)) : null;
const COMPONENTS = ['sky_canvas', 'horizon', 'illumination', 'atmosphere', 'weather'];
const GROUPS = ['G0', 'G1', 'G2', 'G3', 'G4'];

// ---------- statistics ----------
export const seedOf = label => Number.parseInt(hash(`${P0_POLICY.bootstrap.seed}|${label}`).slice(0, 8), 16) >>> 0;
export function primaryLast(rows) {
  const best = new Map();
  for (const r of rows) { const b = best.get(r.event_id);
    if (!b || r.lead_time_minutes < b.lead_time_minutes || r.lead_time_minutes === b.lead_time_minutes && compare(r.snapshot_id, b.snapshot_id) < 0) best.set(r.event_id, r); }
  return [...best.values()].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
}
// Cohort weights: PRIMARY_LAST = GT confidence per Event; ALL_SNAPSHOTS = Event-normalized weight.
export const cohortWeights = (rows, cohort) => rows.map(r => cohort === 'PRIMARY_LAST' ? r.gt_confidence : r.weight);

// Weighted AUC (positives = mask true), pair weight w_p·w_n, ties count half; sorted once, O(n) per evaluation.
export function aucEvaluator(values, positive) {
  const idx = values.map((v, i) => i).filter(i => finite(values[i])).sort((a, b) => values[a] - values[b]), groups = [];
  for (const i of idx) { const last = groups.at(-1); if (last && values[last[0]] === values[i]) last.push(i); else groups.push([i]); }
  return weights => {
    let below = 0, num = 0, P = 0, N = 0;
    for (const g of groups) {
      let wp = 0, wn = 0; for (const i of g) { if (positive[i]) wp += weights[i]; else wn += weights[i]; }
      num += wp * (below + wn / 2); below += wn; P += wp; N += wn;
    }
    return P > 0 && N > 0 ? num / (P * N) : null;
  };
}
export function weightedRate(den, num) {
  return weights => { let d = 0, n = 0; for (let i = 0; i < weights.length; i++) if (den[i]) { d += weights[i]; if (num[i]) n += weights[i]; } return d > 0 ? n / d : null; };
}
export function weightedMeanOf(values, mask = null) {
  return weights => { let s = 0, t = 0; for (let i = 0; i < weights.length; i++) if ((!mask || mask[i]) && finite(values[i])) { s += weights[i] * values[i]; t += weights[i]; } return t > 0 ? s / t : null; };
}
// Date-block percentile bootstrap of fn(weights); replicate weights multiply each row by its date's draw count.
export function bootstrapInterval(rows, baseWeights, label, fn, policy = P0_POLICY.bootstrap) {
  const point = fn(baseWeights), dates = [...new Set(rows.map(r => r.event_date_local))].sort(compare);
  const dateIndex = new Map(dates.map((d, i) => [d, i])), di = rows.map(r => dateIndex.get(r.event_date_local)), values = [];
  if (dates.length >= 2) for (const draw of bootstrapIndices(seedOf(label), dates.length, policy.replicates)) {
    const counts = Array(dates.length).fill(0); for (const i of draw) counts[i]++;
    const v = fn(baseWeights.map((w, i) => w * counts[di[i]])); if (finite(v)) values.push(v);
  }
  const valid = values.sort((a, b) => a - b), ok = valid.length >= policy.minimum_valid;
  const lower = ok ? computeLinearQuantile(valid, policy.lower) : null, upper = ok ? computeLinearQuantile(valid, policy.upper) : null;
  return { point: r6(point), ci95: [lower, upper], valid_replicates: valid.length, status: ok ? 'COMPUTED' : 'NOT_ESTIMABLE',
    significant: ok && (lower > 0 || upper < 0), reason_code: ok ? null : dates.length < 2 ? 'INSUFFICIENT_DATES' : 'FEWER_THAN_1900_VALID_REPLICATES' };
}
export function support(rows, mask = rows.map(() => true)) {
  const sel = rows.filter((r, i) => mask[i]), events = new Map(sel.map(r => [r.event_id, r]));
  const ev = [...events.values()];
  return { snapshots: sel.length, events: ev.length, dates: new Set(ev.map(r => r.event_date_local)).size,
    ge2_events: ev.filter(r => r.gt_ordinal >= 2).length, ge3_events: ev.filter(r => r.gt_ordinal >= 3).length, le1_events: ev.filter(r => r.gt_ordinal <= 1).length };
}
const supported = (s, policy = P0_POLICY.support) => s.events >= policy.events && s.dates >= policy.dates;
export function weightedQuantile(values, weights, p, mask = null) {
  const items = values.map((v, i) => [v, weights[i]]).filter(([v, w], i) => (!mask || mask[i]) && finite(v) && w > 0).sort((a, b) => a[0] - b[0]);
  const total = items.reduce((s, [, w]) => s + w, 0); if (!total) return null;
  let sum = 0; for (const [v, w] of items) { sum += w; if (sum >= p * total - 1e-12) return r6(v); } return r6(items.at(-1)[0]);
}
// Weighted Spearman: average ranks for ties, then weighted Pearson on ranks; pairwise complete rows only.
export function weightedSpearman(a, b, weights) {
  const idx = a.map((v, i) => i).filter(i => finite(a[i]) && finite(b[i]) && weights[i] > 0);
  if (idx.length < 3) return null;
  const rank = vals => { const order = [...idx].sort((x, y) => vals[x] - vals[y]), out = new Map();
    for (let s = 0; s < order.length;) { let e = s; while (e + 1 < order.length && vals[order[e + 1]] === vals[order[s]]) e++;
      for (let k = s; k <= e; k++) out.set(order[k], (s + e) / 2 + 1); s = e + 1; } return out; };
  const ra = rank(a), rb = rank(b), W = idx.reduce((s, i) => s + weights[i], 0);
  const ma = idx.reduce((s, i) => s + weights[i] * ra.get(i), 0) / W, mb = idx.reduce((s, i) => s + weights[i] * rb.get(i), 0) / W;
  let cov = 0, va = 0, vb = 0;
  for (const i of idx) { const da = ra.get(i) - ma, db = rb.get(i) - mb; cov += weights[i] * da * db; va += weights[i] * da * da; vb += weights[i] * db * db; }
  return va > 0 && vb > 0 ? r6(cov / Math.sqrt(va * vb)) : null;
}

// ---------- groups ----------
export function withGroups(rows, policy = P0_POLICY) {
  return rows.map(r => ({ ...r, groups: Object.fromEntries(Object.entries(policy.thresholds).map(([set, t]) => [set, mechanismGroups(r.features, t)])) }));
}
const ERROR_METRICS = {
  miss: { den: r => r.gt_ordinal >= 2, num: r => r.ordinal <= 1 },
  severe_miss: { den: r => r.gt_ordinal >= 3, num: r => r.ordinal <= 1, ge3: true },
  false_alarm: { den: r => r.gt_ordinal <= 1, num: r => r.ordinal >= 2 }
};
function errorValue(rows, metric, mask) {
  if (metric === 'residual') return weightedMeanOf(rows.map(r => r.ordinal - r.gt_ordinal), mask);
  const m = ERROR_METRICS[metric];
  return weightedRate(rows.map((r, i) => mask[i] && m.den(r)), rows.map(r => m.num(r)));
}

// D1 (PRD §6): per threshold set, cohort and group, error rates against the complement.
export function d1(rowsAll, policy = P0_POLICY) {
  const cohorts = { PRIMARY_LAST: primaryLast(rowsAll), ALL_SNAPSHOTS: rowsAll }, out = { sets: {}, composition: {}, attribution: null };
  for (const set of Object.keys(policy.thresholds)) {
    out.sets[set] = {};
    for (const [cohort, rows] of Object.entries(cohorts)) {
      const w = cohortWeights(rows, cohort), res = {};
      for (const g of GROUPS) {
        const inG = rows.map(r => r.groups[set][g]), outG = inG.map(v => !v), sG = support(rows, inG), sC = support(rows, outG), metrics = {};
        for (const metric of ['miss', 'severe_miss', 'false_alarm', 'residual']) {
          const fG = errorValue(rows, metric, inG), fC = errorValue(rows, metric, outG);
          const estimable = supported(sG) && supported(sC) && (!ERROR_METRICS[metric]?.ge3 || sG.ge3_events >= policy.support.ge3_events && sC.ge3_events >= policy.support.ge3_events);
          const diff = estimable ? bootstrapInterval(rows, w, `D1|${set}|${cohort}|${g}|${metric}`, x => { const a = fG(x), b = fC(x); return finite(a) && finite(b) ? a - b : null; }, policy.bootstrap) : null;
          metrics[metric] = { group: r6(fG(w)), complement: r6(fC(w)), difference: diff, status: estimable ? diff.status : 'NOT_ESTIMABLE' };
        }
        const scores = rows.map(r => r.score), aucs = {};
        for (const t of [2, 3]) {
          const ok = supported(sG) && (t === 2 ? sG.ge2_events > 0 && sG.le1_events > 0 : sG.ge3_events >= policy.support.ge3_events);
          const sub = rows.filter((r, i) => inG[i]), f = aucEvaluator(sub.map(r => r.score), sub.map(r => r.gt_ordinal >= t));
          aucs[`auc_ge${t}`] = ok ? bootstrapInterval(sub, cohortWeights(sub, cohort), `D1AUC|${set}|${cohort}|${g}|${t}`, f, policy.bootstrap) : { point: r6(f(cohortWeights(sub, cohort))), status: 'NOT_ESTIMABLE' };
        }
        res[g] = { support: sG, complement_support: sC, metrics, ...aucs,
          median_score_by_gt: Object.fromEntries([0, 1, 2, 3, 4].map(k => [k, weightedQuantile(scores, w, 0.5, rows.map((r, i) => inG[i] && r.gt_ordinal === k))])) };
      }
      out.sets[set][cohort] = res;
    }
  }
  for (const [cohort, rows] of Object.entries(cohorts))
    out.composition[cohort] = Object.fromEntries(policy.group_priority.map(g => [g, support(rows, rows.map(r => r.groups.primary.exclusive === g))]));
  out.stability = stability(out);
  out.attribution = attribution(cohorts.PRIMARY_LAST);
  return out;
}
// A primary-set result is stable when both alternative sets give a point difference of the same sign.
function stability(d) {
  const res = {};
  for (const g of GROUPS) for (const metric of ['miss', 'severe_miss', 'false_alarm', 'residual']) {
    const p = d.sets.primary.PRIMARY_LAST[g].metrics[metric], alts = ['alternative_lower', 'alternative_upper'].map(s => d.sets[s].PRIMARY_LAST[g].metrics[metric]);
    const altPoint = a => finite(a.difference?.point) ? a.difference.point : finite(a.group) && finite(a.complement) ? a.group - a.complement : null;
    const sign = p.difference?.point, same = finite(sign) && sign !== 0 && alts.every(a => finite(altPoint(a)) && Math.sign(altPoint(a)) === Math.sign(sign));
    res[`${g}.${metric}`] = { primary_significant: p.difference?.significant === true, direction: finite(sign) ? Math.sign(sign) : null, stable: same,
      evidence: p.difference?.significant === true && same };
  }
  return res;
}
const ATTRIBUTION_KEYS = ['score', 'score_engine', 'P', 'Q', 'horizon_gate', 'structure_bonus', 'transition_bonus', 'weather_penalty', 'gw_factor', 'gw_points',
  ...COMPONENTS.map(c => `comp_${c}`), ...COMPONENTS.map(c => `contrib_${c}`), 'l_corr', 'b_max', 's_screen', 'rh', 'visibility_km', 'pm25'];
function describe(rows, mask) {
  const w = rows.map(r => r.gt_confidence), s = support(rows, mask), value = k => rows.map(r => r[k] ?? r.features?.[k]);
  return { support: s, mean: Object.fromEntries(ATTRIBUTION_KEYS.map(k => [k, r6(weightedMeanOf(value(k), mask)(w))])),
    median: Object.fromEntries(ATTRIBUTION_KEYS.map(k => [k, weightedQuantile(value(k), w, 0.5, mask)])) };
}
// PRD §6.3, on PRIMARY_LAST with primary thresholds.
function attribution(rows) {
  const g = k => rows.map(r => r.groups.primary[k]), G1 = g('G1'), G2 = g('G2'), G3 = g('G3');
  const hit = rows.map(r => r.gt_ordinal >= 2 && r.ordinal >= 2), miss = rows.map(r => r.gt_ordinal >= 2 && r.ordinal <= 1);
  const cn = rows.map(r => r.gt_ordinal <= 1 && r.ordinal <= 1), fa = rows.map(r => r.gt_ordinal <= 1 && r.ordinal >= 2);
  const and = (a, b) => a.map((v, i) => v && b[i]), not = a => a.map(v => !v);
  const sets = { G1_miss: and(G1, miss), G1_hit: and(G1, hit), all_hit: hit, G2_false_alarm: and(G2, fa), G2_correct_negative: and(G2, cn),
    all_correct_negative: cn, G3_all: G3, non_G3: not(G3), all: rows.map(() => true) };
  const desc = Object.fromEntries(Object.entries(sets).map(([k, m]) => [k, describe(rows, m)]));
  // Points lost by G1 misses relative to all hits, per stage (weighted means; PRD §6.3 question 1).
  const w = rows.map(r => r.gt_confidence), mean = (vals, m) => weightedMeanOf(vals, m)(w);
  const cloud = rows.map(r => (r.contrib_sky_canvas + r.contrib_illumination) * r.Q * r.horizon_gate), horizonPts = rows.map(r => r.contrib_horizon * r.Q * r.horizon_gate);
  const pg = rows.map(r => r.P * r.horizon_gate), Qs = rows.map(r => r.Q), gwp = rows.map(r => r.gw_points);
  let q1 = { status: 'NOT_ESTIMABLE', reason_code: 'FEWER_THAN_5_G1_MISS_EVENTS' };
  if (desc.G1_miss.support.events >= 5 && desc.all_hit.support.events >= 5) {
    const deltas = { cloud: mean(cloud, sets.G1_miss) - mean(cloud, hit), horizon: mean(horizonPts, sets.G1_miss) - mean(horizonPts, hit),
      atmosphere: mean(pg, sets.G1_miss) * (mean(Qs, sets.G1_miss) - mean(Qs, hit)), golden_window: mean(gwp, sets.G1_miss) - mean(gwp, hit) };
    const main = Object.entries(deltas).sort((a, b) => a[1] - b[1] || compare(a[0], b[0]))[0][0];
    q1 = { status: 'COMPUTED', point_deltas_vs_all_hits: Object.fromEntries(Object.entries(deltas).map(([k, v]) => [k, r6(v)])), main_loss_stage: main };
  }
  const meanHorizon = m => r6(mean(rows.map(r => r.comp_horizon), m));
  const q2 = desc.G2_false_alarm.support.events >= 5 ? { status: 'COMPUTED', horizon_false_alarm: meanHorizon(sets.G2_false_alarm), horizon_all: meanHorizon(sets.all),
    b_max_false_alarm: desc.G2_false_alarm.mean.b_max, horizon_high: meanHorizon(sets.G2_false_alarm) >= meanHorizon(sets.all) }
    : { status: 'NOT_ESTIMABLE', reason_code: 'FEWER_THAN_5_G2_FALSE_ALARM_EVENTS' };
  const resid = m => r6(mean(rows.map(r => r.ordinal - r.gt_ordinal), m));
  const q3 = desc.G3_all.support.events >= 5 ? { status: 'COMPUTED', residual_G3: resid(G3), residual_non_G3: resid(sets.non_G3),
    direction: Math.sign(resid(G3) - resid(sets.non_G3)) > 0 ? 'OVER' : Math.sign(resid(G3) - resid(sets.non_G3)) < 0 ? 'UNDER' : 'NONE',
    Q_G3: desc.G3_all.mean.Q, Q_non_G3: desc.non_G3.mean.Q, atmosphere_G3: desc.G3_all.mean.comp_atmosphere, atmosphere_non_G3: desc.non_G3.mean.comp_atmosphere }
    : { status: 'NOT_ESTIMABLE', reason_code: 'FEWER_THAN_5_G3_EVENTS' };
  return { cohort: 'PRIMARY_LAST', threshold_set: 'primary', sets: desc, questions: { q1_g1_miss_loss: q1, q2_g2_false_alarm: q2, q3_g3_direction: q3 } };
}

// ---------- D2 golden window ----------
const comp3 = r => r.groups.primary.G1 ? 'G1' : r.groups.primary.G4 ? 'G4' : 'OTHER';
export function probeScores(rows, probe) {
  return rows.map(r => {
    if (!r.gw_active) return r.score;
    const f = probe === 'GWP-0' ? 1 : probe === 'GWP-1' ? (r.gw_source === 'NWP_SUNSET' ? 1 : r.gw_factor)
      : probe === 'GWP-2' ? (r.groups.primary.G1 ? Math.max(r.gw_factor, 1) : r.gw_factor) : null;
    return Math.round(Math.min(100, Math.max(0, r.sky_score * f)));
  });
}
function scoreSetMetrics(rows, scores, thresholds) {
  const graded = rows.map((r, i) => ({ ...r, predicted_ordinal: gradeScore(scores[i], thresholds) })), m = productMetrics(graded);
  return { product_loss: r6(m.product_loss), ge2_recall: r6(m.target_ge2.recall), ge3_recall: r6(m.target_ge3.recall),
    ge2_precision: r6(m.target_ge2.precision), ge3_precision: r6(m.target_ge3.precision) };
}
// Same-Event evening minus 12:13 mean score (events with both slots).
function slotDrift(rows, scores) {
  const by = new Map();
  rows.forEach((r, i) => { const e = by.get(r.event_id) || { S1213: [], EVENING: [] }; if (e[r.slot]) e[r.slot].push(scores[i]); by.set(r.event_id, e); });
  const d = [...by.values()].filter(e => e.S1213.length && e.EVENING.length).map(e => e.EVENING.reduce((a, b) => a + b, 0) / e.EVENING.length - e.S1213.reduce((a, b) => a + b, 0) / e.S1213.length);
  return { events: d.length, mean: d.length ? r6(d.reduce((a, b) => a + b, 0) / d.length) : null };
}
export function d2(rowsAll, rRows, gwp3Scores, thresholds, policy = P0_POLICY) {
  const active = rowsAll.filter(r => r.gw_active), slots = ['S1213', 'S1613', 'EVENING'];
  const paths = Object.fromEntries(slots.map(s => [s, { inactive: rowsAll.filter(r => r.slot === s && !r.gw_active).length,
    by_source: Object.fromEntries([...new Set(active.filter(r => r.slot === s).map(r => r.gw_source ?? 'NONE'))].sort().map(src => [src,
      active.filter(r => r.slot === s && (r.gw_source ?? 'NONE') === src).length])) }]));
  const coverage = Object.fromEntries(['NWP_SUNSET', 'EVOLUTION'].map(k => { const sel = active.filter(r => (r.gw_source === 'NWP_SUNSET') === (k === 'NWP_SUNSET'));
    const q = key => { const v = sel.map(r => r[key]).filter(finite).sort((a, b) => a - b); return v.length ? [0, .5, .9].map(p => computeLinearQuantile(v, p)) : null; };
    return [k, { rows: sel.length, radar_coverage_p0_p50_p90: q('gw_radar_coverage'), satellite_coverage_p0_p50_p90: q('gw_satellite_coverage'),
      open_probability_p0_p50_p90: q('gw_open_probability'), factor_p0_p50_p90: q('gw_factor') }]; }));
  const crosstab = [];
  const bins = policy.t_avg_bins;
  for (let b = 0; b < bins.length - 1; b++) for (const c of ['G1', 'G4', 'OTHER']) {
    const sel = active.filter(r => finite(r.features.t_avg) && r.features.t_avg >= bins[b] && r.features.t_avg < bins[b + 1] && comp3(r) === c);
    const W = sel.reduce((s, r) => s + r.weight, 0), wm = k => W ? r6(sel.reduce((s, r) => s + r.weight * r[k], 0) / W) : null;
    crosstab.push({ t_avg_bin: `${bins[b]}-${Math.min(bins[b + 1], 100)}`, composition: c, rows: sel.length, events: new Set(sel.map(r => r.event_id)).size,
      mean_factor: wm('gw_factor'), mean_points: wm('gw_points'), grade_down: sel.filter(r => r.ordinal < r.ordinal_without_gw).length, grade_up: sel.filter(r => r.ordinal > r.ordinal_without_gw).length });
  }
  // Core question (§7.1-3): at high total cloud, do screen-dominated (G1) and low-blocked (G4) rows get different factors?
  const high = active.filter(r => finite(r.features.t_avg) && r.features.t_avg >= 50), hw = high.map(r => r.weight);
  const isG1 = high.map(r => comp3(r) === 'G1'), isG4 = high.map(r => comp3(r) === 'G4'), f = high.map(r => r.gw_factor);
  const sG1 = support(high, isG1), sG4 = support(high, isG4), estimable = supported(sG1) && supported(sG4);
  const core = { t_avg_min: 50, G1_support: sG1, G4_support: sG4, G1_mean_factor: r6(weightedMeanOf(f, isG1)(hw)), G4_mean_factor: r6(weightedMeanOf(f, isG4)(hw)),
    difference_G1_minus_G4: estimable ? bootstrapInterval(high, hw, 'D2|core', x => { const a = weightedMeanOf(f, isG1)(x), b = weightedMeanOf(f, isG4)(x); return finite(a) && finite(b) ? a - b : null; }, policy.bootstrap) : null,
    status: estimable ? 'COMPUTED' : 'NOT_ESTIMABLE' };
  core.indistinguishable = estimable ? !core.difference_G1_minus_G4.significant : null;
  // §7.1-4: G1 active rows under 2.5.5.1 (R) vs 2.5.5.2 (C).
  const rById = new Map(rRows.map(r => [r.snapshot_id, r])), g1 = active.filter(r => comp3(r) === 'G1');
  const mean = (list, fn) => { const W = list.reduce((s, r) => s + r.weight, 0); return W ? r6(list.reduce((s, r) => s + r.weight * fn(r), 0) / W) : null; };
  const release = { G1_active_rows: g1.length, C_mean_factor: mean(g1, r => r.gw_factor), R_mean_factor: mean(g1, r => rById.get(r.snapshot_id).gw_factor),
    C_mean_points: mean(g1, r => r.gw_points), R_mean_points: mean(g1, r => rById.get(r.snapshot_id).gw_points),
    C_rows_factor_below_1: g1.filter(r => r.gw_factor < 1).length, R_rows_factor_below_1: g1.filter(r => rById.get(r.snapshot_id).gw_factor < 1).length };
  // Probes (§7.2), compared with C on PRIMARY_LAST AUC and full-pool product metrics.
  const base = rowsAll.map(r => r.score), pl = primaryLast(rowsAll), plIndex = new Map(rowsAll.map((r, i) => [r.snapshot_id, i]));
  const plw = pl.map(r => r.gt_confidence), probes = {};
  const scoresFor = { 'GWP-0': probeScores(rowsAll, 'GWP-0'), 'GWP-1': probeScores(rowsAll, 'GWP-1'), 'GWP-2': probeScores(rowsAll, 'GWP-2'), 'GWP-3': gwp3Scores };
  const baseMetrics = scoreSetMetrics(rowsAll, base, thresholds);
  for (const [id, scores] of Object.entries(scoresFor)) {
    const pick = s => pl.map(r => s[plIndex.get(r.snapshot_id)]), aucs = {};
    for (const t of [2, 3]) {
      const pos = pl.map(r => r.gt_ordinal >= t), a = aucEvaluator(pick(scores), pos), c = aucEvaluator(pick(base), pos);
      aucs[`delta_auc_ge${t}`] = bootstrapInterval(pl, plw, `D2|${id}|${t}`, x => { const u = a(x), v = c(x); return finite(u) && finite(v) ? u - v : null; }, policy.bootstrap);
      aucs[`auc_ge${t}`] = r6(a(plw));
    }
    const changed = scores.filter((s, i) => s !== base[i]).length;
    probes[id] = { ...aucs, metrics: scoreSetMetrics(rowsAll, scores, thresholds), changed_scores: changed,
      grade_changes: scores.filter((s, i) => gradeScore(s, thresholds) !== rowsAll[i].ordinal).length, slot_drift: slotDrift(rowsAll, scores),
      wiring: changed > 0 ? 'WIRED' : 'NOT_WIRED', role: 'DIAGNOSTIC_PROBE_NOT_A_CANDIDATE' };
  }
  return { paths, coverage, crosstab, core, release, C_metrics: baseMetrics, C_slot_drift: slotDrift(rowsAll, base),
    C_auc: { ge2: r6(aucEvaluator(pl.map(r => r.score), pl.map(r => r.gt_ordinal >= 2))(plw)), ge3: r6(aucEvaluator(pl.map(r => r.score), pl.map(r => r.gt_ordinal >= 3))(plw)) }, probes };
}

// ---------- D3 signal review ----------
export const SIGNALS = ['score', 'score_engine', 'P', 'Q', 'horizon_gate', 'gw_factor', 'gw_open_probability', ...COMPONENTS.map(c => `comp_${c}`),
  ...COMPONENTS.map(c => `contrib_${c}`), 'structure_bonus', 'transition_bonus', 'weather_penalty', ...P0_POLICY.feature_ids];
const valueOf = (r, k) => r[k] ?? r.features?.[k] ?? null;
function screen(rowsAll, policy) {
  const pl = primaryLast(rowsAll), out = [];
  for (const k of SIGNALS) {
    const entry = { signal: k };
    for (const [cohort, rows] of [['PRIMARY_LAST', pl], ['ALL_SNAPSHOTS', rowsAll]]) {
      const v = rows.map(r => valueOf(r, k)), w = cohortWeights(rows, cohort), res = { n: v.filter(finite).length };
      for (const t of [2, 3]) res[`auc_ge${t}`] = bootstrapInterval(rows, w, `D3|${k}|${cohort}|${t}`, aucEvaluator(v, rows.map(r => r.gt_ordinal >= t)), policy.bootstrap);
      res.direction_ge2 = res.auc_ge2.status !== 'COMPUTED' ? 'NOT_ESTIMABLE' : res.auc_ge2.ci95[0] > .5 ? 'POSITIVE' : res.auc_ge2.ci95[1] < .5 ? 'REVERSED' : 'NONE';
      entry[cohort] = res;
    }
    entry.slots = Object.fromEntries(['S1213', 'S1613', 'EVENING'].map(s => { const rows = rowsAll.filter(r => r.slot === s);
      return [s, bootstrapInterval(rows, cohortWeights(rows, 'ALL_SNAPSHOTS'), `D3|${k}|${s}|2`, aucEvaluator(rows.map(r => valueOf(r, k)), rows.map(r => r.gt_ordinal >= 2)), policy.bootstrap)]; }));
    out.push(entry);
  }
  return out;
}
// Equal-frequency bins by Event without splitting ties.
export function equalFrequencyBins(values, count) {
  const idx = values.map((v, i) => i).filter(i => finite(values[i])).sort((a, b) => values[a] - values[b] || a - b), bins = [];
  let current = [], target = idx.length / count;
  for (let p = 0; p < idx.length; p++) {
    current.push(idx[p]);
    const tie = p + 1 < idx.length && values[idx[p + 1]] === values[idx[p]];
    if (!tie && (idx.length - (p + 1) === 0 || (bins.length + 1) * target <= p + 1 + 1e-9) && bins.length < count - 1) { bins.push(current); current = []; }
  }
  if (current.length) bins.push(current);
  return bins;
}
function responseCurves(scoring) {
  const gauss = (c, w) => v => 100 * Math.exp(-0.5 * ((v - c) / w) ** 2);
  return { rh: gauss(scoring.humidityCenter, scoring.humidityWidth), aod: gauss(scoring.aodCenter, scoring.aodWidth),
    pm25: v => Math.min(100, Math.max(0, 100 - (v - 5) * (100 / 70))), visibility_km: v => 100 * (1 - Math.exp(-v / scoring.visibilityScaleKm)),
    center_high: gauss(scoring.highCloudCenter, scoring.highCloudWidth), center_mid: gauss(scoring.midCloudCenter, scoring.midCloudWidth),
    center_low: v => Math.min(100, Math.max(0, 100 - v)), l_corr: v => Math.min(100, Math.max(0, 100 - v)) };
}
function binCurve(rows, key, label, scoring, policy) {
  const v = rows.map(r => valueOf(r, key)), w = rows.map(r => r.gt_confidence), bins = equalFrequencyBins(v, policy.bins.count), curve = responseCurves(scoring)[key];
  const masks = bins.map(b => { const s = new Set(b); return rows.map((r, i) => s.has(i)); });
  const rate = (m, t) => weightedRate(m, rows.map(r => r.gt_ordinal >= t)), gtMean = m => weightedMeanOf(rows.map(r => r.gt_ordinal), m);
  const out = bins.map((b, j) => { const vals = b.map(i => v[i]), med = weightedQuantile(v, w, 0.5, masks[j]);
    return { bin: j + 1, events: b.length, min: r6(Math.min(...vals)), max: r6(Math.max(...vals)), median: med,
      ge2_rate: bootstrapInterval(rows, w, `D3BIN|${label}|${j}|2`, rate(masks[j], 2), policy.bootstrap),
      ge3_rate: bootstrapInterval(rows, w, `D3BIN|${label}|${j}|3`, rate(masks[j], 3), policy.bootstrap),
      mean_gt: bootstrapInterval(rows, w, `D3BIN|${label}|${j}|m`, gtMean(masks[j]), policy.bootstrap),
      current_response_at_median: curve && finite(med) ? r6(curve(med)) : null }; });
  // Shape rule (PRD §8.2), on the GT>=2 rate.
  let shape = 'UNRESOLVED', evidence = {};
  if (bins.length >= 2) {
    const diff = (a, b, tag) => bootstrapInterval(rows, w, `D3SHAPE|${label}|${tag}`, x => { const p = rate(masks[a], 2)(x), q = rate(masks[b], 2)(x); return finite(p) && finite(q) ? p - q : null; }, policy.bootstrap);
    const ends = diff(bins.length - 1, 0, 'ends'); evidence.last_minus_first = ends;
    if (bins.length >= policy.bins.minimum_for_peak) for (let j = 1; j < bins.length - 1; j++) {
      const a = diff(j, 0, `peak${j}first`), b = diff(j, bins.length - 1, `peak${j}last`);
      evidence[`bin${j + 1}_peak`] = { minus_first: a, minus_last: b };
      if (a.status === 'COMPUTED' && b.status === 'COMPUTED' && a.ci95[0] > 0 && b.ci95[0] > 0) shape = 'INTERIOR_PEAK';
    }
    if (shape !== 'INTERIOR_PEAK' && ends.significant) shape = ends.point > 0 ? 'MONOTONE_INC' : 'MONOTONE_DEC';
  }
  return { variable: key, label, rows: v.filter(finite).length, bin_count: bins.length, requested_bins: policy.bins.count, bins: out, shape, shape_evidence: evidence };
}
function redundancy(pl, policy) {
  const w = pl.map(r => r.gt_confidence), keys = [...policy.atmosphere_variables, 'Q', 'comp_atmosphere'];
  const matrix = keys.map(a => ({ variable: a, ...Object.fromEntries(keys.map(b => [b, weightedSpearman(pl.map(r => valueOf(r, a)), pl.map(r => valueOf(r, b)), w)])) }));
  const data = pl.map(r => ({ ...r, ...Object.fromEntries(keys.concat('score').map(k => [k, valueOf(r, k)])) })), pos = pl.map(r => r.gt_ordinal >= 2);
  const fit = ks => looDatePredictions(data, ks, policy.logistic), models = {}, atm = policy.atmosphere_variables;
  models.atmosphere_full = fit(atm); for (const k of atm) models[`atmosphere_drop_${k}`] = fit(atm.filter(x => x !== k));
  models.score_only = fit(['score']); for (const k of atm) models[`score_plus_${k}`] = fit(['score', k]);
  const auc = id => aucEvaluator(models[id].predictions, pos), compareTo = (id, ref) => bootstrapInterval(pl, w, `D3LOGIT|${id}|${ref}`, x => { const a = auc(id)(x), b = auc(ref)(x); return finite(a) && finite(b) ? a - b : null; }, policy.bootstrap);
  const summary = Object.fromEntries(Object.entries(models).map(([id, m]) => [id, { oof_auc_ge2: r6(auc(id)(w)), folds: m.folds, converged_folds: m.converged_folds }]));
  const drop = Object.fromEntries(atm.map(k => { const d = compareTo(`atmosphere_drop_${k}`, 'atmosphere_full');
    return [k, { delta_vs_full: d, removable_without_loss: d.status === 'COMPUTED' && d.ci95[1] >= 0 }]; }));
  const increment = Object.fromEntries(atm.map(k => { const d = compareTo(`score_plus_${k}`, 'score_only'); return [k, { delta_vs_score_only: d, adds_information: d.status === 'COMPUTED' && d.ci95[0] > 0 }]; }));
  return { spearman: matrix, models: summary, drop_one: drop, increment_over_score: increment,
    all_folds_converged: Object.values(models).every(m => m.converged_folds === m.folds) };
}
export function d3(rowsAll, scoring, policy = P0_POLICY) {
  const pl = primaryLast(rowsAll), t = policy.thresholds.primary;
  const bins = policy.bin_variables.map(k => binCurve(pl, k, k, scoring, policy));
  const conditional = policy.conditional_bin_variables.flatMap(k => [['clear', r => finite(r.features.l_corr) && r.features.l_corr <= t.l_corr_clear], ['not_clear', r => finite(r.features.l_corr) && r.features.l_corr > t.l_corr_clear]]
    .map(([tag, fn]) => binCurve(pl.filter(fn), k, `${k}|l_corr_${tag}`, scoring, policy)));
  const w = pl.map(r => r.gt_confidence), doy = pl.map(r => { const d = new Date(`${r.event_date_local}T00:00:00Z`); return (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5 + 1; });
  const tw = pl.map(r => r.features.twilight_minutes);
  return { screen: screen(rowsAll, policy), bins, conditional_bins: conditional,
    twilight_confounding: { spearman_latitude: weightedSpearman(tw, pl.map(r => r.latitude), w), spearman_day_of_year: weightedSpearman(tw, doy, w) },
    redundancy: redundancy(pl, policy) };
}

// ---------- §9 mapping ----------
export function decide(D1, D2, D3) {
  const ev = k => D1.stability[k]?.evidence === true && D1.stability[k].direction > 0;
  const q1 = D1.attribution.questions.q1_g1_miss_loss, q2 = D1.attribution.questions.q2_g2_false_alarm;
  const shape = k => D3.bins.find(b => b.label === k)?.shape ?? 'UNRESOLVED';
  const probeGain = ['GWP-1', 'GWP-2'].some(p => D2.probes[p].delta_auc_ge2.status === 'COMPUTED' && D2.probes[p].delta_auc_ge2.ci95[0] > 0);
  const evidence = {
    G1_miss_elevated: ev('G1.miss'), G1_main_loss_stage: q1.status === 'COMPUTED' ? q1.main_loss_stage : 'NOT_ESTIMABLE',
    GW_probe_gain: probeGain, GW_screen_block_indistinguishable: D2.core.indistinguishable,
    G2_false_alarm_elevated: ev('G2.false_alarm'), G2_horizon_high: q2.status === 'COMPUTED' ? q2.horizon_high : null,
    G3_error_significant: ['miss', 'false_alarm', 'residual', 'severe_miss'].some(m => D1.stability[`G3.${m}`]?.evidence === true),
    rh_shape: shape('rh'), aod_shape: shape('aod'),
    atmosphere_removable: Object.entries(D3.redundancy.drop_one).filter(([, v]) => v.removable_without_loss).map(([k]) => k)
  };
  const gw = (evidence.G1_miss_elevated && evidence.G1_main_loss_stage === 'golden_window') || evidence.GW_probe_gain || evidence.GW_screen_block_indistinguishable === true;
  const cloud = evidence.G1_miss_elevated && evidence.G1_main_loss_stage === 'cloud';
  const bottleneck = evidence.G2_false_alarm_elevated && evidence.G2_horizon_high === true;
  const monotone = s => s === 'MONOTONE_INC' || s === 'MONOTONE_DEC';
  const atmosphere = evidence.G3_error_significant || monotone(evidence.rh_shape) || monotone(evidence.aod_shape);
  const items = [
    { item: 'P1_GW_LAYERED_BLOCKING_PROXY', recommended: gw },
    { item: 'P1_CONDITIONAL_MID_HIGH_RESPONSE', recommended: cloud },
    { item: 'P1_ATMOSPHERE_FUNCTION', recommended: atmosphere,
      notes: { g3_error_direction: D1.attribution.questions.q3_g3_direction?.direction ?? null, rh_shape: evidence.rh_shape, aod_shape: evidence.aod_shape, keep_single_peak: ['rh', 'aod'].filter(k => evidence[`${k}_shape`] === 'INTERIOR_PEAK'),
        removable_without_loss: evidence.atmosphere_removable } },
    { item: 'P2_TO_P1_CORRIDOR_BOTTLENECK', recommended: bottleneck }
  ];
  let rank = 1;
  // GW goes before the mid/high response when both hold (smaller change; semantic error already confirmed in code).
  for (const it of items) it.status = it.recommended ? `PRIORITY_${rank++}` : 'DATA_LIMITED';
  return { rules_version: P0_POLICY.decision_rules_version, evidence, recommendations: items,
    requires_owner_confirmation: true, role: 'PRIORITY_ADVICE_ONLY_NO_CANDIDATE_NO_CONFIG_CHANGE' };
}
export { weightedRows, COMPONENTS };
