// V2.5.5.14 pooled P0 diagnostics (Practical Tuning Schema/Policy 13). PRD: ref_docs/PRD/V2.5.5.14--P0机制诊断合并数据重跑方案.md
// Re-runs the frozen V2.5.5.3 P0 analysis (Policy 9) on DEV + H1 + H2 with the 2.5.5.11 baseline. Read-only: no candidate, no
// configuration change, no Observation beyond the frozen GT/Model packages, and never a row dated on or after the H3 start.
// Policy 9 (p0-workflow.mjs) is untouched so that its published Run still verifies byte for byte.
import path from 'node:path';
import { mkdir, writeFile, rename, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory, compare } from '../dataset/lib/common.mjs';
import { scoreToOrdinal, gradeScore } from '../evaluation/metrics.mjs';
import { releaseConfigs } from '../model-release/holdout.mjs';
import { SKY_OFF_REFERENCE, V25511_REFERENCE } from '../model-release/release.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { preflight, gradeThresholdsOf } from './compute.mjs';
import { highCloudMetrics } from './high-cloud.mjs';
import { digest } from './policy.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { acquireRunLock, atomicJson, csv } from './workflow.mjs';
import { P0_POLICY, P0_POOLED_POLICY } from './p0-features.mjs';
import { d1, d2, d3, decide, withGroups, probeScores, support } from './p0-diagnostics.mjs';
import { analysisRow, p0Calculator } from './p0-workflow.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 13;

// ---------- pooled input ----------
/** pools: [{ name, raw, gt, model }] directories; returns one loaded pool with per-pool roots and fingerprints. */
export async function loadPooled(pools, progress = () => {}, policy = P0_POOLED_POLICY) {
  if (!Array.isArray(pools) || pools.length !== policy.pools.length) fail('P0_POOLED_POOLS_INVALID');
  const parts = [];
  for (const [i, spec] of policy.pools.entries()) {
    const given = pools[i];
    if (!given || given.name !== spec.name) fail('P0_POOLED_POOLS_INVALID');
    const loaded = await loadPool(given, progress);
    if (loaded.source_ids.raw !== spec.raw || loaded.source_ids.gt !== spec.gt || loaded.source_ids.model !== spec.model) fail('P0_POOLED_IDENTITY_MISMATCH', { detail: spec.name });
    if (loaded.exclusions.length || loaded.rows.length !== spec.snapshots) fail('P0_POOLED_POOL_INCOMPLETE', { detail: `${spec.name}:${loaded.rows.length}/${loaded.exclusions.length}` });
    // H3 (from 2026-11-16) must never be read; every pool stays inside its declared, non-overlapping date range.
    if (loaded.rows.some(r => r.event_date_local >= policy.h3_first_date)) fail('P0_POOLED_H3_DATE_REJECTED');
    if (loaded.rows.some(r => r.event_date_local < spec.first_date || r.event_date_local > spec.last_date)) fail('P0_POOLED_DATE_OUT_OF_RANGE', { detail: spec.name });
    parts.push({ name: spec.name, loaded });
  }
  const rows = parts.flatMap(p => p.loaded.rows.map(r => ({ ...r, pool: p.name })));
  const ids = new Set(), events = new Map();
  for (const r of rows) {
    if (ids.has(r.snapshot_id)) fail('P0_POOLED_DUPLICATE_SNAPSHOT');
    ids.add(r.snapshot_id);
    if (events.has(r.event_id) && events.get(r.event_id) !== r.pool) fail('P0_POOLED_EVENT_IN_TWO_POOLS');
    events.set(r.event_id, r.pool);
  }
  rows.sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
  return { rows, exclusions: [], parts,
    roots: Object.fromEntries(parts.map(p => [p.name, p.loaded.roots])),
    fingerprints: Object.fromEntries(parts.map(p => [p.name, p.loaded.fingerprints])),
    source_ids: Object.fromEntries(parts.map(p => [p.name, p.loaded.source_ids])) };
}
async function checkPooledInputs(pooled) { for (const p of pooled.parts) await checkInputs(p.loaded); }

