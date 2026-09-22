import { compare, unique } from '../../dataset/lib/common.mjs';
import { computeHeadlineMetrics, computeLinearQuantile, formatMetric } from '../../evaluation/metrics.mjs';
import { SLICE_DIMENSIONS, FIXED_SLICE_ENUMS } from '../../tuning/tuning-schema.mjs';

/**
 * Optimization-side metric helpers. They deliberately re-derive the paired weights instead of
 * reusing the Sensitivity package tables, because Phase 6 must be able to recompute every
 * Candidate from the TRAIN cohort alone.
 */

/** Event weight renormalised inside the cohort actually being measured. */
export function renormalizeEventWeights(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.event_id, (counts.get(row.event_id) || 0) + 1);
  return rows.map(row => ({ ...row, event_normalized_weight: row.gt_confidence / counts.get(row.event_id) }));
}

function metricRows(rows, predictedKey) {
  return [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id)).map(row => ({
    snapshot_id: row.snapshot_id,
    gt_ordinal: row.gt_ordinal,
    predicted_ordinal: row[predictedKey],
    weight: row.event_normalized_weight
  }));
}

export function weightedHeadline(rows, predictedKey) {
  return computeHeadlineMetrics(metricRows(rows, predictedKey), 'weighted');
}

export const HEADLINE_KEYS = Object.freeze([
  'mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate',
  'overprediction_rate', 'underprediction_rate', 'qwk'
]);

/** Control vs Candidate metrics on one cohort, with renormalised Event weights. */
export function pairMetrics(rows) {
  const reweighted = renormalizeEventWeights(rows);
  const control = weightedHeadline(reweighted, 'control_ordinal');
  const candidate = weightedHeadline(reweighted, 'experiment_ordinal');
  const deltas = {};
  for (const key of HEADLINE_KEYS) {
    deltas[`delta_${key}`] = control[key] === null || candidate[key] === null
      ? null : formatMetric(candidate[key] - control[key]);
  }
  return { reweighted, control, candidate, deltas };
}

/** Signed weighted MAE difference on a subset: negative means the Candidate is better. */
export function deltaMae(rows) {
  if (!rows.length) return null;
  const reweighted = renormalizeEventWeights(rows);
  const control = weightedHeadline(reweighted, 'control_ordinal').mae;
  const candidate = weightedHeadline(reweighted, 'experiment_ordinal').mae;
  if (control === null || candidate === null) return null;
  return formatMetric(candidate - control);
}

/** Weighted MAE of the frozen no-skill ordinal on the same paired cohort. */
export function noSkillMae(rows, referenceOrdinal) {
  if (!Number.isInteger(referenceOrdinal) || !rows.length) return null;
  const reweighted = renormalizeEventWeights(rows);
  const rowsWithPrediction = reweighted.map(row => ({ ...row, no_skill_ordinal: referenceOrdinal }));
  return weightedHeadline(rowsWithPrediction, 'no_skill_ordinal').mae;
}

function classify(delta, epsilon) {
  if (delta === null) return 'UNAVAILABLE';
  if (delta < -epsilon) return 'IMPROVED';
  if (delta > epsilon) return 'DEGRADED';
  return 'NEUTRAL';
}

function summarize(deltas, epsilon) {
  const available = deltas.filter(delta => delta !== null).map(delta => Number(delta));
  const improved = available.filter(delta => delta < -epsilon).length;
  const degraded = available.filter(delta => delta > epsilon).length;
  const neutral = available.length - improved - degraded;
  const sorted = [...available].sort((a, b) => a - b);
  return {
    evaluated_count: available.length,
    improved_count: improved,
    degraded_count: degraded,
    neutral_count: neutral,
    improvement_rate: available.length ? formatMetric(improved / available.length) : null,
    median_delta_mae: sorted.length ? computeLinearQuantile(sorted, 0.5) : null,
    worst_delta_mae: sorted.length ? formatMetric(sorted[sorted.length - 1]) : null
  };
}

/**
 * Two distinct statistics that the PRD forbids mixing: per-date effects (each date measured on
 * its own Snapshot subset) and Leave-One-Date-Out folds (each date removed, remainder measured).
 */
