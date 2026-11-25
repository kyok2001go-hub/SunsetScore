// V2.5.5.35 workflow (Practical Tuning Schema/Policy 20): scores the released 2.5.5.19 (C0) and the two referenceByLead members on
// DEV + H1 + H2 by Replay, traces C0 and K1 to check every applied golden-window factor against the frozen tables, tags rows with the
// frozen photo-review table and applies N1–N4 + T1 at the current lines. Read-only: explicit configs only; js/config.js never carries
// referenceByLead. PRD: ref_docs/PRD/V2.5.5.35--晚间黄金窗口分数水平修正方案.md
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
import { GL_POLICY, MEMBER_KEYS, memberConfig, expectedFactor, evaluateAll } from './gw-lead-reference.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 20;
const slotOf = s => ['1213', '1613'].includes(s) ? s : ['1720', '1729', '1755'].includes(s) ? 'EVENING' : 'OTHER';

/** §4 check on one row: applied factor equals the frozen formula for C0 (single reference) and for K1 (table at the row's lead time). */
export function factorCheck(row, c0, k1, C0config, policy = GL_POLICY) {
  const ga = c0.golden_window_observation, gb = k1.golden_window_observation, active = c0.golden_window_active === true;
  if (active !== (k1.golden_window_active === true)) fail('GL_ACTIVE_MISMATCH', { detail: row.snapshot_id });
  if (!active) return { active: false, C0: 1, K1: 1 };
  const p = ga.sunset_open_probability, floor = C0config.goldenWindow.floor;
  if (p !== gb.sunset_open_probability) fail('GL_PROBABILITY_MISMATCH', { detail: row.snapshot_id });
  const e0 = expectedFactor(p, row.lead_time_minutes, floor, [{ maxLeadMinutes: Infinity, reference: C0config.goldenWindow.reference }]);
  const e1 = expectedFactor(p, row.lead_time_minutes, floor, policy.members[policy.primary].referenceByLead);
  if (Math.abs(ga.applied_factor - e0) > policy.factor_tolerance) fail('GL_C0_FACTOR_MISMATCH', { detail: { snapshot: row.snapshot_id, applied: ga.applied_factor, expected: e0 } });
  if (Math.abs(gb.applied_factor - e1) > policy.factor_tolerance) fail('GL_K1_FACTOR_MISMATCH', { detail: { snapshot: row.snapshot_id, applied: gb.applied_factor, expected: e1, lead: row.lead_time_minutes } });
  return { active: true, C0: ga.applied_factor, K1: gb.applied_factor, source: ga.probability_source ?? null };
}

export async function computeGl(loaded, code, progress = () => {}, policy = GL_POLICY) {
  const table = await loadReviewTable(policy), configs = await releaseConfigs(), C0 = configs['2.5.5.19'];
  if (!C0 || C0.version !== '2.5.5.19' || 'referenceByLead' in (C0.goldenWindow || {})) fail('GL_BASELINE_CONFIG_MISMATCH');
  const calculator = p0Calculator(code.engine_sha256);
  progress('C0（2.5.5.19）预检');
  const checked = await preflight(loaded, C0, calculator, progress);
  if (checked.exclusions.length) fail('GL_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scores = rows.map(r => ({ C0: r.control_score }));
  if (digest(rows.map((r, i) => [r.snapshot_id, scores[i].C0])) !== policy.baseline_reference.signature_sha256) fail('GL_BASELINE_PARITY_FAILED');
  progress('C0 与 K1 Trace（黄金窗口因子核对）');
  const traced = p0Calculator(code.engine_sha256), K1 = memberConfig(C0, policy.primary, policy), factors = [], C = [];
  for (const [i, row] of rows.entries()) {
    const a = await traced.calculate(row, C0, true), b = await traced.calculate(row, K1, true);
    if (a.score !== scores[i].C0) fail('GL_TRACE_SCORE_MISMATCH', { detail: row.snapshot_id });
    factors.push(factorCheck(row, a.trace, b.trace, C0, policy)); C.push(a.trace.horizon_cloud_potential?.value ?? null);
    scores[i][policy.primary] = b.score;
    if ((i + 1) % 200 === 0) progress(`Trace ${i + 1}/${rows.length}`);
  }
  for (const key of MEMBER_KEYS.filter(k => k !== policy.primary)) {
    progress(`成员 ${key}`); const config = memberConfig(C0, key, policy);
    for (const [i, row] of rows.entries()) scores[i][key] = (await calculator.calculate(row, config)).score;
  }
  const evalRows = attachReview(rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool,
    city: r.city, slot: slotOf(r.scheduled_slot), lead_time_minutes: r.lead_time_minutes, gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence,
    weight: r.weight, C: C[i], scores: scores[i] })), table, policy);
  progress('判定（现行线下 N1–N4 与 T1）与只报告项');
  const evaluation = evaluateAll(evalRows, factors, policy);
  const active = factors.filter(f => f.active), sources = [...new Set(active.map(f => f.source))].sort();
  const parity = { status: 'PASS', members: rows.length, baseline: policy.baseline_reference, engine_sha256: code.engine_sha256, C0_config_sha256: digest(C0),
    configs_scored: Object.keys(scores[0]).length, active_rows: active.length, factor_tolerance: policy.factor_tolerance,
    probability_sources: Object.fromEntries(sources.map(s => [s, active.filter(f => f.source === s).length])),
    rows_with_changed_factor: active.filter(f => f.C0 !== f.K1).length };
  return { parity, rows: evalRows, evaluation };
}

