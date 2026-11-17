#!/usr/bin/env node
// V2.5.5.9 offline check of a bypass package
// (npm run bypass:validate -- <package> [--raw <Raw package>] [--report-dir <directory outside the package>]).
// Re-verifies every object and the quality report (recomputed with the report's own quality_version; v1 has none);
// with --raw, reports the join on snapshot_id + replay_sha256 using the Raw package's replay_index, and (V2.5.5.15)
// the satellite vs NWP single-level mid/high cloud contrast from the matched Replays. Never reads Observations.
// Exit 1 only on integrity failures.
import path from 'node:path';
import { canonicalJson, compare, errorCode, fail, hash, isMain, readJson, readSafe, reportOutside, safePath, within } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { datasetSchema } from '../dataset/dataset-schema.mjs';
import { buildQuality } from './lib/quality.mjs';
import { openBypassPackage } from './lib/read-bypass.mjs';
import { singleLevelContrast } from './lib/nwp-contrast.mjs';

export function parseArgs(args) {
  if (!args[0] || args[0].startsWith('--') || args.length % 2 !== 1) fail('INVALID_ARGUMENTS');
  const options = { dataset: path.resolve(args[0]), raw: null, reportDir: null };
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1], key = { '--raw': 'raw', '--report-dir': 'reportDir' }[flag];
    if (!key || options[key] !== null || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    options[key] = path.resolve(value);
  }
  return options;
}

// The Raw package is checked by its own validator; here a missing or altered Replay is counted, not fatal.
async function readRawReplay(directory, row) {
  const file = await safePath(path.join(directory, row.local_path));
  if (!within(directory, file)) fail('UNSAFE_PATH');
  let bytes;
  try { bytes = await readSafe(file); } catch (error) { if (error.code === 'ENOENT') return { status: 'MISSING' }; throw error; }
  if (hash(bytes) !== row.replay_sha256) return { status: 'HASH_MISMATCH' };
  return { status: 'OK', replay: JSON.parse(bytes.toString('utf8')) };
}

async function rawReplayIndex(directory) {
  const manifest = await readJson(path.join(directory, 'manifest.json'));
  const fields = datasetSchema(!!manifest?.descriptor?.selection?.include_comments).tables.replay_index;
  return readCsv(fields, await readSafe(path.join(directory, 'raw/replay_index.csv')));
}

export function joinReport(index, rawRows) {
  const raw = new Map(rawRows.map(row => [row.snapshot_id, row])), own = new Map(index.map(row => [row.snapshot_id, row]));
  const result = { matched: 0, matched_valid: 0, replay_sha256_mismatch: [], bypass_only: [], raw_only: [] };
  for (const row of index) {
    const other = raw.get(row.snapshot_id);
    if (!other) { result.bypass_only.push(row.snapshot_id); continue; }
    if (other.replay_sha256 !== row.replay_sha256) { result.replay_sha256_mismatch.push(row.snapshot_id); continue; }
    result.matched++;
    if (row.object_status === 'VALID') result.matched_valid++;
  }
  for (const id of raw.keys()) if (!own.has(id)) result.raw_only.push(id);
  for (const key of ['replay_sha256_mismatch', 'bypass_only', 'raw_only']) result[key].sort(compare);
  return result;
}

export async function validateBypass(options) {
  const pkg = await openBypassPackage(options.dataset), payloads = new Map();
  for (const row of pkg.index) if (row.object_status === 'VALID') payloads.set(row.snapshot_id, await pkg.read(row.snapshot_id));
  const stored = await readJson(path.join(pkg.root, 'reports/quality.json')), version = stored?.quality_version ?? 1;
  const quality = buildQuality(pkg.index, payloads, version);
  if (canonicalJson(quality) !== canonicalJson(stored)) fail('BYPASS_QUALITY_REPORT_MISMATCH');
  const result = { status: 'PASS', bypass_dataset_id: pkg.manifest.bypass_dataset_id, counts: pkg.manifest.counts,
    verified_objects: payloads.size, quality_version: version, quality_status: quality.status };
  if (options.raw) {
    const rawRows = await rawReplayIndex(options.raw), byId = new Map(rawRows.map(row => [row.snapshot_id, row]));
    result.raw_join = joinReport(pkg.index, rawRows);
    const items = [], unavailable = { MISSING: 0, HASH_MISMATCH: 0 };
    for (const row of pkg.index) {
      const other = byId.get(row.snapshot_id);
      if (row.object_status !== 'VALID' || !other || other.replay_sha256 !== row.replay_sha256) continue;
      const got = await readRawReplay(options.raw, other);
      if (got.status === 'OK') items.push({ payload: payloads.get(row.snapshot_id), replay: got.replay }); else unavailable[got.status]++;
    }
    result.nwp_single_level_contrast = { ...singleLevelContrast(items), replay_missing: unavailable.MISSING, replay_hash_mismatch: unavailable.HASH_MISMATCH };
  }
  if (options.reportDir) await reportOutside(pkg.root, options.reportDir, `bypass-validate-${pkg.manifest.bypass_dataset_id}.json`, result);
  return result;
}

if (isMain(import.meta.url)) {
  try { console.log(canonicalJson(await validateBypass(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(error) })); process.exitCode = 1; }
}
