import { assertCompatibleEngine } from './engine-compatibility.mjs';
import path from 'node:path';
import { mkdir, readdir, rename, writeFile, appendFile, unlink, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSafe, safePath, within, fail, hash, inventory, canonicalJson, errorCode } from '../dataset/lib/common.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { digest, POLICY, q } from './policy.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { replayCalculator, preflight, evaluateConfig, constantComparisons } from './compute.mjs';
import { inspectPractical, acquireRunLock, atomicJson, csv } from './workflow.mjs';
import * as high from './high-cloud.mjs';

// Shared two-parameter cloud run lifecycle; versioned policies and parent semantics stay in adapters.
export function createCloudWorkflow(adapter) {
const { H, parametersOf, installHighCloud, withoutHighCloud, highCloudCandidate, searchHighCloud, rankHighCloud, selectHighCloud, highCloudMetrics, meetsHighCloudRecognition, recognitionFloor } = adapter;
const version = H.practical_tuning_schema_version;
const exec = promisify(execFile), json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const compact = record => { if (adapter.keepScores) return record; const { scores, ...rest } = record; return rest; };
const highCodeIdentity = async () => ({ ...await codeIdentity(), policy_sha256: digest(H) });
function assertRecordBindings(request, originalMetrics, baselineMetrics) {
  const { spec } = request, context = { baseline: spec.baseline_config, original: spec.original_control_config, engine_sha256: spec.code.engine_sha256 };
  const baselineId = highCloudCandidate(parametersOf(spec.baseline_config), context).candidate_id;
  const baseline = request.search_records.find(r => r.candidate_id === baselineId), selected = request.search_records.find(r => r.candidate_id === request.selected.candidate_id);
  if (!baseline || baseline.status !== 'EVALUATED' || digest(baseline.metrics) !== digest(baselineMetrics) ||
      !selected || digest(selected) !== digest(compact(request.selected)) ||
      new Set(request.search_records.map(r => r.candidate_id)).size !== request.search_records.length) fail('HIGH_CLOUD_RECORD_BINDING_MISMATCH');
  for (const r of request.search_records) {
    const c = highCloudCandidate(r.parameters, context);
    if (c.candidate_id !== r.candidate_id || c.parameter_distance !== r.parameter_distance) fail('HIGH_CLOUD_CANDIDATE_ID_MISMATCH');
  }
  if (adapter.validateRecords) adapter.validateRecords(request);
  if (digest(selectHighCloud(request.search_records, baselineId, originalMetrics)) !== digest(request.phase7_result)) fail('FINAL_SELECTION_MISMATCH');
}

async function loadHighCloudParent(directory) {
  if (adapter.loadParent) return adapter.loadParent(directory);
  if (!directory) fail('BASELINE_RUN_REQUIRED');
  const root = await safePath(directory), bytes = await readSafe(path.join(root, 'manifest.json')), m = JSON.parse(bytes);
  if (m.practical_tuning_schema_version !== 1 || m.practical_tuning_policy_version !== 1) fail('HIGH_CLOUD_PARENT_MUST_BE_WEIGHT_RUN_V1');
  const parent = await inspectPractical(root);
  if (parent.result.selection_mode !== 'RECOGNITION_FIRST') fail('HIGH_CLOUD_PARENT_MUST_BE_RECOGNITION_FIRST');
  const original = await json(path.join(root, 'rollback_config.json')), baseline = await json(path.join(root, 'selected_effective_config.json'));
  const request = await json(path.join(root, 'verification_request.json'));
  const pool = await json(path.join(root, 'pool_manifest.json')), exclusions = await json(path.join(root, 'exclusions.json'));
  if (baseline.highCloudCenter !== 60 || baseline.highCloudWidth !== 25) fail('HIGH_CLOUD_BASELINE_PARAMETERS_DIFFER', { detail: parametersOf(baseline) });
  const { weights: ignored0, ...rest0 } = original, { weights: ignored1, ...rest1 } = baseline;
  if (digest(rest0) !== digest(rest1)) fail('PARENT_CHANGED_NON_WEIGHT_CONFIG');
  return { root, original, baseline, pool, exclusions, request, spec: parent.spec,
    reference: { run_id: m.run_id, manifest_sha256: hash(bytes), candidate_id: parent.result.selected_candidate,
      original_config_sha256: digest(original), baseline_config_sha256: digest(baseline),
      members_sha256: digest(pool.included), inputs_sha256: digest(parent.spec.identity.inputs),
      engine_sha256: parent.spec.code.engine_sha256 } };
}
async function reproduceHighCloudBaselines(loaded, parent, code, calculator, progress = () => {}) {
  if (adapter.reproduce) return adapter.reproduce(loaded, parent, code, calculator, progress);
  const engineCompatibility = assertCompatibleEngine(code, parent.spec.code, { allowDefaultCompatibility: true, reason: 'PARENT_ENGINE_DIFFERS' });
  if (digest(loaded.fingerprints) !== digest(parent.spec.identity.inputs) || digest(loaded.source_ids) !== digest(parent.pool.source_ids)) fail('PARENT_INPUT_FILES_DIFFER');
  const checked = await preflight(loaded, parent.original, calculator, progress);
  if (digest(checked.included) !== digest(parent.pool.included) || digest(checked.exclusions) !== digest(parent.exclusions)) fail('PARENT_COHORT_OR_B0_SCORES_DIFFER',
    { detail: { parent_count: parent.pool.included.length, current_count: checked.rows.length,
      differing_members: checked.included.filter((r, i) => digest(r) !== digest(parent.pool.included[i])).slice(0, 5).map(r => r.snapshot_id) } });
  const B0 = await evaluateConfig(checked.rows, parent.original, calculator), B1 = await evaluateConfig(checked.rows, parent.baseline, calculator);
  for (const [role, actual, expected, expectedScores] of [['B0', B0, parent.request.control, parent.request.control_predictions],
    ['B1', B1, parent.request.selected, parent.request.selected_predictions]]) {
    if (actual.predictions_sha256 !== expected.predictions_sha256 || digest(actual.scores) !== digest(expectedScores) || digest(actual.metrics) !== digest(expected.metrics))
      fail('PARENT_BASELINE_REPRODUCTION_MISMATCH', { detail: { role, actual_loss: actual.metrics.product_loss,
        expected_loss: expected.metrics.product_loss, differing_scores: actual.scores.map((v, i) => v === expectedScores[i] ? null : checked.rows[i].snapshot_id).filter(Boolean).slice(0, 10) } });
  }
  return { checked, B0: { ...B0, metrics: highCloudMetrics(checked.rows, B0.scores) }, B1: { ...B1, metrics: highCloudMetrics(checked.rows, B1.scores) },
    audit: { status: 'PASS', member_count: checked.rows.length, B0_predictions_sha256: B0.predictions_sha256,
      B1_predictions_sha256: B1.predictions_sha256, old_metrics_exactly_reproduced: true, engine_compatibility: engineCompatibility,
      engine_sha256: code.engine_sha256, parent_tool_sha256: parent.spec.code.sha256, current_tool_sha256: code.sha256,
      mode: engineCompatibility.mode === 'IDENTICAL_ENGINE' ? 'CURRENT_TOOLS_SAME_ENGINE_EXACT_PARENT_PREDICTIONS_AND_METRICS' : 'PINNED_DEFAULT_COMPATIBLE_ENGINE_EXACT_PARENT_PREDICTIONS_AND_METRICS' } };
}
async function evaluateHigh(rows, config, calculator) { const result = await evaluateConfig(rows, config, calculator); return { ...result, metrics: highCloudMetrics(rows, result.scores) }; }
function highSlices(rows, B0, B1, selected) {
  return ['event_date_local', 'city', 'lead_time_bucket', 'regime_label', 'scheduled_slot'].flatMap(dimension =>
    [...new Set(rows.map(r => r[dimension] ?? null))].sort().map(value => {
      const indices = rows.flatMap((r, i) => (r[dimension] ?? null) === value ? [i] : []), subset = indices.map(i => rows[i]);
      return { dimension, value, B0: highCloudMetrics(subset, indices.map(i => B0.scores[i])),
        B1: highCloudMetrics(subset, indices.map(i => B1.scores[i])), B2: highCloudMetrics(subset, indices.map(i => selected.scores[i])) };
    }));
}
function renderReport(spec, result, search, anchors, selected, constants) {
  const b0 = anchors.B0.metrics, b1 = anchors.B1.metrics, b2 = selected.metrics, f = n => n == null ? '未评估' : String(Number(n.toFixed(6)));
  const records = search.records, lowest = records.find(r => r.candidate_id === result.lowest_loss_candidate), highest = records.find(r => r.candidate_id === result.highest_ge3_recall_with_ge2_floor);
  const metrics = [['产品损失', r => r.product_loss], ['MAE', r => r.mae], ['Bias', r => r.bias], ['QWK', r => r.qwk],
    ['≥2召回', r => r.target_ge2.recall], ['≥3召回', r => r.target_ge3.recall], ['≥2精确率', r => r.target_ge2.precision], ['≥3精确率', r => r.target_ge3.precision],
    ['高估至少2级', r => r.overprediction_ge2], ['低估至少2级', r => r.underprediction_ge2], ['4→0/1整体比例', r => r.critical_overprediction.rate],
    ['4→0/1条件比例', r => r.critical_overprediction.conditional_on_predicted4], ['4→2整体比例', r => r.predicted4_actual2.rate],
    ['预测4样本数', r => r.predicted4_support.snapshot_count]];
  const cloud = version === 3 ? '中云' : '高云';
  return `# ${version === 3 ? 'V2.5.4.11' : 'V2.5.4.10'} 识别优先${cloud}调优与 Phase 7\n\n**Phase 7 已完成：${result.selection_status}。** ${result.selection_status === 'KEEP_CONTROL' ? '没有达标且损失低于 B1 的候选，保留 B1。' : `选中满足累计召回底线且优于 B1 的${cloud}配置。`}\n\n重点风险：预测4、实际0/1=${b2.critical_overprediction.snapshot_count}条，整体比例=${f(b2.critical_overprediction.rate)}；预测4状态=${b2.grade4_status}，${b2.predicted4_support.snapshot_count}条，条件比例=${f(b2.critical_overprediction.conditional_on_predicted4)}。${b2.predicted4_support.snapshot_count ? '' : 'PREDICTION_4_NOT_ASSESSED；不能据零预测4宣称可靠性已验证。'}\n\n## 本轮与累计效果\n\nB0=沿用父Run的原始锚点；B1=父Run选中权重基准；B2=本轮最终配置（KEEP_CONTROL时即B1）。固定≥2召回底线=${f(result.recognition_floor.target_ge2)}，≥3=${f(result.recognition_floor.target_ge3)}，每轮不重置累计容忍带。\n\n| 指标 | B0原始 | B1本轮基准 | B2最终 |\n| --- | --- | --- | --- |\n${metrics.map(([name, get]) => `| ${name} | ${f(get(b0))} | ${f(get(b1))} | ${f(get(b2))} |`).join('\n')}\n\n本轮产品损失差值=${f(result.metrics_vs_baseline.delta_product_loss)}，相对B1改善=${f((b1.product_loss - b2.product_loss) / b1.product_loss * 100)}%；相对B0累计差值=${f(result.metrics_vs_original.delta_product_loss)}，累计改善=${f((b0.product_loss - b2.product_loss) / b0.product_loss * 100)}%。\n\n相对B1取舍：${result.tradeoffs_vs_B1.join('、') || '无报告退化'}。相对B0：${result.tradeoffs_vs_B0.join('、') || '无报告退化'}。召回底线只防止退步，不承诺本轮提升≥3召回。\n\n## 参数、试用及回退\n\n${cloud}中心 ${spec.baseline_config[H.canonical_paths[0]]} → ${selected.parameters[H.parameter_id[0]]}；${cloud}宽度 ${spec.baseline_config[H.canonical_paths[1]]} → ${selected.parameters[H.parameter_id[1]]}。它们是${cloud}覆盖率评分曲线的中心和宽度，不是云高度或时间窗口。只改评分根 ${H.canonical_paths.join("/")}，走廊同名字段、五项基础权重、天气型动态逻辑及其他配置完全保留B1。\n\n基础权重=${JSON.stringify(spec.baseline_config.weights)}。weather基础值为0仍执行动态下限0.05与整体归一化，该下限不是最终固定5%占比。\n\n完整试用配置：[selected_effective_config.json](selected_effective_config.json)。回退本轮使用 [rollback_config.json](rollback_config.json)，内容=B1，与 [baseline_config.json](baseline_config.json) 相同。B0另存 [original_control_config.json](original_control_config.json)，不把任何一份配置自动称为当前线上配置。${result.selection_status === 'KEEP_CONTROL' ? '建议继续使用B1，本轮范围结束。' : '可作有限试用，观察自然新样本中的高估、漏报与3/4级表现。'} 不自动上线，不要求新增观测时间字段或补齐旧Phase8。\n\n## 候选及代价\n\n本次${search.budget.evaluated_unique}/${search.budget.maximum}唯一组合，ERROR=${search.budget.errors}，去重=${search.budget.duplicates}，非法=${search.budget.invalid}；${search.budget.termination}，未穷尽连续空间。先42点粗网格，再前2父节点±2/±1邻域；父节点优先累计召回达标，未达标点保留完整分母，不自动扩搜。\n\n| 候选 | 中心/宽度 | 达累计底线 | 损失 | ≥2召回 | ≥3召回 |\n| --- | --- | --- | --- | --- | --- |\n${rankHighCloud(records, b0).slice(0, 5).map(r => `| ${r.candidate_id} | ${r.parameters[H.parameter_id[0]]}/${r.parameters[H.parameter_id[1]]} | ${meetsHighCloudRecognition(r, b0)} | ${f(r.metrics.product_loss)} | ${f(r.metrics.target_ge2.recall)} | ${f(r.metrics.target_ge3.recall)} |`).join('\n')}\n\n不加召回条件的最低损失点=${lowest.candidate_id}，参数=${JSON.stringify(lowest.parameters)}，损失=${f(lowest.metrics.product_loss)}，≥2/≥3召回=${f(lowest.metrics.target_ge2.recall)}/${f(lowest.metrics.target_ge3.recall)}，是否选中=${lowest.candidate_id === selected.candidate_id}。未选中时不隐去漏报代价。\n\n≥2达底线且≥3召回最高的折中点=${highest?.candidate_id ?? '无'}${highest ? `，参数=${JSON.stringify(highest.parameters)}，损失=${f(highest.metrics.product_loss)}，≥2/≥3召回=${f(highest.metrics.target_ge2.recall)}/${f(highest.metrics.target_ge3.recall)}` : ''}。只作对照，不自动替换最终选择。\n\n固定1/固定2/池最优常量损失=${f(constants.fixed1.metrics.product_loss)}/${f(constants.fixed2.metrics.product_loss)}/${f(constants.pool_optimal.metrics.product_loss)}，只作参照。\n\n## 数据、分组及复算\n\n父Run=${spec.parent.run_id}，父候选=${spec.parent.candidate_id}，成员Hash=${spec.parent.members_sha256}。655为指定真实池；本次实际=${b2.snapshot_count}Snapshot/${b2.event_count}Event/${b2.date_count}日期。成员、标签和Event confidence分权精确复用父Run，不因预测较差删行。原分区已作开发使用，REUSED_DEVELOPMENT_DATA，independent_validation=false，不称独立测试。\n\n${b2.grades.map(g => `等级${g.ordinal}：${g.event_count}Event/${g.date_count}日期/${g.snapshot_count}Snapshot`).join('；')}。实际和预测等级支持、计数/加权5×5矩阵见三方comparison.json，各候选完整矩阵见search_audit.json；日期/城市/提前量/天气型/采集时段配对指标见slices.json，分组不增资格门槛。\n\n预检精确复现父Run B0/B1分数、等级和旧指标；发布前新进程只复算B0/B1/最终选择（同配置去重），逐样本与汇总一致；未重复整个搜索。原输入与历史Run不覆写。工具Hash=${spec.code.sha256}，引擎Hash=${spec.code.engine_sha256}，策略Hash=${spec.identity.policy_sha256}。工作树修改状态=${spec.code.git.dirty ?? '未知'}。\n`;
}
async function runHighCloud(options, progress = () => {}) {
  const maxCandidates = options.maxCandidates ?? H.budget;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > H.budget) fail('INVALID_CANDIDATE_BUDGET');
  const parent = await loadHighCloudParent(options.baselineRun), loaded = await loadPool(options, progress), code = await highCodeIdentity();
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const root of Object.values(loaded.roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  if (within(parent.root, output)) fail('OUTPUT_OVERLAPS_PARENT_RUN');
  const calculator = replayCalculator(code.engine_sha256);
  progress('复现父Run固定成员及B0/B1基准，不允许缩小样本');
  const anchors = await reproduceHighCloudBaselines(loaded, parent, code, calculator, progress), rows = anchors.checked.rows;
  const identity = { schema: version, policy: H, policy_sha256: digest(H), search_space: H.search_space, parent: parent.reference,
    inputs: loaded.fingerprints, original_config_sha256: digest(parent.original), baseline_config_sha256: digest(parent.baseline),
    pool_sha256: digest(parent.pool), code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version,
    recognition_floor: recognitionFloor(anchors.B0.metrics),
    search_plan: { coarse_centers: H.coarse_centers, coarse_widths: H.coarse_widths, local_steps: H.local_steps, local_parents: 2, max_candidates: maxCandidates,
      proposal_order: 'B1_THEN_CENTER_ASC_WIDTH_ASC_THEN_RANKED_TWO_PARENTS_CENTER_OFFSET_ASC_WIDTH_OFFSET_ASC' } };
  const runId = `practical_tuning_v${version}_${digest(identity).slice(0, 20)}`, target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true }); await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const old = await inspectHighCloud(target); return { ...old.result, directory: target, run_id: runId, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(path.join(work, 'candidates'), { recursive: true });
    const spec = { practical_tuning_schema_version: version, practical_tuning_policy_version: version, run_id: runId, identity, code,
      parent: parent.reference, parent_directory: parent.root, sources: loaded.roots, original_control_config: parent.original, baseline_config: parent.baseline,
      created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) { const old = await json(path.join(work, 'run_spec.json')); if (digest(old.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = old.created_at_utc; }
    await atomicJson(path.join(work, 'run_spec.json'), spec); await atomicJson(path.join(work, 'state.json'), { status: 'SEARCHING', phase7_completed: false, run_id: runId });
    progress(`B0/B1复现PASS；运行 ${runId}，固定${rows.length}条样本，累计召回底线=${JSON.stringify(identity.recognition_floor)}`);
    const restored = []; for (const name of await readdir(path.join(work, 'candidates'))) if (name.endsWith('.json')) restored.push(await json(path.join(work, 'candidates', name)));
    const search = await searchHighCloud({ baseline: parent.baseline, original: parent.original, engine_sha256: code.engine_sha256,
      originalMetrics: anchors.B0.metrics, restored, maxCandidates, evaluate: async c => { const value = await evaluateHigh(rows, installHighCloud(parent.baseline, c.parameters), calculator);
        return { ...value, ...(adapter.migrations ? { paired_migrations: adapter.migrations(rows, anchors.B1.scores, value.scores) } : {}) }; },
      save: r => atomicJson(path.join(work, 'candidates', `${r.candidate_id}.json`), r), progress: p => { if (p.count === 1 || p.count % 5 === 0)
        progress(`已评估${p.count}；${p.stage}；识别优先最优损失=${p.best_loss}；达累计底线=${p.best_meets_floor}`); } });
    const result = selectHighCloud(search.records, search.baseline_id, anchors.B0.metrics), selected = search.records.find(r => r.candidate_id === result.selected_candidate);
    const selectedConfig = installHighCloud(parent.baseline, selected.parameters);
    const request = { spec, pool: parent.pool, exclusions: parent.exclusions, B0: anchors.B0, B1: anchors.B1, selected,
      selected_effective_config: selectedConfig, phase7_result: result, search_records: search.records.map(compact) };
    await atomicJson(path.join(work, 'verification_request.json'), request); await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', phase7_completed: false, run_id: runId });
    progress('搜索结束；新进程只复算B0/B1/最终选择，相同配置去重');
    const proof = await highCloudWorker(path.join(work, 'verification_request.json'));
    const slices = highSlices(rows, anchors.B0, anchors.B1, selected), constants = constantComparisons(rows);
    const center = search.records.find(r => r.status === 'EVALUATED' && r.parameters[H.parameter_id[0]] === H.coarse_centers[0] && r.parameters[H.parameter_id[1]] === 25);
    const width = search.records.find(r => r.status === 'EVALUATED' && r.parameters[H.parameter_id[0]] === parametersOf(parent.baseline)[H.parameter_id[0]] && r.parameters[H.parameter_id[1]] === 15);
    const wiring = { canonical_paths: H.canonical_paths, non_target_config_sha256: digest(withoutHighCloud(parent.baseline)), weights_unchanged: true, corridor_unchanged: true,
      center_changed_snapshots: center ? center.scores.filter((s, i) => s !== anchors.B1.scores[i]).length : null,
      width_changed_snapshots: width ? width.scores.filter((s, i) => s !== anchors.B1.scores[i]).length : null,
      assessment: 'OBSERVED_GRID_COMPARISONS_NO_ADDITIONAL_SEARCH_PROBES', examples: [] };
    for (const row of [...new Map(rows.map(r => [r.regime_label, r])).values()].slice(0, 3)) wiring.examples.push({ snapshot_id: row.snapshot_id,
      B1: await calculator.calculate(row, parent.baseline, true), B2: await calculator.calculate(row, selectedConfig, true) });
    const files = { 'pool_manifest.json': parent.pool, 'exclusions.json': parent.exclusions, 'baseline_config.json': parent.baseline,
      'original_control_config.json': parent.original, 'rollback_config.json': parent.baseline, 'selected_effective_config.json': selectedConfig,
      'selected_candidate.json': compact(selected), 'top_candidates.json': rankHighCloud(search.records, anchors.B0.metrics).slice(0, 5).map(compact),
      'phase7_result.json': result, 'comparison.json': { B0: anchors.B0.metrics, B1: anchors.B1.metrics, B2: selected.metrics },
      'search_audit.json': { budget: search.budget, proposals: search.audit, records: search.records.map(compact) }, 'slices.json': slices,
      'baseline_reproduction.json': anchors.audit, 'constant_baselines.json': constants, 'verification.json': proof, 'wiring_audit.json': wiring, 'cache_statistics.json': calculator.stats(), ...(adapter.outputFiles ? adapter.outputFiles(request) : {}) };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    await writeFile(path.join(work, 'candidate_metrics.csv'), csv(search.records.map(r => ({ candidate_id: r.candidate_id, stage: r.stage, status: r.status,
      ...r.parameters, meets_cumulative_floor: meetsHighCloudRecognition(r, anchors.B0.metrics), product_loss: r.metrics?.product_loss ?? null,
      delta_vs_B1: r.metrics ? q(r.metrics.product_loss - anchors.B1.metrics.product_loss) : null, delta_vs_B0: r.metrics ? q(r.metrics.product_loss - anchors.B0.metrics.product_loss) : null,
      mae: r.metrics?.mae ?? null, bias: r.metrics?.bias ?? null, qwk: r.metrics?.qwk ?? null,
      recall_ge2: r.metrics?.target_ge2.recall ?? null, precision_ge2: r.metrics?.target_ge2.precision ?? null,
      recall_ge3: r.metrics?.target_ge3.recall ?? null, precision_ge3: r.metrics?.target_ge3.precision ?? null,
      critical_4_to_0_1_rate: r.metrics?.critical_overprediction.rate ?? null, four_to_two_rate: r.metrics?.predicted4_actual2.rate ?? null,
      reason_code: r.reason_code ?? null, ...(adapter.csvFields ? adapter.csvFields(r) : {}) }))));
    await writeFile(path.join(work, 'selected_predictions.csv'), csv(rows.map((r, i) => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, event_date_local: r.event_date_local,
      city: r.city, historical_splits: r.historical_splits.join('|'), gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence, event_normalized_weight: r.event_normalized_weight,
      B0_score: anchors.B0.scores[i], B0_ordinal: scoreToOrdinal(anchors.B0.scores[i]), B1_score: anchors.B1.scores[i], B1_ordinal: scoreToOrdinal(anchors.B1.scores[i]),
      B2_score: selected.scores[i], B2_ordinal: scoreToOrdinal(selected.scores[i]) }))));
    await writeFile(path.join(work, 'report.md'), (renderReport(spec, result, search, anchors, selected, constants) + (adapter.report ? adapter.report(request) : '')).replace(/\r?\n/g, '\r\n'), 'utf8');
    await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    if ((await loadHighCloudParent(parent.root)).reference.manifest_sha256 !== parent.reference.manifest_sha256) fail('PARENT_CHANGED_DURING_RUN');
    const history = path.join(output, 'usage_history.jsonl'), prior = await exists(history) ? (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
    if (!prior.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, search_space: H.search_space, usage: POLICY.usage,
      evaluation_scope: POLICY.evaluation_scope, independent_validation: false, parent_run_id: parent.reference.run_id,
      model: loaded.source_ids.model, historical_partitions: parent.pool.historical_partitions,
      members: parent.pool.included.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, historical_splits: r.historical_splits })), selection_status: result.selection_status }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', phase7_completed: true, run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: version, practical_tuning_policy_version: version, run_id: runId, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { run_id: runId, directory: target, phase7_completed: true, selection_status: result.selection_status,
      selected_candidate: result.selected_candidate, selected_parameters: selected.parameters, delta_product_loss_vs_B1: result.metrics_vs_baseline.delta_product_loss,
      delta_product_loss_vs_B0: result.metrics_vs_original.delta_product_loss, evaluated_candidates: search.budget.evaluated_unique, trial_config_available: true, independent_validation: false };
  } catch (e) { if (await exists(path.join(work, 'run_spec.json'))) await atomicJson(path.join(work, 'state.json'), { status: 'EXECUTION_ERROR', phase7_completed: false, error_code: errorCode(e), run_id: runId }); throw e; }
  finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
