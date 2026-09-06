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

test('minute precipitation influence fades to neutral at its coverage boundary', () => {
  const SS = load(createRuntime(), CORE_FILES);
  const now = Date.parse('2026-08-26T09:00:00Z');
  const motionForecast = {
    predictions: Object.fromEntries([30, 60, 90, 120].map(minutes => [
      'm' + minutes, { summary: { avgCloudCover: 20 } }
    ]))
  };
  const common = {
    forecastTrend: 0,
    radar: null,
    satellite: null,
    motionForecast,
    nowMs: now,
    sunsetMs: now + 60 * 60000,
    sunsetCloudCover: 20
  };
  const withoutPrecip = SS.evolution.evaluate({ ...common, precip: null });
  const withPrecip = SS.evolution.evaluate({
    ...common,
    precip: {
      available: true,
      rainingNow: true,
      stopMin: null,
      intensifying: false,
      coverageEndMs: now + 60 * 60000
    }
  });

  assert.ok(withPrecip.openProbability['30m'] < withoutPrecip.openProbability['30m']);
  assert.equal(withPrecip.openProbability['60m'], withoutPrecip.openProbability['60m']);
  assert.equal(SS.evolution.precipCoverageWeight(withPrecip.detail.precip, now, 60), 0);
});

test('sunset beyond the 120-minute evolution horizon uses the exact NWP sunset field', () => {
  const SS = load(createRuntime(), CORE_FILES);
  const now = Date.parse('2026-08-26T09:00:00Z');
  const motionForecast = {
    predictions: Object.fromEntries([30, 60, 90, 120].map(minutes => [
      'm' + minutes, { summary: { avgCloudCover: 0 } }
    ]))
  };
  const evo = SS.evolution.evaluate({
    forecastTrend: 0,
    precip: null,
    radar: null,
    satellite: null,
    motionForecast,
    nowMs: now,
    sunsetMs: now + 150 * 60000,
    sunsetCloudCover: 90
  });

  assert.equal(evo.sunsetMinutesAway, 150);
  assert.equal(evo.sunsetProbabilitySource, 'NWP_SUNSET');
  assert.ok(evo.sunsetOpenProbability < 0.5);
  assert.ok(evo.openProbability['120m'] > evo.sunsetOpenProbability);
});

test('missing NWP sunset field beyond 120 minutes falls back to background, never the 120-minute bucket', () => {
  const SS = load(createRuntime(), CORE_FILES);
  const now = Date.parse('2026-08-26T09:00:00Z');
  const motionForecast = {
    predictions: Object.fromEntries([30, 60, 90, 120].map(minutes => [
      'm' + minutes, { summary: { avgCloudCover: 0 } }
    ]))
  };
  const evo = SS.evolution.evaluate({
    forecastTrend: -40,
    precip: null,
    radar: null,
    satellite: null,
    motionForecast,
    nowMs: now,
    sunsetMs: now + 150 * 60000,
    sunsetCloudCover: null
  });

  assert.equal(evo.sunsetProbabilitySource, 'FORECAST_BACKGROUND');
  assert.equal(evo.sunsetOpenProbability, 0.3);
  assert.notEqual(evo.sunsetOpenProbability, evo.openProbability['120m']);
});
