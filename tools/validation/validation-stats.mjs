#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { runCli } from './lib/cli.mjs';
import { inspectValidation } from './lib/package.mjs';
import { CSV_TABLES } from './validation-schema.mjs';

export async function validationStats(options) {
  const checked = await inspectValidation(options.path);
  const selection = JSON.parse(checked.files['selection_result.json']);
  const metrics = readCsv(CSV_TABLES['candidate_validation_metrics.csv'],
    checked.files['candidate_validation_metrics.csv']);
  const summary = JSON.parse(checked.files['reports/summary.json']);
  return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL',
    validation_id: checked.validation_id, mode: selection.mode,
    result_usage: selection.result_usage, selection_outcome: selection.outcome,
    selected_candidate_id: selection.selected_candidate_id, candidate_count: metrics.length,
    ...(checked.manifest.validation_policy_version === 3 ? { campaign_id: selection.campaign_id,
      semantic_evidence_id: selection.semantic_evidence_id, mapping_contract_sha256: selection.mapping_contract_sha256,
      runtime_bundle_id: selection.runtime_bundle_id, formal_promotion_allowed: selection.formal_promotion_allowed } : {}),
    ...(checked.manifest.validation_policy_version >= 2 ? { validation_policy_version: checked.manifest.validation_policy_version,
      gt_level_support: summary.gt_level_support, upstream_train_support: summary.upstream_train_support,
      rare_level_audit: summary.rare_level_audit } : {}),
    candidate_metrics: metrics.map(row => ({ candidate_id: row.candidate_id,
      sample_count: row.sample_count, control_mae: row.control_mae,
      candidate_mae: row.candidate_mae, delta_mae: row.delta_mae,
      closest_sample_count: row.closest_sample_count,
      closest_delta_mae: row.closest_delta_mae })) };
}

if (isMain(import.meta.url)) await runCli('stats', validationStats);
