import path from 'node:path';
import { canonicalJson, compare, fail, hash, inventory, readSafe } from '../../dataset/lib/common.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
import { loadTuningInput, verifyUpstreamSources } from '../lib/input.mjs';
import { assertCoverageAccounting } from '../validate-sensitivity.mjs';
import { ordinalOf } from '../lib/experiment.mjs';
import { sliceAggregate } from '../lib/metrics.mjs';
import { leaveOneDateOut } from '../lib/stability.mjs';
import { SLICE_DIMENSIONS, FIXED_SLICE_ENUMS, SLICE_DELTA_FIELDS } from '../tuning-schema.mjs';
import { pairedDiagnostics, buildSensitivityPackageV2, alignmentSummary } from './build.mjs';
import { POLICY_V2, SCHEMA_V2, CSV_TABLES_V2, FILES_V2 } from './contract.mjs';
import { inspectBaselineLinkage } from './baseline-linkage.mjs';

const check = (ok, reason_code) => { if (!ok) fail('TUNING_VALIDATION_FAILED', { reason_code }); };
const equal = (a, b, reason_code) => check(canonicalJson(a) === canonicalJson(b), reason_code);
const sameNumber = (a, b) => a === null || b === null ? a === b :
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-10;
const json = bytes => {
  const value = JSON.parse(bytes.toString('utf8'));
  check(Buffer.from(canonicalJson(value)).equals(bytes), 'JSON_NOT_CANONICAL');
  return value;
};

