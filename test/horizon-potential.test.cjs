const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.17 horizon contribution conditioned on cloud potential (default off). PRD: ref_docs/PRD/V2.5.5.17--地平线贡献按云潜力条件化方案.md

// Every sky node gets the same layers; `withField: false` drops the cloud field (no potential can be computed).
function runEngine(layers, patch = {}, { withField = true } = {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  delete SS.config.horizonCloudPotential; delete SS.config.canvasZeroFloor;
  Object.assign(SS.config, patch);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(layers) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  let trace = null;
  const result = SS.engine.compute({ location: { name: 'Fixture City', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: withField ? SS.cloudField.buildCloudField(sky, sunset) : undefined, expectedSampleCount: 13,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0, offlineTrace: t => { trace = t; } });
  return { result, trace };
}
const CLEAR = { low: 0, mid: 0, high: 0, cloud: 0 }, CLOUDY = { low: 5, mid: 30, high: 40, cloud: 55 }, THIN = { low: 0, mid: 5, high: 10, cloud: 12 };
const hcp = (f, k) => ({ horizonCloudPotential: { f, k, radiusKm: 100 } });

test('Without the key nothing changes; f = 1 is neutral; missing cloud field disables the conditioning', () => {
  for (const layers of [CLEAR, CLOUDY, THIN]) {
    const base = runEngine(layers), neutral = runEngine(layers, hcp(1, 25));
    assert.equal(base.trace.horizon_cloud_potential, undefined, 'no trace key without the config key');
    assert.equal(neutral.result.score, base.result.score); assert.equal(neutral.trace.P, base.trace.P);
    assert.equal(neutral.trace.horizon_cloud_potential.factor, 1);
  }
  const noField = runEngine(CLEAR, hcp(0.3, 25), { withField: false }), base = runEngine(CLEAR, {}, { withField: false });
  assert.deepEqual([noField.trace.horizon_cloud_potential.value, noField.trace.horizon_cloud_potential.factor], [null, 1]);
  assert.equal(noField.result.score, base.result.score);
});

test('g(C) = f + (1 − f)·min(1, C/k) scales only the horizon contribution to P', () => {
  const base = runEngine(CLEAR), cond = runEngine(CLEAR, hcp(0.5, 25)), h = cond.trace.horizon_cloud_potential;
  assert.deepEqual([h.value, h.factor], [0, 0.5]);
  const w = base.trace.dynamic_weights.horizon, horizon = base.trace.components.horizon;
  assert.ok(Math.abs((base.trace.P - cond.trace.P) - 0.5 * w * horizon) < 1e-9, 'P drops by exactly (1 − g)·w·horizon');
  assert.equal(cond.trace.components.horizon, horizon, 'horizon component itself unchanged');
  assert.ok(Math.abs(cond.trace.contributions.horizon - 0.5 * w * horizon) < 1e-9);
  assert.ok(cond.result.score < base.result.score);
  // C = max(mid, high) = 10 over the centre and the 50 / 100 km rings → g = 0.5 + 0.5·10/25 = 0.7.
  const thin = runEngine(THIN, hcp(0.5, 25)).trace.horizon_cloud_potential;
  assert.deepEqual([thin.value, Number(thin.factor.toFixed(9))], [10, 0.7]);
  // C ≥ k → full contribution, identical to the baseline.
  const cloudy = runEngine(CLOUDY, hcp(0.3, 35)), cloudyBase = runEngine(CLOUDY);
  assert.deepEqual([cloudy.trace.horizon_cloud_potential.value, cloudy.trace.horizon_cloud_potential.factor], [40, 1]);
  assert.equal(cloudy.result.score, cloudyBase.result.score);
});

test('H-B removes the zero-cloud canvas floor and scales the low-cloud term; it leaves covered layers above the ramp unchanged', () => {
  const a = runEngine(CLEAR, hcp(0.5, 25)), b = runEngine(CLEAR, { ...hcp(0.5, 25), canvasZeroFloor: { rampPct: 10 } });
  assert.ok(b.trace.components.skyCanvas < a.trace.components.skyCanvas, 'canvas floor removed with no cloud');
  const ca = runEngine(CLOUDY, hcp(0.5, 25)), cb = runEngine(CLOUDY, { ...hcp(0.5, 25), canvasZeroFloor: { rampPct: 10 } });
  assert.equal(cb.trace.components.skyCanvas, ca.trace.components.skyCanvas, 'layers ≥ ramp and C ≥ k: unchanged');
});

let modules;
const api = () => modules ||= Promise.all(['practical-tuning/horizon-potential', 'practical-tuning/policy'].map(n => import(`../tools/${n}.mjs`)))
  .then(([hp, policy]) => ({ ...hp, digest: policy.digest }));

test('Line selection follows the V2.5.5.11 rule and the variant with the lowest training loss wins', async () => {
  const m = await api();
  assert.deepEqual(m.gridKeys('HA'), ['HA_f0.3_k15', 'HA_f0.3_k25', 'HA_f0.3_k35', 'HA_f0.5_k15', 'HA_f0.5_k25', 'HA_f0.5_k35', 'HA_f0.7_k15', 'HA_f0.7_k25', 'HA_f0.7_k35']);
  assert.deepEqual(m.gridParams('HB_f0.7_k35'), { f: 0.7, k: 35 });
  assert.deepEqual([m.grade(48, [19, 49, 66, 90]), m.grade(49, [19, 49, 66, 90]), m.grade(95, [19, 49, 66, 90])], [1, 2, 4]);
  const base = { horizonCloudPotential: undefined }, cfg = m.variantConfig({ x: 1 }, 'HB', 0.5, 25);
  assert.deepEqual(cfg, { x: 1, horizonCloudPotential: { f: 0.5, k: 25, radiusKm: 100 }, canvasZeroFloor: { rampPct: 10 } });
  assert.equal(base.horizonCloudPotential, undefined);
  // GT 0/1 at 40–50, GT 2 at 60, GT 3 at 70: the best feasible lines separate them; a variant that pushes GT 0/1 down wins.
  const rows = [];
  let n = 0;
  for (const [gt, c0, v] of [[0, 45, 20], [1, 50, 30], [2, 60, 60], [3, 72, 72], [1, 52, 25], [2, 62, 62], [0, 47, 15], [3, 75, 75]])
    for (let d = 0; d < 3; d++) rows.push({ snapshot_id: `s${n}`, event_id: `e${n++}`, event_date_local: `2026-10-0${d + 1}`, gt_ordinal: gt, gt_confidence: 1, weight: 1,
      lead_time_minutes: 30, scores: { C0: c0, HA_f0_k1: v, HA_f9_k9: c0 } });
  const l0 = m.selectLines(rows, 'C0');
  assert.ok(l0 && l0.lines[3] === 90 && l0.lines[0] < l0.lines[1] && l0.lines[1] < l0.lines[2]);
  const pick = m.selectVariant(rows, ['HA_f9_k9', 'HA_f0_k1']);
  assert.ok(pick.train_loss <= l0.train_loss); assert.equal(pick.key, pick.train_loss < l0.train_loss - 1e-12 ? 'HA_f0_k1' : 'HA_f9_k9');
  const cv = m.crossValidate(rows, 3, ['HA_f9_k9', 'HA_f0_k1']);
  assert.equal(cv.folds.length, 3); assert.equal(cv.list.length, rows.length);
  assert.ok(cv.list.every(r => Number.isInteger(r.ordL0) && Number.isInteger(r.ordX) && ['HA_f9_k9', 'HA_f0_k1'].includes(r.keyX)));
});

test('Policy 14 plan is frozen around the PRD grid, floors and pools', async () => {
  const m = await api(), p = m.HP_POLICY;
  assert.deepEqual([p.practical_tuning_schema_version, p.search_space, p.baseline, p.h3_first_date], [14, 'horizon-potential', 'RELEASE_LINE_2.5.5.11', '2026-11-16']);
  assert.deepEqual([[...p.grid.f], [...p.grid.k], p.radius_km, p.canvas_zero_floor_ramp_pct], [[0.3, 0.5, 0.7], [15, 25, 35], 100, 10]);
  assert.deepEqual([p.lines.ge2_recall_floor, p.lines.ge3_recall_floor, [...p.lines.current], [...p.folds], p.auc_drop_tolerance], [0.65, 0.2, [19, 49, 66, 90], [5, 11], 0.02]);
  assert.deepEqual(p.pools.map(x => x.name), ['DEV', 'H1', 'H2']);
});
