import { fail, errorCode, compare } from '../dataset/lib/common.mjs';
import { registryUnit } from '../tuning/parameter-registry.mjs';
import { digest, POLICY, q, tradeoffs } from './policy.mjs';
import { productMetrics, weightedRows } from '../product-evaluation/metrics.mjs';
import { scoreToOrdinal, gradeScore } from '../evaluation/metrics.mjs';

const { members, grid_step, ...sharedPolicy } = POLICY;
export const HIGH_CLOUD_POLICY = Object.freeze({ ...sharedPolicy, practical_tuning_schema_version: 2, practical_tuning_policy_version: 2,
  search_space: 'high-cloud', parameter_id: ['high_cloud_center', 'high_cloud_width'],
  canonical_paths: ['highCloudCenter', 'highCloudWidth'], selection_mode: 'CUMULATIVE_RECOGNITION_FIRST',
  budget: 80, coarse_centers: [45, 50, 55, 60, 65, 70, 75], coarse_widths: [15, 20, 25, 30, 35, 40],
  local_steps: [2, 1], local_parents: 2, recognition_anchor: 'B0_ORIGINAL_CONTROL',
  recognition_policy: { ge2_max_cumulative_drop: 0.02, ge3_max_cumulative_drop: 0, null_passes: false },
  distance: 'abs(center-60)/100+abs(width-25)/59',
  rank: [...POLICY.rank.slice(0, 5), 'parameter_distance ASC', 'candidate_id ASC'] });
export function highCloudParameters(values) {
  if (!values || Object.keys(values).length !== 2) fail('INVALID_HIGH_CLOUD_PARAMETERS');
  for (const id of HIGH_CLOUD_POLICY.parameter_id) {
    const unit = registryUnit(id), path = id === 'high_cloud_center' ? 'highCloudCenter' : 'highCloudWidth';
    if (unit.canonical_path !== path || unit.integer !== true || !Array.isArray(unit.range)) fail('INCOMPATIBLE_HIGH_CLOUD_REGISTRY');
    const value = values[id];
    if (!Number.isInteger(value) || value < unit.range[0] || value > unit.range[1]) fail('INVALID_HIGH_CLOUD_PARAMETERS');
  }
  return Object.fromEntries(HIGH_CLOUD_POLICY.parameter_id.map(id => [id, values[id]]));
}
export const parametersOf = config => highCloudParameters({ high_cloud_center: config.highCloudCenter, high_cloud_width: config.highCloudWidth });
export function withoutHighCloud(config) { const { highCloudCenter, highCloudWidth, ...rest } = config; return rest; }
export function installHighCloud(baseline, parameters) {
  const p = highCloudParameters(parameters), config = structuredClone(baseline);
  config.highCloudCenter = p.high_cloud_center; config.highCloudWidth = p.high_cloud_width;
  if (digest(withoutHighCloud(config)) !== digest(withoutHighCloud(baseline))) fail('NON_HIGH_CLOUD_CONFIG_CHANGED');
  return config;
}
export function highCloudCandidate(parameters, context) {
  parameters = highCloudParameters(parameters);
  return { candidate_id: `practical_candidate_v2_${digest({ parameters, baseline: digest(context.baseline), original: digest(context.original),
    engine_sha256: context.engine_sha256, policy: HIGH_CLOUD_POLICY }).slice(0, 20)}`, parameters,
    parameter_distance: q(Math.abs(parameters.high_cloud_center - 60) / 100 + Math.abs(parameters.high_cloud_width - 25) / 59) };
}
export function recognitionFloor(originalMetrics) {
  return { anchor: 'B0', target_ge2: originalMetrics.target_ge2.recall == null ? null : originalMetrics.target_ge2.recall - .02,
    target_ge3: originalMetrics.target_ge3.recall, epsilon: POLICY.epsilon };
}
export function meetsHighCloudRecognition(record, originalMetrics) {
  const floor = recognitionFloor(originalMetrics);
  return [2, 3].every(n => record.metrics?.[`target_ge${n}`]?.recall != null && floor[`target_ge${n}`] != null &&
    record.metrics[`target_ge${n}`].recall >= floor[`target_ge${n}`] - POLICY.epsilon);
}
export function compareHighCloud(a, b) {
  for (const [x, y, d] of [[a.metrics.product_loss, b.metrics.product_loss, 1],
    [a.metrics.critical_overprediction.rate, b.metrics.critical_overprediction.rate, 1],
    [a.metrics.target_ge3.recall, b.metrics.target_ge3.recall, -1], [a.metrics.target_ge2.recall, b.metrics.target_ge2.recall, -1],
    [a.metrics.mae, b.metrics.mae, 1], [a.parameter_distance, b.parameter_distance, 1]]) {
    if (x == null && y == null) continue; if (x == null) return 1; if (y == null) return -1;
    if (Math.abs(x - y) > POLICY.epsilon) return Math.sign(x - y) * d;
  }
  return compare(a.candidate_id, b.candidate_id);
}
export const rankHighCloud = (records, originalMetrics, recognitionFirst = true) => records.filter(r => r.status === 'EVALUATED').sort((a, b) =>
  (recognitionFirst ? Number(meetsHighCloudRecognition(b, originalMetrics)) - Number(meetsHighCloudRecognition(a, originalMetrics)) : 0) || compareHighCloud(a, b));
