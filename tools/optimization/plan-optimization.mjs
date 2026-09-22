#!/usr/bin/env node
import { canonicalJson, hash, isMain } from '../dataset/lib/common.mjs';
import { silentProgress } from '../progress.mjs';
import { runCli } from './lib/cli.mjs';
import { loadOptimizationInput, sourceIdentity } from './lib/input.mjs';
import { buildSearchSpace, publicSearchSpace } from './lib/search-space.mjs';
import { coarseProposals } from './lib/generator.mjs';
import { cohortProfile, computeOptimizationReadiness } from './lib/readiness.mjs';
import { optimizationInputIdentity } from './lib/build.mjs';
import { optimizationPolicy } from './optimization-policy.mjs';

/**
 * Dry run: reports the run mode, the eligible / excluded Search Space, the replay volume and the
 * freeze eligibility before any Candidate is evaluated.
 */
export async function planOptimization(options) {
  const progress = options.progress || silentProgress;
  const policy = optimizationPolicy();
  const input = await loadOptimizationInput({
    model: options.model, raw: options.raw, gt: options.gt,
    baseline: options.baseline, sensitivity: options.sensitivity,
    root: options.root, progress
  });
  const source = sourceIdentity(input);
  const profile = cohortProfile(input.model.rows);
  const replayUsableRate = input.sensitivity.readiness?.metrics?.replay_usable_rate ?? 1;
  const readiness = computeOptimizationReadiness({
    profile, replayUsableRate, sensitivityLinkage: input.sensitivity.linkage
  });
  const searchSpace = buildSearchSpace({
    mode: readiness.optimization_mode, registry: input.sensitivity.registry,
    readiness: input.sensitivity.readiness, baseConfig: input.sensitivity.baseConfig,
    linkage: input.sensitivity.linkage
  });
  const publicSpace = publicSearchSpace(searchSpace);
  const searchSpaceSha256 = hash(canonicalJson(publicSpace));
  const optimizationInputId = `optimization_input_${hash(canonicalJson(
    optimizationInputIdentity({ source, searchSpaceSha256, policy })
  )).slice(0, 16)}`;
  const seeds = 1 + coarseProposals(searchSpace).length;
  return {
    status: 'PLANNED',
    optimization_input_id: optimizationInputId,
    optimization_mode: readiness.optimization_mode,
    optimization_readiness: readiness.optimization_readiness,
    search_space_id: searchSpace.search_space_id,
    search_space_sha256: searchSpaceSha256,
    cohort: {
      samples: input.summary.sample_count,
      events: input.summary.event_count,
      dates: input.summary.date_count,
      replay_payload_count: input.cohort.length
    },
    replay_count_per_candidate: input.cohort.length,
    declared_units: [...searchSpace.declared_units],
    active_units: [...searchSpace.unit_order],
    excluded_units: searchSpace.excluded_units,
    search_budget: { ...policy.algorithm },
    declared_probe_count: seeds,
    estimated_candidate_ceiling: Math.min(
      policy.algorithm.max_unique_candidates,
      policy.algorithm.stage_a_b_budget + policy.algorithm.stage_c_budget
    ),
    engine_runtime_sha256: source.engine_runtime_sha256,
    tuning_base_config_sha256: source.tuning_base_config_sha256,
    parameter_registry_sha256: source.parameter_registry_sha256,
    freeze_eligibility: {
      candidate_freeze_allowed: readiness.optimization_mode === 'FORMAL_OPTIMIZATION',
      blocking_reasons: readiness.reasons
    },
    readiness: {
      engineering_readiness: readiness.engineering_readiness,
      data_readiness: readiness.data_readiness,
      metric_readiness: readiness.metric_readiness,
      label_concentration: readiness.label_concentration
    }
  };
}

if (isMain(import.meta.url)) await runCli('plan', planOptimization);
