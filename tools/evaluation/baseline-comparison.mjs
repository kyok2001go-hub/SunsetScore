import { compare, unique } from '../dataset/lib/common.mjs';
import { formatMetric, scoreToOrdinal } from './metrics.mjs';
import { COMPARATOR } from './evaluation-schema.mjs';

export function computeBaselineComparison(benchmarkRows, benchmarkMode, split) {
  const benchmarkSampleCount = benchmarkRows.length;
  const benchmarkEventCount = unique(benchmarkRows.map(r => r.event_id)).length;
  const pairedRows = benchmarkRows.filter(r => r.baseline_score != null);
  const pairedSampleCount = pairedRows.length;
  const pairedEventCount = unique(pairedRows.map(r => r.event_id)).length;
  const missingBaselineSampleCount = benchmarkSampleCount - pairedSampleCount;

  let pairedSampleCoverage = null, pairedSampleCoverageReason = null;
  let pairedEventCoverage = null, pairedEventCoverageReason = null;

  if (benchmarkSampleCount === 0) {
    pairedSampleCoverageReason = 'NO_BENCHMARK_SAMPLES';
    pairedEventCoverageReason = 'NO_BENCHMARK_SAMPLES';
  } else {
    pairedSampleCoverage = formatMetric(pairedSampleCount / benchmarkSampleCount);
    pairedEventCoverage = formatMetric(pairedEventCount / benchmarkEventCount);
  }

  const warnings = [];
  if (pairedSampleCount === 0) {
    warnings.push({
      warning_code: 'NO_PAIRED_SAMPLES',
      benchmark_mode: benchmarkMode,
      split,
      slice_dimension: null,
      slice_value: null,
      slice_value_is_null: null
    });
  }

  // Count events in paired
  const pairedEventCounts = new Map();
  for (const r of pairedRows) {
    pairedEventCounts.set(r.event_id, (pairedEventCounts.get(r.event_id) || 0) + 1);
  }

  // Rows sorted by snapshot_id ASC for deterministic sum
  const sortedPaired = [...pairedRows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));

  function evaluateSubset(weighting) {
    if (sortedPaired.length === 0) {
      return {
        weight_sum: 0,
        final_mae: null, final_mae_reason_code: 'NO_PAIRED_SAMPLES',
        baseline_mae: null, baseline_mae_reason_code: 'NO_PAIRED_SAMPLES',
        delta_mae: null, delta_mae_reason_code: 'NO_PAIRED_SAMPLES',
        final_bias: null, final_bias_reason_code: 'NO_PAIRED_SAMPLES',
        baseline_bias: null, baseline_bias_reason_code: 'NO_PAIRED_SAMPLES',
        final_exact_accuracy: null, final_exact_accuracy_reason_code: 'NO_PAIRED_SAMPLES',
        baseline_exact_accuracy: null, baseline_exact_accuracy_reason_code: 'NO_PAIRED_SAMPLES',
        final_within_1_accuracy: null, final_within_1_accuracy_reason_code: 'NO_PAIRED_SAMPLES',
        baseline_within_1_accuracy: null, baseline_within_1_accuracy_reason_code: 'NO_PAIRED_SAMPLES',
        final_severe_error_rate: null, final_severe_error_rate_reason_code: 'NO_PAIRED_SAMPLES',
        baseline_severe_error_rate: null, baseline_severe_error_rate_reason_code: 'NO_PAIRED_SAMPLES',
        final_win_rate: null, final_win_rate_reason_code: 'NO_PAIRED_SAMPLES',
        tie_rate: null, tie_rate_reason_code: 'NO_PAIRED_SAMPLES',
        baseline_win_rate: null, baseline_win_rate_reason_code: 'NO_PAIRED_SAMPLES'
      };
    }

    const weights = sortedPaired.map(r =>
      weighting === 'unweighted' ? 1 : r.gt_confidence / pairedEventCounts.get(r.event_id)
    );
    const W = weights.reduce((a, b) => a + b, 0);

    let finalAbsErrorSum = 0, finalErrorSum = 0, finalExactSum = 0, finalWithin1Sum = 0, finalSevereSum = 0;
    let baseAbsErrorSum = 0, baseErrorSum = 0, baseExactSum = 0, baseWithin1Sum = 0, baseSevereSum = 0;
    let finalWinSum = 0, tieSum = 0, baseWinSum = 0;

    for (let i = 0; i < sortedPaired.length; i++) {
      const r = sortedPaired[i];
      const w = weights[i];

      const predOrd = r.predicted_ordinal;
      const baseOrd = scoreToOrdinal(r.baseline_score);
      const gtOrd = r.gt_ordinal;

      const finalErr = predOrd - gtOrd;
      const finalAbsErr = Math.abs(finalErr);
      const baseErr = baseOrd - gtOrd;
      const baseAbsErr = Math.abs(baseErr);

      finalAbsErrorSum += w * finalAbsErr;
      finalErrorSum += w * finalErr;
      if (finalErr === 0) finalExactSum += w;
      if (finalAbsErr <= 1) finalWithin1Sum += w;
      if (finalAbsErr >= 2) finalSevereSum += w;

      baseAbsErrorSum += w * baseAbsErr;
      baseErrorSum += w * baseErr;
      if (baseErr === 0) baseExactSum += w;
      if (baseAbsErr <= 1) baseWithin1Sum += w;
      if (baseAbsErr >= 2) baseSevereSum += w;

      if (finalAbsErr < baseAbsErr) finalWinSum += w;
      else if (finalAbsErr === baseAbsErr) tieSum += w;
      else baseWinSum += w;
    }

    const finalMae = finalAbsErrorSum / W;
    const baseMae = baseAbsErrorSum / W;
    const deltaMae = finalMae - baseMae;

    return {
      weight_sum: formatMetric(W) ?? 0,
      final_mae: formatMetric(finalMae),
      final_mae_reason_code: null,
      baseline_mae: formatMetric(baseMae),
      baseline_mae_reason_code: null,
      delta_mae: formatMetric(deltaMae),
      delta_mae_reason_code: null,
      final_bias: formatMetric(finalErrorSum / W),
      final_bias_reason_code: null,
      baseline_bias: formatMetric(baseErrorSum / W),
      baseline_bias_reason_code: null,
      final_exact_accuracy: formatMetric(finalExactSum / W),
      final_exact_accuracy_reason_code: null,
      baseline_exact_accuracy: formatMetric(baseExactSum / W),
      baseline_exact_accuracy_reason_code: null,
      final_within_1_accuracy: formatMetric(finalWithin1Sum / W),
      final_within_1_accuracy_reason_code: null,
      baseline_within_1_accuracy: formatMetric(baseWithin1Sum / W),
      baseline_within_1_accuracy_reason_code: null,
      final_severe_error_rate: formatMetric(finalSevereSum / W),
      final_severe_error_rate_reason_code: null,
      baseline_severe_error_rate: formatMetric(baseSevereSum / W),
      baseline_severe_error_rate_reason_code: null,
      final_win_rate: formatMetric(finalWinSum / W),
      final_win_rate_reason_code: null,
      tie_rate: formatMetric(tieSum / W),
      tie_rate_reason_code: null,
      baseline_win_rate: formatMetric(baseWinSum / W),
      baseline_win_rate_reason_code: null
    };
  }

  const weightedMetrics = evaluateSubset('weighted');
  const unweightedMetrics = evaluateSubset('unweighted');

  const csvRows = [
    {
      benchmark_mode: benchmarkMode,
      split,
      weighting: 'weighted',
      comparator: COMPARATOR,
      benchmark_sample_count: benchmarkSampleCount,
      benchmark_event_count: benchmarkEventCount,
      paired_sample_count: pairedSampleCount,
      paired_event_count: pairedEventCount,
      missing_baseline_sample_count: missingBaselineSampleCount,
      paired_sample_coverage: pairedSampleCoverage,
      paired_sample_coverage_reason_code: pairedSampleCoverageReason,
      paired_event_coverage: pairedEventCoverage,
      paired_event_coverage_reason_code: pairedEventCoverageReason,
      ...weightedMetrics
    },
    {
      benchmark_mode: benchmarkMode,
      split,
      weighting: 'unweighted',
      comparator: COMPARATOR,
      benchmark_sample_count: benchmarkSampleCount,
      benchmark_event_count: benchmarkEventCount,
      paired_sample_count: pairedSampleCount,
      paired_event_count: pairedEventCount,
      missing_baseline_sample_count: missingBaselineSampleCount,
      paired_sample_coverage: pairedSampleCoverage,
      paired_sample_coverage_reason_code: pairedSampleCoverageReason,
      paired_event_coverage: pairedEventCoverage,
      paired_event_coverage_reason_code: pairedEventCoverageReason,
      ...unweightedMetrics
    }
  ];

  const summaryEntry = {
    comparator: COMPARATOR,
    benchmark_sample_count: benchmarkSampleCount,
    benchmark_event_count: benchmarkEventCount,
    paired_sample_count: pairedSampleCount,
    paired_event_count: pairedEventCount,
    missing_baseline_sample_count: missingBaselineSampleCount,
    paired_sample_coverage: pairedSampleCoverage,
    paired_sample_coverage_reason_code: pairedSampleCoverageReason,
    paired_event_coverage: pairedEventCoverage,
    paired_event_coverage_reason_code: pairedEventCoverageReason,
    weighted: {
      final_mae: weightedMetrics.final_mae,
      baseline_mae: weightedMetrics.baseline_mae,
      delta_mae: weightedMetrics.delta_mae,
      final_bias: weightedMetrics.final_bias,
      baseline_bias: weightedMetrics.baseline_bias,
      final_exact_accuracy: weightedMetrics.final_exact_accuracy,
      baseline_exact_accuracy: weightedMetrics.baseline_exact_accuracy,
      final_within_1_accuracy: weightedMetrics.final_within_1_accuracy,
      baseline_within_1_accuracy: weightedMetrics.baseline_within_1_accuracy,
      final_severe_error_rate: weightedMetrics.final_severe_error_rate,
      baseline_severe_error_rate: weightedMetrics.baseline_severe_error_rate,
      final_win_rate: weightedMetrics.final_win_rate,
      tie_rate: weightedMetrics.tie_rate,
      baseline_win_rate: weightedMetrics.baseline_win_rate,
      metric_reasons: {
        final_mae: weightedMetrics.final_mae_reason_code,
        baseline_mae: weightedMetrics.baseline_mae_reason_code,
        delta_mae: weightedMetrics.delta_mae_reason_code,
        final_bias: weightedMetrics.final_bias_reason_code,
        baseline_bias: weightedMetrics.baseline_bias_reason_code,
        final_exact_accuracy: weightedMetrics.final_exact_accuracy_reason_code,
        baseline_exact_accuracy: weightedMetrics.baseline_exact_accuracy_reason_code,
        final_within_1_accuracy: weightedMetrics.final_within_1_accuracy_reason_code,
        baseline_within_1_accuracy: weightedMetrics.baseline_within_1_accuracy_reason_code,
        final_severe_error_rate: weightedMetrics.final_severe_error_rate_reason_code,
        baseline_severe_error_rate: weightedMetrics.baseline_severe_error_rate_reason_code,
        final_win_rate: weightedMetrics.final_win_rate_reason_code,
        tie_rate: weightedMetrics.tie_rate_reason_code,
        baseline_win_rate: weightedMetrics.baseline_win_rate_reason_code
      }
    },
    unweighted: {
      final_mae: unweightedMetrics.final_mae,
      baseline_mae: unweightedMetrics.baseline_mae,
      delta_mae: unweightedMetrics.delta_mae,
      final_bias: unweightedMetrics.final_bias,
      baseline_bias: unweightedMetrics.baseline_bias,
      final_exact_accuracy: unweightedMetrics.final_exact_accuracy,
      baseline_exact_accuracy: unweightedMetrics.baseline_exact_accuracy,
      final_within_1_accuracy: unweightedMetrics.final_within_1_accuracy,
      baseline_within_1_accuracy: unweightedMetrics.baseline_within_1_accuracy,
      final_severe_error_rate: unweightedMetrics.final_severe_error_rate,
      baseline_severe_error_rate: unweightedMetrics.baseline_severe_error_rate,
      final_win_rate: unweightedMetrics.final_win_rate,
      tie_rate: unweightedMetrics.tie_rate,
      baseline_win_rate: unweightedMetrics.baseline_win_rate,
      metric_reasons: {
        final_mae: unweightedMetrics.final_mae_reason_code,
        baseline_mae: unweightedMetrics.baseline_mae_reason_code,
        delta_mae: unweightedMetrics.delta_mae_reason_code,
        final_bias: unweightedMetrics.final_bias_reason_code,
        baseline_bias: unweightedMetrics.baseline_bias_reason_code,
        final_exact_accuracy: unweightedMetrics.final_exact_accuracy_reason_code,
        baseline_exact_accuracy: unweightedMetrics.baseline_exact_accuracy_reason_code,
        final_within_1_accuracy: unweightedMetrics.final_within_1_accuracy_reason_code,
        baseline_within_1_accuracy: unweightedMetrics.baseline_within_1_accuracy_reason_code,
        final_severe_error_rate: unweightedMetrics.final_severe_error_rate_reason_code,
        baseline_severe_error_rate: unweightedMetrics.baseline_severe_error_rate_reason_code,
        final_win_rate: unweightedMetrics.final_win_rate_reason_code,
        tie_rate: unweightedMetrics.tie_rate_reason_code,
        baseline_win_rate: unweightedMetrics.baseline_win_rate_reason_code
      }
    }
  };

  return { csvRows, summaryEntry, warnings };
}
