import { compare, unique, fail } from '../dataset/lib/common.mjs';
import { GT_LABELS, LEAD_TIME_BUCKETS } from './evaluation-schema.mjs';

export const ORDINAL_TO_LABEL = Object.freeze([...GT_LABELS]);
export const LABEL_TO_ORDINAL = Object.freeze(
  Object.fromEntries(GT_LABELS.map((label, idx) => [label, idx]))
);

export function scoreToOrdinal(score) {
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) {
    fail('INVALID_SCORE', { reason_code: 'SCORE_OUT_OF_RANGE' });
  }
  if (score <= 19) return 0;
  if (score <= 39) return 1;
  if (score <= 59) return 2;
  if (score <= 89) return 3;
  return 4;
}

export function ordinalToLabel(ordinal) {
  if (typeof ordinal !== 'number' || ordinal < 0 || ordinal > 4 || !Number.isInteger(ordinal)) {
    fail('INVALID_ORDINAL');
  }
  return ORDINAL_TO_LABEL[ordinal];
}

export function formatMetric(val) {
  if (val === null || val === undefined || Number.isNaN(val) || !Number.isFinite(val)) {
    return null;
  }
  const rounded = Number(val.toFixed(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function computeLinearQuantile(sortedArray, p) {
  const n = sortedArray.length;
  if (n === 0) return null;
  if (n === 1) return formatMetric(sortedArray[0]);
  const h = (n - 1) * p;
  const j = Math.floor(h);
  const next = Math.min(j + 1, n - 1);
  const q = sortedArray[j] + (h - j) * (sortedArray[next] - sortedArray[j]);
  return formatMetric(q);
}

export function computeLeadTimeBucket(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    fail('LEAD_TIME_INVALID');
  }
  if (minutes < 30) return 'T_0_30M';
  if (minutes < 60) return 'T_30_60M';
  if (minutes < 180) return 'T_1_3H';
  if (minutes < 360) return 'T_3_6H';
  return 'T_6H_PLUS';
}

export function computeLeadTimeCoverage(rows) {
  const values = rows.map(r => r.lead_time_minutes).sort((a, b) => a - b);
  const n = values.length;
  const buckets = Object.fromEntries(LEAD_TIME_BUCKETS.map(b => [b, { sample_count: 0, event_count: 0 }]));
  for (const b of LEAD_TIME_BUCKETS) {
    const inBucket = rows.filter(r => r.lead_time_bucket === b);
    buckets[b].sample_count = inBucket.length;
    buckets[b].event_count = unique(inBucket.map(r => r.event_id)).length;
  }
  return {
    min: n ? formatMetric(values[0]) : null,
    median: computeLinearQuantile(values, 0.5),
    p25: computeLinearQuantile(values, 0.25),
    p75: computeLinearQuantile(values, 0.75),
    max: n ? formatMetric(values[n - 1]) : null,
    metric_reasons: Object.fromEntries(['min', 'median', 'p25', 'p75', 'max'].map(k => [k, n ? null : 'NO_SAMPLES'])),
    buckets
  };
}

export function computeSpearman(xValues, yValues) {
  const n = xValues.length;
  if (n < 2) return { correlation: null, reason_code: 'INSUFFICIENT_SAMPLES' };
  const getRanks = vals => {
    const indexed = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let start = 0;
    while (start < n) {
      let end = start;
      while (end + 1 < n && indexed[end + 1].v === indexed[start].v) end++;
      const avgRank = (start + 1 + end + 1) / 2;
      for (let k = start; k <= end; k++) ranks[indexed[k].i] = avgRank;
      start = end + 1;
    }
    return ranks;
  };
  const rx = getRanks(xValues), ry = getRanks(yValues);
  const meanX = rx.reduce((a, b) => a + b, 0) / n;
  const meanY = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX, dy = ry[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return { correlation: null, reason_code: 'CONSTANT_INPUT' };
  let r = cov / Math.sqrt(varX * varY);
  if (r > 1) r = 1; else if (r < -1) r = -1;
  return { correlation: formatMetric(r), reason_code: null };
}

export function computeHeadlineMetrics(rows, weighting = 'weighted') {
  // Deterministic accumulation order: sorted by snapshot_id Unicode codepoints ASC
  const sorted = [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
  const nullReasons = {
    mae: 'NO_SAMPLES', bias: 'NO_SAMPLES', exact_accuracy: 'NO_SAMPLES',
    within_1_accuracy: 'NO_SAMPLES', severe_error_rate: 'NO_SAMPLES',
    overprediction_rate: 'NO_SAMPLES', underprediction_rate: 'NO_SAMPLES',
    qwk: 'NO_SAMPLES'
  };
  if (sorted.length === 0) {
    return {
      mae: null, bias: null, exact_accuracy: null, within_1_accuracy: null,
      severe_error_rate: null, overprediction_rate: null, underprediction_rate: null,
      qwk: null, metric_reasons: nullReasons
    };
  }

  const weights = sorted.map(r => weighting === 'unweighted' ? 1 : r.weight);
  const W = weights.reduce((a, b) => a + b, 0);
  if (W <= 0) {
    const zeroReasons = Object.fromEntries(Object.keys(nullReasons).map(k => [k, 'ZERO_WEIGHT']));
    return {
      mae: null, bias: null, exact_accuracy: null, within_1_accuracy: null,
      severe_error_rate: null, overprediction_rate: null, underprediction_rate: null,
      qwk: null, metric_reasons: zeroReasons
    };
  }

  let sumAbsError = 0, sumError = 0, sumExact = 0, sumWithin1 = 0;
  let sumSevere = 0, sumOver = 0, sumUnder = 0;

  // 5x5 observed matrix for QWK
  const O = Array.from({ length: 5 }, () => new Float64Array(5));

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const w = weights[i];
    const e = r.predicted_ordinal - r.gt_ordinal;
    const absE = Math.abs(e);
    sumAbsError += w * absE;
    sumError += w * e;
    if (e === 0) sumExact += w;
    if (absE <= 1) sumWithin1 += w;
    if (absE >= 2) sumSevere += w;
    if (e > 0) sumOver += w;
    if (e < 0) sumUnder += w;
    O[r.gt_ordinal][r.predicted_ordinal] += w;
  }

  // QWK
  const R = new Float64Array(5), C = new Float64Array(5);
  for (let a = 0; a < 5; a++) {
    for (let b = 0; b < 5; b++) {
      R[a] += O[a][b];
      C[b] += O[a][b];
    }
  }

  let num = 0, denom = 0;
  for (let a = 0; a < 5; a++) {
    for (let b = 0; b < 5; b++) {
      const D = ((a - b) * (a - b)) / 16;
      const E = (R[a] * C[b]) / W;
      num += D * O[a][b];
      denom += D * E;
    }
  }

  let qwk = null, qwkReason = null;
  if (denom === 0) {
    qwkReason = 'QWK_ZERO_EXPECTED_DISAGREEMENT';
  } else {
    qwk = formatMetric(1 - num / denom);
  }

  const metricReasons = {
    mae: null, bias: null, exact_accuracy: null, within_1_accuracy: null,
    severe_error_rate: null, overprediction_rate: null, underprediction_rate: null,
    qwk: qwkReason
  };

  return {
    mae: formatMetric(sumAbsError / W),
    bias: formatMetric(sumError / W),
    exact_accuracy: formatMetric(sumExact / W),
    within_1_accuracy: formatMetric(sumWithin1 / W),
    severe_error_rate: formatMetric(sumSevere / W),
    overprediction_rate: formatMetric(sumOver / W),
    underprediction_rate: formatMetric(sumUnder / W),
    qwk,
    metric_reasons: metricReasons
  };
}

export function computeConfusionMatrix(rows, benchmarkMode, split) {
  // Sort rows by snapshot_id ASC for deterministic sum
  const sorted = [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
  const counts = Array.from({ length: 5 }, () => new Int32Array(5));
  const weightSums = Array.from({ length: 5 }, () => new Float64Array(5));

  for (const r of sorted) {
    counts[r.gt_ordinal][r.predicted_ordinal]++;
    weightSums[r.gt_ordinal][r.predicted_ordinal] += r.weight;
  }

  const result = [];
  for (let a = 0; a < 5; a++) {
    for (let b = 0; b < 5; b++) {
      result.push({
        benchmark_mode: benchmarkMode,
        split,
        gt_ordinal: a,
        gt_label: ordinalToLabel(a),
        predicted_ordinal: b,
        predicted_label: ordinalToLabel(b),
        sample_count: counts[a][b],
        weight_sum: formatMetric(weightSums[a][b]) ?? 0
      });
    }
  }
  return result;
}

export function computeScoreDistribution(rows, benchmarkMode, split) {
  const result = [];
  for (let ordinal = 0; ordinal < 5; ordinal++) {
    const label = ordinalToLabel(ordinal);
    const inLabel = rows.filter(r => r.gt_ordinal === ordinal);
    if (inLabel.length === 0) {
      result.push({
        benchmark_mode: benchmarkMode,
        split,
        weighting: 'unweighted',
        gt_label: label,
        gt_ordinal: ordinal,
        sample_count: 0,
        event_count: 0,
        mean: null,
        mean_reason_code: 'NO_SAMPLES',
        median: null,
        median_reason_code: 'NO_SAMPLES',
        p25: null,
        p25_reason_code: 'NO_SAMPLES',
        p75: null,
        p75_reason_code: 'NO_SAMPLES',
        min: null,
        min_reason_code: 'NO_SAMPLES',
        max: null,
        max_reason_code: 'NO_SAMPLES'
      });
    } else {
      const scores = inLabel.map(r => r.predicted_score).sort((a, b) => a - b);
      const sum = scores.reduce((a, b) => a + b, 0);
      result.push({
        benchmark_mode: benchmarkMode,
        split,
        weighting: 'unweighted',
        gt_label: label,
        gt_ordinal: ordinal,
        sample_count: scores.length,
        event_count: unique(inLabel.map(r => r.event_id)).length,
        mean: formatMetric(sum / scores.length),
        mean_reason_code: null,
        median: computeLinearQuantile(scores, 0.5),
        median_reason_code: null,
        p25: computeLinearQuantile(scores, 0.25),
        p25_reason_code: null,
        p75: computeLinearQuantile(scores, 0.75),
        p75_reason_code: null,
        min: scores[0],
        min_reason_code: null,
        max: scores[scores.length - 1],
        max_reason_code: null
      });
    }
  }
  return result;
}
