const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.26 confidence: data completeness and lead time only; scores unchanged. PRD: ref_docs/PRD/V2.5.5.26--置信度修正方案.md

const SUNSET = new Date('2026-08-26T18:30:00Z');
const TIMES = ['2026-08-26T16:00', '2026-08-26T17:00', '2026-08-26T18:00', '2026-08-26T19:00', '2026-08-26T20:00'];
const AIR = { hourly: { time: TIMES, aerosol_optical_depth: [0.2, 0.2, 0.2, 0.2, 0.2], pm2_5: [12, 12, 12, 12, 12] } };
const SKY = { cloud: 50, low: 10, mid: 40, high: 50, precipitation: 0, precipitationProbability: 5, visibility: 20000 };

// mode: 'FULL_SKY_33' (default), 'LOCAL_ONLY', 'FULL' (13 corridor) or 'STANDARD' (7); cacheStatus as the prediction service passes it.
function run({ mode = 'FULL_SKY_33', cacheStatus = 'MISS', hours = 1, air = AIR, dataAgeMinutes = 0 } = {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47;
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(SKY) }));
  let samples = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  if (mode === 'LOCAL_ONLY') samples = samples.filter(s => s.point.distanceKm === 0);
  if (mode === 'STANDARD') samples = samples.filter(s => s.point.distanceKm === 0 || s.point.azimuthOffset === 0 || s.point.distanceKm === 100).slice(0, 7);
  return SS.engine.compute({ location: { name: 'Fixture', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date(SUNSET.valueOf() - hours * 3600e3), solar: { sunset: SUNSET, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: SUNSET, samples, air, cloudField: SS.cloudField.buildCloudField(mode === 'LOCAL_ONLY' ? sky.slice(0, 1) : sky, SUNSET), expectedSampleCount: samples.length,
    spatialCompleteness: 1, samplingMode: mode, cacheStatus, dataAgeMinutes });
}
const FALLBACK_WARNING = '全天空云场暂时无法获取，只用了部分数据，参考价值有限';

test('full sky, complete data, one hour before sunset: confidence 100 with the breakdown', () => {
  const r = run();
  assert.equal(r.confidence, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(r.confidence_breakdown)), { cloud_data: 100, aux_data: 100, lead: 100, freshness: 100, spatial_share: 1, spatial_fallback: null });
  assert.ok(!r.warnings.includes(FALLBACK_WARNING));
});

test('fetch-failure fallback only local is at least 15 lower and warned; deliberate overcast LOCAL_ONLY is not penalised', () => {
  const full = run().confidence, failed = run({ mode: 'LOCAL_ONLY', cacheStatus: 'MISS' }), overcast = run({ mode: 'LOCAL_ONLY', cacheStatus: 'LOCAL' });
  assert.ok(full - failed.confidence >= 15, `${full} vs ${failed.confidence}`);
  assert.equal(failed.confidence_breakdown.spatial_fallback, 'LOCAL_ONLY'); assert.equal(failed.confidence_breakdown.spatial_share, 0.2);
  assert.ok(failed.warnings.includes(FALLBACK_WARNING));
  assert.ok(Math.abs(full - overcast.confidence) <= 5, `${full} vs ${overcast.confidence}`);
  assert.equal(overcast.confidence_breakdown.spatial_fallback, null); assert.ok(!overcast.warnings.includes(FALLBACK_WARNING));
  assert.equal(failed.score, run({ mode: 'LOCAL_ONLY', cacheStatus: 'LOCAL' }).score, 'the cache status changes confidence only, never the score');
});

test('13-point and 7-point fallbacks sit between full sky and local-only, 13 ≥ 7, both warned', () => {
  const full = run().confidence, c13 = run({ mode: 'FULL' }), c7 = run({ mode: 'STANDARD' }), local = run({ mode: 'LOCAL_ONLY' }).confidence;
  assert.ok(full > c13.confidence && c13.confidence >= c7.confidence && c7.confidence > local, [full, c13.confidence, c7.confidence, local].join(' '));
  assert.equal(c13.confidence_breakdown.spatial_share, 0.8); assert.equal(c7.confidence_breakdown.spatial_share, 0.5);
  assert.ok(c13.warnings.includes(FALLBACK_WARNING) && c7.warnings.includes(FALLBACK_WARNING));
});

test('missing AOD and PM2.5 lowers confidence by more than 0 and at most 5', () => {
  const full = run().confidence, noAir = run({ air: null });
  assert.ok(full - noAir.confidence > 0 && full - noAir.confidence <= 5, `${full} vs ${noAir.confidence}`);
  assert.equal(noAir.confidence, 97);
});

test('lead time: 1, 3, 6, 24 and 48 hours never increase; anchors 100 / 90 / 75 / 45 / 20; after sunset 60', () => {
  const lead = h => run({ hours: h }).confidence_breakdown.lead;
  assert.deepEqual([1, 3, 6, 24, 48, 72].map(lead), [100, 90, 75, 45, 20, 20]);
  assert.equal(lead(4.5), 82.5); assert.equal(lead(-0.25), 60);
  const c = [1, 3, 6, 24, 48].map(h => run({ hours: h }).confidence);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] <= c[i - 1], c.join(' '));
});

test('stale cache: the freshness decay is the previous rule on a 0–100 scale; data_freshness output is unchanged', () => {
  const stale = run({ cacheStatus: 'STALE', dataAgeMinutes: 15 + 600 });   // decay hits the floor of 30 (of 90)
  assert.equal(stale.data_freshness, 30);
  assert.ok(Math.abs(stale.confidence_breakdown.freshness - 33.3) < 0.05);
  assert.equal(stale.confidence, Math.round(0.5 * 100 + 0.05 * 100 + 0.3 * 100 + 0.15 * 30 / 90 * 100));
  assert.equal(run().data_freshness, 90);
});
