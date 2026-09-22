import { canonicalJson, compare, fail, hash } from '../../dataset/lib/common.mjs';
import { computeHeadlineMetrics, formatMetric } from '../../evaluation/metrics.mjs';
import { silentProgress } from '../../progress.mjs';
import { candidatePolicy } from '../candidate-policy.mjs';
import { buildModelConfig, cloneConfig, resolvePath, writePath } from './base-config.mjs';
import { validateBaseConfig } from './constraints.mjs';
import { computeControl, coverageFor, ordinalOf } from './experiment.mjs';
import { metricPair, weightedRows } from './metrics.mjs';
import { objectiveFor, rankCandidates } from './objective.mjs';

/**
 * Candidate evaluation. Sensitivity keeps its one-unit-per-experiment rule so a probe can be
 * attributed to a single Parameter Registry unit; a candidate vector is the opposite case and
 * is allowed to move several units at once, because V2.5.3 searches the joint space.
 */

function reject(reason_code, detail) {
  return { ok: false, reason_code, detail };
}

function unitIndex(units) {
  return new Map(units.map(unit => [unit.parameter_id, unit]));
}

const CANDIDATE_DECIMALS = 12;

function quantize(value) {
  const rounded = Number(Number(value).toFixed(CANDIDATE_DECIMALS));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Reads a `{ parameter_id: value }` vector into flat changes. A SIMPLEX unit takes a
 * `{ member: value }` object; every other unit takes a scalar. Out-of-registry or
 * non-optimizable entries are refused here, but value constraints are checked after the
 * vector is installed, so MIN_MAX / DEPENDENT / MONOTONIC see the whole candidate config.
 */
export function normalizeCandidate(vector, units) {
  if (vector === null || typeof vector !== 'object' || Array.isArray(vector)) {
    return reject('VECTOR_NOT_OBJECT', vector);
  }
  const index = unitIndex(units);
  const changes = [];
  const normalized = {};
  for (const parameterId of Object.keys(vector).sort(compare)) {
    const unit = index.get(parameterId);
    if (!unit) return reject('UNKNOWN_PARAMETER', parameterId);
    if (unit.unit_category === 'DIAGNOSTIC' || unit.optimizable !== true) {
      return reject('PARAMETER_NOT_OPTIMIZABLE', parameterId);
    }
    const value = vector[parameterId];
    if (unit.unit_category === 'SIMPLEX') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return reject('SIMPLEX_VECTOR_MALFORMED', parameterId);
      }
      const members = Object.keys(value).sort(compare);
      if (!members.length) return reject('SIMPLEX_VECTOR_EMPTY', parameterId);
      for (const member of members) {
        if (!unit.members.includes(member)) return reject('UNKNOWN_SIMPLEX_MEMBER', `${parameterId}.${member}`);
        if (!Number.isFinite(value[member])) return reject('PARAMETER_NOT_NUMERIC', `${parameterId}.${member}`);
        changes.push({
          unit, parameter_id: parameterId, member, path: `${unit.canonical_path}.${member}`, value: quantize(value[member])
        });
      }
      normalized[parameterId] = Object.fromEntries(members.map(member => [member, quantize(value[member])]));
      continue;
    }
    if (unit.unit_category !== 'OAT') return reject('UNSUPPORTED_UNIT_CATEGORY', parameterId);
    if (!Number.isFinite(value)) return reject('PARAMETER_NOT_NUMERIC', parameterId);
    changes.push({ unit, parameter_id: parameterId, member: null, path: unit.canonical_path, value: quantize(value) });
    normalized[parameterId] = quantize(value);
  }
  return { ok: true, changes, vector: normalized };
}

/** Flat, serialisable view of a change list; the registry unit itself stays internal. */
function publicChanges(changes) {
  return changes.map(change => ({
    parameter_id: change.parameter_id, member: change.member, path: change.path, value: change.value
  }));
}

/**
 * Installs a normalized vector onto a clone of the frozen base config. A SIMPLEX group whose
 * members are only partly given keeps the remaining members at their relative proportions,
 * which is the same renormalisation rule the single-member probe path uses.
 */
