// V2.5.5.17 workflow (Practical Tuning Schema/Policy 14): scores C0 and every H-A / H-B grid member on DEV + H1 + H2 by Replay,
// derives H-C from the traced H-A rows, then runs the pre-registered evaluation (horizon-potential.mjs).
// Read-only: explicit configs only; js/config.js never carries the new keys. PRD: ref_docs/PRD/V2.5.5.17--地平线贡献按云潜力条件化方案.md
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
import { HP_POLICY, gridKeys, gridParams, variantConfig, evaluateAll } from './horizon-potential.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 14;
const stageOutput = (trace, stage) => { const s = trace.stages.find(x => x.stage === stage); if (!s) fail('HP_TRACE_STAGE_MISSING', { detail: stage }); return s.output_score; };
const clampRound = v => Math.round(Math.min(100, Math.max(0, v)));

export async function computeHp(loaded, code, progress = () => {}, policy = HP_POLICY) {
  const configs = await releaseConfigs(), C0 = configs['2.5.5.11'], R = configs['2.5.5.1'], V2554 = configs['2.5.5.4'];
  if (!C0 || !R || !V2554) fail('HP_RELEASE_CONFIG_MISSING');
  if ('horizonCloudPotential' in C0 || 'canvasZeroFloor' in C0) fail('HP_BASELINE_CARRIES_NEW_KEY');
  const calculator = p0Calculator(code.engine_sha256), thresholds = gradeThresholdsOf(C0), thresholds2554 = gradeThresholdsOf(V2554);
  progress('C0（2.5.5.11）预检');
  const checked = await preflight(loaded, C0, calculator, progress);
  if (checked.exclusions.length) fail('HP_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, c0 = rows.map(r => r.control_score);
  // Parity (same as Policy 13): DEV reproduces V2.5.5.11 and V2.5.5.1; live 2.5.5.4 / 2.5.5.11 rows reproduce their live score.
  const devIdx = rows.map((r, i) => r.pool === 'DEV' ? i : -1).filter(i => i >= 0), dev = devIdx.map(i => rows[i]), devScores = devIdx.map(i => c0[i]);
  const v25511 = { prediction_signature_sha256: digest(dev.map((r, i) => [r.snapshot_id, devScores[i], gradeScore(devScores[i], thresholds)])),
    product_loss: highCloudMetrics(dev, devScores, thresholds).product_loss,
    grade_changed_vs_V2554: devScores.filter(s => gradeScore(s, thresholds) !== gradeScore(s, thresholds2554)).length };
  if (digest(v25511) !== digest(V25511_REFERENCE)) fail('HP_V25511_PARITY_FAILED');
  const rDev = []; for (const i of devIdx) rDev.push((await calculator.calculate(rows[i], R)).score);
  if (digest(devIdx.map((i, j) => [rows[i].snapshot_id, rDev[j], scoreToOrdinal(rDev[j])])) !== SKY_OFF_REFERENCE.prediction_signature_sha256) fail('HP_V2551_PARITY_FAILED');
  const live = rows.map((r, i) => [r, i]).filter(([r]) => policy.live_parity_model_versions.includes(r.model_version));
  if (live.some(([r, i]) => Number(r.predicted_score) !== c0[i])) fail('HP_LIVE_PARITY_FAILED');
  // C0 trace: total cloud for the report-only clear-sky subgroup.
  progress('C0 Trace');
  // Traced results are large: each traced pass uses its own calculator so its cache is released afterwards.
  const tAvg = [], traceC0 = p0Calculator(code.engine_sha256);
  for (const row of rows) tAvg.push((await traceC0.calculate(row, C0, true)).trace.diagnostic_observer.sunset_field.avg_cloud_cover ?? null);
  // Neutrality: f = 1 must reproduce C0 exactly (the conditioning is wired but inert).
  progress('中性检查 f = 1');
  const neutral = variantConfig(C0, 'HA', 1, 25, policy);
  for (const [i, row] of rows.entries()) if ((await calculator.calculate(row, neutral)).score !== c0[i]) fail('HP_NEUTRAL_VARIANT_CHANGED_SCORE', { detail: row.snapshot_id });
  const scores = rows.map((r, i) => ({ C0: c0[i] })), potential = rows.map(() => null);
  let missingPotential = 0;
  for (const key of gridKeys('HA', policy)) {
    const { f, k } = gridParams(key), config = variantConfig(C0, 'HA', f, k, policy), keyC = key.replace(/^HA/, 'HC');
    progress(`${key}（含 H-C）`);
    const traced = p0Calculator(code.engine_sha256);
    for (const [i, row] of rows.entries()) {
      const result = await traced.calculate(row, config, true), t = result.trace, hcp = t.horizon_cloud_potential;
      if (!hcp) fail('HP_TRACE_POTENTIAL_MISSING');
      const gw = t.diagnostic_observer.golden_window, sky = stageOutput(t, 'sky_evolution'), applied = gw.active ? gw.applied_factor : 1;
      if (clampRound(sky * applied) !== result.score) fail('HP_GW_RECONSTRUCTION_MISMATCH', { detail: row.snapshot_id });
      scores[i][key] = result.score;
      // H-C: when g(C) < 1 the golden-window factor may not exceed 1.
      scores[i][keyC] = gw.active && hcp.factor < 1 ? clampRound(sky * Math.min(applied, 1)) : result.score;
      if (potential[i] === null) { potential[i] = hcp.value; if (hcp.value === null) missingPotential++; }
    }
  }
  for (const key of gridKeys('HB', policy)) {
    const { f, k } = gridParams(key), config = variantConfig(C0, 'HB', f, k, policy);
    progress(key);
    for (const [i, row] of rows.entries()) scores[i][key] = (await calculator.calculate(row, config)).score;
  }
  const evalRows = rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool,
    slot: ['1213', '1613'].includes(r.scheduled_slot) ? r.scheduled_slot : ['1720', '1729', '1755'].includes(r.scheduled_slot) ? 'EVENING' : 'OTHER',
    lead_time_minutes: r.lead_time_minutes, gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence, weight: r.weight,
    t_avg: tAvg[i], cloud_potential: potential[i], scores: scores[i] }));
  progress('评估（交叉验证、跨时段、区间）');
  const evaluation = evaluateAll(evalRows, policy);
  const parity = { status: 'PASS', members: rows.length, V25511_DEV: v25511, V2551_DEV: 'SKY_OFF_REFERENCE', live_parity_rows: live.length,
    neutral_f1_identical: true, gw_reconstruction: 'ROUND(CLAMP(SKY_STAGE*F_GW)) == SCORE FOR ALL H-A ROWS', engine_sha256: code.engine_sha256,
    C0_config_sha256: digest(C0), rows_without_cloud_potential: missingPotential };
  return { parity, rows: evalRows, evaluation };
}

