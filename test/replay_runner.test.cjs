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
      nowUtcMs: Date.parse('2026-08-26T10:00:00Z'), satelliteEnabled: false },
    { name: 'SATELLITE_DEGRADED', values: { cloud: 52, low: 20, mid: 42, high: 68 },
      nowUtcMs: Date.parse('2026-08-26T10:00:00Z'), radarEnabled: false }
  ];
  for (const spec of cases) {
    const fixture = await capture(spec);
    const report = await runReplay(fixture.replay, { reference: fixture.reference });
    assert.equal(report.pass, true, spec.name + ': ' + JSON.stringify(report));
    assert.ok(Math.abs(report.deltas.score) <= 1);
    assert.ok(report.deltas.components && Object.values(report.deltas.components).every((value) => value == null || Math.abs(value) <= 1));
  }
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
    replay_sha256: createHash('sha256').update(plain).digest('hex')
  };
  assert.deepEqual(verifyReplay(row, compressed), replay);
  assert.throws(() => verifyReplay({ ...row, replay_size_bytes: compressed.byteLength + 1 }, compressed), /SIZE_MISMATCH/);
  assert.throws(() => verifyReplay({ ...row, replay_sha256: '0'.repeat(64) }, compressed), /CONTENT_HASH_MISMATCH/);
  assert.throws(() => verifyReplay({ ...row, event_id: 'other_event' }, compressed), /IDENTITY_MISMATCH/);
});
