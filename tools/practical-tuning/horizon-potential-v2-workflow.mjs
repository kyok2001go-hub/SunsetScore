// V2.5.5.18 workflow (Practical Tuning Schema/Policy 15): scores C0, the fixed candidate (f 0.7, k 5), three sensitivity
// members and the V2.5.5.17 reference member on DEV + H1 + H2 by Replay, tags rows with the frozen photo-review table, then
// runs the pre-registered evaluation (horizon-potential-v2.mjs). Read-only: explicit configs only; js/ is not changed and
// js/config.js never carries the key. PRD: ref_docs/PRD/V2.5.5.18--地平线条件化第二版与评估口径调整方案.md
import path from 'node:path';
import { mkdir, writeFile, rename, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../dataset/lib/common.mjs';
import { scoreToOrdinal, gradeScore } from '../evaluation/metrics.mjs';
import { releaseConfigs } from '../model-release/holdout.mjs';
import { SKY_OFF_REFERENCE, V25511_REFERENCE } from '../model-release/release.mjs';
import { APP_ROOT, codeIdentity, checkInputs } from './data.mjs';
import { preflight, gradeThresholdsOf } from './compute.mjs';
import { highCloudMetrics } from './high-cloud.mjs';
import { digest } from './policy.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { acquireRunLock, atomicJson } from './workflow.mjs';
import { p0Calculator } from './p0-workflow.mjs';
import { loadPooled, defaultPools } from './p0-pooled-workflow.mjs';
import { HP2_POLICY, keyOf, variantConfig, attachReview, evaluateAll } from './horizon-potential-v2.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 15;

/** The frozen photo-review table; a missing file or different content stops the run. */
export async function loadReviewTable(policy = HP2_POLICY, root = APP_ROOT) {
  let table;
  try { table = JSON.parse(await readSafe(path.join(root, policy.review.file))); }
  catch (e) { if (e.code === 'ENOENT') fail('HP2_REVIEW_TABLE_MISSING'); throw e; }
  if (digest(table) !== policy.review.content_sha256) fail('HP2_REVIEW_TABLE_HASH_MISMATCH');
  return table;
}

export async function computeHp2(loaded, code, progress = () => {}, policy = HP2_POLICY) {
  const table = await loadReviewTable(policy);
  const configs = await releaseConfigs(), C0 = configs['2.5.5.11'], R = configs['2.5.5.1'], V2554 = configs['2.5.5.4'];
  if (!C0 || !R || !V2554) fail('HP2_RELEASE_CONFIG_MISSING');
  if ('horizonCloudPotential' in C0 || 'canvasZeroFloor' in C0) fail('HP2_BASELINE_CARRIES_NEW_KEY');
  const calculator = p0Calculator(code.engine_sha256), thresholds = gradeThresholdsOf(C0), thresholds2554 = gradeThresholdsOf(V2554);
  progress('C0（2.5.5.11）预检');
  const checked = await preflight(loaded, C0, calculator, progress);
  if (checked.exclusions.length) fail('HP2_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, c0 = rows.map(r => r.control_score);
  // Parity (same as Policy 13 / 14): DEV reproduces V2.5.5.11 and V2.5.5.1; live 2.5.5.4 / 2.5.5.11 rows reproduce their live score.
  const devIdx = rows.map((r, i) => r.pool === 'DEV' ? i : -1).filter(i => i >= 0), dev = devIdx.map(i => rows[i]), devScores = devIdx.map(i => c0[i]);
  const v25511 = { prediction_signature_sha256: digest(dev.map((r, i) => [r.snapshot_id, devScores[i], gradeScore(devScores[i], thresholds)])),
    product_loss: highCloudMetrics(dev, devScores, thresholds).product_loss,
    grade_changed_vs_V2554: devScores.filter(s => gradeScore(s, thresholds) !== gradeScore(s, thresholds2554)).length };
  if (digest(v25511) !== digest(V25511_REFERENCE)) fail('HP2_V25511_PARITY_FAILED');
  const rDev = []; for (const i of devIdx) rDev.push((await calculator.calculate(rows[i], R)).score);
  if (digest(devIdx.map((i, j) => [rows[i].snapshot_id, rDev[j], scoreToOrdinal(rDev[j])])) !== SKY_OFF_REFERENCE.prediction_signature_sha256) fail('HP2_V2551_PARITY_FAILED');
  const live = rows.map((r, i) => [r, i]).filter(([r]) => policy.live_parity_model_versions.includes(r.model_version));
  if (live.some(([r, i]) => Number(r.predicted_score) !== c0[i])) fail('HP2_LIVE_PARITY_FAILED');
  // C0 trace: total cloud for the report-only clear-sky subgroup. Traced results are large, so each traced pass has its own calculator.
  progress('C0 Trace');
  const tAvg = [], traceC0 = p0Calculator(code.engine_sha256);
  for (const row of rows) tAvg.push((await traceC0.calculate(row, C0, true)).trace.diagnostic_observer.sunset_field.avg_cloud_cover ?? null);
  // Neutrality: f = 1 must reproduce C0 exactly.
  progress('中性检查 f = 1');
  const neutral = variantConfig(C0, { f: 1, k: policy.candidate.k }, policy);
  for (const [i, row] of rows.entries()) if ((await calculator.calculate(row, neutral)).score !== c0[i]) fail('HP2_NEUTRAL_VARIANT_CHANGED_SCORE', { detail: row.snapshot_id });
  // Candidate (traced: cloud potential C and g).
  const cand = keyOf(policy.candidate), scores = rows.map((r, i) => ({ C0: c0[i] })), potential = [];
  progress(`候选 ${cand}`);
  const traced = p0Calculator(code.engine_sha256), candidateConfig = variantConfig(C0, policy.candidate, policy);
  for (const [i, row] of rows.entries()) {
    const result = await traced.calculate(row, candidateConfig, true), hcp = result.trace.horizon_cloud_potential;
    if (!hcp) fail('HP2_TRACE_POTENTIAL_MISSING');
    scores[i][cand] = result.score; potential.push(hcp.value);
  }
  const missingPotential = potential.filter(v => v === null).length;
  for (const member of policy.sensitivity) {
    const key = keyOf(member), config = variantConfig(C0, member, policy);
    progress(`灵敏度 ${key}`);
    for (const [i, row] of rows.entries()) scores[i][key] = (await calculator.calculate(row, config)).score;
  }
  // §4.1 reference: HA_f0.7_k15 reproduces the V2.5.5.17 Run row by row, and equals the candidate wherever g(C) does not depend on k.
  const ref = policy.reference, refKey = keyOf(ref), refConfig = variantConfig(C0, ref, policy), refScores = [];
  progress(`参照 ${refKey}（V2.5.5.17 Run）`);
  for (const row of rows) refScores.push((await calculator.calculate(row, refConfig)).score);
  if (digest(rows.map((r, i) => [r.snapshot_id, refScores[i]])) !== ref.signature_sha256) fail('HP2_V25517_REFERENCE_PARITY_FAILED');
  const kIndependent = rows.map((r, i) => i).filter(i => potential[i] === null || potential[i] === 0 || potential[i] >= ref.k_independent_at_or_above);
  const differing = kIndependent.filter(i => scores[i][cand] !== refScores[i]);
  if (differing.length) fail('HP2_K_INDEPENDENT_ROWS_DIFFER', { detail: rows[differing[0]].snapshot_id });
  const evalRows = attachReview(rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool,
    slot: ['1213', '1613'].includes(r.scheduled_slot) ? r.scheduled_slot : ['1720', '1729', '1755'].includes(r.scheduled_slot) ? 'EVENING' : 'OTHER',
    lead_time_minutes: r.lead_time_minutes, gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence, weight: r.weight,
    t_avg: tAvg[i], cloud_potential: potential[i], scores: scores[i] })), table, policy);
  progress('评估（交叉验证、跨时段、区间、Brier）');
  const evaluation = evaluateAll(evalRows, policy);
  const events = new Map(evalRows.map(r => [r.event_id, r]));
  const parity = { status: 'PASS', members: rows.length, V25511_DEV: v25511, V2551_DEV: 'SKY_OFF_REFERENCE', live_parity_rows: live.length,
    neutral_f1_identical: true, engine_sha256: code.engine_sha256, C0_config_sha256: digest(C0), rows_without_cloud_potential: missingPotential,
    V25517_reference: { run_id: ref.run_id, key: refKey, signature_sha256: ref.signature_sha256, all_rows_identical: true,
      k_independent_rows: kIndependent.length, candidate_identical_on_k_independent_rows: true },
    review_table: { content_sha256: policy.review.content_sha256, events: table.events.length,
      recall_exempt_events: [...events.values()].filter(r => r.recall_exempt).length, recall_exempt_snapshots: evalRows.filter(r => r.recall_exempt).length,
      gt_ge2_events: [...events.values()].filter(r => r.gt_ordinal >= 2).length } };
  return { parity, rows: evalRows, evaluation };
}

