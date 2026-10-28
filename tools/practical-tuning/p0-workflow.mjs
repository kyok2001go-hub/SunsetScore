// V2.5.5.3 P0 diagnostics workflow (Practical Tuning Schema/Policy 9, PRD §10). Policies 7 and 8 are skipped: they name the
// unmerged V2.5.6 / V2.5.7 branch runs (practical_tuning_v7_* / v8_*). Read-only over DEV; no candidate, no configuration change, no H1 access.
import path from 'node:path';
import { mkdir, writeFile, rename, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../dataset/lib/common.mjs';
import { scoreToOrdinal, gradeScore } from '../evaluation/metrics.mjs';
import { runReplay } from '../replay/replay-runner.mjs';
import { releaseConfigs } from '../model-release/holdout.mjs';
import { SKY_OFF_REFERENCE, V2552_REFERENCE } from '../model-release/release.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { replayCalculator, preflight, gradeThresholdsOf } from './compute.mjs';
import { highCloudMetrics } from './high-cloud.mjs';
import { digest } from './policy.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { acquireRunLock, atomicJson, csv } from './workflow.mjs';
import { P0_POLICY, sunsetFeatures } from './p0-features.mjs';
import { d1, d2, d3, decide, withGroups, probeScores, SIGNALS, COMPONENTS } from './p0-diagnostics.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const CAMEL = { sky_canvas: 'skyCanvas', horizon: 'horizon', illumination: 'illumination', atmosphere: 'atmosphere', weather: 'weather' };
export const p0Calculator = engine => replayCalculator(engine, (r, o) => runReplay(r, { ...o, diagnosticObserver: o.trace === true }));

function assertDev(loaded, policy) {
  const d = policy.dev;
  if (loaded.source_ids.raw !== d.raw || loaded.source_ids.gt !== d.gt || loaded.source_ids.model !== d.model) fail('P0_DEV_IDENTITY_MISMATCH');
  // H1 forward holdout (>= 2026-10-13) must never be read by P0 (PRD §2).
  if (loaded.rows.some(r => r.event_date_local >= policy.first_holdout_date)) fail('P0_HOLDOUT_DATE_REJECTED');
  if (loaded.exclusions.length || loaded.rows.length !== d.snapshots) fail('P0_DEV_POOL_INCOMPLETE');
}
const stageOutput = (trace, stage) => { const s = trace.stages.find(x => x.stage === stage); if (!s) fail('P0_TRACE_STAGE_MISSING', { detail: stage }); return s.output_score; };
// One analysis row per Snapshot from a traced replay (observer on).
export function analysisRow(row, result, scoring, thresholds) {
  const t = result.trace, gw = t.diagnostic_observer.golden_window, sky = stageOutput(t, 'sky_evolution'), factor = gw.active ? gw.applied_factor : 1;
  if (Math.round(Math.min(100, Math.max(0, sky * factor))) !== result.score) fail('P0_GW_RECONSTRUCTION_MISMATCH', { detail: row.snapshot_id });
  const without = Math.round(Math.min(100, Math.max(0, sky))), features = sunsetFeatures(t, scoring);
  if (features.l_corr != null && Math.abs(features.l_corr - (100 - t.components.horizon)) > 1e-9) fail('P0_HORIZON_AGGREGATION_MISMATCH', { detail: row.snapshot_id });
  return { snapshot_id: row.snapshot_id, event_id: row.event_id, event_date_local: row.event_date_local, city: row.city, latitude: Number(row.latitude),
    slot: P0_POLICY.slots[row.scheduled_slot] ?? fail('P0_UNKNOWN_SLOT', { detail: row.scheduled_slot }), lead_time_minutes: row.lead_time_minutes,
    gt_ordinal: row.gt_ordinal, gt_confidence: row.gt_confidence, weight: row.event_normalized_weight, location_key: row.location_key,
    score: result.score, ordinal: result.ordinal, score_engine: stageOutput(t, 'core_round'), P: t.P, Q: t.Q, horizon_gate: t.horizon_gate,
    structure_bonus: t.structure_bonus, transition_bonus: t.transition_bonus, weather_penalty: t.weather_penalty,
    ...Object.fromEntries(COMPONENTS.map(c => [`comp_${c}`, t.components[CAMEL[c]]])), ...Object.fromEntries(COMPONENTS.map(c => [`contrib_${c}`, t.contributions[CAMEL[c]]])),
    gw_active: gw.active, gw_factor: factor, gw_source: gw.probability_source ?? null, gw_open_probability: gw.sunset_open_probability ?? null,
    gw_radar_coverage: gw.radar_coverage_now ?? null, gw_satellite_coverage: gw.satellite_coverage_now ?? null, gw_raining_now: gw.raining_now ?? null,
    sky_score: sky, score_without_gw: without, ordinal_without_gw: gradeScore(without, thresholds), gw_points: result.score - without, features };
}
async function collect(rows, config, calculator, progress, label) {
  const thresholds = gradeThresholdsOf(config), out = [];
  for (const [i, row] of rows.entries()) {
    out.push(analysisRow(row, await calculator.calculate(row, config, true), config, thresholds));
    if ((i + 1) % 100 === 0 || i + 1 === rows.length) progress(`${label} Trace ${i + 1}/${rows.length}`);
  }
  return out;
}
// Deterministic P0 payload; recomputed in a fresh process before publication and by verify.
export async function computeP0(loaded, code, progress = () => {}, policy = P0_POLICY) {
  assertDev(loaded, policy);
  const configs = await releaseConfigs(), C = configs['2.5.5.2'], R = configs['2.5.5.1'], calculator = p0Calculator(code.engine_sha256);
  const thresholds = gradeThresholdsOf(C);
  progress('V2.5.5.2 预检');
  const checked = await preflight(loaded, C, calculator, progress);
  if (checked.exclusions.length) fail('P0_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scoresC = rows.map(r => r.control_score);
  // §3 parity with the pinned V2.5.5.2 release signature and the deployed V2.5.5.1 signature.
  const scoresR = [];
  for (const row of rows) scoresR.push((await calculator.calculate(row, R)).score);
  const signature = digest(rows.map((r, i) => [r.snapshot_id, scoresC[i], gradeScore(scoresC[i], thresholds)]));
  const reference = { prediction_signature_sha256: signature, product_loss: highCloudMetrics(rows, scoresC, thresholds).product_loss,
    score_changed_vs_V2551: scoresC.filter((s, i) => s !== scoresR[i]).length,
    grade_changed_vs_V2551: scoresC.filter((s, i) => gradeScore(s, thresholds) !== scoreToOrdinal(scoresR[i])).length };
  if (digest(reference) !== digest(V2552_REFERENCE)) fail('P0_V2552_PARITY_FAILED');
  const rSignature = digest(rows.map((r, i) => [r.snapshot_id, scoresR[i], scoreToOrdinal(scoresR[i])]));
  if (rSignature !== SKY_OFF_REFERENCE.prediction_signature_sha256) fail('P0_V2551_PARITY_FAILED');
  // Traced rows with the observer on; scores must equal the observer-off preflight exactly.
  const traced = await collect(rows, C, calculator, progress, 'C');
  const mismatch = traced.filter((t, i) => t.score !== scoresC[i] || t.ordinal !== rows[i].control_ordinal).length;
  if (mismatch) fail('P0_OBSERVER_CHANGED_SCORES', { detail: String(mismatch) });
  const tracedR = await collect(rows, R, calculator, progress, 'R');
  if (tracedR.some((t, i) => t.score !== scoresR[i])) fail('P0_OBSERVER_CHANGED_SCORES');
  const parity = { status: 'PASS', members: rows.length, V2552: reference, V2551_prediction_signature_sha256: rSignature,
    observer_on_off_identical: true, engine_sha256: code.engine_sha256, C_config_sha256: digest(C), R_config_sha256: digest(R),
    gw_reconstruction: 'ROUND(CLAMP(SKY_STAGE*F_GW)) == SCORE FOR ALL ROWS', horizon_aggregation: 'L_CORR == 100 - HORIZON FOR ALL ROWS WITH LOW CLOUD',
    // Engine finding: an offset-less center sample voids the ±30° bank sector, so horizon uses only the 0° ray (50–300 km).
    engine_bank_sector_voided_rows: traced.filter(t => t.features.engine_bank_sector_voided).length };
  const grouped = withGroups(traced, policy), groupedR = withGroups(tracedR, policy);
  // GWP-3 (real replay): background prior removed through the existing configuration path.
  const gwp3 = structuredClone(C); gwp3.evolution.backgroundWeight = 0;
  const gwp3Scores = []; for (const row of rows) gwp3Scores.push((await calculator.calculate(row, gwp3)).score);
  // Spot checks: rows whose probe factor became exactly 1 must equal a replay with the golden window disabled.
  const off = structuredClone(C); off.goldenWindow.enabled = false;
  const spot = {};
  for (const probe of ['GWP-0', 'GWP-1', 'GWP-2']) {
    const scores = probeScores(grouped, probe), picked = grouped.map((r, i) => [r, i]).filter(([r, i]) => r.gw_active && scores[i] !== r.score).slice(0, policy.probe_spot_checks);
    for (const [r, i] of picked) if ((await calculator.calculate(rows[i], off)).score !== scores[i]) fail('P0_PROBE_POSTPROCESS_MISMATCH', { detail: `${probe}:${r.snapshot_id}` });
    spot[probe] = { checked: picked.length, equal: picked.length };
  }
  progress('D1 机制分组'); const D1 = d1(grouped, policy);
  progress('D2 黄金窗口'); const D2 = d2(grouped, groupedR, gwp3Scores, thresholds, policy);
  progress('D3 信号复核'); const D3 = d3(grouped, C, policy);
  const decision = decide(D1, D2, D3);
  return { parity, probe_spot_checks: spot, rows: grouped.map(({ groups, ...r }) => ({ ...r, groups })), d1: D1, d2: D2, d3: D3, decision };
}

const f = v => v == null ? '—' : typeof v === 'number' ? String(Number(v.toFixed(3))) : String(v);
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f(x.point)}（不可估计）` : `${f(x.point)} [${f(x.ci95[0])}, ${f(x.ci95[1])}]${x.significant ? ' *' : ''}`;
function renderReport(spec, p) {
  const P = p.d1.sets.primary.PRIMARY_LAST, a = p.d1.attribution.questions, d2r = p.d2, dec = p.decision;
  const groupRows = ['G1', 'G2', 'G3', 'G4', 'G0'].map(g => `| ${g} | ${P[g].support.events}/${P[g].support.dates} | ${P[g].support.ge2_events}/${P[g].support.ge3_events} | ${f(P[g].metrics.miss.group)} | ${ci(P[g].metrics.miss.difference)} | ${f(P[g].metrics.false_alarm.group)} | ${ci(P[g].metrics.false_alarm.difference)} | ${ci(P[g].metrics.residual.difference)} | ${ci(P[g].metrics.severe_miss.difference)} |`).join('\n');
  const stable = Object.entries(p.d1.stability).filter(([, v]) => v.evidence).map(([k, v]) => `${k}（方向 ${v.direction > 0 ? '+' : '−'}）`).join('、') || '无';
  const probes = Object.entries(d2r.probes).map(([id, x]) => `| ${id} | ${ci(x.delta_auc_ge2)} | ${ci(x.delta_auc_ge3)} | ${f(x.metrics.product_loss)} | ${f(x.metrics.ge2_recall)} / ${f(x.metrics.ge3_recall)} | ${x.changed_scores} / ${x.grade_changes} | ${f(x.slot_drift.mean)} | ${x.wiring} |`).join('\n');
  const paths = Object.entries(d2r.paths).map(([s, v]) => `| ${s} | ${v.inactive} | ${Object.entries(v.by_source).map(([k, n]) => `${k}=${n}`).join('，') || '—'} |`).join('\n');
  const cross = d2r.crosstab.filter(r => r.rows).map(r => `| ${r.t_avg_bin} | ${r.composition} | ${r.rows}/${r.events} | ${f(r.mean_factor)} | ${f(r.mean_points)} | ${r.grade_down}/${r.grade_up} |`).join('\n');
  const sig = dir => p.d3.screen.filter(s => s.PRIMARY_LAST.direction_ge2 === dir).map(s => `${s.signal} ${ci(s.PRIMARY_LAST.auc_ge2)}`).join('；') || '无';
  const shapes = p.d3.bins.map(b => `| ${b.variable} | ${b.bin_count} | ${b.bins.map(x => f(x.ge2_rate.point)).join(' / ')} | ${b.bins.map(x => f(x.current_response_at_median)).join(' / ')} | ${b.shape} |`).join('\n');
  const cond = p.d3.conditional_bins.map(b => `| ${b.label} | ${b.rows} | ${b.bins.map(x => f(x.ge2_rate.point)).join(' / ')} | ${b.shape} |`).join('\n');
  const red = p.d3.redundancy, recs = dec.recommendations.map(r => `| ${r.item} | ${r.status} |`).join('\n');
  return `# V2.5.5.3 P0 机制诊断与信号复核

Run：${spec.run_id}。基准 C = 发布线 2.5.5.2（22/47/66/90 判级），对照 R = 2.5.5.1。数据为 DEV ${p.parity.members} 条复用开发数据（independent_validation=false），未读取 H1。本报告只给出 P1/P2 优先级建议，不产生候选、不改配置。

## 复现

引擎口径发现：${p.parity.engine_bank_sector_voided_rows}/${p.parity.members} 行的走廊中心样本缺少方位偏移，使 ±30° 云幕区整体失效，horizon 实际只用 0° 射线 50–300 km；F01/F02 按此实际口径计算（只报告，不修正）。

V2.5.5.2 签名与发布证据一致（${p.parity.V2552.prediction_signature_sha256.slice(0, 8)}…，产品损失 ${f(p.parity.V2552.product_loss)}）；V2.5.5.1 签名一致（${p.parity.V2551_prediction_signature_sha256.slice(0, 8)}…）。观察器开/关分数逐条一致；GW 重建与 horizon 聚合在全部行上一致。探针后处理抽查：${Object.entries(p.probe_spot_checks).map(([k, v]) => `${k} ${v.equal}/${v.checked}`).join('，')}。

## D1 机制分组误差（主阈值，PRIMARY_LAST）

差值 = 组 − 补集，区间为日期块 Bootstrap 95%，* 为显著。

| 组 | Event/日期 | GT≥2/GT≥3 | 漏报率 | 漏报差 | 误报率 | 误报差 | 残差差 | 严重漏报差 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${groupRows}

显著且两套备选阈值方向一致的结论：${stable}。

丢分定位：
- G1 漏报（相对全体判对）：${a.q1_g1_miss_loss.status === 'COMPUTED' ? `${Object.entries(a.q1_g1_miss_loss.point_deltas_vs_all_hits).map(([k, v]) => `${k} ${f(v)}`).join('，')}；主要丢分环节 ${a.q1_g1_miss_loss.main_loss_stage}` : a.q1_g1_miss_loss.status}。
- G2 误报：${a.q2_g2_false_alarm.status === 'COMPUTED' ? `horizon 均值 ${f(a.q2_g2_false_alarm.horizon_false_alarm)}（全体 ${f(a.q2_g2_false_alarm.horizon_all)}），B_max 均值 ${f(a.q2_g2_false_alarm.b_max_false_alarm)}` : a.q2_g2_false_alarm.status}。
- G3：${a.q3_g3_direction.status === 'COMPUTED' ? `残差 ${f(a.q3_g3_direction.residual_G3)}（其余 ${f(a.q3_g3_direction.residual_non_G3)}），方向 ${a.q3_g3_direction.direction}；Q ${f(a.q3_g3_direction.Q_G3)} / ${f(a.q3_g3_direction.Q_non_G3)}` : a.q3_g3_direction.status}。

## D2 黄金窗口

| 时段 | 未启用 | 启用行按概率来源 |
| --- | --- | --- |
${paths}

| 总云 T_avg | 组合 | 行/Event | 平均因子 | 平均分数影响 | 降级/升级 |
| --- | --- | --- | --- | --- | --- |
${cross}

核心问题（T_avg ≥ 50）：G1 平均因子 ${f(d2r.core.G1_mean_factor)}，G4 ${f(d2r.core.G4_mean_factor)}，差值 ${ci(d2r.core.difference_G1_minus_G4)}；${d2r.core.status !== 'COMPUTED' ? '支持不足，不可估计' : d2r.core.indistinguishable ? 'GW 无法显著区分中高云主导与低云遮挡' : 'GW 能区分两者'}。G1 启用行：2.5.5.1 平均因子 ${f(d2r.release.R_mean_factor)}、2.5.5.2 ${f(d2r.release.C_mean_factor)}；因子 <1 的行 ${d2r.release.R_rows_factor_below_1} → ${d2r.release.C_rows_factor_below_1}。

| 探针 | ΔAUC≥2 | ΔAUC≥3 | 产品损失 | ≥2/≥3 召回 | 分数/等级变化 | 晚间−12:13 | 接线 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${probes}

C：产品损失 ${f(d2r.C_metrics.product_loss)}，AUC≥2/≥3 ${f(d2r.C_auc.ge2)} / ${f(d2r.C_auc.ge3)}，晚间−12:13 ${f(d2r.C_slot_drift.mean)}。探针只作诊断，不冻结、不进入 H1 或发布流程。

## D3 信号复核

AUC≥2 区间下限 > 0.5：${sig('POSITIVE')}。

方向相反（区间上限 < 0.5）：${sig('REVERSED')}。

| 变量 | 箱数 | 各箱 GT≥2 比例 | 当前响应（箱中位数处） | 形状 |
| --- | --- | --- | --- | --- |
${shapes}

| 条件曲线 | 行 | 各箱 GT≥2 比例 | 形状 |
| --- | --- | --- | --- |
${cond}

暮光时长与纬度 Spearman ${f(p.d3.twilight_confounding.spearman_latitude)}，与年内日序 ${f(p.d3.twilight_confounding.spearman_day_of_year)}。

大气变量：去掉后不损失信息的 ${Object.entries(red.drop_one).filter(([, v]) => v.removable_without_loss).map(([k]) => k).join('、') || '无'}；在最终分之外仍有增量的 ${Object.entries(red.increment_over_score).filter(([, v]) => v.adds_information).map(([k]) => k).join('、') || '无'}。逻辑回归全部折收敛：${red.all_folds_converged}。

## 结论映射（PRD §9）

| 改进项 | 建议 |
| --- | --- |
${recs}

证据：${canonicalJson(dec.evidence)}

建议只表示优先级，须项目负责人确认；P1 每项另行立项，在 DEV 上单假设验证，并只能用 H1 之后的独立数据核验。样本限制：GT≥3 约 21 个 Event，多数 ≥3 结论不可估计；特征为日落时刻预报值，组别反映模型看到的天气。
`;
}
function featureCsv(rows) {
  return csv(rows.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, slot: r.slot, gt_ordinal: r.gt_ordinal,
    score: r.score, ordinal: r.ordinal, gw_active: r.gw_active, gw_factor: r.gw_factor, gw_source: r.gw_source, gw_points: r.gw_points,
    ...r.features, group_primary: r.groups.primary.exclusive, G1: r.groups.primary.G1, G2: r.groups.primary.G2, G3: r.groups.primary.G3, G4: r.groups.primary.G4,
    miss: r.gt_ordinal >= 2 && r.ordinal <= 1, false_alarm: r.gt_ordinal <= 1 && r.ordinal >= 2 })));
}
const screenCsv = s => csv(s.map(x => ({ signal: x.signal, n: x.PRIMARY_LAST.n, auc_ge2: x.PRIMARY_LAST.auc_ge2.point, auc_ge2_lower: x.PRIMARY_LAST.auc_ge2.ci95[0], auc_ge2_upper: x.PRIMARY_LAST.auc_ge2.ci95[1],
  auc_ge3: x.PRIMARY_LAST.auc_ge3.point, auc_ge3_lower: x.PRIMARY_LAST.auc_ge3.ci95[0], auc_ge3_upper: x.PRIMARY_LAST.auc_ge3.ci95[1], direction_ge2: x.PRIMARY_LAST.direction_ge2,
  all_auc_ge2: x.ALL_SNAPSHOTS.auc_ge2.point, all_auc_ge3: x.ALL_SNAPSHOTS.auc_ge3.point, ...Object.fromEntries(Object.entries(x.slots).map(([k, v]) => [`auc_ge2_${k}`, v.point])) })));
const binsCsv = d => csv([...d.bins, ...d.conditional_bins].flatMap(b => b.bins.map(x => ({ curve: b.label, shape: b.shape, bin: x.bin, events: x.events, min: x.min, max: x.max, median: x.median,
  ge2_rate: x.ge2_rate.point, ge2_lower: x.ge2_rate.ci95?.[0] ?? null, ge2_upper: x.ge2_rate.ci95?.[1] ?? null, ge3_rate: x.ge3_rate.point, mean_gt: x.mean_gt.point,
  current_response_at_median: x.current_response_at_median }))));

export async function runP0(options, progress = () => {}) {
  const loaded = await loadPool(options, progress), code = await codeIdentity();
  assertDev(loaded, P0_POLICY);
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const root of Object.values(loaded.roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const configs = await releaseConfigs();
  const identity = { schema: 9, policy: P0_POLICY, plan_sha256: digest(P0_POLICY), inputs: loaded.fingerprints, C_config_sha256: digest(configs['2.5.5.2']),
    R_config_sha256: digest(configs['2.5.5.1']), code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version };
  const runId = `practical_tuning_v9_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectP0(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: 9, practical_tuning_policy_version: 9, run_id: runId, identity, code, sources: loaded.roots, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'p0_plan.json'), P0_POLICY);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeP0(loaded, code, progress), payloadSha = digest(payload);
    const request = { spec, payload_sha256: payloadSha };
    await atomicJson(path.join(work, 'verification_request.json'), request);
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 P0 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH');
    const result = { run_id: runId, status: 'COMPLETED', usage: P0_POLICY.usage, evaluation_scope: P0_POLICY.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, recommendations: payload.decision.recommendations.map(r => ({ item: r.item, status: r.status })) };
    const files = { 'parity.json': payload.parity, 'probe_spot_checks.json': payload.probe_spot_checks, 'p0_rows.json': payload.rows,
      'd1_groups.json': { sets: payload.d1.sets, composition: payload.d1.composition, stability: payload.d1.stability }, 'd1_attribution.json': payload.d1.attribution,
      'd2_golden_window.json': { paths: payload.d2.paths, coverage: payload.d2.coverage, crosstab: payload.d2.crosstab, core: payload.d2.core, release: payload.d2.release,
        C_metrics: payload.d2.C_metrics, C_slot_drift: payload.d2.C_slot_drift, C_auc: payload.d2.C_auc }, 'd2_probes.json': payload.d2.probes,
      'd3_signal_screen.json': payload.d3.screen, 'd3_bins.json': { bins: payload.d3.bins, conditional_bins: payload.d3.conditional_bins, twilight_confounding: payload.d3.twilight_confounding },
      'd3_redundancy.json': payload.d3.redundancy, 'p0_decision.json': payload.decision, 'p0_result.json': result, 'verification.json': proof };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'p0_features.csv'), featureCsv(payload.rows));
    await writeFile(path.join(work, 'd3_signal_screen.csv'), screenCsv(payload.d3.screen));
    await writeFile(path.join(work, 'd3_bins.csv'), binsCsv(payload.d3));
    await writeFile(path.join(work, 'report.md'), renderReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
    await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl');
    let historyRows = []; if (await exists(history)) historyRows = (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!historyRows.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, model: loaded.source_ids.model, usage: P0_POLICY.usage,
      evaluation_scope: P0_POLICY.evaluation_scope, independent_validation: false, members: payload.rows.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id })),
      selection_status: 'DIAGNOSTICS_ONLY' }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: 9, practical_tuning_policy_version: 9, run_id: runId, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { ...result, directory: target };
  } catch (e) {
    if (await exists(path.join(work, 'run_spec.json'))) await atomicJson(path.join(work, 'state.json'), { status: 'EXECUTION_ERROR', error_code: errorCode(e), run_id: runId });
    throw e;
  } finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
export async function inspectP0(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== 9 || manifest.practical_tuning_policy_version !== 9) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of ['run_spec.json', 'p0_plan.json', 'parity.json', 'p0_rows.json', 'd1_groups.json', 'd2_probes.json', 'd3_signal_screen.json',
    'p0_decision.json', 'p0_result.json', 'verification_request.json', 'verification.json', 'report.md']) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'p0_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v9_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'p0_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
// Fresh-process recompute: the full payload must be byte-identical under the recorded plan.
export async function verifyP0Request(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  // V2.5.5.4: a byte-pinned default-compatible engine is accepted (P0 uses explicit release configs without the new key).
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(P0_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPool(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeP0(loaded, code);
  // The payload records the engine hash it ran on; everything else must be byte-identical.
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  await checkInputs(loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyP0(directory) {
  const inspected = await inspectP0(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
export { SIGNALS };
