import { fail } from '../../dataset/lib/common.mjs';
import { resolvePath } from './base-config.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';

const SIMPLEX_TOLERANCE = 1e-9;

const ORDER_CHECKS = Object.freeze({
  STRICTLY_INCREASING: (previous, current) => current > previous,
  NON_DECREASING: (previous, current) => current >= previous,
  STRICTLY_DECREASING: (previous, current) => current < previous,
  NON_INCREASING: (previous, current) => current <= previous
});

function reject(reason_code, detail) {
  fail('TUNING_VALIDATION_FAILED', { reason_code, detail });
}

function roundProbe(value, integer) {
  if (!Number.isFinite(value)) reject('PROBE_NOT_FINITE', value);
  return integer ? Math.round(value) : Number(value.toFixed(6));
}

/** Probe values for one OAT unit, derived from the frozen baseline. */
export function probeValues(unit, baseline) {
  const base = Number(baseline);
  if (!Number.isFinite(base)) reject('BASELINE_NOT_NUMERIC', { parameter_id: unit.parameter_id, baseline });
  const raw = unit.probe_absolute
    ? [...unit.probe_absolute]
    : (unit.probe_offsets || []).map(offset => base * (1 + offset));
  const values = [...new Set(raw.map(value => roundProbe(value, unit.integer)))];
  if (values.length < 2) reject('INSUFFICIENT_PROBES', { parameter_id: unit.parameter_id });
  return values.sort((a, b) => a - b);
}

/** Probe values for one SIMPLEX member: perturb it, remaining members keep proportions. */
export function simplexProbes(unit, baselineGroup) {
  const probes = [];
  for (const member of unit.members) {
    const base = Number(baselineGroup[member]);
    if (!Number.isFinite(base)) reject('SIMPLEX_MEMBER_NOT_NUMERIC', { group_id: unit.parameter_id, member });
    for (const factor of unit.probe_factors) {
      const value = roundProbe(base * factor, false);
      if (value <= 0 || value >= 1) continue;
      probes.push({ member, value, factor });
    }
  }
  if (!probes.length) reject('INSUFFICIENT_PROBES', { parameter_id: unit.parameter_id });
  return probes;
}

export function validateUnitValue(unit, value, config) {
  const integer = unit.integer;
  if (Array.isArray(unit.enum_values) && !unit.enum_values.includes(value)) {
    reject('ENUM_CONSTRAINT_VIOLATION', { parameter_id: unit.parameter_id, value, enum_values: unit.enum_values });
  }
  if (integer && !Number.isInteger(value)) {
    reject('INTEGER_CONSTRAINT_VIOLATION', { parameter_id: unit.parameter_id, value });
  }
  if (Array.isArray(unit.range) && (value < unit.range[0] || value > unit.range[1])) {
    reject('RANGE_CONSTRAINT_VIOLATION', { parameter_id: unit.parameter_id, value, range: unit.range });
  }
  if (unit.pair_constraint) {
    const sibling = resolvePath(config, unit.pair_constraint.sibling_path);
    if (!sibling.exists) reject('PAIR_SIBLING_MISSING', { parameter_id: unit.parameter_id });
    if (unit.pair_constraint.relation === 'LESS_THAN_OR_EQUAL' && !(value <= sibling.value)) {
      reject('MIN_MAX_CONSTRAINT_VIOLATION', { parameter_id: unit.parameter_id, value, sibling: sibling.value });
    }
  }
  if (unit.depends_on) {
    const dependency = resolvePath(config, unit.depends_on.path);
    if (!dependency.exists) reject('DEPENDENT_TARGET_MISSING', { parameter_id: unit.parameter_id });
    if (dependency.value !== unit.depends_on.equals) {
      reject('DEPENDENT_CONSTRAINT_VIOLATION', {
        parameter_id: unit.parameter_id, dependency: unit.depends_on.path, actual: dependency.value
      });
    }
  }
}

/** Validates the frozen base config itself against every declared constraint. */
export function validateBaseConfig(units, config) {
  const policy = tuningPolicy();
  const checked = [];
  for (const unit of units) {
    const resolved = resolvePath(config, unit.canonical_path);
    if (!resolved.exists) reject('PARAMETER_PATH_UNRESOLVED', unit.canonical_path);
    if (unit.unit_category === 'SIMPLEX') {
      const members = unit.members.map(name => {
        const value = Number(resolved.value[name]);
        if (!Number.isFinite(value)) reject('SIMPLEX_MEMBER_NOT_NUMERIC', { group_id: unit.parameter_id, member: name });
        return value;
      });
      const sum = members.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > SIMPLEX_TOLERANCE) {
        reject('SIMPLEX_SUM_VIOLATION', { group_id: unit.parameter_id, sum });
      }
      checked.push({ parameter_id: unit.parameter_id, constraint: 'SIMPLEX', sum });
      continue;
    }
    if (unit.unit_category === 'OAT') validateUnitValue(unit, resolved.value, config);
    checked.push({ parameter_id: unit.parameter_id, constraint: unit.integer ? 'INTEGER' : 'RANGE' });
  }
  for (const rule of policy.declared_constraints.monotonic) {
    const list = resolvePath(config, rule.path);
    if (!list.exists || !Array.isArray(list.value)) reject('MONOTONIC_TARGET_MISSING', rule.path);
    const values = list.value.map(entry => Number(entry[rule.member_key]));
    const compare = ORDER_CHECKS[rule.order];
    if (!compare) reject('UNKNOWN_MONOTONIC_ORDER', { group_id: rule.group_id, order: rule.order });
    for (let i = 1; i < values.length; i++) {
      if (!compare(values[i - 1], values[i])) {
        reject('MONOTONIC_CONSTRAINT_VIOLATION', { group_id: rule.group_id, order: rule.order, index: i, values });
      }
    }
    checked.push({ parameter_id: rule.group_id, constraint: 'MONOTONIC', values });
  }
  return checked;
}

export function constraintTypesFor(unit) {
  if (unit.unit_category === 'SIMPLEX') return ['SIMPLEX', ...unit.extra_constraint_types];
  if (unit.unit_category === 'DIAGNOSTIC') return ['NONE', ...unit.extra_constraint_types];
  if (Array.isArray(unit.enum_values)) return ['ENUM', ...unit.extra_constraint_types].filter((v, i, a) => a.indexOf(v) === i);
  return [unit.integer ? 'INTEGER' : 'RANGE', 'RANGE', ...unit.extra_constraint_types].filter((v, i, a) => a.indexOf(v) === i);
}
