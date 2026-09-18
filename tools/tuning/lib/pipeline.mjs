import { unique, fail } from '../../dataset/lib/common.mjs';
import { silentProgress } from '../../progress.mjs';
import { loadFrozenBaseConfig, buildModelConfig, verifyAliasIdentity } from './base-config.mjs';
import { auditRegistry } from './registry-audit.mjs';
import { validateBaseConfig } from './constraints.mjs';
import { verifyCompositionParity } from './composition.mjs';
import { runtimeDocument, APP_ROOT } from './engine-runtime.mjs';
import { loadTuningInput, verifyUpstreamSources, loadEvaluationLinkage } from './input.mjs';
import { loadReplayCohort, verifyReplayParity } from './replay-cohort.mjs';
import { cohortProfiles } from './metrics.mjs';
import { computeGlobalReadiness } from './readiness.mjs';
import { registryDocument } from '../parameter-registry.mjs';
import { UNITS, ABLATIONS, REGISTRY_VERSION, validateRegistryShape } from '../parameter-registry.mjs';
import { canonicalJson, hash } from '../../dataset/lib/common.mjs';

/**
 * Shared preparation for readiness / plan / sensitivity. Phase A validates sources, phase B
 * only ever reads the TRAIN whitelist, and every integrity gate must pass before any
 * experiment runs.
 */
export async function prepareContext({ model, raw, gt, baseline, progress = silentProgress, root = APP_ROOT }) {
  validateRegistryShape();
  const upstream = await verifyUpstreamSources(model, raw, gt, progress);
  const input = await loadTuningInput(model, { progress });
  const linkage = await loadEvaluationLinkage(baseline, input.linkage);
  const engineRuntime = await runtimeDocument(root);
  const loaded = await loadFrozenBaseConfig(root);
  const modelConfig = buildModelConfig(loaded.config);
  const audit = await auditRegistry({
    units: UNITS, config: loaded.config, modelConfig, root, verifyAliasIdentity,
    policy: (await import('../tuning-policy.mjs')).tuningPolicy()
  });
  const constraintChecks = validateBaseConfig(UNITS, loaded.config);
  const composition = await verifyCompositionParity(root);
  const cohort = await loadReplayCohort({ rows: input.rows, rawDir: raw, progress });
  const parity = await verifyReplayParity({ cohort, runReplay: (await import('../../replay/replay-runner.mjs')).runReplay, progress });

  const registry = registryDocument();
  const registrySha256 = hash(canonicalJson(registry));
  const profiles = cohortProfiles(input.rows);
  const integrityChecks = [
    { id: 'UPSTREAM_SOURCE_LINKED_FAILED', ok: upstream.validation_scope === 'SOURCE_LINKED' },
    { id: 'REPLAY_PARITY_FAILED', ok: parity.summary.fail_count === 0 },
    { id: 'REGISTRY_AUDIT_FAILED', ok: audit.units.length === UNITS.length },
    { id: 'ALIAS_IDENTITY_BROKEN', ok: modelConfig.scoring === loaded.config },
    { id: 'BASE_CONFIG_INVALID', ok: constraintChecks.length > 0 },
    { id: 'COMPOSITION_PARITY_FAILED', ok: composition.check_count > 0 },
    { id: 'RUNTIME_IMPORT_GRAPH_DRIFT', ok: engineRuntime.runtime_file_count > 0 }
  ];
  const readiness = computeGlobalReadiness({ profiles, replaySummary: parity.summary, integrity: { checks: integrityChecks } });
  if (readiness.global_readiness === 'NOT_READY') {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'TUNING_NOT_READY', detail: readiness.reasons });
  }
  const observedBuilds = unique(input.rows.map(row => row.engine_build_sha));
  const observedConfigs = unique(input.rows.map(row => row.config_hash));

  return {
    upstream, input, linkage, engineRuntime, loaded, modelConfig, audit, constraintChecks,
    composition, cohort, parity, registry, registrySha256, profiles, readiness,
    observedBuilds, observedConfigs,
    units: UNITS, ablations: ABLATIONS,
    source: {
      model_dataset_id: input.linkage.model_dataset_id,
      model_dataset_manifest_sha256: input.manifestSha256,
      model_dataset_schema_version: input.linkage.model_dataset_schema_version,
      model_dataset_policy_version: input.linkage.model_dataset_policy_version,
      model_dataset_descriptor_sha256: input.linkage.model_dataset_descriptor_sha256,
      source_dataset_id: input.linkage.source_dataset_id,
      ground_truth_id: input.linkage.ground_truth_id,
      evaluation_id: linkage.evaluation_id,
      evaluation_manifest_sha256: linkage.evaluation_manifest_sha256,
      engine_runtime_sha256: engineRuntime.engine_runtime_sha256,
      tuning_base_config_sha256: loaded.sha256,
      parameter_registry_version: REGISTRY_VERSION,
      parameter_registry_sha256: registrySha256,
      observed_engine_build_shas: observedBuilds,
      observed_config_hashes: observedConfigs
    }
  };
}

export { UNITS, ABLATIONS };
