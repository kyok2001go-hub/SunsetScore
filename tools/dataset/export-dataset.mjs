#!/usr/bin/env node
import { mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { datasetSchema, projectRow } from './dataset-schema.mjs';
import { buildEventIndex } from './build-event-index.mjs';
import { buildManifest } from './build-manifest.mjs';
import { validateDataset } from './validate-dataset.mjs';
import { canonicalJson, compare, errorCode, fail, hash, isMain, readSafe, removeOwned, runId, safePath, withLock, writeJson } from './lib/common.mjs';
import { writeCsv } from './lib/csv.mjs';
import { cachedReplay } from './lib/replay-cache.mjs';
import { createRemoteSource } from './lib/wrangler.mjs';
import { assertSelection, eventIdsFor, extractObservations, extractSnapshots, parseExportArgs } from './lib/selection.mjs';
import { ERROR_FIELDS, isGoldenWindow, issue, qualityReport, validateTables } from './lib/quality.mjs';
import { datasetStatistics } from './lib/statistics.mjs';

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
function exporterCommit() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  const sha = String(result.stdout || '').trim();
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}
async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function publishDataset(staging, destination, manifest) {
  await safePath(destination);
  return withLock(`${destination}.lock`, async () => {
    if (await exists(destination)) {
      const current = await validateDataset(destination);
      if (current.report.status !== 'PASS' || current.manifest.descriptor_sha256 !== manifest.descriptor_sha256 ||
          !same(current.manifest.descriptor, manifest.descriptor)) fail('DATASET_ID_CONFLICT');
      return 'DEDUPLICATED';
    }
    await rename(staging, destination);
    return 'EXPORTED';
  });
}

