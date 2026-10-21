import { canonicalJson, hash, fail, compare } from '../dataset/lib/common.mjs';
import { registryUnit } from '../tuning/parameter-registry.mjs';
import { productPolicy } from '../product-evaluation/policy.mjs';
export const digest = value => hash(canonicalJson(value));
export const ROOT = new URL('../../', import.meta.url);
export const MEMBERS = Object.freeze(['skyCanvas', 'horizon', 'illumination', 'atmosphere', 'weather']);
export const POLICY = Object.freeze({ practical_tuning_schema_version: 1, practical_tuning_policy_version: 1,
  usage: 'PERSONAL_PROJECT_TUNING', evaluation_scope: 'REUSED_DEVELOPMENT_DATA', independent_validation: false,
  parameter_id: 'component_weights', members: MEMBERS, decimals: 12, epsilon: 1e-12,
  loss_matrix: productPolicy().loss_matrix, loss_orientation: 'PREDICTED_ROW_ACTUAL_COLUMN',
  loss_contract: 'FROZEN_TECHNICAL_DEFAULT_NOT_USER_CONFIRMED_PRODUCTION_SLA',
  budget: 500, grid_step: 0.2, local_steps: [0.1, 0.05, 0.025], local_parents: 5,
  rank: ['product_loss ASC', 'critical_overprediction.rate ASC', 'target_ge3.recall DESC NULL LAST',
    'target_ge2.recall DESC NULL LAST', 'mae ASC', 'control_weight_distance ASC', 'candidate_id ASC'] });
export const q = n => Number(n.toFixed(12));
export const RECOGNITION_POLICY = Object.freeze({ version: 1, ge2_max_drop: 0.02, ge3_max_drop: 0,
  max_candidates: 100, local_steps: [0.05, 0.025], local_parents: 3,
  seeds: [
    { skyCanvas: 0.2, horizon: 0.4, illumination: 0.4, atmosphere: 0, weather: 0 },
    { skyCanvas: 0.4, horizon: 0.4, illumination: 0.2, atmosphere: 0, weather: 0 }
  ] });
