// V2.5.5.6 golden-window cloud/rain split: DEV evaluation (Practical Tuning Schema/Policy 12, PRD V2.5.5.6 §4). Single hypothesis
// H-GW: P_open = P_cloud(sun-side layered blocking at sunset) × P_rain(radar × minute precipitation), on every lead time.
// C0 = 2.5.5.4; W1 = C0 + H-GW with the GW reference recomputed by the V2.5.5.2 rule; W_TOTAL / W_NORADAR / W1_NOREF are
// attribution rows only. Nothing is searched; the reference follows a fixed deterministic rule.
import path from 'node:path';
import { mkdir, writeFile, rename, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../dataset/lib/common.mjs';
import { scoreToOrdinal, gradeScore } from '../evaluation/metrics.mjs';
import { releaseConfigs, bootstrapDeltas, primaryLast, weightedAuc } from '../model-release/holdout.mjs';
import { SKY_OFF_REFERENCE, V2552_REFERENCE, V2554_REFERENCE, V2556_REFERENCE, gwSplitScoring } from '../model-release/release.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { preflight, gradeThresholdsOf } from './compute.mjs';
import { highCloudMetrics } from './high-cloud.mjs';
import { digest } from './policy.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { acquireRunLock, atomicJson, csv } from './workflow.mjs';
import { P0_POLICY } from './p0-features.mjs';
import { withGroups } from './p0-diagnostics.mjs';
import { p0Calculator, analysisRow } from './p0-workflow.mjs';
import { changeSurface, groupShift } from './horizon-fix-workflow.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const freeze = value => Object.freeze(value);

export const GW_POLICY = freeze({
  practical_tuning_schema_version: 12, practical_tuning_policy_version: 12,
  search_space: 'gw-split', usage: 'PERSONAL_PROJECT_EVALUATION', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  dev: P0_POLICY.dev, first_holdout_date: P0_POLICY.first_holdout_date,
  hypothesis: 'H-GW: P_OPEN = P_CLOUD(SUN_SIDE_BLOCKING = LOW + 0.5 MID, HORIZON AGGREGATION, AT SUNSET) x P_RAIN(RADAR x MINUTE PRECIP); ALL LEAD TIMES',
  candidates: freeze({ W1: freeze({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'RAIN_GATE', reference: 'RECOMPUTED' }),
    W_TOTAL: freeze({ cloudSignal: 'TOTAL_CLOUD', radarRole: 'RAIN_GATE', reference: 'RECOMPUTED' }),
    W_NORADAR: freeze({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'IGNORE', reference: 'RECOMPUTED' }),
    W1_NOREF: freeze({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'RAIN_GATE', reference: 'UNCHANGED' }) }),
  // V2.5.5.2 PRD §3.1: reference = mean of (floor + (1 − floor) × P_open) over the active DEV rows, 6 decimals.
  reference_rule: 'MEAN_PRE_REFERENCE_FACTOR_OF_ACTIVE_ROWS_ROUND_6',
  versions: freeze(['C0', 'W1', 'W_TOTAL', 'W_NORADAR', 'W1_NOREF']),
  comparisons: freeze(['W1', 'W_TOTAL', 'W_NORADAR', 'W1_NOREF'].map(v => freeze({ id: `${v}_VS_C0`, candidate: v, control: 'C0' }))
    .concat([freeze({ id: 'W1_VS_W_TOTAL', candidate: 'W1', control: 'W_TOTAL' }), freeze({ id: 'W1_VS_W_NORADAR', candidate: 'W1', control: 'W_NORADAR' })])),
  bootstrap: freeze({ replicates: 2000, block: 'event_date_local', seed: 'V2556_GW_SPLIT_EVAL_1' }),
  // PRD V2.5.5.6 §4.1 (decision 2): the V2.5.5.5 improvement rule.
  rules: freeze({ product_loss_delta_below: 0, auc_ge2_point_delta_at_least: 0, auc_ge2_ci_upper_must_exceed: 0, ge2_recall_max_drop: 0.02 }),
  // PRD §4.2 scenarios on C0 sunset features and radar coverage (fixed thresholds).
  scenarios: freeze({ screen_min: 50, radar_none_max: 5, clear_blocking_max: 30, thick_blocking_min: 60, radar_echo_min: 35, min_events: 15 }),
  decision_rules_version: 1
});

function assertDev(loaded, policy) {
  const d = policy.dev;
  if (loaded.source_ids.raw !== d.raw || loaded.source_ids.gt !== d.gt || loaded.source_ids.model !== d.model) fail('GW_DEV_IDENTITY_MISMATCH');
  if (loaded.rows.some(r => r.event_date_local >= policy.first_holdout_date)) fail('GW_HOLDOUT_DATE_REJECTED');
  if (loaded.exclusions.length || loaded.rows.length !== d.snapshots) fail('GW_DEV_POOL_INCOMPLETE');
}
const r6 = v => typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const mean = v => { const x = v.filter(finite); return x.length ? r6(x.reduce((a, b) => a + b, 0) / x.length) : null; };
const quantile = (v, p) => { const x = v.filter(finite).sort((a, b) => a - b); return x.length ? r6(x[Math.min(x.length - 1, Math.floor(p * x.length))]) : null; };
const gwObs = result => result.trace?.diagnostic_observer?.golden_window ?? fail('GW_OBSERVER_MISSING');
// The V2.5.5.2 reference rule applied to a configuration whose reference is set to 1.
export function referenceByRule(openProbabilities, floor) {
  const xs = openProbabilities.filter(finite);
  if (!xs.length) fail('GW_REFERENCE_NO_ACTIVE_ROWS');
  return r6(xs.reduce((s, p) => s + floor + (1 - floor) * p, 0) / xs.length);
}
async function openProbabilities(rows, config, calculator) {
  const out = [];
  for (const row of rows) { const g = gwObs(await calculator.calculate(row, config, true)); out.push(g.active ? g.sunset_open_probability : null); }
  return out;
}
async function collect(rows, config, calculator, progress, label) {
  const thresholds = gradeThresholdsOf(config), out = [];
  for (const [i, row] of rows.entries()) {
    const result = await calculator.calculate(row, config, true);
    out.push({ ...analysisRow(row, result, config, thresholds), gw: gwObs(result) });
    if ((i + 1) % 100 === 0 || i + 1 === rows.length) progress(`${label} Trace ${i + 1}/${rows.length}`);
  }
  return out;
}
export function gwConfigs(base, references) {
  const out = { C0: base };
  for (const [v, c] of Object.entries(GW_POLICY.candidates))
    out[v] = gwSplitScoring(base, { cloudSignal: c.cloudSignal, radarRole: c.radarRole, reference: c.reference === 'RECOMPUTED' ? references[v] : undefined });
  return out;
}
export function scenarioOf(row, blocking, t) {
  const f = row.features, radar = row.gw.radar_coverage_now;
  if (!row.gw.active || !finite(radar)) return null;
  if (radar >= t.radar_echo_min) return 'S_C_ECHO';
  if (radar < t.radar_none_max && finite(blocking) && blocking >= t.thick_blocking_min) return 'S_B_THICK_NO_ECHO';
  if (radar < t.radar_none_max && finite(blocking) && blocking < t.clear_blocking_max && (f.center_high >= t.screen_min || f.s_screen >= t.screen_min)) return 'S_A_SCREEN_NO_ECHO';
  return null;
}
export function decideGw(metrics, deltas, rules) {
  const loss = r6(metrics.W1.product_loss - metrics.C0.product_loss), recall = r6(metrics.W1.ge2_recall - metrics.C0.ge2_recall);
  const auc = r6(metrics.W1.auc_ge2_primary_last - metrics.C0.auc_ge2_primary_last), upper = deltas.W1_VS_C0.auc_ge2_primary_last.ci95[1];
  const checks = { product_loss_lower: loss < rules.product_loss_delta_below, auc_ge2_not_lower: auc >= rules.auc_ge2_point_delta_at_least,
    auc_ge2_ci_upper_above_zero: upper != null && upper > rules.auc_ge2_ci_upper_must_exceed, ge2_recall: recall >= -rules.ge2_recall_max_drop };
  const status = Object.values(checks).every(Boolean) ? 'ADOPT_CANDIDATE' : 'NO_GAIN';
  return { decision_rules_version: GW_POLICY.decision_rules_version, rules, W1: { status, checks, product_loss_delta: loss, auc_ge2_delta: auc,
    auc_ge2_delta_ci95_upper: r6(upper), ge2_recall_delta: recall }, recommendation: status, decision_owner: 'PROJECT_OWNER' };
}

// Deterministic payload; recomputed in a fresh process before publication and by verify.
export async function computeGw(loaded, code, progress = () => {}, policy = GW_POLICY) {
  assertDev(loaded, policy);
  const configs = await releaseConfigs(), base = configs['2.5.5.4'], R = configs['2.5.5.1'], B0 = configs['2.5.5.2'], calculator = p0Calculator(code.engine_sha256);
  const thresholds = gradeThresholdsOf(base), floor = base.goldenWindow.floor;
  progress('B0（2.5.5.2）预检');
  const checked = await preflight(loaded, B0, calculator, progress);
  if (checked.exclusions.length) fail('GW_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, sB0 = rows.map(r => r.control_score), sR = [], sC0 = [];
  for (const row of rows) { sR.push((await calculator.calculate(row, R)).score); sC0.push((await calculator.calculate(row, base)).score); }
  const signature = s => digest(rows.map((r, i) => [r.snapshot_id, s[i], gradeScore(s[i], thresholds)]));
  const v2552 = { prediction_signature_sha256: signature(sB0), product_loss: highCloudMetrics(rows, sB0, thresholds).product_loss,
    score_changed_vs_V2551: sB0.filter((s, i) => s !== sR[i]).length, grade_changed_vs_V2551: sB0.filter((s, i) => gradeScore(s, thresholds) !== scoreToOrdinal(sR[i])).length };
  if (digest(v2552) !== digest(V2552_REFERENCE)) fail('GW_V2552_PARITY_FAILED');
  const rSignature = digest(rows.map((r, i) => [r.snapshot_id, sR[i], scoreToOrdinal(sR[i])]));
  if (rSignature !== SKY_OFF_REFERENCE.prediction_signature_sha256) fail('GW_V2551_PARITY_FAILED');
  const v2554 = { prediction_signature_sha256: signature(sC0), product_loss: highCloudMetrics(rows, sC0, thresholds).product_loss,
    score_changed_vs_V2552: sC0.filter((s, i) => s !== sB0[i]).length, grade_changed_vs_V2552: sC0.filter((s, i) => gradeScore(s, thresholds) !== gradeScore(sB0[i], thresholds)).length };
  if (digest(v2554) !== digest(V2554_REFERENCE)) fail('GW_V2554_PARITY_FAILED');
  // Reference by rule: candidates with reference 1 (the C0 rule check uses the legacy GW with reference 1).
  progress('按 V2.5.5.2 规则重算 reference');
  const withRef1 = cfg => { const c = structuredClone(cfg); c.goldenWindow.reference = 1; return c; };
  const references = {}, ruleCheck = referenceByRule(await openProbabilities(rows, withRef1(base), calculator), floor);
  for (const [v, c] of Object.entries(policy.candidates)) if (c.reference === 'RECOMPUTED')
    references[v] = referenceByRule(await openProbabilities(rows, gwSplitScoring(base, { cloudSignal: c.cloudSignal, radarRole: c.radarRole, reference: 1 }), calculator), floor);
  const cfg = gwConfigs(base, references);
  const traced = { C0: await collect(rows, cfg.C0, calculator, progress, 'C0'), W1: await collect(rows, cfg.W1, calculator, progress, 'W1') };
  if (traced.C0.some((t, i) => t.score !== sC0[i])) fail('GW_OBSERVER_CHANGED_SCORES');
  const scores = { C0: sC0 };
  for (const v of policy.versions.filter(v => v !== 'C0')) { scores[v] = []; for (const row of rows) scores[v].push((await calculator.calculate(row, cfg[v])).score); }
  if (traced.W1.some((t, i) => t.score !== scores.W1[i])) fail('GW_OBSERVER_CHANGED_SCORES');
  // Invariant: rows outside the golden window are untouched by every candidate.
  for (const v of policy.versions) if (scores[v].some((s, i) => !traced.C0[i].gw.active && s !== sC0[i])) fail('GW_INACTIVE_ROW_CHANGED', { detail: v });
  const scored = rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, gt_ordinal: r.gt_ordinal,
    gt_confidence: r.gt_confidence, event_normalized_weight: r.event_normalized_weight, lead_time_minutes: r.lead_time_minutes, location_key: r.location_key,
    ...Object.fromEntries(policy.versions.flatMap(v => [[`score_${v}`, scores[v][i]], [`ordinal_${v}`, gradeScore(scores[v][i], thresholds)]])) }));
  const last = primaryLast(scored), metrics = {};
  for (const v of policy.versions) {
    const m = highCloudMetrics(rows, scores[v], thresholds);
    metrics[v] = { product_loss: m.product_loss, ge2_recall: m.target_ge2.recall, ge2_precision: m.target_ge2.precision, ge3_recall: m.target_ge3.recall,
      ge3_precision: m.target_ge3.precision, ge3_usage_rate: m.target_ge3.predicted_usage_rate, mae: m.mae, bias: m.bias,
      auc_ge2_primary_last: weightedAuc(last, `score_${v}`, 2), auc_ge3_primary_last: weightedAuc(last, `score_${v}`, 3) };
  }
  progress(`按日期整块抽样（${policy.bootstrap.replicates} 次）`);
  const deltas = bootstrapDeltas(scored, Object.fromEntries(policy.versions.map(v => [v, thresholds])), policy);
  const comparisons = policy.comparisons.map(c => ({ ...c, point_difference: Object.fromEntries(Object.keys(metrics.C0).map(k =>
    [k, metrics[c.candidate][k] == null || metrics[c.control][k] == null ? null : r6(metrics[c.candidate][k] - metrics[c.control][k])])), bootstrap: deltas[c.id] }));
  const v2556 = { gw_reference: references.W1, prediction_signature_sha256: signature(scores.W1), product_loss: metrics.W1.product_loss,
    score_changed_vs_V2554: scores.W1.filter((s, i) => s !== sC0[i]).length,
    grade_changed_vs_V2554: scores.W1.filter((s, i) => gradeScore(s, thresholds) !== gradeScore(sC0[i], thresholds)).length };
  if (V2556_REFERENCE.prediction_signature_sha256 !== null && digest(v2556) !== digest(V2556_REFERENCE)) fail('GW_V2556_REFERENCE_MISMATCH');
  const parity = { status: 'PASS', members: rows.length, V2552: v2552, V2551_prediction_signature_sha256: rSignature, V2554: v2554,
    key_absent_reproduces_V2552_and_V2554: true, observer_on_off_identical: ['C0', 'W1'], inactive_rows_identical: true,
    // The rule reads the observer open probability (2 decimals), so it is compared with the V2.5.5.2 constant within 1e-4.
    reference_rule_on_C0: ruleCheck, reference_rule_difference_vs_V2552: r6(ruleCheck - base.goldenWindow.reference),
    reference_rule_reproduces_V2552_value: Math.abs(ruleCheck - base.goldenWindow.reference) <= 1e-4, references,
    engine_sha256: code.engine_sha256, config_sha256: Object.fromEntries(policy.versions.map(v => [v, digest(cfg[v])])), V2556_computed_reference: v2556 };
  progress('机制、场景与分组');
  const active = traced.C0.map((t, i) => t.gw.active ? i : -1).filter(i => i >= 0), blocking = traced.W1.map(t => t.gw.cloud_signal_value);
  const pathOf = i => traced.C0[i].gw.probability_source === 'NWP_SUNSET' ? 'NWP_SUNSET' : 'EVOLUTION';
  const factor = (v, i) => v === 'C0' ? traced.C0[i].gw_factor : v === 'W1' ? traced.W1[i].gw_factor : null;
  const dist = (v, idx) => { const xs = idx.map(i => factor(v, i)); return { rows: idx.length, mean: mean(xs), p10: quantile(xs, .1), p50: quantile(xs, .5), p90: quantile(xs, .9) }; };
  const spearman = (a, b) => { const idx = a.map((_, i) => i).filter(i => finite(a[i]) && finite(b[i]));
    const rank = x => { const o = [...idx].sort((p, q) => x[p] - x[q]), r = new Map(); for (let s = 0; s < o.length;) { let e = s; while (e + 1 < o.length && x[o[e + 1]] === x[o[s]]) e++; for (let k = s; k <= e; k++) r.set(o[k], (s + e) / 2); s = e + 1; } return r; };
    const ra = rank(a), rb = rank(b), n = idx.length, ma = idx.reduce((s, i) => s + ra.get(i), 0) / n, mb = idx.reduce((s, i) => s + rb.get(i), 0) / n;
    let c = 0, va = 0, vb = 0; for (const i of idx) { const x = ra.get(i) - ma, y = rb.get(i) - mb; c += x * y; va += x * x; vb += y * y; }
    return { n, rho: va > 0 && vb > 0 ? r6(c / Math.sqrt(va * vb)) : null }; };
  const changed = active.filter(i => scores.W1[i] !== sC0[i]);
  const mechanism = { active_rows: active.length, legacy_fallback_rows: traced.W1.filter(t => t.gw.active && t.gw.cloud_signal_mode === 'LEGACY_FALLBACK').length,
    gw_factor: Object.fromEntries(['C0', 'W1'].map(v => [v, { all: dist(v, active), NWP_SUNSET: dist(v, active.filter(i => pathOf(i) === 'NWP_SUNSET')),
      EVOLUTION: dist(v, active.filter(i => pathOf(i) === 'EVOLUTION')) }])),
    open_probability: Object.fromEntries(['C0', 'W1'].map(v => [v, { mean: mean(active.map(i => traced[v][i].gw.sunset_open_probability)),
      p10: quantile(active.map(i => traced[v][i].gw.sunset_open_probability), .1), p90: quantile(active.map(i => traced[v][i].gw.sunset_open_probability), .9) }])),
    blocking: { mean: mean(active.map(i => blocking[i])), p10: quantile(active.map(i => blocking[i]), .1), p50: quantile(active.map(i => blocking[i]), .5), p90: quantile(active.map(i => blocking[i]), .9) },
    overlap: { blocking_vs_horizon: spearman(active.map(i => blocking[i]), active.map(i => traced.C0[i].comp_horizon)),
      blocking_vs_total_cloud: spearman(active.map(i => blocking[i]), active.map(i => traced.C0[i].features.t_avg)),
      changed_rows: changed.length, changed_rows_with_horizon_below_70: changed.filter(i => traced.C0[i].comp_horizon < 70).length,
      score_drop_rows: changed.filter(i => scores.W1[i] < sC0[i]).length, score_drop_rows_with_horizon_below_70: changed.filter(i => scores.W1[i] < sC0[i] && traced.C0[i].comp_horizon < 70).length } };
  const sc = policy.scenarios, scen = traced.C0.map((t, i) => scenarioOf(t, blocking[i], sc));
  const scenarios = Object.fromEntries(['S_A_SCREEN_NO_ECHO', 'S_B_THICK_NO_ECHO', 'S_C_ECHO'].map(name => {
    const idx = scen.map((s, i) => s === name ? i : -1).filter(i => i >= 0), events = new Set(idx.map(i => rows[i].event_id)).size;
    const miss = v => idx.filter(i => rows[i].gt_ordinal >= 2 && gradeScore(scores[v][i], thresholds) <= 1).length;
    const fa = v => idx.filter(i => rows[i].gt_ordinal <= 1 && gradeScore(scores[v][i], thresholds) >= 2).length;
    return [name, { rows: idx.length, events, status: events >= sc.min_events ? 'COMPUTED' : 'NOT_ESTIMABLE', ge2_rows: idx.filter(i => rows[i].gt_ordinal >= 2).length,
      mean_factor: { C0: mean(idx.map(i => factor('C0', i))), W1: mean(idx.map(i => factor('W1', i))) },
      mean_score: { C0: mean(idx.map(i => sC0[i])), W1: mean(idx.map(i => scores.W1[i])) },
      ge2_missed: { C0: miss('C0'), W1: miss('W1') }, le1_false_alarm: { C0: fa('C0'), W1: fa('W1') } }];
  }));
  const grouped = withGroups(traced.C0, P0_POLICY);
  const groups = { shift_by_C0_group: groupShift(grouped, { C0: traced.C0, W1: traced.W1 }) };
  const surface = Object.fromEntries(policy.versions.filter(v => v !== 'C0').map(v => [v, v === 'W1' ? changeSurface(traced.C0, traced.W1, thresholds) : {
    score_changed: scores[v].filter((s, i) => s !== sC0[i]).length, grade_changed: scores[v].filter((s, i) => gradeScore(s, thresholds) !== gradeScore(sC0[i], thresholds)).length }]));
  const decision = decideGw(metrics, deltas, policy.rules);
  const predictions = scored.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, slot: traced.C0[i].slot,
    gt_ordinal: r.gt_ordinal, gw_active: traced.C0[i].gw.active, gw_path: traced.C0[i].gw.active ? pathOf(i) : null, radar_coverage: traced.C0[i].gw.radar_coverage_now ?? null,
    sun_side_blocking: r6(blocking[i]), horizon_C0: r6(traced.C0[i].comp_horizon), gw_factor_C0: traced.C0[i].gw_factor, gw_factor_W1: traced.W1[i].gw_factor, scenario: scen[i],
    ...Object.fromEntries(policy.versions.flatMap(v => [[`score_${v}`, r[`score_${v}`]], [`ordinal_${v}`, r[`ordinal_${v}`]]])) }));
  return { parity, metrics, comparisons, change_surface: surface, mechanism, scenarios, groups, decision, predictions };
}

