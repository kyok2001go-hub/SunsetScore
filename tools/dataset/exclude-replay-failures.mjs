#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { inspectDataset } from './validate-dataset.mjs';
import { publishDataset } from './export-dataset.mjs';
import { buildManifest } from './build-manifest.mjs';
import { datasetSchema } from './dataset-schema.mjs';
import { writeCsv } from './lib/csv.mjs';
import { ERROR_FIELDS, isGoldenWindow, validateTables } from './lib/quality.mjs';
import { datasetStatistics } from './lib/statistics.mjs';
import { canonicalJson, compare, hash, readSafe, writeJson, safePath, within, safeId, fail, runId, removeOwned, isMain, errorCode } from './lib/common.mjs';
import { filteredTables, referenceFor } from './lib/replay-exclusion.mjs';
import { compareReference, runReplay, REPLAY_RUNTIME_FILES } from '../replay/replay-runner.mjs';
import { withBuildLease } from '../maintenance/lib/lease.mjs';

async function withExclusionLeases(raw, output, operation) {
  const source = await safePath(raw);
  if (path.basename(path.dirname(source)) !== 'exports') fail('REPLAY_EXCLUSION_SOURCE_LAYOUT_INVALID');
  await mkdir(output, { recursive: true });
  const roots = await Promise.all([path.dirname(path.dirname(source)), output].map(root => realpath(root)));
  const unique = new Map(roots.map(root => [process.platform === 'win32' ? root.toLowerCase() : root, root]));
  const ordered = [...unique].sort((a, b) => compare(a[0], b[0])).map(([, root]) => root);
  const acquire = index => index === ordered.length ? operation() :
    withBuildLease('raw', () => acquire(index + 1), { datasetRoot: ordered[index] });
  return acquire(0);
}

