const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function head() {
  const result = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  return result.stdout.trim();
}

test('scenario classification requires Replay source state, not tile flags alone', async () => {
  const { createSizedReplay, snapshotRowForReplay } = await import('../tools/replay/replay-fixture.mjs');
  const { classifyReplayScenarios } = await import('../tools/replay/verify-production-replay.mjs');
  const replay = await createSizedReplay(100 * 1024);
  replay.identity.prediction_time_utc = '2026-09-09T10:00:00.000Z';
  const row = snapshotRowForReplay(replay, { regime_label: 'CLEAR' });
  let scenarios = classifyReplayScenarios(row, replay);
  assert.ok(scenarios.includes('GOLDEN_WINDOW'));
  assert.ok(!scenarios.includes('RADAR_DEGRADED'));
  replay.radar.source_status = 'FAILED';
  scenarios = classifyReplayScenarios(row, replay);
  assert.ok(scenarios.includes('RADAR_DEGRADED'));
  replay.radar = { available: true, source: 'fixture', source_status: 'OK', layer: null,
    coverage_series: [{ t: Date.parse(replay.identity.prediction_time_utc), pct: 10 }] };
  replay.satellite = { available: true, source: 'fixture', source_status: 'OK', layer: 'fixture',
    coverage_series: [{ t: Date.parse(replay.identity.prediction_time_utc), pct: 20 }] };
  scenarios = classifyReplayScenarios(row, replay);
  assert.ok(scenarios.includes('RADAR_SATELLITE_NORMAL'));
});

test('batch verifier enforces the exact Engine Root SHA and writes sanitized reports', async () => {
  const schema = await import('../server/replay-schema.js');
  const { runReplay } = await import('../tools/replay/replay-runner.mjs');
  const { createSizedReplay, snapshotRowForReplay } = await import('../tools/replay/replay-fixture.mjs');
  const { SCENARIO_NAMES, verifyDataset } = await import('../tools/replay/verify-production-replay.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sunsetscore-phase0-'));
  try {
    await mkdir(path.join(directory, 'replay'), { recursive: true });
    const replay = await createSizedReplay(100 * 1024, { engineBuildSha: head() });
    const actual = (await runReplay(replay, { engineRoot: ROOT })).actual;
    const row = snapshotRowForReplay(replay, actual);
    await writeFile(path.join(directory, 'snapshots.json'), JSON.stringify([row]), 'utf8');
    await writeFile(path.join(directory, 'errors.json'), '[]', 'utf8');
    await writeFile(path.join(directory, 'replay', row.id + '.json'), schema.canonicalJson(replay), 'utf8');
    const verified = await verifyDataset(directory, { engineRoot: ROOT, fixtureCoverage: SCENARIO_NAMES });
    assert.equal(verified.report.download_status, 'PASS');
    assert.equal(verified.report.build_matched, 1);
    assert.equal(verified.report.passed, 1);
    assert.equal(verified.failures.length, 0);
    assert.equal(verified.scenarioReport.ORDINARY_WEATHER.status, 'PASS_REAL');
    assert.equal(verified.scenarioReport.RAIN_TO_CLEAR.status, 'PASS_FIXTURE_PENDING_REAL');
    const persisted = JSON.parse(await readFile(path.join(directory, 'verification', 'replay-report.json'), 'utf8'));
    assert.equal(persisted.records[0].pass, true);
    assert.equal(JSON.stringify(persisted).includes('effective_config'), false);

    const mismatch = structuredClone(replay);
    mismatch.identity.engine_build_sha = 'b'.repeat(40);
    await writeFile(path.join(directory, 'replay', row.id + '.json'), schema.canonicalJson(mismatch), 'utf8');
    const rejected = await verifyDataset(directory, { engineRoot: ROOT, fixtureCoverage: SCENARIO_NAMES });
    assert.equal(rejected.report.build_mismatch, 1);
    assert.equal(rejected.report.passed, 0);
    assert.equal(rejected.failures[0].error_code, 'ENGINE_VERSION_MISMATCH');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Phase 0 report only returns GO when every independent gate passes', async () => {
  const { buildPhase0Report, npmInvocation } = await import('../tools/replay/phase0-check.mjs');
  const invocation = npmInvocation(['run', 'check'], {
    platform: 'win32', nodeExecutable: 'C:\\nodejs\\node.exe',
    npmExecPath: null,
    exists: () => true
  });
  assert.deepEqual(invocation, {
    command: 'C:\\nodejs\\node.exe',
    args: ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'check']
  });
  const scenarioReport = Object.fromEntries([
    'ORDINARY_WEATHER', 'RAIN_TO_CLEAR', 'GOLDEN_WINDOW', 'RADAR_DEGRADED',
    'SATELLITE_DEGRADED', 'RADAR_SATELLITE_NORMAL'
  ].map((name) => [name, { status: 'PASS_FIXTURE_PENDING_REAL' }]));
  const verification = {
    report: { engine_build_sha: 'a'.repeat(40), download_status: 'PASS', total: 1,
      build_matched: 1, build_mismatch: 0, passed: 1, failed: 0, pass_rate: 1 },
    scenarioReport,
    failures: []
  };
  const input = { checksPassed: true, verification, benchmark: { status: 'MEASURED' },
    modelVersion: '2.4.6', datasetName: 'fixture', generatedAtUtc: '2026-09-10T00:00:00.000Z' };
  assert.equal(buildPhase0Report(input).decision, 'GO');
  assert.equal(buildPhase0Report({ ...input, verification: {
    ...verification, report: { ...verification.report, build_mismatch: 1 }
  } }).decision, 'NO-GO');
  assert.equal(buildPhase0Report({ ...input, benchmark: { status: 'FAIL' } }).decision, 'NO-GO');
});
