const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
const { scoreCases } = require('./score-cases.cjs');

for (const level of [850, 700, 500]) {
  test('pressure wind ' + level + ': missing neighbours, one neighbour, zero, wrap and boundaries', () => {
    const SS = load(createRuntime(), CORE_FILES);
    const fc = forecast();
    const speed = 'wind_speed_' + level + 'hPa', direction = 'wind_direction_' + level + 'hPa';
    fc.hourly[speed] = [null, null, null, null, null];
    fc.hourly[direction] = [null, null, null, null, null];
    const at = (time = '17:30') => SS.cloudField.extractInterpolatedAt(fc, Date.parse('2026-08-26T' + time + ':00Z'));
    for (const time of ['15:00', '17:30', '21:00']) {
      assert.equal(at(time)[speed], null);
      assert.equal(at(time)[direction], null);
    }
    let data = at();
    const layer = {850:'LOW',700:'MID',500:'HIGH'}[level];
    const fallback = SS.wind.getLayerWind(15, 270, layer, 31, data);
    assert.equal(fallback.isRealSounding, false);
    assert.ok(Number.isFinite(fallback.speedKmH));
    fc.hourly[speed][2] = 0;
    fc.hourly[direction][2] = 0;
    assert.equal(at()[speed], 0);
    assert.equal(at()[direction], 0);
    fc.hourly[speed][1] = 20;
    fc.hourly[direction][1] = 350;
    fc.hourly[direction][2] = 10;
    assert.equal(at()[speed], 10);
    assert.equal(at()[direction], 0);
    fc.hourly[speed][1] = Infinity;
    fc.hourly[direction][1] = NaN;
    assert.equal(at()[speed], 0);
    assert.equal(at()[direction], 10);
    fc.hourly[speed][2] = null;
    fc.hourly[direction][2] = null;
    assert.equal(at()[speed], null);
    assert.equal(at()[direction], null);
  });
}

test('distance reliability is weighted by valid bands; coverage is separate from scoring', () => {
  const results = scoreCases(true);
  for (const [key, result] of Object.entries(results)) {
    if (key.endsWith('/FULL') || key.endsWith('/FULL_SKY_33') || key.endsWith('/STANDARD')) {
      assert.ok(Math.abs(result.distance_reliability - 0.7875) < 1e-12, key);
      assert.equal(result.distance_band_coverage, 1);
    } else {
      assert.equal(result.distance_reliability, 1, key);
      assert.equal(result.distance_band_coverage, 0.15, key);
    }
    assert.equal(result.illumination_data_factor, 1);
  }
});

test('golden-window switch and exact boundaries share one configuration', () => {
  const SS = load(createRuntime(), CORE_FILES);
  const active = minutes => SS.evolution.isGoldenWindowActive({ time: { minutesToSunset: minutes } });
  assert.equal(active(180.001), false);
  assert.equal(active(180), true);
  assert.equal(active(-30), true);
  assert.equal(active(-30.001), false);
  SS.modelConfig.goldenWindow.beforeSunsetMinutes = 120;
  assert.equal(active(121), false);
  assert.equal(active(120), true);
  SS.modelConfig.goldenWindow.enabled = false;
  assert.equal(active(0), false);
  assert.equal(SS.modelConfig.goldenWindow.floor, 0.5);
  for (const key of ['weatherRegimeV17','nowcastV19','evolutionV20','goldenWindowV4']) assert.equal(SS.config[key], undefined);
  assert.equal(SS.modelConfig.scoring.weatherRegime.enabled, undefined);
  assert.equal(SS.modelConfig.evolution.enabled, undefined);
  assert.equal(SS.modelConfig.goldenWindow.endMinutes, undefined);
});