export async function excludeReplayFailures(raw, ids, options = {}) {
  if (options.acknowledge !== true) fail('REPLAY_EXCLUSION_ACK_REQUIRED');
  const output = await safePath(options.output || 'dataset');
  if (within(raw, output)) fail('OUTPUT_DIRECTORY_INSIDE_DATASET');
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) fail('REPLAY_EXCLUSION_INVALID');
  ids.forEach(safeId);
  return withExclusionLeases(raw, output, async () => {
    const parent = await inspectDataset(raw);
    if (parent.report.status !== 'PASS') fail('REPLAY_EXCLUSION_SOURCE_INVALID');
    if (parent.manifest.selection.replay_exclusion) fail('REPLAY_EXCLUSION_ALREADY_DERIVED');
    const fingerprint = hash(await readSafe(path.join(raw, 'manifest.json')));
    const snapshots = new Map(parent.tables.prediction_snapshots.map(row => [row.id, row]));
    const replays = new Map(parent.tables.replay_index.map(row => [row.snapshot_id, row]));
    const records = [];
    for (const id of [...ids].sort()) {
      const row = snapshots.get(id), metadata = replays.get(id);
      if (!row || !metadata) fail('REPLAY_EXCLUSION_UNKNOWN_SNAPSHOT');
      const replay = JSON.parse((await readSafe(path.join(raw, metadata.local_path))).toString('utf8'));
      const reference = referenceFor(row);
      const first = await runReplay(replay, { reference }), second = await runReplay(replay, { reference });
      if (first.pass || second.pass) fail('REPLAY_EXCLUSION_PARITY_PASSED');
      if (canonicalJson(first) !== canonicalJson(second)) fail('REPLAY_EXCLUSION_NONDETERMINISTIC');
      const comparison = compareReference(first.actual, reference);
      if (comparison.issues.length) fail('REPLAY_EXCLUSION_REFERENCE_INVALID');
      records.push({ snapshot_id: id, replay_sha256: metadata.replay_sha256, reference, actual: first.actual, comparison });
    }
    const root = new URL('../../', import.meta.url);
    const runtime_files = await Promise.all([...REPLAY_RUNTIME_FILES, 'js/replay_service.js', 'tools/replay/replay-runner.mjs'].map(async file =>
      ({ path: file, sha256: hash(await readSafe(fileURLToPath(new URL(file, root)))) })));
    const audit = { decision: 'EXCLUDE_UNRECOVERABLE', reason_code: 'REFERENCE_PARITY_FAILED',
      parent_dataset_id: parent.manifest.dataset_id, parent_manifest_sha256: fingerprint, records, runtime_files };
    const selection = { ...parent.manifest.selection, replay_exclusion: audit }, tables = filteredTables(parent, audit);
    const staging = await safePath(path.join(output, 'staging', runId()));
    if (within(raw, staging)) fail('OUTPUT_DIRECTORY_INSIDE_DATASET');
    await mkdir(path.join(staging, 'raw'), { recursive: true });
    await mkdir(path.join(staging, 'reports')); await mkdir(path.join(staging, 'replay'));
    const summary = { hasGoldenWindow: false };
    for (const row of tables.replay_index) {
      const bytes = await readSafe(path.join(raw, row.local_path));
      summary.hasGoldenWindow ||= isGoldenWindow(JSON.parse(bytes.toString('utf8')));
      await writeFile(path.join(staging, row.local_path), bytes, { flag: 'wx' });
    }
    const schema = datasetSchema(selection.include_comments), quality = await validateTables(tables, selection, parent.manifest.export_cutoff_epoch, summary);
    if (quality.status !== 'PASS') fail('DATASET_QUALITY_FAILED');
    for (const [name, rows] of Object.entries(tables)) await writeFile(path.join(staging, `raw/${name}.csv`), writeCsv(schema.tables[name], rows), { flag: 'wx' });
    await writeJson(path.join(staging, 'schema.json'), schema);
    await writeJson(path.join(staging, 'reports/data-quality.json'), quality);
    await writeJson(path.join(staging, 'reports/statistics.json'), datasetStatistics(tables, selection));
    await writeFile(path.join(staging, 'reports/errors.csv'), writeCsv(ERROR_FIELDS, quality.issues), { flag: 'wx' });
    const manifest = await buildManifest(staging, tables, { selection, cutoff: parent.manifest.export_cutoff_epoch, issueCount: quality.issues.length });
    await writeJson(path.join(staging, 'manifest.json'), manifest);
    // Full parent integrity and exact subset checks; never silently mutate an original row.
    const validation = await inspectDataset(staging, { staging: true, sourceRawDir: raw });
    if (validation.report.status !== 'PASS') fail('DATASET_VALIDATION_FAILED');
    if (hash(await readSafe(path.join(raw, 'manifest.json'))) !== fingerprint) fail('SOURCE_CHANGED_DURING_EXPORT');
    const target = path.join(output, 'exports', manifest.dataset_id);
    await mkdir(path.join(output, 'exports'), { recursive: true });
    const status = await publishDataset(staging, target, manifest);
    if (status === 'DEDUPLICATED') await removeOwned(path.join(output, 'staging'), staging);
    return { status, dataset_id: manifest.dataset_id, directory: path.resolve(target), counts: manifest.counts,
      excluded_snapshots: records.length, removed_observations: parent.tables.sunset_observations.length - tables.sunset_observations.length,
      removed_events: parent.tables.events.length - tables.events.length, validation_scope: 'SOURCE_LINKED', parent_dataset_id: parent.manifest.dataset_id };
  });
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {}, seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (seen.has(flag)) fail('INVALID_ARGUMENTS'); seen.add(flag);
      if (flag === '--acknowledge-exclusions') { options.acknowledge = true; continue; }
      if (!['--raw', '--snapshot-ids', '--output'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
      options[flag.slice(2)] = args[++i];
    }
    if (!options.raw || !options['snapshot-ids']) fail('INVALID_ARGUMENTS');
    console.log(canonicalJson(await excludeReplayFailures(options.raw, options['snapshot-ids'].split(','), options)));
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
}