// ---------- analysis rows ----------
function pooledRow(row, result, scoring, thresholds, policy) {
  const known = Object.prototype.hasOwnProperty.call(P0_POLICY.slots, row.scheduled_slot);
  // analysisRow only uses the slot as a label; non-standard captures are relabelled afterwards.
  const out = analysisRow(known ? row : { ...row, scheduled_slot: '1213' }, result, scoring, thresholds);
  return { ...out, slot: known ? out.slot : policy.other_slot, scheduled_slot: row.scheduled_slot, pool: row.pool };
}
async function collect(rows, config, calculator, progress, label, policy) {
  const thresholds = gradeThresholdsOf(config), out = [];
  for (const [i, row] of rows.entries()) {
    out.push(pooledRow(row, await calculator.calculate(row, config, true), config, thresholds, policy));
    if ((i + 1) % 100 === 0 || i + 1 === rows.length) progress(`${label} Trace ${i + 1}/${rows.length}`);
  }
  return out;
}

// ---------- §5 supplementary rules ----------
export function decidePooled(D1, D2, D3, policy = P0_POOLED_POLICY) {
  const base = decide(D1, D2, D3), rules = policy.supplementary_rules;
  const evidence = { ...base.evidence };
  const severe = D1.sets.primary.PRIMARY_LAST.G1.metrics.severe_miss.difference;
  evidence.G1_severe_miss_significant = severe?.status === 'COMPUTED' && severe.ci95[0] > 0;
  evidence.G1_severe_miss_difference = severe ?? null;
  const gwp2 = D2.probes['GWP-2'].delta_auc_ge2;
  evidence.GWP2_gain = gwp2.status === 'COMPUTED' && gwp2.ci95[0] > 0;
  const different = { RH_SHAPE_MONOTONE: ['MONOTONE_INC', 'MONOTONE_DEC'].includes(evidence.rh_shape), GWP2_DELTA_AUC_GE2_LOWER_ABOVE_0: evidence.GWP2_gain };
  const items = base.recommendations.map(it => {
    const tested = rules.already_tested[it.item];
    const forced = it.item === rules.g1_severe_miss_item && evidence.G1_severe_miss_significant;
    const recommended = it.recommended || forced;
    const alreadyTested = Boolean(recommended && tested && !different[tested.different_change_if]);
    return { item: it.item, base_status: it.status, recommended, forced_by_g1_severe_miss: forced && !it.recommended,
      already_tested: alreadyTested ? tested.tested_by : null, ...(it.notes ? { notes: it.notes } : {}) };
  });
  const ranked = items.filter(it => it.recommended && !it.already_tested);
  const forced = ranked.findIndex(it => it.item === rules.g1_severe_miss_item && evidence.G1_severe_miss_significant);
  if (forced >= rules.g1_severe_miss_max_rank) ranked.splice(rules.g1_severe_miss_max_rank - 1, 0, ...ranked.splice(forced, 1));
  for (const it of items) it.status = it.already_tested ? 'ALREADY_TESTED' : it.recommended ? `PRIORITY_${ranked.indexOf(it) + 1}` : 'DATA_LIMITED';
  return { rules_version: P0_POLICY.decision_rules_version, supplementary_rules_version: rules.version, evidence, recommendations: items,
    base_recommendations: base.recommendations.map(r => ({ item: r.item, status: r.status })),
    requires_owner_confirmation: true, role: 'PRIORITY_ADVICE_ONLY_NO_CANDIDATE_NO_CONFIG_CHANGE' };
}

// Per-pool directions of the main D1 results (primary thresholds, PRIMARY_LAST); reference only, not part of the decision.
function byPool(rows, policy) {
  const out = {};
  for (const spec of policy.pools) {
    const sub = rows.filter(r => r.pool === spec.name), D = d1(sub, policy).sets.primary.PRIMARY_LAST;
    out[spec.name] = { rows: sub.length, events: new Set(sub.map(r => r.event_id)).size, groups: Object.fromEntries(['G1', 'G2', 'G3', 'G4'].map(g => [g, {
      support: D[g].support, ...Object.fromEntries(['miss', 'severe_miss', 'false_alarm', 'residual'].map(m => [m, {
        group: D[g].metrics[m].group, complement: D[g].metrics[m].complement, difference_point: D[g].metrics[m].difference?.point ?? null,
        status: D[g].metrics[m].status }])) }])) };
  }
  return out;
}

