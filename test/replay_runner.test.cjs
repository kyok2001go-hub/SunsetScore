const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { createRuntime, load, forecast } = require('./helpers.cjs');

const FILES = [
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/vendor/suncalc.js', 'js/solar.js', 'js/baseline.js', 'js/cache.js', 'js/data.js',
  'js/city_search.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js', 'js/sky_state.js',
  'js/engine.js', 'js/sampling.js', 'js/corridor.js', 'js/nowcast.js', 'js/evolution.js',
  'js/replay_service.js', 'js/prediction_service.js'
];

async function capture(spec) {
  const values = spec.values || spec;
  const SS = load(createRuntime(), FILES);
  const fc = forecast(values);
  fc.timezone = 'Asia/Shanghai';
  fc.utc_offset_seconds = 28800;
  SS.data.fetchForecastWithRetry = async () => fc;
  SS.data.fetchAirQuality = async () => null;
  SS.data.gather = async (nodes) => ({ samples: nodes.map((point) => ({ point, forecast: fc })), successCount: nodes.length });
  if (spec.radarEnabled === false) SS.modelConfig.nowcast.radar.enabled = false;
  if (spec.satelliteEnabled === false) SS.modelConfig.nowcast.satellite.enabled = false;
  const nowUtcMs = spec.nowUtcMs || Date.parse('2026-08-26T02:00:00Z');
  if (spec.rainToClear) {
    SS.nowcast.fetchMinutePrecip = async () => ({
      times: Array.from({ length: 24 }, (_, index) => nowUtcMs + index * 300000),
      precipitation: Array.from({ length: 24 }, (_, index) => index < 4 ? 0.18 : 0),
      stepMs: 300000, intervalAnchor: 'interval_start', source: 'qweather'
    });
  }
  const result = await SS.prediction.predict('31.23,121.47', {
    nowUtcMs, captureReplay: true
  });
  return { replay: result.replay_payload, reference: {
    predicted_score: result.score, predicted_level: result.level,
    baseline_score: result.baseline_score, baseline_level: result.baseline_level,
    regime_label: result.regime_label, regime_strength: result.regime_state && result.regime_state.strength,
    sky_evolution_state: result.all_day_sky_state && result.all_day_sky_state.state,
    sky_evolution_factor: result.sky_evolution_factor,
    gw_factor: result.sky_evolution && result.sky_evolution.gwFactor != null ? result.sky_evolution.gwFactor : 1,
    comp_sky_canvas: result.components.sky_canvas, comp_horizon: result.components.horizon,
    comp_illumination: result.components.illumination, comp_atmosphere: result.components.atmosphere,
    comp_weather: result.components.weather
  } };
}

test('offline Replay Runner reproduces the seven required golden scenario classes', async () => {
  const { runReplay } = await import('../tools/replay/replay-runner.mjs');
  const cases = [
    { name: 'CLEAR', values: { cloud: 8, low: 2, mid: 4, high: 10, visibility: 30000 } },
    { name: 'PARTLY_CLOUDY', values: { cloud: 48, low: 18, mid: 44, high: 62, visibility: 22000 } },
    { name: 'OVERCAST', values: { cloud: 96, low: 92, mid: 85, high: 50, visibility: 6000 } },
    { name: 'RAIN_TO_CLEAR', values: { cloud: 70, low: 55, mid: 48, high: 60 },
      nowUtcMs: Date.parse('2026-08-26T10:00:00Z'), rainToClear: true },
    { name: 'GOLDEN_WINDOW', values: { cloud: 55, low: 15, mid: 45, high: 72 },
      nowUtcMs: Date.parse('2026-08-26T10:00:00Z') },
    { name: 'RADAR_DEGRADED', values: { cloud: 52, low: 20, mid: 42, high: 68 },
      nowUtcMs: Date.parse('2026-08-26T10:00:00Z'), radarEnabled: false },
    { name: 'SATELLITE_DEGRADED', values: { cloud: 52, low: 20, mid: 42, high: 68 },
      nowUtcMs: Date.parse('2026-08-26T10:00:00Z'), satelliteEnabled: false }
  ];
  for (const spec of cases) {
    const fixture = await capture(spec);
    const report = await runReplay(fixture.replay, { reference: fixture.reference });
    assert.equal(report.pass, true, spec.name + ': ' + JSON.stringify(report));
    assert.ok(Math.abs(report.deltas.score) <= 1);
    assert.ok(report.deltas.components && Object.values(report.deltas.components).every((value) => value == null || Math.abs(value) <= 1));
    if (spec.name === 'RADAR_DEGRADED') {
      assert.equal(fixture.replay.radar.available, false);
      assert.equal(fixture.replay.radar.source_status, 'DISABLED');
    }
    if (spec.name === 'SATELLITE_DEGRADED') {
      assert.equal(fixture.replay.satellite.available, false);
      assert.equal(fixture.replay.satellite.source_status, 'DISABLED');
    }
  }
});

test('strict Reference comparison rejects missing fields and normalizes off-window GW factor', async () => {
  const { runReplay } = await import('../tools/replay/replay-runner.mjs');
  const fixture = await capture({ values: { cloud: 48, low: 18, mid: 44, high: 62 } });
  const strict = await runReplay(fixture.replay, { reference: fixture.reference });
  assert.equal(strict.actual.gw_factor, 1);
  assert.equal(strict.deltas.gw_factor, 0);
  const incomplete = { ...fixture.reference, baseline_level: null };
  const failed = await runReplay(fixture.replay, { reference: incomplete });
  assert.equal(failed.pass, false);
  assert.ok(failed.comparison_errors.includes('INVALID_REFERENCE_FIELD:baseline_level'));
});

