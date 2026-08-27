const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, forecast } = require('./helpers.cjs');

const SERVICE_FILES = [
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/vendor/suncalc.js', 'js/solar.js', 'js/baseline.js', 'js/cache.js',
  'js/data.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js',
  'js/sky_state.js', 'js/engine.js', 'js/sampling.js', 'js/corridor.js',
  'js/nowcast.js', 'js/evolution.js', 'js/prediction_service.js', 'js/feedback_service.js'
];

test('prediction service runs without DOM and returns a valid V2.3 result', async () => {
  const runtime = createRuntime();
  const SS = load(runtime, SERVICE_FILES);
  const fc = forecast({ cloud: 48, low: 18, mid: 44, high: 62 });
  fc.timezone = 'Asia/Shanghai';
  fc.utc_offset_seconds = 8 * 3600;
  fc.hourly.time = [
    '2026-08-26T16:00', '2026-08-26T17:00', '2026-08-26T18:00',
    '2026-08-26T19:00', '2026-08-26T20:00'
  ];

  SS.data.fetchForecastWithRetry = async () => fc;
  SS.data.fetchAirQuality = async () => null;
  SS.data.gather = async (nodes) => ({
    samples: nodes.map((point) => ({ point, forecast: fc })),
    successCount: nodes.length
  });

  const result = await SS.prediction.predict('31.23, 121.47', {
    nowUtcMs: Date.parse('2026-08-26T02:00:00Z')
  });

  assert.equal(result.model_version, '2.3.1');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.utc_offset_seconds, 28800);
  assert.ok(Number.isFinite(result.score));
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(result.cloud_field.schemaVersion, 1);
  assert.deepEqual(Object.keys(result.cloud_motion.predictions).sort(), ['m120', 'm30', 'm60']);
  assert.doesNotThrow(() => SS.domain.assertPredictionResult(result));
});

test('golden-window prediction carries minute rain through the complete service into timeline', async () => {
  const runtime = createRuntime();
  const SS = load(runtime, SERVICE_FILES);
  const fc = forecast({ cloud: 40, precipitation: 0 });
  fc.timezone = 'Asia/Shanghai';
  fc.utc_offset_seconds = 28800;
  const now = Date.parse('2026-08-26T10:00:00Z');
  SS.data.fetchForecastWithRetry = async () => fc;
  SS.data.fetchAirQuality = async () => null;
  SS.data.gather = async (nodes) => ({ samples: nodes.map((point) => ({ point, forecast: fc })), successCount: nodes.length });
  SS.nowcast.fetchMinutePrecip = async () => ({
    times: Array.from({ length: 24 }, (_, i) => new Date(now + i * 300000).toISOString()),
    precip: Array(24).fill(0.14), stepMs: 300000, source: 'qweather', summary: '降雨还将持续120分钟'
  });
  const result = await SS.prediction.predict('31.23,121.47', { nowUtcMs: now });
  assert.equal(result.nowcast_active, true);
  assert.equal(result.nowcast.detail.precip.available, true);
  assert.equal(result.nowcast.detail.precip.series.times.length, 24);
  assert.ok(result.nowcast.timeline.slice(0, 4).every((item) => item.icon === '🌧️'));
  assert.ok(result.sky_evolution.sources.includes('precip'));
  const payload = SS.feedbackService.buildPayload(result, { rating: 'poor' });
  for (const horizon of [30, 60, 120]) {
    assert.equal(payload['open_prob_' + horizon + 'm'], result.sky_evolution.openProbability[horizon + 'm']);
    assert.ok(Number.isFinite(payload['open_prob_' + horizon + 'm']));
  }
  assert.equal(payload.tile_radar_available, 0);
  assert.equal(payload.tile_sat_available, 0);
  assert.doesNotThrow(() => SS.domain.assertPredictionResult(result));
});

test('cached results respect both golden-window boundaries without changing the scoring formula', async () => {
  const SS = load(createRuntime(), SERVICE_FILES);
  const fc = forecast({ cloud: 48, low: 18, mid: 44, high: 62 });
  fc.timezone = 'Asia/Shanghai';
  fc.utc_offset_seconds = 28800;
  SS.data.fetchForecastWithRetry = async () => fc;
  SS.data.fetchAirQuality = async () => null;
  SS.data.gather = async (nodes) => ({ samples: nodes.map((point) => ({ point, forecast: fc })), successCount: nodes.length });
  SS.solar.getSunEvents = () => ({
    sunset: new Date('2026-08-26T10:45:00Z'), civilDusk: new Date('2026-08-26T11:10:00Z'),
    goldenHourStart: new Date('2026-08-26T10:15:00Z'), goldenHourEnd: new Date('2026-08-26T11:00:00Z'),
    sunsetAzimuthDeg: 282, twilightMinutes: 25
  });
  SS.nowcast.fetchMinutePrecip = async () => null;
  let nowcastCalls = 0;
  SS.nowcast.run = async () => { nowcastCalls++; return null; };
  const predictAt = (time) => SS.prediction.predict('22.54,114.06', { nowUtcMs: Date.parse('2026-08-26T' + time + 'Z') });

  const before = await predictAt('07:44:00');
  assert.equal(before.nowcast_active, false);
  assert.equal(SS.feedbackService.buildPayload(before, { rating: 'poor' }).open_prob_30m, null);
  assert.equal(before.score, Math.round(SS.domain.clamp(before.base_score * before.sky_evolution_factor, 0, 100)));
  const entered = await predictAt('07:45:00');
  assert.equal(entered.nowcast_active, true);
  assert.equal(entered.prediction_time_utc, '2026-08-26T07:45:00.000Z');
  assert.equal(nowcastCalls, 1);
  assert.ok(Number.isFinite(SS.feedbackService.buildPayload(entered, { rating: 'poor' }).open_prob_30m));
  assert.equal(entered.score, Math.round(SS.domain.clamp(entered.base_score * entered.sky_evolution_factor * entered.sky_evolution.gwFactor, 0, 100)));
  const sameWindow = await predictAt('07:46:00');
  assert.equal(sameWindow.query_id, entered.query_id);
  assert.equal(nowcastCalls, 1);

  SS.cache.remove('22.54,114.06_2026-08-26');
  const lastActive = await predictAt('11:15:00');
  assert.equal(lastActive.nowcast_active, true);
  assert.equal(nowcastCalls, 2);
  const ended = await predictAt('11:15:01');
  assert.equal(ended.nowcast_active, false);
  assert.equal(ended.sky_evolution, null);
  assert.equal(SS.feedbackService.buildPayload(ended, { rating: 'poor' }).open_prob_30m, null);
  assert.equal(nowcastCalls, 2);
});
