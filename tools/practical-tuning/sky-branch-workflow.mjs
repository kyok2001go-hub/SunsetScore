import path from 'node:path';
import { readSafe, safePath, hash, fail } from '../dataset/lib/common.mjs';
import { runReplay } from '../replay/replay-runner.mjs';
import { replayCalculator, preflight, evaluateConfig } from './compute.mjs';
import { digest, POLICY } from './policy.mjs';
import { inspectPractical } from './workflow.mjs';
import { createTargetedWorkflow } from './mechanism-workflow.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { highCloudMetrics } from './high-cloud.mjs';
import { collectMechanismTraces } from './mechanism-trace.mjs';
import { SKY_POLICY, summarizeSkyBranches, buildBranchPlan, installSky, skyCandidate, refineSky, searchSky, selectSky } from './sky-branch.mjs';
import { MIGRATION_KEYS } from './migrations.mjs';
const json = async p => JSON.parse(await readSafe(p));
export const skyCalculator = engine => replayCalculator(engine, (r, o) => runReplay(r, { ...o, skyBranchTrace: o.trace === true }));
export async function loadSkyParent(directory) {
  const root = await safePath(directory), bytes = await readSafe(path.join(root, 'manifest.json')), m = JSON.parse(bytes);
  if (m.practical_tuning_schema_version !== 4 || m.practical_tuning_policy_version !== 4) fail('SKY_PARENT_MUST_BE_MECHANISM_RUN_V4');
  const p = await inspectPractical(root), original = await json(path.join(root, 'original_control_config.json')), baseline = await json(path.join(root, 'selected_effective_config.json'));
  return { root, original, baseline, spec: p.spec, request: await json(path.join(root, 'verification_request.json')), pool: await json(path.join(root, 'pool_manifest.json')),
    exclusions: await json(path.join(root, 'exclusions.json')), reference: { run_id: m.run_id, manifest_sha256: hash(bytes), candidate_id: p.result.selected_candidate,
      original_config_sha256: digest(original), current_config_sha256: digest(baseline), engine_sha256: p.spec.code.engine_sha256,
      members_sha256: digest((await json(path.join(root, 'pool_manifest.json'))).included), inputs_sha256: digest(p.spec.identity.inputs) } };
}
async function reproduce(loaded, parent, code, calculator, progress) {
  const compatibility = assertCompatibleEngine(code, parent.spec.code, { allowDefaultCompatibility: true, reason: 'PARENT_ENGINE_DIFFERS' });
  if (digest(loaded.fingerprints) !== digest(parent.spec.identity.inputs) || digest(loaded.source_ids) !== digest(parent.pool.source_ids)) fail('PARENT_INPUT_FILES_DIFFER');
  const checked = await preflight(loaded, parent.original, calculator, progress);
  if (digest(checked.included) !== digest(parent.pool.included) || digest(checked.exclusions) !== digest(parent.exclusions)) fail('PARENT_COHORT_OR_B0_SCORES_DIFFER');
  const evaluate = async cfg => { const r = await evaluateConfig(checked.rows, cfg, calculator); return { ...r, metrics: highCloudMetrics(checked.rows, r.scores) }; };
  const B0 = await evaluate(parent.original), C = await evaluate(parent.baseline);
  for (const [actual, expected] of [[B0, parent.request.B0], [C, parent.request.selected]])
    if (digest(actual.scores) !== digest(expected.scores) || actual.predictions_sha256 !== expected.predictions_sha256 || digest(actual.metrics) !== digest(expected.metrics)) fail('DEFAULT_SKY_BEHAVIOR_DRIFT');
  return { checked, B0, C, audit: { status: 'PASS', member_count: checked.rows.length, engine_compatibility: compatibility,
    old_metrics_exactly_reproduced: true, B0_source: 'original_control_config.json', current_source: 'selected_effective_config.json',
    raw_current_config_sha256: digest(parent.baseline), defaults_added_to_parent: false, B0_predictions_sha256: B0.predictions_sha256, C_predictions_sha256: C.predictions_sha256 } };
}
function protectedSignature(t) {
  const s = t.sky_branch;
  return digest({ components: t.components, dynamic_weights: t.dynamic_weights, contributions: t.contributions, P: t.P, Q: t.Q,
    horizon_gate: t.horizon_gate, hard_gate_reasons: t.hard_gate_reasons, core_stages: t.stages.slice(0, 9),
    F_gw: s.fusion.F_gw, inputs: s.inputs, sector: s.sector, nodes: s.nodes, thresholds: s.thresholds, decisions: s.decisions,
    branch_id: s.branch_id, state: s.state, fallbacks: s.fallbacks, execution_context: s.execution_context });
}
function light(t) {
  const s = t.sky_branch;
  if (!s || Math.abs(s.fusion.score_engine * s.fusion.applied_factor - s.fusion.score_after_sky) > 1e-8 || s.fusion.final_score !== t.predicted_score || s.fusion.returned_factor !== s.returned_factor) fail('SKY_BRANCH_TRACE_NOT_CONSERVED');
  return { snapshot_id: t.snapshot_id, branch_id: s.branch_id, state: s.state, applied_factor: s.fusion.applied_factor,
    returned_factor: s.returned_factor, final_score: t.predicted_score, protected_sha256: protectedSignature(t), formula_sha256: digest(s.formula) };
}
export function assertSkyCoupling(currentRows, candidateRows, target) {
  if (currentRows.length !== candidateRows.length) fail('SKY_CANDIDATE_COHORT_MISMATCH');
  let nonTargets = 0, changedTargets = 0;
  for (const [i, a] of currentRows.entries()) {
    const b = candidateRows[i];
    if (!b || a.snapshot_id !== b.snapshot_id || a.branch_id !== b.branch_id || a.state !== b.state || a.protected_sha256 !== b.protected_sha256) fail('SKY_OTHER_COMPONENT_OR_BRANCH_CHANGED');
    if (a.branch_id !== target) { nonTargets++; if (digest(a) !== digest(b)) fail('SKY_NON_TARGET_PREDICTION_CHANGED'); }
    else if (a.applied_factor !== b.applied_factor) changedTargets++;
  }
  return { status: 'PASS', non_target_snapshots: nonTargets, changed_target_factors: changedTargets, protected_components_Q_gates_penalties_and_F_gw_equal: true };
}
async function evaluateExtra({ rows, config, calculator, currentTraces, scores, plan }) {
  const next = await collectMechanismTraces(rows, config, scores, calculator), skyRows = next.map(light);
  return { sky_rows: skyRows, coupling: assertSkyCoupling(currentTraces.map(light), skyRows, plan.selected[0]?.branch_id ?? null) };
}
function validateAdditional(request) {
  const current = request.trace_rows.map(light), target = request.target_plan.selected[0]?.branch_id ?? null;
  for (const r of request.search_records.filter(r => r.status === 'EVALUATED')) {
    if (digest(assertSkyCoupling(current, r.sky_rows, target)) !== digest(r.coupling) || r.sky_rows.some((s, i) => s.final_score !== r.scores[i])) fail('SKY_COUPLING_BINDING_MISMATCH');
  }
  if (request.selected_sky_traces && digest(request.selected_sky_traces.map(light)) !== digest(request.selected.sky_rows)) fail('SKY_SELECTED_TRACE_BINDING_MISMATCH');
}
function renderReport(req, search) {
  const { phase7_result: r, C, B0, selected: n, target_plan: p, stage_summary: s } = req, f = v => v == null ? 'null' : String(Number(v.toFixed(6)));
  const most = req.search_records.filter(c => c.status === 'EVALUATED').sort((a, b) => b.paired_migrations.net_recovered_weight - a.paired_migrations.net_recovered_weight || a.metrics.product_loss - b.metrics.product_loss)[0];
  const metrics = [['产品损失', m => m.product_loss], ['≥2召回', m => m.target_ge2.recall], ['≥3召回', m => m.target_ge3.recall], ['MAE', m => m.mae], ['Bias', m => m.bias], ['QWK', m => m.qwk],
    ['低估至少2级', m => m.underprediction_ge2], ['高估至少2级', m => m.overprediction_ge2], ['预测4条数', m => m.predicted4_support.snapshot_count]];
  return `# V2.5.4.13 天空演化单分支系数与Phase7

**Phase7完成：${r.selection_status}；高等级识别改善=${r.high_grade_recognition_improved}。** 配置=${JSON.stringify(n.parameters)}；本轮降损=${f((C.metrics.product_loss - n.metrics.product_loss) / C.metrics.product_loss * 100)}%，累计降损=${f((B0.metrics.product_loss - n.metrics.product_loss) / B0.metrics.product_loss * 100)}%。

| 指标 | B0 | C最新基准 | N最终 |
| --- | --- | --- | --- |
${metrics.map(([name, get]) => `| ${name} | ${f(get(B0.metrics))} | ${f(get(C.metrics))} | ${f(get(n.metrics))} |`).join('\n')}

相对C取舍=${r.tradeoffs_vs_C.join('、') || '无报告退化'}；相对B0=${r.tradeoffs_vs_B0.join('、') || '无报告退化'}。无预测4时NOT_ASSESSED；无新增≥3误报不等于没有任何新增高估。底线始终锚定B0，且必须严格胜最新C。

## 分支证据与目标

全部${C.metrics.snapshot_count}Snapshot/${C.metrics.event_count}Event/${C.metrics.date_count}日期；原TRAIN/VALIDATION/TEST用于开发，不称独立TEST。完整记录实际当前云场与m60、扇区节点/云层辅助值、缺失回落、||默认值、到达时间truthy、逐项TRUE/FALSE/NOT_EVALUATED、分支公式、分支内下限、3位舍入和内外两层夹限。总云量不等于高云覆盖率；云层辅助值不参与本轮状态条件。

| 分支 | 漏报Snapshot | 向下跨60加权支持 | 漏报压分加权总量 | 低等级同分支权重 |
| --- | --- | --- | --- | --- |
${p.ranking.map(b => `| ${b.branch_id} | ${b.snapshot_count} | ${b.crossing_down_60.full_pool_weighted_amount} | ${b.weighted_suppression_total} | ${b.low_control.full_pool_weighted_amount} |`).join('\n')}

唯一目标=${p.selected[0]?.branch_id ?? 'NO_ACTIONABLE_BRANCH'}，参数=${p.selected[0]?.canonical_path ?? '无'}，初探=${JSON.stringify(p.selected[0]?.probe_values ?? [])}。排序按上述三列及固定branch_id，只有漏报实际命中且能改变最终因子的分支参与；排序安排试验，不证明规则错误。全部组/分支支持、因子分布、夹限和回落见sky_branch_summary.json，低等级GT0/1/2全部保留。组内均值和全池贡献的分母单独标明，不把跨线条数相加当找回数。

## 真实试验与代价

${search.budget.evaluated_unique}个唯一配置（含C，不含B0），ERROR=${search.budget.errors}，终止=${search.budget.termination}。细化=${req.refinement_plan.status}，${JSON.stringify(req.refinement_plan.values)}。保持全部分支条件、优先级/状态、权重、高中云、黄金窗口floor=${req.spec.baseline_config.goldenWindow.floor}、等级阈值及夹限范围不变。参数值规范12位，实际因子仍3位；同效预测组=${JSON.stringify(r.same_prediction_groups)}，不宣称精确物理常数。

${[['最终选择', n], ['净找回最多的代价对照', most]].map(([label, c]) => { const m = c.paired_migrations; return `### ${label}：${JSON.stringify(c.parameters)}\n\n损失=${f(c.metrics.product_loss)}，≥2/≥3召回=${f(c.metrics.target_ge2.recall)}/${f(c.metrics.target_ge3.recall)}。\n\n| C→候选迁移 | Snapshot | 去重Event | 全池加权量 |\n| --- | --- | --- | --- |\n${MIGRATION_KEYS.map(k => `| ${k} | ${m[k].snapshot_count} | ${m[k].event_count} | ${m[k].weighted_amount} |`).join('\n')}\n\n净找回=${m.net_recovered_weight}，GT≥3支持=${m.gt_ge3_weighted_support}，比值/召回变化=${m.recall_ge3_delta_from_net}/${m.recall_ge3_delta}；新增误报按GT0/1/2=${JSON.stringify(m.new_false_alarms_by_actual)}。\n`; }).join('\n')}

全池Event内分权，不在迁移子集重新归一化；Event可能跨行，不可简单相加。所有候选完整Replay并核对非目标分支分数/状态/因子零变化；目标分支其他组件、Q、门控/扣分及F_gw相同，失败整点ERROR。对照不自动改选，配置改善与识别改善分别报告。

## 默认兼容、交付及停止

共享sky_state实现同时供生产与Replay调用，仅提取arrivalRiskSlope，缺失为0.30，合法0保留；源码指纹已变化。js/config的新增默认值和静态资源修订保持旧数值行为，旧冻结配置不补写字段，baseline/rollback仍为原始C。逐样本复现父B0/C及指标后才试验，旧/新指纹及受限文件清单见baseline_reproduction.json。旧V1–V4使用明确的默认兼容实现，不能宣称回到历史源码环境。

[完整配置](selected_effective_config.json)；[本轮C回退](rollback_config.json)；[原始B0](original_control_config.json)。发布前及单独verify仅重算B0/C/N（去重）及C/N全池Trace，核对开关、非目标不变、迁移和选择，不重复搜索。计划/Trace及最终配置绑定身份；同spec恢复复用既定目标。输入与历史Run不覆盖。

本轮停止，未部署。${r.selection_status === 'KEEP_CONTROL' ? '系数试验没有可接受收益，保留C。后续仅考虑illumination实际评分依据与低等级对照，不自动继续本分支或新增条件/云层规则。' : '保留新配置供后续决定试用；不自动扩搜、改分类规则或上线。'} 分支与天气/提前量相关，不能用组间差异作因果结论；仍不能认为全部漏报由F_sky造成。
`;
}
const api = createTargetedWorkflow({ policy: SKY_POLICY, calculator: skyCalculator, loadParent: loadSkyParent, reproduce, buildPlan: buildBranchPlan,
  install: installSky, candidate: skyCandidate, refine: refineSky, search: searchSky, select: selectSky, summarize: summarizeSkyBranches,
  evaluateExtra, validateAdditional, renderReport, traceFileName: 'sky_branch_traces.jsonl',
  extendRequest: async (r, { rows, calculator }) => ({ selected_sky_traces: await collectMechanismTraces(rows, r.selected_effective_config, r.selected.scores, calculator) }),
  verifyAdditional: async (r, { rows, calculator }) => { const selected = await collectMechanismTraces(rows, r.selected_effective_config, r.selected.scores, calculator);
    if (digest(selected) !== digest(r.selected_sky_traces)) fail('SKY_SELECTED_TRACE_RECOMPUTE_MISMATCH'); },
  outputFiles: r => ({ 'sky_branch_summary.json': r.stage_summary, 'branch_plan.json': r.target_plan, 'selected_sky_branch_traces.json': r.selected_sky_traces,
    'sky_coupling_audit.json': r.search_records.map(c => ({ candidate_id: c.candidate_id, status: c.status, coupling: c.coupling ?? null })) }),
  nextAction: r => ({ action: r.phase7_result.selection_status === 'KEEP_CONTROL' ? 'CHECK_ILLUMINATION_ACTUAL_SCORING_WITH_ALL_LOW_GRADE_CONTROLS' : 'REVIEW_EXPORTED_CONFIGURATION_FOR_POSSIBLE_TRIAL', automatic_next_run: false }) });
export const { runMechanism: runSkyBranch, inspectMechanism: inspectSkyBranch, verifyMechanism: verifySkyBranch, verifyMechanismRequest: verifySkyRequest } = api;