// ---------- report ----------
const f3 = v => v == null ? '—' : Number(Number(v).toFixed(3)).toString();
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f3(x.point)}（不可估计）` : `${f3(x.point)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;
const m = s => `${f3(s.product_loss)} | ${f3(s.ge2_recall_cloud_type)} | ${f3(s.ge2_recall)} | ${f3(s.ge2_precision)} | ${f3(s.ge3_recall)} | ${f3(s.false_alarm_rate)} | ${f3(s.bias)}`;
const HEAD = '| | 产品损失 | ≥2 召回（有云） | ≥2 召回（全体） | ≥2 精确 | ≥3 召回 | 误报率 | 偏差 |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
const N_LABEL = { N1_auc_ge2_lower_above_minus_0_01: 'N1 ΔAUC≥2 下限 > −0.01', N2_auc_ge3_lower_above_minus_0_02: 'N2 ΔAUC≥3 下限 > −0.02',
  N3_loss_upper_at_most_0_02: 'N3 损失差上限 ≤ +0.02', N4_recall_not_lower_by_more_than_0_01: 'N4 全体与有云 ≥2 召回不低于 C0 超过 0.01',
  T1_evening_minus_1613_at_most_1_0: 'T1 晚间 − 16:13 平均分差 ≤ +1.0' };
const sub = (name, s) => !s ? '' : `| ${name} | ${s.snapshots} | ${s.gt_ge2_snapshots} | ${f3(s.C0.product_loss)} → ${f3(s.candidate.product_loss)} | ${f3(s.C0.ge2_recall)} → ${f3(s.candidate.ge2_recall)} | ${f3(s.mean_score_change)} |`;
export function renderGlReport(spec, p, policy = GL_POLICY) {
  const e = p.evaluation, F = e.at_current_lines, T = e.evening_gap, R = e.report_only, b = R.breakdowns, K = R.members.K1P;
  const lead = Object.entries(R.by_lead).map(([k, x]) => `| ${k} | ${x.snapshots} | ${f3(x.mean_factor_C0)} → ${f3(x.mean_factor_candidate)} | ${f3(x.mean_score_C0)} → ${f3(x.mean_score_candidate)} | ${f3(x.over_rate_C0)} → ${f3(x.over_rate_candidate)} |`).join('\n');
  const cross = Object.entries(R.cross_period).map(([k, c]) => `| ${k} | ${c.snapshots} | ${f3(c.C0.product_loss)} → ${f3(c.candidate.product_loss)} | ${ci(c.loss_delta)} | ${ci(c.ge2_recall_delta)} | ${ci(c.auc_ge2.delta)} |`).join('\n');
  return `# V2.5.5.35 晚间黄金窗口分数水平修正（开发数据评估）

Run：${spec.run_id}。数据 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（复用开发数据，independent_validation=false，未读取 ${policy.h3_first_date} 起的数据）。基准 C0 = 2.5.5.19；主候选 K1（五段 reference：${policy.members.K1.referenceByLead.map(x => `≤${x.maxLeadMinutes} 分钟 ${x.reference}`).join('，')}）。现行线 ${policy.rule.lines.join(' / ')}，不选线。

**结论：${e.decision}**${e.failed.length ? `（未满足：${e.failed.map(k => N_LABEL[k]).join('；')}）` : ''}。

## 复现与核对

C0 在全部 ${p.parity.members} 条上与 ${p.parity.baseline.run_id} 的 ${p.parity.baseline.key} 逐条相同；共重算 ${p.parity.configs_scored} 套配置。启用黄金窗口的 ${p.parity.active_rows} 条中，C0 与 K1 的因子都与冻结公式逐条相等（容差 ${p.parity.factor_tolerance}），${p.parity.rows_with_changed_factor} 条因子改变。概率来源：${Object.entries(p.parity.probability_sources).map(([k, v]) => `${k} ${v}`).join('，')}。

## 判定（K1 对 C0，现行线）

${Object.entries(e.conditions).map(([k, v]) => `- ${N_LABEL[k]}：${v ? '满足' : '**不满足**'}`).join('\n')}

${HEAD}
| C0 | ${m(F.C0)} |
| K1 | ${m(F.candidate)} |

- 产品损失差：${ci(F.loss_delta)}
- 全体 ≥2 召回差：${ci(F.ge2_recall_delta)}；有云 ≥2 召回差：${ci(F.ge2_recall_cloud_type_delta)}；≥3 召回差：${ci(F.ge3_recall_delta)}
- AUC≥2：${f3(F.auc_ge2.C0)} → ${f3(F.auc_ge2.candidate)}，差 ${ci(F.auc_ge2.delta)}；AUC≥3：${f3(F.auc_ge3.C0)} → ${f3(F.auc_ge3.candidate)}，差 ${ci(F.auc_ge3.delta)}
- 高报率（全部 Snapshot）：${f3(F.over_rate.C0)} → ${f3(F.over_rate.candidate)}；晚间决策快照：${f3(R.decision_evening_over_rate.over_rate_C0)} → ${f3(R.decision_evening_over_rate.over_rate_candidate)}（${R.decision_evening_over_rate.events} 个 Event）
- T1：${T.events} 个同时有 16:13 与晚间快照的 Event，晚间 − 16:13 平均分差 ${f3(T.C0_mean)} → ${f3(T.candidate_mean)}，|差| ≥ 5 的 ${T.C0_abs_ge5} → ${T.candidate_abs_ge5}
- 等级改变的 Snapshot：${F.grade_changes} 条

## 只报告：按距日落时距

| 距日落（分钟） | 条数 | 平均因子 C0 → K1 | 平均分 | 高报率 |
| --- | --- | --- | --- | --- |
${lead}

## 只报告：两段版 K1P

产品损失 ${f3(K.at_current_lines.candidate.product_loss)}，损失差 ${ci(K.at_current_lines.loss_delta)}；ΔAUC≥2 ${ci(K.at_current_lines.auc_ge2.delta)}；ΔAUC≥3 ${ci(K.at_current_lines.auc_ge3.delta)}；全体 / 有云 ≥2 召回 ${f3(K.at_current_lines.candidate.ge2_recall)} / ${f3(K.at_current_lines.candidate.ge2_recall_cloud_type)}；T1 ${f3(K.evening_gap.candidate_mean)}。

## 只报告：跨时段与分组

| 时段 | 条数 | 损失 C0 → K1 | 损失差 | 全体 ≥2 召回差 | ΔAUC≥2 |
| --- | --- | --- | --- | --- | --- |
${cross}

| 分组 | 条数 | GT≥2 | 损失 | 全体 ≥2 召回 | 平均分数变化 |
| --- | --- | --- | --- | --- | --- |
${Object.entries(b.by_pool).map(([k, s]) => sub(`数据池 ${k}`, s)).join('\n')}
${Object.entries(b.by_slot).map(([k, s]) => sub(`时段 ${k}`, s)).join('\n')}
${Object.entries(b.by_region).map(([k, s]) => sub(k === 'SOUTH' ? '南方组' : '其余城市', s)).join('\n')}
${sub('C < 5%', R.by_clear_sky.C_lt5)}
${sub('C ≥ 5%', R.by_clear_sky.C_ge5)}

结论只是开发证据；是否发布另写 PRD（PRD 第 7 节）。
`;
}

// ---------- run / inspect / verify ----------
const REQUIRED = ['run_spec.json', 'gl_plan.json', 'parity.json', 'gl_rows.json', 'evaluation.json', 'gl_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runGl(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity(), policy = GL_POLICY;
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
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectGl(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'gl_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeGl(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const e = payload.evaluation;
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, primary: e.primary, decision: e.decision, conditions: e.conditions, failed: e.failed };
    for (const [name, value] of Object.entries({ 'parity.json': payload.parity, 'gl_rows.json': payload.rows, 'evaluation.json': e, 'gl_result.json': result, 'verification.json': proof }))
      await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'report.md'), renderGlReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
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
export async function inspectGl(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'gl_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'gl_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyGlRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(GL_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeGl(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  for (const p of loaded.parts) await checkInputs(p.loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyGl(directory) {
  const inspected = await inspectGl(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
