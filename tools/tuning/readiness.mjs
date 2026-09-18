#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { prepareContext } from './lib/pipeline.mjs';
import { parameterReadiness } from './lib/readiness.mjs';
import { supportMetrics } from './lib/replay-cohort.mjs';
import { tuningPolicy } from './tuning-policy.mjs';

export async function tuningReadiness(options) {
  const ctx = await prepareContext(options);
  const policy = tuningPolicy();
  const parameterReadinessRows = ctx.units.map(unit => {
    const support = supportMetrics(unit, ctx.cohort);
    const decided = parameterReadiness({ unit, support });
    return {
      parameter_id: unit.parameter_id,
      group_id: unit.group_id,
      canonical_path: unit.canonical_path,
      unit_category: unit.unit_category,
      replay_class: unit.replay_class,
      wired_status: unit.wired_status,
      activation_condition: unit.activation_condition,
      parameter_readiness: decided.parameter_readiness,
      observability_status: decided.observability_status,
      reason_code: decided.reason_code,
      ...support
    };
  });
  const warnings = [];
  if (ctx.observedBuilds.length > 1) warnings.push({ warning_code: 'MULTIPLE_ENGINE_BUILDS', scope: 'cohort' });
  if (ctx.observedConfigs.length !== 1) warnings.push({ warning_code: 'MULTIPLE_CONFIG_HASHES', scope: 'cohort' });
  for (const reason of ctx.readiness.reasons) warnings.push({ warning_code: 'READINESS_GAP:' + reason, scope: 'readiness' });
  const notObservable = parameterReadinessRows.filter(row => row.parameter_readiness === 'INSUFFICIENT_SUPPORT').length;
  if (notObservable) warnings.push({ warning_code: 'PARAMETERS_WITHOUT_SUPPORT', scope: 'readiness' });

  return {
    global_readiness: ctx.readiness.global_readiness,
    reasons: ctx.readiness.reasons,
    metrics: ctx.readiness.metrics,
    thresholds: policy.readiness_thresholds,
    cohort: {
      samples: ctx.input.rows.length,
      events: ctx.profiles.primary_events,
      dates: ctx.profiles.unique_dates,
      replay_pass_count: ctx.parity.summary.pass_count,
      replay_fail_count: ctx.parity.summary.fail_count
    },
    engine_runtime: {
      engine_runtime_sha256: ctx.engineRuntime.engine_runtime_sha256,
      runtime_file_count: ctx.engineRuntime.runtime_file_count,
      observed_engine_build_shas: ctx.observedBuilds
    },
    tuning_base_config_sha256: ctx.loaded.sha256,
    registry: {
      parameter_registry_version: ctx.registry.parameter_registry_version,
      parameter_registry_sha256: ctx.registrySha256,
      unit_count: ctx.units.length,
      audited_units: ctx.audit.units.length,
      alias_namespaces: ctx.audit.aliased_namespaces
    },
    composition_parity: { check_count: ctx.composition.check_count },
    parameter_readiness: parameterReadinessRows,
    warnings
  };
}

if (isMain(import.meta.url)) await runCli('readiness', tuningReadiness);