// ---------- payload ----------
export async function computePooledP0(loaded, code, progress = () => {}, policy = P0_POOLED_POLICY) {
  const configs = await releaseConfigs(), C = configs['2.5.5.11'], R = configs['2.5.5.1'], V2554 = configs['2.5.5.4'], calculator = p0Calculator(code.engine_sha256);
  if (!C || !R || !V2554) fail('P0_POOLED_RELEASE_CONFIG_MISSING');
  const thresholds = gradeThresholdsOf(C), thresholds2554 = gradeThresholdsOf(V2554);
  progress('V2.5.5.11 预检');
  const checked = await preflight(loaded, C, calculator, progress);
  if (checked.exclusions.length) fail('P0_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scoresC = rows.map(r => r.control_score);
  // Parity 1: DEV reproduces the pinned V2.5.5.11 release reference (and V2.5.5.1 under R).
  const devIdx = rows.map((r, i) => r.pool === 'DEV' ? i : -1).filter(i => i >= 0), dev = devIdx.map(i => rows[i]), devScores = devIdx.map(i => scoresC[i]);
  const scoresR = [];
  for (const row of rows) scoresR.push((await calculator.calculate(row, R)).score);
  const v25511 = { prediction_signature_sha256: digest(dev.map((r, i) => [r.snapshot_id, devScores[i], gradeScore(devScores[i], thresholds)])),
    product_loss: highCloudMetrics(dev, devScores, thresholds).product_loss,
    grade_changed_vs_V2554: devScores.filter(s => gradeScore(s, thresholds) !== gradeScore(s, thresholds2554)).length };
  if (digest(v25511) !== digest(V25511_REFERENCE)) fail('P0_POOLED_V25511_PARITY_FAILED');
  const rSignature = digest(devIdx.map(i => [rows[i].snapshot_id, scoresR[i], scoreToOrdinal(scoresR[i])]));
  if (rSignature !== SKY_OFF_REFERENCE.prediction_signature_sha256) fail('P0_POOLED_V2551_PARITY_FAILED');
  // Parity 2: rows captured live with the same scoring (2.5.5.4 / 2.5.5.11) reproduce their live score exactly.
  const live = rows.map((r, i) => [r, i]).filter(([r]) => policy.live_parity_model_versions.includes(r.model_version));
  const liveMismatch = live.filter(([r, i]) => Number(r.predicted_score) !== scoresC[i]).map(([r]) => r.snapshot_id);
  if (liveMismatch.length) fail('P0_POOLED_LIVE_PARITY_FAILED', { detail: liveMismatch.slice(0, 5).join(',') });
  const traced = await collect(rows, C, calculator, progress, 'C', policy);
  const mismatch = traced.filter((t, i) => t.score !== scoresC[i] || t.ordinal !== rows[i].control_ordinal).length;
  if (mismatch) fail('P0_OBSERVER_CHANGED_SCORES', { detail: String(mismatch) });
  const tracedR = await collect(rows, R, calculator, progress, 'R', policy);
  if (tracedR.some((t, i) => t.score !== scoresR[i])) fail('P0_OBSERVER_CHANGED_SCORES');
  const count = (list, key) => Object.fromEntries([...new Set(list.map(r => r[key]))].sort(compare).map(k => [k, list.filter(r => r[key] === k).length]));
  const parity = { status: 'PASS', members: rows.length, by_pool: count(rows, 'pool'), V25511_DEV: v25511, V2551_DEV_prediction_signature_sha256: rSignature,
    live_parity: { model_versions: policy.live_parity_model_versions, rows: live.length, by_pool: count(live.map(([r]) => r), 'pool'), mismatches: 0 },
    observer_on_off_identical: true, engine_sha256: code.engine_sha256, C_config_sha256: digest(C), R_config_sha256: digest(R),
    gw_reconstruction: 'ROUND(CLAMP(SKY_STAGE*F_GW)) == SCORE FOR ALL ROWS', horizon_aggregation: 'L_CORR == 100 - HORIZON FOR ALL ROWS WITH LOW CLOUD',
    // With centerAzimuthOffset (V2.5.5.4) the center sample has an offset, so the bank sector is no longer voided.
    engine_bank_sector_voided_rows: traced.filter(t => t.features.engine_bank_sector_voided).length,
    slots: count(traced, 'slot'), scheduled_slots_other: count(traced.filter(t => t.slot === policy.other_slot), 'scheduled_slot') };
  const grouped = withGroups(traced, policy), groupedR = withGroups(tracedR, policy);
  const gwp3 = structuredClone(C); gwp3.evolution.backgroundWeight = 0;
  const gwp3Scores = []; for (const row of rows) gwp3Scores.push((await calculator.calculate(row, gwp3)).score);
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
  progress('按数据池'); const pools = byPool(grouped, policy);
  const decision = decidePooled(D1, D2, D3, policy);
  return { parity, probe_spot_checks: spot, rows: grouped.map(({ groups, ...r }) => ({ ...r, groups })), d1: D1, d2: D2, d3: D3, by_pool: pools, decision };
}

// ---------- report ----------
const f = v => v == null ? '—' : typeof v === 'number' ? String(Number(v.toFixed(3))) : String(v);
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f(x.point)}（不可估计）` : `${f(x.point)} [${f(x.ci95[0])}, ${f(x.ci95[1])}]${x.significant ? ' *' : ''}`;
export function renderPooledReport(spec, p) {
  const P = p.d1.sets.primary.PRIMARY_LAST, a = p.d1.attribution.questions, d2r = p.d2, dec = p.decision;
  const groupRows = ['G1', 'G2', 'G3', 'G4', 'G0'].map(g => `| ${g} | ${P[g].support.events}/${P[g].support.dates} | ${P[g].support.ge2_events}/${P[g].support.ge3_events} | ${f(P[g].metrics.miss.group)} | ${ci(P[g].metrics.miss.difference)} | ${f(P[g].metrics.false_alarm.group)} | ${ci(P[g].metrics.false_alarm.difference)} | ${ci(P[g].metrics.residual.difference)} | ${ci(P[g].metrics.severe_miss.difference)} |`).join('\n');
  const stable = Object.entries(p.d1.stability).filter(([, v]) => v.evidence).map(([k, v]) => `${k}（方向 ${v.direction > 0 ? '+' : '−'}）`).join('、') || '无';
  const probes = Object.entries(d2r.probes).map(([id, x]) => `| ${id} | ${ci(x.delta_auc_ge2)} | ${ci(x.delta_auc_ge3)} | ${f(x.metrics.product_loss)} | ${f(x.metrics.ge2_recall)} / ${f(x.metrics.ge3_recall)} | ${x.changed_scores} / ${x.grade_changes} |`).join('\n');
  const sig = dir => p.d3.screen.filter(s => s.PRIMARY_LAST.direction_ge2 === dir).map(s => `${s.signal} ${ci(s.PRIMARY_LAST.auc_ge2)}`).join('；') || '无';
  const shapes = p.d3.bins.map(b => `| ${b.variable} | ${b.bin_count} | ${b.bins.map(x => f(x.ge2_rate.point)).join(' / ')} | ${b.shape} |`).join('\n');
  const red = p.d3.redundancy;
  const pools = Object.entries(p.by_pool).map(([name, v]) => `| ${name} | ${v.events} | ${['G1', 'G2', 'G3', 'G4'].map(g => `${v.groups[g].support.events}：${f(v.groups[g].miss.difference_point)} / ${f(v.groups[g].false_alarm.difference_point)} / ${f(v.groups[g].severe_miss.difference_point)}`).join(' | ')} |`).join('\n');
  const recs = dec.recommendations.map(r => `| ${r.item} | ${r.base_status} | ${r.status}${r.already_tested ? `（${r.already_tested}）` : ''}${r.forced_by_g1_severe_miss ? '（G1 严重漏报规则）' : ''} |`).join('\n');
  return `# V2.5.5.14 P0 机制诊断合并数据重跑

