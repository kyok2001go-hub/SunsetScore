import path from 'node:path';
import { readSafe, safePath, hash, fail } from '../dataset/lib/common.mjs';
import { runReplay } from '../replay/replay-runner.mjs';
import { replayCalculator, preflight, evaluateConfig, assertLegacyGradeConfig } from './compute.mjs';
import { digest } from './policy.mjs';
import { inspectPractical } from './workflow.mjs';
import { createTargetedWorkflow } from './mechanism-workflow.mjs';
import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { highCloudMetrics, meetsHighCloudRecognition } from './high-cloud.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { MIGRATION_KEYS } from './migrations.mjs';
import { ILLUMINATION_POLICY, summarizeIllumination, buildIlluminationPlan, installIllumination, illuminationCandidate, refineIllumination, searchIllumination, selectIllumination } from './illumination-targeted.mjs';
import { collectIlluminationTraces, illuminationLight, assertIlluminationCoupling } from './illumination-trace.mjs';
const json = async p => JSON.parse(await readSafe(p));
export const illuminationCalculator = engine => replayCalculator(engine, (r, o) => runReplay(r, { ...o, illuminationTrace: o.trace === true, skyBranchTrace: o.trace === true }));
export async function loadIlluminationParent(directory) {
  const root = await safePath(directory), bytes = await readSafe(path.join(root, 'manifest.json')), m = JSON.parse(bytes);
  if (m.practical_tuning_schema_version !== 5 || m.practical_tuning_policy_version !== 5) fail('ILLUMINATION_PARENT_MUST_BE_SKY_RUN_V5');
  const p = await inspectPractical(root), original = await json(path.join(root, 'original_control_config.json')), baseline = await json(path.join(root, 'selected_effective_config.json'));
  assertLegacyGradeConfig(baseline, 'PRACTICAL_PARENT_GRADE_LINES_UNSUPPORTED');
  const pool = await json(path.join(root, 'pool_manifest.json'));
  return { root, original, baseline, spec: p.spec, pool, request: await json(path.join(root, 'verification_request.json')), exclusions: await json(path.join(root, 'exclusions.json')),
    reference: { run_id: m.run_id, manifest_sha256: hash(bytes), candidate_id: p.result.selected_candidate, original_config_sha256: digest(original), current_config_sha256: digest(baseline),
      engine_sha256: p.spec.code.engine_sha256, members_sha256: digest(pool.included), inputs_sha256: digest(p.spec.identity.inputs) } };
}
async function reproduce(loaded, parent, code, calculator, progress) {
  const compatibility = assertCompatibleEngine(code, parent.spec.code, { allowDefaultCompatibility: true, reason: 'PARENT_ENGINE_DIFFERS' });
  if (digest(loaded.fingerprints) !== digest(parent.spec.identity.inputs) || digest(loaded.source_ids) !== digest(parent.pool.source_ids)) fail('PARENT_INPUT_FILES_DIFFER');
  const checked = await preflight(loaded, parent.original, calculator, progress);
  if (digest(checked.included) !== digest(parent.pool.included) || digest(checked.exclusions) !== digest(parent.exclusions)) fail('PARENT_COHORT_OR_B0_SCORES_DIFFER');
  const evaluate = async cfg => { const r = await evaluateConfig(checked.rows, cfg, calculator); return { ...r, metrics: highCloudMetrics(checked.rows, r.scores) }; };
  const B0 = await evaluate(parent.original), C = await evaluate(parent.baseline);
  for (const [actual, expected] of [[B0, parent.request.B0], [C, parent.request.selected]])
    if (digest(actual.scores) !== digest(expected.scores) || actual.predictions_sha256 !== expected.predictions_sha256 || digest(actual.metrics) !== digest(expected.metrics)) fail('DEFAULT_ILLUMINATION_BEHAVIOR_DRIFT');
  return { checked, B0, C, audit: { status: 'PASS', member_count: checked.rows.length, engine_compatibility: compatibility, old_metrics_exactly_reproduced: true,
    B0_source: 'original_control_config.json', current_source: 'selected_effective_config.json', raw_current_config_sha256: digest(parent.baseline), defaults_added_to_parent: false,
    B0_predictions_sha256: B0.predictions_sha256, C_predictions_sha256: C.predictions_sha256 } };
}
function allGradeChanges(rows, current, next) {
  return rows.flatMap((r, i) => scoreToOrdinal(current[i]) === scoreToOrdinal(next[i]) ? [] : [{ snapshot_id: r.snapshot_id, event_id: r.event_id, gt_ordinal: r.gt_ordinal,
    full_pool_weight: r.event_normalized_weight, C_score: current[i], N_score: next[i], C_ordinal: scoreToOrdinal(current[i]), N_ordinal: scoreToOrdinal(next[i]) }]);
}
function validateAdditional(r) {
  const a = r.trace_rows.map(illuminationLight);
  for (const c of r.search_records.filter(c => c.status === 'EVALUATED')) {
    if (digest(assertIlluminationCoupling(a, c.illumination_rows)) !== digest(c.coupling) || c.illumination_rows.some((s, i) => s.final_score !== c.scores[i]) ||
      digest(allGradeChanges(r.pool.included, r.C.scores, c.scores)) !== digest(c.all_grade_changes)) fail('ILLUMINATION_COUPLING_BINDING_MISMATCH');
  }
  if (digest(r.selected_illumination_traces.map(illuminationLight)) !== digest(r.selected.illumination_rows)) fail('ILLUMINATION_SELECTED_TRACE_BINDING_MISMATCH');
}
function renderReport(r, search) {
  const f = v => v == null ? 'null' : String(Number(v.toFixed(6))), result = r.phase7_result, N = r.selected.metrics, C = r.C.metrics, B0 = r.B0.metrics;
  const group = id => r.stage_summary.groups.find(g => g.group === id), most = [...r.search_records].filter(c => c.status === 'EVALUATED').sort((a, b) => b.paired_migrations.net_recovered_weight - a.paired_migrations.net_recovered_weight || a.metrics.product_loss - b.metrics.product_loss)[0];
  const metricRows = [['产品损失', m => m.product_loss], ['≥2召回', m => m.target_ge2.recall], ['≥3召回', m => m.target_ge3.recall], ['MAE', m => m.mae], ['Bias', m => m.bias], ['QWK', m => m.qwk],
    ['高估至少2级', m => m.overprediction_ge2], ['低估至少2级', m => m.underprediction_ge2], ['预测4条数', m => m.predicted4_support.snapshot_count]];
  return `# V2.5.4.14 Illumination评分拆解与定向优化Phase7

**Phase7完成：${result.selection_status}；高等级识别改善=${result.high_grade_recognition_improved}。** 参数=${JSON.stringify(r.selected.parameters)}。本轮降损=${f((C.product_loss - N.product_loss) / C.product_loss * 100)}%，累计降损=${f((B0.product_loss - N.product_loss) / B0.product_loss * 100)}%。

| 指标 | B0 | C最新 | N最终 |
| --- | --- | --- | --- |
${metricRows.map(([k, fn]) => `| ${k} | ${f(fn(B0))} | ${f(fn(C))} | ${f(fn(N))} |`).join('\n')}

取舍vs C=${result.tradeoffs_vs_C.join('、')}，vs B0=${result.tradeoffs_vs_B0.join('、')}。底线始终锚定B0：≥2=${result.recognition_floor.target_ge2}、≥3=${result.recognition_floor.target_ge3}，达标且严格胜最新C才替换。无预测4时条件可靠性NOT_ASSESSED。

## 实际分解与区分证据

同一${C.snapshot_count} Snapshot/${C.event_count} Event/${C.date_count}日期，原TRAIN362/VALIDATION198/TEST95继续复用开发，不称独立TEST或Raw全部1277条。共享engine实际执行采集太阳项、日落插值节点/有效0、半开距离分带、可用项及真实分子/分母、云幕对比/中心/距离、bank与spatial回落、dataFactor、诊断distanceReliability、光照原值/动态贡献，以及P/Q和全部后续阶段、F_sky/F_gw。开关逐条分数/等级完全一致，子项/贡献/最终守恒容差1e-8。distanceReliability没有额外乘入。

| C分组 | Snapshot/Event | solarAngle均值 | bankScore均值 | spatialCompat均值 | dataFactor均值 | illumination均值 | 分带/云幕回落数 | 有效对比≤0/缺失 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${r.stage_summary.groups.slice(0, 8).map(g => `| ${g.group} | ${g.snapshot_count}/${g.event_count} | ${['solar_angle', 'bank_score', 'spatial_compat', 'data_factor', 'illumination'].map(k => f(g.distributions[k].conditional_weighted_mean)).join(' | ')} | ${g.spatial_fallback.snapshot_count}/${g.bank_fallback.snapshot_count} | ${g.contrast_nonpositive_valid.snapshot_count}/${g.contrast_missing.snapshot_count} |`).join('\n')}

光照是太阳项乘以两个云评分的混合再乘dataFactor，云评分本身低就不能只归因于太阳。各项p10/p50/p90、全池贡献/分母、漏报预测0/1/2及50–59等分段、天气型/提前量和缺测支持见illumination_summary。漏报vs全部低等级加权两两排序一致率=${JSON.stringify(r.stage_summary.separation)}；它检查分布重叠，不能只用均值证明区分能力或因果。对比有效≤0代表中心不比两侧突出，不能冒称缺失或认定均匀云场不可能出现好晚霞。

共享依赖：高中云评分进入bank与spatial；bank同时进入skyCanvas和illumination。相关和共享输入不等于已证明重复扣分。contrastBonusMax在正值正常路径先乘后除抵消，未作为有效参数；未改变共享云幕权重、距离/可信度或高中云曲线。

## 冻结入口、真实试验及代价

计划=${r.target_plan.diagnostic_status}，活跃=${r.target_plan.selected.map(p => p.parameter_id).join('、') || '无'}，非活跃=${JSON.stringify(r.target_plan.inactive)}。入口只按真实漏报子项在冻结初探值的可改变性安排试验，不伪造最终分数。有作用的两个内部入口全部初探，单点只改一个；只细化一个参数8内点。

| 参数 | 默认/范围 | 冻结初探值 | 可影响漏报/低等级数 |
| --- | --- | --- | --- |
${r.target_plan.selected.map(p => `| ${p.canonical_path} | ${p.default_value}/${JSON.stringify(p.range)} | ${JSON.stringify(p.probe_values)} | ${p.evidence.high_missed_snapshot_ids.length}/${p.evidence.low_control_snapshot_ids.length} |`).join('\n')}

${search.budget.evaluated_unique}唯一配置（含C不含B0），ERROR=${search.budget.errors}，细化=${r.refinement_plan.status}，参数=${r.refinement_plan.parameter_id}，值=${JSON.stringify(r.refinement_plan.values)}；至多17点，结束即停止。同效完整预测组=${JSON.stringify(result.same_prediction_groups)}，网格精度不代表精确物理常数。

| 参数/值 | 损失 | ≥2召回 | ≥3召回 | MAE | Bias | 高估/低估≥2级 | 等级变化数 | 累计底线 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${r.search_records.map(c => `| ${JSON.stringify(c.parameters)} | ${f(c.metrics?.product_loss)} | ${f(c.metrics?.target_ge2.recall)} | ${f(c.metrics?.target_ge3.recall)} | ${f(c.metrics?.mae)} | ${f(c.metrics?.bias)} | ${f(c.metrics?.overprediction_ge2)}/${f(c.metrics?.underprediction_ge2)} | ${c.all_grade_changes?.length ?? 'ERROR'} | ${meetsHighCloudRecognition(c, B0)} |`).join('\n')}

${[['最终', r.selected], ['净找回最多的代价对照', most]].map(([label, c]) => `### ${label}：${JSON.stringify(c.parameters)}

损失=${c.metrics.product_loss}，≥2/≥3召回=${c.metrics.target_ge2.recall}/${c.metrics.target_ge3.recall}，MAE=${c.metrics.mae}，Bias=${c.metrics.bias}，高估/低估≥2级=${c.metrics.overprediction_ge2}/${c.metrics.underprediction_ge2}，预测4=${c.metrics.predicted4_support.snapshot_count}。

| C→候选迁移 | Snapshot | 去重Event | 全池加权量 |
| --- | --- | --- | --- |
${MIGRATION_KEYS.map(k => `| ${k} | ${c.paired_migrations[k].snapshot_count} | ${c.paired_migrations[k].event_count} | ${c.paired_migrations[k].weighted_amount} |`).join('\n')}

新增≥3误报按实际0/1/2=${JSON.stringify(c.paired_migrations.new_false_alarms_by_actual)}；净找回=${c.paired_migrations.net_recovered_weight}，GT≥3支持=${c.paired_migrations.gt_ge3_weighted_support}，净找回/支持与召回变化=${c.paired_migrations.recall_ge3_delta_from_net}/${c.paired_migrations.recall_ge3_delta}。全部等级变化=${JSON.stringify(c.all_grade_changes)}。
`).join('\n')}

所有候选的完整等级变化保存all_grade_changes.json；不能用无新增≥3误报掩盖一级高估。迁移保持全池Event内分权，Event可跨行不可相加，不在子集重新归一化。每点完整Replay，其他四组件、动态权重、Q、门控、扣分/结构与过渡加分、天空状态/F_sky/F_gw和共享云幕/空间评分必须一致；只允许illumination、P及其后分数随参数变化。失败整点ERROR不删行。

## 默认兼容、复算、交付与停止

生产/Replay调用共享公式；旧字段缺失仍执行0.5/35，合法bankShare=0保留，旧C不补写。固定最新权重/高中云/黄金窗口floor=${r.spec.baseline_config.goldenWindow.floor}/大气质量/arrival斜率。源码和指纹改变，受限字节Hash及B0/C全池逐样本/指标默认复现证据见baseline_reproduction；V1–V5依原策略可读可复算，不宣称同历史环境。计划/Trace/汇总绑定Run，恢复仅复用相同spec与冻结初探/细化；输入和旧包不覆盖。

发布前新进程及单独verify仅重算B0/C/N（同配置去重）及C/N各全池光照Trace、分数还原、非目标一致、迁移与选择，其他候选从冻结结果校核，不重复搜索。[最终配置](selected_effective_config.json)、[C回退](rollback_config.json)、[原始B0](original_control_config.json)已导出；baseline/rollback=C。

本轮计划完成并停止，未部署。${result.selection_status === 'KEEP_CONTROL' ? '本次内部参数范围未提供可接受收益，保留C；不能据此宣称模型无解，也不能仅凭共享输入判定重复扣分。' : '导出改进配置供后续决定试用，识别收益与损失改善分开裁决，完整保留代价。'} 不自动改共享bank或云曲线、不追加扫描。若后续考虑云幕规则，唯一最小候选是验证对比项与产品目标的关系：保持中心/距离输入，单独检查有效负/零对比支持，在同池同时核对skyCanvas和illumination及低等级误报；该后续改变不在本期实施。
`;
}
const api = createTargetedWorkflow({ policy: ILLUMINATION_POLICY, calculator: illuminationCalculator, loadParent: loadIlluminationParent, reproduce,
  collect: collectIlluminationTraces, summarize: summarizeIllumination, buildPlan: buildIlluminationPlan, install: installIllumination,
  candidate: illuminationCandidate, refine: refineIllumination, search: searchIllumination, select: selectIllumination, renderReport, validateAdditional,
  traceFileName: 'illumination_traces.jsonl',
  evaluateExtra: async ({ rows, config, calculator, currentTraces, scores }) => { const next = await collectIlluminationTraces(rows, config, scores, calculator), light = next.map(illuminationLight);
    return { illumination_rows: light, coupling: assertIlluminationCoupling(currentTraces.map(illuminationLight), light), all_grade_changes: allGradeChanges(rows, currentTraces.map(t => t.predicted_score), scores) }; },
  extendRequest: async (r, { rows, calculator }) => ({ selected_illumination_traces: await collectIlluminationTraces(rows, r.selected_effective_config, r.selected.scores, calculator) }),
  verifyAdditional: async (r, { rows, calculator }) => { const traces = await collectIlluminationTraces(rows, r.selected_effective_config, r.selected.scores, calculator);
    if (digest(traces) !== digest(r.selected_illumination_traces)) fail('ILLUMINATION_SELECTED_TRACE_RECOMPUTE_MISMATCH'); },
  outputFiles: r => ({ 'illumination_summary.json': r.stage_summary, 'illumination_plan.json': r.target_plan, 'selected_illumination_traces.json': r.selected_illumination_traces,
    'illumination_coupling_audit.json': r.search_records.map(c => ({ candidate_id: c.candidate_id, status: c.status, coupling: c.coupling ?? null })),
    'all_grade_changes.json': r.search_records.filter(c => c.status === 'EVALUATED').map(c => ({ candidate_id: c.candidate_id, parameters: c.parameters, changes: c.all_grade_changes })) }),
  nextAction: r => ({ action: r.phase7_result.selection_status === 'KEEP_CONTROL' ? 'BOUNDED_INTERNAL_RANGE_HAS_NO_ACCEPTABLE_GAIN; REVIEW_CONTRAST_WITH_BOTH_COMPONENTS_IF_AUTHORIZED' : 'REVIEW_EXPORTED_CONFIGURATION_FOR_POSSIBLE_TRIAL', automatic_next_run: false }) });
export const { runMechanism: runIllumination, inspectMechanism: inspectIllumination, verifyMechanism: verifyIllumination, verifyMechanismRequest: verifyIlluminationRequest } = api;