// ---------- report ----------
const f3 = v => v == null ? '—' : Number(Number(v).toFixed(3)).toString();
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f3(x.point)}（不可估计）` : `${f3(x.point)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;
const m = s => `${f3(s.product_loss)} | ${f3(s.ge2_recall)} | ${f3(s.ge2_precision)} | ${f3(s.ge3_recall)} | ${f3(s.bias)} | ${f3(s.predicted_ge2_share)}`;
export function renderHpReport(spec, p) {
  const e = p.evaluation, A = e.A;
  const folds = A.cv5.folds.map(x => `| ${x.dates.join(' ~ ')} | ${x.L0_lines.join('/')} | ${x.variant} | ${x.variant_lines.join('/')} |`).join('\n');
  const cross = A.cross_period.map(c => c.feasible ? `| ${c.train.join('+')} → ${c.test.join('+')} | ${c.L0_lines.join('/')} | ${f3(c.L0.product_loss)} | ${c.variant} ${c.variant_lines.join('/')} | ${f3(c.candidate.product_loss)} |` : `| ${c.train.join('+')} → ${c.test.join('+')} | 不可行 | | | |`).join('\n');
  const cs = A.report.clear_sky;
  const sec = Object.entries(e.secondary).map(([k, v]) => `| H-A+${k} | ${f3(v.versus_A.candidate.product_loss)} | ${ci(v.versus_A.loss_delta)} | ${v.further_improvement} |`).join('\n');
  return `# V2.5.5.17 地平线贡献按云潜力条件化（开发数据验证）

Run：${spec.run_id}。数据 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（复用开发数据，independent_validation=false，未读取 2026-11-16 起的数据）。基准 C0 = 2.5.5.11。

**结论：${e.decision}**${e.recommended_combination ? `，推荐组合 ${e.recommended_combination}` : ''}。门槛：${Object.entries(e.gates).map(([k, v]) => `${k}=${v}`).join('，')}。

## 复现

DEV 与 V2.5.5.11 参照一致（签名 ${p.parity.V25511_DEV.prediction_signature_sha256.slice(0, 8)}…），R = 2.5.5.1 一致，线上同版本 ${p.parity.live_parity_rows} 条逐条一致；f = 1 的中性变体与 C0 逐条一致；GW 重建在全部 H-A 行上一致。无云潜力（无有效节点）的行：${p.parity.rows_without_cloud_potential}。

## 5 折样本外（A = H-A，L0 = C0 + 重新选线）

| | 产品损失 | ≥2 召回 | ≥2 精确 | ≥3 召回 | 偏差 | 预测 ≥2 |
| --- | --- | --- | --- | --- | --- | --- |
| C0 现行线 19/49/66/90（全数据） | ${m(e.current_lines_C0)} |
| L0 | ${m(A.cv5.reference)} |
| A | ${m(A.cv5.candidate)} |

产品损失差（A − L0）：${ci(A.cv5.loss_delta)}；≥2 召回差：${ci(A.cv5.ge2_recall_delta)}。11 折：A ${f3(A.cv11.candidate.product_loss)}、L0 ${f3(A.cv11.reference.product_loss)}，差 ${ci(A.cv11.loss_delta)}，A 的 ≥2 召回 ${f3(A.cv11.candidate.ge2_recall)}。

AUC≥2：A ${f3(A.auc.auc_ge2.candidate)}、C0 ${f3(A.auc.auc_ge2.C0)}，差 ${ci(A.auc.auc_ge2.delta)}；AUC≥3 差 ${ci(A.auc.auc_ge3.delta)}。

| 留出日期 | L0 线 | A 选中 | A 线 |
| --- | --- | --- | --- |
${folds}

## 跨时段

| 方向 | L0 线 | L0 损失 | A 选中与线 | A 损失 |
| --- | --- | --- | --- | --- |
${cross}

## 无云子组（总云量 < ${HP_POLICY.clear_sky_t_avg_below}%，5 折样本外，只报告）

${cs.snapshots} 条 Snapshot / ${cs.events} 个 Event，其中 GT≥2 ${cs.gt_ge2} 条。误报：L0 ${cs.L0.false_alarm_snapshots}、A ${cs.candidate.false_alarm_snapshots}；漏报 GT≥2：L0 ${cs.L0.missed_ge2_snapshots}、A ${cs.candidate.missed_ge2_snapshots}。

## 次要变体（对 H-A 的 5 折比较）

| 组合 | 产品损失 | 差（− H-A） | 进一步改进 |
| --- | --- | --- | --- |
${sec}

全数据选择（只描述）：A ${A.full_data_choice?.key ?? '—'}，线 ${A.full_data_choice?.lines?.join('/') ?? '—'}；L0 线 ${A.L0_full_data_lines?.join('/') ?? '—'}。

结论只是开发证据；是否发布与 H3 核验另行决定。
`;
}

// ---------- run / inspect / verify ----------
const REQUIRED = ['run_spec.json', 'hp_plan.json', 'parity.json', 'hp_rows.json', 'evaluation.json', 'hp_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runHp(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity(), policy = HP_POLICY;
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
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectHp(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'hp_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeHp(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const e = payload.evaluation;
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, decision: e.decision, recommended_combination: e.recommended_combination, gates: e.gates };
    for (const [name, value] of Object.entries({ 'parity.json': payload.parity, 'hp_rows.json': payload.rows, 'evaluation.json': e, 'hp_result.json': result, 'verification.json': proof }))
      await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'report.md'), renderHpReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
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
export async function inspectHp(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'hp_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'hp_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyHpRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(HP_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeHp(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  for (const p of loaded.parts) await checkInputs(p.loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyHp(directory) {
  const inspected = await inspectHp(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
