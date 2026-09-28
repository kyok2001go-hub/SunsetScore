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
  return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL',
    validation_id: checked.validation_id, mode: selection.mode,
    result_usage: selection.result_usage, selection_outcome: selection.outcome,
    selected_candidate_id: selection.selected_candidate_id, candidate_count: metrics.length,
    candidate_metrics: metrics.map(row => ({ candidate_id: row.candidate_id,
      sample_count: row.sample_count, control_mae: row.control_mae,
      candidate_mae: row.candidate_mae, delta_mae: row.delta_mae,
      closest_sample_count: row.closest_sample_count,
      closest_delta_mae: row.closest_delta_mae })) };
}

if (isMain(import.meta.url)) await runCli('stats', validationStats);