function installCandidate(config, changes) {
  const next = cloneConfig(config);
  const byUnit = new Map();
  for (const change of changes) {
    if (!byUnit.has(change.parameter_id)) byUnit.set(change.parameter_id, []);
    byUnit.get(change.parameter_id).push(change);
  }
  const composition = {};
  for (const [parameterId, group] of byUnit) {
    if (group[0].member === null) {
      writePath(next, group[0].path, group[0].value);
      continue;
    }
    const path = group[0].path.slice(0, group[0].path.lastIndexOf('.'));
    const base = resolvePath(next, path).value;
    const given = new Map(group.map(change => [change.member, change.value]));
    const allMembers = group[0].unit.members;
    const unspecified = allMembers.filter(name => !given.has(name));
    const remaining = 1 - [...given.values()].reduce((sum, value) => sum + value, 0);
    const othersSum = unspecified.reduce((sum, name) => sum + Number(base[name]), 0);
    const expanded = allMembers.map(name => given.has(name)
      ? given.get(name)
      : (othersSum > 0 ? remaining * (Number(base[name]) / othersSum) : remaining / unspecified.length));
    const expandedSum = expanded.reduce((sum, value) => sum + value, 0);
    const quantized = expanded.map(quantize);
    // A valid SIMPLEX expansion sums to one before quantization. Put the rounding residual on
    // the declared final member so equivalent partial/full spellings produce identical bytes.
    if (Math.abs(expandedSum - 1) <= 1e-9 && quantized.length) {
      quantized[quantized.length - 1] = quantize(1 - quantized.slice(0, -1).reduce((sum, value) => sum + value, 0));
    }
    for (let index = 0; index < allMembers.length; index++) base[allMembers[index]] = quantized[index];
    composition[parameterId] = Object.fromEntries(allMembers.map(name => [name, base[name]]));
  }
  return { config: next, composition };
}

/** Deterministic identity of a vector: same parameters, same values, same candidate id. */
export function candidateIdFor(vector) {
  return `candidate_${hash(canonicalJson(vector)).slice(0, 12)}`;
}

/**
 * Resolves a raw vector into an installable candidate: normalises, installs, then runs the full
 * declared-constraint check against the installed config. Any failure is a policy-level
 * INFEASIBLE, never an exception, because V2.5.3 needs to skip such points and keep searching.
 */
export function resolveCandidate({ vector, units, config }) {
  const normalized = normalizeCandidate(vector, units);
  if (!normalized.ok) {
    return { ...normalized, status: 'INFEASIBLE', candidate_id: null, vector: null, changes: [], config: null, composition: null };
  }
  const installed = installCandidate(config, normalized.changes);
  const candidateId = candidateIdFor(normalized.vector);
  try {
    validateBaseConfig(units, installed.config);
  } catch (error) {
    return {
      ok: false,
      status: 'INFEASIBLE',
      reason_code: error.reason_code || error.code || 'CONSTRAINT_VIOLATION',
      detail: error.detail ?? null,
      candidate_id: candidateId,
      vector: normalized.vector,
      changes: publicChanges(normalized.changes),
      config: null,
      composition: null
    };
  }
  return {
    ok: true,
    status: 'FEASIBLE',
    candidate_id: candidateId,
    vector: normalized.vector,
    changes: publicChanges(normalized.changes),
    config: installed.config,
    composition: Object.keys(installed.composition).length ? installed.composition : null
  };
}

/** Candidate-side headline metrics. The objective reads `metrics[weighting][metric]`. */
function headlineBundle(rows, scoreKey) {
  const weighted = weightedRows(rows, scoreKey);
  return {
    weighted: computeHeadlineMetrics(weighted, 'weighted'),
    unweighted: computeHeadlineMetrics(weighted, 'unweighted')
  };
}

function controlRowsFor(control, cohort) {
  return control.map(base => ({
    snapshot_id: base.snapshot_id,
    gt_ordinal: cohort[base.index].gt_ordinal,
    event_normalized_weight: cohort[base.index].event_normalized_weight,
    control_score: base.control_score
  }));
}

