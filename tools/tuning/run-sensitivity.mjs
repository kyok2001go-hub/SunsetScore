#!/usr/bin/env node
import { isMain, canonicalJson } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { buildSensitivityPackage } from './lib/build.mjs';
import { defaultOutputRoot, publishPackage } from './lib/publish.mjs';
import { captureWhitelistFingerprints, verifyUpstreamSources, loadEvaluationLinkage } from './lib/input.mjs';
import { inspectSensitivity } from './validate-sensitivity.mjs';
import { buildSensitivityPackageV2 } from './v2/build.mjs';
import { inspectBaselineLinkage } from './v2/baseline-linkage.mjs';
import { FILES_V2 } from './v2/contract.mjs';
import { withBuildLease } from '../maintenance/lib/lease.mjs';
import { datasetRootForPhaseOutput } from '../maintenance/maintenance-policy.mjs';
import { APP_ROOT } from './lib/engine-runtime.mjs';

async function runSensitivityBuild(options) {
  const v2 = options.tuningVersion === 2;
  const built = v2 ? await buildSensitivityPackageV2(options) : await buildSensitivityPackage(options);
  const before = await captureWhitelistFingerprints(options.model);
  const published = await publishPackage({
    output: options.output,
    roots: [options.model, options.raw, options.gt, options.baseline, options.validationEvidence].filter(Boolean),
    files: built.files,
    manifest: built.manifest,
    exportFiles: v2 ? FILES_V2 : undefined,
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
      if (v2) {
        const current = await inspectBaselineLinkage(options);
        const frozen = Object.fromEntries(Object.keys(current).map(key => [key, built.manifest[key]]));
        if (canonicalJson(current) !== canonicalJson(frozen)) {
          const error = new Error('EVALUATION_CHANGED_DURING_TUNING');
          error.code = 'EVALUATION_CHANGED_DURING_TUNING';
          throw error;
        }
      } else await loadEvaluationLinkage(options.baseline, built.ctx.input.linkage);
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

/** Holds the shared maintenance lease for the whole run so prune never races a Sensitivity publish. */
export async function runSensitivity(options) {
  return withBuildLease('sensitivity', () => runSensitivityBuild(options), {
    datasetRoot: datasetRootForPhaseOutput('sensitivity', options.output || defaultOutputRoot(APP_ROOT))
  });
}

if (isMain(import.meta.url)) await runCli('sensitivity', runSensitivity);
