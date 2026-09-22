import { canonicalJson, compare, hash } from '../../dataset/lib/common.mjs';
import { writeCsv } from '../../dataset/lib/csv.mjs';
import { CSV_TABLES, FILES, MANIFEST_FILE } from '../optimization-schema.mjs';
import { objectivePolicyDocument, optimizationPolicy } from '../optimization-policy.mjs';

export { FILES, MANIFEST_FILE };

export function identity(descriptor) {
  const digest = hash(canonicalJson(descriptor));
  const modelShort = descriptor.source.model_dataset_descriptor_sha256.slice(0, 12);
  return { descriptor_sha256: digest, optimization_id: `optimization_v1_${modelShort}_${digest.slice(0, 12)}` };
}

export function filesMetadata(files, fileList = FILES) {
  const metadata = {};
  for (const file of fileList) {
    const content = files[file];
    if (content === undefined) continue;
    const bytes = Buffer.byteLength(content);
    const entry = { sha256: hash(content), bytes };
    if (CSV_TABLES[file]) entry.rows = content.split('\r\n').length - 2;
    metadata[file] = entry;
  }
  return metadata;
}

export function csvFor(file, rows) {
  return writeCsv(CSV_TABLES[file], rows);
}

export function descriptorOf({ source, metadata, searchSpace, searchSpaceSha256, mode, counts }) {
  const policy = optimizationPolicy();
  return {
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    source,
    search_space_id: searchSpace.search_space_id,
    search_space_sha256: searchSpaceSha256,
    candidate_normalization_version: searchSpace.candidate_normalization_version,
    numeric: { ...policy.numeric },
    objective_policy_sha256: hash(canonicalJson(objectivePolicyDocument())),
    algorithm: { ...policy.algorithm },
    selection: {
      mode,
      splits: [policy.computation_split],
      count: counts.candidate_count,
      feasible_count: counts.feasible_candidate_count,
      finalist_count: counts.finalist_count,
      freeze_allowed: counts.candidate_freeze_allowed
    },
    file_sha256: Object.fromEntries(Object.keys(metadata).sort(compare)
      .filter(file => file !== 'reports/summary.json')
      .map(file => [file, metadata[file].sha256])),
    summary_template_sha256: metadata['reports/summary.json']?.sha256 ?? null
  };
}

export function makeManifest({ descriptor, descriptorSha256, optimizationId, source, counts, readiness, resultUsage, extra }) {
  const policy = optimizationPolicy();
  return {
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    optimization_id: optimizationId,
    descriptor_sha256: descriptorSha256,
    descriptor,
    optimization_mode: counts.optimization_mode,
    optimization_outcome: counts.optimization_outcome,
    candidate_freeze_allowed: counts.candidate_freeze_allowed,
    validation_promotion_allowed: counts.validation_promotion_allowed,
    search_space_id: descriptor.search_space_id,
    search_space_sha256: descriptor.search_space_sha256,
    model_dataset_id: source.model_dataset_id,
    model_dataset_manifest_sha256: source.model_dataset_manifest_sha256,
    model_dataset_descriptor_sha256: source.model_dataset_descriptor_sha256,
    model_dataset_schema_version: source.model_dataset_schema_version,
    model_dataset_policy_version: source.model_dataset_policy_version,
    source_dataset_id: source.source_dataset_id,
    ground_truth_id: source.ground_truth_id,
    evaluation_id: source.evaluation_id,
    evaluation_manifest_sha256: source.evaluation_manifest_sha256,
    sensitivity_id: source.sensitivity_id,
    sensitivity_manifest_sha256: source.sensitivity_manifest_sha256,
    sensitivity_descriptor_sha256: source.sensitivity_descriptor_sha256,
    engine_runtime_sha256: source.engine_runtime_sha256,
    tuning_base_config_sha256: source.tuning_base_config_sha256,
    parameter_registry_version: source.parameter_registry_version,
    parameter_registry_sha256: source.parameter_registry_sha256,
    evaluated_splits: [policy.computation_split],
    validation_evaluated: false,
    test_evaluated: false,
    source_validation_scope: 'SOURCE_LINKED',
    computation_access_policy: 'TRAIN_ONLY',
    result_usage: resultUsage,
    cohort_sample_count: counts.cohort_sample_count,
    cohort_event_count: counts.cohort_event_count,
    cohort_date_count: counts.cohort_date_count,
    candidate_count: counts.candidate_count,
    feasible_candidate_count: counts.feasible_candidate_count,
    finalist_count: counts.finalist_count,
    engineering_readiness: readiness.engineering_readiness,
    data_readiness: readiness.data_readiness,
    metric_readiness: readiness.metric_readiness,
    mapping_status: source.mapping_status,
    interpretation_scope: source.interpretation_scope,
    no_skill_reference_ordinal: source.no_skill_reference_ordinal,
    validation_disclosure_status: source.validation_disclosure_status,
    validation_disclosure_evidence_id: source.validation_disclosure_evidence_id ?? null,
    validation_disclosure_evidence_sha256: source.validation_disclosure_evidence_sha256 ?? null,
    validation_access_ledger_sha256: source.validation_access_ledger_sha256 ?? null,
    schema_sha256: null,
    policy_sha256: null,
    files: {},
    ...extra
  };
}
