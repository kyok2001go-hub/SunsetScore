import path from 'node:path';
import { mkdir, writeFile, rename, readdir, appendFile, rmdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../dataset/lib/common.mjs';
import { loadFrozenBaseConfig } from '../tuning/lib/base-config.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { POLICY, digest, normalizeWeights, installWeights, withoutWeights, rank, selectPhase7, MEMBERS, RECOGNITION_POLICY, rankRecognition } from './policy.mjs';
import { APP_ROOT, loadPool, codeIdentity, checkInputs } from './data.mjs';
import { replayCalculator, preflight, wiringCheck, evaluateWeights, constantComparisons, sliceComparisons } from './compute.mjs';
import { searchWeights } from './search.mjs';
const exec = promisify(execFile);
const json = async file => JSON.parse(await readSafe(file));
const exists = async file => { try { await readSafe(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export async function acquireRunLock(lock, resume) {
  try { await mkdir(lock); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (!resume) fail('PRACTICAL_RUN_ACTIVE_LOCK', { detail: lock });
    const recovery = `${lock}.recovery`;
    try { await mkdir(recovery); } catch { fail('PRACTICAL_RUN_ACTIVE_LOCK', { detail: lock }); }
    try {
      const owner = await json(path.join(lock, 'owner.json'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('PRACTICAL_LOCK_OWNER_UNKNOWN');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; }
      if (!dead) fail('PRACTICAL_RUN_ACTIVE_LOCK', { detail: lock });
      // Recover only a positively exited process; no age/timeout heuristic.
      await unlink(path.join(lock, 'owner.json')); await rmdir(lock); await mkdir(lock);
    } finally { await rmdir(recovery); }
  }
  await writeFile(path.join(lock, 'owner.json'), canonicalJson({ pid: process.pid }), { flag: 'wx' });
}
export async function atomicJson(file, value) { const temp = `${file}.tmp`; await writeFile(temp, canonicalJson(value), 'utf8'); await rename(temp, file); }
export const csv = rows => {
  if (!rows.length) return '\uFEFF\r\n';
  const keys = Object.keys(rows[0]), cell = v => v == null ? '' : /[,"\r\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
  return '\uFEFF' + [keys.join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n') + '\r\n';
};
const compact = ({ scores, ...r }) => r;
function report(spec, pool, search, result, selected, nearest, constants, slices) {
  const m = result.metrics_vs_control, c = m.control, s = m.selected, f = n => n == null ? '未评估' : Number(n.toFixed(6));
  const improvement = c.product_loss ? (c.product_loss - s.product_loss) / c.product_loss * 100 : 0;
  const risk = result.critical_risk;
  const best = (result.recognition_policy ? rankRecognition(search.records, search.records.find(r => r.candidate_id === result.control_candidate)) : rank(search.records)).slice(0, 5);
  return `# V2.5.4.9 轻量权重调优与 Phase 7\n\n**Phase 7 已完成：${result.selection_status}。** ${result.selection_status === 'KEEP_CONTROL' ? '本次搜索没有严格降低产品损失，保留 Control。' : '已选出新权重，导出完整配置供试用。'}\n\n**重点风险：预测 4、实际 0/1 共 ${risk.snapshot_count} 条，整体比例 ${f(risk.rate)}，预测 4 内条件比例 ${f(risk.conditional_on_predicted4)}。** 预测 4：${s.grade4_status}，${s.predicted4_support.snapshot_count} 条。${result.tradeoffs.length ? `取舍/未验证项：${result.tradeoffs.join('、')}。` : '未观察到所列指标退化。'}\n\n## 参数及结论\n\n仅调整 component_weights。基础权重会再次受天气型乘数、强度及 weather 下限调整，实际动态权重见 wiring_audit.json；其余配置、公式和 20/40/60/90 阈值保持 Control。\n\n| 成员 | Control | 选中 | 变化 |\n| --- | --- | --- | --- |\n${MEMBERS.map(k => `| ${k} | ${f(spec.control_config.weights[k])} | ${f(selected.weights[k])} | ${f(selected.weights[k] - spec.control_config.weights[k])} |`).join('\n')}\n\n产品损失改善 ${f(improvement)}%，绝对差 ${f(m.delta_product_loss)}。${result.selection_status === 'KEEP_CONTROL' ? '建议继续使用原配置，最接近候选的实际代价见下方。' : '建议可作有限试用；该建议基于复用开发数据，需要观察自然新样本中的高估、漏报和各等级表现。'} 不自动修改生产配置。selected_effective_config.json 为完整评分配置（含 weights）；回退使用 rollback_config.json。\n\n| 指标 | Control | 选中 |\n| --- | --- | --- |\n${[['产品损失', c.product_loss, s.product_loss], ['MAE', c.mae, s.mae], ['Bias', c.bias, s.bias], ['QWK', c.qwk, s.qwk], ['目标 ≥2 召回', c.target_ge2.recall, s.target_ge2.recall], ['目标 ≥3 召回', c.target_ge3.recall, s.target_ge3.recall], ['目标 ≥2 精确率', c.target_ge2.precision, s.target_ge2.precision], ['目标 ≥3 精确率', c.target_ge3.precision, s.target_ge3.precision], ['高估至少 2 级', c.overprediction_ge2, s.overprediction_ge2], ['低估至少 2 级', c.underprediction_ge2, s.underprediction_ge2]].map(([k, a, b]) => `| ${k} | ${f(a)} | ${f(b)} |`).join('\n')}\n\n严重高估和至少两级低估等错误的减少/增加、5×5 矩阵、预测分布见 phase7_result.json、top_candidates.json；日期/城市/提前量/时段的配对指标见 slices.json（${slices.length} 组），不按支持度否决配置。\n\n## 搜索及对照\n\n预算 ${search.budget.evaluated_unique}/${search.budget.maximum}，失败 ${search.budget.errors}，非法提议 ${search.budget.invalid}，去重 ${search.budget.duplicates}，终止 ${search.budget.termination}；仅穷举 0.20 粗网格和三轮局部细搜，未穷尽连续空间。接线探针也计入唯一向量预算。\n\n| 候选 | 产品损失 | ≥2 召回 | ≥3 召回 | MAE |\n| --- | --- | --- | --- | --- |\n${best.map(r => `| ${r.candidate_id} | ${f(r.metrics.product_loss)} | ${f(r.metrics.target_ge2.recall)} | ${f(r.metrics.target_ge3.recall)} | ${f(r.metrics.mae)} |`).join('\n')}\n\n最低损失 ${result.lowest_loss_candidate}；保留等级识别的可选折中点 ${result.recognition_compromise ?? '无'}（不作为资格门禁）。最佳非 Control 点：${nearest ? `${nearest.candidate_id}，损失 ${f(nearest.metrics.product_loss)}，≥2/≥3 召回 ${f(nearest.metrics.target_ge2.recall)}/${f(nearest.metrics.target_ge3.recall)}，4→0/1 比例 ${f(nearest.metrics.critical_overprediction.rate)}` : '无可评估非 Control 点'}。\n\n固定 1 损失 ${f(constants.fixed1.metrics.product_loss)}；固定 2 损失 ${f(constants.fixed2.metrics.product_loss)}；开发池最优常量 ${constants.pool_optimal.ordinal} 损失 ${f(constants.pool_optimal.metrics.product_loss)}。仅作对照，不自动否决候选。\n\n## 数据与复算\n\n原分区 ${JSON.stringify(pool.historical_partitions)}，实际纳入 ${pool.included.length} Snapshot/${s.event_count} Event/${s.date_count} 日期，排除 ${pool.excluded_count}，重复 ${pool.duplicate_count}。全部同样本、同引擎计算，Event confidence 按纳入样本数分权；历史 Reference 差异 ${pool.reference_difference_count} 条，仅报告，不因差异自动剔除。\n\n${s.grades.map(g => `等级 ${g.ordinal}：${g.event_count} Event/${g.date_count} 日期/${g.snapshot_count} Snapshot${g.event_count ? '' : '，NOT_ASSESSED'}`).join('；')}。零预测 4 的条件精确率为 null，不宣称可靠性已验证。\n\nusage=PERSONAL_PROJECT_TUNING，evaluation_scope=REUSED_DEVELOPMENT_DATA，independent_validation=false。原 TEST 已作为开发数据使用，不能再称其独立盲验。本工具只追加一条轻量使用记录，不要求补建历史资格或独立性材料。\n\n最终 Control 与选中配置在新 Node 进程逐样本独立复算（分数、等级及汇总一致），未重复整场搜索。代码/输入/配置/策略指纹见 run_spec.json。代码修改状态：${spec.code.git.dirty ?? '未知'}。\n`;
}
export async function practicalRun(options, progress = () => {}) {
  if (options.searchSpace === 'illumination-targeted') return (await import('./illumination-workflow.mjs')).runIllumination(options, progress);
  if (options.searchSpace === 'sky-branch') return (await import('./sky-branch-workflow.mjs')).runSkyBranch(options, progress);
  if (options.searchSpace === 'mechanism-targeted') return (await import('./mechanism-workflow.mjs')).runMechanism(options, progress);
  if (options.searchSpace === 'mid-cloud') return (await import('./mid-cloud-workflow.mjs')).runMidCloud(options, progress);
  if (options.searchSpace === 'high-cloud') return (await import('./high-cloud-workflow.mjs')).runHighCloud(options, progress);
  if (options.searchSpace != null && options.searchSpace !== 'component-weights') fail('UNSUPPORTED_PRACTICAL_SEARCH_SPACE');
  if (options.recognitionFirst) options = { ...options, maxCandidates: Math.min(options.maxCandidates ?? RECOGNITION_POLICY.max_candidates, RECOGNITION_POLICY.max_candidates) };
  if (options.maxCandidates != null && (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > POLICY.budget)) fail('INVALID_CANDIDATE_BUDGET');
  const loaded = await loadPool(options, progress), code = await codeIdentity();
  const output = await safePath(options.output ?? path.join(APP_ROOT, 'dataset/practical_tuning'));
  for (const root of Object.values(loaded.roots)) if (within(root, output) || within(output, root)) fail('OUTPUT_OVERLAPS_INPUT');
  const control = (await loadFrozenBaseConfig()).config; normalizeWeights(control.weights);
  const calculator = replayCalculator(code.engine_sha256);
  progress('统一当前引擎执行 Control 预检');
  const checked = await preflight(loaded, control, calculator, progress);
  const pool = { source_ids: loaded.source_ids, historical_partitions: loaded.historical_partitions,
    duplicate_count: loaded.duplicate_count, included: checked.included,
    excluded_count: checked.exclusions.length, reference_difference_count: checked.reference.filter(r => r.delta !== 0).length,
    historical_test_usage: 'DEVELOPMENT_REUSED_DATA_NOT_INDEPENDENT', weighting: 'GT_CONFIDENCE_DIVIDED_BY_INCLUDED_SNAPSHOTS_PER_EVENT' };
  const identity = { schema: 1, policy: POLICY, ...(options.recognitionFirst ? { recognition_policy: RECOGNITION_POLICY } : {}), inputs: loaded.fingerprints, pool_sha256: digest(pool),
    exclusions_sha256: digest(checked.exclusions), control_config: control,
    code_sha256: code.sha256, engine_sha256: code.engine_sha256, node_version: code.node_version, max_candidates: options.maxCandidates ?? POLICY.budget };
  const runId = `practical_tuning_v1_${digest(identity).slice(0, 20)}`;
  const target = path.join(output, runId), work = path.join(output, '.work', runId), lock = `${work}.lock`;
  await mkdir(path.dirname(work), { recursive: true });
  await acquireRunLock(lock, options.resume);
  try {
    if (await exists(path.join(target, 'manifest.json'))) { const existing = await inspectPractical(target); return { ...existing.result, run_id: runId, directory: target, deduplicated: true }; }
    if (await exists(path.join(work, 'run_spec.json')) && !options.resume) fail('INTERRUPTED_RUN_USE_RESUME', { detail: work });
    await mkdir(path.join(work, 'candidates'), { recursive: true });
    const spec = { practical_tuning_schema_version: 1, practical_tuning_policy_version: 1, run_id: runId,
      identity, code, sources: loaded.roots, control_config: control, created_at_utc: new Date().toISOString() };
    if (await exists(path.join(work, 'run_spec.json'))) {
      const prior = await json(path.join(work, 'run_spec.json'));
      if (digest(prior.identity) !== digest(identity)) fail('RESUME_SPEC_CHANGED'); spec.created_at_utc = prior.created_at_utc;
    }
    await atomicJson(path.join(work, 'run_spec.json'), spec);
    await atomicJson(path.join(work, 'state.json'), { status: 'SEARCHING', phase7_completed: false, run_id: runId });
    progress(`运行 ${runId}；固定 cohort=${checked.rows.length}，其他配置 Hash=${digest(withoutWeights(control))}`);
    const wiring = await wiringCheck(checked.rows, control, calculator, (options.maxCandidates ?? POLICY.budget) - 1);
    progress(`权重接线 ${wiring.status}`);
    const restored = [];
    for (const name of await readdir(path.join(work, 'candidates'))) if (name.endsWith('.json')) restored.push(await json(path.join(work, 'candidates', name)));
    const search = await searchWeights({ control, engine_sha256: code.engine_sha256, restored, probes: wiring.perturbations,
      recognitionFirst: options.recognitionFirst === true,
      maxCandidates: options.maxCandidates ?? POLICY.budget, skipSearch: wiring.status === 'WEIGHTS_NOT_EFFECTIVE',
      evaluate: c => evaluateWeights(checked.rows, control, c.weights, calculator),
      save: r => atomicJson(path.join(work, 'candidates', `${r.candidate_id}.json`), r),
      progress: p => { if (p.count === 1 || p.count % 10 === 0) progress(`已评估 ${p.count}；${p.stage}；最佳产品损失=${p.best}`); } });
    const result = selectPhase7(search.records, search.control_id, wiring.status, options.recognitionFirst === true);
    const selected = search.records.find(r => r.candidate_id === result.selected_candidate), controlRecord = search.records[0];
    const selectedConfig = installWeights(control, selected.weights);
    const request = { spec, pool, exclusions: checked.exclusions, selected: compact(selected), control: compact(controlRecord),
      selected_effective_config: selectedConfig, control_predictions: controlRecord.scores, selected_predictions: selected.scores };
    await atomicJson(path.join(work, 'verification_request.json'), request);
    await atomicJson(path.join(work, 'state.json'), { status: 'FINAL_RECOMPUTING', phase7_completed: false, run_id: runId });
    progress('搜索结束；新进程仅独立复算 Control 与选中配置');
    const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(work, 'verification_request.json')],
      { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const proof = JSON.parse(stdout.trim()); if (proof.status !== 'PASS') fail('FINAL_RECOMPUTE_MISMATCH');
    const constants = constantComparisons(checked.rows), slices = sliceComparisons(checked.rows, selected.scores);
    const ranked = options.recognitionFirst ? rankRecognition(search.records, controlRecord) : rank(search.records), nearest = ranked.find(r => r.candidate_id === result.nearest_non_control);
    const files = { 'pool_manifest.json': pool, 'exclusions.json': checked.exclusions, 'control_config.json': control,
      'top_candidates.json': ranked.slice(0, 5).map(compact), 'selected_candidate.json': compact(selected),
      'selected_effective_config.json': selectedConfig, 'rollback_config.json': control, 'phase7_result.json': result,
      'wiring_audit.json': wiring, 'reference_comparison.json': checked.reference, 'constant_baselines.json': constants,
      'slices.json': slices, 'search_audit.json': { budget: search.budget, proposals: search.audit, records: search.records.map(compact) },
      'verification.json': proof, 'cache_statistics.json': calculator.stats() };
    for (const [name, value] of Object.entries(files)) await atomicJson(path.join(work, name), value);
    const metricRows = search.records.map(r => ({ candidate_id: r.candidate_id, status: r.status, stage: r.stage,
      ...Object.fromEntries(MEMBERS.map(k => [k, r.weights[k]])), product_loss: r.metrics?.product_loss ?? null,
      delta_product_loss: r.metrics ? r.metrics.product_loss - controlRecord.metrics.product_loss : null,
      mae: r.metrics?.mae ?? null, bias: r.metrics?.bias ?? null, qwk: r.metrics?.qwk ?? null,
      critical_4_to_0_1_rate: r.metrics?.critical_overprediction.rate ?? null,
      critical_4_to_0_1_conditional: r.metrics?.critical_overprediction.conditional_on_predicted4 ?? null,
      predicted4_snapshots: r.metrics?.predicted4_support.snapshot_count ?? null,
      target_ge2_recall: r.metrics?.target_ge2.recall ?? null, target_ge2_precision: r.metrics?.target_ge2.precision ?? null,
      target_ge3_recall: r.metrics?.target_ge3.recall ?? null, target_ge3_precision: r.metrics?.target_ge3.precision ?? null,
      overprediction_ge2: r.metrics?.overprediction_ge2 ?? null, underprediction_ge2: r.metrics?.underprediction_ge2 ?? null,
      reason_code: r.reason_code ?? null }));
    await writeFile(path.join(work, 'candidate_metrics.csv'), csv(metricRows));
    await writeFile(path.join(work, 'selected_predictions.csv'), csv(checked.rows.map((r, i) => ({ snapshot_id: r.snapshot_id,
      event_id: r.event_id, city: r.city, event_date_local: r.event_date_local, historical_splits: r.historical_splits.join('|'),
      gt_ordinal: r.gt_ordinal, gt_confidence: r.gt_confidence, event_normalized_weight: r.event_normalized_weight,
      control_score: controlRecord.scores[i], control_ordinal: scoreToOrdinal(controlRecord.scores[i]),
      selected_score: selected.scores[i], selected_ordinal: scoreToOrdinal(selected.scores[i]) }))));
    let reportText = report(spec, pool, search, result, selected, nearest, constants, slices);
    if (options.recognitionFirst) reportText = '# 识别优先局部调优\n\n选择顺序：≥2召回最多下降2个百分点，≥3召回不下降，再最小化产品损失。缺失召回不视为通过；无改善则保留Control。仅本次100点以内局部搜索，不改变天气动态权重规则。\n\n' + reportText.replace('仅穷举 0.20 粗网格和三轮局部细搜', '仅执行Control、平衡/召回种子、非零权重中点及0.05/0.025局部搜索');
    await writeFile(path.join(work, 'report.md'), reportText.replace(/\r?\n/g, '\r\n'), 'utf8');
    await checkInputs(loaded);
    if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
    // A single idempotent append records reuse, including TEST, without cross-ledger qualification.
    const history = path.join(output, 'usage_history.jsonl');
    let historyRows = []; if (await exists(history)) historyRows = (await readSafe(history)).toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (!historyRows.some(r => r.run_id === runId)) await appendFile(history, canonicalJson({ run_id: runId, model: loaded.source_ids.model,
      usage: POLICY.usage, evaluation_scope: POLICY.evaluation_scope, independent_validation: false,
      historical_partitions: pool.historical_partitions, members: pool.included.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, historical_splits: r.historical_splits })),
      selection_status: result.selection_status }) + '\n');
    await atomicJson(path.join(work, 'state.json'), { status: 'COMPLETED', phase7_completed: true, run_id: runId });
    const hashes = {}; for (const name of await inventory(work)) if (name !== 'manifest.json' && !name.endsWith('.tmp')) hashes[name] = hash(await readSafe(path.join(work, name)));
    await atomicJson(path.join(work, 'manifest.json'), { practical_tuning_schema_version: 1, practical_tuning_policy_version: 1,
      run_id: runId, identity_sha256: digest(identity), files: hashes });
    await rename(work, target);
    return { run_id: runId, directory: target, phase7_completed: true, selection_status: result.selection_status,
      selected_candidate: result.selected_candidate, delta_product_loss: result.metrics_vs_control.delta_product_loss,
      evaluated_candidates: search.budget.evaluated_unique, trial_config_available: true, independent_validation: false };
  } catch (e) {
    if (await exists(path.join(work, 'run_spec.json'))) await atomicJson(path.join(work, 'state.json'),
      { status: 'EXECUTION_ERROR', phase7_completed: false, error_code: errorCode(e), run_id: runId });
    throw e;
  } finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
export async function inspectPractical(directory) {
  const root = await safePath(directory), manifest = await json(path.join(root, 'manifest.json'));
  if (manifest.practical_tuning_schema_version === 6 && manifest.practical_tuning_policy_version === 6) return (await import('./illumination-workflow.mjs')).inspectIllumination(root);
  if (manifest.practical_tuning_schema_version === 5 && manifest.practical_tuning_policy_version === 5) return (await import('./sky-branch-workflow.mjs')).inspectSkyBranch(root);
  if (manifest.practical_tuning_schema_version === 4 && manifest.practical_tuning_policy_version === 4)
    return (await import('./mechanism-workflow.mjs')).inspectMechanism(root);
  if (manifest.practical_tuning_schema_version === 3 && manifest.practical_tuning_policy_version === 3)
    return (await import('./mid-cloud-workflow.mjs')).inspectMidCloud(root);
  if (manifest.practical_tuning_schema_version === 2 && manifest.practical_tuning_policy_version === 2)
    return (await import('./high-cloud-workflow.mjs')).inspectHighCloud(root);
  if (manifest.practical_tuning_schema_version !== 1 || manifest.practical_tuning_policy_version !== 1) fail('UNSUPPORTED_PRACTICAL_VERSION');
  for (const name of ['run_spec.json', 'pool_manifest.json', 'exclusions.json', 'control_config.json', 'candidate_metrics.csv',
    'top_candidates.json', 'selected_candidate.json', 'selected_effective_config.json', 'rollback_config.json',
    'selected_predictions.csv', 'phase7_result.json', 'report.md', 'verification_request.json', 'verification.json']) {
    if (!manifest.files?.[name]) fail('PRACTICAL_OUTPUT_MISSING');
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!within(root, path.resolve(root, name)) || hash(await readSafe(path.join(root, name))) !== expected) fail('PRACTICAL_OUTPUT_HASH_MISMATCH');
  }
  const spec = await json(path.join(root, 'run_spec.json')), result = await json(path.join(root, 'phase7_result.json'));
  if (digest(spec.identity) !== manifest.identity_sha256 || spec.run_id !== manifest.run_id ||
      manifest.run_id !== `practical_tuning_v1_${digest(spec.identity).slice(0, 20)}` || !result.phase7_completed ||
      result.independent_validation !== false || result.usage !== POLICY.usage) fail('INVALID_PRACTICAL_RESULT');
  const selected = await json(path.join(root, 'selected_candidate.json')), selectedConfig = await json(path.join(root, 'selected_effective_config.json'));
  if (digest(installWeights(spec.control_config, selected.weights)) !== digest(selectedConfig) || result.selected_candidate !== selected.candidate_id) fail('INVALID_SELECTED_CONFIG');
  const request = await json(path.join(root, 'verification_request.json'));
  if (digest(request.spec) !== digest(spec) || digest(request.selected) !== digest(selected) ||
      digest(request.selected_effective_config) !== digest(selectedConfig) || digest(result.metrics_vs_control.selected) !== digest(selected.metrics) ||
      digest(request.pool) !== digest(await json(path.join(root, 'pool_manifest.json'))) ||
      digest(request.exclusions) !== digest(await json(path.join(root, 'exclusions.json'))) ||
      digest(spec.control_config) !== digest(await json(path.join(root, 'rollback_config.json')))) fail('PRACTICAL_RESULT_BINDING_MISMATCH');
  return { status: 'PASS', directory: root, manifest, spec, result };
}
export async function verifyPractical(directory) {
  const inspected = await inspectPractical(directory);
  if (inspected.manifest.practical_tuning_schema_version === 6) return (await import('./illumination-workflow.mjs')).verifyIllumination(directory);
  if (inspected.manifest.practical_tuning_schema_version === 5) return (await import('./sky-branch-workflow.mjs')).verifySkyBranch(directory);
  if (inspected.manifest.practical_tuning_schema_version === 4) return (await import('./mechanism-workflow.mjs')).verifyMechanism(directory);
  if (inspected.manifest.practical_tuning_schema_version === 3) return (await import('./mid-cloud-workflow.mjs')).verifyMidCloud(directory);
  if (inspected.manifest.practical_tuning_schema_version === 2) return (await import('./high-cloud-workflow.mjs')).verifyHighCloud(directory);
  const { stdout } = await exec(process.execPath, [path.join(APP_ROOT, 'tools/practical-tuning/worker.mjs'), path.join(directory, 'verification_request.json'), '--compatible-v1-tools'],
    { cwd: APP_ROOT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return { ...JSON.parse(stdout.trim()), run_id: inspected.manifest.run_id, phase7_completed: true };
}