export function preservesRecognition(record, control) {
  return [2, 3].every(n => {
    const a = record.metrics[`target_ge${n}`].recall, b = control.metrics[`target_ge${n}`].recall;
    return a != null && b != null && a >= b - RECOGNITION_POLICY[`ge${n}_max_drop`] - POLICY.epsilon;
  });
}
export function rankRecognition(records, control) {
  return rank(records).sort((a, b) => Number(preservesRecognition(b, control)) - Number(preservesRecognition(a, control)) || compareCandidates(a, b));
}
export function normalizeWeights(weights, unit = registryUnit('component_weights')) {
  if (unit.unit_category !== 'SIMPLEX' || unit.canonical_path !== 'weights' ||
      digest(unit.members) !== digest(MEMBERS)) fail('INCOMPATIBLE_COMPONENT_WEIGHTS_REGISTRY');
  if (!weights || Object.keys(weights).length !== MEMBERS.length || MEMBERS.some(k =>
    !Number.isFinite(weights[k]) || weights[k] < 0 || weights[k] > 1)) fail('INVALID_COMPONENT_WEIGHTS');
  if (Math.abs(MEMBERS.reduce((s, k) => s + weights[k], 0) - 1) > 1e-9) fail('INVALID_WEIGHT_SUM');
  const out = Object.fromEntries(MEMBERS.map(k => [k, q(weights[k])]));
  // Apply a possible rounding residual to the last member with enough range to hold it.
  const residual = q(1 - MEMBERS.reduce((s, k) => s + out[k], 0));
  const target = [...MEMBERS].reverse().find(k => out[k] + residual >= 0 && out[k] + residual <= 1);
  if (!target) fail('INVALID_WEIGHT_SUM');
  out[target] = q(out[target] + residual);
  const range = unit.range ?? [0, 1];
  if (MEMBERS.some(k => out[k] < range[0] || out[k] > range[1]) ||
      Math.abs(MEMBERS.reduce((s, k) => s + out[k], 0) - 1) > 1e-12) fail('INVALID_COMPONENT_WEIGHTS');
  return out;
}
export function withoutWeights(config) { const { weights, ...rest } = config; return rest; }
export function installWeights(control, weights) {
  const config = structuredClone(control); config.weights = normalizeWeights(weights);
  if (digest(withoutWeights(config)) !== digest(withoutWeights(control))) fail('NON_WEIGHT_CONFIG_CHANGED');
  return config;
}
export function compareCandidates(a, b) {
  const keys = [[a.metrics.product_loss, b.metrics.product_loss, 1],
    [a.metrics.critical_overprediction.rate, b.metrics.critical_overprediction.rate, 1],
    [a.metrics.target_ge3.recall, b.metrics.target_ge3.recall, -1],
    [a.metrics.target_ge2.recall, b.metrics.target_ge2.recall, -1],
    [a.metrics.mae, b.metrics.mae, 1], [a.control_weight_distance, b.control_weight_distance, 1]];
  for (const [x, y, direction] of keys) {
    if (x == null && y == null) continue;
    if (x == null) return 1; if (y == null) return -1;
    if (Math.abs(x - y) > POLICY.epsilon) return Math.sign(x - y) * direction;
  }
  return compare(a.candidate_id, b.candidate_id);
}
export const rank = records => records.filter(r => r.status === 'EVALUATED').sort(compareCandidates);
export function tradeoffs(metrics, control) {
  const out = [];
  for (const [key, direction] of [['mae', 1], ['overprediction_ge2', 1], ['underprediction_ge2', 1], ['qwk', -1]]) {
    if (metrics[key] == null || control[key] == null) out.push(`${key.toUpperCase()}_NOT_ASSESSED`);
    else if (direction * (metrics[key] - control[key]) > POLICY.epsilon) out.push(`${key.toUpperCase()}_WORSE`);
  }
  if (Math.abs(metrics.bias ?? 0) > Math.abs(control.bias ?? 0) + POLICY.epsilon) out.push('ABSOLUTE_BIAS_WORSE');
  for (const n of [2, 3]) {
    const a = metrics[`target_ge${n}`].recall, b = control[`target_ge${n}`].recall;
    if (a == null || b == null) out.push(`TARGET_GE${n}_RECALL_NOT_ASSESSED`);
    else if (a < b - POLICY.epsilon) out.push(`TARGET_GE${n}_RECALL_LOWER`);
  }
  if (metrics.critical_overprediction.rate > control.critical_overprediction.rate + POLICY.epsilon) out.push('CRITICAL_4_TO_0_1_INCREASED');
  if (metrics.critical_overprediction.snapshot_count) out.push('OBSERVED_CRITICAL_4_TO_0_1');
  if (!metrics.predicted4_support.snapshot_count) out.push('PREDICTION_4_NOT_ASSESSED');
  for (const g of metrics.grades) if (!g.event_count) out.push(`ACTUAL_GRADE_${g.ordinal}_NOT_ASSESSED`);
  return out;
}
export function selectPhase7(records, controlId, wiringStatus = 'EFFECTIVE', recognitionFirst = false) {
  const ranked = rank(records), control = ranked.find(r => r.candidate_id === controlId);
  if (!control) fail('NO_VALID_CONTROL');
  const nearest = ranked.find(r => r.candidate_id !== controlId && (!recognitionFirst || preservesRecognition(r, control))) ?? null;
  const improved = nearest && nearest.metrics.product_loss < control.metrics.product_loss - POLICY.epsilon;
  const selected = improved ? nearest : control;
  const costs = tradeoffs(selected.metrics, control.metrics);
  const compromise = ranked.find(r => r.candidate_id !== controlId && [2, 3].every(n => {
    const a = r.metrics[`target_ge${n}`].recall, b = control.metrics[`target_ge${n}`].recall;
    return a == null || b == null || a >= b - POLICY.epsilon;
  })) ?? null;
  return { ...POLICY, ...(recognitionFirst ? { recognition_policy: RECOGNITION_POLICY, selection_mode: 'RECOGNITION_FIRST' } : {}), phase7_completed: true, trial_config_available: true,
    selection_status: improved ? costs.length ? 'SELECTED_WITH_TRADEOFFS' : 'SELECTED_IMPROVED' : 'KEEP_CONTROL',
    wiring_status: wiringStatus, selected_candidate: selected.candidate_id, control_candidate: controlId,
    selected_effective_config: 'selected_effective_config.json', rollback_config: 'rollback_config.json',
    metrics_vs_control: { selected: selected.metrics, control: control.metrics,
      delta_product_loss: q(selected.metrics.product_loss - control.metrics.product_loss) },
    tradeoffs: costs, critical_risk: selected.metrics.critical_overprediction,
    lowest_loss_candidate: ranked[0].candidate_id, nearest_non_control: nearest?.candidate_id ?? null,
    recognition_compromise: compromise?.candidate_id ?? null, selection_is_independent_validation: false };
}