// ---------- report ----------
const f3 = v => v == null ? '—' : Number(Number(v).toFixed(3)).toString();
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f3(x.point)}（不可估计）` : `${f3(x.point)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;
const m = s => `${f3(s.product_loss)} | ${f3(s.ge2_recall_cloud_type)} | ${f3(s.ge2_recall)} | ${f3(s.ge2_precision)} | ${f3(s.ge3_recall)} | ${f3(s.false_alarm_rate)} | ${f3(s.bias)} | ${f3(s.predicted_ge2_share)}`;
const HEAD = '| | 产品损失 | ≥2 召回（有云） | ≥2 召回（全体） | ≥2 精确 | ≥3 召回 | 误报率 | 偏差 | 预测 ≥2 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
export function renderHp2Report(spec, p, policy = HP2_POLICY) {
  const e = p.evaluation, A = e.A, cand = keyOf(policy.candidate), rv = p.parity.review_table, ro = e.report_only;
  const folds = A.cv5.folds.map(x => `| ${x.dates.join(' ~ ')} | ${x.L0_lines.join('/')} | ${x.A2_lines.join('/')} | ${x.L0_old_rule_lines.join('/')} |`).join('\n');
  const cross = A.cross_period.map(c => c.feasible ? `| ${c.train.join('+')} → ${c.test.join('+')} | ${c.L0_lines.join('/')} | ${f3(c.L0.product_loss)} | ${c.A2_lines.join('/')} | ${f3(c.candidate.product_loss)} |` : `| ${c.train.join('+')} → ${c.test.join('+')} | 不可行 | | | |`).join('\n');
  const split = groups => Object.entries(groups).map(([k, v]) => `| ${k} | ${v.snapshots} | ${f3(v.L0.product_loss)} | ${f3(v.candidate.product_loss)} | ${f3(v.L0.ge2_recall_cloud_type)} | ${f3(v.candidate.ge2_recall_cloud_type)} | ${f3(v.L0.false_alarm_rate)} | ${f3(v.candidate.false_alarm_rate)} | ${f3(v.L0.bias)} | ${f3(v.candidate.bias)} |`).join('\n');
  const sub = (name, s) => `| ${name} | ${s.snapshots} / ${s.events} | ${s.gt_ge2_snapshots} | ${s.L0.false_alarm_snapshots} → ${s.candidate.false_alarm_snapshots} | ${s.L0.missed_ge2_snapshots} → ${s.candidate.missed_ge2_snapshots} | ${f3(s.L0.product_loss)} → ${f3(s.candidate.product_loss)} | ${f3(s.L0.bias)} → ${f3(s.candidate.bias)} |`;
  const review = Object.entries(A.report.by_review).map(([k, v]) => `| ${k} | ${v.events} | ${v.snapshots} | ${f3(v.L0_ge2_recall)} | ${f3(v.candidate_ge2_recall)} | ${v.L0_missed_snapshots} → ${v.candidate_missed_snapshots} |`).join('\n');
  const sens = Object.entries(ro.sensitivity).map(([k, v]) => `| ${k} | ${f3(v.cv5.product_loss)} | ${f3(v.cv5_loss_delta_vs_L0)} | ${f3(v.cv11_loss_delta_vs_L0)} | ${f3(v.cv5.ge2_recall_cloud_type)} | ${f3(v.cv5.ge2_recall)} |`).join('\n');
  return `# V2.5.5.18 地平线条件化第二版与评估口径调整（开发数据验证）

Run：${spec.run_id}。数据 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（复用开发数据，independent_validation=false，未读取 2026-11-16 起的数据）。基准 C0 = 2.5.5.11；候选 A2 = ${cand}（参数固定，不在折内选择）。

**结论：${e.decision}。** 门槛：${Object.entries(e.gates).map(([k, v]) => `${k}=${v}`).join('，')}。G1 的两条通道：损失区间 ${e.G1_paths.loss_interval_upper_below_0}，点估计加 Brier ${e.G1_paths.both_points_below_0_and_brier_upper_below_0}。

## 复现

DEV 与 V2.5.5.11 参照一致（签名 ${p.parity.V25511_DEV.prediction_signature_sha256.slice(0, 8)}…），R = 2.5.5.1 一致，线上同版本 ${p.parity.live_parity_rows} 条逐条一致；f = 1 的中性配置与 C0 逐条一致；${p.parity.V25517_reference.key} 在全部行上与 V2.5.5.17 Run 一致，候选在 C = 0 或 C ≥ ${policy.reference.k_independent_at_or_above} 的 ${p.parity.V25517_reference.k_independent_rows} 条上与它逐条相同。无云潜力的行：${p.parity.rows_without_cloud_potential}。

复查类型表：${rv.events} 个 Event；不计入 ≥2 召回下限的晴空渐变色 ${rv.recall_exempt_events} 个 Event / ${rv.recall_exempt_snapshots} 条 Snapshot；GT≥2 共 ${rv.gt_ge2_events} 个 Event。

## 5 折样本外（L0 = C0 + 重新选线）

${HEAD}
| C0 现行线 ${policy.lines.current.join('/')}（全数据） | ${m(e.current_lines_C0)} |
| L0 | ${m(A.cv5.reference)} |
| A2 | ${m(A.cv5.candidate)} |

产品损失差（A2 − L0）：${ci(A.cv5.loss_delta)}；有云好晚霞 ≥2 召回差：${ci(A.cv5.ge2_recall_cloud_type_delta)}；全体 ≥2 召回差：${ci(A.cv5.ge2_recall_delta)}。

11 折：A2 ${f3(A.cv11.candidate.product_loss)}、L0 ${f3(A.cv11.reference.product_loss)}，差 ${ci(A.cv11.loss_delta)}；A2 的 ≥2 召回：有云 ${f3(A.cv11.candidate.ge2_recall_cloud_type)}、全体 ${f3(A.cv11.candidate.ge2_recall)}。

Brier（P(GT≥2)，每个 Event 最接近日落的一条，${A.brier.cv5.events} 个 Event）：5 折 A2 ${f3(A.brier.cv5.candidate)}、C0 ${f3(A.brier.cv5.C0)}，差 ${ci(A.brier.cv5.delta)}；11 折差 ${ci(A.brier.cv11.delta)}。

AUC≥2：A2 ${f3(A.auc.auc_ge2.candidate)}、C0 ${f3(A.auc.auc_ge2.C0)}，差 ${ci(A.auc.auc_ge2.delta)}；AUC≥3：A2 ${f3(A.auc.auc_ge3.candidate)}、C0 ${f3(A.auc.auc_ge3.C0)}，差 ${ci(A.auc.auc_ge3.delta)}。

| 留出日期 | L0 线 | A2 线 | L0 线（原口径） |
| --- | --- | --- | --- |
${folds}

## 跨时段

| 方向 | L0 线 | L0 损失 | A2 线 | A2 损失 |
| --- | --- | --- | --- | --- |
${cross}

## 只报告

### 按数据池与时段（5 折样本外）

| | Snapshot | L0 损失 | A2 损失 | L0 ≥2 召回（有云） | A2 ≥2 召回（有云） | L0 误报率 | A2 误报率 | L0 偏差 | A2 偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${split(A.report.by_pool)}
${split(A.report.by_slot)}

### 子组（L0 → A2）

| 子组 | Snapshot / Event | GT≥2 条数 | 误报 | 漏报 GT≥2 | 产品损失 | 偏差 |
| --- | --- | --- | --- | --- | --- | --- |
${sub(`C < ${policy.low_potential_below}%`, A.report.low_potential)}
${sub(`总云量 < ${policy.clear_sky_t_avg_below}%`, A.report.clear_sky)}

### 按复查类型的 ≥2 召回

| 类型 | Event | Snapshot | L0 | A2 | 漏报条数 |
| --- | --- | --- | --- | --- | --- |
${review}

### 其他对照

${HEAD}
| A2 配现行线 ${policy.lines.current.join('/')}（全数据，不选线） | ${m(ro.A2_current_lines)} |
| L0 原口径（全体召回 ≥ ${policy.lines.ge2_recall_floor}，5 折） | ${m(ro.L0_old_rule.cv5)} |

### 灵敏度（点估计，不替换 A2）

| 配置 | 5 折损失 | 5 折差（− L0） | 11 折差（− L0） | ≥2 召回（有云） | ≥2 召回（全体） |
| --- | --- | --- | --- | --- | --- |
${sens}

全数据选线（只描述）：L0 ${A.full_data_lines.L0?.join('/') ?? '—'}，A2 ${A.full_data_lines.A2?.join('/') ?? '—'}，L0 原口径 ${A.full_data_lines.L0_old_rule?.join('/') ?? '—'}。

结论只是开发证据；是否发布与 H3 核验另行决定。
`;
}

// ---------- run / inspect / verify ----------
const REQUIRED = ['run_spec.json', 'hp2_plan.json', 'parity.json', 'hp2_rows.json', 'evaluation.json', 'hp2_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runHp2(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity(), policy = HP2_POLICY;
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const roots of Object.values(loaded.roots)) for (const root of Object.values(roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const configs = await releaseConfigs();
  const identity = { schema: SCHEMA, policy, plan_sha256: digest(policy), inputs: loaded.fingerprints, C0_config_sha256: digest(configs['2.5.5.11']),
    code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version };
  const runId = `practical_tuning_v${SCHEMA}_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectHp2(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'hp2_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeHp2(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const e = payload.evaluation;
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, decision: e.decision, gates: e.gates, G1_paths: e.G1_paths };
    for (const [name, value] of Object.entries({ 'parity.json': payload.parity, 'hp2_rows.json': payload.rows, 'evaluation.json': e, 'hp2_result.json': result, 'verification.json': proof }))
      await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'report.md'), renderHp2Report(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
    for (const p of loaded.parts) await checkInputs(p.loaded);
    if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl');
    let historyRows = []; if (await exists(history)) historyRows = (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!historyRows.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, models: Object.values(loaded.source_ids).map(s => s.model), usage: policy.usage,
      evaluation_scope: policy.evaluation_scope, independent_validation: false, members: payload.rows.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id })),
      selection_status: 'DEVELOPMENT_EVIDENCE_ONLY' }) + '\n');
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
export async function inspectHp2(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'hp2_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'hp2_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyHp2Request(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(HP2_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeHp2(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  for (const p of loaded.parts) await checkInputs(p.loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyHp2(directory) {
  const inspected = await inspectHp2(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
