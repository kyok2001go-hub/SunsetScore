import { canonicalJson, errorCode, fail } from '../../dataset/lib/common.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';
import { silentProgress } from '../../progress.mjs';
import { resolvePath, buildModelConfig, cloneConfig, applyUnitOverride, applyAblationOverride } from './base-config.mjs';
import { probeValues, simplexProbes, validateUnitValue, validateBaseConfig } from './constraints.mjs';

export function ordinalOf(score) {
  return [20, 40, 60, 90].filter(min => score >= min).length;
}

/**
 * Tuning Control: one replay per Snapshot with the frozen base config. Shared by the
 * sensitivity plan and the single-candidate evaluator so both compare against the same basis.
 */
export async function computeControl({ cohort, config, runReplay, progress = silentProgress }) {
  progress.stage('重算 Tuning Control');
  const controlConfig = buildModelConfig(cloneConfig(config));
  const control = [];
  const controlFailures = [];
  for (let index = 0; index < cohort.length; index++) {
    const row = cohort[index];
    let report;
    try {
      report = await runReplay(row.replay, { modelConfig: controlConfig });
    } catch (error) {
      // A Snapshot without a Control score cannot be compared on either side, so it leaves
      // the cohort for every experiment.
      controlFailures.push(failureRecord('CONTROL', null, row, error));
      continue;
    }
    control.push({
      index,
      snapshot_id: row.snapshot_id,
      control_score: report.actual.score,
      control_ordinal: ordinalOf(report.actual.score),
      control_gw_factor: report.actual.gw_factor,
      control_sky_evolution_factor: report.actual.sky_evolution_factor
    });
  }
  return { control, controlFailures };
}

/** Paired cohort accounting. `paired_sample_count` is the metric basis on both paths. */
export function coverageFor({ cohortSampleCount, pairedRows, controlFailureCount, experimentFailureCount }) {
  const pairedSampleCount = pairedRows.length;
  return {
    cohort_sample_count: cohortSampleCount,
    paired_sample_count: pairedSampleCount,
    paired_event_count: new Set(pairedRows.map(row => row.event_id)).size,
    coverage_rate: cohortSampleCount ? formatMetric(pairedSampleCount / cohortSampleCount) : null,
    failure_count: cohortSampleCount - pairedSampleCount,
    control_failure_count: controlFailureCount,
    experiment_failure_count: experimentFailureCount
  };
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_]+/g, '_');
}

function experimentId(kind, parts) {
  return [kind.toLowerCase(), ...parts.map(slug)].join('_');
}

/** Deterministic experiment plan: OAT probes, SIMPLEX probes, then module ablations. */
export function planExperiments({ units, ablations, config }) {
  const plan = [];
  for (const unit of units) {
    if (unit.unit_category === 'DIAGNOSTIC') continue;
    if (unit.unit_category === 'SIMPLEX') {
      const group = resolvePath(config, unit.canonical_path).value;
      for (const probe of simplexProbes(unit, group)) {
        plan.push({
          experiment_kind: 'SIMPLEX', parameter_id: unit.parameter_id, group_id: unit.group_id,
          canonical_path: unit.canonical_path, probe_member: probe.member, probe_value: probe.value,
          probe_index: null, ablation: null, ablation_layer: null,
          experiment_id: experimentId('simplex', [unit.parameter_id, probe.member, probe.value])
        });
      }
      continue;
    }
    const baseline = resolvePath(config, unit.canonical_path).value;
    probeValues(unit, baseline).forEach((value, index) => {
      plan.push({
        experiment_kind: 'OAT', parameter_id: unit.parameter_id, group_id: unit.group_id,
        canonical_path: unit.canonical_path, probe_member: null, probe_value: value,
        probe_index: index, ablation: null, ablation_layer: null,
        experiment_id: experimentId('oat', [unit.parameter_id, value])
      });
    });
  }
  for (const ablation of ablations) {
    plan.push({
      experiment_kind: 'ABLATION', parameter_id: null, group_id: null, canonical_path: ablation.canonical_path,
      probe_member: null, probe_value: null, probe_index: null,
      ablation: ablation.ablation, ablation_layer: ablation.ablation_layer,
      experiment_id: experimentId('ablation', [ablation.ablation])
    });
  }
  const seen = new Set();
  for (const entry of plan) {
    if (seen.has(entry.experiment_id)) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'DUPLICATE_EXPERIMENT_ID', detail: entry.experiment_id });
    }
    seen.add(entry.experiment_id);
  }
  return plan.map((entry, index) => ({ ...entry, experiment_order: index + 1 }));
}

