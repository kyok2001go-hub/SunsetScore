// V2.5.5.31 workflow (Practical Tuning Schema/Policy 19): scores the released 2.5.5.19 (C0) and the five canvasMerge members on
// DEV + H1 + H2 by Replay, traces C0 and M1 to check the merged dynamic weight against the two original weights, tags rows with
// the frozen photo-review table and applies the non-inferiority rule at the current lines. Read-only: explicit configs only;
// js/config.js never carries canvasMerge. PRD: ref_docs/PRD/V2.5.5.31--云幕与光照组件合并方案.md
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
import { CM_POLICY, MEMBER_KEYS, memberConfig, evaluateAll, distribution } from './canvas-merge.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 19;
const r6 = v => typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const slotOf = s => ['1213', '1613'].includes(s) ? s : ['1720', '1729', '1755'].includes(s) ? 'EVENING' : 'OTHER';

/** §5.1 checks on one row: merged weight = C0 sky + illumination weight, other weights equal, illumination weight 0, M1 trace complete. */
export function weightCheck(c0, m1, policy = CM_POLICY) {
  const a = c0.dynamic_weights, b = m1.dynamic_weights, tol = policy.weight_tolerance, cm = m1.canvas_merge, M = policy.members[policy.primary].canvasMerge;
  if (!cm || cm.sky_canvas_share !== M.skyCanvasShare || cm.scale !== M.scale || cm.twilight_factor !== 1 || m1.components.illumination !== null || 'canvas_merge' in c0) fail('CM_TRACE_INVALID');
  const merged = Math.abs(b.skyCanvas - (a.skyCanvas + a.illumination)), others = Math.max(...['horizon', 'atmosphere', 'weather'].map(k => Math.abs(b[k] - a[k])));
  if (!(merged <= tol) || !(others <= tol) || b.illumination !== 0) fail('CM_DYNAMIC_WEIGHT_MISMATCH', { detail: { merged, others } });
  if (Math.abs(cm.sky_canvas_original - c0.components.skyCanvas) > 1e-9) fail('CM_ORIGINAL_SKY_CANVAS_MISMATCH');
  return { merged_abs_diff: merged, other_abs_diff: others };
}

