// V2.5.5.21 workflow (Practical Tuning Schema/Policy 16): scores the released 2.5.5.19 (C0) and the redundancy candidates on
// DEV + H1 + H2 by Replay, derives the golden-window cap (G1) from traced rows, then runs the pre-registered evaluation
// (redundancy.mjs). Read-only: explicit configs only; js/ is not changed. PRD: ref_docs/PRD/V2.5.5.21--三项单参数去冗余评估方案.md
import path from 'node:path';
import { mkdir, writeFile, rename, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../dataset/lib/common.mjs';
import { releaseConfigs } from '../model-release/holdout.mjs';
import { APP_ROOT, codeIdentity, checkInputs } from './data.mjs';
import { preflight } from './compute.mjs';
import { digest } from './policy.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { acquireRunLock, atomicJson } from './workflow.mjs';
import { p0Calculator } from './p0-workflow.mjs';
import { loadPooled, defaultPools } from './p0-pooled-workflow.mjs';
import { RD_POLICY, candidateConfig, keyOf, capGoldenWindow, referenceByRule, evaluateAll } from './redundancy.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 16;
const stageOutput = (trace, stage) => { const s = trace.stages.find(x => x.stage === stage); if (!s) fail('RD_TRACE_STAGE_MISSING', { detail: stage }); return s.output_score; };
const clampRound = v => Math.round(Math.min(100, Math.max(0, v)));

export async function computeRd(loaded, code, progress = () => {}, policy = RD_POLICY) {
  const configs = await releaseConfigs(), C0 = configs['2.5.5.19'];
  if (!C0 || C0.version !== '2.5.5.19' || !C0.horizonCloudPotential) fail('RD_BASELINE_CONFIG_MISMATCH');
  const calculator = p0Calculator(code.engine_sha256);
  progress('C0（2.5.5.19）预检');
  const checked = await preflight(loaded, C0, calculator, progress);
  if (checked.exclusions.length) fail('RD_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scores = rows.map(r => ({ C0: r.control_score }));
  if (digest(rows.map((r, i) => [r.snapshot_id, scores[i].C0])) !== policy.baseline_reference.signature_sha256) fail('RD_BASELINE_PARITY_FAILED');
  // Traced passes: C0, T0, W0, T0W0. Each gives its own score and, through the golden-window trace, its G1 variant.
  const floor = C0.goldenWindow.floor, openProbabilities = [];
  let gwActive = 0;
  for (const parts of [[], ['T0'], ['W0'], ['T0', 'W0']]) {
    const key = keyOf(parts), config = candidateConfig(C0, parts), traced = p0Calculator(code.engine_sha256);
    progress(`${key}（含 G1 后处理）`);
    for (const [i, row] of rows.entries()) {
      const result = await traced.calculate(row, config, true), gw = result.trace.diagnostic_observer.golden_window;
      const sky = stageOutput(result.trace, 'sky_evolution'), applied = gw.active ? gw.applied_factor : 1;
      if (clampRound(sky * applied) !== result.score) fail('RD_GW_RECONSTRUCTION_MISMATCH', { detail: row.snapshot_id });
      if (key === 'C0' && result.score !== scores[i].C0) fail('RD_TRACED_C0_DIFFERS');
      scores[i][key] = result.score;
      scores[i][keyOf([...parts, 'G1'])] = gw.active ? capGoldenWindow(sky, applied) : result.score;
      if (key === 'C0' && gw.active) { gwActive++; openProbabilities.push(gw.sunset_open_probability); }
    }
  }
  // Report-only members: W0 at 0.02, and the golden-window reference recomputed by the V2.5.5.2 rule on all rows.
  const recomputed = referenceByRule(openProbabilities, floor);
  if (recomputed !== policy.report_only.GREF_reference) fail('RD_GREF_REFERENCE_DRIFT', { detail: String(recomputed) });
  for (const [key, extra] of [['W0_02', { minimumWeatherWeight: policy.report_only.W0_02 }], ['GREF', { reference: policy.report_only.GREF_reference }]]) {
    progress(`只报告 ${key}`);
    const config = candidateConfig(C0, [], extra);
    for (const [i, row] of rows.entries()) scores[i][key] = (await calculator.calculate(row, config)).score;
  }
  const evalRows = rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool,
    slot: ['1213', '1613'].includes(r.scheduled_slot) ? r.scheduled_slot : ['1720', '1729', '1755'].includes(r.scheduled_slot) ? 'EVENING' : 'OTHER',
    lead_time_minutes: r.lead_time_minutes, gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence, weight: r.weight, scores: scores[i] }));
  progress('评估（成对比较、区间、组合）');
  const evaluation = evaluateAll(evalRows, policy);
  const parity = { status: 'PASS', members: rows.length, baseline: policy.baseline_reference, engine_sha256: code.engine_sha256, C0_config_sha256: digest(C0),
    gw_reconstruction: 'ROUND(CLAMP(SKY_STAGE*F_GW)) == SCORE FOR ALL ROWS OF C0 / T0 / W0 / T0W0', gw_active_rows: gwActive, gref_reference_recomputed: recomputed,
    g1_never_raises: rows.every((r, i) => [['C0', 'G1'], ['T0', 'T0G1'], ['W0', 'W0G1'], ['T0W0', 'T0W0G1']].every(([base, capped]) => scores[i][capped] <= scores[i][base])) };
  if (!parity.g1_never_raises) fail('RD_G1_RAISED_A_SCORE');
  return { parity, rows: evalRows, evaluation };
}

