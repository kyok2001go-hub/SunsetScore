#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { prepareContext } from './lib/pipeline.mjs';
import { planExperiments } from './lib/experiment.mjs';
import { inspectBaselineLinkage } from './v2/baseline-linkage.mjs';

/**
 * Dry run: reports experiment count, parameter classes, replay volume and estimated
 * executions before any experiment actually runs.
 */
export async function planSensitivity(options) {
  if (options.tuningVersion === 2) {
    const linkage = await inspectBaselineLinkage(options);
    const legacy = await planSensitivity({ ...options, tuningVersion: 1, validationEvidence: undefined });
    return {
      ...legacy, tuning_schema_version: 2, tuning_policy_version: 2,
      global_readiness: 'EXPLORATORY', result_usage: 'EXPLORATORY_ONLY',
      engineering_readiness: { status: 'READY', reasons: [] },
      data_readiness: { status: legacy.global_readiness === 'TUNING_READY' ? 'READY' : 'INSUFFICIENT',
        reasons: legacy.warnings.map(item => item.replace(/^READINESS_GAP:/, '')) },
      metric_readiness: { status: 'PROVISIONAL_PROXY', reasons: ['PROXY_MAPPING_NOT_VALIDATED'] },
      mapping_status: linkage.mapping_status, interpretation_scope: linkage.interpretation_scope,
      no_skill_reference_ordinal: linkage.no_skill_reference_ordinal,
      validation_disclosure_status: linkage.validation_disclosure_status
    };
  }
  const ctx = await prepareContext(options);
  const plan = planExperiments({ units: ctx.units, ablations: ctx.ablations, config: ctx.loaded.config });
  const byKind = {};
  for (const entry of plan) byKind[entry.experiment_kind] = (byKind[entry.experiment_kind] || 0) + 1;
  const byClass = {};
  for (const unit of ctx.units) byClass[unit.replay_class] = (byClass[unit.replay_class] || 0) + 1;
  const byWiring = {};
  for (const unit of ctx.units) byWiring[unit.wired_status] = (byWiring[unit.wired_status] || 0) + 1;
  return {
    status: 'PLANNED',
    global_readiness: ctx.readiness.global_readiness,
    result_usage: ctx.readiness.global_readiness === 'TUNING_READY' ? 'FORMAL' : 'EXPLORATORY_ONLY',
    cohort: {
      samples: ctx.input.rows.length,
      events: ctx.profiles.primary_events,
      dates: ctx.profiles.unique_dates,
      replay_pass_count: ctx.parity.summary.pass_count,
      replay_fail_count: ctx.parity.summary.fail_count
    },
    replay_count: ctx.cohort.length,
    experiment_count: plan.length,
    experiments_by_kind: byKind,
    units_by_replay_class: byClass,
    units_by_wired_status: byWiring,
    skip_list: ctx.units.filter(unit => unit.unit_category === 'DIAGNOSTIC' || unit.optimizable === false)
      .map(unit => ({ parameter_id: unit.parameter_id, wired_status: unit.wired_status, reason_code: unit.reason_code })),
    estimated_replay_executions: plan.length * ctx.cohort.length + ctx.cohort.length,
    engine_runtime_sha256: ctx.engineRuntime.engine_runtime_sha256,
    tuning_base_config_sha256: ctx.loaded.sha256,
    parameter_registry_sha256: ctx.registrySha256,
    composition_parity_checks: ctx.composition.check_count,
    warnings: ctx.readiness.reasons.map(reason => 'READINESS_GAP:' + reason)
  };
}

if (isMain(import.meta.url)) await runCli('plan', planSensitivity);
