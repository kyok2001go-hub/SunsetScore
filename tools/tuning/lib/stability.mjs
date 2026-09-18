import { formatMetric, computeHeadlineMetrics } from '../../evaluation/metrics.mjs';
import { unique, compare } from '../../dataset/lib/common.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';

function maeFor(rows) {
  const sorted = [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
  const metrics = computeHeadlineMetrics(sorted.map(row => ({
    snapshot_id: row.snapshot_id,
    gt_ordinal: row.gt_ordinal,
    predicted_ordinal: row.predicted_ordinal,
    weight: row.event_normalized_weight
  })), 'weighted');
  return metrics.mae;
}

/**
 * Leave-One-Date-Out diagnosis: drop one local date at a time and check whether the
 * experiment still improves over control on the remaining dates.
 */
export function leaveOneDateOut(rows, predictedOrdinalKey) {
  const policy = tuningPolicy();
  const dates = unique(rows.map(row => row.event_date_local));
  if (dates.length < 2) {
    return {
      date_count: dates.length,
      fold_count: 0,
      improved_date_count: 0,
      degraded_date_count: 0,
      direction_stability_ratio: null,
      limited_date_coverage: dates.length < policy.stability.ready_dates,
      reason_code: 'INSUFFICIENT_DATES_FOR_LODO'
    };
  }
  let improved = 0, degraded = 0;
  for (const date of dates) {
    const subset = rows.filter(row => row.event_date_local !== date);
    if (!subset.length) continue;
    const control = maeFor(subset.map(row => ({ ...row, predicted_ordinal: row.control_ordinal })));
    const experiment = maeFor(subset.map(row => ({ ...row, predicted_ordinal: row[predictedOrdinalKey] })));
    if (control === null || experiment === null) continue;
    const delta = experiment - control;
    if (delta < 0) improved++;
    else if (delta > 0) degraded++;
  }
  const folds = improved + degraded;
  return {
    date_count: dates.length,
    // Evaluated folds. Neutral folds (no MAE change either way) still count here but not in
    // the directional ratio, which only weighs improved against degraded folds.
    fold_count: folds,
    improved_date_count: improved,
    degraded_date_count: degraded,
    direction_stability_ratio: folds ? formatMetric(Math.max(improved, degraded) / folds) : null,
    limited_date_coverage: dates.length < policy.stability.ready_dates,
    reason_code: folds ? null : 'NO_DIRECTIONAL_FOLDS'
  };
}