Run：${spec.run_id}。基准 C = 发布线 2.5.5.11（19/49/66/90 判级），对照 R = 2.5.5.1（只用于 D2）。数据为 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（${Object.entries(p.parity.by_pool).map(([k, v]) => `${k} ${v}`).join('，')}），全部是复用开发数据（independent_validation=false），未读取 2026-11-16 起的任何数据（H3）。本报告只给出优先级建议，不产生候选、不改配置。

## 复现

DEV 上 2.5.5.11 与发布参照一致（签名 ${p.parity.V25511_DEV.prediction_signature_sha256.slice(0, 8)}…，产品损失 ${f(p.parity.V25511_DEV.product_loss)}，相对 2.5.5.4 等级变化 ${p.parity.V25511_DEV.grade_changed_vs_V2554}）；R = 2.5.5.1 签名一致。线上分数为 2.5.5.4 / 2.5.5.11 的 ${p.parity.live_parity.rows} 条逐条与 Replay 重算一致。观察器开/关分数逐条一致；GW 重建与 horizon 聚合在全部行上一致；云幕区失效的行 ${p.parity.engine_bank_sector_voided_rows}。非常规时段归入 OTHER：${canonicalJson(p.parity.scheduled_slots_other)}。探针后处理抽查：${Object.entries(p.probe_spot_checks).map(([k, v]) => `${k} ${v.equal}/${v.checked}`).join('，')}。

