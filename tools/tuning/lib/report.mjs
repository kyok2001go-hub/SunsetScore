import { canonicalJson, unique, compare } from '../../dataset/lib/common.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';
import { scoreResponse, metricPair, sliceAggregate } from './metrics.mjs';
import { parameterReadiness } from './readiness.mjs';
import { supportMetrics } from './replay-cohort.mjs';
import { FIXED_SLICE_ENUMS, SLICE_DIMENSIONS } from '../tuning-schema.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';
import { constraintTypesFor } from './constraints.mjs';

function countsFor(rows) {
  return {
    sample_count: rows.length,
    event_count: unique(rows.map(row => row.event_id)).length,
    date_count: unique(rows.map(row => row.event_date_local)).length
  };
}

function coverageColumns(coverage, experimentId) {
  if (!coverage) {
    throw Object.assign(new Error('MISSING_EXPERIMENT_COVERAGE'), {
      code: 'TUNING_VALIDATION_FAILED', reason_code: 'MISSING_EXPERIMENT_COVERAGE', detail: experimentId
    });
  }
  return {
    cohort_sample_count: coverage.cohort_sample_count,
    paired_sample_count: coverage.paired_sample_count,
    paired_event_count: coverage.paired_event_count,
    coverage_rate: coverage.coverage_rate,
    failure_count: coverage.failure_count,
    control_failure_count: coverage.control_failure_count,
    experiment_failure_count: coverage.experiment_failure_count
  };
}

export function experimentMetricRow({ entry, rows, composition, stability, coverage }) {
  if (!stability) {
    throw Object.assign(new Error('MISSING_EXPERIMENT_STABILITY'), {
      code: 'TUNING_VALIDATION_FAILED', reason_code: 'MISSING_EXPERIMENT_STABILITY', detail: entry.experiment_id
    });
  }
  const response = scoreResponse(
    rows.map(row => row.control_score), rows.map(row => row.experiment_score),
    rows.map(row => row.control_ordinal), rows.map(row => row.experiment_ordinal)
  );
  const pair = metricPair(rows);
  const counts = countsFor(rows);
  return {
    experiment_id: entry.experiment_id,
    experiment_kind: entry.experiment_kind,
    parameter_id: entry.parameter_id,
    group_id: entry.group_id,
    canonical_path: entry.canonical_path,
    probe_value: entry.probe_value,
    ablation: entry.ablation,
    ...counts,
    ...coverageColumns(coverage, entry.experiment_id),
    weight_sum: formatMetric(rows.reduce((sum, row) => sum + row.event_normalized_weight, 0)) ?? 0,
    changed_score_rate: response.changed_score_rate,
    changed_ordinal_rate: response.changed_ordinal_rate,
    mean_score_delta: response.mean_score_delta,
    median_score_delta: response.median_score_delta,
    mean_abs_score_delta: response.mean_abs_score_delta,
    p95_abs_score_delta: response.p95_abs_score_delta,
    control_mae: pair.control.mae, experiment_mae: pair.experiment.mae, delta_mae: pair.deltas.delta_mae,
    control_bias: pair.control.bias, experiment_bias: pair.experiment.bias, delta_bias: pair.deltas.delta_bias,
    control_exact_accuracy: pair.control.exact_accuracy, experiment_exact_accuracy: pair.experiment.exact_accuracy,
    delta_exact_accuracy: pair.deltas.delta_exact_accuracy,
    control_within_1_accuracy: pair.control.within_1_accuracy, experiment_within_1_accuracy: pair.experiment.within_1_accuracy,
    delta_within_1_accuracy: pair.deltas.delta_within_1_accuracy,
    control_severe_error_rate: pair.control.severe_error_rate, experiment_severe_error_rate: pair.experiment.severe_error_rate,
    delta_severe_error_rate: pair.deltas.delta_severe_error_rate,
    control_overprediction_rate: pair.control.overprediction_rate,
    experiment_overprediction_rate: pair.experiment.overprediction_rate,
    control_underprediction_rate: pair.control.underprediction_rate,
    experiment_underprediction_rate: pair.experiment.underprediction_rate,
    control_qwk: pair.control.qwk, experiment_qwk: pair.experiment.qwk, delta_qwk: pair.deltas.delta_qwk,
    lodo_fold_count: stability.fold_count,
    lodo_improved_count: stability.improved_date_count,
    lodo_degraded_count: stability.degraded_date_count,
    lodo_stability_ratio: stability.direction_stability_ratio,
    lodo_reason_code: stability.reason_code,
    limited_date_coverage: stability.limited_date_coverage,
    effective_composition_json: composition ? canonicalJson(composition) : null
  };
}

