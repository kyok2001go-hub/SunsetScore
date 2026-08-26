const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast, localSample } = require('./helpers.cjs');

test('NWP-only Golden Window fallback remains finite', () => {
  const SS = load(createRuntime(), CORE_FILES);
  const sample = localSample(forecast({ cloud: [75, 65, 50, 35, 25] }));
  const now = Date.parse('2026-08-26T17:00:00Z');
  const current = SS.cloudField.buildCloudField([sample], now);
  const motion = SS.cloudMotion.forecast(current, 270, [sample], now);
  const evo = SS.evolution.evaluate({
    forecastTrend: 25,
    precip: null,
    radar: null,
    satellite: null,
    motionForecast: motion,
    nowMs: now,
    sunsetMs: Date.parse('2026-08-26T18:30:00Z')
  });
  assert.ok(evo);
  assert.equal(Number.isFinite(evo.openProbability['60m']), true);
  assert.equal(Number.isFinite(evo.gwFactor), true);
  assert.ok(evo.gwFactor >= 0.5 && evo.gwFactor <= 1);
});
