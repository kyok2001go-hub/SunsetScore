const test = require('node:test');
const assert = require('node:assert/strict');
const scenarios = require('./fixtures/scenarios.json');
const { createRuntime, load, CORE_FILES, forecast, localSample } = require('./helpers.cjs');

for (const scenario of scenarios) {
  test(`engine invariants: ${scenario.name}`, () => {
    const SS = load(createRuntime(), CORE_FILES);
    const fc = forecast(scenario);
    const sample = localSample(fc);
    const sunset = new Date('2026-08-26T18:30:00Z');
    const cloudField = SS.cloudField.buildCloudField([sample], sunset);
    const result = SS.engine.compute({
      location: { name: 'Fixture City', country: 'Test', latitude: 31.23, longitude: 121.47 },
      utcOffsetSeconds: 0,
      localNowUtc: new Date('2026-08-26T17:00:00Z'),
      solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
      sunsetLocal: sunset,
      samples: [sample],
      air: null,
      cloudField,
      expectedSampleCount: 1,
      spatialCompleteness: 1,
      samplingMode: 'LOCAL_ONLY',
      cacheStatus: 'MISS',
      dataAgeMinutes: 0
    });
    assert.equal(Number.isFinite(result.score), true);
    assert.ok(result.score >= 0 && result.score <= 100);
  });
}
