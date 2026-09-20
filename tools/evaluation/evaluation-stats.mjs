#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { inspectEvaluation } from './validate-evaluation.mjs';
import { runCli } from './lib/cli.mjs';

export async function evaluationStats(directory, options = {}) {
  const result = await inspectEvaluation(directory, options);
  const { manifest, summary } = result;

  const headlineSummary = {};
  for (const [key, group] of Object.entries(summary.groups)) {
    headlineSummary[key] = {
      sample_count: group.sample_count,
      event_count: group.event_count,
      date_count: group.date_count,
      weight_sum: group.weight_sum,
      weighted_mae: group.weighted.mae,
      weighted_bias: group.weighted.bias,
      weighted_exact_accuracy: group.weighted.exact_accuracy,
      weighted_within_1_accuracy: group.weighted.within_1_accuracy,
      weighted_severe_error_rate: group.weighted.severe_error_rate,
      weighted_qwk: group.weighted.qwk,
      unweighted_mae: group.unweighted.mae,
      unweighted_bias: group.unweighted.bias,
      unweighted_exact_accuracy: group.unweighted.exact_accuracy,
      unweighted_within_1_accuracy: group.unweighted.within_1_accuracy,
      unweighted_severe_error_rate: group.unweighted.severe_error_rate,
      unweighted_qwk: group.unweighted.qwk
    };
  }

  return {
    status: 'PASS',
    evaluation_id: manifest.evaluation_id,
    model_dataset_id: manifest.model_dataset_id,
    sample_count: manifest.sample_count,
    event_count: manifest.event_count,
    date_count: manifest.date_count,
    benchmark_counts: manifest.benchmark_counts,
    evaluated_versions: manifest.evaluated_versions,
    headline_summary: headlineSummary,
    warnings_summary: summary.warnings_summary,
    ...(manifest.evaluation_schema_version === 2 ? {
      mapping_status: manifest.mapping_status,
      interpretation_scope: manifest.interpretation_scope,
      no_skill_reference: manifest.no_skill_reference,
      no_skill_comparison: Object.fromEntries(Object.entries(summary.groups)
        .map(([key, group]) => [key, group.no_skill_comparison]))
    } : {})
  };
}

if (isMain(import.meta.url)) await runCli('stats', o => evaluationStats(o.path, o));
