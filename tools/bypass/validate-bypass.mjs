#!/usr/bin/env node
// V2.5.5.9 offline check of a bypass package (npm run bypass:validate -- <package> [--raw <Raw package>]).
// Re-verifies every object and the quality report; with --raw, reports the join on snapshot_id + replay_sha256
// using only the Raw package's replay_index (never Observations). Exit 1 only on integrity failures.
import path from 'node:path';
import { canonicalJson, compare, errorCode, fail, isMain, readJson, readSafe } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { datasetSchema } from '../dataset/dataset-schema.mjs';
import { buildQuality } from './lib/quality.mjs';
import { openBypassPackage } from './lib/read-bypass.mjs';

export function parseArgs(args) {
  if (!args[0] || args[0].startsWith('--') || ![1, 3].includes(args.length) || (args.length === 3 && (args[1] !== '--raw' || !args[2]))) fail('INVALID_ARGUMENTS');
  return { dataset: path.resolve(args[0]), raw: args[2] ? path.resolve(args[2]) : null };
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
  const quality = buildQuality(pkg.index, payloads);
  if (canonicalJson(quality) !== canonicalJson(await readJson(path.join(pkg.root, 'reports/quality.json')))) fail('BYPASS_QUALITY_REPORT_MISMATCH');
  const result = { status: 'PASS', bypass_dataset_id: pkg.manifest.bypass_dataset_id, counts: pkg.manifest.counts,
    verified_objects: payloads.size, quality_status: quality.status };
  if (options.raw) result.raw_join = joinReport(pkg.index, await rawReplayIndex(options.raw));
  return result;
}

if (isMain(import.meta.url)) {
  try { console.log(canonicalJson(await validateBypass(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(error) })); process.exitCode = 1; }
}
