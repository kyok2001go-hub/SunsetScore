import { fail } from '../dataset/lib/common.mjs';
import { registryUnit } from '../tuning/parameter-registry.mjs';
import { digest, q } from './policy.mjs';
import { HIGH_CLOUD_POLICY, searchHighCloud, selectHighCloud, highCloudMetrics, recognitionFloor,
  meetsHighCloudRecognition, rankHighCloud } from './high-cloud.mjs';
export { highCloudMetrics, recognitionFloor, meetsHighCloudRecognition, rankHighCloud };

export const MID_CLOUD_POLICY = Object.freeze({ ...HIGH_CLOUD_POLICY,
  practical_tuning_schema_version: 3, practical_tuning_policy_version: 3, search_space: 'mid-cloud',
  parameter_id: ['mid_cloud_center', 'mid_cloud_width'], canonical_paths: ['midCloudCenter', 'midCloudWidth'],
  coarse_centers: [25, 30, 35, 40, 45, 50, 55], distance: 'abs(center-40)/100+abs(width-25)/59',
  paired_migrations: 'B1_TO_CANDIDATE_FULL_POOL_EVENT_NORMALIZED_WEIGHTS_NO_SUBSET_RENORMALIZATION' });
export function midCloudParameters(values) {
  if (!values || Object.keys(values).length !== 2) fail('INVALID_MID_CLOUD_PARAMETERS');
  for (const [i, id] of MID_CLOUD_POLICY.parameter_id.entries()) {
    const unit = registryUnit(id), value = values[id];
    if (unit.canonical_path !== MID_CLOUD_POLICY.canonical_paths[i] || !unit.integer || !Array.isArray(unit.range)) fail('INCOMPATIBLE_MID_CLOUD_REGISTRY');
    if (!Number.isInteger(value) || value < unit.range[0] || value > unit.range[1]) fail('INVALID_MID_CLOUD_PARAMETERS');
  }
  return Object.fromEntries(MID_CLOUD_POLICY.parameter_id.map(id => [id, values[id]]));
}
export const parametersOf = config => midCloudParameters({ mid_cloud_center: config.midCloudCenter, mid_cloud_width: config.midCloudWidth });
export function withoutMidCloud(config) { const { midCloudCenter, midCloudWidth, ...rest } = config; return rest; }
export function installMidCloud(baseline, parameters) {
  const p = midCloudParameters(parameters), config = structuredClone(baseline);
  config.midCloudCenter = p.mid_cloud_center; config.midCloudWidth = p.mid_cloud_width;
  if (digest(withoutMidCloud(config)) !== digest(withoutMidCloud(baseline))) fail('NON_MID_CLOUD_CONFIG_CHANGED');
  return config;
}
export function midCloudCandidate(parameters, context) {
  parameters = midCloudParameters(parameters);
  return { candidate_id: `practical_candidate_v3_${digest({ parameters, baseline: digest(context.baseline), original: digest(context.original),
    engine_sha256: context.engine_sha256, policy: MID_CLOUD_POLICY }).slice(0, 20)}`, parameters,
    parameter_distance: q(Math.abs(parameters.mid_cloud_center - 40) / 100 + Math.abs(parameters.mid_cloud_width - 25) / 59) };
}
export const midCloudGrid = () => MID_CLOUD_POLICY.coarse_centers.flatMap(c => MID_CLOUD_POLICY.coarse_widths.map(w => ({ mid_cloud_center: c, mid_cloud_width: w })));
export const midCloudNeighbors = (p, step) => [-step, 0, step].flatMap(c => [-step, 0, step].map(w => ({ mid_cloud_center: p.mid_cloud_center + c, mid_cloud_width: p.mid_cloud_width + w })));
export const searchMidCloud = options => searchHighCloud({ ...options, adapter: {
  candidate: midCloudCandidate, parameters: parametersOf, grid: midCloudGrid, neighbors: midCloudNeighbors, policy: MID_CLOUD_POLICY } });
export function selectMidCloud(records, baselineId, originalMetrics) {
  return { ...selectHighCloud(records, baselineId, originalMetrics), practical_tuning_schema_version: 3,
    practical_tuning_policy_version: 3, search_space: 'mid-cloud' };
}