export async function exportDataset(options, dependencies = {}) {
  const output = await safePath(options.output), id = runId();
  const staging = path.join(output, 'staging', id), temp = path.join(staging, '.download');
  await safePath(temp);
  await mkdir(temp, { recursive: true });
  const source = dependencies.source || createRemoteSource(options, temp);
  const metrics = [], started = Date.now();
  let hits = 0, misses = 0;
  try {
    const selection = assertSelection(options.selection);
    if (!same(selection, options.selection)) fail('SELECTION_INVALID');
    const serverTime = await source.query("SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 AS cutoff_epoch");
    const now = serverTime?.[0]?.cutoff_epoch;
    if (!Number.isSafeInteger(now) || now < 0) fail('D1_TIME_INVALID');
    const cutoff = options.cutoff ? Date.parse(options.cutoff) : now;
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > now) fail('INVALID_CUTOFF');
    const schema = datasetSchema(selection.include_comments), pageSize = dependencies.pageSize ?? 1000;
    const rawSnapshots = await extractSnapshots(source, selection, cutoff, pageSize, metrics);
    if (!rawSnapshots.length) fail('EMPTY_SELECTION');
    const events = eventIdsFor(rawSnapshots);
    const rawObservations = await extractObservations(source, selection, cutoff, events, pageSize, metrics);
    const tables = {
      prediction_snapshots: rawSnapshots.map(row => projectRow({ ...row,
        lead_time_minutes: (Date.parse(row.sunset_time_utc) - row.prediction_time_epoch) / 60000 }, schema.tables.prediction_snapshots)),
      sunset_observations: rawObservations.map(row => projectRow(row, schema.tables.sunset_observations)),
      events: [], replay_index: []
    };
    await mkdir(path.join(staging, 'replay'));
    const replaySummary = { hasGoldenWindow: false };
    for (const row of rawSnapshots) {
      try {
        const cached = await cachedReplay(row, path.join(output, 'cache/replay'), source.download.bind(source), dependencies);
        if (cached.hit) hits++; else misses++;
        const local = `replay/${row.id}.json`;
        await writeFile(path.join(staging, local), cached.bytes, { flag: 'wx' });
        if (hash(await readSafe(path.join(staging, local))) !== row.replay_sha256) fail('REPLAY_HASH_MISMATCH');
        replaySummary.hasGoldenWindow ||= isGoldenWindow(cached.replay);
        tables.replay_index.push(projectRow({ snapshot_id: row.id, event_id: row.event_id,
          replay_schema_version: row.replay_schema_version, engine_build_sha: cached.replay.identity.engine_build_sha,
          config_hash: cached.replay.identity.config_hash, replay_sha256: row.replay_sha256,
          replay_size_bytes: cached.bytes.length, replay_compressed_size_bytes: row.replay_size_bytes,
          replay_saved_at_utc: row.replay_saved_at_utc, local_path: local }, schema.tables.replay_index));
      } catch (error) {
        Object.assign(error, { entity_type: 'replay', entity_id: row.id, event_id: row.event_id });
        throw error;
      }
    }
    tables.replay_index.sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
    tables.events = buildEventIndex(tables.prediction_snapshots, tables.sunset_observations, tables.replay_index);
    const quality = await validateTables(tables, selection, cutoff, replaySummary);
    if (quality.status !== 'PASS') throw Object.assign(new Error('DATASET_QUALITY_FAILED'), { report: quality });
    await mkdir(path.join(staging, 'raw'));
    await mkdir(path.join(staging, 'reports'));
    for (const [table, rows] of Object.entries(tables)) await writeFile(path.join(staging, `raw/${table}.csv`), writeCsv(schema.tables[table], rows), { flag: 'wx' });
    await writeJson(path.join(staging, 'schema.json'), schema);
    await writeJson(path.join(staging, 'reports/data-quality.json'), quality);
    await writeJson(path.join(staging, 'reports/statistics.json'), datasetStatistics(tables, selection));
    await writeFile(path.join(staging, 'reports/errors.csv'), writeCsv(ERROR_FIELDS, quality.issues), { flag: 'wx' });
    const snapshotsAgain = await extractSnapshots(source, selection, cutoff, pageSize, metrics);
    const observationsAgain = await extractObservations(source, selection, cutoff, events, pageSize, metrics);
    if (!same(rawSnapshots, snapshotsAgain) || !same(rawObservations, observationsAgain)) fail('SOURCE_CHANGED_DURING_EXPORT');
    await removeOwned(staging, temp);
    const manifest = await buildManifest(staging, tables, { ...options, selection, cutoff,
      issueCount: quality.issues.length, createdAt: dependencies.createdAt, commit: exporterCommit() });
    await writeJson(path.join(staging, 'manifest.json'), manifest);
    const validation = await validateDataset(staging, { staging: true });
    if (validation.report.status !== 'PASS') throw Object.assign(new Error('DATASET_VALIDATION_FAILED'), { report: validation.report });
    await safePath(path.join(output, 'exports'));
    await mkdir(path.join(output, 'exports'), { recursive: true });
    const destination = path.join(output, 'exports', manifest.dataset_id);
    const status = await publishDataset(staging, destination, manifest);
    if (status === 'DEDUPLICATED') await removeOwned(path.join(output, 'staging'), staging);
    return { status, dataset_id: manifest.dataset_id, directory: destination, counts: manifest.counts,
      cache_hits: hits, downloads: misses, duration_ms: Date.now() - started, query_metrics: metrics,
      provenance: manifest.provenance };
  } catch (error) {
    const report = error.report || qualityReport([issue(errorCode(error), { id: error.entity_id, event_id: error.event_id }, error.entity_type || 'dataset')]);
    await mkdir(path.join(staging, 'reports'), { recursive: true });
    // Staging is mutable; failure must replace any earlier PASS report.
    await writeFile(path.join(staging, 'reports/data-quality.json'), canonicalJson(report));
    await writeFile(path.join(staging, 'reports/errors.csv'), writeCsv(ERROR_FIELDS, report.issues));
    await removeOwned(staging, temp);
    return { status: 'FAIL', error_code: errorCode(error), staging, report };
  }
}
if (isMain(import.meta.url)) {
  try {
    const result = await exportDataset(parseExportArgs(process.argv.slice(2)));
    console.log(canonicalJson(result));
    if (result.status === 'FAIL') process.exitCode = 1;
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
}
