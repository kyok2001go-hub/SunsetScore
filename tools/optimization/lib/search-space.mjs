import { canonicalJson, compare, fail, hash } from '../../dataset/lib/common.mjs';
import { probeValues } from '../../tuning/lib/constraints.mjs';
import { resolvePath } from '../../tuning/lib/base-config.mjs';
import { optimizationPolicy } from '../optimization-policy.mjs';

export const CANDIDATE_NORMALIZATION_VERSION = 1;

const ELIGIBLE_READINESS = Object.freeze({
  EXPLORATORY_SEARCH: ['READY', 'EXPLORATORY'],
  FORMAL_OPTIMIZATION: ['READY']
});

function reject(reason_code, detail) {
  fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code, detail });
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Frozen Sensitivity evidence carried into search_space.json for every declared Unit. */
function sensitivityEvidence(linkage, row) {
  return {
    sensitivity_id: linkage.sensitivity_id,
    parameter_registry_sha256: linkage.parameter_registry_sha256,
    observability_status: row?.observability_status ?? null,
    parameter_readiness: row?.parameter_readiness ?? null,
    reason_code: row?.reason_code ?? null,
    support_samples: row?.support_samples ?? null,
    support_events: row?.support_events ?? null,
    support_dates: row?.support_dates ?? null,
    metric_usage: row?.metric_usage ?? null
  };
}

/** Coarse step for local refinement: the registry probe spacing, halved per refinement round. */
function refinementStepFor(unit, coarseValues) {
  if (coarseValues.length >= 2) {
    const sorted = [...new Set(coarseValues)].sort((a, b) => a - b);
    const gaps = [];
    for (let index = 1; index < sorted.length; index++) gaps.push(sorted[index] - sorted[index - 1]);
    const step = median(gaps);
    if (Number.isFinite(step) && step > 0) return Number(step.toFixed(12));
  }
  if (Array.isArray(unit.range)) return Number(((unit.range[1] - unit.range[0]) / 20).toFixed(12));
  return null;
}

/**
 * Frozen Search Space for one campaign. Declared membership comes from the Policy; eligibility
 * comes from the frozen Registry plus the Sensitivity readiness report, never from a live
 * repository constant. Any change here changes `optimization_input_id`.
 */
