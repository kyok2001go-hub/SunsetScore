#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, fail, isMain, readSafe } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { buildOptimizationPackage } from './lib/build.mjs';
import { fingerprintSourcePackage } from './lib/input.mjs';
import { APP_ROOT } from '../tuning/lib/engine-runtime.mjs';
import { defaultOutputRoot, publishOptimizationPackage } from './lib/publish.mjs';
import { inspectOptimization } from './validate-optimization.mjs';
import { withBuildLease } from '../maintenance/lib/lease.mjs';
import { datasetRootForPhaseOutput } from '../maintenance/maintenance-policy.mjs';
import { formalMissingReasons, validateFormalSourceContext, withFormalLeases } from '../formal/context.mjs';

async function runOptimizationBuild(options) {
  const built = await buildOptimizationPackage(options);
  const sourcesBefore = built.input.sourceFingerprints;
  const published = await publishOptimizationPackage({
    output: options.output,
    roots: [options.model, options.raw, options.gt, options.baseline, options.sensitivity, options.campaign, options.metricEvidence, options.runtimeBundle].filter(Boolean),
    files: built.files,
    manifest: built.manifest,
    progress: options.progress,
    validateStaging: async staging => { await inspectOptimization(staging, { staging: true }); },
    sourceCheck: async () => {
      if (options.optimizationPolicyVersion === 3) await validateFormalSourceContext(built.input.sensitivity.formalContext, options);
      const sourceDirectories = {
        model: options.model, raw: options.raw, gt: options.gt,
        baseline: options.baseline, sensitivity: options.sensitivity
      };
      for (const [name, directory] of Object.entries(sourceDirectories)) {
        const after = await fingerprintSourcePackage(directory);
        if (canonicalJson(sourcesBefore[name]) !== canonicalJson(after)) {
          fail('OPTIMIZATION_VALIDATION_FAILED', {
            reason_code: `${name.toUpperCase()}_CHANGED_DURING_OPTIMIZATION`
          });
        }
      }
    }
  });
  return {
    status: published.status,
    optimization_id: published.optimization_id,
    directory: published.directory,
    optimization_mode: built.mode,
    optimization_outcome: built.counts.optimization_outcome,
    candidate_freeze_allowed: built.counts.candidate_freeze_allowed,
    validation_promotion_allowed: built.counts.validation_promotion_allowed,
    candidate_count: built.counts.candidate_count,
    feasible_candidate_count: built.counts.feasible_candidate_count,
    finalist_count: built.counts.finalist_count,
    search_budget: built.files['readiness.json'] ? JSON.parse(built.files['readiness.json']).search_budget : null,
    engine_runtime_sha256: built.manifest.engine_runtime_sha256,
    tuning_base_config_sha256: built.manifest.tuning_base_config_sha256,
    parameter_registry_sha256: built.manifest.parameter_registry_sha256,
    descriptor_sha256: built.manifest.descriptor_sha256,
    ...(options.optimizationPolicyVersion === 3 ? { result_usage: built.manifest.result_usage } : {})
  };
}

/** Holds the shared maintenance lease so prune never races an Optimization publish. */
export async function runOptimization(options) {
  if(options.optimizationPolicyVersion===5||options.plan&&JSON.parse(await readSafe(path.join(options.plan,'manifest.json'))).optimization_policy_version===5)
    return (await import('../product-evaluation/package.mjs')).runProductArtifact(options);
  if (options.plan || options.optimizationPolicyVersion === 4) {
    return (await import('../optimization-diagnostics/optimization-adapter.mjs')).runDevelopmentOptimization(options);
  }
  if (options.optimizationPolicyVersion === 3) {
    const reasons = formalMissingReasons(options); if (reasons.length) return { status: 'BLOCKED', blocking_reasons: reasons };
    return withFormalLeases('optimization', options, options.output || defaultOutputRoot(APP_ROOT), () => runOptimizationBuild(options));
  }
  return withBuildLease('optimization', () => runOptimizationBuild(options), {
    datasetRoot: datasetRootForPhaseOutput('optimization', options.output || defaultOutputRoot(APP_ROOT))
  });
}

if (isMain(import.meta.url)) await runCli('run', runOptimization);
