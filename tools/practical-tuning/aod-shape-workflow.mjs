// V2.5.5.5 AOD response shape: DEV evaluation (Practical Tuning Schema/Policy 11, PRD V2.5.5.5 §4). Single hypothesis H-AOD:
// the AOD score stops penalising clean air (AOD <= aodCenter scores 100; above it the original Gaussian). C0 = 2.5.5.4,
// A1 = C0 + HALF_GAUSSIAN; the same pair on 2.5.5.2 (B0/B1) is a robustness row only. Nothing is tuned.
import path from 'node:path';
import { mkdir, writeFile, rename, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../dataset/lib/common.mjs';
import { scoreToOrdinal, gradeScore } from '../evaluation/metrics.mjs';
import { releaseConfigs, bootstrapDeltas, primaryLast, weightedAuc } from '../model-release/holdout.mjs';
import { SKY_OFF_REFERENCE, V2552_REFERENCE, V2554_REFERENCE, V2555_REFERENCE, aodCandidateScoring } from '../model-release/release.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { preflight, gradeThresholdsOf } from './compute.mjs';
import { highCloudMetrics } from './high-cloud.mjs';
import { digest } from './policy.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { acquireRunLock, atomicJson, csv } from './workflow.mjs';
import { P0_POLICY } from './p0-features.mjs';
import { d1, withGroups } from './p0-diagnostics.mjs';
import { p0Calculator, analysisRow } from './p0-workflow.mjs';
import { changeSurface, groupShift } from './horizon-fix-workflow.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const freeze = value => Object.freeze(value);

export const AOD_POLICY = freeze({
  practical_tuning_schema_version: 11, practical_tuning_policy_version: 11,
  search_space: 'aod-shape', usage: 'PERSONAL_PROJECT_EVALUATION', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  dev: P0_POLICY.dev, first_holdout_date: P0_POLICY.first_holdout_date,
  hypothesis: 'H-AOD: AOD_SCORE = 100 FOR AOD <= aodCenter, ELSE gauss(AOD; aodCenter, aodWidth); aodCenter AND aodWidth UNCHANGED',
  versions: freeze(['C0', 'A1', 'B0', 'B1']),
  bases: freeze({ C0: '2.5.5.4', A1: '2.5.5.4 + HALF_GAUSSIAN', B0: '2.5.5.2', B1: '2.5.5.2 + HALF_GAUSSIAN' }),
  comparisons: freeze([freeze({ id: 'A1_VS_C0', candidate: 'A1', control: 'C0' }), freeze({ id: 'B1_VS_B0', candidate: 'B1', control: 'B0' })]),
  bootstrap: freeze({ replicates: 2000, block: 'event_date_local', seed: 'V2555_AOD_SHAPE_EVAL_1' }),
  // PRD V2.5.5.5 §4.1 (decision 2): an improvement hypothesis must improve the point estimates.
  rules: freeze({ product_loss_delta_below: 0, auc_ge2_point_delta_at_least: 0, auc_ge2_ci_upper_must_exceed: 0, ge2_recall_max_drop: 0.02 }),
  // P0 (Run practical_tuning_v9_561f773d7e43a9045dc3) equal-frequency AOD bins: 0.06–0.21 / 0.22–0.31 / 0.32–0.38 / 0.39–0.60 / 0.62–1.30.
  aod_bin_upper: freeze([0.215, 0.315, 0.385, 0.61]),
  decision_rules_version: 1
});

function assertDev(loaded, policy) {
  const d = policy.dev;
  if (loaded.source_ids.raw !== d.raw || loaded.source_ids.gt !== d.gt || loaded.source_ids.model !== d.model) fail('AOD_DEV_IDENTITY_MISMATCH');
  if (loaded.rows.some(r => r.event_date_local >= policy.first_holdout_date)) fail('AOD_HOLDOUT_DATE_REJECTED');
  if (loaded.exclusions.length || loaded.rows.length !== d.snapshots) fail('AOD_DEV_POOL_INCOMPLETE');
}
export function aodConfigs(configs) {
  return { C0: configs['2.5.5.4'], A1: aodCandidateScoring(configs['2.5.5.4']), B0: configs['2.5.5.2'], B1: aodCandidateScoring(configs['2.5.5.2']) };
}
async function collect(rows, config, calculator, progress, label) {
  const thresholds = gradeThresholdsOf(config), out = [];
  for (const [i, row] of rows.entries()) {
    out.push(analysisRow(row, await calculator.calculate(row, config, true), config, thresholds));
    if ((i + 1) % 100 === 0 || i + 1 === rows.length) progress(`${label} Trace ${i + 1}/${rows.length}`);
  }
  return out;
}
const r6 = v => typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const mean = v => { const x = v.filter(Number.isFinite); return x.length ? r6(x.reduce((a, b) => a + b, 0) / x.length) : null; };
const finite = v => typeof v === 'number' && Number.isFinite(v);
export const affectedByAod = (aod, center) => finite(aod) && aod < center;
export const aodBin = (aod, upper) => finite(aod) ? upper.filter(u => aod >= u).length + 1 : null;

// Calibration by the frozen P0 AOD bins on PRIMARY_LAST Events (GT confidence weights).
export function aodBins(last, upper, versions) {
  const w = rs => rs.reduce((s, r) => s + r.gt_confidence, 0);
  return [1, 2, 3, 4, 5].map(bin => {
    const rs = last.filter(r => r.aod_bin === bin), W = w(rs);
    return { bin, events: rs.length, ge2_rate: W ? r6(w(rs.filter(r => r.gt_ordinal >= 2)) / W) : null,
      ...Object.fromEntries(versions.map(v => [v, { mean_score: mean(rs.map(r => r[`score_${v}`])),
        predicted_ge2_share: W ? r6(w(rs.filter(r => r[`ordinal_${v}`] >= 2)) / W) : null }])) };
  });
}
export function decideAod(metrics, deltas, rules) {
  const verdict = (cand, ctl, id) => {
    const loss = r6(metrics[cand].product_loss - metrics[ctl].product_loss), recall = r6(metrics[cand].ge2_recall - metrics[ctl].ge2_recall);
    const auc = r6(metrics[cand].auc_ge2_primary_last - metrics[ctl].auc_ge2_primary_last), upper = deltas[id].auc_ge2_primary_last.ci95[1];
    const checks = { product_loss_lower: loss < rules.product_loss_delta_below, auc_ge2_not_lower: auc >= rules.auc_ge2_point_delta_at_least,
      auc_ge2_ci_upper_above_zero: upper != null && upper > rules.auc_ge2_ci_upper_must_exceed, ge2_recall: recall >= -rules.ge2_recall_max_drop };
    return { status: Object.values(checks).every(Boolean) ? 'ADOPT_CANDIDATE' : 'NO_GAIN', checks,
      product_loss_delta: loss, auc_ge2_delta: auc, auc_ge2_delta_ci95_upper: r6(upper), ge2_recall_delta: recall };
  };
  const primary = verdict('A1', 'C0', 'A1_VS_C0'), robustness = verdict('B1', 'B0', 'B1_VS_B0');
  const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
  return { decision_rules_version: AOD_POLICY.decision_rules_version, rules, A1: primary, recommendation: primary.status,
    robustness_B1_vs_B0: { ...robustness, decision_weight: 'NONE',
      same_direction: sign(primary.product_loss_delta) === sign(robustness.product_loss_delta) && sign(primary.auc_ge2_delta) === sign(robustness.auc_ge2_delta) },
    decision_owner: 'PROJECT_OWNER' };
}

// Deterministic payload; recomputed in a fresh process before publication and by verify.
export async function computeAod(loaded, code, progress = () => {}, policy = AOD_POLICY) {
  assertDev(loaded, policy);
  const configs = await releaseConfigs(), cfg = aodConfigs(configs), R = configs['2.5.5.1'], calculator = p0Calculator(code.engine_sha256);
  const thresholds = gradeThresholdsOf(cfg.C0);
  if (policy.versions.some(v => digest(gradeThresholdsOf(cfg[v])) !== digest(thresholds))) fail('AOD_GRADE_LINES_CHANGED');
  progress('B0（2.5.5.2）预检');
  const checked = await preflight(loaded, cfg.B0, calculator, progress);
  if (checked.exclusions.length) fail('AOD_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scores = { B0: rows.map(r => r.control_score) }, scoresR = [];
  for (const row of rows) scoresR.push((await calculator.calculate(row, R)).score);
  for (const v of ['C0', 'B1']) { scores[v] = []; for (const row of rows) scores[v].push((await calculator.calculate(row, cfg[v])).score); }
  progress('复现核对');
  const signature = s => digest(rows.map((r, i) => [r.snapshot_id, s[i], gradeScore(s[i], thresholds)]));
  const v2552 = { prediction_signature_sha256: signature(scores.B0), product_loss: highCloudMetrics(rows, scores.B0, thresholds).product_loss,
    score_changed_vs_V2551: scores.B0.filter((s, i) => s !== scoresR[i]).length,
    grade_changed_vs_V2551: scores.B0.filter((s, i) => gradeScore(s, thresholds) !== scoreToOrdinal(scoresR[i])).length };
  if (digest(v2552) !== digest(V2552_REFERENCE)) fail('AOD_V2552_PARITY_FAILED');
  const rSignature = digest(rows.map((r, i) => [r.snapshot_id, scoresR[i], scoreToOrdinal(scoresR[i])]));
  if (rSignature !== SKY_OFF_REFERENCE.prediction_signature_sha256) fail('AOD_V2551_PARITY_FAILED');
  const v2554 = { prediction_signature_sha256: signature(scores.C0), product_loss: highCloudMetrics(rows, scores.C0, thresholds).product_loss,
    score_changed_vs_V2552: scores.C0.filter((s, i) => s !== scores.B0[i]).length,
    grade_changed_vs_V2552: scores.C0.filter((s, i) => gradeScore(s, thresholds) !== gradeScore(scores.B0[i], thresholds)).length };
  if (digest(v2554) !== digest(V2554_REFERENCE)) fail('AOD_V2554_PARITY_FAILED');
  const traced = { C0: await collect(rows, cfg.C0, calculator, progress, 'C0'), A1: await collect(rows, cfg.A1, calculator, progress, 'A1') };
  if (traced.C0.some((t, i) => t.score !== scores.C0[i])) fail('AOD_OBSERVER_CHANGED_SCORES');
  scores.A1 = []; for (const row of rows) scores.A1.push((await calculator.calculate(row, cfg.A1)).score);
  if (traced.A1.some((t, i) => t.score !== scores.A1[i])) fail('AOD_OBSERVER_CHANGED_SCORES');
  // Invariant of the hypothesis: rows without AOD below the centre are untouched; affected rows can only rise.
  const center = cfg.C0.aodCenter, affected = traced.C0.map(t => affectedByAod(t.features.aod, center));
  for (const [base, cand] of [['C0', 'A1'], ['B0', 'B1']]) {
    if (scores[cand].some((s, i) => !affected[i] && s !== scores[base][i])) fail('AOD_UNAFFECTED_ROW_CHANGED', { detail: cand });
    if (scores[cand].some((s, i) => s < scores[base][i])) fail('AOD_SCORE_DECREASED', { detail: cand });
  }
  const scored = rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, gt_ordinal: r.gt_ordinal,
    gt_confidence: r.gt_confidence, event_normalized_weight: r.event_normalized_weight, lead_time_minutes: r.lead_time_minutes, location_key: r.location_key,
    aod: traced.C0[i].features.aod, aod_bin: aodBin(traced.C0[i].features.aod, policy.aod_bin_upper),
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
  const v2555 = { prediction_signature_sha256: signature(scores.A1), product_loss: metrics.A1.product_loss,
    score_changed_vs_V2554: scores.A1.filter((s, i) => s !== scores.C0[i]).length,
    grade_changed_vs_V2554: scores.A1.filter((s, i) => gradeScore(s, thresholds) !== gradeScore(scores.C0[i], thresholds)).length };
  if (V2555_REFERENCE.prediction_signature_sha256 !== null && digest(v2555) !== digest(V2555_REFERENCE)) fail('AOD_V2555_REFERENCE_MISMATCH');
  const parity = { status: 'PASS', members: rows.length, V2552: v2552, V2551_prediction_signature_sha256: rSignature, V2554: v2554,
    key_absent_reproduces_V2552_and_V2554: true, observer_on_off_identical: ['C0', 'A1'], unaffected_rows_identical: true, affected_rows_never_decrease: true,
    engine_sha256: code.engine_sha256, config_sha256: Object.fromEntries(policy.versions.map(v => [v, digest(cfg[v])])), V2555_computed_reference: v2555 };
  progress('机制、分箱与分组');
  const idx = affected.map((a, i) => a ? i : -1).filter(i => i >= 0);
  const mechanism = { aod_center: center, aod_available_rows: traced.C0.filter(t => finite(t.features.aod)).length, affected_rows: idx.length,
    affected_events: new Set(idx.map(i => rows[i].event_id)).size, affected_primary_last_events: last.filter(r => affectedByAod(r.aod, center)).length,
    atmosphere_mean_delta_affected: mean(idx.map(i => traced.A1[i].comp_atmosphere - traced.C0[i].comp_atmosphere)),
    Q_mean_delta_affected: mean(idx.map(i => traced.A1[i].Q - traced.C0[i].Q)), score_mean_delta_affected: mean(idx.map(i => scores.A1[i] - scores.C0[i])),
    affected_gt_ge2_share: idx.length ? r6(idx.filter(i => rows[i].gt_ordinal >= 2).length / idx.length) : null };
  const grouped = { C0: withGroups(traced.C0, P0_POLICY), A1: withGroups(traced.A1, P0_POLICY) };
  const D1 = Object.fromEntries(Object.entries(grouped).map(([v, g]) => [v, d1(g, P0_POLICY)]));
  const groups = { shift_by_C0_group: groupShift(grouped.C0, traced), d1_primary_last: Object.fromEntries(Object.entries(D1).map(([v, x]) => [v, x.sets.primary.PRIMARY_LAST])) };
  const surface = { A1: changeSurface(traced.C0, traced.A1, thresholds),
    B1: { score_changed: scores.B1.filter((s, i) => s !== scores.B0[i]).length, grade_changed: scores.B1.filter((s, i) => gradeScore(s, thresholds) !== gradeScore(scores.B0[i], thresholds)).length } };
  const bins = aodBins(last, policy.aod_bin_upper, ['C0', 'A1']);
  const decision = decideAod(metrics, deltas, policy.rules);
  const predictions = scored.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, slot: traced.C0[i].slot,
    gt_ordinal: r.gt_ordinal, aod: r.aod, aod_bin: r.aod_bin, affected: affected[i], ...Object.fromEntries(policy.versions.flatMap(v => [[`score_${v}`, r[`score_${v}`]], [`ordinal_${v}`, r[`ordinal_${v}`]]])),
    atmosphere_C0: r6(traced.C0[i].comp_atmosphere), atmosphere_A1: r6(traced.A1[i].comp_atmosphere), group_C0: grouped.C0[i].groups.primary.exclusive }));
  return { parity, metrics, comparisons, change_surface: surface, mechanism, aod_bins: bins, groups, decision, predictions };
}