export function buildSearchSpace({ mode, registry, readiness, baseConfig, linkage }) {
  const policy = optimizationPolicy();
  const declared = policy.search_space.declared_units;
  if (hash(canonicalJson(registry)) !== linkage.parameter_registry_sha256) {
    reject('PARAMETER_REGISTRY_SHA_MISMATCH');
  }
  const unitById = new Map(registry.units.map(unit => [unit.parameter_id, unit]));
  const readinessById = new Map((readiness.parameter_readiness || []).map(row => [row.parameter_id, row]));
  const units = [];
  const excluded = [];
  declared.forEach((parameterId, index) => {
    const unit = unitById.get(parameterId);
    if (!unit) {
      excluded.push({ parameter_id: parameterId, reason_code: 'DECLARED_UNIT_MISSING_FROM_REGISTRY' });
      return;
    }
    const row = readinessById.get(parameterId) || null;
    const reasons = [];
    if (unit.optimizable !== true) reasons.push('PARAMETER_NOT_OPTIMIZABLE');
    if (unit.wired_status !== 'WIRED') reasons.push('WIRING_STATUS_NOT_READY');
    if (unit.replay_class !== 'REPLAY_SAFE') reasons.push('REPLAY_CLASS_NOT_SAFE');
    if (!['OAT', 'SIMPLEX'].includes(unit.unit_category)) reasons.push('UNSUPPORTED_UNIT_CATEGORY');
    if (!row) reasons.push('SENSITIVITY_EVIDENCE_MISSING');
    if (row && row.observability_status === 'NOT_OBSERVABLE') reasons.push('NO_SCORE_RESPONSE_ON_COHORT');
    if (row && !ELIGIBLE_READINESS[mode].includes(row.parameter_readiness)) {
      reasons.push('PARAMETER_READINESS_BELOW_MODE_REQUIREMENT');
    }
    if (reasons.length) {
      excluded.push({ parameter_id: parameterId, reason_code: reasons[0], reasons: [...new Set(reasons)].sort(compare) });
      units.push({
        unit_order: index + 1, parameter_id: parameterId, group_id: unit.group_id ?? null,
        unit_category: unit.unit_category, canonical_path: unit.canonical_path,
        parameter_type: unit.unit_category,
        allowed_range: Array.isArray(unit.range) ? [...unit.range] : null,
        refinement_rule: null,
        sensitivity_evidence: sensitivityEvidence(linkage, row),
        baseline_value: null, included: false, exclusion_reason: reasons[0],
        observability_status: row?.observability_status ?? null,
        parameter_readiness: row?.parameter_readiness ?? null,
        wired_status: unit.wired_status ?? null, replay_class: unit.replay_class ?? null,
        constraint_type: null, support_events: row?.support_events ?? null, support_dates: row?.support_dates ?? null
      });
      return;
    }
    const resolved = resolvePath(baseConfig.config, unit.canonical_path);
    if (!resolved.exists) reject('PARAMETER_PATH_UNRESOLVED', unit.canonical_path);
    const entry = {
      unit_order: index + 1, parameter_id: parameterId, group_id: unit.group_id ?? null,
      unit_category: unit.unit_category, canonical_path: unit.canonical_path,
      parameter_type: unit.unit_category,
      allowed_range: Array.isArray(unit.range) ? [...unit.range] : null,
      sensitivity_evidence: sensitivityEvidence(linkage, row),
      included: true, exclusion_reason: null,
      observability_status: row.observability_status, parameter_readiness: row.parameter_readiness,
      wired_status: unit.wired_status, replay_class: unit.replay_class,
      constraint_type: unit.unit_category === 'SIMPLEX' ? 'SIMPLEX' : (unit.integer ? 'INTEGER' : 'RANGE'),
      support_events: row.support_events ?? null, support_dates: row.support_dates ?? null
    };
    if (unit.unit_category === 'SIMPLEX') {
      const members = [...unit.members].sort(compare);
      const baseline = {};
      for (const member of members) {
        const value = Number(resolved.value[member]);
        if (!Number.isFinite(value)) reject('SIMPLEX_MEMBER_NOT_NUMERIC', `${parameterId}.${member}`);
        baseline[member] = value;
      }
      entry.members = members;
      entry.baseline_value = baseline;
      entry.probe_factors = [...unit.probe_factors];
      entry.refinement_rule = {
        kind: 'SIMPLEX_MEMBER_FACTOR_HALVING',
        probe_factors: [...unit.probe_factors],
        refinement_rounds: policy.algorithm.refinement_rounds,
        step_factor: policy.algorithm.refinement_step_factor
      };
      units.push(entry);
      return;
    }
    const coarse = probeValues(unit, resolved.value);
    if (coarse.length < 2) reject('INSUFFICIENT_PROBES', parameterId);
    entry.baseline_value = Number(resolved.value);
    entry.coarse_values = coarse;
    entry.integer = unit.integer === true;
    entry.range = Array.isArray(unit.range) ? [...unit.range] : null;
    entry.refinement_step = refinementStepFor(unit, coarse);
    entry.refinement_rule = {
      kind: 'ABSOLUTE_STEP_HALVING',
      coarse_step: entry.refinement_step,
      refinement_rounds: policy.algorithm.refinement_rounds,
      step_factor: policy.algorithm.refinement_step_factor,
      integer: entry.integer
    };
    units.push(entry);
  });
  const active = units.filter(unit => unit.included).map(unit => unit.parameter_id);
  if (!active.length) reject('NO_ELIGIBLE_SEARCH_UNITS', { declared });
  if (mode === 'FORMAL_OPTIMIZATION') {
    const missing = declared.filter(id => !active.includes(id));
    if (missing.length) reject('FORMAL_SEARCH_SPACE_INCOMPLETE', { missing });
  }
  const registryUnits = {};
  for (const unit of registry.units) if (active.includes(unit.parameter_id)) registryUnits[unit.parameter_id] = unit;
  return {
    search_space_id: policy.search_space.id,
    search_space_version: policy.optimization_policy_version,
    candidate_normalization_version: CANDIDATE_NORMALIZATION_VERSION,
    parameter_registry_sha256: linkage.parameter_registry_sha256,
    tuning_base_config_sha256: linkage.tuning_base_config_sha256,
    engine_runtime_sha256: linkage.engine_runtime_sha256,
    unit_order: active,
    declared_units: [...declared],
    excluded_units: excluded,
    numeric_precision_decimal_places: policy.numeric.numeric_precision_decimal_places,
    metric_output_decimal_places: policy.numeric.metric_output_decimal_places,
    metric_compare_epsilon: policy.numeric.metric_compare_epsilon,
    units,
    registry_units: registryUnits
  };
}

export function publicSearchSpace(searchSpace) {
  const { registry_units, base_config, optimization_input_id, ...rest } = searchSpace;
  return rest;
}

export function searchSpaceSha256(searchSpace) {
  return hash(canonicalJson(publicSearchSpace(searchSpace)));
}
