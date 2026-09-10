#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { runBenchmark } from './benchmark-replay.mjs';
import { SCENARIO_NAMES, verifyDataset } from './verify-production-replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(args) {
  if (!args.length || args[0].startsWith('--')) throw new Error('Usage: phase0-check.mjs <dataset> [--engine-root path]');
  const result = { dataset: args[0], engineRoot: ROOT };
  for (let index = 1; index < args.length; index += 2) {
    if (args[index] !== '--engine-root' || !args[index + 1]) throw new Error('Invalid Phase 0 arguments');
    result.engineRoot = path.resolve(args[index + 1]);
  }
  return result;
}

function runChecks() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['run', 'check'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === 0;
}

export function buildPhase0Report({ checksPassed, verification, benchmark, modelVersion,
  datasetName, generatedAtUtc = new Date().toISOString() }) {
  const scenariosPass = Object.values(verification.scenarioReport)
    .every((scenario) => ['PASS_REAL', 'PASS_FIXTURE_PENDING_REAL'].includes(scenario.status));
  const referencePass = verification.report.total > 0 && verification.report.failed === 0 &&
    verification.report.build_mismatch === 0 && verification.report.passed === verification.report.total;
  const decision = checksPassed && verification.report.download_status === 'PASS' && referencePass &&
    scenariosPass && benchmark.status !== 'FAIL' ? 'GO' : 'NO-GO';
  return {
    generated_at_utc: generatedAtUtc,
    model_version: modelVersion,
    engine_build_sha: verification.report.engine_build_sha,
    replay_schema_version: 1,
    runtime: { node_version: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}` },
    dataset: datasetName,
    check: checksPassed ? 'PASS' : 'FAIL',
    production_download: verification.report.download_status,
    reference_replay: {
      total: verification.report.total,
      build_matched: verification.report.build_matched,
      build_mismatch: verification.report.build_mismatch,
      pass: verification.report.passed,
      failed: verification.report.failed,
      rate: verification.report.pass_rate
    },
    scenario_coverage: Object.fromEntries(Object.entries(verification.scenarioReport)
      .map(([name, scenario]) => [name.toLowerCase(), scenario.status])),
    payload_boundary_test: checksPassed ? 'PASS' : 'FAIL',
    processing_benchmark: benchmark.status,
    state_machine_test: checksPassed ? 'PASS' : 'FAIL',
    security_test: checksPassed ? 'PASS' : 'FAIL',
    failure_count: verification.failures.length,
    decision
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataset = path.resolve(options.dataset);
  const verificationDirectory = path.join(dataset, 'verification');
  await mkdir(verificationDirectory, { recursive: true });

  const checksPassed = runChecks();
  const verification = await verifyDataset(dataset, {
    engineRoot: options.engineRoot,
    fixtureCoverage: checksPassed ? SCENARIO_NAMES : []
  });
  const benchmark = await runBenchmark({ engineBuildSha: verification.report.engine_build_sha });
  await writeFile(path.join(verificationDirectory, 'processing-benchmark.json'),
    JSON.stringify(benchmark, null, 2) + '\n', 'utf8');

  let modelVersion = null;
  try {
    const snapshots = JSON.parse(await readFile(path.join(dataset, 'snapshots.json'), 'utf8'));
    modelVersion = snapshots[0] && snapshots[0].model_version || null;
  } catch { /* verification report carries the failure */ }

  const report = buildPhase0Report({ checksPassed, verification, benchmark, modelVersion,
    datasetName: path.basename(dataset) });
  await writeFile(path.join(verificationDirectory, 'phase0-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(report.decision);
  if (report.decision !== 'GO') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