const f = v => v == null ? '—' : typeof v === 'number' ? String(Number(v.toFixed(3))) : String(v);
const pass = b => b ? '通过' : '未通过';
export function renderReport(spec, p) {
  const V = AOD_POLICY.versions, m = p.metrics, dec = p.decision, a = dec.A1, rb = dec.robustness_B1_vs_B0;
  const row = (label, k) => `| ${label} | ${V.map(v => f(m[v][k])).join(' | ')} |`;
  const cmp = p.comparisons.map(c => `| ${c.id} | ${['product_loss', 'ge2_recall', 'auc_ge2_primary_last', 'auc_ge3_primary_last'].map(k =>
    `${f(c.point_difference[k])} [${f(c.bootstrap[k].ci95[0])}, ${f(c.bootstrap[k].ci95[1])}]`).join(' | ')} |`).join('\n');
  const s = p.change_surface.A1, mech = p.mechanism;
  const slots = s.by_slot_base.map((b, i) => `| ${b.slot} | ${b.grades.join(' / ')} | ${s.by_slot_candidate[i].grades.join(' / ')} | ${f(b.mean_score)} / ${f(s.by_slot_candidate[i].mean_score)} |`).join('\n');
  const bins = p.aod_bins.map(b => `| ${b.bin} | ${b.events} | ${f(b.ge2_rate)} | ${f(b.C0.mean_score)} → ${f(b.A1.mean_score)} | ${f(b.C0.predicted_ge2_share)} → ${f(b.A1.predicted_ge2_share)} |`).join('\n');
  const shift = Object.entries(p.groups.shift_by_C0_group).map(([g, x]) => `| ${g} | ${x.rows} / ${x.ge2_rows} | ${f(x.C0.mean_score)} → ${f(x.A1.mean_score)} | ${x.C0.ge2_missed_rows} → ${x.A1.ge2_missed_rows} | ${f(x.C0.mean_residual)} → ${f(x.A1.mean_residual)} |`).join('\n');
  const g3 = v => p.groups.d1_primary_last[v].G3;
  return `# V2.5.5.5 大气函数 AOD 单调响应：DEV 评估

Run：${spec.run_id}。单一假设 H-AOD：AOD ≤ ${mech.aod_center} 时 AOD 评分为 100，高于时为原高斯（中心与宽度不变）。C0 = 2.5.5.4，A1 = C0 + H-AOD；B0 = 2.5.5.2，B1 = B0 + H-AOD（稳健性，无决策权重）。等级线均为 22/47/66/90。数据为 DEV ${p.parity.members} 条复用开发数据（independent_validation=false），未读取 H1。

## 结论（按 PRD §4.1 规则机械生成，须项目负责人确认）

**${a.status === 'ADOPT_CANDIDATE' ? 'ADOPT_CANDIDATE：A1 可作为候选' : 'NO_GAIN：保留高斯形状，结束这个假设'}。**

| 条件 | 值 | 结果 |
| --- | --- | --- |
| 产品损失差 < 0 | ${f(a.product_loss_delta)} | ${pass(a.checks.product_loss_lower)} |
| AUC≥2 差 ≥ 0 | ${f(a.auc_ge2_delta)} | ${pass(a.checks.auc_ge2_not_lower)} |
| AUC≥2 差的 95% 上限 > 0 | ${f(a.auc_ge2_delta_ci95_upper)} | ${pass(a.checks.auc_ge2_ci_upper_above_zero)} |
| ≥2 召回差 ≥ −0.02 | ${f(a.ge2_recall_delta)} | ${pass(a.checks.ge2_recall)} |

稳健性（B1 对 B0，无决策权重）：${rb.status}，产品损失差 ${f(rb.product_loss_delta)}，AUC≥2 差 ${f(rb.auc_ge2_delta)}；与 A1 方向${rb.same_direction ? '一致' : '**不一致**'}。

## 复现

开关缺键时复现 V2.5.5.2（${p.parity.V2552.prediction_signature_sha256.slice(0, 8)}…）、V2.5.5.1（${p.parity.V2551_prediction_signature_sha256.slice(0, 8)}…）与 V2.5.5.4（${p.parity.V2554.prediction_signature_sha256.slice(0, 8)}…）的固定签名。C0 与 A1 观察器开/关分数逐条一致。AOD 不低于中心或缺失的行，A1/B1 分数与对照逐条相同；受影响行分数只升不降。

## 指标

| 指标 | C0 | A1 | B0 | B1 |
| --- | --- | --- | --- | --- |
${row('产品损失', 'product_loss')}
${row('≥2 召回', 'ge2_recall')}
${row('≥2 精确', 'ge2_precision')}
${row('≥3 召回', 'ge3_recall')}
${row('≥3 精确', 'ge3_precision')}
${row('≥3 使用率', 'ge3_usage_rate')}
${row('MAE', 'mae')}
${row('Bias', 'bias')}
${row('AUC≥2（最近一条）', 'auc_ge2_primary_last')}
${row('AUC≥3（最近一条）', 'auc_ge3_primary_last')}

差值（候选 − 对照），括号为日期块 Bootstrap 95% 区间（${AOD_POLICY.bootstrap.replicates} 次）：

| 比较 | 产品损失 | ≥2 召回 | AUC≥2 | AUC≥3 |
| --- | --- | --- | --- | --- |
${cmp}

## 影响面与机制（A1 对 C0）

AOD 有值 ${mech.aod_available_rows} 行；受影响（AOD < ${mech.aod_center}）${mech.affected_rows} 行 / ${mech.affected_events} 个 Event（最近一条 ${mech.affected_primary_last_events} 个），其中 GT≥2 占 ${f(mech.affected_gt_ge2_share)}。受影响行平均：atmosphere +${f(mech.atmosphere_mean_delta_affected)}，Q +${f(mech.Q_mean_delta_affected)}，分数 +${f(mech.score_mean_delta_affected)}。

全部 ${p.parity.members} 行：分数变化 ${s.score_changed} 行（↑${s.score_up}），平均 +${f(s.mean_delta)}，最大 +${s.max_up}；等级变化 ${s.grade_changed} 行（↑${s.grade_up}）。B1 对 B0：分数变化 ${p.change_surface.B1.score_changed} 行，等级变化 ${p.change_surface.B1.grade_changed} 行。

| 时段 | C0 等级 0/1/2/3/4 | A1 | 平均分 C0 / A1 |
| --- | --- | --- | --- |
${slots}

AOD 分箱（P0 箱界，最近一条）：

| 箱 | Event | GT≥2 比例 | 平均分 C0 → A1 | 预测 ≥2 占比 C0 → A1 |
| --- | --- | --- | --- | --- |
${bins}

## 次要观察：分组（无决策权重）

| 组（C0 互斥分组） | 行 / GT≥2 行 | 平均分 | GT≥2 漏报行 | 平均残差 |
| --- | --- | --- | --- | --- |
${shift}

G3（PRIMARY_LAST）：漏报率 ${f(g3('C0').metrics.miss?.group)} → ${f(g3('A1').metrics.miss?.group)}，残差差 ${f(g3('C0').metrics.residual.difference?.point)} → ${f(g3('A1').metrics.residual.difference?.point)}。

## 限制

H-AOD 来自 P0 在同一 DEV 上的分箱，虽不调参数，结果仍偏乐观；GT≥3 约 21 个 Event。规则要求点估计变好，差值通常不显著；独立确认依赖 H1（是否加入见 PRD 决策 4）。
`;
}

