import { canonicalJson } from '../../dataset/lib/common.mjs';
import { prepareContext } from './pipeline.mjs';
import { planExperiments, runExperiments } from './experiment.mjs';
import {
  experimentMetricRow, ablationMetricRow, sampleDeltaRows, sliceDeltaRows,
  parameterSummaryRows, buildWarnings, failureRows
} from './report.mjs';
import { contents, filesMetadata, descriptorOf, makeManifest } from './package.mjs';
import { runReplay } from '../../replay/replay-runner.mjs';
import { silentProgress } from '../../progress.mjs';
import { leaveOneDateOut } from './stability.mjs';

function ablationAffected(rows) {
  return rows.filter(row => row.experiment_score !== row.control_score).length;
}

/**
 * Builds the whole Sensitivity package in memory. No timestamps, no absolute paths and no
 * run metadata enter the contents, so identical inputs always produce identical bytes.
 */
export async function buildSensitivityPackage(options) {
  const progress = options.progress || silentProgress;
  const ctx = await prepareContext(options);
  progress.stage('生成敏感度实验计划');
  const plan = planExperiments({ units: ctx.units, ablations: ctx.ablations, config: ctx.loaded.config });
  progress.stage(`执行 ${plan.length} 个实验`);
  const { results, failures } = await runExperiments({
    plan, units: ctx.units, ablations: ctx.ablations, cohort: ctx.cohort,
    config: ctx.loaded.config, runReplay, progress
  });

  progress.stage('汇总指标、切片与稳定性');
  const experimentMetrics = results.map(result => experimentMetricRow({
    entry: result.entry,
    rows: result.rows,
    composition: result.composition,
    stability: leaveOneDateOut(result.rows, 'experiment_ordinal'),
    coverage: result.coverage
  }));
  const metricsByExperiment = new Map(experimentMetrics.map(row => [row.experiment_id, row]));
  const ablationMetrics = results
    .filter(result => result.entry.experiment_kind === 'ABLATION')
    .map(result => ablationMetricRow(metricsByExperiment.get(result.entry.experiment_id), result.entry, ablationAffected(result.rows)));
  const sampleDeltas = sampleDeltaRows(results);
  const sliceDeltas = sliceDeltaRows(results);
  const parameterSummary = parameterSummaryRows({ ctx, results, experimentMetrics });
  const experimentFailureRows = failureRows(failures);
  const warningRows = buildWarnings({ ctx, parameterSummary, ablationMetrics });
  const warningCounts = {};
  for (const row of warningRows) warningCounts[row.warning_code] = (warningCounts[row.warning_code] || 0) + 1;
  const resultUsage = ctx.readiness.global_readiness === 'TUNING_READY' ? 'FORMAL' : 'EXPLORATORY_ONLY';

  const experimentPlanRows = plan.map(entry => ({
    experiment_order: entry.experiment_order,
    experiment_id: entry.experiment_id,
    experiment_kind: entry.experiment_kind,
    parameter_id: entry.parameter_id,
    group_id: entry.group_id,
    canonical_path: entry.canonical_path,
    probe_index: entry.probe_index,
    probe_value: entry.probe_value,
    ablation: entry.ablation,
    ablation_layer: entry.ablation_layer,
    replay_count: ctx.cohort.length
  }));

  const parameterSummaryForReport = parameterSummary.map(row => ({
    parameter_id: row.parameter_id, group_id: row.group_id, wired_status: row.wired_status,
    parameter_readiness: row.parameter_readiness, observability_status: row.observability_status,
    probe_count: row.probe_count, max_changed_score_rate: row.max_changed_score_rate,
    best_delta_mae: row.best_delta_mae, direction_stability_ratio: row.direction_stability_ratio,
    reason_code: row.reason_code
  }));
  const ablationSummary = ablationMetrics.map(row => ({
    ablation: row.ablation, ablation_layer: row.ablation_layer, affected_sample_count: row.affected_sample_count,
    changed_score_rate: row.changed_score_rate, mean_score_delta: row.mean_score_delta,
    control_mae: row.control_mae, experiment_mae: row.experiment_mae, delta_mae: row.delta_mae
  }));

  const readinessDoc = {
    ...ctx.readiness,
    cohort: {
      samples: ctx.input.rows.length,
      events: ctx.profiles.primary_events,
      dates: ctx.profiles.unique_dates,
      replay_pass_count: ctx.parity.summary.pass_count,
      replay_fail_count: ctx.parity.summary.fail_count
    },
    parameter_readiness: parameterSummary.map(row => ({
      parameter_id: row.parameter_id, wired_status: row.wired_status,
      parameter_readiness: row.parameter_readiness, observability_status: row.observability_status,
      reason_code: row.reason_code, support_samples: row.support_samples,
      support_events: row.support_events, support_dates: row.support_dates
    })),
    warnings: warningRows.map(row => row.warning_code)
  };

  const files = contents({
    engineRuntime: ctx.engineRuntime,
    baseConfig: { ...ctx.loaded, sha256: ctx.loaded.sha256 },
    registry: ctx.registry,
    readiness: readinessDoc,
    parityRows: ctx.parity.rows,
    planRows: experimentPlanRows,
    experimentMetrics,
    sampleDeltas,
    sliceDeltas,
    ablationMetrics,
    experimentFailureRows,
    parameterSummary,
    warningRows,
    summary: {
      sensitivity_id: null,
      model_dataset_id: ctx.source.model_dataset_id,
      evaluation_id: ctx.source.evaluation_id,
      global_readiness: ctx.readiness.global_readiness,
      result_usage: resultUsage,
      cohort: { samples: ctx.input.rows.length, events: ctx.profiles.primary_events, dates: ctx.profiles.unique_dates },
      experiment_count: plan.length,
      replay_parity: ctx.parity.summary,
      parameter_summary: parameterSummaryForReport,
      ablation_summary: ablationSummary,
      warnings_summary: warningCounts
    }
  });

  // The descriptor deliberately excludes reports/summary.json, so the identity can be
  // computed before the id is written back into that file.
  const metadata = filesMetadata(files);
  const counts = {
    sample_count: ctx.input.rows.length,
    event_count: ctx.profiles.primary_events,
    date_count: ctx.profiles.unique_dates,
    experiment_count: plan.length
  };
  const descriptor = descriptorOf(ctx.source, metadata, {
    splits: ['TRAIN'],
    experiment_count: plan.length,
    parameter_registry_version: ctx.registry.parameter_registry_version,
    probes: plan.map(entry => [entry.experiment_id, entry.probe_value])
  });
  const manifest = makeManifest(ctx.source, counts, readinessDoc, metadata, descriptor);
  const summary = JSON.parse(files['reports/summary.json']);
  summary.sensitivity_id = manifest.sensitivity_id;
  files['reports/summary.json'] = canonicalJson(summary);
  const finalMetadata = filesMetadata(files);
  return { ctx, files, manifest: { ...manifest, files: finalMetadata }, counts, summary };
}
