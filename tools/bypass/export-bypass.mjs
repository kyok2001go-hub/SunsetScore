#!/usr/bin/env node
// V2.5.5.9 bypass export (npm run bypass:export): read-only D1 prediction_snapshots + R2 bypass objects → immutable
// local package with a label-free quality report. Never reads Observations. PRD: ref_docs/PRD/V2.5.5.9--旁路对象导出与质量巡检方案.md
import { mkdir, readFile, rename, writeFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalJson, compare, errorCode, fail, hash, inventory, isMain, readSafe, removeOwned, runId, safePath, withLock, writeJson } from '../dataset/lib/common.mjs';
import { writeCsv } from '../dataset/lib/csv.mjs';
import { validDate, canonicalUtc } from '../dataset/dataset-schema.mjs';
import { literal, paginate } from '../dataset/lib/selection.mjs';
import { BYPASS_PACKAGE_VERSION, BYPASS_TOOL_VERSION, DEFAULT_FROM, INDEX_FIELDS, SNAPSHOT_COLUMNS, expectation, indexRow,
  objectKeyFor, payloadFields, verifyObject } from './lib/core.mjs';
import { buildQuality, qualityMarkdown } from './lib/quality.mjs';
import { createBypassSource } from './lib/source.mjs';

const ENUMS = { snapshot_sources: ['github_schedule', 'github_manual', 'user_feedback'] };
const LIST_FLAGS = { '--city': 'cities', '--snapshot-source': 'snapshot_sources', '--scheduled-slot': 'scheduled_slots' };

function todayShanghai(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

export function parseArgs(args, now = Date.now()) {
  const options = { database: 'sunset-db', bucket: 'sunsetscore-replay', output: path.resolve('dataset'), config: null,
    cutoff: null, refresh: false, quiet: false, maxMinutes: 50 };
  const selection = { event_date_from: DEFAULT_FROM, event_date_to: todayShanghai(now), cities: null, snapshot_sources: null, scheduled_slots: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) fail('DUPLICATE_ARGUMENT');
    seen.add(flag);
    if (flag === '--refresh') { options.refresh = true; continue; }
    if (flag === '--quiet') { options.quiet = true; continue; }
    if (![...Object.keys(LIST_FLAGS), '--from', '--to', '--cutoff', '--output', '--database', '--bucket', '--config', '--max-minutes'].includes(flag)) fail('INVALID_ARGUMENTS');
    const value = args[++i];
    if (!value || value.startsWith('--') || /[\x00-\x1f]/.test(value)) fail('INVALID_ARGUMENTS');
    if (LIST_FLAGS[flag]) {
      const key = LIST_FLAGS[flag], values = [...new Set(value.split(',').map(x => x.trim()))].sort(compare);
      if (values.length > 100 || values.some(x => !x || x.length > 100)) fail('INVALID_FILTER');
      if (ENUMS[key] && values.some(x => !ENUMS[key].includes(x))) fail('INVALID_FILTER');
      if (key === 'scheduled_slots' && values.some(x => !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(x))) fail('INVALID_FILTER');
      selection[key] = values;
    } else if (flag === '--from') selection.event_date_from = value;
    else if (flag === '--to') selection.event_date_to = value;
    else if (flag === '--max-minutes') {
      options.maxMinutes = Number(value);
      if (!Number.isInteger(options.maxMinutes) || options.maxMinutes < 1 || options.maxMinutes > 600) fail('INVALID_ARGUMENTS');
    } else options[flag.slice(2)] = value;
  }
  if (!validDate(selection.event_date_from) || !validDate(selection.event_date_to) || selection.event_date_from > selection.event_date_to) fail('INVALID_DATE_RANGE');
  for (const key of ['database', 'bucket']) if (!/^[a-z0-9_-]{1,64}$/i.test(options[key])) fail('INVALID_RESOURCE_NAME');
  if (options.cutoff !== null) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(options.cutoff) || !Number.isFinite(Date.parse(options.cutoff))) fail('INVALID_CUTOFF');
    options.cutoff = new Date(options.cutoff).toISOString();
  }
  options.output = path.resolve(options.output);
  return { ...options, selection };
}

