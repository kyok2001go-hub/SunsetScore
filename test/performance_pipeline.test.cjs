const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, forecast, CORE_FILES } = require('./helpers.cjs');

const SERVICE_FILES = [
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/vendor/suncalc.js', 'js/solar.js', 'js/baseline.js', 'js/cache.js',
  'js/data.js', 'js/city_search.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js',
  'js/sky_state.js', 'js/engine.js', 'js/sampling.js', 'js/corridor.js',
  'js/nowcast.js', 'js/evolution.js', 'js/prediction_service.js', 'js/feedback_service.js'
];

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixedForecast() {
  const fc = forecast({ cloud: 48, low: 18, mid: 44, high: 62 });
  fc.timezone = 'Asia/Shanghai';
  fc.utc_offset_seconds = 28800;
  return fc;
}

test('Air, Minute and Sky start concurrently after Local Forecast and share the query signal', async () => {
  const SS = load(createRuntime(), SERVICE_FILES);
  const fc = fixedForecast();
  const nowUtcMs = Date.parse('2026-08-26T09:00:00Z');
  SS.data.fetchForecastWithRetry = async () => fc;
  SS.solar.getSunEvents = () => ({
    sunset: new Date(nowUtcMs + 105 * 60000), civilDusk: new Date(nowUtcMs + 130 * 60000),
    goldenHourStart: new Date(nowUtcMs + 75 * 60000), goldenHourEnd: new Date(nowUtcMs + 120 * 60000),
    sunsetAzimuthDeg: 282, twilightMinutes: 25
  });

  const gates = { air: deferred(), minute: deferred(), sky: deferred() };
  const signals = [];
  const started = [];
  let releaseStarted;
  const allStarted = new Promise(resolve => { releaseStarted = resolve; });
  function mark(name, options) {
    started.push(name);
    signals.push(options.signal);
    if (started.length === 3) releaseStarted();
  }
  SS.data.fetchAirQuality = (_, __, options) => { mark('air', options); return gates.air.promise; };
  SS.nowcast.getMinutePrecip = (_, options) => { mark('minute', options); return gates.minute.promise; };
  SS.data.gather = (nodes, _, options) => { mark('sky', options); return gates.sky.promise.then(() => ({
    samples: nodes.map(point => ({ point, forecast: fc })), successCount: nodes.length
  })); };
  SS.nowcast.run = async () => null;

  const pending = SS.prediction.predict('22.54,114.06', { nowUtcMs });
  await Promise.race([
    allStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('parallel sources did not all start')), 250))
  ]);
  assert.deepEqual(started.sort(), ['air', 'minute', 'sky']);
  assert.equal(new Set(signals).size, 1, 'all branches receive the same query AbortSignal');
  gates.air.resolve(null);
  gates.minute.resolve({ analysis: null, status: 'NO_DATA', qweather: { status: 'NO_DATA' } });
  gates.sky.resolve();
  const result = await pending;
  assert.equal(result.qweather_status, 'NO_DATA');
  assert.ok(result.performance_timing.air_quality_ms >= 0);
  assert.ok(result.performance_timing.minute_precip_ms >= 0);
  assert.ok(result.performance_timing.spatial_batch_ms >= 0);
});

test('Air and Minute failures degrade without failing a prediction', async () => {
  const SS = load(createRuntime(), SERVICE_FILES);
  const fc = fixedForecast();
  const nowUtcMs = Date.parse('2026-08-26T09:00:00Z');
  SS.data.fetchForecastWithRetry = async () => fc;
  SS.data.fetchAirQuality = async () => { throw new Error('air unavailable'); };
  SS.nowcast.getMinutePrecip = async () => { throw new Error('minute unavailable'); };
  SS.data.gather = async nodes => ({ samples: nodes.map(point => ({ point, forecast: fc })) });
  SS.solar.getSunEvents = () => ({
    sunset: new Date(nowUtcMs + 105 * 60000), civilDusk: new Date(nowUtcMs + 130 * 60000),
    sunsetAzimuthDeg: 282, twilightMinutes: 25
  });
  SS.nowcast.run = async () => null;
  const result = await SS.prediction.predict('22.54,114.06', { nowUtcMs });
  assert.ok(Number.isFinite(result.score));
  assert.equal(result.qweather_status, 'UNKNOWN');
});

