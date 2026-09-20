import { canonicalJson, compare, hash } from '../../dataset/lib/common.mjs';
import { readCsv, writeCsv } from '../../dataset/lib/csv.mjs';
import { evaluate } from '../lib/core.mjs';
import { evaluationSchema } from '../evaluation-schema.mjs';
import { scoreToOrdinal } from '../metrics.mjs';
import { evaluationSchemaV2, V2_EXPORT_FILES } from './schema.mjs';
import { evaluationPolicyV2, MAPPING } from './policy.mjs';
import { noSkillComparison, selectNoSkillReference } from './no-skill.mjs';
import { silentProgress } from '../../progress.mjs';

const CSV_FILES = ['confusion_matrix.csv', 'slice_metrics.csv', 'score_distribution.csv',
  'baseline_comparison.csv', 'error_cases.csv', 'reports/warnings.csv'];

function closestRows(rows) {
  const chosen = new Map();
  for (const row of rows) {
    const prior = chosen.get(row.event_id);
    if (!prior || row.lead_time_minutes < prior.lead_time_minutes ||
        (row.lead_time_minutes === prior.lead_time_minutes &&
          (row.prediction_time_epoch > prior.prediction_time_epoch ||
            (row.prediction_time_epoch === prior.prediction_time_epoch && compare(row.snapshot_id, prior.snapshot_id) < 0)))) {
      chosen.set(row.event_id, row);
    }
  }
  return [...chosen.values()].map(r => ({ ...r, weight: r.gt_confidence }));
}