const list = (column, values) => values ? `${column} COLLATE BINARY IN (${values.map(literal).join(',')})` : '1=1';
export function snapshotCondition(selection, cutoff) {
  return [`event_date_local >= ${literal(selection.event_date_from)}`, `event_date_local <= ${literal(selection.event_date_to)}`,
    `submitted_at_epoch <= ${cutoff}`, "replay_status = 'READY'", list('city', selection.cities),
    list('snapshot_source', selection.snapshot_sources), list('scheduled_slot', selection.scheduled_slots)].join(' AND ');
}

async function readSnapshots(source, selection, cutoff, pageSize, metrics) {
  const rows = await paginate(source.query.bind(source), 'prediction_snapshots', SNAPSHOT_COLUMNS, snapshotCondition(selection, cutoff), pageSize, metrics);
  return rows.filter(row => {
    if (!canonicalUtc(row.replay_saved_at_utc)) fail('REPLAY_READY_TIME_INVALID', { entity_id: row.id });
    return Date.parse(row.replay_saved_at_utc) <= cutoff;
  });
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function exporterCommit() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const sha = String(spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

// Cached bytes are re-verified on every use; a cache entry that no longer verifies is downloaded again once.
async function fetchVerified(row, source, cacheDir, refresh) {
  const key = objectKeyFor(row), cacheFile = path.join(cacheDir, hash(key) + '.json.gz');
  if (!refresh && await exists(cacheFile)) {
    const bytes = await readSafe(cacheFile);
    try { return { status: 'FOUND', bytes, verified: verifyObject(row, bytes), cached: true }; } catch { /* fall through */ }
  }
  const got = await source.getObject(key);
  if (got.status === 'MISSING') return { status: 'MISSING' };
  const verified = verifyObject(row, got.bytes);
  await writeFile(cacheFile + '.tmp', got.bytes);
  await rename(cacheFile + '.tmp', cacheFile);
  return { status: 'FOUND', bytes: got.bytes, verified, cached: false };
}

async function runExport(options, dependencies = {}) {
  const log = options.quiet ? () => {} : (dependencies.log || (text => process.stderr.write(text + '\n')));
  const root = await safePath(path.join(options.output, 'bypass')), id = runId();
  const staging = path.join(root, 'staging', id), temp = path.join(staging, '.download'), cacheDir = path.join(root, 'cache');
  await mkdir(temp, { recursive: true }); await mkdir(cacheDir, { recursive: true });
  const source = dependencies.source || createBypassSource(options, temp);
  const started = Date.now(), deadline = started + options.maxMinutes * 60_000, clock = dependencies.now || Date.now;
  const metrics = [], pageSize = dependencies.pageSize ?? 1000;
  try {
    const serverTime = await source.query("SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 AS cutoff_epoch");
    const now = serverTime?.[0]?.cutoff_epoch;
    if (!Number.isSafeInteger(now) || now < 0) fail('D1_TIME_INVALID');
    const cutoff = options.cutoff ? Date.parse(options.cutoff) : now;
    if (cutoff > now) fail('INVALID_CUTOFF');
    log('读取 Snapshot（只读 prediction_snapshots）');
    const snapshots = await readSnapshots(source, options.selection, cutoff, pageSize, metrics);
    if (!snapshots.length) fail('EMPTY_SELECTION');
    await mkdir(path.join(staging, 'objects'), { recursive: true });
    const index = [], payloads = new Map(), errors = [];
    let downloads = 0, hits = 0, done = 0;
    const expected = snapshots.filter(row => expectation(row) === 'EXPECTED').length;
    for (const row of snapshots) {
      if (expectation(row) !== 'EXPECTED') { index.push(indexRow(row, {})); continue; }
      if (clock() > deadline) fail('BYPASS_EXPORT_TIMEOUT');
      let fields;
      try {
        const got = await fetchVerified(row, source, cacheDir, options.refresh);
        if (got.status === 'MISSING') fields = { object_status: 'MISSING' };
        else {
          if (got.cached) hits++; else downloads++;
          const local = `objects/${row.id}.json.gz`;
          await writeFile(path.join(staging, local), got.verified.packageBytes, { flag: 'wx' });
          payloads.set(row.id, got.verified.payload);
          fields = { object_status: 'VALID', compressed_bytes: got.verified.packageBytes.length, uncompressed_bytes: got.verified.uncompressedBytes,
            content_sha256: got.verified.contentSha256, local_path: local, ...payloadFields(got.verified.payload) };
        }
      } catch (error) {
        const code = errorCode(error);
        if (code === 'BYPASS_EXPORT_TIMEOUT') throw error;
        fields = { object_status: code === 'DOWNLOAD_FAILED' ? 'DOWNLOAD_FAILED' : 'INVALID', error_code: code };
        errors.push({ snapshot_id: row.id, error_code: code, detail: error.detail || '' });
      }
      index.push(indexRow(row, fields));
      if (++done % 25 === 0 || done === expected) log(`旁路对象 ${done}/${expected}，缓存 ${hits}，下载 ${downloads}`);
    }
    // The source must not change while we read it (same rule as the Raw export).
    const again = await readSnapshots(source, options.selection, cutoff, pageSize, metrics);
    if (canonicalJson(again) !== canonicalJson(snapshots)) fail('SOURCE_CHANGED_DURING_EXPORT');
    index.sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
    const indexCsv = writeCsv(INDEX_FIELDS, index);
    await writeFile(path.join(staging, 'index.csv'), indexCsv, { flag: 'wx' });
    const quality = buildQuality(index, payloads);
    await mkdir(path.join(staging, 'reports'));
    await writeJson(path.join(staging, 'reports/quality.json'), quality);
    await writeJson(path.join(staging, 'reports/errors.json'), errors.sort((a, b) => compare(a.snapshot_id, b.snapshot_id)));
    const descriptor = { bypass_package_version: BYPASS_PACKAGE_VERSION, tool_version: BYPASS_TOOL_VERSION,
      selection: options.selection, cutoff_utc: new Date(cutoff).toISOString(), index_sha256: hash(indexCsv) };
    const descriptorSha = hash(canonicalJson(descriptor)), datasetId = `bypass_v1_${descriptorSha.slice(0, 16)}`;
    const manifestBase = { bypass_dataset_id: datasetId, descriptor, descriptor_sha256: descriptorSha };
    await writeFile(path.join(staging, 'reports/quality.md'), qualityMarkdown(quality, manifestBase), { flag: 'wx' });
    await removeOwned(staging, temp);
    const files = {};
    for (const name of await inventory(staging)) files[name] = hash(await readSafe(path.join(staging, name)));
    const counts = { snapshots: index.length, expected, valid: payloads.size,
      missing: index.filter(r => r.object_status === 'MISSING').length, invalid: index.filter(r => r.object_status === 'INVALID').length,
      download_failed: index.filter(r => r.object_status === 'DOWNLOAD_FAILED').length };
    const manifest = { ...manifestBase, created_at_utc: new Date(dependencies.createdAt ?? Date.now()).toISOString(),
      exporter_commit: dependencies.commit === undefined ? exporterCommit() : dependencies.commit, counts, files };
    await writeJson(path.join(staging, 'manifest.json'), manifest);
    const destination = path.join(root, 'exports', datasetId);
    await mkdir(path.join(root, 'exports'), { recursive: true });
    const status = await withLock(`${destination}.lock`, async () => {
      if (await exists(destination)) {
        const current = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
        if (current.descriptor_sha256 !== descriptorSha) fail('BYPASS_DATASET_ID_CONFLICT');
        return 'DEDUPLICATED';
      }
      await rename(staging, destination);
      return 'EXPORTED';
    });
    if (status === 'DEDUPLICATED') await removeOwned(path.join(root, 'staging'), staging);
    return { status, bypass_dataset_id: datasetId, directory: destination, counts, quality_status: quality.status,
      warnings: quality.warnings.map(w => w.code), cache_hits: hits, downloads, duration_ms: Date.now() - started, query_metrics: metrics };
  } catch (error) {
    await removeOwned(staging, temp).catch(() => {});
    return { status: 'FAIL', error_code: errorCode(error), staging };
  }
}

export async function exportBypass(options, dependencies = {}) {
  return runExport(options, dependencies);
}

if (isMain(import.meta.url)) {
  try {
    const result = await exportBypass(parseArgs(process.argv.slice(2)));
    console.log(canonicalJson(result));
    if (result.status === 'FAIL') process.exitCode = 1;
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
}
