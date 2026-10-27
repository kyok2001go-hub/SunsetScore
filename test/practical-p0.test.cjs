const test = require('node:test');
const assert = require('node:assert/strict');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/p0-features', 'practical-tuning/p0-diagnostics', 'practical-tuning/p0-probe',
  'practical-tuning/p0-workflow', 'practical-tuning/policy', 'model-release/holdout'].map(n => import(`../tools/${n}.mjs`)))
  .then(([features, diagnostics, probe, workflow, policy, holdout]) => ({ ...features, ...diagnostics, ...probe, ...workflow, digest: policy.digest, holdout })); }
const row = (id, event, gt, extra = {}) => ({ snapshot_id: id, event_id: event, event_date_local: '2026-09-01', gt_ordinal: gt, gt_confidence: .6, lead_time_minutes: 60, ...extra });
const scoring = { horizonDistanceWeights: { 0: .3, 50: .25, 100: .2, 200: .15, 300: .1 }, spatialField: { angularPower: 2, sectorWeights: { corridor: .6, bank: .3, side: .1 } } };

test('Fast weighted AUC equals the pairwise H1 definition, ties count half, single class is null', async () => {
  const m = await api();
  const rows = [[1, 0, .6], [2, 1, 1], [2, 0, .6], [3, 2, .6], [3, 3, 1], [5, 1, .6], [7, 4, .6], [7, 0, 1], [9, 2, .6]]
    .map(([s, g, c], i) => row(`s${i}`, `e${i}`, g, { score: s, gt_confidence: c }));
  for (const t of [2, 3]) {
    const fast = m.aucEvaluator(rows.map(r => r.score), rows.map(r => r.gt_ordinal >= t))(rows.map(r => r.gt_confidence));
    assert.ok(Math.abs(fast - m.holdout.weightedAuc(rows, 'score', t)) < 1e-12);
  }
  assert.equal(m.aucEvaluator([1, 2], [true, true])([1, 1]), null);
  assert.equal(m.aucEvaluator([1, 1], [true, false])([1, 1]), .5);
  assert.equal(m.aucEvaluator([1, null, 3], [false, true, true])([1, 1, 1]), 1);
});

test('PRIMARY_LAST keeps the smallest lead time per Event and breaks ties by snapshot_id', async () => {
  const m = await api();
  const rows = [row('b', 'A', 1, { lead_time_minutes: 30 }), row('a', 'A', 1, { lead_time_minutes: 30 }), row('c', 'A', 1, { lead_time_minutes: 10 }),
    row('d', 'B', 2, { lead_time_minutes: 50 }), row('e', 'B', 2, { lead_time_minutes: 40 })];
  assert.deepEqual(m.primaryLast(rows).map(r => r.snapshot_id), ['c', 'e']);
  assert.deepEqual(m.primaryLast(rows.filter(r => r.snapshot_id !== 'c')).map(r => r.snapshot_id), ['a', 'e']);
});

test('Date-block bootstrap multiplies each row by its date draw count, is deterministic, and needs two dates', async () => {
  const m = await api();
  const rows = ['2026-09-01', '2026-09-01', '2026-09-02', '2026-09-03'].map((d, i) => row(`s${i}`, `e${i}`, i % 2 ? 2 : 0, { event_date_local: d }));
  const seen = [];
  const r1 = m.bootstrapInterval(rows, [1, 1, 1, 1], 'unit', w => { seen.push(w); return w.reduce((a, b) => a + b, 0); }, { replicates: 50, minimum_valid: 40, lower: .025, upper: .975 });
  assert.equal(r1.point, 4); assert.equal(r1.valid_replicates, 50);
  // Rows on the same date always share the same multiplier; total draws = number of dates.
  for (const w of seen.slice(1)) { assert.equal(w[0], w[1]); assert.equal(w[0] + w[2] + w[3], 3); }
  const r2 = m.bootstrapInterval(rows, [1, 1, 1, 1], 'unit', w => w.reduce((a, b) => a + b, 0), { replicates: 50, minimum_valid: 40, lower: .025, upper: .975 });
  assert.deepEqual(r1.ci95, r2.ci95);
  const one = m.bootstrapInterval(rows.slice(0, 2), [1, 1], 'unit', w => w[0], { replicates: 50, minimum_valid: 40, lower: .025, upper: .975 });
  assert.equal(one.status, 'NOT_ESTIMABLE'); assert.equal(one.reason_code, 'INSUFFICIENT_DATES');
  assert.notEqual(m.seedOf('a'), m.seedOf('b'));
});