const f = v => v == null ? '—' : typeof v === 'number' ? String(Number(v.toFixed(3))) : String(v);
const pass = b => b ? '通过' : '未通过';
const SCEN = { S_A_SCREEN_NO_ECHO: 'S-A 云幕多、无回波', S_B_THICK_NO_ECHO: 'S-B 厚云、无回波', S_C_ECHO: 'S-C 有回波' };
export function renderReport(spec, p) {
  const V = GW_POLICY.versions, m = p.metrics, a = p.decision.W1, mech = p.mechanism, s = p.change_surface.W1;
  const row = (label, k) => `| ${label} | ${V.map(v => f(m[v][k])).join(' | ')} |`;
  const cmp = p.comparisons.map(c => `| ${c.id} | ${['product_loss', 'ge2_recall', 'auc_ge2_primary_last', 'auc_ge3_primary_last'].map(k =>
    `${f(c.point_difference[k])} [${f(c.bootstrap[k].ci95[0])}, ${f(c.bootstrap[k].ci95[1])}]`).join(' | ')} |`).join('\n');
  const gf = (v, k) => { const d = mech.gw_factor[v][k]; return `${d.rows} 行，均值 ${f(d.mean)}，P10/P50/P90 ${f(d.p10)} / ${f(d.p50)} / ${f(d.p90)}`; };
  const scen = Object.entries(p.scenarios).map(([k, x]) => `| ${SCEN[k]} | ${x.rows} / ${x.events}${x.status === 'COMPUTED' ? '' : '（不可估计）'} | ${x.ge2_rows} | ${f(x.mean_factor.C0)} → ${f(x.mean_factor.W1)} | ${f(x.mean_score.C0)} → ${f(x.mean_score.W1)} | ${x.ge2_missed.C0} → ${x.ge2_missed.W1} | ${x.le1_false_alarm.C0} → ${x.le1_false_alarm.W1} |`).join('\n');
  const slots = s.by_slot_base.map((b, i) => `| ${b.slot} | ${b.grades.join(' / ')} | ${s.by_slot_candidate[i].grades.join(' / ')} | ${f(b.mean_score)} / ${f(s.by_slot_candidate[i].mean_score)} |`).join('\n');
  const shift = Object.entries(p.groups.shift_by_C0_group).map(([g, x]) => `| ${g} | ${x.rows} / ${x.ge2_rows} | ${f(x.C0.mean_score)} → ${f(x.W1.mean_score)} | ${x.C0.ge2_missed_rows} → ${x.W1.ge2_missed_rows} | ${f(x.C0.mean_residual)} → ${f(x.W1.mean_residual)} |`).join('\n');
  const ov = mech.overlap;
  return `# V2.5.5.6 黄金窗口云雨信号拆分：DEV 评估

Run：${spec.run_id}。H-GW：P_open = P_cloud（日落时刻太阳侧分层遮挡 B = 低云 + 0.5 × 中云）× P_rain（雷达 × 分钟降水），所有提前量统一。C0 = 2.5.5.4；W1 = C0 + H-GW（reference 按 V2.5.5.2 规则重算为 ${f(p.parity.references.W1)}）；W_TOTAL、W_NORADAR、W1_NOREF 为归因对照，无决策权重。等级线均为 22/47/66/90。数据为 DEV ${p.parity.members} 条复用开发数据（independent_validation=false），未读取 H1，不加入 H1。

## 结论（按 PRD §4.1 规则机械生成，须项目负责人确认）

**${a.status === 'ADOPT_CANDIDATE' ? 'ADOPT_CANDIDATE：W1 可作为候选，确认留待 H2' : 'NO_GAIN：保留现行 GW，结束 H-GW'}。**

| 条件 | W1 − C0 | 结果 |
| --- | --- | --- |
| 产品损失差 < 0 | ${f(a.product_loss_delta)} | ${pass(a.checks.product_loss_lower)} |
| AUC≥2 差 ≥ 0 | ${f(a.auc_ge2_delta)} | ${pass(a.checks.auc_ge2_not_lower)} |
| AUC≥2 差的 95% 上限 > 0 | ${f(a.auc_ge2_delta_ci95_upper)} | ${pass(a.checks.auc_ge2_ci_upper_above_zero)} |
| ≥2 召回差 ≥ −0.02 | ${f(a.ge2_recall_delta)} | ${pass(a.checks.ge2_recall)} |

## 复现与 reference

开关缺键时复现 V2.5.5.2（${p.parity.V2552.prediction_signature_sha256.slice(0, 8)}…）、V2.5.5.1（${p.parity.V2551_prediction_signature_sha256.slice(0, 8)}…）与 V2.5.5.4（${p.parity.V2554.prediction_signature_sha256.slice(0, 8)}…）的固定签名。C0 与 W1 观察器开/关一致；GW 未启用的行在所有候选下逐条不变。

reference 规则用于 C0 得 ${p.parity.reference_rule_on_C0}（V2.5.5.2 固定值 0.826654，差 ${p.parity.reference_rule_difference_vs_V2552}，${p.parity.reference_rule_reproduces_V2552_value ? '在 1e-4 内一致；差异来自观察器的开放概率取两位小数' : '**超出 1e-4**'}）。各候选：${Object.entries(p.parity.references).map(([k, v]) => `${k} ${f(v)}`).join('，')}。

## 指标

| 指标 | ${V.join(' | ')} |
| --- |${V.map(() => ' --- |').join('')}
${row('产品损失', 'product_loss')}
${row('≥2 召回', 'ge2_recall')}
${row('≥2 精确', 'ge2_precision')}
${row('≥3 召回', 'ge3_recall')}
${row('≥3 精确', 'ge3_precision')}
${row('≥3 使用率', 'ge3_usage_rate')}
${row('MAE', 'mae')}
${row('AUC≥2（最近一条）', 'auc_ge2_primary_last')}
${row('AUC≥3（最近一条）', 'auc_ge3_primary_last')}

差值（候选 − 对照），括号为日期块 Bootstrap 95% 区间（${GW_POLICY.bootstrap.replicates} 次）：

| 比较 | 产品损失 | ≥2 召回 | AUC≥2 | AUC≥3 |
| --- | --- | --- | --- | --- |
${cmp}

## 机制

GW 启用 ${mech.active_rows} 行；W1 回落旧逻辑 ${mech.legacy_fallback_rows} 行。

- GW 因子 C0：全部 ${gf('C0', 'all')}；NWP_SUNSET ${gf('C0', 'NWP_SUNSET')}；近日落 ${gf('C0', 'EVOLUTION')}。
- GW 因子 W1：全部 ${gf('W1', 'all')}；NWP_SUNSET ${gf('W1', 'NWP_SUNSET')}；近日落 ${gf('W1', 'EVOLUTION')}。
- 开放概率均值：C0 ${f(mech.open_probability.C0.mean)}（P10/P90 ${f(mech.open_probability.C0.p10)} / ${f(mech.open_probability.C0.p90)}），W1 ${f(mech.open_probability.W1.mean)}（${f(mech.open_probability.W1.p10)} / ${f(mech.open_probability.W1.p90)}）。
- 太阳侧遮挡 B：均值 ${f(mech.blocking.mean)}，P10/P50/P90 ${f(mech.blocking.p10)} / ${f(mech.blocking.p50)} / ${f(mech.blocking.p90)}。
- 与 horizon 的重叠：B 与 horizon 的 Spearman ${f(ov.blocking_vs_horizon.rho)}，与总云量 ${f(ov.blocking_vs_total_cloud.rho)}。W1 分数变化 ${ov.changed_rows} 行，其中 horizon < 70 的 ${ov.changed_rows_with_horizon_below_70} 行；分数下降 ${ov.score_drop_rows} 行，其中 horizon < 70 的 ${ov.score_drop_rows_with_horizon_below_70} 行。

全部 ${p.parity.members} 行：分数变化 ${s.score_changed} 行（↑${s.score_up} ↓${s.score_down}），平均 ${f(s.mean_delta)}，范围 ${s.max_down} ~ +${s.max_up}；等级变化 ${s.grade_changed} 行（↑${s.grade_up}）。

| 时段 | C0 等级 0/1/2/3/4 | W1 | 平均分 C0 / W1 |
| --- | --- | --- | --- |
${slots}

## 场景（无决策权重）

| 场景 | 行 / Event | GT≥2 行 | 平均 GW 因子 C0 → W1 | 平均分 | GT≥2 漏报行 | GT≤1 误报行 |
| --- | --- | --- | --- | --- | --- | --- |
${scen}

"雨后残云"无法评估：DEV 没有雨天样本。

## 分组（P0 主阈值，C0 互斥分组；无决策权重）

| 组 | 行 / GT≥2 行 | 平均分 C0 → W1 | GT≥2 漏报行 | 平均残差 |
| --- | --- | --- | --- | --- |
${shift}

## 限制

本期是同一批 DEV 上检验的第三个假设（2.5.5.4、2.5.5.5 之后），DEV 上的改进偏乐观；B 与 horizon 同源（见重叠统计）；GT≥3 约 21 个 Event。确认只能依赖 H1 之后的前向数据（H2）。
`;
}

