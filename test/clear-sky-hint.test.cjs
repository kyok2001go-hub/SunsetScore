const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.19: horizonCloudPotential is enabled in production (f 0.7, k 5) and the result carries the display-only clear-sky hint.
// PRD: ref_docs/PRD/V2.5.5.19--地平线条件化上线与无云日提示方案.md

// Every sky node gets the same layers; `withField: false` drops the cloud field (degraded sampling without nodes).
function runEngine(layers, { withField = true, patch = null } = {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  if (patch) patch(SS.config);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(layers) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  let trace = null;
  const result = SS.engine.compute({ location: { name: 'Fixture City', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: withField ? SS.cloudField.buildCloudField(sky, sunset) : undefined, expectedSampleCount: 13,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0, offlineTrace: t => { trace = t; } });
  return { result, trace, SS };
}
const off = config => { delete config.horizonCloudPotential; };
// Engine objects come from the vm realm: compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));
const CLEAR = { low: 0, mid: 0, high: 0, cloud: 0 }, LOW_OVERCAST = { low: 70, mid: 0, high: 2, cloud: 72 },
  THIN_HIGH = { low: 0, mid: 3, high: 8, cloud: 10 }, CLOUDY = { low: 5, mid: 30, high: 40, cloud: 55 };

test('Production config carries the released key: f 0.7, k 5, 100 km, hint below 20% total cloud; grade lines unchanged', () => {
  const SS = load(createRuntime(), ['js/config.js', 'js/model_config.js']);
  assert.deepEqual(JSON.parse(JSON.stringify(SS.config.horizonCloudPotential)), { f: 0.7, k: 5, radiusKm: 100, hintTotalCloudBelowPct: 20 });
  assert.equal('canvasZeroFloor' in SS.config, false);
  assert.deepEqual(plain(SS.config.levels.map(l => l.min)), [90, 66, 49, 19, 0]);
  assert.deepEqual([SS.version.app, SS.version.model, SS.version.assetRevision, SS.version.cache], ['2.5.5.29', '2.5.5.19', 'app25529', 'v237']);
});

test('Hint shows only when C < 5% and the sunset-time total cloud is below 20%', () => {
  // 1. Cloud-free: C = 0, total 0 → horizon scaled by 0.7, hint on, score below the same sky without the key.
  const clear = runEngine(CLEAR), clearOff = runEngine(CLEAR, { patch: off });
  assert.deepEqual(plain(clear.result.clear_sky), { cloud_potential: 0, horizon_factor: 0.7, total_cloud: 0, hint: true });
  assert.ok(clear.result.score < clearOff.result.score);
  assert.equal('clear_sky' in clearOff.result, false, 'historical configs without the key carry no clear_sky field');
  assert.equal(clear.trace.horizon_cloud_potential.hint, true); assert.equal(clear.trace.horizon_cloud_potential.total_cloud, 0);
  // 2. Low overcast: C = 2 (< 5, so the horizon is scaled) but total cloud 72% → "basically cloudless" would be wrong, no hint.
  const low = runEngine(LOW_OVERCAST);
  assert.deepEqual([low.result.clear_sky.cloud_potential, low.result.clear_sky.horizon_factor, low.result.clear_sky.total_cloud, low.result.clear_sky.hint], [2, 0.82, 72, false]);
  // 3. Thin high cloud: C = 8 ≥ 5 → not scaled, no hint, score identical to the configuration without the key.
  const thin = runEngine(THIN_HIGH), thinOff = runEngine(THIN_HIGH, { patch: off });
  assert.deepEqual([thin.result.clear_sky.cloud_potential, thin.result.clear_sky.horizon_factor, thin.result.clear_sky.hint], [8, 1, false]);
  assert.equal(thin.result.score, thinOff.result.score);
  const cloudy = runEngine(CLOUDY);
  assert.equal(cloudy.result.clear_sky.hint, false); assert.equal(cloudy.result.score, runEngine(CLOUDY, { patch: off }).result.score);
  // 4. No cloud-field nodes (degraded sampling): neither scaled nor hinted.
  const none = runEngine(CLEAR, { withField: false }), noneOff = runEngine(CLEAR, { withField: false, patch: off });
  assert.deepEqual(plain(none.result.clear_sky), { cloud_potential: null, horizon_factor: 1, total_cloud: null, hint: false });
  assert.equal(none.result.score, noneOff.result.score);
});

test('The hint threshold is display-only: removing or changing it never changes a score', () => {
  for (const layers of [CLEAR, LOW_OVERCAST, THIN_HIGH, CLOUDY]) {
    const base = runEngine(layers), noHint = runEngine(layers, { patch: c => { delete c.horizonCloudPotential.hintTotalCloudBelowPct; } }),
      wide = runEngine(layers, { patch: c => { c.horizonCloudPotential.hintTotalCloudBelowPct = 100; } });
    assert.equal(noHint.result.score, base.result.score); assert.equal(wide.result.score, base.result.score);
    assert.equal(noHint.result.clear_sky.hint, false, 'without a threshold the hint stays off');
    assert.equal(noHint.trace.P, base.trace.P); assert.equal(wide.trace.P, base.trace.P);
  }
  assert.equal(runEngine(LOW_OVERCAST, { patch: c => { c.horizonCloudPotential.hintTotalCloudBelowPct = 100; } }).result.clear_sky.hint, true);
});

test('Page contract: the hint line sits right under 天气型, is hidden by default and toggled from result.clear_sky.hint', () => {
  const root = join(__dirname, '..'), html = readFileSync(join(root, 'index.html'), 'utf8'), css = readFileSync(join(root, 'css/style.css'), 'utf8'), ui = readFileSync(join(root, 'js/ui.js'), 'utf8');
  assert.match(html, /<span class="info-label">天气型<\/span>\s*<span id="r-regime" class="info-value">—<\/span>\s*<\/div>\s*(?:<!--[^>]*-->\s*)?<div id="r-clear-sky-hint" class="info-hint" role="note" hidden>今天基本无云，不会有火烧云，可能有渐变色余晖<\/div>/);
  assert.equal(html.split('id="r-clear-sky-hint"').length, 2);
  assert.match(css, /\.info-hint\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(ui, /\$\('r-clear-sky-hint'\);\s*if \(clearSkyHint\) clearSkyHint\.hidden = !\(result\.clear_sky && result\.clear_sky\.hint === true\);/);
});
