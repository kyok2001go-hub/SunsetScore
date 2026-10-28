// V2.5.5.4 horizon centre-node fix: DEV evaluation (Practical Tuning Schema/Policy 10, PRD V2.5.5.4 §4). Compares the release
// line 2.5.5.2 (C0) with the corridor-centre azimuth fix limited to the horizon sectors (FIX_H) and applied to every consumer
// (FIX_ALL). Nothing is tuned and no default changes; the recommendation follows the pre-registered rules mechanically.
import path from 'node:path';
import { mkdir, writeFile, rename, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../dataset/lib/common.mjs';
import { scoreToOrdinal, gradeScore } from '../evaluation/metrics.mjs';
import { releaseConfigs, bootstrapDeltas, primaryLast, weightedAuc } from '../model-release/holdout.mjs';
import { SKY_OFF_REFERENCE, V2552_REFERENCE, V2554_REFERENCE, candidateReleaseScoring } from '../model-release/release.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { preflight, gradeThresholdsOf } from './compute.mjs';
import { highCloudMetrics } from './high-cloud.mjs';
import { digest } from './policy.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { acquireRunLock, atomicJson, csv } from './workflow.mjs';
import { P0_POLICY } from './p0-features.mjs';
import { d1, withGroups } from './p0-diagnostics.mjs';
import { p0Calculator, analysisRow } from './p0-workflow.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const freeze = value => Object.freeze(value);

export const HFIX_POLICY = freeze({
  practical_tuning_schema_version: 10, practical_tuning_policy_version: 10,
  search_space: 'horizon-fix', usage: 'PERSONAL_PROJECT_EVALUATION', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  dev: P0_POLICY.dev, first_holdout_date: P0_POLICY.first_holdout_date,
  baseline: 'RELEASE_LINE_2.5.5.2', candidates: freeze({ FIX_H: 'HORIZON', FIX_ALL: 'ALL' }),
  versions: freeze(['C0', 'FIX_H', 'FIX_ALL']),
  comparisons: freeze([freeze({ id: 'FIX_H_VS_C0', candidate: 'FIX_H', control: 'C0' }), freeze({ id: 'FIX_ALL_VS_C0', candidate: 'FIX_ALL', control: 'C0' }),
    freeze({ id: 'FIX_ALL_VS_FIX_H', candidate: 'FIX_ALL', control: 'FIX_H' })]),
  // Same resampling as the H1 check (date blocks, floor percentile), so DEV and H1 differences are read the same way.
  bootstrap: freeze({ replicates: 2000, block: 'event_date_local', seed: 'V2554_HORIZON_FIX_EVAL_1' }),
  // PRD V2.5.5.4 §4 (decision 2): a correctness fix must not be clearly worse; it need not be significantly better.
  rules: freeze({ product_loss_max_increase: 0.01, ge2_recall_max_drop: 0.05, auc_ge2_ci_upper_must_exceed: 0 }),
  decision_rules_version: 1
});

function assertDev(loaded, policy) {
  const d = policy.dev;
  if (loaded.source_ids.raw !== d.raw || loaded.source_ids.gt !== d.gt || loaded.source_ids.model !== d.model) fail('HFIX_DEV_IDENTITY_MISMATCH');
  if (loaded.rows.some(r => r.event_date_local >= policy.first_holdout_date)) fail('HFIX_HOLDOUT_DATE_REJECTED');
  if (loaded.exclusions.length || loaded.rows.length !== d.snapshots) fail('HFIX_DEV_POOL_INCOMPLETE');
}
export function evaluationConfigs(configs) {
  const C0 = configs['2.5.5.2'], out = { C0, FIX_H: candidateReleaseScoring(C0, { scope: 'HORIZON' }), FIX_ALL: candidateReleaseScoring(C0) };
  // FIX_ALL is exactly the 2.5.5.4 that the H1 check (holdout Policy 2) will recompute.
  if (digest(out.FIX_ALL) !== digest(configs['2.5.5.4'])) fail('HFIX_CANDIDATE_DIFFERS_FROM_H1_CONFIG');
  return out;
}
async function collect(rows, config, calculator, progress, label) {
  const thresholds = gradeThresholdsOf(config), out = [];
  for (const [i, row] of rows.entries()) {
    const result = await calculator.calculate(row, config, true);
    out.push({ ...analysisRow(row, result, config, thresholds), structure: result.trace.diagnostic_observer.engine_structure });
    if ((i + 1) % 100 === 0 || i + 1 === rows.length) progress(`${label} Trace ${i + 1}/${rows.length}`);
  }
  return out;
}
const r6 = v => typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const mean = v => { const x = v.filter(Number.isFinite); return x.length ? r6(x.reduce((a, b) => a + b, 0) / x.length) : null; };
const quantile = (v, p) => { const x = v.filter(Number.isFinite).sort((a, b) => a - b); return x.length ? x[Math.min(x.length - 1, Math.floor(p * x.length))] : null; };
const tally = values => Object.fromEntries([...new Set(values.map(String))].sort().map(k => [k, values.filter(v => String(v) === k).length]));

export function mechanism(traced, scoring) {
  const horizon = traced.map(t => t.comp_horizon);
  return { horizon: { mean: mean(horizon), p10: quantile(horizon, .1), p50: quantile(horizon, .5), p90: quantile(horizon, .9) },
    bank_sector_valid_rows: traced.filter(t => t.structure.sector_openings?.bank != null).length,
    hard_gate_horizon_rows: traced.filter(t => t.comp_horizon < scoring.hardGate.horizonOpeningPct).length,
    horizon_gate_tiers: tally(traced.map(t => t.horizon_gate)),
    contrast_mean: mean(traced.map(t => t.structure.contrast)), center_cloud_mean: mean(traced.map(t => t.structure.center_cloud)),
    bank_score_mean: mean(traced.map(t => t.structure.bank_score)), gradient_types: tally(traced.map(t => t.structure.gradient_type)),
    component_means: Object.fromEntries(['sky_canvas', 'horizon', 'illumination', 'atmosphere'].map(c => [c, mean(traced.map(t => t[`comp_${c}`]))])),
    structure_bonus_mean: mean(traced.map(t => t.structure_bonus)) };
}
export function changeSurface(base, cand, thresholds) {
  const d = cand.map((t, i) => t.score - base[i].score), slots = [...new Set(base.map(t => t.slot))].sort();
  const dist = rows => slots.map(s => ({ slot: s, grades: [0, 1, 2, 3, 4].map(g => rows.filter(t => t.slot === s && gradeScore(t.score, thresholds) === g).length),
    mean_score: mean(rows.filter(t => t.slot === s).map(t => t.score)) }));
  return { score_changed: d.filter(v => v !== 0).length, score_up: d.filter(v => v > 0).length, score_down: d.filter(v => v < 0).length,
    mean_delta: mean(d), mean_abs_delta: mean(d.map(Math.abs)), max_up: Math.max(0, ...d), max_down: Math.min(0, ...d),
    grade_changed: cand.filter((t, i) => gradeScore(t.score, thresholds) !== gradeScore(base[i].score, thresholds)).length,
    grade_up: cand.filter((t, i) => gradeScore(t.score, thresholds) > gradeScore(base[i].score, thresholds)).length,
    horizon_mean_delta: mean(cand.map((t, i) => t.comp_horizon - base[i].comp_horizon)), by_slot_base: dist(base), by_slot_candidate: dist(cand) };
}
// Per C0 mechanism group (primary thresholds, exclusive): mean score change and miss counts under each version.
export function groupShift(groupedC0, tracedByVersion) {
  return Object.fromEntries(['G1', 'G2', 'G3', 'G4', 'G0'].map(g => {
    const idx = groupedC0.map((r, i) => [r, i]).filter(([r]) => r.groups.primary.exclusive === g).map(([, i]) => i);
    const ge2 = idx.filter(i => groupedC0[i].gt_ordinal >= 2);
    return [g, { rows: idx.length, ge2_rows: ge2.length, ...Object.fromEntries(Object.entries(tracedByVersion).map(([v, rows]) => [v, {
      mean_score: mean(idx.map(i => rows[i].score)), ge2_missed_rows: ge2.filter(i => rows[i].ordinal <= 1).length,
      mean_residual: mean(idx.map(i => rows[i].ordinal - rows[i].gt_ordinal)) }])) }];
  }));
}
export function decideFix(metrics, deltas, rules) {
  const verdict = c => {
    // Differences are rounded to 6 decimals before comparison so a boundary value is not decided by float residue.
    const loss = r6(metrics[c].product_loss - metrics.C0.product_loss), recall = r6(metrics[c].ge2_recall - metrics.C0.ge2_recall), upper = deltas[`${c}_VS_C0`].auc_ge2_primary_last.ci95[1];
    const checks = { product_loss: loss <= rules.product_loss_max_increase, ge2_recall: recall >= -rules.ge2_recall_max_drop, auc_ge2_not_clearly_worse: upper != null && upper > rules.auc_ge2_ci_upper_must_exceed };
    return { status: Object.values(checks).every(Boolean) ? 'RELEASE_CANDIDATE' : 'NEEDS_RETUNE', checks,
      product_loss_delta: r6(loss), ge2_recall_delta: r6(recall), auc_ge2_delta_ci95_upper: r6(upper) };
  };
  const FIX_H = verdict('FIX_H'), FIX_ALL = verdict('FIX_ALL');
  const recommendation = FIX_ALL.status === 'RELEASE_CANDIDATE' ? 'FIX_ALL' : FIX_H.status === 'RELEASE_CANDIDATE' ? 'FIX_H_ONLY_OWNER_DECISION' : 'NEEDS_RETUNE_STOP';
  return { decision_rules_version: HFIX_POLICY.decision_rules_version, rules, FIX_H, FIX_ALL, recommendation, decision_owner: 'PROJECT_OWNER' };
}

// Deterministic payload; recomputed in a fresh process before publication and by verify.
export async function computeHorizonFix(loaded, code, progress = () => {}, policy = HFIX_POLICY) {
  assertDev(loaded, policy);
  const configs = await releaseConfigs(), cfg = evaluationConfigs(configs), R = configs['2.5.5.1'], calculator = p0Calculator(code.engine_sha256);
  const thresholds = gradeThresholdsOf(cfg.C0);
  if (policy.versions.some(v => digest(gradeThresholdsOf(cfg[v])) !== digest(thresholds))) fail('HFIX_GRADE_LINES_CHANGED');
  progress('C0（2.5.5.2）预检');
  const checked = await preflight(loaded, cfg.C0, calculator, progress);
  if (checked.exclusions.length) fail('HFIX_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scoresC = rows.map(r => r.control_score), scoresR = [];
  for (const row of rows) scoresR.push((await calculator.calculate(row, R)).score);
  // With the key absent the modified engine must reproduce the pinned 2.5.5.2 and 2.5.5.1 signatures exactly.
  const reference = { prediction_signature_sha256: digest(rows.map((r, i) => [r.snapshot_id, scoresC[i], gradeScore(scoresC[i], thresholds)])),
    product_loss: highCloudMetrics(rows, scoresC, thresholds).product_loss, score_changed_vs_V2551: scoresC.filter((s, i) => s !== scoresR[i]).length,
    grade_changed_vs_V2551: scoresC.filter((s, i) => gradeScore(s, thresholds) !== scoreToOrdinal(scoresR[i])).length };
  if (digest(reference) !== digest(V2552_REFERENCE)) fail('HFIX_V2552_PARITY_FAILED');
  const rSignature = digest(rows.map((r, i) => [r.snapshot_id, scoresR[i], scoreToOrdinal(scoresR[i])]));
  if (rSignature !== SKY_OFF_REFERENCE.prediction_signature_sha256) fail('HFIX_V2551_PARITY_FAILED');
  const traced = {};
  for (const v of policy.versions) traced[v] = await collect(rows, cfg[v], calculator, progress, v);
  if (traced.C0.some((t, i) => t.score !== scoresC[i])) fail('HFIX_OBSERVER_CHANGED_SCORES');
  const plainAll = []; for (const row of rows) plainAll.push((await calculator.calculate(row, cfg.FIX_ALL)).score);
  if (traced.FIX_ALL.some((t, i) => t.score !== plainAll[i])) fail('HFIX_OBSERVER_CHANGED_SCORES');
  const scored = rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, gt_ordinal: r.gt_ordinal,
    gt_confidence: r.gt_confidence, event_normalized_weight: r.event_normalized_weight, lead_time_minutes: r.lead_time_minutes, location_key: r.location_key,
    ...Object.fromEntries(policy.versions.map(v => [`score_${v}`, traced[v][i].score])) }));
  const last = primaryLast(scored), metrics = {};
  for (const v of policy.versions) {
    const m = highCloudMetrics(rows, traced[v].map(t => t.score), thresholds);
    metrics[v] = { product_loss: m.product_loss, ge2_recall: m.target_ge2.recall, ge2_precision: m.target_ge2.precision, ge3_recall: m.target_ge3.recall,
      ge3_precision: m.target_ge3.precision, ge3_usage_rate: m.target_ge3.predicted_usage_rate, mae: m.mae, bias: m.bias,
      auc_ge2_primary_last: weightedAuc(last, `score_${v}`, 2), auc_ge3_primary_last: weightedAuc(last, `score_${v}`, 3) };
  }
  progress(`按日期整块抽样（${policy.bootstrap.replicates} 次）`);
  const deltas = bootstrapDeltas(scored, Object.fromEntries(policy.versions.map(v => [v, thresholds])), policy);
  const comparisons = policy.comparisons.map(c => ({ ...c, point_difference: Object.fromEntries(Object.keys(metrics.C0).map(k =>
    [k, metrics[c.candidate][k] == null || metrics[c.control][k] == null ? null : r6(metrics[c.candidate][k] - metrics[c.control][k])])), bootstrap: deltas[c.id] }));
  const fixAll = traced.FIX_ALL.map(t => t.score);
  const v2554 = { prediction_signature_sha256: digest(rows.map((r, i) => [r.snapshot_id, fixAll[i], gradeScore(fixAll[i], thresholds)])),
    product_loss: metrics.FIX_ALL.product_loss, score_changed_vs_V2552: fixAll.filter((s, i) => s !== scoresC[i]).length,
    grade_changed_vs_V2552: fixAll.filter((s, i) => gradeScore(s, thresholds) !== gradeScore(scoresC[i], thresholds)).length };
  if (V2554_REFERENCE.prediction_signature_sha256 !== null && digest(v2554) !== digest(V2554_REFERENCE)) fail('HFIX_V2554_REFERENCE_MISMATCH');
  const parity = { status: 'PASS', members: rows.length, V2552: reference, V2551_prediction_signature_sha256: rSignature, key_absent_reproduces_V2552: true,
    observer_on_off_identical: ['C0', 'FIX_ALL'], engine_sha256: code.engine_sha256,
    config_sha256: Object.fromEntries(policy.versions.map(v => [v, digest(cfg[v])])), V2554_computed_reference: v2554 };
  progress('机制与分组');
  const grouped = Object.fromEntries(policy.versions.map(v => [v, withGroups(traced[v], P0_POLICY)]));
  const D1 = Object.fromEntries(['C0', 'FIX_ALL'].map(v => [v, d1(grouped[v], P0_POLICY)]));
  const groups = { shift_by_C0_group: groupShift(grouped.C0, traced),
    d1_primary_last: Object.fromEntries(Object.entries(D1).map(([v, x]) => [v, x.sets.primary.PRIMARY_LAST])),
    attribution: Object.fromEntries(Object.entries(D1).map(([v, x]) => [v, x.attribution.questions])) };
  const surface = Object.fromEntries(['FIX_H', 'FIX_ALL'].map(v => [v, changeSurface(traced.C0, traced[v], thresholds)]));
  surface.FIX_ALL_VS_FIX_H = changeSurface(traced.FIX_H, traced.FIX_ALL, thresholds);
  const mech = Object.fromEntries(policy.versions.map(v => [v, mechanism(traced[v], cfg[v])]));
  const decision = decideFix(metrics, deltas, policy.rules);
  const predictions = rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, slot: traced.C0[i].slot,
    gt_ordinal: r.gt_ordinal, ...Object.fromEntries(policy.versions.flatMap(v => [[`score_${v}`, traced[v][i].score], [`ordinal_${v}`, traced[v][i].ordinal],
      [`horizon_${v}`, r6(traced[v][i].comp_horizon)]])), group_C0: grouped.C0[i].groups.primary.exclusive }));
  return { parity, metrics, comparisons, change_surface: surface, mechanism: mech, groups, decision, predictions };
}

