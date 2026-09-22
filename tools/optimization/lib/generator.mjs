import { canonicalJson } from '../../dataset/lib/common.mjs';

/**
 * Deterministic proposal generation. Every stage walks `unit_order` and then the frozen probe
 * values, so a budget cut always truncates at the same point regardless of platform or timing.
 */

/** Named `roundTo` so the refinement round index can never shadow it. */
function roundTo(value, precision) {
  return Number(value.toFixed(precision));
}

function clip(value, range) {
  if (!Array.isArray(range)) return value;
  return Math.min(Math.max(value, range[0]), range[1]);
}

function oatValue(raw, entry, precision) {
  const bounded = clip(raw, entry.range);
  return entry.integer ? Math.round(bounded) : roundTo(bounded, precision);
}

function changeJson(parameterId, member, value) {
  return canonicalJson(member === null ? { parameter_id: parameterId, value } : { parameter_id: parameterId, member, value });
}

/** Member reference values for one SIMPLEX unit: the frozen baseline or the parent Candidate. */
function memberReference(entry, parentVector) {
  const current = parentVector ? parentVector[entry.parameter_id] : null;
  const reference = {};
  for (const member of entry.members) {
    const value = current ? Number(current[member]) : Number(entry.baseline_value[member]);
    reference[member] = Number.isFinite(value) ? value : Number(entry.baseline_value[member]);
  }
  return reference;
}

function simplexProposals(entry, reference, precision) {
  const proposals = [];
  for (const member of entry.members) {
    for (const factor of entry.probe_factors) {
      const value = reference[member] * factor;
      if (!(value > 0) || !(value < 1)) continue;
      proposals.push({ member, factor, value: roundTo(value, precision) });
    }
  }
  return proposals;
}

/**
 * Every single-unit coarse probe for one Unit, in frozen order. Stage A seeds use the baseline
 * as the reference; Stage B expansions use the parent Candidate so a joint vector keeps moving.
 */
export function unitProposals({ entry, parentVector = null, precision }) {
  if (entry.unit_category === 'SIMPLEX') {
    return simplexProposals(entry, memberReference(entry, parentVector), precision)
      .map(item => ({
        member: item.member, factor: item.factor, value: item.value,
        vector: { [entry.parameter_id]: { ...(parentVector?.[entry.parameter_id] || entry.baseline_value), [item.member]: item.value } },
        change_json: changeJson(entry.parameter_id, item.member, item.value)
      }));
  }
  return entry.coarse_values.map(value => ({
    member: null, factor: null, value,
    vector: { ...(parentVector || {}), [entry.parameter_id]: value },
    change_json: changeJson(entry.parameter_id, null, value)
  }));
}

/** Stage A: the frozen single-unit coarse seeds, in unit_order then probe order. */
export function coarseProposals(searchSpace) {
  const precision = searchSpace.numeric_precision_decimal_places;
  const proposals = [];
  for (const parameterId of searchSpace.unit_order) {
    const entry = searchSpace.units.find(unit => unit.parameter_id === parameterId);
    for (const item of unitProposals({ entry, precision })) {
      proposals.push({ stage: 'COARSE_SEED', parameter_id: parameterId, ...item });
    }
  }
  return proposals;
}

/**
 * Stage B: one Coordinate Expansion around a parent Candidate. Every active Unit is moved in
 * turn while the parent's other units stay fixed, which is what forms the joint vectors.
 */
export function coordinateExpansions({ searchSpace, parent }) {
  const precision = searchSpace.numeric_precision_decimal_places;
  const proposals = [];
  for (const parameterId of searchSpace.unit_order) {
    const entry = searchSpace.units.find(unit => unit.parameter_id === parameterId);
    for (const item of unitProposals({ entry, parentVector: parent.canonical_vector, precision })) {
      proposals.push({ stage: 'BEAM', parameter_id: parameterId, ...item });
    }
  }
  return proposals;
}

function currentOf(parent, entry, member) {
  if (member === null) return Number(parent.canonical_vector[entry.parameter_id] ?? entry.baseline_value);
  const group = parent.canonical_vector[entry.parameter_id] || entry.baseline_value;
  return Number(group[member]);
}

/**
 * Stage C: local refinement around a parent Candidate. The coarse step halves each round and is
 * clipped to the declared range, so refinement can never escape the frozen Search Space.
 */
export function refinementProposals({ searchSpace, parent, round, stepFactor = 0.5 }) {
  const precision = searchSpace.numeric_precision_decimal_places;
  const shrink = Math.pow(stepFactor, round);
  const proposals = [];
  for (const parameterId of searchSpace.unit_order) {
    const entry = searchSpace.units.find(unit => unit.parameter_id === parameterId);
    if (entry.unit_category === 'SIMPLEX') {
      for (const member of entry.members) {
        const current = currentOf(parent, entry, member);
        for (const probeFactor of entry.probe_factors) {
          const value = current * (1 + (probeFactor - 1) * shrink);
          if (!(value > 0) || !(value < 1)) continue;
          const rounded = roundTo(value, precision);
          if (rounded === current) continue;
          proposals.push({
            stage: 'REFINEMENT', parameter_id: parameterId, member, factor: probeFactor, value: rounded,
            vector: { ...parent.canonical_vector, [parameterId]: { ...(parent.canonical_vector[parameterId] || entry.baseline_value), [member]: rounded } },
            change_json: changeJson(parameterId, member, rounded)
          });
        }
      }
      continue;
    }
    if (!Number.isFinite(entry.refinement_step) || entry.refinement_step <= 0) continue;
    const current = currentOf(parent, entry, null);
    for (const direction of [-1, 1]) {
      const value = oatValue(current + direction * entry.refinement_step * shrink, entry, precision);
      if (value === current) continue;
      proposals.push({
        stage: 'REFINEMENT', parameter_id: parameterId, member: null, factor: direction, value,
        vector: { ...parent.canonical_vector, [parameterId]: value },
        change_json: changeJson(parameterId, null, value)
      });
    }
  }
  return proposals;
}
