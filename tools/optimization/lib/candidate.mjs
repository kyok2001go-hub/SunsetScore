import { canonicalJson, compare, hash } from '../../dataset/lib/common.mjs';
import { resolveCandidate } from '../../tuning/lib/candidate.mjs';
import { resolvePath } from '../../tuning/lib/base-config.mjs';

/**
 * Candidate identity is defined on the final effective configuration, not on the raw input
 * vector. `{}`, an explicit restatement of every baseline value and a differently spelled but
 * equivalent SIMPLEX vector therefore collapse to one Candidate and one Replay.
 */

function unitRange(unit) {
  if (Array.isArray(unit.range)) return unit.range[1] - unit.range[0];
  return 1;
}

function unitOrderOf(searchSpace) {
  return searchSpace.unit_order;
}

function unitEntry(searchSpace, parameterId) {
  return searchSpace.units.find(unit => unit.parameter_id === parameterId);
}

function serializeValue(value) {
  return canonicalJson(value);
}

/**
 * Installs a raw vector on the frozen base config and derives the canonical Candidate.
 * Returns an INFEASIBLE record instead of throwing: the search treats an invalid point as a
 * skipped neighbourhood, not as a failed campaign.
 */
export function canonicalizeCandidate({ vector, searchSpace, baseConfig, optimizationInputId }) {
  const units = Object.values(searchSpace.registry_units);
  const resolved = resolveCandidate({ vector, units, config: baseConfig.config });
  if (resolved.status === 'INFEASIBLE') {
    const attemptedVector = resolved.vector ?? vector;
    return {
      ok: false,
      status: 'INFEASIBLE',
      reason_code: resolved.reason_code,
      detail: resolved.detail ?? null,
      candidate_id: null,
      canonical_vector: attemptedVector,
      effective_config: null,
      effective_config_sha256: null,
      changes: [],
      changed_unit_count: 0,
      normalized_parameter_distance: null,
      baseline_equivalent: false
    };
  }
  const order = unitOrderOf(searchSpace);
  const canonicalVector = {};
  const changes = [];
  let changedUnitCount = 0;
  let distance = 0;
  for (const parameterId of order) {
    const unit = searchSpace.registry_units[parameterId];
    const baseline = resolvePath(baseConfig.config, unit.canonical_path).value;
    const current = resolvePath(resolved.config, unit.canonical_path).value;
    if (unit.unit_category === 'SIMPLEX') {
      const members = [...unit.members].sort(compare);
      const changed = members.filter(member => Number(current[member]) !== Number(baseline[member]));
      if (!changed.length) continue;
      changedUnitCount += 1;
      canonicalVector[parameterId] = Object.fromEntries(members.map(member => [member, Number(current[member])]));
      for (const member of members) {
        const delta = Number(current[member]) - Number(baseline[member]);
        if (delta === 0) continue;
        distance += Math.abs(delta) / unitRange(unit);
        changes.push({
          parameter_id: parameterId, member, path: `${unit.canonical_path}.${member}`,
          baseline_value: Number(baseline[member]), value: Number(current[member]), delta
        });
      }
      continue;
    }
    if (Number(current) === Number(baseline)) continue;
    changedUnitCount += 1;
    const value = Number(current);
    canonicalVector[parameterId] = value;
    const delta = value - Number(baseline);
    distance += Math.abs(delta) / unitRange(unit);
    changes.push({
      parameter_id: parameterId, member: null, path: unit.canonical_path,
      baseline_value: Number(baseline), value, delta
    });
  }
  const effectiveConfigSha256 = hash(canonicalJson(resolved.config));
  const candidateId = `candidate_${hash(canonicalJson({
    optimization_input_id: optimizationInputId,
    canonical_effective_config_sha256: effectiveConfigSha256
  })).slice(0, 12)}`;
  return {
    ok: true,
    status: 'FEASIBLE',
    reason_code: null,
    detail: null,
    candidate_id: candidateId,
    canonical_vector: canonicalVector,
    effective_config: resolved.config,
    effective_config_sha256: effectiveConfigSha256,
    changes,
    changed_unit_count: changedUnitCount,
    normalized_parameter_distance: changedUnitCount ? Number(distance.toFixed(12)) : 0,
    baseline_equivalent: changedUnitCount === 0
  };
}

/** Canonical identity key used for de-duplication before any Replay happens. */
export function candidateKey(candidate) {
  if (candidate.status !== 'FEASIBLE') {
    // Distinct invalid points each consume budget; only the same normalized attempted point is
    // a duplicate. The reason remains part of the key because it is part of the audit result.
    return `INFEASIBLE|${serializeValue(candidate.canonical_vector)}|${candidate.reason_code}|${serializeValue(candidate.detail ?? null)}`;
  }
  return `FEASIBLE|${candidate.effective_config_sha256}`;
}

/** Scale-free distance summary for the complexity tie-break. */
export function complexityOf(candidate) {
  return {
    changed_unit_count: candidate.changed_unit_count,
    normalized_parameter_distance: candidate.normalized_parameter_distance
  };
}

export function candidateUnitEntry(searchSpace, parameterId) {
  return unitEntry(searchSpace, parameterId);
}