const f = v => v == null ? '—' : typeof v === 'number' ? String(Number(v.toFixed(3))) : String(v);
const STATUS = { RELEASE_CANDIDATE: '可作为发布候选', NEEDS_RETUNE: '未达标（需重调，本期停止）' };
const REC = { FIX_ALL: '建议采用 FIX_ALL（根因修正）', FIX_H_ONLY_OWNER_DECISION: '只有 FIX_H 达标，由项目负责人决定是否只修 horizon', NEEDS_RETUNE_STOP: '两者均未达标：停止，另立"修正后重调"项目或接受代价，由项目负责人决定' };
export function renderReport(spec, p) {
  const V = HFIX_POLICY.versions, m = p.metrics, row = (label, k) => `| ${label} | ${V.map(v => f(m[v][k])).join(' | ')} |`;
  const cmp = p.comparisons.map(c => `| ${c.id} | ${['product_loss', 'ge2_recall', 'auc_ge2_primary_last', 'auc_ge3_primary_last'].map(k =>
    `${f(c.point_difference[k])} [${f(c.bootstrap[k].ci95[0])}, ${f(c.bootstrap[k].ci95[1])}]`).join(' | ')} |`).join('\n');
  const mech = (label, fn) => `| ${label} | ${V.map(v => fn(p.mechanism[v])).join(' | ')} |`;
  const surf = v => { const s = p.change_surface[v]; return `| ${v} | ${s.score_changed}（↑${s.score_up} ↓${s.score_down}） | ${f(s.mean_delta)} / ${f(s.mean_abs_delta)} | ${s.max_down} ~ +${s.max_up} | ${s.grade_changed}（↑${s.grade_up}） | ${f(s.horizon_mean_delta)} |`; };
  const slots = p.change_surface.FIX_ALL.by_slot_base.map((b, i) => { const c = p.change_surface.FIX_ALL.by_slot_candidate[i], h = p.change_surface.FIX_H.by_slot_candidate[i];
    return `| ${b.slot} | ${b.grades.join(' / ')} | ${h.grades.join(' / ')} | ${c.grades.join(' / ')} | ${f(b.mean_score)} / ${f(h.mean_score)} / ${f(c.mean_score)} |`; }).join('\n');
  const shift = Object.entries(p.groups.shift_by_C0_group).map(([g, s]) => `| ${g} | ${s.rows} / ${s.ge2_rows} | ${V.map(v => f(s[v].mean_score)).join(' / ')} | ${V.map(v => s[v].ge2_missed_rows).join(' / ')} | ${V.map(v => f(s[v].mean_residual)).join(' / ')} |`).join('\n');
  const d1row = g => { const a = p.groups.d1_primary_last.C0[g], b = p.groups.d1_primary_last.FIX_ALL[g];
    return `| ${g} | ${a.support.events} → ${b.support.events} | ${f(a.metrics.miss?.group)} → ${f(b.metrics.miss?.group)} | ${f(a.metrics.residual.difference?.point)} → ${f(b.metrics.residual.difference?.point)} |`; };
  const dec = p.decision, verdict = c => `| ${c} | ${STATUS[dec[c].status]} | ${f(dec[c].product_loss_delta)}（${dec[c].checks.product_loss ? '通过' : '未通过'}） | ${f(dec[c].ge2_recall_delta)}（${dec[c].checks.ge2_recall ? '通过' : '未通过'}） | ${f(dec[c].auc_ge2_delta_ci95_upper)}（${dec[c].checks.auc_ge2_not_clearly_worse ? '通过' : '未通过'}） |`;
  return `# V2.5.5.4 地平线中心节点方位修正：DEV 评估

Run：${spec.run_id}。C0 = 发布线 2.5.5.2；FIX_H = 只在 horizon 分区补齐中心节点偏移；FIX_ALL = 所有消费方补齐（即 2.5.5.4）。三者均不重调参数，等级线均为 22/47/66/90。数据为 DEV ${p.parity.members} 条复用开发数据（independent_validation=false），未读取 H1。

## 结论（按 PRD §4 规则机械生成，须项目负责人确认）

**${REC[dec.recommendation]}。**

| 候选 | 结论 | 产品损失差（≤ +${HFIX_POLICY.rules.product_loss_max_increase}） | ≥2 召回差（≥ −${HFIX_POLICY.rules.ge2_recall_max_drop}） | AUC≥2 差的 95% 上限（> 0） |
| --- | --- | --- | --- | --- |
${verdict('FIX_H')}
${verdict('FIX_ALL')}

## 复现

开关缺键时，修改后的引擎复现 V2.5.5.2 签名（${p.parity.V2552.prediction_signature_sha256.slice(0, 8)}…，产品损失 ${f(p.parity.V2552.product_loss)}）和 V2.5.5.1 签名（${p.parity.V2551_prediction_signature_sha256.slice(0, 8)}…）。C0 与 FIX_ALL 观察器开/关分数逐条一致。FIX_ALL 与 H1 核验 Policy 2 中的 2.5.5.4 配置相同。

## 指标

| 指标 | C0 | FIX_H | FIX_ALL |
| --- | --- | --- | --- |
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

差值（候选 − 对照），括号为日期块 Bootstrap 95% 区间（${HFIX_POLICY.bootstrap.replicates} 次）：

| 比较 | 产品损失 | ≥2 召回 | AUC≥2 | AUC≥3 |
| --- | --- | --- | --- | --- |
${cmp}

## 变化面（相对 C0）

| 候选 | 分数变化行 | 平均 / 平均绝对变化 | 范围 | 等级变化行 | horizon 平均变化 |
| --- | --- | --- | --- | --- | --- |
${surf('FIX_H')}
${surf('FIX_ALL')}
${surf('FIX_ALL_VS_FIX_H').replace('| FIX_ALL_VS_FIX_H |', '| FIX_ALL 相对 FIX_H |')}

各时段等级分布（0/1/2/3/4 级行数）与平均分（C0 / FIX_H / FIX_ALL）：

| 时段 | C0 | FIX_H | FIX_ALL | 平均分 |
| --- | --- | --- | --- | --- |
${slots}

## 机制

| 项 | C0 | FIX_H | FIX_ALL |
| --- | --- | --- | --- |
${mech('horizon 均值 / P10 / P50 / P90', x => `${f(x.horizon.mean)} / ${f(x.horizon.p10)} / ${f(x.horizon.p50)} / ${f(x.horizon.p90)}`)}
${mech('云幕区有效行', x => x.bank_sector_valid_rows)}
${mech('horizon 硬门槛（< 10）行', x => x.hard_gate_horizon_rows)}
${mech('horizon 门槛各档行数', x => Object.entries(x.horizon_gate_tiers).map(([k, n]) => `${k}:${n}`).join('，'))}
${mech('云幕对比度 contrast 均值', x => f(x.contrast_mean))}
${mech('中心云量 centerCloud 均值', x => f(x.center_cloud_mean))}
${mech('云幕分 bankScore 均值', x => f(x.bank_score_mean))}
${mech('梯度类型', x => Object.entries(x.gradient_types).map(([k, n]) => `${k}:${n}`).join('，'))}
${mech('结构加分均值', x => f(x.structure_bonus_mean))}
${mech('组件均值 sky/horizon/illum/atmo', x => Object.values(x.component_means).map(f).join(' / '))}

## 分组（P0 主阈值）

按 C0 的互斥分组看各版本：

| 组 | 行 / GT≥2 行 | 平均分 C0/FIX_H/FIX_ALL | GT≥2 漏报行 | 平均残差 |
| --- | --- | --- | --- | --- |
${shift}

修正后重新分组的 D1（PRIMARY_LAST，C0 → FIX_ALL；修正改变了 L_CORR，组成员会变化）：

| 组 | Event | 漏报率 | 残差差（组 − 补集） |
| --- | --- | --- | --- |
${['G1', 'G2', 'G3', 'G4', 'G0'].map(d1row).join('\n')}

## 限制

DEV 是反复使用过的开发数据，C0 的参数又是在缺陷状态下选的；GT≥3 约 21 个 Event，≥3 结论多不可估计。本评估只回答"修正是否明显变差"，不代表独立验证；独立确认依赖 H1（holdout Policy 2 已含 2.5.5.4）。
`;
}