export async function runAod(options, progress = () => {}) {
  const loaded = await loadPool(options, progress), code = await codeIdentity();
  assertDev(loaded, AOD_POLICY);
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const root of Object.values(loaded.roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const cfg = aodConfigs(await releaseConfigs());
  const identity = { schema: 11, policy: AOD_POLICY, plan_sha256: digest(AOD_POLICY), inputs: loaded.fingerprints,
    config_sha256: Object.fromEntries(AOD_POLICY.versions.map(v => [v, digest(cfg[v])])), code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version };
  const runId = `practical_tuning_v11_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectAod(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: 11, practical_tuning_policy_version: 11, run_id: runId, identity, code, sources: loaded.roots, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'aod_plan.json'), AOD_POLICY);
    await atomicJson(path.join(work, 'configs.json'), cfg);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeAod(loaded, code, progress), payloadSha = digest(payload);
    // Render before the fresh-process recompute so a report error cannot leave a verified but unpublished run behind.
    const report = renderReport(spec, payload).replace(/\r?\n/g, '\r\n');
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算评估 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH');
    const result = { run_id: runId, status: 'COMPLETED', usage: AOD_POLICY.usage, evaluation_scope: AOD_POLICY.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, recommendation: payload.decision.recommendation, robustness_same_direction: payload.decision.robustness_B1_vs_B0.same_direction,
      V2555_computed_reference: payload.parity.V2555_computed_reference };
    const files = { 'parity.json': payload.parity, 'metrics.json': payload.metrics, 'comparisons.json': payload.comparisons, 'change_surface.json': payload.change_surface,
      'mechanism.json': payload.mechanism, 'aod_bins.json': payload.aod_bins, 'groups.json': payload.groups, 'decision.json': payload.decision, 'aod_result.json': result, 'verification.json': proof };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'predictions.csv'), csv(payload.predictions));
    await writeFile(path.join(work, 'report.md'), report, 'utf8');
    await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl');
    let historyRows = []; if (await exists(history)) historyRows = (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!historyRows.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, model: loaded.source_ids.model, usage: AOD_POLICY.usage,
      evaluation_scope: AOD_POLICY.evaluation_scope, independent_validation: false, members: payload.predictions.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id })),
      selection_status: 'FIXED_CANDIDATE_EVALUATION_NO_SEARCH' }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: 11, practical_tuning_policy_version: 11, run_id: runId, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { ...result, directory: target };
  } catch (e) {
    if (await exists(path.join(work, 'run_spec.json'))) await atomicJson(path.join(work, 'state.json'), { status: 'EXECUTION_ERROR', error_code: errorCode(e), run_id: runId });
    throw e;
  } finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
export async function inspectAod(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== 11 || manifest.practical_tuning_policy_version !== 11) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of ['run_spec.json', 'aod_plan.json', 'configs.json', 'parity.json', 'metrics.json', 'comparisons.json', 'decision.json', 'aod_result.json',
    'predictions.csv', 'verification_request.json', 'verification.json', 'report.md']) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'aod_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v11_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'aod_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyAodRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(AOD_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPool(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeAod(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  await checkInputs(loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyAod(directory) {
  const inspected = await inspectAod(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