/** Lists every leaf path whose value differs between two configs. */
export function diffConfigPaths(left, right, prefix = '') {
  const changed = [];
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = (left || {})[key], b = (right || {})[key];
    const aObject = a !== null && typeof a === 'object' && !Array.isArray(a);
    const bObject = b !== null && typeof b === 'object' && !Array.isArray(b);
    if (aObject && bObject) {
      changed.push(...diffConfigPaths(a, b, path));
      continue;
    }
    if (canonicalJson(a === undefined ? null : a) !== canonicalJson(b === undefined ? null : b)) changed.push(path);
  }
  return changed.sort();
}

/**
 * Enforces "one Parameter Registry unit per experiment". A probe that equals the frozen
 * baseline is a deliberate control-parity self check and must therefore change nothing.
 */
export function assertExperimentDiff(baseConfig, experimentConfig, entry, unit, baselineValue) {
  const changed = diffConfigPaths(baseConfig, experimentConfig);
  if (entry.experiment_kind === 'ABLATION') {
    if (!changed.length) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'ABLATION_CHANGED_NOTHING', detail: entry.experiment_id });
    }
    return { changed, control_parity: false };
  }
  if (unit.unit_category === 'OAT' && entry.probe_value === baselineValue) {
    if (changed.length) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'BASELINE_PROBE_CHANGED_CONFIG', detail: { experiment_id: entry.experiment_id, changed } });
    }
    return { changed: [], control_parity: true };
  }
  if (!changed.length) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'EXPERIMENT_CHANGED_NOTHING', detail: entry.experiment_id });
  }
  if (unit.unit_category === 'OAT') {
    if (changed.length !== 1 || changed[0] !== unit.canonical_path) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'OAT_MULTIPLE_CHANGES', detail: { experiment_id: entry.experiment_id, changed } });
    }
    return { changed, control_parity: false };
  }
  const allowed = unit.members.map(member => `${unit.canonical_path}.${member}`);
  const unexpected = changed.filter(path => !allowed.includes(path));
  if (unexpected.length) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'SIMPLEX_MEMBER_OUTSIDE_GROUP', detail: { experiment_id: entry.experiment_id, unexpected } });
  }
  return { changed, control_parity: false };
}

function configForExperiment(entry, unit, ablation, config) {
  if (entry.experiment_kind === 'ABLATION') {
    return { config: applyAblationOverride(config, ablation), composition: null };
  }
  if (entry.experiment_kind === 'SIMPLEX') {
    const applied = applyUnitOverride(config, unit, { member: entry.probe_member, value: entry.probe_value });
    return { config: applied.config, composition: applied.composition };
  }
  // applyUnitOverride clones internally, so its return value is the experiment config.
  const applied = applyUnitOverride(config, unit, { value: entry.probe_value });
  validateUnitValue(unit, entry.probe_value, applied.config);
  return { config: applied.config, composition: null };
}

/**
 * Runs every planned experiment against the frozen base config. Control is recomputed once
 * per Snapshot and reused as the paired baseline for every experiment.
 */
