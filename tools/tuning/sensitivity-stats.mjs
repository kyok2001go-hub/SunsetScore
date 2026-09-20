#!/usr/bin/env node
import { isMain, readSafe } from '../dataset/lib/common.mjs';
import path from 'node:path';
import { runCli } from './lib/cli.mjs';
import { inspectSensitivity, parseJson } from './validate-sensitivity.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { CSV_TABLES } from './tuning-schema.mjs';
import { CSV_TABLES_V2 } from './v2/contract.mjs';

export async function sensitivityStats(directory, options = {}) {
  const result = await inspectSensitivity(directory, options);
  const manifest = result.manifest;
  const v2 = manifest.tuning_schema_version === 2;
  const tables = v2 ? CSV_TABLES_V2 : CSV_TABLES;
  const loaded = {};
  for (const file of Object.keys(tables)) {
    loaded[file] = readCsv(tables[file], await readSafe(path.join(directory, file)));
  }
  const readiness = parseJson(await readSafe(path.join(directory, 'readiness.json')));
  const byReadiness = {};
  for (const row of loaded['parameter_summary.csv']) {
    byReadiness[row.parameter_readiness] = (byReadiness[row.parameter_readiness] || 0) + 1;
  }
  const byObservability = {};
  for (const row of loaded['parameter_summary.csv']) {
    byObservability[row.observability_status] = (byObservability[row.observability_status] || 0) + 1;
  }
  return {
    status: 'PASS',
    sensitivity_id: manifest.sensitivity_id,
    model_dataset_id: manifest.model_dataset_id,
    evaluation_id: manifest.evaluation_id,
    global_readiness: readiness.global_readiness,
    result_usage: manifest.result_usage,
    ...(v2 ? {
      tuning_schema_version: 2,
      engineering_readiness: manifest.engineering_readiness,
      data_readiness: manifest.data_readiness,
      metric_readiness: manifest.metric_readiness,
      mapping_status: manifest.mapping_status,
      interpretation_scope: manifest.interpretation_scope,
      validation_disclosure_status: manifest.validation_disclosure_status,
      control_alignment: result.summary.control_alignment,
      no_skill_reference_ordinal: manifest.no_skill_reference_ordinal
    } : {}),
    cohort: {
      sample_count: manifest.sample_count,
      event_count: manifest.event_count,
      date_count: manifest.date_count
    },
    experiment_count: manifest.experiment_count,
    engine_runtime_sha256: manifest.engine_runtime_sha256,
    tuning_base_config_sha256: manifest.tuning_base_config_sha256,
    parameter_registry_sha256: manifest.parameter_registry_sha256,
    observed_engine_build_shas: manifest.observed_engine_build_shas,
    observed_config_hashes: manifest.observed_config_hashes,
    replay_parity: result.summary.replay_parity,
    parameters_by_readiness: byReadiness,
    parameters_by_observability: byObservability,
    top_parameters_by_response: loaded['parameter_summary.csv']
      .filter(row => row.max_mean_abs_score_delta != null)
      .sort((a, b) => b.max_mean_abs_score_delta - a.max_mean_abs_score_delta)
      .slice(0, 10)
      .map(row => ({
        parameter_id: row.parameter_id,
        wired_status: row.wired_status,
        observability_status: row.observability_status,
        max_changed_score_rate: row.max_changed_score_rate,
        max_mean_abs_score_delta: row.max_mean_abs_score_delta,
        best_delta_mae: row.best_delta_mae
      })),
    ablations: result.summary.ablation_summary,
    warnings_summary: result.summary.warnings_summary
  };
}

if (isMain(import.meta.url)) await runCli('stats', options => sensitivityStats(options.path, options));