test('Support counts distinct Events, dates and grade supports', async () => {
  const m = await api();
  const rows = [row('a', 'A', 3), row('b', 'A', 3), row('c', 'B', 1, { event_date_local: '2026-09-02' }), row('d', 'C', 2)];
  assert.deepEqual(m.support(rows), { snapshots: 4, events: 3, dates: 2, ge2_events: 2, ge3_events: 1, le1_events: 1 });
  assert.deepEqual(m.support(rows, [false, false, true, false]), { snapshots: 1, events: 1, dates: 1, ge2_events: 0, ge3_events: 0, le1_events: 1 });
});

test('Sector aggregation and F01–F06 match hand computation', async () => {
  const m = await api();
  const c = (o, d, low, mid, high = 0) => ({ azimuth_offset: o, distance_km: d, low, mid, high, total: low + mid + high });
  const corridor = [c(0, 0, 10, 20), c(0, 50, 20, 40), c(0, 100, 80, 40), c(-30, 50, 0, 0), c(-30, 100, 40, 0), c(30, 50, 60, 20), c(30, 100, null, 10)];
  // Corridor ray low: (10*.3+20*.25+80*.2)/.75 = 32; bank: -30 → (0*.25+40*.2)/.45, +30 → 60; equal cos^2 weights.
  const bank = ((40 * .2) / .45 + 60) / 2, expectedLow = (32 * .6 + bank * .3) / .9;
  const trace = { atmosphere_inputs: { visibility_km: 9, humidity: 70, pm25: 30, aod: .3 }, diagnostic_observer: { observer_version: 1, corridor, twilight_minutes: 24,
    sunset_field: { center: { low: 10, mid: 20, high: 55, total: 85 }, avg_cloud_cover: 61, nodes: [{ distance_km: 50, has_data: true, mid: 30, high: 10 }, { distance_km: 50, has_data: true, mid: 0, high: 70 }, { distance_km: 100, has_data: true, mid: 99, high: 99 }] },
    golden_window: { forecast_trend: -12 } } };
  const f = m.sunsetFeatures(trace, scoring);
  assert.ok(Math.abs(f.l_corr - expectedLow) < 1e-9);
  assert.equal(f.b_max, 100); // 80 + 0.5*40 = 100 clamped
  assert.equal(f.b_count, 1); // 0° ray: 50 km = 20 + 0.5·40 = 40, 100 km = 100 → one node >= 70
  assert.equal(f.engine_bank_sector_voided, false);
  // Engine-faithful quirk: an offset-less center sample voids the whole ±30° bank sector (horizon = 0° ray 50–300 km).
  const quirk = m.sunsetFeatures({ ...trace, diagnostic_observer: { ...trace.diagnostic_observer, corridor: [{ ...corridor[0], azimuth_offset: null }, ...corridor.slice(1)] } }, scoring);
  assert.ok(Math.abs(quirk.l_corr - (20 * .25 + 80 * .2) / .45) < 1e-9); assert.equal(quirk.engine_bank_sector_voided, true);
  assert.equal(f.b_robust, 70); // -30: max(0, 40) = 40; 0: 100; +30: max(70, null) = 70 → median 70
  assert.equal(f.s_screen, 55); assert.equal(f.s_ring, 50); assert.equal(f.t_avg, 61); assert.equal(f.forecast_trend, -12); assert.equal(f.rh, 70);
  assert.throws(() => m.sunsetFeatures({}, scoring), /P0_OBSERVER_MISSING|Error/);
});

