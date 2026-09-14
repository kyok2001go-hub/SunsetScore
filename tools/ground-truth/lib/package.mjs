import { canonicalJson, hash } from '../../dataset/lib/common.mjs';
import { writeCsv, readCsv } from '../../dataset/lib/csv.mjs';
import { groundTruthSchema, EVENT_FIELDS, ERROR_FIELDS } from '../ground-truth-schema.mjs';
import { POLICY } from '../ground-truth-policy.mjs';
export const FILES = ['schema.json', 'policy.json', 'event_ground_truth.csv', 'observation_contributions.csv',
  'reports/statistics.json', 'reports/source-agreement.json', 'reports/errors.csv'];
export function contents(result, issues = [], version = 2) {
  const schema = groundTruthSchema(version);
  const events = new Map(result.gt.map(e => [e.event_id, e]));
  const contributions = version === 1 ? result.contributions : result.contributions.map(row => ({
    event_id: row.event_id, event_date_local: events.get(row.event_id).event_date_local, city: events.get(row.event_id).city,
    ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'event_id'))
  }));
  return {
    'schema.json': canonicalJson(schema), 'policy.json': canonicalJson(POLICY),
    'event_ground_truth.csv': writeCsv(EVENT_FIELDS, result.gt),
    'observation_contributions.csv': writeCsv(schema.tables.observation_contributions, contributions),
    'reports/statistics.json': canonicalJson(result.statistics), 'reports/source-agreement.json': canonicalJson(result.agreement),
    'reports/errors.csv': writeCsv(ERROR_FIELDS, issues)
  };
}
export function identity(descriptor) {
  const digest = hash(canonicalJson(descriptor));
  return { descriptor_sha256: digest, ground_truth_id: `gt_v${descriptor.ground_truth_schema_version}_${descriptor.source_descriptor_sha256.slice(0, 12)}_${digest.slice(0, 12)}` };
}
export function makeManifest(source, result, files, createdAt = new Date().toISOString()) {
  const metadata = Object.fromEntries(FILES.map(file => [file, { sha256: hash(files[file]), bytes: Buffer.byteLength(files[file]) }]));
  metadata['event_ground_truth.csv'].rows = result.gt.length;
  metadata['observation_contributions.csv'].rows = result.contributions.length;
  metadata['reports/errors.csv'].rows = readCsv(ERROR_FIELDS, files['reports/errors.csv']).length;
  const version = JSON.parse(files['schema.json']).ground_truth_schema_version;
  groundTruthSchema(version);
  const descriptor = { ground_truth_schema_version: version, gt_policy_version: 1, ...source,
    schema_sha256: metadata['schema.json'].sha256, policy_sha256: metadata['policy.json'].sha256,
    event_ground_truth_sha256: metadata['event_ground_truth.csv'].sha256,
    observation_contributions_sha256: metadata['observation_contributions.csv'].sha256 };
  return { ground_truth_schema_version: version, gt_policy_version: 1, ...identity(descriptor), ...source,
    policy_sha256: descriptor.policy_sha256, schema_sha256: descriptor.schema_sha256,
    files: metadata, counts: { event_count: result.gt.length, labeled_event_count: result.statistics.labeled_events,
      observation_count: result.contributions.length, status_counts: result.statistics.status_counts },
    descriptor, builder_version: '2.4.9', created_at_utc: createdAt };
}
