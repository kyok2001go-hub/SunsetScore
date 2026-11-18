// V2.5.5.24 workflow (Practical Tuning Schema/Policy 18): scores the released 2.5.5.19 (C0) and the A / B / C members on DEV + H1 + H2
// by Replay, traces C0 under the neutral keys for the report subgroups, tags rows with the frozen photo-review table, evaluates the
// three families, and scores combination members only when two or more families pass. Read-only: explicit configs only; js/config.js
// never carries the three keys. PRD: ref_docs/PRD/V2.5.5.24--必要条件结构与方向纠正评估方案.md
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
import { SD_POLICY, FAMILIES, candidateConfig, neutralConfig, familyKeys, parseMemberKey, evaluateFamilies, needsCombination, combinationMembers, evaluateAll } from './structure-direction.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const SCHEMA = 18;
const KEYS = ['canvasLightAccess', 'gradientDirection', 'viewOcclusion'];
const r3 = v => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

export async function computeSd(loaded, code, progress = () => {}, policy = SD_POLICY) {
  const table = await loadReviewTable(policy), configs = await releaseConfigs(), C0 = configs['2.5.5.19'];
  if (!C0 || C0.version !== '2.5.5.19' || KEYS.some(k => k in C0)) fail('SD_BASELINE_CONFIG_MISMATCH');
  const calculator = p0Calculator(code.engine_sha256);
  progress('C0（2.5.5.19）预检');
  const checked = await preflight(loaded, C0, calculator, progress);
  if (checked.exclusions.length) fail('SD_CONTROL_REPLAY_EXCLUSIONS');
  const rows = checked.rows, scores = rows.map(r => ({ C0: r.control_score }));
  if (digest(rows.map((r, i) => [r.snapshot_id, scores[i].C0])) !== policy.baseline_reference.signature_sha256) fail('SD_BASELINE_PARITY_FAILED');
  // The neutral config (gamma 0, alpha 0 present) must reproduce C0 exactly; its trace carries the subgroup inputs.
  progress('中性检查与 Trace（gamma = 0、alpha = 0）');
  const traced = p0Calculator(code.engine_sha256), neutral = neutralConfig(C0), inputs = [];
  for (const [i, row] of rows.entries()) {
    const result = await traced.calculate(row, neutral, true);
    if (result.score !== scores[i].C0) fail('SD_NEUTRAL_KEYS_CHANGED_SCORE', { detail: row.snapshot_id });
    const s = result.trace.structure_direction;
    if (!s || s.access_factor !== 1) fail('SD_TRACE_STRUCTURE_DIRECTION_MISSING', { detail: row.snapshot_id });
    inputs.push({ corridor_opening: r3(s.corridor_opening), local_low: r3(s.local_low), gradient: r3(s.gradient) });
  }
  const score = async (key, config) => { for (const [i, row] of rows.entries()) scores[i][key] = (await calculator.calculate(row, config)).score; };
  for (const family of FAMILIES) for (const key of familyKeys(family, policy).filter(k => k !== 'C0')) { progress(`候选 ${key}`); await score(key, candidateConfig(C0, parseMemberKey(key))); }
  const evalRows = attachReview(rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local, pool: r.pool,
    slot: ['1213', '1613'].includes(r.scheduled_slot) ? r.scheduled_slot : ['1720', '1729', '1755'].includes(r.scheduled_slot) ? 'EVENING' : 'OTHER',
    lead_time_minutes: r.lead_time_minutes, gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence, weight: r.weight, ...inputs[i], scores: scores[i] })), table, policy);
  progress('评估三组候选（交叉验证、跨时段、区间、Brier）');
  const families = evaluateFamilies(evalRows, policy);
  let combinationRows = null, combined = [];
  if (needsCombination(families)) {
    combined = combinationMembers(families).filter(k => !(k in scores[0]));
    if (combined.length > policy.max_combination_members) fail('SD_TOO_MANY_COMBINATION_MEMBERS');
    for (const key of combined) { progress(`组合 ${key}`); await score(key, candidateConfig(C0, parseMemberKey(key))); }
    combinationRows = evalRows.map((r, i) => ({ ...r, scores: scores[i] }));
  }
  progress('判定');
  const evaluation = evaluateAll(evalRows, policy, families, combinationRows);
  const parity = { status: 'PASS', members: rows.length, baseline: policy.baseline_reference, engine_sha256: code.engine_sha256, C0_config_sha256: digest(C0),
    neutral_keys_identical: true, configs_scored: Object.keys(scores[0]).length, combination_members_scored: combined,
    subgroup_counts: { corridor_opening_below_80: inputs.filter(x => x.corridor_opening != null && x.corridor_opening < policy.report_subgroups.corridor_opening_below).length,
      gradient_le_minus_30: inputs.filter(x => x.gradient != null && x.gradient <= -policy.report_subgroups.gradient_abs_at_least).length,
      gradient_ge_30: inputs.filter(x => x.gradient != null && x.gradient >= policy.report_subgroups.gradient_abs_at_least).length,
      local_low_ge_50: inputs.filter(x => x.local_low != null && x.local_low >= policy.report_subgroups.local_low_at_least).length } };
  return { parity, rows: combinationRows ?? evalRows, evaluation };
}