## D1 机制分组误差（主阈值，PRIMARY_LAST）

差值 = 组 − 补集，区间为日期块 Bootstrap 95%，* 为显著。

| 组 | Event/日期 | GT≥2/GT≥3 | 漏报率 | 漏报差 | 误报率 | 误报差 | 残差差 | 严重漏报差 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${groupRows}

显著且两套备选阈值方向一致的结论：${stable}。

丢分定位：
- G1 漏报（相对全体判对）：${a.q1_g1_miss_loss.status === 'COMPUTED' ? `${Object.entries(a.q1_g1_miss_loss.point_deltas_vs_all_hits).map(([k, v]) => `${k} ${f(v)}`).join('，')}；主要丢分环节 ${a.q1_g1_miss_loss.main_loss_stage}` : a.q1_g1_miss_loss.status}。
- G2 误报：${a.q2_g2_false_alarm.status === 'COMPUTED' ? `horizon 均值 ${f(a.q2_g2_false_alarm.horizon_false_alarm)}（全体 ${f(a.q2_g2_false_alarm.horizon_all)}），B_max 均值 ${f(a.q2_g2_false_alarm.b_max_false_alarm)}` : a.q2_g2_false_alarm.status}。
- G3：${a.q3_g3_direction.status === 'COMPUTED' ? `残差 ${f(a.q3_g3_direction.residual_G3)}（其余 ${f(a.q3_g3_direction.residual_non_G3)}），方向 ${a.q3_g3_direction.direction}` : a.q3_g3_direction.status}。

## 按数据池（只作参考）

每格：组内 Event 数：漏报差 / 误报差 / 严重漏报差（点估计）。

| 数据池 | Event | G1 | G2 | G3 | G4 |
| --- | --- | --- | --- | --- | --- |
${pools}

## D2 黄金窗口

核心问题（T_avg ≥ 50）：G1 平均因子 ${f(d2r.core.G1_mean_factor)}，G4 ${f(d2r.core.G4_mean_factor)}，差值 ${ci(d2r.core.difference_G1_minus_G4)}；${d2r.core.status !== 'COMPUTED' ? '支持不足，不可估计' : d2r.core.indistinguishable ? 'GW 无法显著区分中高云主导与低云遮挡' : 'GW 能区分两者'}。

| 探针 | ΔAUC≥2 | ΔAUC≥3 | 产品损失 | ≥2/≥3 召回 | 分数/等级变化 |
| --- | --- | --- | --- | --- | --- |
${probes}

C：产品损失 ${f(d2r.C_metrics.product_loss)}，AUC≥2/≥3 ${f(d2r.C_auc.ge2)} / ${f(d2r.C_auc.ge3)}。

## D3 信号复核

AUC≥2 区间下限 > 0.5：${sig('POSITIVE')}。

方向相反（区间上限 < 0.5）：${sig('REVERSED')}。

| 变量 | 箱数 | 各箱 GT≥2 比例 | 形状 |
| --- | --- | --- | --- |
${shapes}

大气变量：去掉后不损失信息的 ${Object.entries(red.drop_one).filter(([, v]) => v.removable_without_loss).map(([k]) => k).join('、') || '无'}；在最终分之外仍有增量的 ${Object.entries(red.increment_over_score).filter(([, v]) => v.adds_information).map(([k]) => k).join('、') || '无'}。

## 结论映射（V2.5.5.3 §9 + V2.5.5.14 §5）

| 改进项 | 原规则 | 本期 |
| --- | --- | --- |
${recs}

证据：${canonicalJson(dec.evidence)}

