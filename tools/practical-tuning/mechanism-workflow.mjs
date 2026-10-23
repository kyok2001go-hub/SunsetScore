import { assertCompatibleEngine } from './engine-compatibility.mjs';
import path from 'node:path';
import { mkdir, readdir, writeFile, appendFile, rename, unlink, rmdir } from 'node:fs/promises';
import { readSafe, safePath, within, fail, hash, inventory, canonicalJson, errorCode } from '../dataset/lib/common.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { digest, POLICY, q } from './policy.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { replayCalculator, evaluateConfig, constantComparisons, assertLegacyGradeConfig } from './compute.mjs';
import { inspectPractical, acquireRunLock, atomicJson, csv } from './workflow.mjs';
import { reproduceMidCloudBaselines } from './mid-cloud-workflow.mjs';
import { highCloudWorker } from './high-cloud-workflow.mjs';
import { highCloudMetrics, recognitionFloor, rankHighCloud, meetsHighCloudRecognition } from './high-cloud.mjs';
import { pairedMigrations, migrationCsvFields, MIGRATION_KEYS } from './migrations.mjs';
import * as traceDefaults from './mechanism-trace.mjs';
import * as targetDefaults from './mechanism-targeted.mjs';

export function createTargetedWorkflow(adapter = {}) {
const { policy: M = targetDefaults.MECHANISM_POLICY, buildPlan: buildTargetPlan = targetDefaults.buildTargetPlan, install: installMechanism = targetDefaults.installMechanism,
 candidate: mechanismCandidate = targetDefaults.mechanismCandidate, refine: chooseRefinement = targetDefaults.chooseRefinement, search: searchMechanisms = targetDefaults.searchMechanisms,
 select: selectMechanism = targetDefaults.selectMechanism, collect: collectMechanismTraces = traceDefaults.collectMechanismTraces, summarize: summarizeMechanismTraces = traceDefaults.summarizeMechanismTraces } = adapter;
const version = M.practical_tuning_schema_version;
const makeCalculator = hash => adapter.calculator ? adapter.calculator(hash) : replayCalculator(hash);
const json = async p => JSON.parse(await readSafe(p));
const exists = async p => { try { await readSafe(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const mechanismCode = async () => ({ ...await codeIdentity(), policy_sha256: digest(M) });
const evaluate = async (rows, config, calc) => { const r = await evaluateConfig(rows, config, calc); return { ...r, metrics: highCloudMetrics(rows, r.scores) }; };

async function loadMechanismParent(directory) {
  if (adapter.loadParent) return adapter.loadParent(directory);
  if (!directory) fail('BASELINE_RUN_REQUIRED');
  const root = await safePath(directory), bytes = await readSafe(path.join(root, 'manifest.json')), m = JSON.parse(bytes);
  if (m.practical_tuning_schema_version !== 3 || m.practical_tuning_policy_version !== 3) fail('MECHANISM_PARENT_MUST_BE_MID_CLOUD_RUN_V3');
  const parent = await inspectPractical(root), original = await json(path.join(root, 'original_control_config.json'));
  const baseline = await json(path.join(root, 'selected_effective_config.json')), request = await json(path.join(root, 'verification_request.json'));
  assertLegacyGradeConfig(baseline, 'PRACTICAL_PARENT_GRADE_LINES_UNSUPPORTED');
  if (parent.result.selection_mode !== 'CUMULATIVE_RECOGNITION_FIRST') fail('MECHANISM_PARENT_MUST_BE_RECOGNITION_FIRST');
  const pool = await json(path.join(root, 'pool_manifest.json')), exclusions = await json(path.join(root, 'exclusions.json'));
  return { root, original, baseline, request, pool, exclusions, spec: parent.spec,
    reference: { run_id: m.run_id, manifest_sha256: hash(bytes), candidate_id: parent.result.selected_candidate,
      original_config_sha256: digest(original), current_config_sha256: digest(baseline), members_sha256: digest(pool.included),
      inputs_sha256: digest(parent.spec.identity.inputs), engine_sha256: parent.spec.code.engine_sha256 } };
}
async function reproduce(loaded, parent, code, calculator, progress) {
  if (adapter.reproduce) return adapter.reproduce(loaded, parent, code, calculator, progress);
  const a = await reproduceMidCloudBaselines(loaded, parent, code, calculator, progress);
  return { checked: a.checked, B0: a.B0, C: a.B1, audit: { ...a.audit, current_source: 'selected_effective_config.json',
    parent_current_config_sha256: digest(parent.baseline), trace_only_tool_change: code.engine_sha256 === parent.spec.code.engine_sha256 ? 'REPLAY_TRACE_OBSERVATIONS_ONLY; ENGINE_FILES_IDENTICAL; EXACT_PARENT_B0_C_SCORES_ORDINALS_AND_METRICS' : 'PINNED_DEFAULT_COMPATIBLE_ENGINE_CHANGE; EXACT_PARENT_PREDICTIONS_REQUIRED' } };
}
function candidateEffects(rows, current, scores) {
  return { changed_snapshots: scores.filter((s, i) => s !== current.scores[i]).length,
    changed_ordinals: scores.filter((s, i) => scoreToOrdinal(s) !== scoreToOrdinal(current.scores[i])).length,
    changed_high_missed: rows.filter((r, i) => r.gt_ordinal >= 3 && current.scores[i] < 60 && scores[i] !== current.scores[i]).length,
    changed_low_control: rows.filter((r, i) => r.gt_ordinal <= 2 && scores[i] !== current.scores[i]).length };
}
function validateMechanismRequest(request) {
  const { spec, target_plan: plan, stage_summary: summary, trace_rows: traces, search_records: records, refinement_plan: refinement } = request;
  const rows = request.pool.included;
  if (digest(plan) !== spec.identity.target_plan_sha256 || digest(traces) !== spec.identity.trace_rows_sha256 || digest(summary) !== spec.identity.stage_summary_sha256 ||
      digest(summarizeMechanismTraces(rows, traces)) !== digest(summary) || digest(buildTargetPlan(rows, traces, summary, spec.baseline_config, spec)) !== digest(plan)) fail('MECHANISM_PLAN_OR_TRACE_BINDING_MISMATCH');
  if (adapter.validateAdditional) adapter.validateAdditional(request);
  const context = { current: spec.baseline_config, original: spec.original_control_config, engine_sha256: spec.code.engine_sha256, target_plan_sha256: digest(plan) };
  const baselineId = mechanismCandidate({ parameter_id: null, value: null }, context).candidate_id;
  const baseline = records.find(r => r.candidate_id === baselineId), selected = records.find(r => r.candidate_id === request.selected.candidate_id);
  if (!baseline || baseline.status !== 'EVALUATED' || digest(baseline.metrics) !== digest(request.C.metrics) || digest(baseline.scores) !== digest(request.C.scores) ||
      !selected || digest(selected) !== digest(request.selected) || new Set(records.map(r => r.candidate_id)).size !== records.length) fail('MECHANISM_RECORD_BINDING_MISMATCH');
  const expectedRefinement = chooseRefinement(records.filter(r => r.stage !== 'REFINEMENT'), baselineId, request.B0.metrics, spec.baseline_config, plan);
  if (refinement.status !== 'STOP_BUDGET_REACHED' && digest(expectedRefinement) !== digest(refinement)) fail('MECHANISM_REFINEMENT_MISMATCH');
  const proposals = [{ parameters: { parameter_id: null, value: null }, stage: 'C_BASELINE' },
    ...plan.selected.flatMap(p => p.probe_values.map(value => ({ parameters: { parameter_id: p.parameter_id, value }, stage: 'PROBE' }))),
    ...refinement.values.map(value => ({ parameters: { parameter_id: refinement.parameter_id, value }, stage: 'REFINEMENT' }))];
  const uniqueMap = new Map();
  for (const p of proposals) { const id = mechanismCandidate(p.parameters, context).candidate_id; if (!uniqueMap.has(id)) uniqueMap.set(id, p); }
  const unique = [...uniqueMap.entries()].slice(0, spec.identity.search_plan.max_candidates);
  if (unique.length !== records.length || records.length > M.max_effective_configurations) fail('MECHANISM_SEARCH_COVERAGE_MISMATCH');
  for (const [i, r] of records.entries()) {
    const c = mechanismCandidate(r.parameters, context);
    if (unique[i][0] !== r.candidate_id || unique[i][1].stage !== r.stage || r.candidate_id !== c.candidate_id || r.parameter_distance !== c.parameter_distance) fail('MECHANISM_CANDIDATE_BINDING_MISMATCH');
    if (r.status === 'ERROR') { if (r.metrics !== null || !r.reason_code) fail('INVALID_ERROR_CANDIDATE'); continue; }
    if (r.status !== 'EVALUATED' || !Array.isArray(r.scores) || r.scores.length !== rows.length ||
        digest(rows.map((row, i) => [row.snapshot_id, r.scores[i], scoreToOrdinal(r.scores[i])])) !== r.predictions_sha256 ||
        digest(highCloudMetrics(rows, r.scores)) !== digest(r.metrics) || digest(pairedMigrations(rows, request.C.scores, r.scores)) !== digest(r.paired_migrations) ||
        digest(candidateEffects(rows, request.C, r.scores)) !== digest(r.effects)) fail('MECHANISM_RECORD_PREDICTIONS_OR_MIGRATIONS_MISMATCH');
    const delta = r.metrics.target_ge3.recall == null || request.C.metrics.target_ge3.recall == null ? null : r.metrics.target_ge3.recall - request.C.metrics.target_ge3.recall;
    if (delta == null ? r.paired_migrations.recall_ge3_delta_from_net !== null : Math.abs(delta - r.paired_migrations.recall_ge3_delta_from_net) > POLICY.epsilon * 2) fail('MIGRATION_RECALL_DELTA_MISMATCH');
  }
  for (const [i, row] of rows.entries()) if (traces[i].snapshot_id !== row.snapshot_id || traces[i].predicted_score !== request.C.scores[i]) fail('MECHANISM_TRACE_CURRENT_MISMATCH');
  if (digest(selectMechanism(records, baselineId, request.B0.metrics)) !== digest(request.phase7_result) ||
      digest(installMechanism(spec.baseline_config, selected.parameters)) !== digest(request.selected_effective_config)) fail('MECHANISM_FINAL_SELECTION_MISMATCH');
}
function slices(rows, anchors, selected) {
  return ['event_date_local', 'city', 'lead_time_bucket', 'regime_label', 'scheduled_slot'].flatMap(dimension =>
    [...new Set(rows.map(r => r[dimension] ?? null))].sort().map(value => {
      const indices = rows.flatMap((r, i) => (r[dimension] ?? null) === value ? [i] : []), subset = indices.map(i => rows[i]);
      return { dimension, value, B0: highCloudMetrics(subset, indices.map(i => anchors.B0.scores[i])),
        C: highCloudMetrics(subset, indices.map(i => anchors.C.scores[i])), N: highCloudMetrics(subset, indices.map(i => selected.scores[i])) };
    }));
}
function nextAction(request) {
  if (adapter.nextAction) return adapter.nextAction(request);
  const missed = request.trace_rows.filter(t => t.gt_ordinal >= 3 && t.predicted_ordinal < 3), lowP = missed.filter(t => t.P < 60);
  return { action: lowP.length >= missed.length / 2 ? 'VERIFY_ILLUMINATION_COMPONENT_DISCRIMINATION_ON_EXISTING_PAIRED_INPUTS' : 'VERIFY_SKY_EVOLUTION_INTERNAL_CONTRIBUTIONS_WITH_ONE_DEFAULT_PRESERVING_OBSERVER',
    evidence: { missed_snapshots: missed.length, missed_with_P_below60: lowP.length,
      snapshot_ids: (lowP.length >= missed.length / 2 ? lowP : missed).map(t => t.snapshot_id) },
    code_location: lowP.length >= missed.length / 2 ? 'js/engine.js:illumination' : 'js/sky_state.js:determineState',
    minimum_discriminating_experiment: lowP.length >= missed.length / 2
      ? 'Compare executed illumination inputs/raw score/dynamic contribution for every high miss and all actual0/1/2 controls; verify whether low P already lacks grade separation before changing any post-score multiplier.'
      : 'Read raw factor inputs and clipping decisions on the same full pool, prove observer on/off B0/C parity, then distinguish component signal from post-score suppression without changing thresholds.',
    automatic_next_run: false, new_data_required: false };
}
function renderMechanismReport(request, search) {
  if (adapter.renderReport) return adapter.renderReport(request, search);
  const { spec, phase7_result: r, selected, C, B0, stage_summary: summary, target_plan: plan } = request;
  const N = selected.metrics, f = n => n == null ? '未评估' : String(Number(n.toFixed(6))), group = key => summary.groups.find(g => g.group === key);
  const metrics = [['产品损失', m => m.product_loss], ['MAE', m => m.mae], ['Bias', m => m.bias], ['QWK', m => m.qwk],
    ['≥2召回', m => m.target_ge2.recall], ['≥3召回', m => m.target_ge3.recall], ['≥3精确率', m => m.target_ge3.precision],
    ['低估至少2级', m => m.underprediction_ge2], ['高估至少2级', m => m.overprediction_ge2], ['4→0/1', m => m.critical_overprediction.rate], ['预测4条数', m => m.predicted4_support.snapshot_count]];
  const mostRecovery = request.search_records.filter(x => x.status === 'EVALUATED').sort((a, b) => b.paired_migrations.net_recovered_weight - a.paired_migrations.net_recovered_weight || a.metrics.product_loss - b.metrics.product_loss || a.candidate_id.localeCompare(b.candidate_id))[0];
  const roles = [['最终选择', selected], ['最低损失', request.search_records.find(c => c.candidate_id === r.lowest_loss_candidate)], ['净找回最多', mostRecovery]];
  const action = nextAction(request), missed = group('high_missed');
  return `# V2.5.4.12 漏报评分拆解与定向优化闭环

**Phase7已完成：${r.selection_status}。高等级识别实际改善=${r.high_grade_recognition_improved}。** 本轮相对C降损=${f((C.metrics.product_loss - N.product_loss) / C.metrics.product_loss * 100)}%，相对B0累计=${f((B0.metrics.product_loss - N.product_loss) / B0.metrics.product_loss * 100)}%。配置=${JSON.stringify(selected.parameters)}。

固定最新C（权重0.20/0.375/0.40/0.025/0，高云60/25、中云54/34）。baseline/rollback=C，original_control=B0；不读取父rollback代替C。${N.predicted4_support.snapshot_count ? `预测4=${N.predicted4_support.snapshot_count}条。` : 'PREDICTION_4_NOT_ASSESSED：无预测4，不能宣称4级可靠性已经验证。'}

| 指标 | B0原始 | C最新基准 | N最终 |
| --- | --- | --- | --- |
${metrics.map(([label, get]) => `| ${label} | ${f(get(B0.metrics))} | ${f(get(C.metrics))} | ${f(get(N))} |`).join('\n')}

累计底线≥2=${r.recognition_floor.target_ge2}、≥3=${r.recognition_floor.target_ge3}，epsilon=1e-12；达标且损失优于C才替换。相对C取舍：${r.tradeoffs_vs_C.join('、') || '无报告退化'}；相对B0：${r.tradeoffs_vs_B0.join('、') || '无报告退化'}。损失下降不能替代“识别改善”的判断。

## 全池实际评分拆解

${summary.groups.slice(0, 4).map(g => `${g.group}：${g.snapshot_count}Snapshot/${g.event_count}Event，权重${g.full_pool_weighted_amount}，P均值${f(g.P.group_conditional_weighted_mean)}，最终分均值${f(g.score.group_conditional_weighted_mean)}`).join('；')}。漏报中P本身<60为${action.evidence.missed_with_P_below60}/${action.evidence.missed_snapshots}条。分组含全体低等级0/1/2、漏报预测0/1/2及50–59等分段，没有挑少量相似样本替代总体。

| 阶段 | 漏报触发Snapshot | 漏报组均值分差 | 低等级触发Snapshot | 低等级组均值分差 | 漏报阶段向下跨60 |
| --- | --- | --- | --- | --- | --- |
${missed.stages.filter(s => s.stage !== 'weighted_components').map(s => { const low = group('low_control').stages.find(x => x.stage === s.stage); return `| ${s.stage} | ${s.triggered.snapshot_count} | ${f(s.delta.group_conditional_weighted_mean)} | ${low.triggered.snapshot_count} | ${f(low.delta.group_conditional_weighted_mean)} | ${s.downward_crossing_60.snapshot_count} |`; }).join('\n')}

阶段跨线仅描述真实执行顺序，不意味着删除该阶段后最终一定跨线。组内均值除组权重，全池贡献除全池权重；未对迁移子集重分Event权重。负值截断、核心/最终舍入单列；全部样本满足五组件贡献和=P、P+后续分差=最终分，容差1e-8。Trace开/关、父C分数及等级完全一致。

| 组件 | 漏报原始均值 | 漏报实际P贡献均值 | 低等级原始均值 | 低等级实际P贡献均值 |
| --- | --- | --- | --- | --- |
${missed.components.map(c => { const low = group('low_control').components.find(x => x.component === c.component); return `| ${c.component} | ${f(c.raw.group_conditional_weighted_mean)} | ${f(c.contribution_to_P.group_conditional_weighted_mean)} | ${f(low.raw.group_conditional_weighted_mean)} | ${f(low.contribution_to_P.group_conditional_weighted_mean)} |`; }).join('\n')}

组件离满分的距离不是应补回分数。天空演化仍PARTIAL_TRACE，硬编码因子夹限不作为有效参数入口。黄金窗口仅补本次实际返回的日落概率、来源、因子、floor及状态，其他内部贡献仍PARTIAL_TRACE；窗口外明确NOT_EXECUTED，不称为无影响。观察字段只读，评分引擎文件未改；工具指纹变化明确保留，旧B0/C全池分数与指标精确复现。

## 证据目标与真实试验

目标计划=${plan.diagnostic_status}，Hash=${digest(plan)}。优先依据实际目标触发和漏报/全体低等级局部响应比，先覆盖不同阶段；局部响应仅用于选试验，未改历史分数或据此宣称因果。

${plan.selected.map(p => `- ${p.rank}. ${p.parameter_id} / ${p.canonical_path}：C=${p.current_value}，范围${JSON.stringify(p.range)}，初探${JSON.stringify(p.probe_values)}；漏报实际可影响${p.evidence.high_missed.affected_snapshots}条，低等级${p.evidence.low_control.affected_snapshots}条，优先值${p.priority}。`).join('\n') || '没有具有实际干预证据的已接线标量：NO_ACTIONABLE_PARAMETER。'}

未选机制/参数及具体代码位置保存在target_plan.json；地平线门控、天气扣分未改公式，保留触发样本及最小单标量验证建议。初探后${request.refinement_plan.status}，只细化${request.refinement_plan.parameter_id ?? '无参数'}：${JSON.stringify(request.refinement_plan.values)}。所有点对完整固定池实际Replay；未联合搜索、未重开权重/高云/中云或阈值。

实际${search.budget.evaluated_unique}/${search.budget.maximum}唯一配置（含C、不含B0），ERROR=${search.budget.errors}，重复=${search.budget.duplicates}；终止=${search.budget.termination}。逐点分数、指标、矩阵、迁移与对低等级的实际影响见search_audit.json/candidate_metrics.csv，无收益及失败点均保留。

## 找回、丢失及误报代价

${roles.map(([label, c]) => { const m = c.paired_migrations; return `### ${label}：${JSON.stringify(c.parameters)}\n\n损失=${f(c.metrics.product_loss)}，≥2/≥3召回=${f(c.metrics.target_ge2.recall)}/${f(c.metrics.target_ge3.recall)}。\n\n| 迁移 | Snapshot | 去重Event | 全池加权量 |\n| --- | --- | --- | --- |\n${MIGRATION_KEYS.map(k => `| ${k} | ${m[k].snapshot_count} | ${m[k].event_count} | ${m[k].weighted_amount} |`).join('\n')}\n\n净找回=${m.net_recovered_weight}，GT≥3权重=${m.gt_ge3_weighted_support}，比值/召回变化=${m.recall_ge3_delta_from_net}/${m.recall_ge3_delta}；新增误报按实际0/1/2=${JSON.stringify(m.new_false_alarms_by_actual)}。\n`; }).join('\n')}

同一Event可跨行，不能相加Event数。原始条数不等于加权召回；净找回最多点只作对照，不自动改选。

## 交付、复算及唯一优先后续动作

完整配置：[selected_effective_config.json](selected_effective_config.json)，回退本轮：[rollback_config.json](rollback_config.json)，原始锚点：[original_control_config.json](original_control_config.json)。发布前新进程及单独verify只Replay B0/C/最终选择、同配置去重，并重新执行C的全池Trace开关/守恒核验；不重复整场试验。

本期完成并停止。唯一优先后续动作=${action.action}：${action.minimum_discriminating_experiment}。依据及全部受影响样本见next_action.json。Trace相关性尚不能单独区分组件辨别力不足与后段压分，不据此定性机制错误；上述最小区分实验供后续决定，不自动追加运行、新数据、独立资格或部署。

父Run=${spec.parent.run_id}，固定${N.snapshot_count}Snapshot/${N.event_count}Event/${N.date_count}日期；原全部分区已复用，REUSED_DEVELOPMENT_DATA，independent_validation=false。引擎Hash=${spec.code.engine_sha256}，工具Hash=${spec.code.sha256}，策略Hash=${digest(M)}。未改源包、标签或生产配置。
`;
}

async function runMechanism(options, progress = () => {}) {
  const maxCandidates = options.maxCandidates ?? M.budget;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > M.budget) fail('INVALID_CANDIDATE_BUDGET');
  const parent = await loadMechanismParent(options.baselineRun), loaded = await loadPool(options, progress), code = await mechanismCode();
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const root of Object.values(loaded.roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  if (within(parent.root, output)) fail('OUTPUT_OVERLAPS_PARENT_RUN');
  const baseIdentity = { schema: version, policy: M, policy_sha256: digest(M), search_space: M.search_space, parent: parent.reference,
    inputs: loaded.fingerprints, original_config_sha256: digest(parent.original), current_config_sha256: digest(parent.baseline),
    pool_sha256: digest(parent.pool), code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version,
    search_plan: { max_candidates: maxCandidates, probe_values: 'DEFAULT_PLUS_MINUS_0.05R_0.10R_OR_FROZEN_REGISTRY_ABSOLUTES',
      target_limit: M.target_limit, per_target_limit: M.probe_limit_per_parameter, refinement_interior_points: M.refinement_interior_points, joint_search: false } };
  const baseHash = digest(baseIdentity), work = path.join(output, '.work', `practical_preparation_v${version}_${baseHash.slice(0, 20)}`), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true }); await acquireRunLock(lock, options.resume);
  try {
    for (const name of await readdir(output)) if (name.startsWith(`practical_tuning_v${version}_`)) {
      const m = await json(path.join(output, name, 'manifest.json'));
      if (m.base_identity_sha256 === baseHash) { const old = await inspectMechanism(path.join(output, name)); return { ...old.result, run_id: m.run_id, directory: old.directory, deduplicated: true }; }
    }
    if (await exists(path.join(work, 'preparation_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(path.join(work, 'traces'), { recursive: true }); await mkdir(path.join(work, 'candidates'), { recursive: true });
    const preparation = { base_identity: baseIdentity, base_identity_sha256: baseHash, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'preparation_spec.json'))) {
      const old = await json(path.join(work, 'preparation_spec.json')); if (digest(old.base_identity) !== baseHash) fail('RESUME_SPEC_CHANGED'); preparation.created_at_utc = old.created_at_utc;
    }
    await atomicJson(path.join(work, 'preparation_spec.json'), preparation);
    await atomicJson(path.join(work, 'state.json'), { status: 'REPRODUCING_AND_TRACING', phase7_completed: false });
    const calculator = makeCalculator(code.engine_sha256), anchors = await reproduce(loaded, parent, code, calculator, progress), rows = anchors.checked.rows;
    progress('B0/C精确复现PASS；开始全池C Trace开关与分数守恒核对');
    const restoredTraces = new Map();
    for (const name of await readdir(path.join(work, 'traces'))) if (name.endsWith('.json')) {
      const cached = await json(path.join(work, 'traces', name));
      if (digest(cached.trace) !== cached.sha256 || restoredTraces.has(cached.trace.snapshot_id)) fail('RESTORED_TRACE_HASH_MISMATCH');
      restoredTraces.set(cached.trace.snapshot_id, cached.trace);
    }
    const traces = await collectMechanismTraces(rows, parent.baseline, anchors.C.scores, calculator, { restored: restoredTraces, progress,
      save: t => atomicJson(path.join(work, 'traces', `${digest(t.snapshot_id).slice(0, 32)}.json`), { sha256: digest(t), trace: t }) });
    const summary = summarizeMechanismTraces(rows, traces), planFile = path.join(work, 'target_plan.json');
    let plan;
    if (await exists(planFile)) {
      plan = await json(planFile);
      if (plan.baseline_config_sha256 !== digest(parent.baseline) || plan.trace_rows_sha256 !== digest(traces) || plan.stage_summary_sha256 !== digest(summary)) fail('RESUME_TARGET_PLAN_MISMATCH');
      progress('恢复已冻结目标计划；不按未完成候选重新挑选参数');
    } else { plan = buildTargetPlan(rows, traces, summary, parent.baseline); await atomicJson(planFile, plan); }
    const identity = { ...baseIdentity, base_identity_sha256: baseHash, recognition_floor: recognitionFloor(anchors.B0.metrics),
      target_plan_sha256: digest(plan), trace_rows_sha256: digest(traces), stage_summary_sha256: digest(summary) };
    const runId = `practical_tuning_v${version}_${digest(identity).slice(0, 20)}`, target = path.join(output, runId);
    const spec = { practical_tuning_schema_version: version, practical_tuning_policy_version: version, run_id: runId, identity, code,
      parent: parent.reference, parent_directory: parent.root, sources: loaded.roots, original_control_config: parent.original, baseline_config: parent.baseline,
      created_at_utc: preparation.created_at_utc };
    if (await exists(path.join(work, 'run_spec.json')) && digest((await json(path.join(work, 'run_spec.json'))).identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED');
    await atomicJson(path.join(work, 'run_spec.json'), spec); await atomicJson(path.join(work, 'stage_summary.json'), summary);
    await writeFile(path.join(work, 'trace_rows.jsonl'), traces.map(canonicalJson).join('\n') + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'SEARCHING', phase7_completed: false, run_id: runId });
    progress(`全池${rows.length}条Trace通过；目标=${plan.selected.map(p => p.parameter_id).join(',') || 'NO_ACTIONABLE_PARAMETER'}；Run=${runId}`);
    const restored = []; for (const name of await readdir(path.join(work, 'candidates'))) if (name.endsWith('.json')) restored.push(await json(path.join(work, 'candidates', name)));
    const refinementFile = path.join(work, 'refinement_plan.json');
    const search = await searchMechanisms({ current: parent.baseline, original: parent.original, engine_sha256: code.engine_sha256, plan,
      originalMetrics: anchors.B0.metrics, maxCandidates, restored, frozenRefinement: await exists(refinementFile) ? await json(refinementFile) : null,
      evaluate: async c => { const r = await evaluate(rows, installMechanism(parent.baseline, c.parameters), calculator);
        return { ...r, paired_migrations: pairedMigrations(rows, anchors.C.scores, r.scores), effects: candidateEffects(rows, anchors.C, r.scores),
          ...(adapter.evaluateExtra ? await adapter.evaluateExtra({ rows, config: installMechanism(parent.baseline, c.parameters), calculator, currentTraces: traces, scores: r.scores, plan }) : {}) };  },
      save: r => atomicJson(path.join(work, 'candidates', `${r.candidate_id}.json`), r), saveRefinement: p => atomicJson(refinementFile, p),
      progress: p => progress(`已评估${p.count} ${p.stage} ${JSON.stringify(p.candidate.parameters)} ${p.candidate.status}；累计识别优先最优损失=${p.best?.metrics.product_loss ?? null}`) });
    const result = selectMechanism(search.records, search.baseline_id, anchors.B0.metrics), selected = search.records.find(r => r.candidate_id === result.selected_candidate);
    const request = { spec, pool: parent.pool, exclusions: parent.exclusions, B0: anchors.B0, C: anchors.C, selected,
      selected_effective_config: installMechanism(parent.baseline, selected.parameters), phase7_result: result, search_records: search.records,
      trace_rows: traces, stage_summary: summary, target_plan: plan, refinement_plan: search.refinement };
    if (adapter.extendRequest) Object.assign(request, await adapter.extendRequest(request, { rows, calculator }));
    validateMechanismRequest(request);
    await atomicJson(path.join(work, 'verification_request.json'), request);
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', phase7_completed: false, run_id: runId });
    progress('试验结束；新进程只复算B0/C/最终选择及C的全池Trace，不重复搜索');
    const proof = await highCloudWorker(path.join(work, 'verification_request.json'));
    const files = { 'pool_manifest.json': parent.pool, 'exclusions.json': parent.exclusions, 'baseline_config.json': parent.baseline,
      'rollback_config.json': parent.baseline, 'original_control_config.json': parent.original, 'selected_effective_config.json': request.selected_effective_config,
      'selected_candidate.json': selected, 'phase7_result.json': result, 'comparison.json': { B0: anchors.B0.metrics, C: anchors.C.metrics, N: selected.metrics },
      'top_candidates.json': rankHighCloud(search.records, anchors.B0.metrics).slice(0, 5), 'search_audit.json': { budget: search.budget, proposals: search.audit, records: search.records },
      'paired_migrations.json': search.records.filter(r => r.status === 'EVALUATED').map(r => ({ candidate_id: r.candidate_id, parameters: r.parameters, ...r.paired_migrations })),
      'slices.json': slices(rows, anchors, selected), 'constant_baselines.json': constantComparisons(rows), 'baseline_reproduction.json': anchors.audit,
      'verification.json': proof, 'next_action.json': nextAction(request), 'cache_statistics.json': calculator.stats(), ...(adapter.outputFiles ? adapter.outputFiles(request) : {}) };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'candidate_metrics.csv'), csv(search.records.map(r => ({ candidate_id: r.candidate_id, stage: r.stage, status: r.status, ...r.parameters,
      meets_cumulative_floor: meetsHighCloudRecognition(r, anchors.B0.metrics), product_loss: r.metrics?.product_loss ?? null,
      delta_vs_C: r.metrics ? q(r.metrics.product_loss - anchors.C.metrics.product_loss) : null,
      recall_ge2: r.metrics?.target_ge2.recall ?? null, recall_ge3: r.metrics?.target_ge3.recall ?? null,
      precision_ge3: r.metrics?.target_ge3.precision ?? null, underprediction_ge2: r.metrics?.underprediction_ge2 ?? null,
      ...r.effects, ...migrationCsvFields(r), reason_code: r.reason_code ?? null }))));
    await writeFile(path.join(work, 'selected_predictions.csv'), csv(rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, gt_ordinal: r.gt_ordinal,
      event_normalized_weight: r.event_normalized_weight, B0_score: anchors.B0.scores[i], B0_ordinal: scoreToOrdinal(anchors.B0.scores[i]),
      C_score: anchors.C.scores[i], C_ordinal: scoreToOrdinal(anchors.C.scores[i]), N_score: selected.scores[i], N_ordinal: scoreToOrdinal(selected.scores[i]) }))));
    if (adapter.traceFileName) await writeFile(path.join(work, adapter.traceFileName), traces.map(canonicalJson).join('\n') + '\n');
    await writeFile(path.join(work, 'report.md'), renderMechanismReport(request, search).replace(/\r?\n/g, '\r\n'));
    await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    if (digest((await loadMechanismParent(parent.root)).reference) !== digest(parent.reference)) fail('PARENT_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl'), prior = await exists(history) ? (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
    if (!prior.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, search_space: M.search_space, usage: POLICY.usage,
      evaluation_scope: POLICY.evaluation_scope, independent_validation: false, parent_run_id: parent.reference.run_id, model: loaded.source_ids.model,
      target_plan_sha256: digest(plan), historical_partitions: parent.pool.historical_partitions,
      members: parent.pool.included.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, historical_splits: r.historical_splits })), selection_status: result.selection_status }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', phase7_completed: true, run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: version, practical_tuning_policy_version: version, run_id: runId,
      base_identity_sha256: baseHash, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { run_id: runId, directory: target, phase7_completed: true, selection_status: result.selection_status, selected_candidate: selected.candidate_id,
      selected_parameters: selected.parameters, high_grade_recognition_improved: result.high_grade_recognition_improved,
      delta_product_loss_vs_C: result.metrics_vs_current.delta_product_loss, delta_product_loss_vs_B0: result.metrics_vs_original.delta_product_loss,
      evaluated_candidates: search.budget.evaluated_unique, target_parameters: plan.selected.map(p => p.parameter_id), trial_config_available: true, independent_validation: false };
  } catch (e) { if (await exists(path.join(work, 'preparation_spec.json'))) await atomicJson(path.join(work, 'state.json'), { status: 'EXECUTION_ERROR', phase7_completed: false, error_code: errorCode(e) }); throw e; }
  finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}

async function verifyMechanismRequest(request, { compatibleTools = false } = {}) {
  const { spec } = request, code = await mechanismCode();
  if ((!compatibleTools && code.sha256 !== spec.code.sha256) || code.node_version !== spec.code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engineCompatibility = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: compatibleTools });
  if (digest(spec.identity.policy) !== digest(M) || spec.identity.policy_sha256 !== digest(M)) fail('MECHANISM_POLICY_MISMATCH');
  const parent = await loadMechanismParent(spec.parent_directory);
  if (digest(parent.reference) !== digest(spec.parent) || digest(spec.identity.parent) !== digest(spec.parent) ||
      digest(parent.original) !== digest(spec.original_control_config) || digest(parent.baseline) !== digest(spec.baseline_config)) fail('PARENT_BINDING_MISMATCH');
  const loaded = await loadPool(spec.sources), calculator = makeCalculator(code.engine_sha256);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const anchors = await reproduce(loaded, parent, code, calculator);
  if (digest(request.pool) !== digest(parent.pool) || digest(request.exclusions) !== digest(parent.exclusions)) fail('PRACTICAL_COHORT_MISMATCH');
  const selected = await evaluate(anchors.checked.rows, installMechanism(parent.baseline, request.selected.parameters), calculator);
  for (const [actual, expected] of [[anchors.B0, request.B0], [anchors.C, request.C], [selected, request.selected]])
    if (digest(actual.scores) !== digest(expected.scores) || actual.predictions_sha256 !== expected.predictions_sha256 || digest(actual.metrics) !== digest(expected.metrics)) fail('FINAL_RECOMPUTE_MISMATCH');
  const traces = await collectMechanismTraces(anchors.checked.rows, parent.baseline, anchors.C.scores, calculator);
  if (digest(traces) !== digest(request.trace_rows)) fail('FINAL_TRACE_RECOMPUTE_MISMATCH');
  if (adapter.verifyAdditional) await adapter.verifyAdditional(request, { rows: anchors.checked.rows, calculator });
  validateMechanismRequest(request);
  await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
  return { status: 'PASS', engine_compatibility: engineCompatibility, scope: 'FRESH_PROCESS_B0_C_SELECTED_AND_C_TRACE_ONLY', engine_replayed: true,
    recomputed_snapshots: anchors.checked.rows.length, trace_snapshots: traces.length,
    unique_config_count: new Set([digest(parent.original), digest(parent.baseline), digest(request.selected_effective_config)]).size,
    B0_predictions_sha256: anchors.B0.predictions_sha256, C_predictions_sha256: anchors.C.predictions_sha256,
    selected_predictions_sha256: selected.predictions_sha256, trace_rows_sha256: digest(traces), target_plan_sha256: digest(request.target_plan),
    per_sample_score_and_ordinal_equal: true, metrics_equal: true, paired_migrations_equal: true, cumulative_selection_equal: true,
    trace_switch_parity_and_conservation: true, full_search_repeated: false, ...(adapter.verifyAdditional ? { selected_branch_trace_and_coupling_equal: true } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: `CURRENT_POLICY${version}_${engineCompatibility.mode}_EXACT_PREDICTIONS_METRICS_TRACE_AND_SELECTION`,
      original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}

async function inspectMechanism(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== version || manifest.practical_tuning_policy_version !== version) fail('UNSUPPORTED_PRACTICAL_VERSION');
  const required = ['run_spec.json', 'pool_manifest.json', 'exclusions.json', 'baseline_config.json', 'rollback_config.json', 'original_control_config.json',
    'selected_effective_config.json', 'selected_candidate.json', 'phase7_result.json', 'trace_rows.jsonl', 'stage_summary.json', 'target_plan.json', 'refinement_plan.json',
    'verification_request.json', 'verification.json', 'search_audit.json', 'comparison.json', 'candidate_metrics.csv', 'selected_predictions.csv', 'paired_migrations.json', 'report.md', 'next_action.json'];
  for (const name of required) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files)) if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), request = await json(path.join(root, 'verification_request.json')), result = await json(path.join(root, 'phase7_result.json'));
  const { target_plan_sha256, trace_rows_sha256, stage_summary_sha256, recognition_floor, base_identity_sha256, ...baseIdentity } = spec.identity;
  if (manifest.identity_sha256 !== digest(spec.identity) || manifest.base_identity_sha256 !== digest(baseIdentity) || base_identity_sha256 !== digest(baseIdentity) ||
      spec.run_id !== manifest.run_id || manifest.run_id !== `practical_tuning_v${version}_${digest(spec.identity).slice(0, 20)}` ||
      spec.practical_tuning_schema_version !== version || spec.practical_tuning_policy_version !== version || spec.identity.search_space !== M.search_space ||
      spec.code.sha256 !== spec.identity.code_sha256 || spec.code.engine_sha256 !== spec.identity.engine_sha256 ||
      digest(spec.original_control_config) !== spec.identity.original_config_sha256 || digest(spec.baseline_config) !== spec.identity.current_config_sha256 ||
      digest(spec.parent) !== digest(spec.identity.parent) || digest(request.pool) !== spec.identity.pool_sha256 ||
      digest(spec.identity.recognition_floor) !== digest(recognitionFloor(request.B0.metrics)) ||
      spec.identity.policy_sha256 !== digest(M) || digest(spec.identity.policy) !== digest(M) || spec.code.policy_sha256 !== digest(M) ||
      digest(request.spec) !== digest(spec) || digest(request.phase7_result) !== digest(result) || !result.phase7_completed || result.independent_validation !== false ||
      result.practical_tuning_schema_version !== version || result.practical_tuning_policy_version !== version) fail('INVALID_PRACTICAL_RESULT');
  const pairs = { 'pool_manifest.json': request.pool, 'exclusions.json': request.exclusions, 'baseline_config.json': spec.baseline_config,
    'rollback_config.json': spec.baseline_config, 'original_control_config.json': spec.original_control_config, 'selected_effective_config.json': request.selected_effective_config,
    'selected_candidate.json': request.selected, 'stage_summary.json': request.stage_summary, 'target_plan.json': request.target_plan, 'refinement_plan.json': request.refinement_plan,
    'comparison.json': { B0: request.B0.metrics, C: request.C.metrics, N: request.selected.metrics }, 'next_action.json': nextAction(request),
    'paired_migrations.json': request.search_records.filter(r => r.status === 'EVALUATED').map(r => ({ candidate_id: r.candidate_id, parameters: r.parameters, ...r.paired_migrations })) };
  for (const [name, value] of Object.entries(pairs)) if (digest(await json(path.join(root, name))) !== digest(value)) fail('PRACTICAL_RESULT_BINDING_MISMATCH');
  if ((await json(path.join(root, 'verification.json'))).status !== 'PASS') fail('FINAL_RECOMPUTE_PROOF_MISSING');
  if (adapter.outputFiles) for (const [name, value] of Object.entries(adapter.outputFiles(request))) {
    if (!manifest.files[name] || digest(await json(path.join(root, name))) !== digest(value)) fail('PRACTICAL_RESULT_BINDING_MISMATCH');
  }
  if (adapter.traceFileName && (!manifest.files[adapter.traceFileName] || hash(await readSafe(path.join(root, adapter.traceFileName))) !== hash(await readSafe(path.join(root, 'trace_rows.jsonl'))))) fail('PRACTICAL_RESULT_BINDING_MISMATCH');
  const traces = (await readSafe(path.join(root, 'trace_rows.jsonl'))).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  if (digest(traces) !== digest(request.trace_rows) || digest((await json(path.join(root, 'search_audit.json'))).records) !== digest(request.search_records)) fail('PRACTICAL_RESULT_BINDING_MISMATCH');
  validateMechanismRequest(request);
  return { status: 'PASS', directory: root, manifest, spec, result };
}
async function verifyMechanism(directory) {
  const inspected = await inspectMechanism(directory), proof = await highCloudWorker(path.join(directory, 'verification_request.json'), true);
  return { ...proof, run_id: inspected.manifest.run_id, phase7_completed: true };
}

return { runMechanism, inspectMechanism, verifyMechanism, verifyMechanismRequest, validateMechanismRequest, loadMechanismParent };
}
export const { runMechanism, inspectMechanism, verifyMechanism, verifyMechanismRequest, validateMechanismRequest, loadMechanismParent } = createTargetedWorkflow();