test('fixed Radar and Satellite coverage fixture exercises the normal visual-source branch', async () => {
  const { runReplay } = await import('../tools/replay/replay-runner.mjs');
  const fixture = await capture({ values: { cloud: 55, low: 15, mid: 45, high: 72 },
    nowUtcMs: Date.parse('2026-08-26T10:00:00Z') });
  const now = Date.parse(fixture.replay.identity.prediction_time_utc);
  fixture.replay.radar = { available: true, source: 'fixture-radar', source_status: 'OK', layer: null,
    coverage_series: [{ t: now - 600000, pct: 35 }, { t: now, pct: 20 }] };
  fixture.replay.satellite = { available: true, source: 'fixture-satellite', source_status: 'OK', layer: 'fixture',
    coverage_series: [{ t: now - 600000, pct: 48 }, { t: now, pct: 42 }] };
  const first = await runReplay(fixture.replay);
  const actual = first.actual;
  const reference = {
    predicted_score: actual.score, predicted_level: actual.level,
    baseline_score: actual.baseline_score, baseline_level: actual.baseline_level,
    regime_label: actual.regime_label, regime_strength: actual.regime_strength,
    sky_evolution_state: actual.sky_evolution_state, sky_evolution_factor: actual.sky_evolution_factor,
    gw_factor: actual.gw_factor,
    comp_sky_canvas: actual.components.sky_canvas, comp_horizon: actual.components.horizon,
    comp_illumination: actual.components.illumination, comp_atmosphere: actual.components.atmosphere,
    comp_weather: actual.components.weather
  };
  assert.equal((await runReplay(fixture.replay, { reference })).pass, true);
});

test('candidate config override produces an explicit comparison report', async () => {
  const { runReplay } = await import('../tools/replay/replay-runner.mjs');
  const fixture = await capture({ values: { cloud: 48, low: 18, mid: 44, high: 62 } });
  const report = await runReplay(fixture.replay, { reference: fixture.reference,
    configOverride: { scoring: { highCloudCenter: 5 } } });
  assert.equal(typeof report.pass, 'boolean');
  assert.equal(typeof report.actual.score, 'number');
  assert.equal(typeof report.reference.score, 'number');
  assert.equal(typeof report.deltas.score, 'number');
});

test('authorized Replay download verifies size, hash and identity before saving', async () => {
  const { verifyReplay } = await import('../tools/replay/download-replay.mjs');
  const replay = {
    replay_schema_version: 1,
    identity: { snapshot_id: 'snap_verify', event_id: 'event_verify' }
  };
  const plain = Buffer.from(JSON.stringify(replay));
  const compressed = gzipSync(plain);
  const row = {
    id: 'snap_verify', event_id: 'event_verify', replay_size_bytes: compressed.byteLength,
    replay_sha256: createHash('sha256').update(plain).digest('hex'), replay_schema_version: 1,
    replay_status: 'READY', replay_compression: 'gzip', replay_object_key: 'replay/v1/snap_verify.json.gz'
  };
  assert.deepEqual(verifyReplay(row, compressed), replay);
  assert.throws(() => verifyReplay({ ...row, replay_size_bytes: compressed.byteLength + 1 }, compressed), /SIZE_MISMATCH/);
  assert.throws(() => verifyReplay({ ...row, replay_sha256: '0'.repeat(64) }, compressed), /CONTENT_HASH_MISMATCH/);
  assert.throws(() => verifyReplay({ ...row, event_id: 'other_event' }, compressed), /IDENTITY_MISMATCH/);
  assert.throws(() => verifyReplay({ ...row, replay_compression: null }, compressed), /REPLAY_METADATA_INVALID/);
});

test('authorized Replay download validates schema and effective config hash', async () => {
  const schema = await import('../server/replay-schema.js');
  const { validateDownloadedReplay } = await import('../tools/replay/download-replay.mjs');
  const { createSizedReplay, snapshotRowForReplay } = await import('../tools/replay/replay-fixture.mjs');
  const replay = await createSizedReplay(100 * 1024);
  const row = snapshotRowForReplay(replay);
  const plain = Buffer.from(schema.canonicalJson(replay));
  const compressed = gzipSync(plain);
  row.replay_size_bytes = compressed.byteLength;
  row.replay_sha256 = createHash('sha256').update(plain).digest('hex');
  assert.equal((await validateDownloadedReplay(row, compressed)).identity.snapshot_id, row.id);

  const tampered = structuredClone(replay);
  tampered.effective_config.goldenWindow.floor = 0.6;
  const tamperedPlain = Buffer.from(schema.canonicalJson(tampered));
  const tamperedCompressed = gzipSync(tamperedPlain);
  const tamperedRow = { ...row, replay_size_bytes: tamperedCompressed.byteLength,
    replay_sha256: createHash('sha256').update(tamperedPlain).digest('hex') };
  await assert.rejects(validateDownloadedReplay(tamperedRow, tamperedCompressed), /CONFIG_MISMATCH/);
});