export async function runGw(options, progress = () => {}) {
  const loaded = await loadPool(options, progress), code = await codeIdentity();
  assertDev(loaded, GW_POLICY);
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const root of Object.values(loaded.roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const configs = await releaseConfigs();
  const identity = { schema: 12, policy: GW_POLICY, plan_sha256: digest(GW_POLICY), inputs: loaded.fingerprints, base_config_sha256: digest(configs['2.5.5.4']),
    code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version };
  const runId = `practical_tuning_v12_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectGw(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: 12, practical_tuning_policy_version: 12, run_id: runId, identity, code, sources: loaded.roots, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'gw_plan.json'), GW_POLICY);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeGw(loaded, code, progress), payloadSha = digest(payload);
    // Render before the fresh-process recompute so a report error cannot leave a verified but unpublished run behind.
    const report = renderReport(spec, payload).replace(/\r?\n/g, '\r\n');
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算评估 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH');
    const result = { run_id: runId, status: 'COMPLETED', usage: GW_POLICY.usage, evaluation_scope: GW_POLICY.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, recommendation: payload.decision.recommendation, references: payload.parity.references, V2556_computed_reference: payload.parity.V2556_computed_reference };
    const files = { 'parity.json': payload.parity, 'metrics.json': payload.metrics, 'comparisons.json': payload.comparisons, 'change_surface.json': payload.change_surface,
      'mechanism.json': payload.mechanism, 'scenarios.json': payload.scenarios, 'groups.json': payload.groups, 'decision.json': payload.decision, 'gw_result.json': result, 'verification.json': proof };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'predictions.csv'), csv(payload.predictions));
    await writeFile(path.join(work, 'report.md'), report, 'utf8');
    await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl');
    let historyRows = []; if (await exists(history)) historyRows = (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!historyRows.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, model: loaded.source_ids.model, usage: GW_POLICY.usage,
      evaluation_scope: GW_POLICY.evaluation_scope, independent_validation: false, members: payload.predictions.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id })),
      selection_status: 'FIXED_CANDIDATE_EVALUATION_NO_SEARCH' }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: 12, practical_tuning_policy_version: 12, run_id: runId, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { ...result, directory: target };
  } catch (e) {
    if (await exists(path.join(work, 'run_spec.json'))) await atomicJson(path.join(work, 'state.json'), { status: 'EXECUTION_ERROR', error_code: errorCode(e), run_id: runId });
    throw e;
  } finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
export async function inspectGw(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== 12 || manifest.practical_tuning_policy_version !== 12) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of ['run_spec.json', 'gw_plan.json', 'parity.json', 'metrics.json', 'comparisons.json', 'scenarios.json', 'decision.json', 'gw_result.json',
    'predictions.csv', 'verification_request.json', 'verification.json', 'report.md']) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'gw_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v12_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'gw_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyGwRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(GW_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPool(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeGw(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  await checkInputs(loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyGw(directory) {
  const inspected = await inspectGw(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