export async function computeCm(loaded, code, progress = () => {}, policy = CM_POLICY) {
  const table = await loadReviewTable(policy), configs = await releaseConfigs(), C0 = configs['2.5.5.19'];
  if (!C0 || C0.version !== '2.5.5.19' || 'canvasMerge' in C0) fail('CM_BASELINE_CONFIG_MISMATCH');
  const calculator = p0Calculator(code.engine_sha256);
  progress('C0（2.5.5.19）预检');
  const checked = await preflight(loaded, C0, calculator, progress);
  if (checked.exclusions.length) fail('CM_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scores = rows.map(r => ({ C0: r.control_score }));
  if (digest(rows.map((r, i) => [r.snapshot_id, scores[i].C0])) !== policy.baseline_reference.signature_sha256) fail('CM_BASELINE_PARITY_FAILED');
  progress('C0 与 M1 Trace（动态权重核对）');
  const traced = p0Calculator(code.engine_sha256), M1 = memberConfig(C0, policy.primary, policy), checks = [];
  for (const [i, row] of rows.entries()) {
    const a = await traced.calculate(row, C0, true), b = await traced.calculate(row, M1, true);
    if (a.score !== scores[i].C0) fail('CM_TRACE_SCORE_MISMATCH', { detail: row.snapshot_id });
    const w = weightCheck(a.trace, b.trace, policy), cm = b.trace.canvas_merge;
    scores[i][policy.primary] = b.score;
    checks.push({ regime: a.trace.executed_regime?.label ?? null, ...w, merged_weight: b.trace.dynamic_weights.skyCanvas,
      merged_multiplier: cm.merged_multiplier, twilight_minutes: cm.twilight_minutes, data_factor: cm.data_factor });
    if ((i + 1) % 200 === 0) progress(`Trace ${i + 1}/${rows.length}`);
  }
  for (const key of MEMBER_KEYS.filter(k => k !== policy.primary)) {
    progress(`成员 ${key}`); const config = memberConfig(C0, key, policy);
    for (const [i, row] of rows.entries()) scores[i][key] = (await calculator.calculate(row, config)).score;
  }
  const evalRows = attachReview(rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool,
    city: r.city, slot: slotOf(r.scheduled_slot), lead_time_minutes: r.lead_time_minutes, gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence,
    weight: r.weight, scores: scores[i] })), table, policy);
  progress('判定（现行线下非劣性）与只报告项');
  const evaluation = evaluateAll(evalRows, policy);
  const by = fn => [...new Set(checks.map(fn))].sort();
  const regimes = Object.fromEntries(by(c => c.regime).map(g => { const x = checks.filter(c => c.regime === g);
    return [g, { snapshots: x.length, max_merged_abs_diff: Math.max(...x.map(c => c.merged_abs_diff)), max_other_abs_diff: Math.max(...x.map(c => c.other_abs_diff)),
      mean_merged_weight: r6(x.reduce((s, c) => s + c.merged_weight, 0) / x.length), merged_multiplier: [...new Set(x.map(c => r6(c.merged_multiplier)))] }]; }));
  const monthOf = i => evalRows[i].event_date_local.slice(0, 7);
  const months = Object.fromEntries(by((c, i) => monthOf(i)).map(mo => [mo, distribution(checks.filter((c, i) => monthOf(i) === mo).map(c => r6(c.twilight_minutes)))]));
  const parity = { status: 'PASS', members: rows.length, baseline: policy.baseline_reference, engine_sha256: code.engine_sha256, C0_config_sha256: digest(C0),
    configs_scored: Object.keys(scores[0]).length, merged_weight_tolerance: policy.weight_tolerance,
    data_factor_values: [...new Set(checks.map(c => c.data_factor))].sort(), dynamic_weight_by_regime: regimes, twilight_minutes_by_month: months };
  return { parity, rows: evalRows, evaluation };
}