export function ablationMetricRow(metricRow, entry, affectedSampleCount) {
  const row = { ...metricRow };
  return {
    experiment_id: row.experiment_id,
    ablation: entry.ablation,
    ablation_layer: entry.ablation_layer,
    sample_count: row.sample_count,
    event_count: row.event_count,
    date_count: row.date_count,
    cohort_sample_count: row.cohort_sample_count,
    paired_sample_count: row.paired_sample_count,
    paired_event_count: row.paired_event_count,
    coverage_rate: row.coverage_rate,
    failure_count: row.failure_count,
    control_failure_count: row.control_failure_count,
    experiment_failure_count: row.experiment_failure_count,
    weight_sum: row.weight_sum,
    affected_sample_count: affectedSampleCount,
    changed_score_rate: row.changed_score_rate,
    changed_ordinal_rate: row.changed_ordinal_rate,
    mean_score_delta: row.mean_score_delta,
    median_score_delta: row.median_score_delta,
    mean_abs_score_delta: row.mean_abs_score_delta,
    p95_abs_score_delta: row.p95_abs_score_delta,
    control_mae: row.control_mae, experiment_mae: row.experiment_mae, delta_mae: row.delta_mae,
    control_bias: row.control_bias, experiment_bias: row.experiment_bias, delta_bias: row.delta_bias,
    control_exact_accuracy: row.control_exact_accuracy, experiment_exact_accuracy: row.experiment_exact_accuracy,
    delta_exact_accuracy: row.delta_exact_accuracy,
    control_within_1_accuracy: row.control_within_1_accuracy, experiment_within_1_accuracy: row.experiment_within_1_accuracy,
    delta_within_1_accuracy: row.delta_within_1_accuracy,
    control_severe_error_rate: row.control_severe_error_rate, experiment_severe_error_rate: row.experiment_severe_error_rate,
    delta_severe_error_rate: row.delta_severe_error_rate,
    control_qwk: row.control_qwk, experiment_qwk: row.experiment_qwk, delta_qwk: row.delta_qwk
  };
}

export function sampleDeltaRows(results) {
  const rows = [];
  for (const result of results) {
    for (const row of result.rows) {
      rows.push({
        experiment_id: row.experiment_id, snapshot_id: row.snapshot_id, event_id: row.event_id,
        event_date_local: row.event_date_local, city: row.city, lead_time_bucket: row.lead_time_bucket,
        gt_label: row.gt_label, gt_ordinal: row.gt_ordinal, gt_confidence: row.gt_confidence,
        event_normalized_weight: row.event_normalized_weight,
        control_score: row.control_score, experiment_score: row.experiment_score, score_delta: row.score_delta,
        control_ordinal: row.control_ordinal, experiment_ordinal: row.experiment_ordinal, ordinal_delta: row.ordinal_delta,
        control_abs_error: row.control_abs_error, experiment_abs_error: row.experiment_abs_error,
        abs_error_delta: row.abs_error_delta
      });
    }
  }
  return rows;
}

/** Deterministic ordering so identical runs produce identical failure tables. */
export function failureRows(failures) {
  return [...failures]
    .sort((a, b) => compare(
      [a.stage, a.experiment_id ?? '', a.snapshot_id].join('|'),
      [b.stage, b.experiment_id ?? '', b.snapshot_id].join('|')
    ))
    .map(record => ({ ...record }));
}

export function sliceDeltaRows(results) {
  const rows = [];
  for (const result of results) {
    rows.push(...sliceAggregate(result.rows, result.entry, SLICE_DIMENSIONS, FIXED_SLICE_ENUMS));
  }
  return rows;
}

export function parameterSummaryRows({ ctx, results, experimentMetrics }) {
  const rows = [];
  const byParameter = new Map();
  for (let index = 0; index < results.length; index++) {
    const entry = results[index].entry;
    if (!entry.parameter_id) continue;
    if (!byParameter.has(entry.parameter_id)) byParameter.set(entry.parameter_id, []);
    byParameter.get(entry.parameter_id).push({ result: results[index], metric: experimentMetrics[index] });
  }
  for (const unit of ctx.units) {
    const support = supportMetrics(unit, ctx.cohort);
    const probes = byParameter.get(unit.parameter_id) || [];
    const perProbe = probes.map(item => ({
      entry: item.result.entry,
      metric: item.metric,
      changed: item.metric.changed_score_rate,
      meanAbs: item.metric.mean_abs_score_delta,
      deltaMae: item.metric.delta_mae
    }));
    const response = probes.length ? {
      max_changed_score_rate: Math.max(...probes.map(item => item.metric.changed_score_rate ?? 0)),
      max_mean_abs_score_delta: Math.max(...probes.map(item => item.metric.mean_abs_score_delta ?? 0))
    } : null;
    const stability = selectRepresentativeStability(perProbe, support);
    const readiness = parameterReadiness({ unit, support, response, stability });
    const deltaMaes = perProbe.map(item => item.deltaMae).filter(value => Number.isFinite(value));
    rows.push({
      parameter_id: unit.parameter_id,
      group_id: unit.group_id,
      canonical_path: unit.canonical_path,
      unit_category: unit.unit_category,
      replay_class: unit.replay_class,
      wired_status: unit.wired_status,
      optimizable: unit.optimizable,
      ablation_supported: unit.ablation_supported,
      activation_condition: unit.activation_condition,
      constraint_types: constraintTypesFor(unit).join('|'),
      parameter_readiness: readiness.parameter_readiness,
      observability_status: readiness.observability_status,
      reason_code: readiness.reason_code,
      ...support,
      probe_count: unit.unit_category === 'DIAGNOSTIC' ? 0 : perProbe.length,
      evaluated_probe_count: perProbe.length,
      max_changed_score_rate: response ? response.max_changed_score_rate : null,
      max_mean_abs_score_delta: response ? response.max_mean_abs_score_delta : null,
      min_delta_mae: deltaMaes.length ? Math.min(...deltaMaes) : null,
      max_delta_mae: deltaMaes.length ? Math.max(...deltaMaes) : null,
      best_delta_mae: deltaMaes.length ? Math.min(...deltaMaes) : null,
      date_count: stability.date_count,
      improved_date_count: stability.improved_date_count,
      degraded_date_count: stability.degraded_date_count,
      direction_stability_ratio: stability.direction_stability_ratio,
      limited_date_coverage: stability.limited_date_coverage,
      stability_representative_experiment_id: stability.representative_experiment_id
    });
  }
  return rows;
}

