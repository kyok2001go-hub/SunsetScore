import { compare, fail, unique } from '../../dataset/lib/common.mjs';
import { GT_LABELS } from '../evaluation-schema.mjs';
import { computeHeadlineMetrics, formatMetric } from '../metrics.mjs';
import { NO_SKILL_COMPARATOR } from './policy.mjs';

const METRICS = ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate',
  'overprediction_rate', 'underprediction_rate', 'qwk'];

export function selectNoSkillReference(trainRows) {
  const events = new Map();
  for (const row of trainRows) {
    const prior = events.get(row.event_id);
    if (prior && (prior.gt_ordinal !== row.gt_ordinal || prior.gt_confidence !== row.gt_confidence)) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'EVENT_GT_INCONSISTENCY' });
    }
    events.set(row.event_id, { gt_ordinal: row.gt_ordinal, gt_confidence: row.gt_confidence });
  }
  const sorted = [...events].sort((a, b) => compare(a[0], b[0])).map(([, value]) => value);
  const W = sorted.reduce((sum, e) => sum + e.gt_confidence, 0);
  const reason = !sorted.length ? 'NO_TRAIN_EVENTS' : W <= 0 ? 'ZERO_TRAIN_WEIGHT' : null;
  let ordinal = null;
  if (!reason) {
    let best = Infinity;
    for (let candidate = 0; candidate < 5; candidate++) {
      const loss = sorted.reduce((sum, e) => sum + e.gt_confidence * Math.abs(candidate - e.gt_ordinal), 0);
      if (loss < best) { best = loss; ordinal = candidate; }
    }
  }
  return {
    comparator: NO_SKILL_COMPARATOR,
    reference_ordinal: ordinal,
    reference_gt_label: ordinal === null ? null : GT_LABELS[ordinal],
    train_event_count: sorted.length,
    train_weight_sum: formatMetric(W) ?? 0,
    reason_code: reason
  };
}

export function noSkillComparison(rows, benchmarkMode, weighting, reference) {
  const final = computeHeadlineMetrics(rows, weighting);
  const noSkill = reference.reference_ordinal === null ? null : computeHeadlineMetrics(
    rows.map(r => ({ ...r, predicted_ordinal: reference.reference_ordinal })), weighting
  );
  const W = weighting === 'unweighted' ? rows.length : rows.reduce((sum, r) => sum + r.weight, 0);
  const result = {
    benchmark_mode: benchmarkMode,
    split: 'TRAIN', weighting, comparator: NO_SKILL_COMPARATOR,
    reference_ordinal: reference.reference_ordinal,
    reference_gt_label: reference.reference_gt_label,
    sample_count: rows.length,
    event_count: unique(rows.map(r => r.event_id)).length,
    weight_sum: formatMetric(W) ?? 0
  };
  for (const key of METRICS) {
    result[`final_${key}`] = final[key];
    result[`final_${key}_reason_code`] = final.metric_reasons[key];
    result[`reference_${key}`] = noSkill?.[key] ?? null;
    result[`reference_${key}_reason_code`] = noSkill?.metric_reasons[key] ?? reference.reason_code;
  }
  let deltaSum = 0;
  if (reference.reference_ordinal !== null) {
    const ordered = [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
    for (const row of ordered) {
      const w = weighting === 'unweighted' ? 1 : row.weight;
      deltaSum += w * (Math.abs(row.predicted_ordinal - row.gt_ordinal) -
        Math.abs(reference.reference_ordinal - row.gt_ordinal));
    }
  }
  result.delta_mae = final.mae === null || noSkill?.mae == null ? null :
    formatMetric(deltaSum / W);
  result.delta_mae_reason_code = result.delta_mae === null ?
    (reference.reason_code || final.metric_reasons.mae || noSkill?.metric_reasons.mae) : null;
  return result;
}