/** One row per Snapshot dropped from a paired cohort, keeping the drop auditable. */
function failureRecord(stage, entry, cohortRow, error) {
  return {
    stage,
    experiment_id: stage === 'CONTROL' ? null : entry.experiment_id,
    parameter_id: stage === 'CONTROL' ? null : (entry.parameter_id ?? null),
    probe_value: stage === 'CONTROL' ? null : (entry.probe_value ?? null),
    snapshot_id: cohortRow.snapshot_id,
    event_id: cohortRow.event_id ?? null,
    event_date_local: cohortRow.event_date_local ?? null,
    error_code: errorCode(error)
  };
}

export async function runExperiments({ plan, units, ablations, cohort, config, runReplay, progress, policy }) {
  validateBaseConfig(units, config);
  const activePolicy = policy || tuningPolicy();
  const unitById = new Map(units.map(unit => [unit.parameter_id, unit]));
  const ablationByName = new Map(ablations.map(item => [item.ablation, item]));

  const { control, controlFailures } = await computeControl({ cohort, config, runReplay, progress });
  const failures = [...controlFailures];

  const results = [];
  for (const entry of plan) {
    const unit = entry.parameter_id ? unitById.get(entry.parameter_id) : null;
    const ablation = entry.ablation ? ablationByName.get(entry.ablation) : null;
    const prepared = configForExperiment(entry, unit, ablation, config);
    if (unit) {
      const baselineValue = resolvePath(config, unit.canonical_path).value;
      assertExperimentDiff(config, prepared.config, entry, unit, baselineValue);
    } else {
      assertExperimentDiff(config, prepared.config, entry, null, null);
    }
    const modelConfig = buildModelConfig(prepared.config);
    const rows = [];
    let experimentFailureCount = 0;
    for (const base of control) {
      const cohortRow = cohort[base.index];
      let report;
      try {
        report = await runReplay(cohortRow.replay, { modelConfig });
      } catch (error) {
        // The Snapshot leaves the paired cohort for this experiment only; control successes
        // stay available for every other experiment.
        failures.push(failureRecord('EXPERIMENT', entry, cohortRow, error));
        experimentFailureCount++;
        continue;
      }
      const experimentScore = report.actual.score;
      const experimentOrdinal = ordinalOf(experimentScore);
      rows.push({
        experiment_id: entry.experiment_id,
        experiment_kind: entry.experiment_kind,
        parameter_id: entry.parameter_id,
        group_id: entry.group_id,
        canonical_path: entry.canonical_path,
        probe_value: entry.probe_value,
        probe_member: entry.probe_member,
        ablation: entry.ablation,
        ablation_layer: entry.ablation_layer,
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
        control_score: base.control_score,
        experiment_score: experimentScore,
        score_delta: experimentScore - base.control_score,
        control_ordinal: base.control_ordinal,
        experiment_ordinal: experimentOrdinal,
        ordinal_delta: experimentOrdinal - base.control_ordinal,
        control_abs_error: Math.abs(base.control_ordinal - cohortRow.gt_ordinal),
        experiment_abs_error: Math.abs(experimentOrdinal - cohortRow.gt_ordinal),
        abs_error_delta: Math.abs(experimentOrdinal - cohortRow.gt_ordinal) - Math.abs(base.control_ordinal - cohortRow.gt_ordinal),
        control_gw_factor: base.control_gw_factor
      });
    }
    const coverage = coverageFor({
      cohortSampleCount: cohort.length,
      pairedRows: rows,
      controlFailureCount: controlFailures.length,
      experimentFailureCount
    });
    if (activePolicy.coverage_policy.fail_run_below_minimum &&
        (coverage.coverage_rate === null || coverage.coverage_rate < activePolicy.coverage_policy.min_coverage_rate)) {
      fail('TUNING_COVERAGE_BELOW_MINIMUM', {
        experiment_id: entry.experiment_id,
        min_coverage_rate: activePolicy.coverage_policy.min_coverage_rate,
        ...coverage
      });
    }
    results.push({ entry, rows, composition: prepared.composition, coverage });
    progress.update(`已执行 ${results.length}/${plan.length} 个实验${failures.length ? `（已剔除 ${failures.length} 条失败样本）` : ''}`);
  }
  return { results, failures };
}
