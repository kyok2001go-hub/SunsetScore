#!/usr/bin/env node
import path from 'node:path';
import { canonicalUtc, CONSISTENCY_POLICY, datasetSchema } from './dataset-schema.mjs';
import { descriptorIdentity, datasetVersions, makeDescriptor, REGISTERED_FILES } from './build-manifest.mjs';
import { canonicalJson, compare, errorCode, fail, hash, inventory, isMain, parseReadArgs, readSafe, reportOutside, rowOrder, safePath } from './lib/common.mjs';
import { readCsv } from './lib/csv.mjs';
import { assertSelection } from './lib/selection.mjs';
import { ERROR_FIELDS, isGoldenWindow, issue, qualityReport, validateTables } from './lib/quality.mjs';
import { datasetStatistics } from './lib/statistics.mjs';
import { validateDatasetReplay } from './lib/replay-cache.mjs';

const equal = (a, b, code) => { if (canonicalJson(a) !== canonicalJson(b)) fail(code); };
async function jsonFile(file) {
  const bytes = await readSafe(file), parsed = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJson(parsed)))) fail('JSON_NOT_CANONICAL');
  return parsed;
}
export async function inspectDataset(directory, options = {}) {
  await safePath(directory);
  const manifest = await jsonFile(path.join(directory, 'manifest.json'));
  if (manifest.offline_dataset_schema_version !== 1 || manifest.consistency_policy !== CONSISTENCY_POLICY) fail('DATASET_SCHEMA_INVALID');
  const selection = assertSelection(manifest.selection);
  equal(selection, manifest.selection, 'SELECTION_INVALID');
  const cutoff = manifest.export_cutoff_epoch;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !canonicalUtc(manifest.export_cutoff_utc) ||
      Date.parse(manifest.export_cutoff_utc) !== cutoff || !canonicalUtc(manifest.created_at_utc)) fail('CUTOFF_INVALID');
  const schema = await jsonFile(path.join(directory, 'schema.json'));
  equal(schema, datasetSchema(selection.include_comments), 'DATASET_SCHEMA_INVALID');
  equal(Object.keys(manifest.files).sort(compare), [...REGISTERED_FILES].sort(compare), 'MANIFEST_FILES_INVALID');
  const tables = {}, files = {};
  for (const name of REGISTERED_FILES) {
    const bytes = await readSafe(path.join(directory, name)), metadata = manifest.files[name];
    if (hash(bytes) !== metadata.sha256 || bytes.length !== metadata.bytes) fail('FILE_HASH_MISMATCH');
    files[name] = { sha256: hash(bytes) };
    if (name.startsWith('raw/')) {
      const table = path.basename(name, '.csv');
      tables[table] = readCsv(schema.tables[table], bytes);
      if (tables[table].length !== metadata.rows) fail('ROW_COUNT_MISMATCH');
      const order = ['prediction_snapshots', 'sunset_observations'].includes(table) ? rowOrder
        : (a, b) => compare(a[table === 'events' ? 'event_id' : 'snapshot_id'], b[table === 'events' ? 'event_id' : 'snapshot_id']);
      equal(tables[table], [...tables[table]].sort(order), 'ROW_ORDER_INVALID');
    }
  }
  const replaySummary = { hasGoldenWindow: false }, replayIssues = [], snapshotMap = new Map(tables.prediction_snapshots.map(x => [x.id, x]));
  for (const row of tables.replay_index) {
    try {
      if (!/^[A-Za-z0-9_-]{1,180}$/.test(row.snapshot_id) || row.local_path !== `replay/${row.snapshot_id}.json`) fail('UNSAFE_PATH');
      const bytes = await readSafe(path.join(directory, row.local_path));
      if (hash(bytes) !== row.replay_sha256 || bytes.length !== row.replay_size_bytes) fail('REPLAY_HASH_MISMATCH');
      const snapshot = snapshotMap.get(row.snapshot_id);
      if (!snapshot) fail('REPLAY_SNAPSHOT_MISMATCH');
      const replay = await validateDatasetReplay({ ...snapshot, replay_status: 'READY', replay_compression: 'gzip',
        replay_schema_version: row.replay_schema_version, replay_sha256: row.replay_sha256,
        replay_size_bytes: row.replay_compressed_size_bytes, replay_object_key: 'offline' }, bytes);
      if (replay.identity.engine_build_sha !== row.engine_build_sha || replay.identity.config_hash !== row.config_hash ||
          replay.identity.event_id !== row.event_id || !bytes.equals(Buffer.from(canonicalJson(replay)))) fail('REPLAY_INDEX_MISMATCH');
      replaySummary.hasGoldenWindow ||= isGoldenWindow(replay);
    } catch (error) { replayIssues.push(issue(errorCode(error), row, 'replay')); }
  }
  if (replayIssues.length) return { manifest, tables, report: qualityReport(replayIssues) };
  const report = await validateTables(tables, selection, cutoff, replaySummary);
  if (report.status === 'FAIL') return { manifest, tables, report };
  const descriptor = makeDescriptor(selection, cutoff, files, tables.replay_index);
  equal(descriptor, manifest.descriptor, 'DESCRIPTOR_MISMATCH');
  const identity = descriptorIdentity(descriptor);
  if (manifest.dataset_id !== identity.dataset_id || manifest.descriptor_sha256 !== identity.descriptor_sha256 ||
      manifest.replay_set_sha256 !== descriptor.replay_set_sha256) fail('DATASET_ID_MISMATCH');
  if (!options.staging && path.basename(path.resolve(directory)) !== manifest.dataset_id) fail('DATASET_DIRECTORY_MISMATCH');
  equal(datasetVersions(tables), manifest.versions, 'VERSIONS_MISMATCH');
  const statistics = datasetStatistics(tables, selection);
  equal(statistics.counts, manifest.counts, 'COUNTS_MISMATCH');
  equal(await jsonFile(path.join(directory, 'reports/statistics.json')), statistics, 'STATISTICS_MISMATCH');
  equal(await jsonFile(path.join(directory, 'reports/data-quality.json')), report, 'QUALITY_REPORT_MISMATCH');
  const errors = readCsv(ERROR_FIELDS, await readSafe(path.join(directory, 'reports/errors.csv')));
  equal(errors, report.issues, 'ERROR_REPORT_MISMATCH');
  if (errors.length !== manifest.files['reports/errors.csv'].rows) fail('ROW_COUNT_MISMATCH');
  equal(await inventory(directory), [...REGISTERED_FILES, 'manifest.json', ...tables.replay_index.map(x => x.local_path)].sort(compare), 'PACKAGE_FILES_INVALID');
  return { manifest, tables, report, statistics };
}
export async function validateDataset(directory, options = {}) {
  try { return await inspectDataset(directory, options); }
  catch (error) { return { report: qualityReport([issue(errorCode(error))]) }; }
}
if (isMain(import.meta.url)) {
  try {
    const options = parseReadArgs(process.argv.slice(2));
    const result = await validateDataset(options.dataset);
    if (options.reportDir) await reportOutside(options.dataset, options.reportDir, 'data-quality.json', result.report);
    console.log(canonicalJson(result.report));
    if (result.report.status !== 'PASS') process.exitCode = 1;
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
}