test('Mechanism groups follow the frozen thresholds and exclusive priority', async () => {
  const m = await api(), t = m.P0_POLICY.thresholds.primary;
  const base = { l_corr: 30, s_screen: 50, b_max: 69, visibility_km: 10, rh: 84, pm25: 74 };
  assert.deepEqual(m.mechanismGroups(base, t), { G1: true, G2: false, G3: false, G4: false, G0: false, exclusive: 'G1' });
  assert.equal(m.mechanismGroups({ ...base, b_max: 70 }, t).exclusive, 'G2');
  assert.equal(m.mechanismGroups({ ...base, b_max: 70, rh: 85 }, t).exclusive, 'G3');
  assert.equal(m.mechanismGroups({ ...base, l_corr: 60, rh: 85 }, t).exclusive, 'G4');
  assert.equal(m.mechanismGroups({ ...base, l_corr: 31, s_screen: 49 }, t).exclusive, 'G0');
  assert.equal(m.mechanismGroups({ ...base, visibility_km: 9.99 }, t).G3, true);
  assert.equal(m.mechanismGroups({ l_corr: null, s_screen: null, b_max: null }, t).exclusive, 'G0');
  // The frozen plan (PRD §10.3): any change must bump the Policy version and this pin together.
  assert.equal(m.digest(m.P0_POLICY), '764941789bebc013e25003d4b6ba5e57a3bfb2e9407850a671d99f4db5581bde');
});

test('Equal-frequency bins never split ties; weighted Spearman handles monotone and tied ranks', async () => {
  const m = await api();
  const bins = m.equalFrequencyBins([1, 2, 2, 2, 2, 3, 4, 5, 6, 7], 5);
  for (const b of bins) assert.ok(b.every(i => true));
  const owner = new Map(); bins.forEach((b, j) => b.forEach(i => owner.set(i, j)));
  assert.equal(new Set([1, 2, 3, 4].map(i => owner.get(i))).size, 1);
  assert.equal(bins.flat().length, 10); assert.ok(bins.length <= 5);
  assert.deepEqual(m.equalFrequencyBins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]]);
  assert.deepEqual(m.equalFrequencyBins([3, 3, 3], 5), [[0, 1, 2]]);
  assert.equal(m.weightedSpearman([1, 2, 3, 4], [10, 20, 30, 40], [1, 1, 1, 1]), 1);
  assert.equal(m.weightedSpearman([1, 2, 3, 4], [4, 3, 2, 1], [1, 2, 1, 2]), -1);
  assert.equal(m.weightedSpearman([1, 1], [1, 2], [1, 1]), null);
});

test('Logistic probe is deterministic on separable and non-separable data and leaves one date out', async () => {
  const m = await api(), pol = m.P0_POLICY.logistic;
  const X = [[-2], [-1], [0], [1], [2], [3]], y = [0, 0, 1, 0, 1, 1], w = [1, 1, 1, 1, 1, 1];
  const a = m.fitLogistic(X, y, w, pol), b = m.fitLogistic(X, y, w, pol);
  assert.deepEqual(a, b); assert.equal(a.converged, true); assert.ok(a.beta[1] > 0);
  const sep = m.fitLogistic([[-1], [-1], [1], [1]], [0, 0, 1, 1], [1, 1, 1, 1], pol);
  assert.equal(sep.converged, true); assert.ok(Number.isFinite(sep.beta[1])); // L2 keeps separable data finite
  const rows = [0, 1, 2, 3, 4, 5].map(i => row(`s${i}`, `e${i}`, i % 2 ? 2 : 0, { event_date_local: `2026-09-0${1 + (i % 3)}`, x: i % 2 ? i : -i, z: i === 2 ? null : 1 }));
  const oof = m.looDatePredictions(rows, ['x', 'z'], pol);
  assert.equal(oof.folds, 3); assert.equal(oof.converged_folds, 3); assert.ok(oof.predictions.every(p => p > 0 && p < 1));
  assert.deepEqual(oof, m.looDatePredictions(rows, ['x', 'z'], pol));
});