export async function inspectSensitivityV2(directory, options = {}) {
  const manifest = json(await readSafe(path.join(directory, 'manifest.json')));
  check(manifest.tuning_schema_version === 2 && manifest.tuning_policy_version === 2, 'VERSION_MISMATCH');
  if (!options.staging) check(path.basename(path.resolve(directory)) === manifest.sensitivity_id, 'DIRECTORY_ID_MISMATCH');
  equal((await inventory(directory)).sort(compare), [...FILES_V2, 'manifest.json'].sort(compare), 'INVENTORY_MISMATCH');
  equal(Object.keys(manifest.files).sort(compare), FILES_V2, 'MANIFEST_FILES_MISMATCH');
  const loaded = {};
  for (const file of FILES_V2) {
    const bytes = await readSafe(path.join(directory, file));
    check(hash(bytes) === manifest.files[file].sha256 && bytes.length === manifest.files[file].bytes, 'FILE_HASH');
    loaded[file] = bytes;
  }
  equal(json(loaded['schema.json']), SCHEMA_V2, 'SCHEMA_MISMATCH');
  equal(json(loaded['policy.json']), POLICY_V2, 'POLICY_MISMATCH');
  const csv = {};
  for (const [file, fields] of Object.entries(CSV_TABLES_V2)) {
    csv[file] = readCsv(fields, loaded[file]);
    check(csv[file].length === manifest.files[file].rows, 'CSV_ROWS_MISMATCH');
  }
  const readiness = json(loaded['readiness.json']);
  const summary = json(loaded['reports/summary.json']);
  check(manifest.result_usage === 'EXPLORATORY_ONLY' && summary.result_usage === 'EXPLORATORY_ONLY' &&
    readiness.global_readiness === 'EXPLORATORY' && summary.global_readiness === 'EXPLORATORY', 'RESULT_USAGE_MISMATCH');
  check(manifest.mapping_status === 'PROVISIONAL' && manifest.interpretation_scope === 'PROXY_ORDINAL_ONLY' &&
    summary.mapping_status === manifest.mapping_status && summary.interpretation_scope === manifest.interpretation_scope,
  'MAPPING_CONTRACT');
  check(manifest.evaluation_schema_version === 2 && manifest.evaluation_policy_version === 2 &&
    manifest.evaluation_validation_scope === 'MODEL_LINKED', 'EVALUATION_CONTRACT');
  equal(manifest.evaluated_splits, ['TRAIN'], 'SPLIT_CONTRACT');
  equal(manifest.evaluation_evaluated_splits, ['TRAIN'], 'EVALUATION_SPLIT_CONTRACT');
  check(manifest.validation_evaluated === false && manifest.test_evaluated === false &&
    manifest.computation_access_policy === 'TRAIN_ONLY' && manifest.source_validation_scope === 'SOURCE_LINKED',
  'ACCESS_CONTRACT');
  check(['DEVELOPMENT_EXPOSED', 'NOT_ATTESTED'].includes(manifest.validation_disclosure_status) &&
    (manifest.validation_disclosure_status === 'NOT_ATTESTED' ?
      manifest.validation_disclosure_evidence_id === null && manifest.validation_disclosure_evidence_sha256 === null :
      typeof manifest.validation_disclosure_evidence_id === 'string' &&
      /^[a-f0-9]{64}$/.test(manifest.validation_disclosure_evidence_sha256)), 'DISCLOSURE_CONTRACT');
  check(manifest.validation_access_ledger_sha256 === null, 'DISCLOSURE_LEDGER_UNSUPPORTED');
  equal(readiness.engineering_readiness, manifest.engineering_readiness, 'READINESS_MISMATCH');
  equal(readiness.data_readiness, manifest.data_readiness, 'READINESS_MISMATCH');
  equal(readiness.metric_readiness, manifest.metric_readiness, 'READINESS_MISMATCH');
  equal(summary.engineering_readiness, manifest.engineering_readiness, 'READINESS_MISMATCH');
  equal(summary.data_readiness, manifest.data_readiness, 'READINESS_MISMATCH');
  equal(summary.metric_readiness, manifest.metric_readiness, 'READINESS_MISMATCH');
  check(manifest.engineering_readiness.status === 'READY' &&
    manifest.metric_readiness.status === 'PROVISIONAL_PROXY', 'READINESS_CONTRACT');
  const descriptor = manifest.descriptor;
  check(descriptor?.tuning_schema_version === 2 && descriptor?.tuning_policy_version === 2, 'DESCRIPTOR_VERSION');
  const source = descriptor.source;
  for (const key of ['model_dataset_id', 'model_dataset_manifest_sha256', 'model_dataset_descriptor_sha256',
    'evaluation_id', 'evaluation_manifest_sha256', 'evaluation_schema_version',
    'evaluation_policy_version', 'mapping_status', 'interpretation_scope',
    'no_skill_reference_ordinal', 'validation_disclosure_status', 'validation_disclosure_evidence_id',
    'validation_disclosure_evidence_sha256', 'engine_runtime_sha256', 'tuning_base_config_sha256',
    'parameter_registry_sha256']) equal(manifest[key], source[key], 'DESCRIPTOR_SOURCE_MISMATCH');
  for (const file of FILES_V2.filter(file => file !== 'reports/summary.json')) {
    check(descriptor.file_sha256[file] === manifest.files[file].sha256, 'DESCRIPTOR_FILE_MISMATCH');
  }
  const summaryTemplate = { ...summary, sensitivity_id: null };
  check(descriptor.summary_template_sha256 === hash(canonicalJson(summaryTemplate)), 'DESCRIPTOR_SUMMARY_MISMATCH');
  const digest = hash(canonicalJson(descriptor));
  check(manifest.descriptor_sha256 === digest &&
    manifest.sensitivity_id === `sensitivity_v2_${manifest.model_dataset_descriptor_sha256.slice(0, 12)}_${digest.slice(0, 12)}` &&
    summary.sensitivity_id === manifest.sensitivity_id, 'DESCRIPTOR_ID_MISMATCH');

  const alignment = csv['control_alignment.csv'];
  check(alignment.length === manifest.sample_count, 'CONTROL_ALIGNMENT_COUNT');
  equal(summary.control_alignment, alignmentSummary(alignment), 'CONTROL_ALIGNMENT_SUMMARY');
  const alignmentIds = new Set();
  for (const row of alignment) {
    check(!alignmentIds.has(row.snapshot_id), 'CONTROL_ALIGNMENT_DUPLICATE');
    alignmentIds.add(row.snapshot_id);
    check(row.historical_ordinal === ordinalOf(row.historical_score) &&
      (row.control_score === null ? row.reason_code === 'CONTROL_REPLAY_FAILED' &&
        row.control_ordinal === null && row.score_delta === null && row.ordinal_changed === null :
        row.control_ordinal === ordinalOf(row.control_score) &&
        row.score_delta === row.control_score - row.historical_score &&
        row.ordinal_changed === (row.control_ordinal !== row.historical_ordinal) && row.reason_code === null),
    'CONTROL_ALIGNMENT_ROW');
  }
  const plan = csv['experiment_plan.csv'];
  const metrics = csv['experiment_metrics.csv'];
  check(plan.length === manifest.experiment_count && metrics.length === plan.length, 'EXPERIMENT_COUNT');
  equal(plan.map(row => row.experiment_id).sort(compare), metrics.map(row => row.experiment_id).sort(compare), 'EXPERIMENT_IDS');
  const metricById = new Map(metrics.map(row => [row.experiment_id, row]));
  check(metricById.size === metrics.length, 'DUPLICATE_EXPERIMENT_ID');
  const byExperiment = new Map();
  const sampleKeys = new Set();
  const eventGt = new Map();
  for (const row of csv['sample_deltas.csv']) {
    check(metricById.has(row.experiment_id) && alignmentIds.has(row.snapshot_id), 'SAMPLE_DELTA_IDENTITY');
    const key = `${row.experiment_id}|${row.snapshot_id}`;
    check(!sampleKeys.has(key), 'DUPLICATE_SAMPLE_DELTA');
    sampleKeys.add(key);
    const event = eventGt.get(row.event_id);
    check(!event || event.gt_ordinal === row.gt_ordinal && event.gt_confidence === row.gt_confidence,
      'EVENT_GT_INCONSISTENCY');
    eventGt.set(row.event_id, row);
    check(row.control_ordinal === ordinalOf(row.control_score) &&
      row.experiment_ordinal === ordinalOf(row.experiment_score) &&
      row.score_delta === row.experiment_score - row.control_score &&
      row.ordinal_delta === row.experiment_ordinal - row.control_ordinal &&
      row.control_abs_error === Math.abs(row.control_ordinal - row.gt_ordinal) &&
      row.experiment_abs_error === Math.abs(row.experiment_ordinal - row.gt_ordinal) &&
      row.abs_error_delta === row.experiment_abs_error - row.control_abs_error,
    'SAMPLE_DELTA_ARITHMETIC');
    if (!byExperiment.has(row.experiment_id)) byExperiment.set(row.experiment_id, []);
    byExperiment.get(row.experiment_id).push(row);
  }
  for (const metric of metrics) {
    const rows = byExperiment.get(metric.experiment_id) || [];
    check(rows.length === metric.sample_count, 'PAIRED_SAMPLE_COUNT');
    assertCoverageAccounting(metric, { cohortSampleCount: manifest.sample_count,
      minCoverageRate: POLICY_V2.coverage_policy.min_coverage_rate });
    const diagnostic = pairedDiagnostics(rows, manifest.no_skill_reference_ordinal);
    for (const key of Object.keys(diagnostic.fields)) equal(metric[key], diagnostic.fields[key], 'NO_SKILL_METRIC_MISMATCH');
    check(sameNumber(metric.weight_sum, diagnostic.reweighted.reduce((sum, row) => sum + row.event_normalized_weight, 0)),
      'PAIRED_WEIGHT_SUM');
    for (const row of rows) {
      const paired = diagnostic.reweighted.find(item => item.snapshot_id === row.snapshot_id);
      check(sameNumber(row.event_normalized_weight, paired.event_normalized_weight), 'PAIRED_EVENT_WEIGHT');
      const control = alignment.find(item => item.snapshot_id === row.snapshot_id);
      check(control && control.control_score === row.control_score && control.control_ordinal === row.control_ordinal,
        'PAIRED_CONTROL_ALIGNMENT');
    }
    for (const key of ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate', 'qwk']) {
      check(sameNumber(metric[`control_${key}`], diagnostic.pair.control[key]) &&
        sameNumber(metric[`experiment_${key}`], diagnostic.pair.experiment[key]) &&
        sameNumber(metric[`delta_${key}`], diagnostic.pair.deltas[`delta_${key}`]), 'PAIRED_PROXY_METRIC_MISMATCH');
    }
    const stability = leaveOneDateOut(diagnostic.reweighted, 'experiment_ordinal');
    check(metric.lodo_fold_count === stability.fold_count &&
      metric.lodo_improved_count === stability.improved_date_count &&
      metric.lodo_degraded_count === stability.degraded_date_count &&
      sameNumber(metric.lodo_stability_ratio, stability.direction_stability_ratio) &&
      metric.lodo_reason_code === stability.reason_code, 'LODO_METRIC_MISMATCH');
  }
  const expectedSlices = metrics.flatMap(metric => sliceAggregate(byExperiment.get(metric.experiment_id) || [],
    metric, SLICE_DIMENSIONS, FIXED_SLICE_ENUMS));
  check(expectedSlices.length === csv['slice_deltas.csv'].length, 'SLICE_COUNT');
  expectedSlices.forEach((expected, index) => {
    const actual = csv['slice_deltas.csv'][index];
    for (const { name } of SLICE_DELTA_FIELDS) {
      check(sameNumber(actual[name], expected[name]) || actual[name] === expected[name], 'SLICE_METRIC_MISMATCH');
    }
  });
  for (const row of csv['ablation_metrics.csv']) {
    const metric = metricById.get(row.experiment_id);
    check(metric && metric.experiment_kind === 'ABLATION', 'ABLATION_EXPERIMENT_ID');
    for (const key of ['sample_count', 'paired_sample_count', 'paired_no_skill_mae',
      'control_mae_gap_to_no_skill', 'experiment_mae_gap_to_no_skill']) equal(row[key], metric[key], 'ABLATION_METRIC_MISMATCH');
  }
  for (const row of csv['slice_deltas.csv']) {
    const key = row.slice_dimension === 'city' ? 'location_key' : row.slice_dimension;
    const matching = (byExperiment.get(row.experiment_id) || []).filter(sample =>
      row.slice_value_is_null ? sample[key] == null : String(sample[key]) === row.slice_value);
    check(matching.length === row.sample_count, 'SLICE_SAMPLE_COUNT');
    const diagnostic = pairedDiagnostics(matching, manifest.no_skill_reference_ordinal);
    for (const name of Object.keys(diagnostic.fields)) equal(row[name], diagnostic.fields[name], 'SLICE_NO_SKILL_MISMATCH');
  }
  check(csv['parameter_summary.csv'].every(row => row.metric_usage === 'PROXY_EXPLORATORY'), 'PARAMETER_METRIC_USAGE');
  for (const row of csv['parameter_summary.csv']) {
    const probes = metrics.filter(metric => metric.parameter_id === row.parameter_id);
    const values = probes.map(metric => metric.delta_mae).filter(Number.isFinite);
    check(row.probe_count === probes.length && row.evaluated_probe_count === probes.length &&
      sameNumber(row.min_delta_mae, values.length ? Math.min(...values) : null) &&
      sameNumber(row.max_delta_mae, values.length ? Math.max(...values) : null) &&
      sameNumber(row.best_delta_mae, values.length ? Math.min(...values) : null),
    'PARAMETER_PROXY_SUMMARY_MISMATCH');
  }

  if (options.model) {
    const input = await loadTuningInput(options.model);
    check(input.linkage.model_dataset_id === manifest.model_dataset_id &&
      input.manifestSha256 === manifest.model_dataset_manifest_sha256 &&
      input.linkage.model_dataset_descriptor_sha256 === manifest.model_dataset_descriptor_sha256,
    'MODEL_LINKAGE_MISMATCH');
    equal(input.rows.map(row => row.snapshot_id).sort(compare), alignment.map(row => row.snapshot_id).sort(compare),
      'TRAIN_COHORT_MISMATCH');
    const train = new Map(input.rows.map(row => [row.snapshot_id, row]));
    for (const row of alignment) {
      const sourceRow = train.get(row.snapshot_id);
      check(row.event_id === sourceRow.event_id && row.engine_build_sha === sourceRow.engine_build_sha &&
        row.config_hash === sourceRow.config_hash && row.historical_score === sourceRow.predicted_score,
      'HISTORICAL_CONTROL_SOURCE_MISMATCH');
    }
  }
  if (options.model && options.raw && options.gt && options.baseline) {
    await verifyUpstreamSources(options.model, options.raw, options.gt);
    const linkage = await inspectBaselineLinkage(options);
    for (const key of Object.keys(linkage)) equal(manifest[key], linkage[key], 'EVALUATION_LINKAGE_MISMATCH');
    const rebuilt = await buildSensitivityPackageV2(options);
    for (const file of FILES_V2) check(loaded[file].equals(Buffer.from(rebuilt.files[file])), 'RECOMPUTED_FILE_MISMATCH');
    equal(manifest, rebuilt.manifest, 'RECOMPUTED_MANIFEST_MISMATCH');
  }
  return {
    status: 'PASS', validation_scope: options.model && options.raw && options.gt && options.baseline ? 'SOURCE_LINKED' :
      options.model ? 'TRAIN_LINKED' : 'PACKAGE_INTERNAL',
    sensitivity_id: manifest.sensitivity_id, manifest, summary
  };
}
