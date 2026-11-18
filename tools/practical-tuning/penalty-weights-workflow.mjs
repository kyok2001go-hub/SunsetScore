// V2.5.5.22 workflow (Practical Tuning Schema/Policy 17): scores the released 2.5.5.19 (C0), the penalty-scale members and the
// component-weight grid on DEV + H1 + H2 by Replay, tags rows with the frozen photo-review table, evaluates the two families,
// and scores the combination members only when both families pass. Read-only: explicit configs only; js/config.js never
// carries penaltyScale. PRD: ref_docs/PRD/V2.5.5.22--天气扣分幅度与组件权重评估方案.md
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
import { attachReview } from './horizon-potential-v2.mjs';
import { loadReviewTable } from './horizon-potential-v2-workflow.mjs';
import { PW_POLICY, candidateConfig, penaltyKey, weightKey, weightGrid, evaluateFamilies, needsCombination, combinationPairs, evaluateAll } from './penalty-weights.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 17;

export async function computePw(loaded, code, progress = () => {}, policy = PW_POLICY) {
  const table = await loadReviewTable(policy), configs = await releaseConfigs(), C0 = configs['2.5.5.19'];
  if (!C0 || C0.version !== '2.5.5.19' || 'penaltyScale' in C0) fail('PW_BASELINE_CONFIG_MISMATCH');
  const calculator = p0Calculator(code.engine_sha256);
  progress('C0（2.5.5.19）预检');
  const checked = await preflight(loaded, C0, calculator, progress);
  if (checked.exclusions.length) fail('PW_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scores = rows.map(r => ({ C0: r.control_score }));
  if (digest(rows.map((r, i) => [r.snapshot_id, scores[i].C0])) !== policy.baseline_reference.signature_sha256) fail('PW_BASELINE_PARITY_FAILED');
  progress('C0 Trace（扣分）');
  const traced = p0Calculator(code.engine_sha256), penalty = [];
  for (const [i, row] of rows.entries()) {
    const result = await traced.calculate(row, C0, true);
    if (result.score !== scores[i].C0) fail('PW_TRACED_C0_DIFFERS');
    penalty.push(result.trace.weather_penalty ?? null);
  }
  if (penalty.some(v => !Number.isFinite(v))) fail('PW_TRACE_PENALTY_MISSING');
  progress('中性检查 penaltyScale = 1');
  const neutral = { ...structuredClone(C0), penaltyScale: 1 };
  for (const [i, row] of rows.entries()) if ((await calculator.calculate(row, neutral)).score !== scores[i].C0) fail('PW_NEUTRAL_SCALE_CHANGED_SCORE', { detail: row.snapshot_id });
  const score = async (key, config) => { for (const [i, row] of rows.entries()) scores[i][key] = (await calculator.calculate(row, config)).score; };
  for (const s of policy.penalty_grid.filter(v => v !== 1)) { progress(`扣分 ${penaltyKey(s)}`); await score(penaltyKey(s), candidateConfig(C0, { penaltyScale: s })); }
  const grid = weightGrid(policy).filter(w => weightKey(w) !== 'C0');
  for (const [n, w] of grid.entries()) { progress(`权重 ${n + 1}/${grid.length} ${weightKey(w)}`); await score(weightKey(w), candidateConfig(C0, { weights: w })); }
  const evalRows = attachReview(rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool,
    slot: ['1213', '1613'].includes(r.scheduled_slot) ? r.scheduled_slot : ['1720', '1729', '1755'].includes(r.scheduled_slot) ? 'EVENING' : 'OTHER',
    lead_time_minutes: r.lead_time_minutes, gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence, weight: r.weight,
    weather_penalty: Math.round(penalty[i] * 1000) / 1000, scores: scores[i] })), table, policy);
  progress('评估两组候选（交叉验证、跨时段、区间、Brier）');
  const families = evaluateFamilies(evalRows, policy);
  let combinationRows = null, combinationMembers = [];
  if (needsCombination(families)) {
    const pairs = combinationPairs(families.P, families.W);
    combinationMembers = [...pairs.keys()].filter(k => !(k in scores[0]));
    if (combinationMembers.length > policy.max_combination_members) fail('PW_TOO_MANY_COMBINATION_MEMBERS');
    for (const key of combinationMembers) { progress(`组合 ${key}`); await score(key, candidateConfig(C0, pairs.get(key))); }
    combinationRows = evalRows.map((r, i) => ({ ...r, scores: scores[i] }));
  }
  progress('判定');
  const evaluation = evaluateAll(evalRows, policy, families, combinationRows);
  const parity = { status: 'PASS', members: rows.length, baseline: policy.baseline_reference, engine_sha256: code.engine_sha256, C0_config_sha256: digest(C0),
    neutral_penalty_scale_1_identical: true, penalised_rows: penalty.filter(v => v > 0).length, configs_scored: Object.keys(scores[0]).length,
    combination_members_scored: combinationMembers };
  return { parity, rows: combinationRows ?? evalRows, evaluation };
}

