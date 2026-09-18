import { canonicalJson, hash, compare } from '../../dataset/lib/common.mjs';
import { writeCsv } from '../../dataset/lib/csv.mjs';
import {
  CSV_TABLES, REPLAY_PARITY_FIELDS, EXPERIMENT_PLAN_FIELDS, EXPERIMENT_METRICS_FIELDS,
  SAMPLE_DELTA_FIELDS, SLICE_DELTA_FIELDS, ABLATION_METRICS_FIELDS, PARAMETER_SUMMARY_FIELDS,
  WARNING_FIELDS, EXPERIMENT_FAILURE_FIELDS, tuningSchema
} from '../tuning-schema.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';

export const FILES = Object.freeze([...tuningPolicy().package.export_files].sort(compare));
export const MANIFEST_FILE = tuningPolicy().package.manifest_file;

export function identity(descriptor) {
  const digest = hash(canonicalJson(descriptor));
  const modelShort = descriptor.model_dataset_descriptor_sha256.slice(0, 12);
  return { descriptor_sha256: digest, sensitivity_id: `sensitivity_v1_${modelShort}_${digest.slice(0, 12)}` };
}

/** Deterministic package contents. Every file is a string; canonical JSON has no trailing newline. */
export function contents(input) {
  return {
    'schema.json': canonicalJson(tuningSchema(1)),
    'policy.json': canonicalJson(tuningPolicy()),
    'engine_runtime.json': canonicalJson(input.engineRuntime),
    'tuning_base_config.json': canonicalJson(input.baseConfig),
    'parameter_registry.json': canonicalJson(input.registry),
    'readiness.json': canonicalJson(input.readiness),
    'replay_parity.csv': writeCsv(REPLAY_PARITY_FIELDS, input.parityRows),
    'experiment_plan.csv': writeCsv(EXPERIMENT_PLAN_FIELDS, input.planRows),
    'experiment_metrics.csv': writeCsv(EXPERIMENT_METRICS_FIELDS, input.experimentMetrics),
    'sample_deltas.csv': writeCsv(SAMPLE_DELTA_FIELDS, input.sampleDeltas),
    'slice_deltas.csv': writeCsv(SLICE_DELTA_FIELDS, input.sliceDeltas),
    'ablation_metrics.csv': writeCsv(ABLATION_METRICS_FIELDS, input.ablationMetrics),
    'experiment_failures.csv': writeCsv(EXPERIMENT_FAILURE_FIELDS, input.experimentFailureRows),
    'parameter_summary.csv': writeCsv(PARAMETER_SUMMARY_FIELDS, input.parameterSummary),
    'reports/warnings.csv': writeCsv(WARNING_FIELDS, input.warningRows),
    'reports/summary.json': canonicalJson(input.summary)
  };
}

export function filesMetadata(files) {
  const metadata = {};
  for (const file of FILES) {
    const bytes = Buffer.byteLength(files[file]);
    const entry = { sha256: hash(files[file]), bytes };
    if (CSV_TABLES[file]) entry.rows = files[file].split('\r\n').length - 2;
    metadata[file] = entry;
  }
  return metadata;
}

export function descriptorOf(source, metadata, selection) {
  return {
    tuning_schema_version: 1,
    tuning_policy_version: 1,
    model_dataset_id: source.model_dataset_id,
    model_dataset_manifest_sha256: source.model_dataset_manifest_sha256,
    model_dataset_descriptor_sha256: source.model_dataset_descriptor_sha256,
    evaluation_id: source.evaluation_id,
    evaluation_manifest_sha256: source.evaluation_manifest_sha256,
    engine_runtime_sha256: source.engine_runtime_sha256,
    tuning_base_config_sha256: source.tuning_base_config_sha256,
    parameter_registry_sha256: source.parameter_registry_sha256,
    selection,
    schema_sha256: metadata['schema.json'].sha256,
    policy_sha256: metadata['policy.json'].sha256,
    csv_sha256: Object.fromEntries(Object.keys(CSV_TABLES).map(file => [file, metadata[file].sha256]))
  };
}

export function makeManifest(source, counts, readiness, metadata, descriptor) {
  const id = identity(descriptor);
  return {
    tuning_schema_version: 1,
    tuning_policy_version: 1,
    sensitivity_id: id.sensitivity_id,
    descriptor_sha256: id.descriptor_sha256,
    descriptor,
    model_dataset_id: source.model_dataset_id,
    model_dataset_manifest_sha256: source.model_dataset_manifest_sha256,
    model_dataset_schema_version: source.model_dataset_schema_version,
    model_dataset_policy_version: source.model_dataset_policy_version,
    model_dataset_descriptor_sha256: source.model_dataset_descriptor_sha256,
    source_dataset_id: source.source_dataset_id,
    ground_truth_id: source.ground_truth_id,
    evaluation_id: source.evaluation_id,
    evaluation_manifest_sha256: source.evaluation_manifest_sha256,
    engine_runtime_sha256: source.engine_runtime_sha256,
    tuning_base_config_sha256: source.tuning_base_config_sha256,
    observed_engine_build_shas: source.observed_engine_build_shas,
    observed_config_hashes: source.observed_config_hashes,
    parameter_registry_version: source.parameter_registry_version,
    parameter_registry_sha256: source.parameter_registry_sha256,
    evaluated_splits: ['TRAIN'],
    validation_evaluated: false,
    test_evaluated: false,
    source_validation_scope: 'SOURCE_LINKED',
    computation_access_policy: 'TRAIN_ONLY',
    result_usage: readiness.global_readiness === 'TUNING_READY' ? 'FORMAL' : 'EXPLORATORY_ONLY',
    sample_count: counts.sample_count,
    event_count: counts.event_count,
    date_count: counts.date_count,
    experiment_count: counts.experiment_count,
    schema_sha256: metadata['schema.json'].sha256,
    policy_sha256: metadata['policy.json'].sha256,
    files: metadata
  };
}

export function compareSort(a, b) { return compare(a, b); }