建议只表示优先级，须项目负责人确认；任何评分改动另立单假设 PRD，并用 H3 确认。
`;
}
function featureCsv(rows) {
  return csv(rows.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool, slot: r.slot, scheduled_slot: r.scheduled_slot,
    gt_ordinal: r.gt_ordinal, score: r.score, ordinal: r.ordinal, gw_active: r.gw_active, gw_factor: r.gw_factor, gw_source: r.gw_source, gw_points: r.gw_points,
    ...r.features, group_primary: r.groups.primary.exclusive, G1: r.groups.primary.G1, G2: r.groups.primary.G2, G3: r.groups.primary.G3, G4: r.groups.primary.G4,
    miss: r.gt_ordinal >= 2 && r.ordinal <= 1, false_alarm: r.gt_ordinal <= 1 && r.ordinal >= 2 })));
}

// ---------- run / inspect / verify ----------
export function defaultPools(root = path.join(APP_ROOT, 'dataset'), policy = P0_POOLED_POLICY) {
  return policy.pools.map(p => ({ name: p.name, raw: path.join(root, 'exports', p.raw), gt: path.join(root, 'ground_truth/exports', p.gt), model: path.join(root, 'model/exports', p.model) }));
}
const REQUIRED = ['run_spec.json', 'p0_plan.json', 'parity.json', 'p0_rows.json', 'd1_groups.json', 'd2_probes.json', 'd3_signal_screen.json', 'by_pool.json',
  'p0_decision.json', 'p0_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runPooledP0(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity();
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const roots of Object.values(loaded.roots)) for (const root of Object.values(roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const configs = await releaseConfigs(), policy = P0_POOLED_POLICY;
  const identity = { schema: SCHEMA, policy, plan_sha256: digest(policy), inputs: loaded.fingerprints, C_config_sha256: digest(configs['2.5.5.11']),
    R_config_sha256: digest(configs['2.5.5.1']), code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version };
  const runId = `practical_tuning_v${SCHEMA}_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectPooledP0(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'p0_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computePooledP0(loaded, code, progress), payloadSha = digest(payload);
    const request = { spec, payload_sha256: payloadSha };
    await atomicJson(path.join(work, 'verification_request.json'), request);
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 P0 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, recommendations: payload.decision.recommendations.map(r => ({ item: r.item, status: r.status })) };
    const files = { 'parity.json': payload.parity, 'probe_spot_checks.json': payload.probe_spot_checks, 'p0_rows.json': payload.rows,
      'd1_groups.json': { sets: payload.d1.sets, composition: payload.d1.composition, stability: payload.d1.stability }, 'd1_attribution.json': payload.d1.attribution,
      'd2_golden_window.json': { paths: payload.d2.paths, coverage: payload.d2.coverage, crosstab: payload.d2.crosstab, core: payload.d2.core, release: payload.d2.release,
        C_metrics: payload.d2.C_metrics, C_slot_drift: payload.d2.C_slot_drift, C_auc: payload.d2.C_auc }, 'd2_probes.json': payload.d2.probes,
      'd3_signal_screen.json': payload.d3.screen, 'd3_bins.json': { bins: payload.d3.bins, conditional_bins: payload.d3.conditional_bins, twilight_confounding: payload.d3.twilight_confounding },
      'd3_redundancy.json': payload.d3.redundancy, 'by_pool.json': payload.by_pool, 'p0_decision.json': payload.decision, 'p0_result.json': result, 'verification.json': proof };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'p0_features.csv'), featureCsv(payload.rows));
    await writeFile(path.join(work, 'report.md'), renderPooledReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
    await checkPooledInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl');
    let historyRows = []; if (await exists(history)) historyRows = (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!historyRows.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, models: Object.values(loaded.source_ids).map(s => s.model), usage: policy.usage,
      evaluation_scope: policy.evaluation_scope, independent_validation: false, members: payload.rows.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id })),
      selection_status: 'DIAGNOSTICS_ONLY' }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { ...result, directory: target };
  } catch (e) {
    if (await exists(path.join(work, 'run_spec.json'))) await atomicJson(path.join(work, 'state.json'), { status: 'EXECUTION_ERROR', error_code: errorCode(e), run_id: runId });
    throw e;
  } finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
export async function inspectPooledP0(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'p0_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'p0_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyPooledP0Request(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(P0_POOLED_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computePooledP0(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  await checkPooledInputs(loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyPooledP0(directory) {
  const inspected = await inspectPooledP0(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
export { support };
