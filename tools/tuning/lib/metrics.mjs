import { computeLinearQuantile, computeHeadlineMetrics, scoreToOrdinal, formatMetric } from '../../evaluation/metrics.mjs';
import { unique, compare } from '../../dataset/lib/common.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';

const HEADLINE_KEYS = ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate', 'overprediction_rate', 'underprediction_rate', 'qwk'];

export function weightedRows(rows, scoreKey) {
  return rows.map(row => ({
    snapshot_id: row.snapshot_id,
    gt_ordinal: row.gt_ordinal,
    predicted_ordinal: scoreToOrdinal(row[scoreKey]),
    weight: row.event_normalized_weight
  }));
}

export function headlineFor(rows, scoreKey) {
  const sorted = [...weightedRows(rows, scoreKey)].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
  return computeHeadlineMetrics(sorted, 'weighted');
}

export function scoreResponse(controlScores, experimentScores, controlOrdinals, experimentOrdinals) {
  const deltas = experimentScores.map((value, index) => value - controlScores[index]);
  const sorted = [...deltas].sort((a, b) => a - b);
  const absolute = deltas.map(Math.abs).sort((a, b) => a - b);
  const changed = deltas.filter(value => value !== 0).length;
  const changedOrdinal = experimentOrdinals.filter((value, index) => value !== controlOrdinals[index]).length;
  return {
    sample_count: deltas.length,
    changed_score_rate: formatMetric(changed / deltas.length),
    changed_ordinal_rate: formatMetric(changedOrdinal / deltas.length),
    mean_score_delta: formatMetric(deltas.reduce((a, b) => a + b, 0) / deltas.length),
    median_score_delta: computeLinearQuantile(sorted, 0.5),
    mean_abs_score_delta: formatMetric(absolute.reduce((a, b) => a + b, 0) / absolute.length),
    p95_abs_score_delta: absolute.length ? computeLinearQuantile(absolute, 0.95) : null
  };
}

export function metricDeltas(control, experiment) {
  const deltas = {};
  for (const key of HEADLINE_KEYS) {
    deltas[`delta_${key}`] = control[key] === null || experiment[key] === null
      ? null
      : formatMetric(experiment[key] - control[key]);
  }
  return deltas;
}

export function metricPair(rows) {
  const control = headlineFor(rows, 'control_score');
  const experiment = headlineFor(rows, 'experiment_score');
  return {
    control, experiment,
    deltas: metricDeltas(control, experiment)
  };
}

function assertKnownSliceValues(rows, key, fixed) {
  const unknown = unique(rows.filter(row => row[key] != null && !fixed.includes(String(row[key])))
    .map(row => String(row[key])));
  if (unknown.length) {
    throw Object.assign(new Error('SLICE_VALUE_NOT_IN_POLICY_ENUM'), {
      code: 'TUNING_VALIDATION_FAILED', reason_code: 'SLICE_VALUE_NOT_IN_POLICY_ENUM', detail: unknown[0]
    });
  }
}

export function sliceAggregate(rows, entry, dimensions, fixedEnums) {
  const out = [];
  for (const dimension of dimensions) {
    const fixed = fixedEnums[dimension];
    const key = dimension === 'city' ? 'location_key' : dimension;
    const values = [];
    const hasNull = rows.some(row => row[key] == null);
    if (fixed) {
      assertKnownSliceValues(rows, key, fixed);
      if (hasNull) values.push({ value: null, isNull: true });
      for (const value of fixed) values.push({ value, isNull: false });
    } else {
      if (hasNull) values.push({ value: null, isNull: true });
      for (const value of unique(rows.filter(row => row[key] != null).map(row => String(row[key])))) {
        values.push({ value, isNull: false });
      }
    }
    for (const target of values) {
      const matching = rows.filter(row => {
        if (target.isNull) return row[key] == null;
        if (row[key] == null) return false;
        return dimension === 'city' ? row.location_key === target.value : String(row[key]) === target.value;
      });
      if (!matching.length) continue;
      const perEvent = new Map();
      for (const row of matching) perEvent.set(row.event_id, (perEvent.get(row.event_id) || 0) + 1);
      const reweighted = matching.map(row => ({ ...row, event_normalized_weight: row.gt_confidence / perEvent.get(row.event_id) }));
      const pair = metricPair(reweighted);
      const response = scoreResponse(
        matching.map(row => row.control_score), matching.map(row => row.experiment_score),
        matching.map(row => row.control_ordinal), matching.map(row => row.experiment_ordinal)
      );
      const improved = matching.filter(row => row.abs_error_delta < 0).length;
      const degraded = matching.filter(row => row.abs_error_delta > 0).length;
      out.push({
        experiment_id: entry.experiment_id,
        parameter_id: entry.parameter_id ?? null,
        parameter_value: entry.probe_value ?? null,
        slice_dimension: dimension,
        slice_value: target.value,
        slice_value_is_null: target.isNull,
        sample_count: matching.length,
        event_count: unique(matching.map(row => row.event_id)).length,
        date_count: unique(matching.map(row => row.event_date_local)).length,
        weight_sum: formatMetric(reweighted.reduce((sum, row) => sum + row.event_normalized_weight, 0)) ?? 0,
        changed_score_rate: response.changed_score_rate,
        mean_score_delta: response.mean_score_delta,
        mean_abs_score_delta: response.mean_abs_score_delta,
        control_mae: pair.control.mae,
        experiment_mae: pair.experiment.mae,
        delta_mae: pair.deltas.delta_mae,
        improved_sample_rate: formatMetric(improved / matching.length),
        degraded_sample_rate: formatMetric(degraded / matching.length)
      });
    }
  }
  return out;
}

export function cohortProfiles(rows) {
  const policy = tuningPolicy();
  const events = new Set(rows.map(row => row.event_id));
  const byDate = new Map(), byCity = new Map();
  for (const row of rows) {
    if (!byDate.has(row.event_date_local)) byDate.set(row.event_date_local, new Set());
    byDate.get(row.event_date_local).add(row.event_id);
    if (!byCity.has(row.city)) byCity.set(row.city, new Set());
    byCity.get(row.city).add(row.event_id);
  }
  const eventLevels = new Map();
  for (const row of rows) eventLevels.set(row.event_id, row.gt_ordinal);
  const levelCounts = {};
  for (const ordinal of eventLevels.values()) levelCounts[`ordinal_${ordinal}`] = (levelCounts[`ordinal_${ordinal}`] || 0) + 1;
  const levels = [...eventLevels.values()];
  return {
    samples: rows.length,
    primary_events: events.size,
    unique_dates: byDate.size,
    gt_levels: new Set(levels).size,
    gt_level_event_counts: levelCounts,
    max_date_event_share: byDate.size ? Math.max(...[...byDate.values()].map(set => set.size)) / events.size : 0,
    max_city_event_share: byCity.size ? Math.max(...[...byCity.values()].map(set => set.size)) / events.size : 0,
    thresholds: policy.readiness_thresholds
  };
}
