import { canonicalJson, hash, unique } from '../../dataset/lib/common.mjs';
import { writeCsv, readCsv } from '../../dataset/lib/csv.mjs';
import { modelSchema, SAMPLE_FIELDS, EVENT_FIELDS, ERROR_FIELDS } from '../model-dataset-schema.mjs';
import { POLICY, modelPolicy } from '../model-dataset-policy.mjs';
export const CSV_TABLES = { 'model_samples.csv': SAMPLE_FIELDS, 'event_splits.csv': EVENT_FIELDS,
  'splits/train.csv': SAMPLE_FIELDS, 'splits/validation.csv': SAMPLE_FIELDS, 'splits/test.csv': SAMPLE_FIELDS,
  'diagnostic_samples.csv': SAMPLE_FIELDS, 'excluded_samples.csv': SAMPLE_FIELDS };
function csvTables(version) {
  const schema = modelSchema(version);
  return Object.fromEntries(Object.keys(CSV_TABLES).map(f => [f, f === 'event_splits.csv' ? schema.tables.event_splits : schema.tables.samples]));
}
export const FILES = ['schema.json', 'policy.json', ...Object.keys(CSV_TABLES), 'reports/statistics.json', 'reports/split-balance.json', 'reports/errors.csv'];
export function contents(result) {
  const version = result.version || 1, tables = csvTables(version);
  const rows = { 'model_samples.csv': result.rows.filter(r => r.eligibility === 'PRIMARY'), 'event_splits.csv': result.events,
    'diagnostic_samples.csv': result.rows.filter(r => r.eligibility === 'DIAGNOSTIC'), 'excluded_samples.csv': result.rows.filter(r => r.eligibility === 'EXCLUDED') };
  for (const s of POLICY.splits) rows[`splits/${s.toLowerCase()}.csv`] = result.rows.filter(r => r.split === s);
  return { 'schema.json': canonicalJson(modelSchema(version)), 'policy.json': canonicalJson(modelPolicy(version)),
    ...Object.fromEntries(Object.entries(tables).map(([f, fields]) => [f, writeCsv(fields, rows[f])])),
    'reports/statistics.json': canonicalJson(result.statistics), 'reports/split-balance.json': canonicalJson(result.balance),
    'reports/errors.csv': writeCsv(ERROR_FIELDS, []) };
}
export function identity(descriptor) {
  const digest = hash(canonicalJson(descriptor));
  return { descriptor_sha256: digest, model_dataset_id: `model_v${descriptor.model_dataset_schema_version}_${descriptor.source_descriptor_sha256.slice(0, 12)}_${descriptor.ground_truth_descriptor_sha256.slice(0, 12)}_${digest.slice(0, 12)}` };
}
export function makeManifest(source, result, files, createdAt = new Date().toISOString()) {
  const version = result.version || 1, tables = csvTables(version);
  const metadata = Object.fromEntries(FILES.map(f => [f, { sha256: hash(files[f]), bytes: Buffer.byteLength(files[f]),
    ...(tables[f] ? { rows: readCsv(tables[f], files[f]).length } : f === 'reports/errors.csv' ? { rows: 0 } : {}) }]));
  const descriptor = { model_dataset_schema_version: version, model_dataset_policy_version: version,
    schema_sha256: metadata['schema.json'].sha256, policy_sha256: metadata['policy.json'].sha256,
    selection: result.plan.selection,
    ...Object.fromEntries(Object.entries(source).filter(([k]) => k !== 'source_versions')),
    csv_sha256: Object.fromEntries(Object.keys(CSV_TABLES).map(f => [f, metadata[f].sha256])) };
  const versions = rows => ({ model_versions: unique(rows.map(r => r.model_version)), engine_build_shas: unique(rows.map(r => r.engine_build_sha)), config_hashes: unique(rows.map(r => r.config_hash)) });
  return { model_dataset_schema_version: version, model_dataset_policy_version: version, ...identity(descriptor), ...source,
    schema_sha256: descriptor.schema_sha256, policy_sha256: descriptor.policy_sha256, selection: result.plan.selection,
    descriptor, counts: result.counts,
    split: { ...result.plan.selected_split, splits: Object.fromEntries(POLICY.splits.map(s => [s, {
      ...result.plan.selected_split.splits[s], samples: result.counts[`${s.toLowerCase()}_samples`] }])) },
    versions: { source: versions(result.rows), primary: versions(result.rows.filter(r => r.eligibility === 'PRIMARY')) },
    files: metadata, test_set_policy: POLICY.test_set_policy, builder_version: '2.5.0', created_at_utc: createdAt };
}