export function selectHighCloud(records, baselineId, originalMetrics) {
  const evaluated = rankHighCloud(records, originalMetrics), baseline = evaluated.find(r => r.candidate_id === baselineId);
  if (!baseline) fail('NO_VALID_BASELINE');
  const chosen = evaluated.find(r => r.candidate_id !== baselineId && meetsHighCloudRecognition(r, originalMetrics) &&
    r.metrics.product_loss < baseline.metrics.product_loss - POLICY.epsilon) ?? baseline;
  const costsB1 = tradeoffs(chosen.metrics, baseline.metrics), costsB0 = tradeoffs(chosen.metrics, originalMetrics);
  const recall3 = evaluated.filter(r => r.metrics.target_ge2.recall != null && recognitionFloor(originalMetrics).target_ge2 != null &&
    r.metrics.target_ge2.recall >= recognitionFloor(originalMetrics).target_ge2 - POLICY.epsilon && r.metrics.target_ge3.recall != null)
    .sort((a, b) => Math.abs(a.metrics.target_ge3.recall - b.metrics.target_ge3.recall) > POLICY.epsilon ?
      b.metrics.target_ge3.recall - a.metrics.target_ge3.recall : compareHighCloud(a, b))[0];
  const lowest = rankHighCloud(records, originalMetrics, false)[0];
  return { practical_tuning_schema_version: 2, practical_tuning_policy_version: 2, usage: POLICY.usage,
    evaluation_scope: POLICY.evaluation_scope, independent_validation: false, phase7_completed: true, trial_config_available: true,
    search_space: 'high-cloud', selection_mode: HIGH_CLOUD_POLICY.selection_mode,
    selection_status: chosen === baseline ? 'KEEP_CONTROL' : costsB1.length || costsB0.length ? 'SELECTED_WITH_TRADEOFFS' : 'SELECTED_IMPROVED',
    control_means: 'B1_PARENT_SELECTED_CONFIG', selected_candidate: chosen.candidate_id, baseline_candidate: baselineId,
    recognition_floor: recognitionFloor(originalMetrics), selected_meets_cumulative_floor: meetsHighCloudRecognition(chosen, originalMetrics),
    metrics_vs_baseline: { selected: chosen.metrics, baseline: baseline.metrics, delta_product_loss: q(chosen.metrics.product_loss - baseline.metrics.product_loss) },
    metrics_vs_original: { selected: chosen.metrics, original: originalMetrics, delta_product_loss: q(chosen.metrics.product_loss - originalMetrics.product_loss) },
    tradeoffs_vs_B1: costsB1, tradeoffs_vs_B0: costsB0, lowest_loss_candidate: lowest.candidate_id,
    highest_ge3_recall_with_ge2_floor: recall3?.candidate_id ?? null,
    selected_effective_config: 'selected_effective_config.json', baseline_config: 'baseline_config.json',
    original_control_config: 'original_control_config.json', rollback_config: 'rollback_config.json' };
}
export function highCloudGrid() { return HIGH_CLOUD_POLICY.coarse_centers.flatMap(c => HIGH_CLOUD_POLICY.coarse_widths.map(w => ({ high_cloud_center: c, high_cloud_width: w }))); }
export function highCloudNeighbors(parameters, step) {
  return [-step, 0, step].flatMap(c => [-step, 0, step].map(w => ({ high_cloud_center: parameters.high_cloud_center + c, high_cloud_width: parameters.high_cloud_width + w })));
}
export async function searchHighCloud({ baseline, original, engine_sha256, originalMetrics, evaluate, restored = [], save = async () => {}, progress = () => {}, maxCandidates = 80, adapter = null }) {
  const { candidate: makeCandidate = highCloudCandidate, parameters: readParameters = parametersOf, grid = highCloudGrid, neighbors = highCloudNeighbors, policy = HIGH_CLOUD_POLICY } = adapter ?? {};
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 80) fail('INVALID_CANDIDATE_BUDGET');
  const context = { baseline, original, engine_sha256 }, old = new Map(restored.map(r => [r.candidate_id, r])), records = [], audit = [], seen = new Set(); let budgetHit = false;
  const propose = async (parameters, stage) => {
    let c; try { c = makeCandidate(parameters, context); }
    catch (e) { audit.push({ stage, parameters, status: 'INVALID', reason_code: errorCode(e) }); return; }
    if (seen.has(c.candidate_id)) { audit.push({ stage, candidate_id: c.candidate_id, status: 'DUPLICATE' }); return; }
    if (records.length >= maxCandidates) { budgetHit = true; return; } seen.add(c.candidate_id);
    let r = old.get(c.candidate_id);
    if (r && digest(r.parameters) !== digest(c.parameters)) fail('RESUME_CANDIDATE_MISMATCH');
    if (!r) { try { r = { ...c, stage, status: 'EVALUATED', ...await evaluate(c) }; }
      catch (e) { r = { ...c, stage, status: 'ERROR', reason_code: errorCode(e), metrics: null }; } await save(r); }
    records.push(r); audit.push({ stage, candidate_id: c.candidate_id, status: r.status });
    const best = rankHighCloud(records, originalMetrics)[0]; progress({ count: records.length, stage, status: r.status,
      best_loss: best?.metrics.product_loss ?? null, best_meets_floor: best ? meetsHighCloudRecognition(best, originalMetrics) : false });
  };
  await propose(readParameters(baseline), 'B1_BASELINE');
  if (records[0]?.status !== 'EVALUATED') fail('NO_VALID_BASELINE');
  for (const p of grid()) await propose(p, 'COARSE_7X6');
  for (const step of policy.local_steps) for (const parent of rankHighCloud(records, originalMetrics).slice(0, 2))
    for (const p of neighbors(parent.parameters, step)) await propose(p, `LOCAL_${step}`);
  return { records, audit, baseline_id: records[0].candidate_id, budget: { maximum: maxCandidates, evaluated_unique: records.length,
    errors: records.filter(r => r.status === 'ERROR').length, duplicates: audit.filter(r => r.status === 'DUPLICATE').length,
    invalid: audit.filter(r => r.status === 'INVALID').length, termination: budgetHit ? 'BUDGET_REACHED' : 'COARSE_AND_TWO_LOCAL_ROUNDS_COMPLETE', exhaustive_parameter_space: false } };
}
// thresholds defaults to the legacy 20/40/60/90; a release passes the boundaries of its own configuration.
export function highCloudMetrics(rows, scores, thresholds) {
  const predicted = rows.map((r, i) => ({ ...r, predicted_ordinal: thresholds ? gradeScore(scores[i], thresholds) : scoreToOrdinal(scores[i]) }));
  const metrics = productMetrics(predicted), weighted = weightedRows(predicted), subset = weighted.filter(r => r.predicted_ordinal === 4 && r.gt_ordinal === 2);
  const weight = rs => rs.reduce((s, r) => s + r.weight, 0), four = weighted.filter(r => r.predicted_ordinal === 4);
  return { ...metrics, predicted4_actual2: { snapshot_count: subset.length, event_count: new Set(subset.map(r => r.event_id)).size,
    date_count: new Set(subset.map(r => r.event_date_local)).size, rate: q(weight(subset) / weight(weighted)),
    conditional_on_predicted4: four.length ? q(weight(subset) / weight(four)) : null } };
}
