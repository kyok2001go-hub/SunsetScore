import { assertCompatibleEngine } from './engine-compatibility.mjs';
import path from 'node:path';
import { readSafe, safePath, hash, fail } from '../dataset/lib/common.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { digest, POLICY } from './policy.mjs';
import { preflight, evaluateConfig } from './compute.mjs';
import { inspectPractical } from './workflow.mjs';
import { createCloudWorkflow } from './high-cloud-workflow.mjs';
import * as mid from './mid-cloud.mjs';
import { pairedMigrations, migrationCsvFields, MIGRATION_KEYS } from './migrations.mjs';
const json = async file => JSON.parse(await readSafe(file));

export async function loadMidCloudParent(directory) {
  if (!directory) fail('BASELINE_RUN_REQUIRED');
  const root = await safePath(directory), bytes = await readSafe(path.join(root, 'manifest.json')), manifest = JSON.parse(bytes);
  if (manifest.practical_tuning_schema_version !== 2 || manifest.practical_tuning_policy_version !== 2) fail('MID_CLOUD_PARENT_MUST_BE_HIGH_CLOUD_RUN_V2');
  const parent = await inspectPractical(root);
  if (parent.result.selection_mode !== 'CUMULATIVE_RECOGNITION_FIRST') fail('MID_CLOUD_PARENT_MUST_BE_RECOGNITION_FIRST');
  // V2 rollback is B1. Preserve the original B0 anchor across successive runs.
  const original = await json(path.join(root, 'original_control_config.json')), baseline = await json(path.join(root, 'selected_effective_config.json'));
  if (baseline.highCloudCenter !== 60 || baseline.highCloudWidth !== 25 || baseline.midCloudCenter !== 40 || baseline.midCloudWidth !== 25) fail('MID_CLOUD_BASELINE_PARAMETERS_DIFFER');
  const request = await json(path.join(root, 'verification_request.json')), pool = await json(path.join(root, 'pool_manifest.json')), exclusions = await json(path.join(root, 'exclusions.json'));
  return { root, original, baseline, pool, exclusions, request, spec: parent.spec,
    reference: { run_id: manifest.run_id, manifest_sha256: hash(bytes), candidate_id: parent.result.selected_candidate,
      original_config_sha256: digest(original), baseline_config_sha256: digest(baseline), members_sha256: digest(pool.included),
      inputs_sha256: digest(parent.spec.identity.inputs), engine_sha256: parent.spec.code.engine_sha256 } };
}
export async function reproduceMidCloudBaselines(loaded, parent, code, calculator, progress = () => {}) {
  const engineCompatibility = assertCompatibleEngine(code, parent.spec.code, { allowDefaultCompatibility: true, reason: 'PARENT_ENGINE_DIFFERS' });
  if (digest(loaded.fingerprints) !== digest(parent.spec.identity.inputs) || digest(loaded.source_ids) !== digest(parent.pool.source_ids)) fail('PARENT_INPUT_FILES_DIFFER');
  const checked = await preflight(loaded, parent.original, calculator, progress);
  if (digest(checked.included) !== digest(parent.pool.included) || digest(checked.exclusions) !== digest(parent.exclusions)) fail('PARENT_COHORT_OR_B0_SCORES_DIFFER');
  const evaluate = async config => { const r = await evaluateConfig(checked.rows, config, calculator); return { ...r, metrics: mid.highCloudMetrics(checked.rows, r.scores) }; };
  const B0 = await evaluate(parent.original), B1 = await evaluate(parent.baseline);
  for (const [actual, expected] of [[B0, parent.request.B0], [B1, parent.request.selected]])
    if (digest(actual.scores) !== digest(expected.scores) || actual.predictions_sha256 !== expected.predictions_sha256 || digest(actual.metrics) !== digest(expected.metrics)) fail('PARENT_BASELINE_REPRODUCTION_MISMATCH');
  return { checked, B0, B1, audit: { status: 'PASS', member_count: checked.rows.length, B0_source: 'original_control_config.json',
    B0_predictions_sha256: B0.predictions_sha256, B1_predictions_sha256: B1.predictions_sha256, old_metrics_exactly_reproduced: true, engine_compatibility: engineCompatibility,
    engine_sha256: code.engine_sha256, parent_tool_sha256: parent.spec.code.sha256, current_tool_sha256: code.sha256,
    mode: engineCompatibility.mode === 'IDENTICAL_ENGINE' ? 'CURRENT_TOOLS_SAME_ENGINE_EXACT_PARENT_PREDICTIONS_AND_METRICS' : 'PINNED_DEFAULT_COMPATIBLE_ENGINE_EXACT_PARENT_PREDICTIONS_AND_METRICS' } };
}
function validateRecords(request) {
  const rows = request.pool.included;
  for (const record of request.search_records.filter(r => r.status === 'EVALUATED')) {
    if (!Array.isArray(record.scores) || record.scores.length !== rows.length ||
        digest(rows.map((r, i) => [r.snapshot_id, record.scores[i], scoreToOrdinal(record.scores[i])])) !== record.predictions_sha256 ||
        digest(mid.highCloudMetrics(rows, record.scores)) !== digest(record.metrics) ||
        digest(pairedMigrations(rows, request.B1.scores, record.scores)) !== digest(record.paired_migrations)) fail('MID_CLOUD_RECORD_PREDICTIONS_OR_MIGRATIONS_MISMATCH');
    const m = record.paired_migrations, delta = record.metrics.target_ge3.recall == null || request.B1.metrics.target_ge3.recall == null ? null : record.metrics.target_ge3.recall - request.B1.metrics.target_ge3.recall;
    if (delta == null ? m.recall_ge3_delta_from_net !== null : Math.abs(delta - m.recall_ge3_delta_from_net) > POLICY.epsilon * 2) fail('MIGRATION_RECALL_DELTA_MISMATCH');
  }
}
function migrationOutputs(request) {
  const result = request.phase7_result;
  return { selected: result.selected_candidate, lowest_loss: result.lowest_loss_candidate, highest_ge3: result.highest_ge3_recall_with_ge2_floor,
    candidates: request.search_records.filter(r => r.status === 'EVALUATED').map(r => ({ candidate_id: r.candidate_id, parameters: r.parameters, ...r.paired_migrations })) };
}
function migrationReport(request) {
  const r = request.phase7_result, roles = [['最终选择', r.selected_candidate], ['最低损失', r.lowest_loss_candidate], ['≥2达底线的最高≥3召回', r.highest_ge3_recall_with_ge2_floor]];
  const labels = ['从预测2找回实际3/4', '从预测0/1找回实际3/4', '原已识别高等级丢失', '新增≥3误报', '原有≥3误报消除'];
  return '\n## 找回与误报：B1→候选配对统计\n\n固定高云60/25与B1权重。每项权重均来自全池Event内分权，不在迁移子集重新归一化；同一Event可跨行，Event数不可相加。所有有效候选详见 paired_migrations.json 和 candidate_metrics.csv。\n\n' + roles.map(([role, id]) => {
    const c = request.search_records.find(c => c.candidate_id === id); if (!c) return `${role}：无可评估点。\n`;
    const m = c.paired_migrations;
    return `### ${role}：${JSON.stringify(c.parameters)}\n\n| 迁移 | Snapshot数 | 去重Event数 | 全池加权量 |\n| --- | --- | --- | --- |\n${MIGRATION_KEYS.map((key, i) => `| ${labels[i]} | ${m[key].snapshot_count} | ${m[key].event_count} | ${m[key].weighted_amount} |`).join('\n')}\n\n净找回加权量=${m.net_recovered_weight}；GT≥3加权支持=${m.gt_ge3_weighted_support}；净找回/支持=${m.recall_ge3_delta_from_net}，≥3召回变化=${m.recall_ge3_delta}。新增误报按实际等级：${m.new_false_alarms_by_actual.map(a => `${a.ordinal}级=${a.snapshot_count}Snapshot/${a.event_count}Event/权重${a.weighted_amount}`).join('；')}。\n\n`;
  }).join('') + '本轮计划结束即停止；无达标改善时保留B1，不自动扩大中云范围、联调高云或重开权重。后续是否检查具体压分机制另行决定。\n';
}
const workflow = createCloudWorkflow({ ...mid, H: mid.MID_CLOUD_POLICY, keepScores: true,
  installHighCloud: mid.installMidCloud, withoutHighCloud: mid.withoutMidCloud, highCloudCandidate: mid.midCloudCandidate,
  searchHighCloud: mid.searchMidCloud, selectHighCloud: mid.selectMidCloud,
  loadParent: loadMidCloudParent, reproduce: reproduceMidCloudBaselines, migrations: pairedMigrations, validateRecords,
  outputFiles: request => ({ 'paired_migrations.json': migrationOutputs(request) }), csvFields: migrationCsvFields, report: migrationReport });
export const { runHighCloud: runMidCloud, inspectHighCloud: inspectMidCloud, verifyHighCloud: verifyMidCloud,
  verifyHighCloudRequest: verifyMidCloudRequest } = workflow;