async function highCloudWorker(requestFile, compatibleTools = false) {
  let stdout;
  try { ({ stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), requestFile, ...(compatibleTools ? ['--compatible-cloud-tools'] : [])], { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })); }
  catch (e) { let reason; try { reason = JSON.parse(e.stdout.trim()).error_code; } catch {} fail(reason ?? 'HIGH_CLOUD_WORKER_FAILED'); }
  const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH'); return proof;
}
async function verifyHighCloudRequest(request, { compatibleTools = false } = {}) {
  const { spec } = request, code = await highCodeIdentity();
  if ((!compatibleTools && code.sha256 !== spec.code.sha256) || code.node_version !== spec.code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engineCompatibility = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: compatibleTools });
  if (digest(spec.identity.policy) !== digest(H) || spec.identity.policy_sha256 !== digest(H)) fail('HIGH_CLOUD_POLICY_MISMATCH');
  const parent = await loadHighCloudParent(spec.parent_directory);
  if (digest(parent.reference) !== digest(spec.parent) || digest(spec.identity.parent) !== digest(spec.parent) ||
      digest(spec.original_control_config) !== digest(parent.original) || digest(spec.baseline_config) !== digest(parent.baseline)) fail('PARENT_BINDING_MISMATCH');
  const loaded = await loadPool(spec.sources), calculator = replayCalculator(code.engine_sha256);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const anchors = await reproduceHighCloudBaselines(loaded, parent, code, calculator);
  if (digest(parent.pool) !== digest(request.pool) || digest(parent.exclusions) !== digest(request.exclusions)) fail('PRACTICAL_COHORT_MISMATCH');
  const selectedConfig = installHighCloud(parent.baseline, request.selected.parameters);
  if (digest(selectedConfig) !== digest(request.selected_effective_config)) fail('NON_HIGH_CLOUD_CONFIG_CHANGED');
  const selected = await evaluateHigh(anchors.checked.rows, selectedConfig, calculator);
  for (const [actual, expected] of [[anchors.B0, request.B0], [anchors.B1, request.B1], [selected, request.selected]])
    if (digest(actual.scores) !== digest(expected.scores) || actual.predictions_sha256 !== expected.predictions_sha256 || digest(actual.metrics) !== digest(expected.metrics)) fail('FINAL_RECOMPUTE_MISMATCH');
  assertRecordBindings(request, anchors.B0.metrics, anchors.B1.metrics);
  await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
  return { status: 'PASS', engine_compatibility: engineCompatibility, scope: 'FRESH_PROCESS_B0_B1_SELECTED_ONLY', engine_replayed: true,
    recomputed_snapshots: anchors.checked.rows.length, unique_config_count: new Set([digest(parent.original), digest(parent.baseline), digest(selectedConfig)]).size,
    B0_predictions_sha256: anchors.B0.predictions_sha256, B1_predictions_sha256: anchors.B1.predictions_sha256,
    selected_predictions_sha256: selected.predictions_sha256, per_sample_score_and_ordinal_equal: true, metrics_equal: true, cumulative_selection_equal: true,
    ...(adapter.validateRecords ? { paired_migrations_equal: true } : {}),
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: `CURRENT_POLICY${version}_${engineCompatibility.mode}_EXACT_OLD_PREDICTIONS_METRICS_AND_SELECTION`, original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
async function inspectHighCloud(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version !== version || manifest.practical_tuning_policy_version !== version) fail('UNSUPPORTED_PRACTICAL_VERSION');
  const required = ['run_spec.json', 'pool_manifest.json', 'exclusions.json', 'baseline_config.json', 'original_control_config.json', 'rollback_config.json',
    'selected_effective_config.json', 'selected_candidate.json', 'phase7_result.json', 'candidate_metrics.csv', 'top_candidates.json', 'selected_predictions.csv',
    'comparison.json', 'verification_request.json', 'verification.json', 'search_audit.json', 'baseline_reproduction.json', 'report.md'];
  for (const name of required) if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  for (const [name, expected] of Object.entries(manifest.files)) if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'phase7_result.json')), request = await json(path.join(root, 'verification_request.json'));
  const selected = await json(path.join(root, 'selected_candidate.json')), config = await json(path.join(root, 'selected_effective_config.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || manifest.run_id !== `practical_tuning_v${version}_${digest(spec.identity).slice(0, 20)}` || spec.run_id !== manifest.run_id ||
      spec.practical_tuning_schema_version !== version || spec.practical_tuning_policy_version !== version || spec.identity.search_space !== H.search_space ||
      result.practical_tuning_schema_version !== version || result.practical_tuning_policy_version !== version || result.usage !== POLICY.usage || !result.phase7_completed || result.independent_validation !== false) fail('INVALID_PRACTICAL_RESULT');
  if (digest(spec.identity.policy) !== spec.identity.policy_sha256 || spec.identity.policy_sha256 !== digest(H) ||
      spec.code.policy_sha256 !== digest(H) || digest(spec.identity.parent) !== digest(spec.parent)) fail('HIGH_CLOUD_POLICY_MISMATCH');
  if (digest(request.spec) !== digest(spec) || digest(compact(request.selected)) !== digest(selected) || digest(request.phase7_result) !== digest(result) ||
      digest(request.pool) !== digest(await json(path.join(root, 'pool_manifest.json'))) || digest(request.exclusions) !== digest(await json(path.join(root, 'exclusions.json'))) ||
      digest(installHighCloud(spec.baseline_config, selected.parameters)) !== digest(config) || digest(request.selected_effective_config) !== digest(config) ||
      digest(spec.baseline_config) !== digest(await json(path.join(root, 'rollback_config.json'))) || digest(spec.baseline_config) !== digest(await json(path.join(root, 'baseline_config.json'))) ||
      digest(spec.original_control_config) !== digest(await json(path.join(root, 'original_control_config.json'))) || result.selected_candidate !== selected.candidate_id ||
      digest(request.search_records) !== digest((await json(path.join(root, 'search_audit.json'))).records)) fail('PRACTICAL_RESULT_BINDING_MISMATCH');
  if (adapter.outputFiles) for (const [name, value] of Object.entries(adapter.outputFiles(request))) {
    if (!manifest.files[name]) fail('PRACTICAL_OUTPUT_MISSING');
    if (digest(await json(path.join(root, name))) !== digest(value)) fail('PRACTICAL_RESULT_BINDING_MISMATCH');
  }
  assertRecordBindings(request, request.B0.metrics, request.B1.metrics);
  if (digest((await json(path.join(root, 'comparison.json')))) !== digest({ B0: request.B0.metrics, B1: request.B1.metrics, B2: selected.metrics })) fail('INVALID_HIGH_CLOUD_SELECTION');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
async function verifyHighCloud(directory) {
  const inspected = await inspectHighCloud(directory), proof = await highCloudWorker(path.join(directory, 'verification_request.json'), true);
  return { ...proof, run_id: inspected.manifest.run_id, phase7_completed: true };
}

return { runHighCloud, loadHighCloudParent, reproduceHighCloudBaselines, highCloudWorker, verifyHighCloudRequest, inspectHighCloud, verifyHighCloud };
}

export const { runHighCloud, loadHighCloudParent, reproduceHighCloudBaselines, highCloudWorker, verifyHighCloudRequest, inspectHighCloud, verifyHighCloud } = createCloudWorkflow({ ...high, H: high.HIGH_CLOUD_POLICY });
