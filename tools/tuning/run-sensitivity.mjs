#!/usr/bin/env node
import { isMain, canonicalJson } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { buildSensitivityPackage } from './lib/build.mjs';
import { publishPackage } from './lib/publish.mjs';
import { captureWhitelistFingerprints, verifyUpstreamSources, loadEvaluationLinkage } from './lib/input.mjs';
import { inspectSensitivity } from './validate-sensitivity.mjs';

export async function runSensitivity(options) {
  const built = await buildSensitivityPackage(options);
  const before = await captureWhitelistFingerprints(options.model);
  const published = await publishPackage({
    output: options.output,
    roots: [options.model, options.raw, options.gt, options.baseline].filter(Boolean),
    files: built.files,
    manifest: built.manifest,
    progress: options.progress,
    validateStaging: async staging => { await inspectSensitivity(staging, { staging: true }); },
    sourceCheck: async () => {
      await verifyUpstreamSources(options.model, options.raw, options.gt);
      const after = await captureWhitelistFingerprints(options.model);
      if (canonicalJson(before) !== canonicalJson(after)) {
        const error = new Error('SOURCE_CHANGED_DURING_TUNING');
        error.code = 'SOURCE_CHANGED_DURING_TUNING';
        throw error;
      }
      await loadEvaluationLinkage(options.baseline, built.ctx.input.linkage);
    }
  });
  return {
    status: published.status,
    sensitivity_id: published.sensitivity_id,
    directory: published.directory,
    global_readiness: built.summary.global_readiness,
    result_usage: built.summary.result_usage,
    cohort: built.summary.cohort,
    experiment_count: built.summary.experiment_count,
    counts: built.counts,
    engine_runtime_sha256: built.manifest.engine_runtime_sha256,
    tuning_base_config_sha256: built.manifest.tuning_base_config_sha256,
    parameter_registry_sha256: built.manifest.parameter_registry_sha256,
    descriptor_sha256: built.manifest.descriptor_sha256
  };
}

if (isMain(import.meta.url)) await runCli('sensitivity', runSensitivity);
