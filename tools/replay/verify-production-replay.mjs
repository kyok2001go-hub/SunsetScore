#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ValidationError } from '../../server/event-dataset.js';
import { validateReplayPayload } from '../../server/replay-schema.js';
import { REPLAY_RUNTIME_FILES, runReplay } from './replay-runner.mjs';

export const SCENARIO_NAMES = Object.freeze([
  'ORDINARY_WEATHER',
  'RAIN_TO_CLEAR',
  'GOLDEN_WINDOW',
  'RADAR_DEGRADED',
  'SATELLITE_DEGRADED',
  'RADAR_SATELLITE_NORMAL'
]);

const DEGRADED_STATUSES = new Set(['FAILED', 'TIMEOUT', 'UNAVAILABLE', 'EMPTY']);

function readGitHead(engineRoot) {
  const result = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', windowsHide: true
  });
  const head = String(result.stdout || '').trim().toLowerCase();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(head)) throw new Error('ENGINE_ROOT_INVALID');
  return head;
}

function assertRuntimeMatchesHead(engineRoot) {
  const result = spawnSync('git', [
    '-C', engineRoot, 'status', '--porcelain', '--untracked-files=all', '--', ...REPLAY_RUNTIME_FILES
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('ENGINE_ROOT_INVALID');
  if (String(result.stdout || '').trim()) throw new Error('ENGINE_ROOT_DIRTY');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function isGoldenWindow(replay) {
  const now = Date.parse(replay.identity && replay.identity.prediction_time_utc);
  const sunset = Date.parse(replay.context && replay.context.sunset_time_utc);
  const config = replay.effective_config && replay.effective_config.goldenWindow;
  const before = config && config.beforeSunsetMinutes;
  const after = config && config.afterSunsetMinutes;
  if (!Number.isFinite(now) || !Number.isFinite(sunset) || !Number.isFinite(before) || !Number.isFinite(after)) return false;
  const minutes = (sunset - now) / 60000;
  return config.enabled !== false && minutes <= before && minutes >= -after;
}

function hasCoverage(source) {
  return !!source && source.available === true && Array.isArray(source.coverage_series) && source.coverage_series.length > 0;
}

export function classifyReplayScenarios(row, replay) {
  const scenarios = new Set();
  const golden = isGoldenWindow(replay);
  if (String(row.regime_label || '').toUpperCase() === 'RAIN_TO_CLEAR') scenarios.add('RAIN_TO_CLEAR');
  else scenarios.add('ORDINARY_WEATHER');
  if (golden) scenarios.add('GOLDEN_WINDOW');
  if (golden && replay.radar && replay.radar.available === false && DEGRADED_STATUSES.has(replay.radar.source_status)) {
    scenarios.add('RADAR_DEGRADED');
  }
  if (golden && replay.satellite && replay.satellite.available === false && DEGRADED_STATUSES.has(replay.satellite.source_status)) {
    scenarios.add('SATELLITE_DEGRADED');
  }
  if (golden && hasCoverage(replay.radar) && hasCoverage(replay.satellite)) {
    scenarios.add('RADAR_SATELLITE_NORMAL');
  }
  return Array.from(scenarios);
}

function stableError(error) {
  const text = String(error && (error.code || error.message) || '');
  if (error instanceof ValidationError || error instanceof SyntaxError) return 'SCHEMA_RESTORE_ERROR';
  if (/CONFIG_MISMATCH|config_hash/.test(text)) return 'CONFIG_MISMATCH';
  if (/ENGINE_VERSION_MISMATCH/.test(text)) return 'ENGINE_VERSION_MISMATCH';
  if (/ENOENT/.test(text)) return 'CAPTURE_MISSING_INPUT';
  if (/JSON|schema|Replay|NWP|identity|context|INVALID_REFERENCE_FIELD/.test(text)) return 'SCHEMA_RESTORE_ERROR';
  return /^[A-Z0-9_]+$/.test(text) ? text : 'UNKNOWN';
}

function buildScenarioReport(evidence, fixtureCoverage) {
  const fixtureSet = new Set(fixtureCoverage || []);
  return Object.fromEntries(SCENARIO_NAMES.map((name) => {
    const records = evidence.get(name) || [];
    const referencePass = records.filter((record) => record.pass).length;
    let status = 'FAIL', source = 'NONE';
    if (records.length) {
      source = 'REAL_PRODUCTION';
      if (referencePass === records.length) status = 'PASS_REAL';
    } else if (fixtureSet.has(name)) {
      source = 'FIXTURE';
      status = 'PASS_FIXTURE_PENDING_REAL';
    }
    return [name, {
      count: records.length,
      reference_pass: referencePass,
      fixture_pass: fixtureSet.has(name),
      evidence: source,
      status,
      snapshot_ids: records.map((record) => record.snapshot_id)
    }];
  }));
}

export async function verifyDataset(datasetDirectory, options = {}) {
  const dataset = path.resolve(datasetDirectory);
  const engineRoot = path.resolve(options.engineRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const engineBuildSha = readGitHead(engineRoot);
  assertRuntimeMatchesHead(engineRoot);
  const verificationDirectory = path.join(dataset, 'verification');
  await mkdir(verificationDirectory, { recursive: true });

  let snapshots = [];
  let downloadErrors = [];
  const failures = [];
  try {
    snapshots = await readJson(path.join(dataset, 'snapshots.json'));
    if (!Array.isArray(snapshots)) throw new Error('SNAPSHOT_MANIFEST_INVALID');
  } catch (error) {
    failures.push({ snapshot_id: null, event_id: null, error_code: stableError(error) });
  }
  try {
    downloadErrors = await readJson(path.join(dataset, 'errors.json'));
    if (!Array.isArray(downloadErrors)) throw new Error('DOWNLOAD_MANIFEST_INVALID');
  } catch (error) {
    downloadErrors = [{ snapshot_id: null, error_code: stableError(error) }];
  }
  for (const error of downloadErrors) {
    failures.push({ snapshot_id: error.snapshot_id || null, event_id: null,
      error_code: error.error_code || 'DOWNLOAD_FAILED' });
  }

  const records = [];
  const evidence = new Map(SCENARIO_NAMES.map((name) => [name, []]));
  let buildMatched = 0;
  let buildMismatch = 0;
  for (const row of snapshots) {
    const record = { snapshot_id: row && row.id || null, event_id: row && row.event_id || null,
      pass: false, error_code: null, scenarios: [] };
    try {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('SNAPSHOT_MANIFEST_INVALID');
      const replay = await validateReplayPayload(await readJson(path.join(dataset, 'replay', row.id + '.json')), row);
      if (replay.identity.engine_build_sha !== engineBuildSha) {
        buildMismatch += 1;
        throw new Error('ENGINE_VERSION_MISMATCH');
      }
      buildMatched += 1;
      record.scenarios = classifyReplayScenarios(row, replay);
      const result = await runReplay(replay, { reference: row, engineRoot });
      record.pass = result.pass === true;
      record.deltas = result.deltas;
      record.comparison_errors = result.comparison_errors;
      if (!record.pass) record.error_code = result.comparison_errors && result.comparison_errors.length
        ? 'SCHEMA_RESTORE_ERROR' : 'NUMERIC_DRIFT';
      for (const scenario of record.scenarios) evidence.get(scenario).push(record);
    } catch (error) {
      record.error_code = record.error_code || stableError(error);
    }
    if (!record.pass) failures.push({ snapshot_id: record.snapshot_id, event_id: record.event_id,
      error_code: record.error_code || 'UNKNOWN' });
    records.push(record);
  }

  const passed = records.filter((record) => record.pass).length;
  const downloadComplete = snapshots.length > 0 && downloadErrors.length === 0 &&
    records.every((record) => record.error_code !== 'CAPTURE_MISSING_INPUT');
  const report = {
    generated_at_utc: new Date().toISOString(),
    dataset: path.basename(dataset),
    engine_root: engineRoot,
    engine_build_sha: engineBuildSha,
    engine_runtime_clean: true,
    download_status: downloadComplete ? 'PASS' : 'FAIL',
    total: snapshots.length,
    build_matched: buildMatched,
    build_mismatch: buildMismatch,
    passed,
    failed: snapshots.length - passed,
    pass_rate: snapshots.length ? passed / snapshots.length : 0,
    records
  };
  const scenarioReport = buildScenarioReport(evidence, options.fixtureCoverage);
  await Promise.all([
    writeFile(path.join(verificationDirectory, 'replay-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'),
    writeFile(path.join(verificationDirectory, 'scenario-coverage.json'), JSON.stringify(scenarioReport, null, 2) + '\n', 'utf8'),
    writeFile(path.join(verificationDirectory, 'failures.json'), JSON.stringify(failures, null, 2) + '\n', 'utf8')
  ]);
  return { report, scenarioReport, failures, verificationDirectory };
}

function parseArgs(args) {
  if (!args.length || args[0].startsWith('--')) throw new Error('Usage: verify-production-replay.mjs <dataset> [--engine-root path]');
  const result = { dataset: args[0], engineRoot: null };
  for (let index = 1; index < args.length; index += 2) {
    if (args[index] !== '--engine-root' || !args[index + 1]) throw new Error('Invalid verifier arguments');
    result.engineRoot = args[index + 1];
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await verifyDataset(options.dataset, { engineRoot: options.engineRoot });
  console.log(JSON.stringify({
    total: result.report.total,
    passed: result.report.passed,
    failed: result.report.failed,
    build_mismatch: result.report.build_mismatch,
    download_status: result.report.download_status
  }));
  if (result.report.download_status !== 'PASS' || result.report.failed || result.report.build_mismatch ||
      Object.values(result.scenarioReport).some((scenario) => scenario.status === 'FAIL')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(stableError(error)); process.exitCode = 1; });
}