// ---------- report ----------
const f3 = v => v == null ? '—' : Number(Number(v).toFixed(3)).toString();
const ci = x => !x ? '—' : x.status !== 'COMPUTED' ? `${f3(x.point)}（不可估计）` : `${f3(x.point)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;
const m = s => `${f3(s.product_loss)} | ${f3(s.ge2_recall_cloud_type)} | ${f3(s.ge2_recall)} | ${f3(s.ge2_precision)} | ${f3(s.ge3_recall)} | ${f3(s.false_alarm_rate)} | ${f3(s.bias)}`;
const HEAD = '| | 产品损失 | ≥2 召回（有云） | ≥2 召回（全体） | ≥2 精确 | ≥3 召回 | 误报率 | 偏差 |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
const LABELS = { A: '画布、光照 × 走廊透光（canvasLightAccess.gamma）', B: '近多远少的方向（gradientDirection）', C: '本地低云的视线遮挡（viewOcclusion.alpha）' };
const SUB = { corridor_opening_below: '走廊开阔度 < 80', gradient_at_most_minus: 'gradient ≤ −30（近多远少）', gradient_at_least: 'gradient ≥ 30（远多近少）', local_low_at_least: '本地低云 ≥ 50%' };
function subgroupTable(report) {
  return `| 子组（5 折样本外） | 条数 | GT≥2 / GT≥3 | 误报 L0 → 候选 | 漏报 GT≥2 L0 → 候选 | 偏差 L0 → 候选 | 平均分数变化 |\n| --- | --- | --- | --- | --- | --- | --- |\n` +
    Object.entries(SUB).map(([k, name]) => { const s = report[k];
      return `| ${name} | ${s.snapshots} | ${s.gt_ge2_snapshots} / ${s.gt_ge3_snapshots} | ${s.L0.false_alarm_snapshots} → ${s.candidate.false_alarm_snapshots} | ${s.L0.missed_ge2_snapshots} → ${s.candidate.missed_ge2_snapshots} | ${f3(s.L0.bias)} → ${f3(s.candidate.bias)} | ${f3(s.mean_score_change)} |`; }).join('\n');
}
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

${subgroupTable(F.report)}
`;
}
export function renderSdReport(spec, p, policy = SD_POLICY) {
  const e = p.evaluation, at = e.report_only.members_at_current_lines;
  const rows = Object.entries(at).map(([k, s]) => `| ${k} | ${f3(s.product_loss)} | ${f3(s.ge2_recall)} | ${f3(s.ge3_recall)} | ${f3(s.auc_ge2)} | ${f3(s.auc_ge3)} |`).join('\n');
  const sc = p.parity.subgroup_counts;
  return `# V2.5.5.24 必要条件结构与方向纠正评估（开发数据验证）

Run：${spec.run_id}。数据 DEV + H1 + H2 共 ${p.parity.members} 条 Snapshot（复用开发数据，independent_validation=false，未读取 2026-11-16 起的数据）。基准 C0 = 2.5.5.19。

**结论：${e.decision}**${e.recommended ? `，推荐 ${e.recommended}` : ''}。A：${e.A.decision}；B：${e.B.decision}；C：${e.C.decision}${e.combination ? `；组合：${e.combination.decision}` : ''}。

## 复现

C0 在全部 ${p.parity.members} 条上与 ${p.parity.baseline.run_id} 的 ${p.parity.baseline.key} 逐条相同；gamma = 0、alpha = 0 与 C0 逐条相同；共重算 ${p.parity.configs_scored} 套配置。子组记录数（全部 Snapshot）：走廊开阔度 < 80 ${sc.corridor_opening_below_80}，gradient ≤ −30 ${sc.gradient_le_minus_30}，gradient ≥ 30 ${sc.gradient_ge_30}，本地低云 ≥ 50% ${sc.local_low_ge_50}。

C0 现行线 ${policy.lines.current.join('/')}（全数据）：产品损失 ${f3(e.current_lines_C0.product_loss)}，有云 / 全体 ≥2 召回 ${f3(e.current_lines_C0.ge2_recall_cloud_type)} / ${f3(e.current_lines_C0.ge2_recall)}。

${FAMILIES.map(f => familySection(f, LABELS[f], e[f])).join('\n')}
${e.combination ? familySection(e.combination.members.join('+'), '组合', e.combination) : ''}
## 只报告：各成员在现行线下（全部数据，不选线）

| 成员 | 产品损失 | ≥2 召回 | ≥3 召回 | AUC≥2 | AUC≥3 |
| --- | --- | --- | --- | --- | --- |
${rows}

全数据选择（只描述）：${FAMILIES.map(f => `${f} ${e[f].full_data_choice?.key ?? '—'} ${e[f].full_data_choice?.lines?.join('/') ?? ''}`).join('；')}；L0 ${e.report_only.full_data_lines.L0?.join('/') ?? '—'}。

结论只是开发证据；是否发布与 H4 核验另行决定。
`;
}