/**
 * Runs Tuning Control once for a cohort so every candidate in a batch is scored against the
 * same paired baseline. Building this is the expensive half; evaluating a vector is not.
 */
export async function prepareCandidateRun({ cohort, config, units, runReplay, progress = silentProgress, policy = candidatePolicy() }) {
  if (policy !== candidatePolicy()) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_CANDIDATE_POLICY' });
  }
  validateBaseConfig(units, config);
  const { control, controlFailures } = await computeControl({ cohort, config, runReplay, progress });
  return {
    cohort, config, units, runReplay, progress, policy, control, controlFailures,
    controlMetrics: headlineBundle(controlRowsFor(control, cohort), 'control_score')
  };
}

/**
 * Shared Candidate replay. Both the aggregate evaluator and the V2.5.3 detailed evaluator read
 * their paired rows from here, so the two paths can never drift apart.
 */
async function replayPairedRows({ prepared, vector }) {
  const { cohort, units, config, control, controlFailures, runReplay } = prepared;
  const resolved = resolveCandidate({ vector, units, config });
  if (resolved.status === 'INFEASIBLE') {
    return { resolved, rows: [], experimentFailureCount: 0, modelConfig: null };
  }

  const modelConfig = buildModelConfig(resolved.config);
  const rows = [];
  let experimentFailureCount = 0;
  for (const controlRow of control) {
    const cohortRow = cohort[controlRow.index];
    let report;
    try {
      report = await runReplay(cohortRow.replay, { modelConfig });
    } catch {
      // A Snapshot the candidate cannot score leaves only this candidate's paired cohort.
      experimentFailureCount++;
      continue;
    }
    const experimentScore = report.actual.score;
    const experimentOrdinal = ordinalOf(experimentScore);
    rows.push({
      snapshot_id: cohortRow.snapshot_id,
      event_id: cohortRow.event_id,
      event_date_local: cohortRow.event_date_local,
      city: cohortRow.city,
      location_key: cohortRow.location_key,
      lead_time_bucket: cohortRow.lead_time_bucket,
      gt_label: cohortRow.gt_label,
      gt_ordinal: cohortRow.gt_ordinal,
      gt_confidence: cohortRow.gt_confidence,
      event_normalized_weight: cohortRow.event_normalized_weight,
      gt_status: cohortRow.gt_status ?? null,
      gt_basis: cohortRow.gt_basis ?? null,
      regime_label: cohortRow.regime_label ?? null,
      sky_evolution_state: cohortRow.sky_evolution_state ?? null,
      scheduled_slot: cohortRow.scheduled_slot ?? null,
      snapshot_source: cohortRow.snapshot_source ?? null,
      tile_radar_available: cohortRow.tile_radar_available ?? null,
      tile_sat_available: cohortRow.tile_sat_available ?? null,
      control_score: controlRow.control_score,
      experiment_score: experimentScore,
      score_delta: experimentScore - controlRow.control_score,
      control_ordinal: controlRow.control_ordinal,
      experiment_ordinal: experimentOrdinal,
      ordinal_delta: experimentOrdinal - controlRow.control_ordinal,
      control_abs_error: Math.abs(controlRow.control_ordinal - cohortRow.gt_ordinal),
      experiment_abs_error: Math.abs(experimentOrdinal - cohortRow.gt_ordinal),
      abs_error_delta: Math.abs(experimentOrdinal - cohortRow.gt_ordinal) -
        Math.abs(controlRow.control_ordinal - cohortRow.gt_ordinal)
    });
  }
  return { resolved, rows, experimentFailureCount, modelConfig, controlFailures };
}

/**
 * V2.5.3 detailed interface. `evaluateCandidate` only publishes aggregates, which is enough for
 * the Sensitivity package but not for Date Robustness, Slice Regression or the two-denominator
 * Coverage gate. This returns the paired rows plus the Control/vs-Cohort accounting that the
 * Optimization Policy needs, and leaves the Phase 5 evaluator untouched.
 */