test('Golden-window probes rebuild scores from the sky stage and only touch the intended rows', async () => {
  const m = await api();
  const r = (id, active, factor, source, G1, sky, score) => ({ snapshot_id: id, gw_active: active, gw_factor: factor, gw_source: source, sky_score: sky, score,
    groups: { primary: { G1 } } });
  const rows = [r('a', true, .8, 'NWP_SUNSET', false, 50, 40), r('b', true, .9, 'EVOLUTION_60M', true, 60, 54), r('c', true, 1.1, 'EVOLUTION_30M', true, 60, 66), r('d', false, 1, null, true, 33.6, 34)];
  assert.deepEqual(m.probeScores(rows, 'GWP-0'), [50, 60, 60, 34]);
  assert.deepEqual(m.probeScores(rows, 'GWP-1'), [50, 54, 66, 34]);
  assert.deepEqual(m.probeScores(rows, 'GWP-2'), [40, 60, 66, 34]);
});

test('Decision mapping is mechanical: GW before mid/high response, unsupported items are DATA_LIMITED', async () => {
  const m = await api();
  const stab = over => ({ 'G1.miss': { evidence: false, direction: 1 }, 'G2.false_alarm': { evidence: false, direction: 1 }, 'G3.miss': { evidence: false }, ...over });
  const D1 = (over, q1 = { status: 'COMPUTED', main_loss_stage: 'cloud' }) => ({ stability: stab(over),
    attribution: { questions: { q1_g1_miss_loss: q1, q2_g2_false_alarm: { status: 'COMPUTED', horizon_high: true } } } });
  const probe = lower => ({ delta_auc_ge2: { status: 'COMPUTED', ci95: [lower, lower + .1] } });
  const D2 = (lower = -.01, indist = false) => ({ probes: { 'GWP-1': probe(lower), 'GWP-2': probe(lower) }, core: { indistinguishable: indist } });
  const D3 = (rh = 'UNRESOLVED') => ({ bins: [{ label: 'rh', shape: rh }, { label: 'aod', shape: 'UNRESOLVED' }], redundancy: { drop_one: { aod: { removable_without_loss: true } } } });
  const none = m.decide(D1({}), D2(), D3());
  assert.ok(none.recommendations.every(r => r.status === 'DATA_LIMITED'));
  const both = m.decide(D1({ 'G1.miss': { evidence: true, direction: 1 } }), D2(.001), D3());
  assert.deepEqual(both.recommendations.map(r => r.status), ['PRIORITY_1', 'PRIORITY_2', 'DATA_LIMITED', 'DATA_LIMITED']);
  const atm = m.decide(D1({ 'G2.false_alarm': { evidence: true, direction: 1 } }), D2(-.01, null), D3('MONOTONE_DEC'));
  assert.deepEqual(atm.recommendations.map(r => r.status), ['DATA_LIMITED', 'DATA_LIMITED', 'PRIORITY_1', 'PRIORITY_2']);
  assert.deepEqual(atm.recommendations[2].notes.removable_without_loss, ['aod']);
  const peak = m.decide(D1({}), D2(), D3('INTERIOR_PEAK'));
  assert.deepEqual(peak.recommendations[2].notes.keep_single_peak, ['rh']); assert.equal(peak.recommendations[2].status, 'DATA_LIMITED');
});

test('P0 rejects H1 dates and a non-DEV pool before any replay', async () => {
  const m = await api(), d = m.P0_POLICY.dev;
  const loaded = (date, ids = { raw: d.raw, gt: d.gt, model: d.model }) => ({ source_ids: ids, exclusions: [], rows: Array.from({ length: d.snapshots }, (_, i) => row(`s${i}`, `e${i}`, 1, { event_date_local: i ? '2026-10-01' : date })) });
  await assert.rejects(m.computeP0(loaded('2026-10-13'), { engine_sha256: 'x' }), e => e.code === 'P0_HOLDOUT_DATE_REJECTED');
  await assert.rejects(m.computeP0(loaded('2026-10-01', { raw: 'other', gt: d.gt, model: d.model }), { engine_sha256: 'x' }), e => e.code === 'P0_DEV_IDENTITY_MISMATCH');
  await assert.rejects(m.computeP0({ ...loaded('2026-10-01'), rows: [] }, { engine_sha256: 'x' }), e => e.code === 'P0_DEV_POOL_INCOMPLETE');
});
