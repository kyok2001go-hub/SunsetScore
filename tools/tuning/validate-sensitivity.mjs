#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { canonicalJson, hash, inventory, readSafe, compare, fail, errorCode, isMain } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { tuningSchema, CSV_TABLES, validateManifestStructure, validateReadinessStructure, validateSummaryStructure } from './tuning-schema.mjs';
import { tuningPolicy } from './tuning-policy.mjs';
import { FILES, MANIFEST_FILE, identity, descriptorOf } from './lib/package.mjs';
import { runCli } from './lib/cli.mjs';
import { buildSensitivityPackage } from './lib/build.mjs';

export const parseJson = bytes => {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!Buffer.from(canonicalJson(value)).equals(bytes)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL' });
  }
  return value;
};

/**
 * Coverage accounting for one experiment: the metric basis, the dropped rows and the policy
 * floor must all agree. A reduced coverage is legitimate as long as it stays above the floor,
 * so this never compares `sample_count` against the full cohort size.
 */
export function assertCoverageAccounting(metric, { cohortSampleCount, minCoverageRate }) {
  const experimentId = metric.experiment_id;
  if (metric.paired_sample_count !== metric.sample_count) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'COVERAGE_PAIRED_SAMPLE_MISMATCH', detail: experimentId });
  }
  if (metric.paired_event_count !== metric.event_count) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'COVERAGE_PAIRED_EVENT_MISMATCH', detail: experimentId });
  }
  if (metric.cohort_sample_count !== cohortSampleCount) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'COVERAGE_COHORT_MISMATCH', detail: experimentId });
  }
  if (metric.failure_count !== metric.cohort_sample_count - metric.paired_sample_count) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'COVERAGE_FAILURE_COUNT_MISMATCH', detail: experimentId });
  }
  if (metric.control_failure_count + metric.experiment_failure_count !== metric.failure_count) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'COVERAGE_FAILURE_SPLIT_MISMATCH', detail: experimentId });
  }
  const expectedCoverage = metric.cohort_sample_count ? metric.paired_sample_count / metric.cohort_sample_count : null;
  if (metric.coverage_rate === null || expectedCoverage === null ||
      Math.abs(metric.coverage_rate - expectedCoverage) > 1e-12) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'COVERAGE_RATE_MISMATCH', detail: experimentId });
  }
  if (metric.coverage_rate < minCoverageRate) {
    fail('TUNING_VALIDATION_FAILED', {
      reason_code: 'COVERAGE_BELOW_MINIMUM',
      detail: { experiment_id: experimentId, coverage_rate: metric.coverage_rate, min_coverage_rate: minCoverageRate }
    });
  }
  return true;
}

export async function inspectSensitivity(directory, options = {}) {
  try {
    return await inspect(directory, options);
  } catch (error) {
    if (['UNSAFE_PATH', 'UNSUPPORTED_TUNING_SCHEMA', 'UNSUPPORTED_TUNING_POLICY', 'INVALID_ARGUMENTS',
      'TUNING_VALIDATION_FAILED'].includes(errorCode(error))) throw error;
    fail('TUNING_VALIDATION_FAILED', { reason_code: errorCode(error) });
  }
}

