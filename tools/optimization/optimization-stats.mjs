#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { inspectOptimization } from './validate-optimization.mjs';

/** Package-internal validation plus a short, readable optimization summary. */
export async function optimizationStats(options) {
  const inspected = await inspectOptimization(options.path, options);
  const { manifest, summary } = inspected;
  return {
    status: 'PASS',
    validation_scope: inspected.validation_scope,
    optimization_id: manifest.optimization_id,
    optimization_mode: manifest.optimization_mode,
    optimization_outcome: manifest.optimization_outcome,
    candidate_freeze_allowed: manifest.candidate_freeze_allowed,
    search_space_id: manifest.search_space_id,
    search_budget: summary.search_budget,
    search_converged: summary.search_converged,
    cohort: summary.cohort,
    candidate_count: summary.candidate_count,
    feasible_candidate_count: summary.feasible_candidate_count,
    finalist_count: summary.finalist_count,
    readiness: {
      engineering_readiness: summary.engineering_readiness,
      data_readiness: summary.data_readiness,
      metric_readiness: summary.metric_readiness,
      global_readiness: summary.global_readiness
    },
    reasons: summary.reasons,
    warnings_summary: summary.warnings_summary,
    top_candidates: summary.top_candidates
  };
}

if (isMain(import.meta.url)) await runCli('stats', optimizationStats);
