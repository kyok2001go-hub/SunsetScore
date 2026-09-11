import path from 'node:path';
import { CONSISTENCY_POLICY } from './dataset-schema.mjs';
import { canonicalJson, compare, hash, readSafe, unique } from './lib/common.mjs';

export const RAW_FILES = ['prediction_snapshots', 'sunset_observations', 'events', 'replay_index'].map(name => `raw/${name}.csv`);
export const REPORT_FILES = ['reports/data-quality.json', 'reports/statistics.json', 'reports/errors.csv'];
export const REGISTERED_FILES = [...RAW_FILES, 'schema.json', ...REPORT_FILES];
export function replaySetHash(replays) {
  return hash(canonicalJson([...replays].sort((a, b) => compare(a.snapshot_id, b.snapshot_id)).map(row =>
    Object.fromEntries(['snapshot_id', 'event_id', 'replay_sha256', 'replay_size_bytes', 'local_path'].map(key => [key, row[key]])))));
}
export function makeDescriptor(selection, cutoff, files, replays) {
  return { offline_dataset_schema_version: 1, consistency_policy: CONSISTENCY_POLICY,
    selection, export_cutoff_epoch: cutoff, schema_sha256: files['schema.json'].sha256,
    raw_files: Object.fromEntries(RAW_FILES.map(name => [name, files[name].sha256])),
    replay_set_sha256: replaySetHash(replays) };
}
export function descriptorIdentity(descriptor) {
  const digest = hash(canonicalJson(descriptor)), s = descriptor.selection;
  return { descriptor_sha256: digest,
    dataset_id: `raw_v1_${s.event_date_from.replaceAll('-', '')}_${s.event_date_to.replaceAll('-', '')}_${digest.slice(0, 12)}` };
}
export const datasetVersions = tables => ({
  dataset_schema_versions: [...new Set([...tables.prediction_snapshots, ...tables.sunset_observations].map(x => x.dataset_schema_version))].sort((a, b) => a - b),
  replay_schema_versions: [...new Set(tables.replay_index.map(x => x.replay_schema_version))].sort((a, b) => a - b),
  model_versions: unique(tables.prediction_snapshots.map(x => x.model_version)),
  engine_build_shas: unique(tables.replay_index.map(x => x.engine_build_sha)),
  config_hashes: unique(tables.replay_index.map(x => x.config_hash))
});
export async function buildManifest(directory, tables, options) {
  const files = {};
  for (const name of REGISTERED_FILES) {
    const bytes = await readSafe(path.join(directory, name));
    files[name] = { sha256: hash(bytes), bytes: bytes.length };
    if (name.startsWith('raw/')) files[name].rows = tables[path.basename(name, '.csv')].length;
    if (name === 'reports/errors.csv') files[name].rows = options.issueCount;
  }
  const descriptor = makeDescriptor(options.selection, options.cutoff, files, tables.replay_index);
  return { offline_dataset_schema_version: 1, ...descriptorIdentity(descriptor),
    created_at_utc: options.createdAt || new Date().toISOString(),
    export_cutoff_epoch: options.cutoff, export_cutoff_utc: new Date(options.cutoff).toISOString(),
    selection: options.selection, consistency_policy: CONSISTENCY_POLICY,
    provenance: { database: options.database, bucket: options.bucket, exporter_version: '2.4.8', exporter_commit: options.commit || null },
    counts: { snapshots: tables.prediction_snapshots.length, observations: tables.sunset_observations.length,
      events: tables.events.length, replays: tables.replay_index.length },
    versions: datasetVersions(tables), files, replay_set_sha256: descriptor.replay_set_sha256, descriptor };
}