export async function evaluateCandidateDetailed({ prepared, vector }) {
  const { cohort, control, controlFailures } = prepared;
  const replayed = await replayPairedRows({ prepared, vector });
  const { resolved, rows, experimentFailureCount } = replayed;
  const coverage = {
    cohort_sample_count: cohort.length,
    control_success_count: control.length,
    candidate_success_count: rows.length,
    control_failure_count: controlFailures.length,
    candidate_failure_count: experimentFailureCount,
    control_source_coverage_rate: cohort.length ? formatMetric(control.length / cohort.length) : null,
    candidate_control_coverage_rate: control.length ? formatMetric(rows.length / control.length) : null
  };
  if (resolved.status === 'INFEASIBLE') {
    return {
      status: 'INFEASIBLE', reason_code: resolved.reason_code, detail: resolved.detail ?? null,
      candidate: resolved, rows: [], coverage, config: null
    };
  }
  if (!control.length) {
    return {
      status: 'UNEVALUABLE', reason_code: 'CONTROL_HAS_NO_SUCCESSFUL_REPLAY', detail: null,
      candidate: resolved, rows: [], coverage, config: resolved.config
    };
  }
  if (!rows.length) {
    return {
      status: 'UNEVALUABLE', reason_code: 'CANDIDATE_HAS_NO_SUCCESSFUL_REPLAY', detail: null,
      candidate: resolved, rows, coverage, config: resolved.config
    };
  }
  return {
    status: 'EVALUABLE', reason_code: null, detail: null,
    candidate: resolved, rows, coverage, config: resolved.config
  };
}

/** One vector -> objective value, under the policy's constraint and coverage gates. */
export async function evaluateCandidate({ prepared, vector, label = null }) {
  const { cohort, controlFailures, policy, controlMetrics } = prepared;
  const replayed = await replayPairedRows({ prepared, vector });
  const { resolved, rows, experimentFailureCount } = replayed;
  const base = {
    candidate_id: resolved.candidate_id,
    candidate_label: label,
    vector: resolved.vector ?? null,
    changes: resolved.changes ?? null,
    composition: resolved.composition ?? null,
    control_metrics: { weighted: controlMetrics.weighted }
  };
  if (resolved.status === 'INFEASIBLE') {
    return {
      ...base, status: 'INFEASIBLE', reason_code: resolved.reason_code, detail: resolved.detail ?? null,
      coverage: null, metrics: null, deltas: null, objective: null, objective_value: null
    };
  }
  const coverage = coverageFor({
    cohortSampleCount: cohort.length,
    pairedRows: rows,
    controlFailureCount: controlFailures.length,
    experimentFailureCount
  });
  const minCoverageRate = policy.infeasibility.min_coverage_rate;
  if (coverage.coverage_rate === null || coverage.coverage_rate < minCoverageRate) {
    return {
      ...base, status: policy.infeasibility.coverage_below_minimum, reason_code: 'COVERAGE_BELOW_MINIMUM',
      detail: { coverage_rate: coverage.coverage_rate, min_coverage_rate: minCoverageRate },
      coverage, metrics: null, deltas: null, objective: null, objective_value: null
    };
  }

  const pair = metricPair(rows);
  const metrics = headlineBundle(rows, 'experiment_score');
  const objective = objectiveFor(metrics, policy.objective);
  return {
    ...base,
    status: 'FEASIBLE',
    reason_code: null,
    detail: null,
    coverage,
    metrics,
    deltas: pair.deltas,
    objective,
    objective_value: objective.primary.value
  };
}

/** Batch entry point: evaluate every vector against one Control, then rank the batch. */
export async function evaluateCandidates({ prepared, vectors, labels = [] }) {
  const results = [];
  for (let index = 0; index < vectors.length; index++) {
    results.push(await evaluateCandidate({ prepared, vector: vectors[index], label: labels[index] ?? null }));
    prepared.progress.update(`已评估 ${index + 1}/${vectors.length} 个候选点`);
  }
  return {
    candidate_policy_version: prepared.policy.candidate_policy_version,
    cohort_sample_count: prepared.cohort.length,
    control_failure_count: prepared.controlFailures.length,
    control_metrics: { weighted: prepared.controlMetrics.weighted },
    results: rankCandidates(results, prepared.policy.objective).map((result, index) => ({ ...result, rank: index + 1 }))
  };
}