export function dateRobustness(rows, epsilon) {
  const reweighted = renormalizeEventWeights(rows);
  const dates = unique(reweighted.map(row => row.event_date_local));
  const perDate = dates.map(date => {
    const subset = reweighted.filter(row => row.event_date_local === date);
    const delta = deltaMae(subset);
    return {
      event_date_local: date,
      sample_count: subset.length,
      event_count: unique(subset.map(row => row.event_id)).length,
      control_mae: subset.length ? weightedHeadline(renormalizeEventWeights(subset), 'control_ordinal').mae : null,
      candidate_mae: subset.length ? weightedHeadline(renormalizeEventWeights(subset), 'experiment_ordinal').mae : null,
      delta_mae: delta,
      direction: classify(delta, epsilon)
    };
  });
  const lodo = dates.map(date => {
    const subset = reweighted.filter(row => row.event_date_local !== date);
    const delta = subset.length ? deltaMae(subset) : null;
    return {
      event_date_local: date,
      sample_count: subset.length,
      event_count: unique(subset.map(row => row.event_id)).length,
      control_mae: subset.length ? weightedHeadline(renormalizeEventWeights(subset), 'control_ordinal').mae : null,
      candidate_mae: subset.length ? weightedHeadline(renormalizeEventWeights(subset), 'experiment_ordinal').mae : null,
      delta_mae: delta,
      direction: classify(delta, epsilon)
    };
  });
  return {
    date_count: dates.length,
    per_date: perDate,
    lodo,
    per_date_summary: summarize(perDate.map(row => row.delta_mae), epsilon),
    lodo_summary: summarize(lodo.map(row => row.delta_mae), epsilon)
  };
}

function sliceKeyFor(dimension) {
  return dimension === 'city' ? 'location_key' : dimension;
}

function sliceValues(rows, key, fixed) {
  const values = [];
  const hasNull = rows.some(row => row[key] === null || row[key] === undefined);
  if (hasNull) values.push({ value: null, isNull: true });
  const observed = unique(rows.filter(row => row[key] !== null && row[key] !== undefined).map(row => String(row[key])));
  for (const value of observed) {
    if (fixed && !fixed.includes(value)) continue;
    values.push({ value, isNull: false });
  }
  return values;
}

/**
 * Slice Regression Guardrail. Only slices that clear the support threshold are hard gates; the
 * rest are reported so a thin Slice can never veto a Candidate.
 */
export function sliceAnalysis(rows, epsilon, sliceSupport) {
  const output = [];
  for (const dimension of SLICE_DIMENSIONS) {
    const key = sliceKeyFor(dimension);
    if (!rows.some(row => key in row)) continue;
    const fixed = FIXED_SLICE_ENUMS[dimension] || null;
    for (const target of sliceValues(rows, key, fixed)) {
      const matching = rows.filter(row => target.isNull
        ? row[key] === null || row[key] === undefined
        : row[key] !== null && row[key] !== undefined && String(row[key]) === target.value);
      if (!matching.length) continue;
      const eventCount = unique(matching.map(row => row.event_id)).length;
      const dateCount = unique(matching.map(row => row.event_date_local)).length;
      const supported = eventCount >= sliceSupport.min_event_count && dateCount >= sliceSupport.min_date_count;
      const pair = pairMetrics(matching);
      const deltaSevere = pair.deltas.delta_severe_error_rate;
      const regression = supported && pair.deltas.delta_mae !== null && deltaSevere !== null &&
        pair.deltas.delta_mae > epsilon && deltaSevere > epsilon;
      output.push({
        slice_dimension: dimension,
        slice_value: target.value,
        slice_value_is_null: target.isNull,
        sample_count: matching.length,
        event_count: eventCount,
        date_count: dateCount,
        supported,
        support_reason: supported ? null : 'INSUFFICIENT_SLICE_SUPPORT',
        control_mae: pair.control.mae,
        candidate_mae: pair.candidate.mae,
        delta_mae: pair.deltas.delta_mae,
        delta_severe_error_rate: deltaSevere,
        regression
      });
    }
  }
  return output;
}