// ---------- report ----------
const f3 = v => v == null ? '—' : Number(Number(v).toFixed(3)).toString();
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f3(x.point)}（不可估计）` : `${f3(x.point)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;
const m = s => `${f3(s.product_loss)} | ${f3(s.ge2_recall)} | ${f3(s.ge2_precision)} | ${f3(s.ge3_recall)} | ${f3(s.false_alarm_rate)} | ${f3(s.bias)} | ${f3(s.predicted_ge2_share)}`;
const NAMES = { T0: '去过渡加分', W0: '去天气下限', G1: '黄金窗口只扣分' };
export function renderRdReport(spec, p, policy = RD_POLICY) {
  const e = p.evaluation, s = e.singles, line = (k, c) => `| ${k}${NAMES[k] ? ' ' + NAMES[k] : ''} | ${m(c.candidate)} |`;
  const gateRow = (k, c) => `| ${k} | ${ci(c.loss_delta)} | ${ci(c.auc_ge2.delta)} | ${f3(c.candidate.ge2_recall)} | ${c.periods.map(x => f3(x.loss_delta_point)).join(' / ')} | ${Object.values(c.gates).map(v => v ? '✓' : '✗').join('')} | ${c.decision} |`;
  const all = [...policy.candidate_order.map(k => [k, s[k]]), ...(e.combination ? [[e.combination.key, e.combination]] : [])];
  const extra = Object.entries(e.report_only.extra).map(([k, c]) => `| ${k} | ${ci(c.loss_delta)} | ${ci(c.auc_ge2.delta)} | ${f3(c.candidate.ge2_recall)} | ${c.changes.score_down} / ${c.changes.score_up} |`).join('\n');
  const combos = Object.entries(e.report_only.combinations_all).map(([k, c]) => `| ${k} | ${f3(c.candidate.product_loss)} | ${f3(c.loss_delta_point)} | ${f3(c.candidate.ge2_recall)} |`).join('\n');
  const slotKeys = Object.keys(Object.values(e.report_only.by_slot)[0]).filter(k => k !== 'snapshots');
  const slots = Object.entries(e.report_only.by_slot).map(([g, v]) => `| ${g} | ${v.snapshots} | ${slotKeys.map(k => `${f3(v[k].bias)} / ${f3(v[k].false_alarm_rate)}`).join(' | ')} |`).join('\n');
  return `# V2.5.5.21 三项单参数去冗余评估（开发数据验证）

Run：${spec.run_id}。数据 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（复用开发数据，independent_validation=false，未读取 2026-11-16 起的数据）。基准 C0 = 2.5.5.19；分数线固定 ${policy.lines.current.join('/')}。

**结论：${e.decision}**${e.recommended ? `，推荐 ${e.recommended}` : ''}。通过的单项：${e.adopted.length ? e.adopted.join('、') : '无'}。

## 复现

C0 在全部 ${p.parity.members} 条上与 ${p.parity.baseline.run_id} 的 ${p.parity.baseline.key} 逐条相同；黄金窗口重建在 C0 / T0 / W0 / T0W0 的全部行上成立；启用黄金窗口 ${p.parity.gw_active_rows} 条；G1 没有让任何一条分数升高；按 V2.5.5.2 规则在全部数据上重算的中心为 ${p.parity.gref_reference_recomputed}。

## 指标（全部数据，现行线）

| | 产品损失 | ≥2 召回 | ≥2 精确 | ≥3 召回 | 误报率 | 偏差 | 预测 ≥2 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C0 2.5.5.19 | ${m(e.C0)} |
${all.map(([k, c]) => line(k, c)).join('\n')}

## 判定（候选 − C0）

| 候选 | 产品损失差 | ΔAUC≥2 | ≥2 召回 | 损失差 DEV / H1+H2 | G1–G4 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
${all.map(([k, c]) => gateRow(k, c)).join('\n')}

AUC≥3 差：${all.map(([k, c]) => `${k} ${ci(c.auc_ge3.delta)}`).join('；')}。

## 只报告

### 补充对照

| 配置 | 产品损失差 | ΔAUC≥2 | ≥2 召回 | 分数降 / 升 条数 |
| --- | --- | --- | --- | --- |
${extra}

### 全部组合（点估计）

| 组合 | 产品损失 | 差（− C0） | ≥2 召回 |
| --- | --- | --- | --- |
${combos}

### 按时段（偏差 / 误报率）

| 时段 | Snapshot | ${slotKeys.join(' | ')} |
| --- | --- | ${slotKeys.map(() => '---').join(' | ')} |
${slots}

分数变化（降 / 升，等级降 / 升）：${all.map(([k, c]) => `${k} ${c.changes.score_down}/${c.changes.score_up}，${c.changes.grade_down}/${c.changes.grade_up}`).join('；')}。

全数据重新选线（只描述）：${Object.entries(e.report_only.full_data_lines).map(([k, v]) => `${k} ${v ? v.join('/') : '—'}`).join('；')}。

三个候选各自用 95% 区间、未做多重比较校正；结论只决定哪个候选进入下一次前向留出，不作为发布依据。
`;
}

// ---------- run / inspect / verify ----------
const REQUIRED = ['run_spec.json', 'rd_plan.json', 'parity.json', 'rd_rows.json', 'evaluation.json', 'rd_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runRd(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity(), policy = RD_POLICY;
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const roots of Object.values(loaded.roots)) for (const root of Object.values(roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const configs = await releaseConfigs();
  const identity = { schema: SCHEMA, policy, plan_sha256: digest(policy), inputs: loaded.fingerprints, C0_config_sha256: digest(configs['2.5.5.19']),
    code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version };
  const runId = `practical_tuning_v${SCHEMA}_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectRd(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'rd_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeRd(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const e = payload.evaluation;
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, decision: e.decision, recommended: e.recommended, adopted: e.adopted,
      gates: Object.fromEntries(Object.entries(e.singles).map(([k, v]) => [k, v.gates])) };
    for (const [name, value] of Object.entries({ 'parity.json': payload.parity, 'rd_rows.json': payload.rows, 'evaluation.json': e, 'rd_result.json': result, 'verification.json': proof }))
      await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'report.md'), renderRdReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
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
export async function inspectRd(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'rd_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'rd_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyRdRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(RD_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeRd(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  for (const p of loaded.parts) await checkInputs(p.loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyRd(directory) {
  const inspected = await inspectRd(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