// ---------- report ----------
const f3 = v => v == null ? '—' : Number(Number(v).toFixed(3)).toString();
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f3(x.point)}（不可估计）` : `${f3(x.point)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;
const m = s => `${f3(s.product_loss)} | ${f3(s.ge2_recall_cloud_type)} | ${f3(s.ge2_recall)} | ${f3(s.ge2_precision)} | ${f3(s.ge3_recall)} | ${f3(s.false_alarm_rate)} | ${f3(s.bias)}`;
const HEAD = '| | 产品损失 | ≥2 召回（有云） | ≥2 召回（全体） | ≥2 精确 | ≥3 召回 | 误报率 | 偏差 |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
const N_LABEL = { N1_auc_ge2_lower_above_minus_0_01: 'N1 ΔAUC≥2 下限 > −0.01', N2_auc_ge3_lower_above_minus_0_02: 'N2 ΔAUC≥3 下限 > −0.02',
  N3_loss_point_at_most_0_03_and_upper_below_0_05: 'N3 损失差点估计 ≤ +0.03 且上限 < +0.05', N4_recall_not_lower_by_more_than_0_01_and_floors: 'N4 召回不低于 C0 超过 0.01 且 ≥ 0.60 / 0.65' };
function memberRow(key, F) {
  return `| ${key} | ${f3(F.candidate.product_loss)} | ${ci(F.loss_delta)} | ${f3(F.candidate.ge2_recall)} / ${f3(F.candidate.ge2_recall_cloud_type)} | ${f3(F.candidate.ge3_recall)} | ${f3(F.candidate.false_alarm_rate)} | ${ci(F.auc_ge2.delta)} | ${ci(F.auc_ge3.delta)} | ${F.grade_changes} |`;
}
const sub = (name, s) => `| ${name} | ${s.snapshots} | ${s.gt_ge2_snapshots} | ${f3(s.C0.product_loss)} → ${f3(s.candidate.product_loss)} | ${f3(s.C0.ge2_recall)} → ${f3(s.candidate.ge2_recall)} | ${f3(s.mean_score_change)} |`;
export function renderCmReport(spec, p, policy = CM_POLICY) {
  const e = p.evaluation, F = e.at_current_lines, R = e.report_only, b = R.breakdowns;
  const relined = Object.entries(R.relined_cv).flatMap(([k, v]) => Object.entries(v).map(([n, c]) =>
    `| ${k} ${n} | ${f3(c.reference.product_loss)} | ${f3(c.candidate.product_loss)} | ${ci(c.loss_delta)} | ${f3(c.candidate.ge2_recall)} | ${f3(c.candidate.ge3_recall)} |`)).join('\n');
  const changes = R.grade_changes.map(c => `| ${c.event_date_local} | ${c.city ?? '—'} | ${c.pool} | ${c.C0_score} → ${c.member_score} | ${c.C0_grade} → ${c.member_grade} | ${c.gt_ordinal}${c.recall_exempt ? '（晴空渐变）' : ''} |`).join('\n');
  const regimes = Object.entries(p.parity.dynamic_weight_by_regime).map(([g, x]) => `| ${g} | ${x.snapshots} | ${x.merged_multiplier.map(f3).join('、')} | ${f3(x.mean_merged_weight)} | ${x.max_merged_abs_diff.toExponential(1)} | ${x.max_other_abs_diff.toExponential(1)} |`).join('\n');
  const months = Object.entries(p.parity.twilight_minutes_by_month).map(([mo, d]) => `| ${mo} | ${d.n} | ${f3(d.min)} | ${f3(d.p50)} | ${f3(d.max)} |`).join('\n');
  const dist = Object.entries(R.score_distribution).map(([k, d]) => `| ${k} | ${d.p10} | ${d.p50} | ${d.p90} |`).join('\n');
  const cross = Object.entries(R.cross_period).map(([k, c]) => `| ${k} | ${c.snapshots} | ${f3(c.C0.product_loss)} → ${f3(c.candidate.product_loss)} | ${ci(c.loss_delta)} | ${ci(c.ge2_recall_delta)} | ${ci(c.auc_ge2.delta)} |`).join('\n');
  return `# V2.5.5.31 云幕与光照组件合并评估（开发数据非劣性验证）

Run：${spec.run_id}。数据 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（复用开发数据，independent_validation=false，未读取 ${policy.h3_first_date} 起的数据）。基准 C0 = 2.5.5.19；主候选 ${e.primary}（s = 1/3，k = ${policy.members[e.primary].canvasMerge.scale}，不含昏影）。现行线 ${policy.rule.lines.join(' / ')}，两边都不选线。

**结论：${e.decision}**${e.failed.length ? `（未满足：${e.failed.map(k => N_LABEL[k]).join('；')}）` : ''}。

## 复现与核对

C0 在全部 ${p.parity.members} 条上与 ${p.parity.baseline.run_id} 的 ${p.parity.baseline.key} 逐条相同；共重算 ${p.parity.configs_scored} 套配置。M1 的合并动态权重与 C0 的 skyCanvas + illumination 动态权重之和逐条相等（容差 ${p.parity.merged_weight_tolerance}），其余三项逐条相同，illumination 权重为 0。数据系数取值：${p.parity.data_factor_values.join('、')}。

| 天气型 | 条数 | m̄ | 平均合并权重 | 合并权重最大差 | 其余权重最大差 |
| --- | --- | --- | --- | --- | --- |
${regimes}

## 判定（${e.primary} 对 C0，现行线）

${Object.entries(e.conditions).map(([k, v]) => `- ${N_LABEL[k]}：${v ? '满足' : '**不满足**'}`).join('\n')}

${HEAD}
| C0 | ${m(F.C0)} |
| ${e.primary} | ${m(F.candidate)} |

- 产品损失差：${ci(F.loss_delta)}
- 全体 ≥2 召回差：${ci(F.ge2_recall_delta)}；有云 ≥2 召回差：${ci(F.ge2_recall_cloud_type_delta)}
- ≥3 召回差（只报告）：${ci(F.ge3_recall_delta)}；≥2 精确率差：${ci(F.ge2_precision_delta)}
- AUC≥2：${f3(F.auc_ge2.C0)} → ${f3(F.auc_ge2.candidate)}，差 ${ci(F.auc_ge2.delta)}
- AUC≥3：${f3(F.auc_ge3.C0)} → ${f3(F.auc_ge3.candidate)}，差 ${ci(F.auc_ge3.delta)}
- 等级改变的 Snapshot：${F.grade_changes} 条

## 只报告：全部成员在现行线下

| 成员 | 产品损失 | 损失差 | ≥2 召回 全体 / 有云 | ≥3 召回 | 误报率 | ΔAUC≥2 | ΔAUC≥3 | 等级改变 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${memberRow(e.primary, F)}
${Object.entries(R.members_at_current_lines).map(([k, x]) => memberRow(k, x)).join('\n')}

M3 − M1L 逐条分数差：p10 / p50 / p90 = ${R.m3_minus_m1l.p10} / ${R.m3_minus_m1l.p50} / ${R.m3_minus_m1l.p90}，|差| ≤ 1 的比例 ${f3(R.m3_minus_m1l.within_1_share)}。

## 只报告：重选线的交叉验证（V2.5.5.18 选线规则）

| 成员与折数 | L0 损失 | 成员损失 | 损失差 | ≥2 召回 | ≥3 召回 |
| --- | --- | --- | --- | --- | --- |
${relined}

全数据选线（只描述）：${Object.entries(R.full_data_lines).map(([k, l]) => `${k} ${l ? l.join('/') : '—'}`).join('；')}。

## 只报告：跨时段（${e.primary} 对 C0，现行线）

| 时段 | 条数 | 损失 C0 → ${e.primary} | 损失差 | 全体 ≥2 召回差 | ΔAUC≥2 |
| --- | --- | --- | --- | --- | --- |
${cross}

## 只报告：分组（${e.primary} 对 C0，现行线）

| 分组 | 条数 | GT≥2 | 损失 | 全体 ≥2 召回 | 平均分数变化 |
| --- | --- | --- | --- | --- | --- |
${Object.entries(b.by_pool).map(([k, s]) => sub(`数据池 ${k}`, s)).join('\n')}
${Object.entries(b.by_slot).map(([k, s]) => sub(`时段 ${k}`, s)).join('\n')}
${Object.entries(b.by_region).map(([k, s]) => sub(k === 'SOUTH' ? '南方组' : '其余城市', s)).join('\n')}

## 只报告：等级改变的 Snapshot（${e.primary} 对 C0）

| 日期 | 城市 | 数据池 | 分数 | 等级 | GT |
| --- | --- | --- | --- | --- | --- |
${changes}

## 只报告：分数分布与昏影

| 配置 | p10 | p50 | p90 |
| --- | --- | --- | --- |
${dist}

| 月份 | 条数 | 昏影最短（分钟） | 中位数 | 最长 |
| --- | --- | --- | --- | --- |
${months}

结论只是开发证据；是否发布与前向确认另行决定（PRD 第 9 节）。
`;
}

// ---------- run / inspect / verify ----------
const REQUIRED = ['run_spec.json', 'cm_plan.json', 'parity.json', 'cm_rows.json', 'evaluation.json', 'cm_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runCm(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity(), policy = CM_POLICY;
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
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectCm(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'cm_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeCm(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const e = payload.evaluation;
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, primary: e.primary, decision: e.decision, conditions: e.conditions, failed: e.failed };
    for (const [name, value] of Object.entries({ 'parity.json': payload.parity, 'cm_rows.json': payload.rows, 'evaluation.json': e, 'cm_result.json': result, 'verification.json': proof }))
      await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'report.md'), renderCmReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
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
export async function inspectCm(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'cm_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'cm_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyCmRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(CM_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeCm(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  for (const p of loaded.parts) await checkInputs(p.loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifyCm(directory) {
  const inspected = await inspectCm(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