export async function runHorizonFix(options, progress = () => {}) {
  const loaded = await loadPool(options, progress), code = await codeIdentity();
  assertDev(loaded, HFIX_POLICY);
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const root of Object.values(loaded.roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const cfg = evaluationConfigs(await releaseConfigs());
  const identity = { schema: 10, policy: HFIX_POLICY, plan_sha256: digest(HFIX_POLICY), inputs: loaded.fingerprints,
    config_sha256: Object.fromEntries(HFIX_POLICY.versions.map(v => [v, digest(cfg[v])])), code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version };
  const runId = `practical_tuning_v10_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectHorizonFix(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: 10, practical_tuning_policy_version: 10, run_id: runId, identity, code, sources: loaded.roots, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'hfix_plan.json'), HFIX_POLICY);
    await atomicJson(path.join(work, 'configs.json'), cfg);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeHorizonFix(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算评估 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH');
    const result = { run_id: runId, status: 'COMPLETED', usage: HFIX_POLICY.usage, evaluation_scope: HFIX_POLICY.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, recommendation: payload.decision.recommendation, FIX_H: payload.decision.FIX_H.status, FIX_ALL: payload.decision.FIX_ALL.status,
      V2554_computed_reference: payload.parity.V2554_computed_reference };
    const files = { 'parity.json': payload.parity, 'metrics.json': payload.metrics, 'comparisons.json': payload.comparisons, 'change_surface.json': payload.change_surface,
      'mechanism.json': payload.mechanism, 'groups.json': payload.groups, 'decision.json': payload.decision, 'hfix_result.json': result, 'verification.json': proof };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'predictions.csv'), csv(payload.predictions));
    await writeFile(path.join(work, 'report.md'), renderReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
    await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl');
    let historyRows = []; if (await exists(history)) historyRows = (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!historyRows.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, model: loaded.source_ids.model, usage: HFIX_POLICY.usage,
      evaluation_scope: HFIX_POLICY.evaluation_scope, independent_validation: false, members: payload.predictions.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id })),
      selection_status: 'FIXED_CANDIDATE_EVALUATION_NO_SEARCH' }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: 10, practical_tuning_policy_version: 10, run_id: runId, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { ...result, directory: target };
  } catch (e) {
    if (await exists(path.join(work, 'run_spec.json'))) await atomicJson(path.join(work, 'state.json'), { status: 'EXECUTION_ERROR', error_code: errorCode(e), run_id: runId });
    throw e;
  } finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
export async function inspectHorizonFix(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== 10 || manifest.practical_tuning_policy_version !== 10) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of ['run_spec.json', 'hfix_plan.json', 'configs.json', 'parity.json', 'metrics.json', 'comparisons.json', 'decision.json', 'hfix_result.json',
    'predictions.csv', 'verification_request.json', 'verification.json', 'report.md']) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'hfix_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v10_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'hfix_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyHorizonFixRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  // V2.5.5.5: a byte-pinned default-compatible engine is accepted (the configs here never carry the later keys).
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(HFIX_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPool(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeHorizonFix(loaded, code);
  // The payload records the engine hash it ran on; everything else must be byte-identical.
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  await checkInputs(loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyHorizonFix(directory) {
  const inspected = await inspectHorizonFix(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