/**
 * Parameter level stability is taken from one representative probe: the probe with the
 * largest |delta_mae|, ties resolved by experiment_id, so the number always describes folds
 * that actually coexisted. Max-merging improved and degraded counts across probes mixed
 * folds from different probes and made fully date-stable parameters look unstable.
 */
function selectRepresentativeStability(perProbe, support) {
  const foldable = perProbe.filter(item => Number.isFinite(item.metric.lodo_stability_ratio));
  if (!foldable.length) {
    return {
      // No fold could be evaluated, so the stability block reports zero folds. Cohort date
      // coverage stays visible in the support columns.
      date_count: 0,
      improved_date_count: 0,
      degraded_date_count: 0,
      direction_stability_ratio: null,
      limited_date_coverage: support.support_dates < tuningPolicy().stability.ready_dates,
      representative_experiment_id: null,
      reason_code: perProbe.length ? 'NO_DIRECTIONAL_FOLDS' : 'NO_PROBES'
    };
  }
  const representative = foldable.reduce((best, current) => {
    const currentAbs = Math.abs(current.deltaMae ?? 0);
    const bestAbs = Math.abs(best.deltaMae ?? 0);
    if (currentAbs > bestAbs) return current;
    if (currentAbs < bestAbs) return best;
    return current.entry.experiment_id < best.entry.experiment_id ? current : best;
  });
  return {
    date_count: representative.metric.lodo_fold_count,
    improved_date_count: representative.metric.lodo_improved_count,
    degraded_date_count: representative.metric.lodo_degraded_count,
    direction_stability_ratio: representative.metric.lodo_stability_ratio,
    limited_date_coverage: representative.metric.limited_date_coverage,
    representative_experiment_id: representative.entry.experiment_id,
    reason_code: representative.metric.lodo_reason_code
  };
}

export function buildWarnings({ ctx, parameterSummary, ablationMetrics }) {
  const rows = [];
  const push = (warning_code, scope, extra = {}) => rows.push({
    warning_code, scope,
    parameter_id: extra.parameter_id ?? null,
    experiment_id: extra.experiment_id ?? null,
    slice_dimension: null, slice_value: null, slice_value_is_null: null
  });
  if (ctx.observedBuilds.length > 1) push('MULTIPLE_ENGINE_BUILDS', 'cohort');
  if (ctx.observedConfigs.length !== 1) push('MULTIPLE_CONFIG_HASHES', 'cohort');
  if (ctx.readiness.global_readiness === 'EXPLORATORY') push('EXPLORATORY_ONLY_RESULT', 'package');
  for (const reason of ctx.readiness.reasons) push('READINESS_GAP:' + reason, 'readiness');
  for (const row of parameterSummary) {
    if (row.parameter_readiness === 'NOT_OBSERVABLE') push('PARAMETER_NOT_OBSERVABLE', 'parameter', { parameter_id: row.parameter_id });
    if (row.parameter_readiness === 'INSUFFICIENT_SUPPORT') push('PARAMETER_INSUFFICIENT_SUPPORT', 'parameter', { parameter_id: row.parameter_id });
    if (row.wired_status !== 'WIRED') push('PARAMETER_NOT_FORMAL', 'parameter', { parameter_id: row.parameter_id });
    if (row.limited_date_coverage) push('LIMITED_DATE_COVERAGE', 'parameter', { parameter_id: row.parameter_id });
  }
  for (const row of ablationMetrics) {
    if (!row.affected_sample_count) push('ABLATION_WITHOUT_EFFECT', 'ablation', { experiment_id: row.experiment_id });
  }
  const deduped = new Map();
  for (const row of rows) deduped.set(canonicalJson(row), row);
  return [...deduped.values()].sort((a, b) => compare(
    [a.warning_code, a.scope, a.parameter_id, a.experiment_id, a.slice_dimension, a.slice_value].join('|'),
    [b.warning_code, b.scope, b.parameter_id, b.experiment_id, b.slice_dimension, b.slice_value].join('|')
  ));
}