// ---------- report ----------
const f3 = v => v == null ? '—' : Number(Number(v).toFixed(3)).toString();
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f3(x.point)}（不可估计）` : `${f3(x.point)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;
const m = s => `${f3(s.product_loss)} | ${f3(s.ge2_recall_cloud_type)} | ${f3(s.ge2_recall)} | ${f3(s.ge2_precision)} | ${f3(s.ge3_recall)} | ${f3(s.false_alarm_rate)} | ${f3(s.bias)}`;
const HEAD = '| | 产品损失 | ≥2 召回（有云） | ≥2 召回（全体） | ≥2 精确 | ≥3 召回 | 误报率 | 偏差 |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
function familySection(name, label, F) {
  if (!F) return '';
  const folds = F.cv5.folds.map(x => `| ${x.dates.join(' ~ ')} | ${x.L0_lines.join('/')} | ${x.member} | ${x.member_lines.join('/')} |`).join('\n');
  const cross = F.cross_period.map(c => c.feasible ? `| ${c.train.join('+')} → ${c.test.join('+')} | ${f3(c.L0.product_loss)} | ${c.member} ${c.member_lines.join('/')} | ${f3(c.candidate.product_loss)} |` : `| ${c.train.join('+')} → ${c.test.join('+')} | 不可行 | | |`).join('\n');
  return `## ${name}：${label}

**结论：${F.decision}。** 门槛：${Object.entries(F.gates).map(([k, v]) => `${k}=${v}`).join('，')}。

${HEAD}
| L0（5 折） | ${m(F.cv5.reference)} |
| ${name}（5 折） | ${m(F.cv5.candidate)} |

产品损失差（${name} − L0）：5 折 ${ci(F.cv5.loss_delta)}；11 折 ${ci(F.cv11.loss_delta)}。全体 ≥2 召回差：${ci(F.cv5.ge2_recall_delta)}。
AUC≥2 差（− C0）：${ci(F.auc.auc_ge2.delta)}；AUC≥3 差：${ci(F.auc.auc_ge3.delta)}。Brier 差（5 折）：${ci(F.brier.cv5.delta)}。
11 折有云 / 全体 ≥2 召回：${f3(F.cv11.candidate.ge2_recall_cloud_type)} / ${f3(F.cv11.candidate.ge2_recall)}。

| 留出日期 | L0 线 | 选中 | 选中的线 |
| --- | --- | --- | --- |
${folds}

11 折选中：${F.chosen_members?.cv11?.join('、') ?? '—'}。

| 跨时段 | L0 损失 | 选中与线 | 损失 |
| --- | --- | --- | --- |
${cross}
`;
}
export function renderPwReport(spec, p, policy = PW_POLICY) {
  const e = p.evaluation, pen = e.P.report.penalised;
  const sens = [...e.report_only.weight_sensitivity].sort((a, b) => b.auc_ge2 - a.auc_ge2).slice(0, 8)
    .map(w => `| ${w.skyCanvas} / ${w.horizon} / ${w.illumination} | ${f3(w.auc_ge2)} | ${f3(w.auc_ge3)} |`).join('\n');
  const c0 = e.report_only.weight_sensitivity.find(w => w.key === 'C0');
  return `# V2.5.5.22 天气扣分幅度与组件权重评估（开发数据验证）

Run：${spec.run_id}。数据 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（复用开发数据，independent_validation=false，未读取 2026-11-16 起的数据）。基准 C0 = 2.5.5.19。

**结论：${e.decision}**${e.recommended ? `，推荐 ${e.recommended}` : ''}。P：${e.P.decision}；W：${e.W.decision}${e.combination ? `；组合：${e.combination.decision}` : ''}。

## 复现

C0 在全部 ${p.parity.members} 条上与 ${p.parity.baseline.run_id} 的 ${p.parity.baseline.key} 逐条相同；penaltyScale = 1 与 C0 逐条相同；被扣分的记录 ${p.parity.penalised_rows} 条；共重算 ${p.parity.configs_scored} 套配置。

C0 现行线 ${policy.lines.current.join('/')}（全数据）：产品损失 ${f3(e.current_lines_C0.product_loss)}，有云 / 全体 ≥2 召回 ${f3(e.current_lines_C0.ge2_recall_cloud_type)} / ${f3(e.current_lines_C0.ge2_recall)}。

${familySection('P', '天气扣分幅度', e.P)}
${familySection('W', '组件权重', e.W)}
${e.combination ? familySection('P+W', '组合', e.combination) : ''}
## 只报告

**被扣分的子组（P，5 折样本外）：** ${pen.snapshots} 条，其中 GT≥2 ${pen.gt_ge2_snapshots} 条。误报 L0 ${pen.L0.false_alarm_snapshots} → P ${pen.candidate.false_alarm_snapshots}；漏报 GT≥2 L0 ${pen.L0.missed_ge2_snapshots} → P ${pen.candidate.missed_ge2_snapshots}；偏差 ${f3(pen.L0.bias)} → ${f3(pen.candidate.bias)}。

**权重灵敏度（全部数据，不选线；AUC≥2 最高的 8 组，现值 ${c0.skyCanvas} / ${c0.horizon} / ${c0.illumination}：AUC≥2 ${f3(c0.auc_ge2)}、AUC≥3 ${f3(c0.auc_ge3)}）：**

| 画布 / 地平线 / 光照 | AUC≥2 | AUC≥3 |
| --- | --- | --- |
${sens}

全数据选择（只描述）：P ${e.P.full_data_choice?.key ?? '—'} ${e.P.full_data_choice?.lines?.join('/') ?? ''}；W ${e.W.full_data_choice?.key ?? '—'} ${e.W.full_data_choice?.lines?.join('/') ?? ''}；L0 ${e.report_only.full_data_lines.L0?.join('/') ?? '—'}。

结论只是开发证据；是否发布与 H4 核验另行决定。
`;
}

// ---------- run / inspect / verify ----------
const REQUIRED = ['run_spec.json', 'pw_plan.json', 'parity.json', 'pw_rows.json', 'evaluation.json', 'pw_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runPw(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity(), policy = PW_POLICY;
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
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectPw(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'pw_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computePw(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const e = payload.evaluation;
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, decision: e.decision, recommended: e.recommended,
      families: { P: { decision: e.P.decision, gates: e.P.gates }, W: { decision: e.W.decision, gates: e.W.gates } },
      combination: e.combination ? { decision: e.combination.decision, gates: e.combination.gates } : null };
    for (const [name, value] of Object.entries({ 'parity.json': payload.parity, 'pw_rows.json': payload.rows, 'evaluation.json': e, 'pw_result.json': result, 'verification.json': proof }))
      await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'report.md'), renderPwReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
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
export async function inspectPw(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'pw_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'pw_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyPwRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(PW_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computePw(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  for (const p of loaded.parts) await checkInputs(p.loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyPw(directory) {
  const inspected = await inspectPw(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
