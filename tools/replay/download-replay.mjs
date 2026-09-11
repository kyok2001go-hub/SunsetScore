#!/usr/bin/env node
/* Authorized offline exporter. It shells out to the user's authenticated
 * Wrangler session; credentials are never accepted as command arguments. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { wrangler, d1Rows } from '../dataset/lib/wrangler.mjs';
import { validateDownloadedReplay } from '../dataset/lib/replay-integrity.mjs';
export { npxInvocation, compactSql } from '../dataset/lib/wrangler.mjs';
export { verifyReplay, validateDownloadedReplay } from '../dataset/lib/replay-integrity.mjs';

const SNAPSHOT_SQL = `SELECT id, event_id, replay_object_key, replay_size_bytes,
 replay_sha256, replay_object_etag, replay_compression, replay_status, replay_schema_version,
 event_date_local, city, admin1, country, latitude, longitude, timezone,
 sunset_time_utc, prediction_time_utc, snapshot_source, scheduled_slot,
 app_version, model_version, schema_version, dataset_schema_version, asset_revision,
 predicted_score, predicted_level, baseline_score, baseline_level, regime_label, regime_strength,
 sky_evolution_state, sky_evolution_factor, gw_factor, comp_sky_canvas,
 comp_horizon, comp_illumination, comp_atmosphere, comp_weather,
 tile_radar_available, tile_sat_available, open_prob_30m, open_prob_60m, open_prob_120m
 FROM prediction_snapshots WHERE replay_status = 'READY'
 ORDER BY submitted_at_epoch, id`;

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output);
  const replayDir = path.join(output, 'replay');
  const tempDir = path.join(output, '.download');
  await mkdir(replayDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  const snapshots = await d1Rows(options.database, SNAPSHOT_SQL, options.config);
  const errors = [];
  for (const row of snapshots) {
    const temp = path.join(tempDir, row.id + '.json.gz');
    try {
      wrangler(['r2', 'object', 'get', options.bucket + '/' + row.replay_object_key, '--remote', '--file', temp], options.config);
      const replay = await validateDownloadedReplay(row, await readFile(temp));
      await writeFile(path.join(replayDir, row.id + '.json'), JSON.stringify(replay, null, 2), 'utf8');
    } catch (error) {
      errors.push({ snapshot_id: row.id, error_code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'DOWNLOAD_FAILED' });
    } finally {
      await rm(temp, { force: true });
    }
  }
  await rm(tempDir, { recursive: true, force: true });
  await writeFile(path.join(output, 'snapshots.csv'), csv(snapshots), 'utf8');
  await writeFile(path.join(output, 'snapshots.json'), JSON.stringify(snapshots, null, 2), 'utf8');
  await writeFile(path.join(output, 'errors.json'), JSON.stringify(errors, null, 2), 'utf8');
  console.log(JSON.stringify({ snapshots: snapshots.length, replaySaved: snapshots.length - errors.length, errors: errors.length }));
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