export function evaluateV2(modelManifest, modelManifestSha256, trainRows, inputWarnings = [], progress = silentProgress) {
  // V1's metric engine is reused with an empty validation cohort. Its empty validation groups
  // are discarded before any V2 package bytes are produced.
  const old = evaluate(modelManifest, modelManifestSha256, trainRows, [], inputWarnings, progress);
  const oldSchema = evaluationSchema(1);
  const schema = evaluationSchemaV2();
  const policy = evaluationPolicyV2();
  const reference = selectNoSkillReference(trainRows);
  const rows = trainRows.map(r => ({ ...r, predicted_ordinal: scoreToOrdinal(r.predicted_score),
    weight: r.event_normalized_weight }));
  const cohorts = { ALL_PRIMARY: rows, CLOSEST_PRE_SUNSET: closestRows(rows) };
  const noSkillRows = [];
  for (const mode of policy.benchmark_modes) {
    for (const weighting of policy.weightings) {
      noSkillRows.push(noSkillComparison(cohorts[mode], mode, weighting, reference));
    }
  }

  const csvRows = {};
  for (const name of CSV_FILES) {
    const table = name.replace('reports/', '').replace('.csv', '');
    csvRows[name] = readCsv(oldSchema.tables[table], old.files[name])
      .filter(r => r.split === 'TRAIN' || r.split === null)
      .map(r => name === 'confusion_matrix.csv' ?
        { ...r, predicted_label: policy.mapping.prediction_levels[r.predicted_ordinal] } : r);
  }
  const warnings = csvRows['reports/warnings.csv'];
  const warningCounts = {};
  for (const row of warnings) warningCounts[row.warning_code] = (warningCounts[row.warning_code] || 0) + 1;

  const oldOverall = JSON.parse(old.files['overall_metrics.json']);
  const overall = {
    evaluation_schema_version: 2, evaluation_policy_version: 2,
    benchmark_modes: policy.benchmark_modes, splits: ['TRAIN'], benchmarks: {}
  };
  const oldSummary = JSON.parse(old.files['reports/summary.json']);
  const summary = {
    model_dataset_id: modelManifest.model_dataset_id,
    evaluation_schema_version: 2, evaluation_policy_version: 2,
    evaluated_splits: ['TRAIN'], validation_evaluated: false, test_evaluated: false,
    benchmark_modes: policy.benchmark_modes, evaluated_versions: old.evaluatedVersions,
    ...MAPPING, no_skill_reference: reference, groups: {}, warnings_summary: warningCounts
  };
  const benchmarkCounts = {};
  for (const mode of policy.benchmark_modes) {
    overall.benchmarks[mode] = { TRAIN: oldOverall.benchmarks[mode].TRAIN };
    benchmarkCounts[mode] = { TRAIN: old.benchmarkCounts[mode].TRAIN };
    summary.groups[`${mode}.TRAIN`] = {
      ...oldSummary.groups[`${mode}.TRAIN`],
      no_skill_comparison: Object.fromEntries(noSkillRows.filter(r => r.benchmark_mode === mode)
        .map(r => [r.weighting, r]))
    };
  }

  const files = {
    'schema.json': canonicalJson(schema),
    'policy.json': canonicalJson(policy),
    'overall_metrics.json': canonicalJson(overall),
    'reports/summary.json': canonicalJson(summary),
    'no_skill_comparison.csv': writeCsv(schema.tables.no_skill_comparison, noSkillRows)
  };
  for (const name of CSV_FILES) {
    const table = name.replace('reports/', '').replace('.csv', '');
    files[name] = writeCsv(schema.tables[table], csvRows[name]);
  }
  const metadata = {};
  for (const name of V2_EXPORT_FILES) {
    const bytes = Buffer.from(files[name], 'utf8');
    const table = name.replace('reports/', '').replace('.csv', '');
    metadata[name] = { sha256: hash(bytes), bytes: bytes.length,
      ...(name.endsWith('.csv') ? { rows: readCsv(schema.tables[table], bytes).length } : {}) };
  }
  const descriptor = {
    benchmark_modes: policy.benchmark_modes,
    evaluated_splits: ['TRAIN'], evaluation_schema_version: 2, evaluation_policy_version: 2,
    model_dataset_id: modelManifest.model_dataset_id,
    model_dataset_manifest_sha256: modelManifestSha256,
    model_dataset_descriptor_sha256: modelManifest.descriptor_sha256,
    schema_sha256: metadata['schema.json'].sha256,
    policy_sha256: metadata['policy.json'].sha256,
    computation_access_policy: 'TRAIN_ONLY',
    validation_access_policy: 'UPSTREAM_VALIDATION_ONLY',
    test_access_policy: 'UPSTREAM_VALIDATION_ONLY',
    ...MAPPING,
    no_skill_reference: reference,
    files_sha256: Object.fromEntries(V2_EXPORT_FILES.map(name => [name, metadata[name].sha256]))
  };
  const descriptorSha = hash(canonicalJson(descriptor));
  const evaluationId = `baseline_v2_${modelManifest.descriptor_sha256.slice(0, 12)}_${descriptorSha.slice(0, 12)}`;
  const counts = old.benchmarkCounts.ALL_PRIMARY.TRAIN;
  const manifest = {
    evaluation_schema_version: 2, evaluation_policy_version: 2,
    evaluation_id: evaluationId, descriptor_sha256: descriptorSha, descriptor,
    model_dataset_id: modelManifest.model_dataset_id,
    model_dataset_manifest_sha256: modelManifestSha256,
    model_dataset_schema_version: modelManifest.model_dataset_schema_version,
    model_dataset_policy_version: modelManifest.model_dataset_policy_version,
    model_dataset_descriptor_sha256: modelManifest.descriptor_sha256,
    evaluated_splits: ['TRAIN'], validation_evaluated: false,
    validation_evaluation_sample_count: 0, test_evaluated: false,
    test_evaluation_sample_count: 0, upstream_validation_scope: 'SOURCE_LINKED',
    computation_access_policy: 'TRAIN_ONLY',
    validation_access_policy: 'UPSTREAM_VALIDATION_ONLY',
    test_access_policy: 'UPSTREAM_VALIDATION_ONLY',
    ...MAPPING, no_skill_reference: reference,
    benchmark_modes: policy.benchmark_modes,
    sample_count: counts.sample_count, event_count: counts.event_count,
    date_count: counts.date_count, benchmark_counts: benchmarkCounts,
    evaluated_versions: old.evaluatedVersions,
    schema_sha256: metadata['schema.json'].sha256,
    policy_sha256: metadata['policy.json'].sha256, files: metadata
  };
  return {
    files: { ...files, 'manifest.json': canonicalJson(manifest) },
    manifest, counts: { sample_count: counts.sample_count, event_count: counts.event_count,
      date_count: counts.date_count }, benchmarkCounts, evaluatedVersions: old.evaluatedVersions
  };
}
