import { canonicalJson, hash, compare, unique, fail } from '../../dataset/lib/common.mjs';
import { writeCsv, readCsv } from '../../dataset/lib/csv.mjs';
import { evaluationSchema } from '../evaluation-schema.mjs';
import { evaluationPolicy } from '../evaluation-policy.mjs';
import {
  scoreToOrdinal,
  computeLeadTimeBucket,
  computeHeadlineMetrics,
  computeConfusionMatrix,
  computeLeadTimeCoverage,
  computeScoreDistribution,
  computeSpearman,
  formatMetric
} from '../metrics.mjs';
import { computeSliceMetrics, computeWorstSlices } from '../slice-analysis.mjs';
import { computeBaselineComparison } from '../baseline-comparison.mjs';
import { CSV_TABLES, EXPORT_FILES, makeManifest } from './package.mjs';
import { silentProgress } from '../../progress.mjs';

function compareWarnings(a, b) {
  for (const key of ['warning_code', 'benchmark_mode', 'split', 'slice_dimension', 'slice_value', 'slice_value_is_null']) {
    if (a[key] === b[key]) continue;
    if (a[key] === null) return -1;
    if (b[key] === null) return 1;
    const d = compare(a[key], b[key]);
    if (d) return d;
  }
  return 0;
}

export function evaluate(modelManifest, modelManifestSha256, trainRows, validationRows, inputWarnings = [], progress = silentProgress) {
  const schema = evaluationSchema(1);
  const policy = evaluationPolicy(1);

  progress.stage('准备评估样本与派生字段');
  const cloneRow = r => {
    const copy = { ...r };
    const computedBucket = computeLeadTimeBucket(r.lead_time_minutes);
    if (r.lead_time_bucket && r.lead_time_bucket !== computedBucket) {
      fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'LEAD_TIME_BUCKET_MISMATCH' });
    }
    copy.lead_time_bucket = r.lead_time_bucket || computedBucket;
    return copy;
  };

  const order = (a, b) => compare(a.snapshot_id, b.snapshot_id);
  const clonedTrain = trainRows.map(cloneRow).sort(order);
  const clonedVal = validationRows.map(cloneRow).sort(order);
  const allRows = [...clonedTrain, ...clonedVal].sort(order);

  // Derive fields on all rows
  for (const r of allRows) {
    r.predicted_ordinal = scoreToOrdinal(r.predicted_score);
    r.ordinal_error = r.predicted_ordinal - r.gt_ordinal;
    r.absolute_error = Math.abs(r.ordinal_error);
    r.is_high_confidence = (r.gt_status === policy.high_confidence_rule.gt_status);
    r.is_severe = (r.absolute_error >= policy.severe_error_threshold);

    if (r.baseline_score != null) {
      r.baseline_ordinal = scoreToOrdinal(r.baseline_score);
      r.baseline_absolute_error = Math.abs(r.baseline_ordinal - r.gt_ordinal);
      if (r.absolute_error < r.baseline_absolute_error) r.paired_outcome = 'FINAL_WIN';
      else if (r.absolute_error === r.baseline_absolute_error) r.paired_outcome = 'TIE';
      else r.paired_outcome = 'BASELINE_WIN';
    } else {
      r.baseline_ordinal = null;
      r.baseline_absolute_error = null;
      r.paired_outcome = null;
    }
  }

  // Check multiple engine builds
  const warnings = [...inputWarnings];
  const evaluatedShas = unique(allRows.map(r => r.engine_build_sha));
  if (evaluatedShas.length > 1) {
    warnings.push({
      warning_code: 'MULTIPLE_ENGINE_BUILDS',
      benchmark_mode: null,
      split: null,
      slice_dimension: null,
      slice_value: null,
      slice_value_is_null: null
    });
  }

  progress.stage('选择 CLOSEST_PRE_SUNSET 与标记成员');
  // CLOSEST selection per event:
  // Sort candidates by:
  // 1. lead_time_minutes ASC
  // 2. prediction_time_epoch DESC
  // 3. snapshot_id Unicode codepoints ASC
  const eventsMap = new Map();
  for (const r of allRows) {
    if (!eventsMap.has(r.event_id)) eventsMap.set(r.event_id, []);
    eventsMap.get(r.event_id).push(r);
  }

  const closestSnapshotIds = new Set();
  for (const [eid, candidates] of eventsMap.entries()) {
    const valid = candidates.filter(r => r.lead_time_minutes >= 0);
    if (valid.length === 0) continue;
    valid.sort((a, b) => {
      if (a.lead_time_minutes !== b.lead_time_minutes) {
        return a.lead_time_minutes - b.lead_time_minutes;
      }
      if (a.prediction_time_epoch !== b.prediction_time_epoch) {
        return b.prediction_time_epoch - a.prediction_time_epoch;
      }
      return compare(a.snapshot_id, b.snapshot_id);
    });
    closestSnapshotIds.add(valid[0].snapshot_id);
  }

  for (const r of allRows) {
    r.selected_in_closest = closestSnapshotIds.has(r.snapshot_id);
  }

  // Setup datasets for the two benchmarks across the three splits
  const benchmarkDatasets = {
    ALL_PRIMARY: {
      TRAIN: clonedTrain.map(r => ({ ...r, weight: r.event_normalized_weight })),
      VALIDATION: clonedVal.map(r => ({ ...r, weight: r.event_normalized_weight })),
      TRAIN_VALIDATION: allRows.map(r => ({ ...r, weight: r.event_normalized_weight }))
    },
    CLOSEST_PRE_SUNSET: {
      TRAIN: clonedTrain.filter(r => r.selected_in_closest).map(r => ({ ...r, weight: r.gt_confidence })),
      VALIDATION: clonedVal.filter(r => r.selected_in_closest).map(r => ({ ...r, weight: r.gt_confidence })),
      TRAIN_VALIDATION: allRows.filter(r => r.selected_in_closest).map(r => ({ ...r, weight: r.gt_confidence }))
    }
  };

  progress.stage('生成 error_cases.csv');
  // error_cases.csv contains all rows in ALL_PRIMARY where absolute_error > 0
  const errorRows = allRows.filter(r => r.absolute_error > 0);
  errorRows.sort((a, b) => {
    if (b.absolute_error !== a.absolute_error) return b.absolute_error - a.absolute_error;
    if (b.gt_confidence !== a.gt_confidence) return b.gt_confidence - a.gt_confidence;
    const dateComp = compare(a.event_date_local, b.event_date_local);
    if (dateComp) return dateComp;
    return compare(a.snapshot_id, b.snapshot_id);
  });

  const errorCasesFields = schema.tables.error_cases.map(f => f.name);
  const errorCasesRows = errorRows.map(r => Object.fromEntries(errorCasesFields.map(k => {
    let val = r[k];
    if (val === undefined) {
      if (['tile_radar_available', 'tile_sat_available'].includes(k)) val = false;
      else val = null;
    }
    return [k, val];
  })));

  progress.stage('计算主指标、混淆矩阵、分布与切片');
  const confusionMatrixRows = [];
  const scoreDistributionRows = [];
  const baselineComparisonRows = [];
  const sliceMetricsRows = [];

  const overallMetricsJson = {
    evaluation_schema_version: 1,
    evaluation_policy_version: 1,
    benchmark_modes: policy.benchmark_modes,
    splits: policy.report_splits,
    benchmarks: {}
  };

  const summaryGroups = {};
  const benchmarkCounts = {};

  for (const mode of policy.benchmark_modes) {
    overallMetricsJson.benchmarks[mode] = {};
    benchmarkCounts[mode] = {};

    for (const split of policy.report_splits) {
      const rows = benchmarkDatasets[mode][split];
      const sampleCount = rows.length;
      const eventCount = unique(rows.map(r => r.event_id)).length;
      const dateCount = unique(rows.map(r => r.event_date_local)).length;
      const weightSum = formatMetric(rows.reduce((sum, r) => sum + r.weight, 0)) ?? 0;

      benchmarkCounts[mode][split] = {
        sample_count: sampleCount,
        event_count: eventCount,
        date_count: dateCount,
        weight_sum: weightSum
      };

      // 1. Headline metrics (weighted & unweighted)
      const weightedHeadline = computeHeadlineMetrics(rows, 'weighted');
      const unweightedHeadline = computeHeadlineMetrics(rows, 'unweighted');

      // 2. Confusion matrix (5x5)
      const confMatrix = computeConfusionMatrix(rows, mode, split);
      confusionMatrixRows.push(...confMatrix);

      // 3. Lead time coverage
      const leadTimeCov = computeLeadTimeCoverage(rows);
      if (leadTimeCov.buckets.T_0_30M.sample_count === 0) {
        warnings.push({
          warning_code: 'NO_NEAR_SUNSET_COVERAGE',
          benchmark_mode: mode,
          split,
          slice_dimension: null,
          slice_value: null,
          slice_value_is_null: null
        });
      }

      // 4. Score distribution
      const scoreDist = computeScoreDistribution(rows, mode, split);
      scoreDistributionRows.push(...scoreDist);

      // 5. Ranking diagnostics (Spearman correlation)
      const rankingDiag = computeSpearman(
        rows.map(r => r.predicted_score),
        rows.map(r => r.gt_ordinal)
      );

      // 6. Baseline comparison
      const baselineComp = computeBaselineComparison(rows, mode, split);
      baselineComparisonRows.push(...baselineComp.csvRows);
      warnings.push(...baselineComp.warnings);

      // 7. Slice metrics
      const sliceResult = computeSliceMetrics(rows, mode, split, policy);
      sliceMetricsRows.push(...sliceResult.sliceRows);
      warnings.push(...sliceResult.warnings);

      // 8. Worst slices for summary
      const worstSlices = computeWorstSlices(sliceResult.sliceRows, mode, split, policy.worst_slices_dimensions);

      // 9. High confidence summary
      const highConfRows = rows.filter(r => r.is_high_confidence);
      const highConfSampleCount = highConfRows.length;
      const highConfEventCount = unique(highConfRows.map(r => r.event_id)).length;
      const highConfSevereRows = highConfRows.filter(r => r.is_severe);
      const highConfSevereSampleCount = highConfSevereRows.length;
      const highConfSevereEventCount = unique(highConfSevereRows.map(r => r.event_id)).length;

      let severeSampleRate = null, severeSampleRateReason = null;
      let severeEventRate = null, severeEventRateReason = null;

      if (highConfSampleCount === 0) {
        severeSampleRateReason = 'NO_HIGH_CONFIDENCE_SAMPLES';
        severeEventRateReason = 'NO_HIGH_CONFIDENCE_SAMPLES';
        warnings.push({
          warning_code: 'NO_HIGH_CONFIDENCE_SAMPLES',
          benchmark_mode: mode,
          split,
          slice_dimension: null,
          slice_value: null,
          slice_value_is_null: null
        });
      } else {
        severeSampleRate = formatMetric(highConfSevereSampleCount / highConfSampleCount);
        severeEventRate = formatMetric(highConfSevereEventCount / highConfEventCount);
      }

      // 10. Worst cases for summary: top 20 distinct Events with error
      const errorInGroup = rows.filter(r => r.absolute_error > 0);
      errorInGroup.sort((a, b) => {
        if (b.absolute_error !== a.absolute_error) return b.absolute_error - a.absolute_error;
        if (b.gt_confidence !== a.gt_confidence) return b.gt_confidence - a.gt_confidence;
        const dateComp = compare(a.event_date_local, b.event_date_local);
        if (dateComp) return dateComp;
        return compare(a.snapshot_id, b.snapshot_id);
      });

      const seenEvents = new Set();
      const worstCases = [];
      for (const r of errorInGroup) {
        if (!seenEvents.has(r.event_id)) {
          seenEvents.add(r.event_id);
          worstCases.push({
            event_id: r.event_id,
            snapshot_id: r.snapshot_id,
            event_date_local: r.event_date_local,
            location_key: r.location_key,
            city: r.city,
            country: r.country,
            admin1: r.admin1,
            lead_time_minutes: r.lead_time_minutes,
            predicted_score: r.predicted_score,
            predicted_ordinal: r.predicted_ordinal,
            gt_label: r.gt_label,
            gt_ordinal: r.gt_ordinal,
            gt_confidence: r.gt_confidence,
            ordinal_error: r.ordinal_error,
            absolute_error: r.absolute_error,
            is_high_confidence: r.is_high_confidence,
            is_severe: r.is_severe
          });
          if (worstCases.length === policy.worst_cases_limit) break;
        }
      }

      overallMetricsJson.benchmarks[mode][split] = {
        sample_count: sampleCount,
        event_count: eventCount,
        date_count: dateCount,
        weight_sum: weightSum,
        weighted: weightedHeadline,
        unweighted: unweightedHeadline,
        lead_time_coverage: leadTimeCov,
        ranking_diagnostics: {
          weighting: 'unweighted',
          spearman_correlation: rankingDiag.correlation,
          metric_reasons: { spearman_correlation: rankingDiag.reason_code },
          spearman_reason_code: rankingDiag.reason_code
        }
      };

      summaryGroups[`${mode}.${split}`] = {
        benchmark_mode: mode,
        split,
        sample_count: sampleCount,
        event_count: eventCount,
        date_count: dateCount,
        weight_sum: weightSum,
        weighted: weightedHeadline,
        unweighted: unweightedHeadline,
        lead_time_coverage: leadTimeCov,
        ranking_diagnostics: {
          weighting: 'unweighted',
          spearman_correlation: rankingDiag.correlation,
          metric_reasons: { spearman_correlation: rankingDiag.reason_code },
          spearman_reason_code: rankingDiag.reason_code
        },
        baseline_comparison: baselineComp.summaryEntry,
        high_confidence: {
          high_confidence_sample_count: highConfSampleCount,
          high_confidence_event_count: highConfEventCount,
          high_confidence_severe_sample_count: highConfSevereSampleCount,
          high_confidence_severe_event_count: highConfSevereEventCount,
          severe_sample_rate: severeSampleRate,
          severe_sample_rate_reason_code: severeSampleRateReason,
          severe_event_rate: severeEventRate,
          severe_event_rate_reason_code: severeEventRateReason,
          weighting: 'unweighted',
          metric_reasons: { severe_sample_rate: severeSampleRateReason, severe_event_rate: severeEventRateReason }
        },
        worst_slices: worstSlices,
        worst_cases: worstCases
      };
    }
  }

  progress.stage('整理与排序警告');
  // Canonical sort and deduplicate warnings
  warnings.sort(compareWarnings);
  const deduplicatedWarnings = [];
  const seenWarnings = new Set();
  const warningCounts = {};

  for (const w of warnings) {
    const key = canonicalJson(w);
    if (!seenWarnings.has(key)) {
      seenWarnings.add(key);
      deduplicatedWarnings.push(w);
      warningCounts[w.warning_code] = (warningCounts[w.warning_code] || 0) + 1;
    }
  }

  const evaluatedVersions = {
    config_hashes: unique(allRows.map(r => r.config_hash)),
    engine_build_shas: unique(allRows.map(r => r.engine_build_sha)),
    model_versions: unique(allRows.map(r => r.model_version))
  };

  const summaryJson = {
    model_dataset_id: modelManifest.model_dataset_id,
    evaluation_schema_version: 1,
    evaluation_policy_version: 1,
    evaluated_splits: ['TRAIN', 'VALIDATION'],
    test_evaluated: false,
    benchmark_modes: policy.benchmark_modes,
    evaluated_versions: evaluatedVersions,
    groups: summaryGroups,
    warnings_summary: warningCounts
  };

  progress.stage('规范化文件编码与生成元数据');
  const files = {
    'schema.json': canonicalJson(schema),
    'policy.json': canonicalJson(policy),
    'overall_metrics.json': canonicalJson(overallMetricsJson),
    'confusion_matrix.csv': writeCsv(schema.tables.confusion_matrix, confusionMatrixRows),
    'slice_metrics.csv': writeCsv(schema.tables.slice_metrics, sliceMetricsRows),
    'score_distribution.csv': writeCsv(schema.tables.score_distribution, scoreDistributionRows),
    'baseline_comparison.csv': writeCsv(schema.tables.baseline_comparison, baselineComparisonRows),
    'error_cases.csv': writeCsv(schema.tables.error_cases, errorCasesRows),
    'reports/summary.json': canonicalJson(summaryJson),
    'reports/warnings.csv': writeCsv(schema.tables.warnings, deduplicatedWarnings)
  };

  const filesMetadata = Object.fromEntries(
    EXPORT_FILES.map(f => {
      const content = files[f];
      const bytes = Buffer.byteLength(content);
      const digest = hash(content);
      const isCsv = f.endsWith('.csv');
      const rowCount = isCsv ? readCsv(schema.tables[f.replace('reports/', '').replace('.csv', '')], content).length : undefined;
      return [f, { sha256: digest, bytes, ...(rowCount !== undefined ? { rows: rowCount } : {}) }];
    })
  );

  const descriptor = {
    benchmark_modes: policy.benchmark_modes,
    evaluated_splits: ['TRAIN', 'VALIDATION'],
    evaluation_policy_version: 1,
    evaluation_schema_version: 1,
    files_sha256: Object.fromEntries(EXPORT_FILES.map(f => [f, filesMetadata[f].sha256])),
    model_dataset_descriptor_sha256: modelManifest.descriptor_sha256,
    model_dataset_id: modelManifest.model_dataset_id,
    model_dataset_manifest_sha256: modelManifestSha256,
    policy_sha256: filesMetadata['policy.json'].sha256,
    schema_sha256: filesMetadata['schema.json'].sha256,
    test_access_policy: 'UPSTREAM_VALIDATION_ONLY'
  };

  const counts = {
    sample_count: allRows.length,
    event_count: unique(allRows.map(r => r.event_id)).length,
    date_count: unique(allRows.map(r => r.event_date_local)).length
  };

  const manifest = makeManifest(
    modelManifest,
    modelManifestSha256,
    filesMetadata,
    counts,
    benchmarkCounts,
    evaluatedVersions,
    descriptor
  );

  return {
    files: {
      ...files,
      'manifest.json': canonicalJson(manifest)
    },
    manifest,
    descriptor,
    counts,
    benchmarkCounts,
    evaluatedVersions
  };
}
