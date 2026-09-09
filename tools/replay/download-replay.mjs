#!/usr/bin/env node
/* Authorized offline exporter. It shells out to the user's authenticated
 * Wrangler session; credentials are never accepted as command arguments. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SNAPSHOT_SQL = `SELECT id, event_id, replay_object_key, replay_size_bytes,
 replay_sha256, replay_object_etag, model_version, predicted_score,
 predicted_level, baseline_score, baseline_level, regime_label, regime_strength,
 sky_evolution_state, sky_evolution_factor, gw_factor, comp_sky_canvas,
 comp_horizon, comp_illumination, comp_atmosphere, comp_weather
 FROM prediction_snapshots WHERE replay_status = 'READY'
 ORDER BY submitted_at_epoch, id`;
const GROUND_TRUTH_SQL = `SELECT event_id, rating, rating_label, source,
 confidence, evidence_count FROM sunset_observations ORDER BY submitted_at_epoch, id`;

function parseArgs(args) {
  const result = { database: 'sunset-db', bucket: 'sunsetscore-replay', output: 'dataset', config: null };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--database', '--bucket', '--output', '--config'].includes(name) || !args[index + 1]) {
      throw new Error('Usage: download-replay.mjs [--database name] [--bucket name] [--output dataset] [--config wrangler.toml]');
    }
    result[name.slice(2)] = args[++index];
  }
  if (!/^[a-z0-9_-]{1,64}$/i.test(result.database) || !/^[a-z0-9_-]{1,64}$/i.test(result.bucket)) {
    throw new Error('Database or bucket name is invalid');
  }
  return result;
}

function wrangler(args, config) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const fullArgs = ['wrangler', ...(config ? ['--config', config] : []), ...args];
  const executed = spawnSync(command, fullArgs, { encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  if (executed.status !== 0) throw new Error('Wrangler command failed without exposing remote output');
  return executed.stdout;
}

function d1Rows(database, sql, config) {
  const parsed = JSON.parse(wrangler(['d1', 'execute', database, '--remote', '--json', '--command', sql], config));
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  return blocks.flatMap((block) => block && block.results || block && block.result && block.result[0] && block.result[0].results || []);
}

function csv(rows) {
  if (!rows.length) return '\uFEFF';
  const columns = Object.keys(rows[0]);
  const cell = (value) => {
    if (value == null) return '';
    const text = String(value).replace(/"/g, '""');
    return /[,"\r\n]/.test(text) ? '"' + text + '"' : text;
  };
  return '\uFEFF' + [columns.join(','), ...rows.map((row) => columns.map((name) => cell(row[name])).join(','))].join('\r\n');
}

export function verifyReplay(row, compressedBytes) {
  if (compressedBytes.byteLength !== Number(row.replay_size_bytes)) throw new Error('SIZE_MISMATCH');
  const plain = gunzipSync(compressedBytes);
  const digest = createHash('sha256').update(plain).digest('hex');
  if (digest !== row.replay_sha256) throw new Error('CONTENT_HASH_MISMATCH');
  const replay = JSON.parse(plain.toString('utf8'));
  if (replay.replay_schema_version !== 1 || replay.identity.snapshot_id !== row.id || replay.identity.event_id !== row.event_id) {
    throw new Error('IDENTITY_MISMATCH');
  }
  return replay;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output);
  const replayDir = path.join(output, 'replay');
  const tempDir = path.join(output, '.download');
  await mkdir(replayDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  const snapshots = d1Rows(options.database, SNAPSHOT_SQL, options.config);
  const groundTruth = d1Rows(options.database, GROUND_TRUTH_SQL, options.config);
  const errors = [];
  for (const row of snapshots) {
    const temp = path.join(tempDir, row.id + '.json.gz');
    try {
      wrangler(['r2', 'object', 'get', options.bucket + '/' + row.replay_object_key, '--remote', '--file', temp], options.config);
      const replay = verifyReplay(row, await readFile(temp));
      await writeFile(path.join(replayDir, row.id + '.json'), JSON.stringify(replay, null, 2), 'utf8');
    } catch (error) {
      errors.push({ snapshot_id: row.id, error_code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'DOWNLOAD_FAILED' });
    } finally {
      await rm(temp, { force: true });
    }
  }
  await rm(tempDir, { recursive: true, force: true });
  await writeFile(path.join(output, 'snapshots.csv'), csv(snapshots), 'utf8');
  await writeFile(path.join(output, 'ground_truth.csv'), csv(groundTruth), 'utf8');
  await writeFile(path.join(output, 'errors.json'), JSON.stringify(errors, null, 2), 'utf8');
  console.log(JSON.stringify({ snapshots: snapshots.length, replaySaved: snapshots.length - errors.length, errors: errors.length }));
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
