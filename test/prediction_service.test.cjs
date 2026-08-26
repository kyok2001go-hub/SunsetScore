const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, forecast } = require('./helpers.cjs');

const SERVICE_FILES = [
  'js/config.js', 'js/model_config.js', 'js/domain.js', 'js/time.js',
  'js/vendor/suncalc.js', 'js/solar.js', 'js/baseline.js', 'js/cache.js',
  'js/data.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js',
  'js/sky_state.js', 'js/engine.js', 'js/sampling.js', 'js/corridor.js',
  'js/nowcast.js', 'js/evolution.js', 'js/prediction_service.js'
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

  assert.equal(result.model_version, '2.3.0');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.utc_offset_seconds, 28800);
  assert.ok(Number.isFinite(result.score));
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(result.cloud_field.schemaVersion, 1);
  assert.deepEqual(Object.keys(result.cloud_motion.predictions).sort(), ['m120', 'm30', 'm60']);
  assert.doesNotThrow(() => SS.domain.assertPredictionResult(result));
});
