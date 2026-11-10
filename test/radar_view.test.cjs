const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');

// V2.5.5.12 display fix: the radar model is a pure function of the prediction result.
function setup() {
  const SS = load(createRuntime(), [...CORE_FILES, 'js/radar_view.js']);
  return SS;
}
const NOW = Date.parse('2026-08-26T17:00:00Z');
function fieldOf(SS, samples) {
  return SS.cloudField.buildCloudField(samples, NOW);
}
function gridSamples(SS, values, skip = () => false) {
  return SS.cloudField.generateGridNodes(30, 114).map((point) => ({
    point, forecast: skip(point) ? null : forecast(values)
  }));
}

test('circle area is proportional to cloud cover and 0% is not drawn', () => {
  const SS = setup(), r = SS.radarView.cloudRadius;
  assert.equal(r(0), 0); assert.equal(r(null), 0); assert.equal(r(undefined), 0);
  assert.equal(r(100), 28);
  assert.ok(Math.abs(r(50) * r(50) / (r(100) * r(100)) - 0.5) < 1e-9);
  assert.equal(r(1), 3.2);
  assert.equal(r(250), 28);
});

test('a full 33-node field has no missing nodes and no note', () => {
  const SS = setup();
  const model = SS.radarView.buildModel({ cloud_field: fieldOf(SS, gridSamples(SS, { cloud: 80, low: 10, mid: 30, high: 70 })), spatial_final_mode: 'FULL_SKY_33' });
  assert.equal(model.points.length, 33); assert.equal(model.missing, 0); assert.equal(model.extras, 0); assert.equal(model.note, null);
  assert.ok(model.points.every((p) => p.hasData && p.total === 80 && p.high === 70));
});

test('LOCAL_ONLY keeps the centre and marks all 32 ring nodes as missing, not as 0% cloud', () => {
  const SS = setup();
  const centre = SS.cloudField.generateGridNodes(30, 114)[0];
  const result = { cloud_field: fieldOf(SS, [{ point: centre, forecast: forecast({ cloud: 96, low: 90, mid: 60, high: 20 }) }]), spatial_final_mode: 'LOCAL_ONLY', batch_attempts: 0 };
  const model = SS.radarView.buildModel(result);
  assert.equal(model.points[0].hasData, true); assert.equal(model.points[0].total, 96);
  assert.equal(model.missing, 32);
  assert.ok(model.points.slice(1).every((p) => p.hasData === false));
  assert.match(model.note, /浓厚阴天.*不代表无云/);
  // Reached through failed requests instead of the overcast shortcut: the note says so.
  assert.match(SS.radarView.buildModel({ ...result, batch_attempts: 2 }).note, /周边云场获取失败/);
  // The same holds after the result cache's JSON round trip (methods and object identity are lost).
  const cached = SS.radarView.buildModel(JSON.parse(JSON.stringify(result)));
  assert.equal(cached.missing, 32); assert.equal(cached.points[0].total, 96);
});

test('nodes whose request returned nothing are missing; the rest keep their values', () => {
  const SS = setup();
  const model = SS.radarView.buildModel({ cloud_field: fieldOf(SS, gridSamples(SS, { cloud: 40 }, (p) => p.direction === 'W')) });
  assert.equal(model.missing, 4);
  assert.equal(model.points.filter((p) => !p.hasData).map((p) => p.key).join(','), 'W_50,W_100,W_200,W_300');
  assert.match(model.note, /^4 个节点暂无数据/);
});

test('degraded sunset-direction samples are drawn at their true bearing and distance', () => {
  const SS = setup(), lat = 30, lon = 114, azimuth = 250;
  // Same node shape as sampling.selectNodes('STANDARD'): no direction, only offsets and coordinates.
  const nodes = [{ latitude: lat, longitude: lon, distanceKm: 0, azimuthOffset: 0 }];
  for (const [offset, distances] of [[0, [50, 100, 200, 300]], [-30, [100]], [30, [100]]]) {
    for (const distanceKm of distances) {
      const p = SS.data.destinationPoint(lat, lon, azimuth + offset, distanceKm);
      nodes.push({ latitude: p.latitude, longitude: p.longitude, distanceKm, azimuthOffset: offset });
    }
  }
  const field = fieldOf(SS, nodes.map((point) => ({ point, forecast: forecast({ cloud: 70, low: 20, mid: 10, high: 60 }) })));
  const model = SS.radarView.buildModel({ cloud_field: field, latitude: lat, longitude: lon, spatial_final_mode: 'STANDARD', batch_attempts: 2 });
  assert.equal(model.missing, 32); assert.equal(model.extras, 6);
  assert.match(model.note, /降级为日落方向 6 个采样点/);
  const extras = model.points.filter((p) => !p.slot);
  assert.ok(extras.every((p) => p.hasData && p.total === 70));
  const corridor300 = extras.find((p) => p.distanceKm === 300);
  // Initial bearing from the centre matches the sunset azimuth; 300 km sits on the outer ring (radius 248).
  assert.ok(Math.abs(corridor300.azimuth - azimuth) < 0.5);
  assert.ok(Math.abs(Math.hypot(corridor300.x - 310, corridor300.y - 310) - 248) < 0.2);
  assert.equal(SS.radarView.radiusForDistance(150), 161);
});

test('sector cells tile the disc: centre circle plus one closed annular sector per grid node', () => {
  const SS = setup();
  assert.match(SS.radarView.cellPath({ distanceKm: 0, azimuth: 0 }), /^M 273 310 a 37 37 /);
  const cell = SS.radarView.cellPath({ distanceKm: 300, azimuth: 90 });
  assert.match(cell, /A 248 248 0 0 1 /); assert.match(cell, /A 219 219 0 0 0 /); assert.ok(cell.endsWith('Z'));
  assert.equal(SS.radarView.cellPath({ distanceKm: 150, azimuth: 90 }), '');
});
