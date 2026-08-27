const { createRuntime, load, CORE_FILES, forecast, localSample } = require('./helpers.cjs');
const scenarios = require('./fixtures/scenarios.json');

function scoreCases(diagnostics = false) {
  const SS = load(createRuntime(), [...CORE_FILES, 'js/sampling.js']);
  const cases = {};
  for (const scenario of scenarios) {
    for (const mode of ['LOCAL_ONLY', 'STANDARD', 'FULL', 'FULL_SKY_33', 'MISSING_REMOTE']) {
      const sunset = new Date('2026-08-26T18:30:00Z');
      const fc = forecast(scenario);
      const skySamples = mode === 'FULL_SKY_33'
        ? SS.cloudField.generateGridNodes(31.23, 121.47).map((point, i) => ({ point, forecast: forecast({ ...scenario, low: Math.min(100, i * 3), high: Math.max(0, 90 - i * 2) }) }))
        : SS.sampling.selectNodes(mode === 'MISSING_REMOTE' ? 'FULL' : mode, 31.23, 121.47, 270)
          .map(point => ({ point, forecast: mode === 'MISSING_REMOTE' && point.distanceKm ? null : fc }));
      const samples = mode === 'FULL_SKY_33'
        ? SS.cloudField.interpolateCorridorSamples(skySamples, 31.23, 121.47, 270, [50, 100, 200, 300], [-30, 0, 30]) : skySamples;
      const solar = { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 };
      const result = SS.engine.compute({
        location: { name: 'Fixture', country: 'Test', latitude: 31.23, longitude: 121.47 },
        utcOffsetSeconds: 0, localNowUtc: new Date('2026-08-26T17:00:00Z'), solar,
        sunsetLocal: sunset, samples, air: null, cloudField: SS.cloudField.buildCloudField(skySamples, sunset),
        expectedSampleCount: samples.length, spatialCompleteness: SS.sampling.weightedCompleteness(samples),
        samplingMode: mode, cacheStatus: 'MISS', dataAgeMinutes: 0
      });
      const baseline = SS.baseline.compute({ solar, sunsetLocal: sunset }, samples);
      cases[scenario.name + '/' + mode] = diagnostics ? {
        distance_reliability: result.distance_reliability,
        distance_band_coverage: result.distance_band_coverage,
        illumination_data_factor: result.illumination_data_factor
      } : Object.fromEntries([
        ...['score', 'components', 'regime_state', 'weather_score', 'bonus', 'penalty', 'horizon_gate', 'hard_gates', 'cloud_structure'].map(key => [key, result[key]]),
        ['baseline_score', baseline.score]
      ]);
    }
  }
  return JSON.parse(JSON.stringify(cases));
}
module.exports = { scoreCases };
