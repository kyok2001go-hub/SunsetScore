import { canonicalJson, hash } from '../../dataset/lib/common.mjs';
import {
  CONFUSION_MATRIX_FIELDS,
  SLICE_METRICS_FIELDS,
  SCORE_DISTRIBUTION_FIELDS,
  BASELINE_COMPARISON_FIELDS,
  ERROR_CASES_FIELDS,
  WARNING_FIELDS,
  EXPORT_FILES
} from '../evaluation-schema.mjs';

export { EXPORT_FILES };

export const CSV_TABLES = Object.freeze({
  'confusion_matrix.csv': CONFUSION_MATRIX_FIELDS,
  'slice_metrics.csv': SLICE_METRICS_FIELDS,
  'score_distribution.csv': SCORE_DISTRIBUTION_FIELDS,
  'baseline_comparison.csv': BASELINE_COMPARISON_FIELDS,
  'error_cases.csv': ERROR_CASES_FIELDS,
  'reports/warnings.csv': WARNING_FIELDS
});

export function identity(descriptor) {
  const digest = hash(canonicalJson(descriptor));
  const modelShort = descriptor.model_dataset_descriptor_sha256.slice(0, 12);
  const hash12 = digest.slice(0, 12);
  return {
    descriptor_sha256: digest,
    evaluation_id: `baseline_v1_${modelShort}_${hash12}`
  };
}

export function makeManifest(
  modelManifest,
  modelManifestSha256,
  filesMetadata,
  counts,
  benchmarkCounts,
  evaluatedVersions,
  descriptor
) {
  const id = identity(descriptor);
  return {
    evaluation_schema_version: 1,
    evaluation_policy_version: 1,
    evaluation_id: id.evaluation_id,
    descriptor_sha256: id.descriptor_sha256,
    descriptor,
    model_dataset_id: modelManifest.model_dataset_id,
    model_dataset_manifest_sha256: modelManifestSha256,
    model_dataset_schema_version: modelManifest.model_dataset_schema_version,
    model_dataset_policy_version: modelManifest.model_dataset_policy_version,
    model_dataset_descriptor_sha256: modelManifest.descriptor_sha256,
    evaluated_splits: ['TRAIN', 'VALIDATION'],
    test_evaluated: false,
    test_evaluation_sample_count: 0,
    upstream_validation_scope: 'SOURCE_LINKED',
    test_access_policy: 'UPSTREAM_VALIDATION_ONLY',
    benchmark_modes: ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET'],
    sample_count: counts.sample_count,
    event_count: counts.event_count,
    date_count: counts.date_count,
    benchmark_counts: benchmarkCounts,
    evaluated_versions: evaluatedVersions,
    schema_sha256: filesMetadata['schema.json'].sha256,
    policy_sha256: filesMetadata['policy.json'].sha256,
    files: filesMetadata
  };
}