test('Batch retry performs exactly two total attempts and one delay', async () => {
  const SS = load(createRuntime(), ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/data.js']);
  let calls = 0, sleeps = 0;
  const attempts = [];
  SS.data.fetchBatchForecast = async () => { calls++; throw new Error('batch unavailable'); };
  SS.network.sleep = async ms => { sleeps++; assert.equal(ms, 800); };
  await assert.rejects(SS.data.fetchBatchForecastWithRetry([{ latitude: 1, longitude: 2 }], {
    onBatchAttempt: attempt => attempts.push(attempt)
  }), /batch unavailable/);
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(attempts, [1, 2]);
});

test('Batch retry aborts during backoff and never starts a second request', async () => {
  const SS = load(createRuntime(), ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/data.js']);
  const controller = new AbortController();
  let calls = 0;
  SS.data.fetchBatchForecast = async () => { calls++; throw new Error('batch unavailable'); };
  const pending = SS.data.fetchBatchForecastWithRetry([{ latitude: 1, longitude: 2 }], { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('prediction passes each per-attempt timeout to its source', async () => {
  const SS = load(createRuntime(), SERVICE_FILES);
  const fc = fixedForecast();
  const seen = {};
  SS.data.fetchForecastWithRetry = async (_, __, ___, options) => { seen.local = options.timeoutMs; return fc; };
  SS.data.fetchAirQuality = async (_, __, options) => { seen.air = options.timeoutMs; return null; };
  SS.data.gather = async (nodes, _, options) => {
    seen.spatial = options.timeoutMs;
    return { samples: nodes.map(point => ({ point, forecast: fc })) };
  };
  await SS.prediction.predict('31.23,121.47', { nowUtcMs: Date.parse('2026-08-26T02:00:00Z') });
  assert.deepEqual(seen, { local: 10000, air: 5000, spatial: 10000 });
});

test('stable result index never reuses a result across the location local-date boundary', async () => {
  const SS = load(createRuntime(), SERVICE_FILES);
  let forecastCalls = 0;
  let currentForecast;
  SS.data.fetchForecastWithRetry = async () => {
    forecastCalls++;
    currentForecast = fixedForecast();
    const date = forecastCalls === 1 ? '2026-08-26' : '2026-08-27';
    currentForecast.hourly.time = currentForecast.hourly.time.map(value => date + value.slice(10));
    return currentForecast;
  };
  SS.data.fetchAirQuality = async () => null;
  SS.data.gather = async nodes => ({ samples: nodes.map(point => ({ point, forecast: currentForecast })) });
  SS.solar.getSunEvents = date => ({
    sunset: new Date(date.valueOf() + 6 * 3600000), civilDusk: new Date(date.valueOf() + 6.5 * 3600000),
    sunsetAzimuthDeg: 282, twilightMinutes: 30
  });
  const first = await SS.prediction.predict('22.54,114.06', { nowUtcMs: Date.parse('2026-08-26T02:00:00Z') });
  const nextDay = await SS.prediction.predict('22.54,114.06', { nowUtcMs: Date.parse('2026-08-27T02:00:00Z') });
  assert.equal(first.date, '2026-08-26');
  assert.equal(nextDay.date, '2026-08-27');
  assert.notEqual(nextDay.query_id, first.query_id);
  assert.equal(nextDay.result_cache_status, 'MISS');
  assert.equal(forecastCalls, 2);
});

test('Radar and Satellite source budgets cap pending metadata before the query deadline', async () => {
  const runtime = createRuntime({ document: {}, fetch: async () => new Promise(() => {}) });
  const SS = load(runtime, [...CORE_FILES, 'js/cache.js', 'js/corridor.js', 'js/nowcast.js']);
  SS.config.network.radarSourceTimeoutMs = 20;
  SS.config.network.satelliteSourceTimeoutMs = 20;
  SS.config.network.observationTimeoutMs = 1000;
  const result = await SS.nowcast.run({
    lat: 22.54, lon: 114.06, dateStr: '2026-08-26', nowUtc: new Date('2026-08-26T09:00:00Z'),
    sunsetAzimuthDeg: 282, forecastTrend: 0,
    precipResult: { analysis: null, status: 'NO_DATA', qweather: { status: 'DISABLED' } }
  });
  assert.equal(result.sourcesStatus.radar.status, 'TIMEOUT');
  assert.equal(result.sourcesStatus.satellite.status, 'TIMEOUT');
});