async function inspect(directory, options) {
  const schema = tuningSchema(1);
  const policy = tuningPolicy();
  const manifest = parseJson(await readSafe(path.join(directory, MANIFEST_FILE)));
  validateManifestStructure(manifest);

  const expected = [...FILES, MANIFEST_FILE].sort(compare);
  const actual = (await inventory(directory)).sort(compare);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'INVENTORY_MISMATCH' });
  }
  if (canonicalJson(Object.keys(manifest.files).sort(compare)) !== canonicalJson([...FILES].sort(compare))) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'MANIFEST_FILES_MISMATCH' });
  }

  const loaded = {};
  for (const file of FILES) {
    const bytes = await readSafe(path.join(directory, file));
    if (hash(bytes) !== manifest.files[file].sha256 || bytes.length !== manifest.files[file].bytes) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'FILE_HASH', file });
    }
    loaded[file] = bytes;
  }
  if (canonicalJson(parseJson(loaded['schema.json'])) !== canonicalJson(schema)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'SCHEMA_MISMATCH' });
  }
  if (canonicalJson(parseJson(loaded['policy.json'])) !== canonicalJson(policy)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'POLICY_MISMATCH' });
  }

  const tables = {};
  for (const [file, fields] of Object.entries(CSV_TABLES)) {
    tables[file] = readCsv(fields, loaded[file]);
    if (manifest.files[file].rows !== tables[file].length) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'CSV_ROWS_MISMATCH', file });
    }
  }
  const readiness = parseJson(loaded['readiness.json']);
  const summary = parseJson(loaded['reports/summary.json']);
  validateReadinessStructure(readiness);
  validateSummaryStructure(summary);

  const metadata = {};
  for (const file of FILES) metadata[file] = manifest.files[file];
  const rebuiltDescriptor = descriptorOf({
    model_dataset_id: manifest.model_dataset_id,
    model_dataset_manifest_sha256: manifest.model_dataset_manifest_sha256,
    model_dataset_descriptor_sha256: manifest.model_dataset_descriptor_sha256,
    evaluation_id: manifest.evaluation_id,
    evaluation_manifest_sha256: manifest.evaluation_manifest_sha256,
    engine_runtime_sha256: manifest.engine_runtime_sha256,
    tuning_base_config_sha256: manifest.tuning_base_config_sha256,
    parameter_registry_sha256: manifest.parameter_registry_sha256
  }, metadata, manifest.descriptor.selection);
  if (canonicalJson(rebuiltDescriptor) !== canonicalJson(manifest.descriptor)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_MISMATCH' });
  }
  const id = identity(manifest.descriptor);
  if (id.descriptor_sha256 !== manifest.descriptor_sha256 || id.sensitivity_id !== manifest.sensitivity_id) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_ID_MISMATCH' });
  }
  if (!options.staging && path.basename(path.resolve(directory)) !== manifest.sensitivity_id) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'DIRECTORY_ID_MISMATCH' });
  }

  const planIds = tables['experiment_plan.csv'].map(row => row.experiment_id);
  if (new Set(planIds).size !== planIds.length) fail('TUNING_VALIDATION_FAILED', { reason_code: 'DUPLICATE_EXPERIMENT_ID' });
  if (planIds.length !== manifest.experiment_count) fail('TUNING_VALIDATION_FAILED', { reason_code: 'EXPERIMENT_COUNT_MISMATCH' });
  const metricIds = tables['experiment_metrics.csv'].map(row => row.experiment_id);
  if (canonicalJson([...metricIds].sort(compare)) !== canonicalJson([...planIds].sort(compare))) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'EXPERIMENT_METRICS_MISMATCH' });
  }
  const metricById = new Map(tables['experiment_metrics.csv'].map(row => [row.experiment_id, row]));
  const deltaCounts = new Map();
  const deltaKeys = new Set();
  for (const row of tables['sample_deltas.csv']) {
    deltaCounts.set(row.experiment_id, (deltaCounts.get(row.experiment_id) || 0) + 1);
    const key = `${row.experiment_id}|${row.snapshot_id}`;
    if (deltaKeys.has(key)) fail('TUNING_VALIDATION_FAILED', { reason_code: 'DUPLICATE_SAMPLE_DELTA', detail: key });
    deltaKeys.add(key);
  }
  for (const [experimentId, metric] of metricById) {
    if ((deltaCounts.get(experimentId) || 0) !== metric.sample_count) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'SAMPLE_DELTA_COUNT_MISMATCH', detail: experimentId });
    }
  }
  const ablationIds = tables['ablation_metrics.csv'].map(row => row.experiment_id);
  const planAblations = tables['experiment_plan.csv'].filter(row => row.experiment_kind === 'ABLATION').map(row => row.experiment_id);
  if (canonicalJson([...ablationIds].sort(compare)) !== canonicalJson([...planAblations].sort(compare))) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'ABLATION_METRICS_MISMATCH' });
  }
  const registry = parseJson(loaded['parameter_registry.json']);
  const summaryIds = tables['parameter_summary.csv'].map(row => row.parameter_id);
  const registryIds = registry.units.map(unit => unit.parameter_id);
  if (canonicalJson([...summaryIds].sort(compare)) !== canonicalJson([...registryIds].sort(compare))) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'PARAMETER_SUMMARY_MISMATCH' });
  }
  if (readiness.global_readiness !== summary.global_readiness) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'READINESS_SUMMARY_MISMATCH' });
  }
  if (manifest.result_usage !== summary.result_usage) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'RESULT_USAGE_MISMATCH' });
  }
  const sliceKeys = new Set();
  for (const row of tables['slice_deltas.csv']) {
    const key = `${row.experiment_id}|${row.slice_dimension}|${row.slice_value_is_null}|${row.slice_value}`;
    if (sliceKeys.has(key)) fail('TUNING_VALIDATION_FAILED', { reason_code: 'DUPLICATE_SLICE_ROW', detail: key });
    sliceKeys.add(key);
    const metric = metricById.get(row.experiment_id);
    if (!metric) fail('TUNING_VALIDATION_FAILED', { reason_code: 'SLICE_EXPERIMENT_UNKNOWN', detail: row.experiment_id });
    if (metric.parameter_id !== row.parameter_id) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'SLICE_PARAMETER_MISMATCH', detail: row.experiment_id });
    }
    if (metric.probe_value !== row.parameter_value) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'SLICE_PARAMETER_VALUE_MISMATCH', detail: row.experiment_id });
    }
  }

  // Coverage accounting: paired basis, dropped rows and the policy gate must all agree.
  const COVERAGE_METRIC_FIELDS = ['cohort_sample_count', 'paired_sample_count', 'paired_event_count',
    'coverage_rate', 'failure_count', 'control_failure_count', 'experiment_failure_count'];
  const minCoverageRate = policy.coverage_policy.min_coverage_rate;
  for (const metric of metricById.values()) {
    assertCoverageAccounting(metric, { cohortSampleCount: manifest.sample_count, minCoverageRate });
  }
  for (const row of tables['ablation_metrics.csv']) {
    const metric = metricById.get(row.experiment_id);
    if (!metric) fail('TUNING_VALIDATION_FAILED', { reason_code: 'ABLATION_EXPERIMENT_UNKNOWN', detail: row.experiment_id });
    for (const name of COVERAGE_METRIC_FIELDS) {
      if (row[name] !== metric[name]) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'ABLATION_COVERAGE_MISMATCH', detail: `${row.experiment_id}.${name}` });
      }
    }
  }

  // Every dropped Snapshot is auditable and explains its own coverage arithmetic.
  const replayIds = new Set(tables['replay_parity.csv'].map(row => row.snapshot_id));
  const controlFailureRows = tables['experiment_failures.csv'].filter(row => row.stage === 'CONTROL');
  const failureKeys = new Set();
  const failuresByExperiment = new Map();
  for (const row of tables['experiment_failures.csv']) {
    const key = `${row.stage}|${row.experiment_id ?? ''}|${row.snapshot_id}`;
    if (failureKeys.has(key)) fail('TUNING_VALIDATION_FAILED', { reason_code: 'DUPLICATE_EXPERIMENT_FAILURE', detail: key });
    failureKeys.add(key);
    if (!replayIds.has(row.snapshot_id)) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'FAILURE_SNAPSHOT_UNKNOWN', detail: row.snapshot_id });
    }
    if (row.stage === 'CONTROL') {
      if (row.experiment_id !== null || row.parameter_id !== null || row.probe_value !== null) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'CONTROL_FAILURE_HAS_EXPERIMENT', detail: row.snapshot_id });
      }
      continue;
    }
    const metric = metricById.get(row.experiment_id);
    if (!metric) fail('TUNING_VALIDATION_FAILED', { reason_code: 'FAILURE_EXPERIMENT_UNKNOWN', detail: row.experiment_id });
    if (metric.parameter_id !== row.parameter_id || metric.probe_value !== row.probe_value) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'FAILURE_PARAMETER_MISMATCH', detail: row.experiment_id });
    }
    failuresByExperiment.set(row.experiment_id, (failuresByExperiment.get(row.experiment_id) || 0) + 1);
  }
  for (const [experimentId, metric] of metricById) {
    const expectedFailures = controlFailureRows.length + (failuresByExperiment.get(experimentId) || 0);
    if (metric.failure_count !== expectedFailures) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'FAILURE_ROWS_MISMATCH', detail: experimentId });
    }
  }
  const declaredFiles = parseJson(loaded['schema.json']).files.export;
  if (canonicalJson([...declaredFiles].sort(compare)) !== canonicalJson([...FILES].sort(compare))) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'SCHEMA_FILE_LIST_MISMATCH' });
  }
  // schema.tables is keyed by logical table name; CSV_TABLES is keyed by package path.
  const declaredTables = Object.keys(parseJson(loaded['schema.json']).tables).sort(compare);
  const expectedTables = Object.keys(CSV_TABLES)
    .map(file => file.replace(/^reports\//, '').replace(/\.csv$/, ''))
    .sort(compare);
  if (canonicalJson(declaredTables) !== canonicalJson(expectedTables)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'SCHEMA_TABLE_LIST_MISMATCH' });
  }

  if (options.model && options.raw && options.gt && options.baseline) {
    const rebuilt = await buildSensitivityPackage({
      model: options.model, raw: options.raw, gt: options.gt, baseline: options.baseline,
      progress: options.progress
    });
    for (const file of FILES) {
      if (!loaded[file].equals(Buffer.from(rebuilt.files[file]))) {
        fail('TUNING_VALIDATION_FAILED', { reason_code: 'RECOMPUTED_FILE_MISMATCH', file });
      }
    }
    if (canonicalJson(manifest) !== canonicalJson(rebuilt.manifest)) {
      fail('TUNING_VALIDATION_FAILED', { reason_code: 'MANIFEST_MISMATCH' });
    }
  }

  return {
    status: 'PASS',
    validation_scope: options.model ? 'TRAIN_LINKED' : 'PACKAGE_INTERNAL',
    sensitivity_id: manifest.sensitivity_id,
    manifest,
    summary
  };
}

if (isMain(import.meta.url)) await runCli('validate', options => inspectSensitivity(options.path, options));