// ---------- run / inspect / verify ----------
const REQUIRED = ['run_spec.json', 'sd_plan.json', 'parity.json', 'sd_rows.json', 'evaluation.json', 'sd_result.json', 'verification_request.json', 'verification.json', 'report.md'];
export async function runSd(options = {}, progress = () => {}) {
  const pools = options.pools ?? defaultPools();
  const loaded = await loadPooled(pools, progress), code = await codeIdentity(), policy = SD_POLICY;
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
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectSd(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(work, { recursive: true });
    const spec = { practical_tuning_schema_version: SCHEMA, practical_tuning_policy_version: SCHEMA, run_id: runId, identity, code, sources: pools, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const prior = await json(path.join(work, 'run_spec.json')); if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'sd_plan.json'), policy);
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPUTING', run_id: runId });
    progress(`运行 ${runId}；计划 Hash=${identity.plan_sha256}`);
    const payload = await computeSd(loaded, code, progress), payloadSha = digest(payload);
    await atomicJson(path.join(work, 'verification_request.json'), { spec, payload_sha256: payloadSha });
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', run_id: runId });
    progress('新进程完整重算 payload');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH', { detail: proof.error_code });
    const e = payload.evaluation;
    const result = { run_id: runId, status: 'COMPLETED', usage: policy.usage, evaluation_scope: policy.evaluation_scope, independent_validation: false,
      payload_sha256: payloadSha, decision: e.decision, recommended: e.recommended,
      families: Object.fromEntries(FAMILIES.map(f => [f, { decision: e[f].decision, gates: e[f].gates }])),
      combination: e.combination ? { members: e.combination.members, decision: e.combination.decision, gates: e.combination.gates } : null };
    for (const [name, value] of Object.entries({ 'parity.json': payload.parity, 'sd_rows.json': payload.rows, 'evaluation.json': e, 'sd_result.json': result, 'verification.json': proof }))
      await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'report.md'), renderSdReport(spec, payload).replace(/\r?\n/g, '\r\n'), 'utf8');
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
export async function inspectSd(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== SCHEMA || manifest.practical_tuning_policy_version !== SCHEMA) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of REQUIRED) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files))
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'sd_result.json')), request = await json(path.join(root, 'verification_request.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${SCHEMA}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      digest(await json(path.join(root, 'sd_plan.json'))) !== spec.identity.plan_sha256 || digest(request.spec) !== digest(spec) ||
      request.payload_sha256 !== result.payload_sha256 || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifySdRequest(request) {
  const { spec } = request, code = await codeIdentity();
  if (spec.identity.engine_sha256 !== spec.code.engine_sha256 || spec.code.node_version !== code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engine = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: true });
  if (digest(spec.identity.policy) !== digest(SD_POLICY)) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPooled(spec.sources);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const payload = await computeSd(loaded, code);
  if (engine.mode !== 'IDENTICAL_ENGINE') payload.parity.engine_sha256 = spec.identity.engine_sha256;
  if (digest(payload) !== request.payload_sha256) fail('FINAL_RECOMPUTE_MISMATCH');
  for (const p of loaded.parts) await checkInputs(p.loaded);
  return { status: 'PASS', scope: 'FRESH_PROCESS_FULL_PAYLOAD_RECOMPUTE', engine_replayed: true, payload_sha256: request.payload_sha256,
    ...(engine.mode !== 'IDENTICAL_ENGINE' ? { engine_compatibility: engine } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: 'SAME_ENGINE_SAME_POLICY_DIFFERENT_TOOL_FILES', original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
export async function verifySd(directory) {
  const inspected = await inspectSd(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(inspected.directory, 'verification_request.json')],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id };
}
