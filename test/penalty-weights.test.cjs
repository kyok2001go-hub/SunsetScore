const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.22 weather-penalty scale and component weights (Policy 17). PRD: ref_docs/PRD/V2.5.5.22--天气扣分幅度与组件权重评估方案.md

let modules;
const api = () => modules ||= Promise.all(['practical-tuning/penalty-weights', 'model-release/release', 'model-release/holdout'].map(n => import(`../tools/${n}.mjs`)))
  .then(([pw, release, holdout]) => ({ ...pw, release, holdout }));
const plain = v => JSON.parse(JSON.stringify(v));

// Engine with a configurable sky: rain + low visibility trigger the rain and haze penalties, a storm regime the storm penalty.
function runEngine(layers, patch = () => {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  delete SS.config.penaltyScale; patch(SS.config);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(layers) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  let trace = null;
  const result = SS.engine.compute({ location: { name: 'Fixture', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: SS.cloudField.buildCloudField(sky, sunset), expectedSampleCount: 13,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0, offlineTrace: t => { trace = t; } });
  return { result, trace };
}
const RAIN_HAZE = { cloud: 70, low: 40, mid: 40, high: 40, precipitation: 1.5, precipitationProbability: 80, visibility: 4000 };
const STORM = { cloud: 95, low: 85, mid: 70, high: 60, precipitation: 3, precipitationProbability: 90, windSpeed: 60, windGusts: 90, pressure: 990, visibility: 9000 };
const CLEAN = { cloud: 40, low: 5, mid: 30, high: 40, precipitation: 0, precipitationProbability: 5, visibility: 20000 };

test('penaltyScale: absent or 1 changes nothing; 0.5 halves the summed penalty for rain, haze and storm skies; only the penalty term moves', () => {
  for (const layers of [RAIN_HAZE, STORM, CLEAN]) {
    const base = runEngine(layers), one = runEngine(layers, c => { c.penaltyScale = 1; }), half = runEngine(layers, c => { c.penaltyScale = 0.5; });
    assert.equal(one.result.score, base.result.score); assert.equal(one.trace.weather_penalty, base.trace.weather_penalty);
    assert.ok(Math.abs(half.trace.weather_penalty - base.trace.weather_penalty / 2) < 1e-9);
    assert.equal(half.trace.P, base.trace.P); assert.equal(half.trace.Q, base.trace.Q);
    if (base.trace.weather_penalty > 0) assert.ok(half.result.score >= base.result.score);
  }
  assert.ok(runEngine(RAIN_HAZE).trace.weather_penalty > 0, 'the rain/haze fixture is penalised');
  assert.equal(runEngine(CLEAN).trace.weather_penalty, 0, 'the clean fixture is not penalised');
});

test('Policy 17 plan: grids, line rule, gates and baseline are frozen; the weight grid has 37 members summing to 0.975', async () => {
  const m = await api(), p = m.PW_POLICY;
  assert.deepEqual([p.practical_tuning_schema_version, p.practical_tuning_policy_version, p.search_space, p.baseline, p.h3_first_date], [17, 17, 'penalty-weights', 'RELEASE_LINE_2.5.5.19', '2026-11-16']);
  assert.deepEqual([...p.penalty_grid], [0.5, 0.75, 1]);
  assert.deepEqual([p.lines.ge2_recall_floor, p.lines.ge2_recall_scope, p.lines.ge3_recall_floor, p.lines.overall_ge2_recall_floor, [...p.lines.current]], [0.65, 'CLOUD_TYPE', 0.2, 0.6, [19, 49, 66, 90]]);
  assert.equal(p.baseline_reference.signature_sha256, 'ae1ded3b0eceb491c1d7fd54679befd5f5239cc8c12730250038fc78de730f1c');
  const grid = m.weightGrid();
  assert.equal(grid.length, 37);
  assert.ok(grid.every(w => Math.abs(w.skyCanvas + w.horizon + w.illumination - 0.975) < 1e-9 && w.illumination >= 0.25 - 1e-9 && w.illumination <= 0.55 + 1e-9));
  assert.equal(grid.filter(w => m.weightKey(w) === 'C0').length, 1, 'the current weights are in the grid exactly once');
  assert.deepEqual(m.familyKeys('P'), ['C0', 'P0.5', 'P0.75']);
  assert.equal(m.familyKeys('W')[0], 'C0', 'ties keep the current weights');
  assert.equal(m.familyKeys('W').length, 37);
  assert.deepEqual(m.parseWeightKey('W_s0.1_h0.475'), { skyCanvas: 0.1, horizon: 0.475, illumination: 0.4 });
  assert.equal(m.parsePenaltyKey('P0.75'), 0.75);
  assert.equal(m.comboKey(0.5, { skyCanvas: 0.2, horizon: 0.375 }), 'P0.5'); assert.equal(m.comboKey(1, { skyCanvas: 0.1, horizon: 0.475 }), 'W_s0.1_h0.475');
  assert.equal(m.comboKey(0.5, { skyCanvas: 0.1, horizon: 0.475 }), 'P0.5+W_s0.1_h0.475');
});

test('candidate configs differ from 2.5.5.19 only in penaltyScale and the three weights', async () => {
  const m = await api(), C0 = (await m.holdout.releaseConfigs())['2.5.5.19'];
  const paths = cfg => m.release.differences(C0, cfg).map(d => d.path).sort();
  assert.deepEqual(paths(m.candidateConfig(C0, { penaltyScale: 0.5 })), ['penaltyScale']);
  assert.deepEqual(paths(m.candidateConfig(C0, { penaltyScale: 1 })), [], 'scale 1 leaves the key absent');
  assert.deepEqual(paths(m.candidateConfig(C0, { weights: { skyCanvas: 0.1, horizon: 0.475, illumination: 0.4 } })), ['weights.horizon', 'weights.skyCanvas']);
  assert.deepEqual(paths(m.candidateConfig(C0, { penaltyScale: 0.75, weights: { skyCanvas: 0.25, horizon: 0.325, illumination: 0.4 } })), ['penaltyScale', 'weights.horizon', 'weights.skyCanvas']);
  assert.equal('penaltyScale' in C0, false); assert.equal(C0.weights.horizon, 0.375);
});

test('selection, cross-validation, gates and the decision follow §5 on a synthetic pool', async () => {
  const m = await api(), rows = [];
  let n = 0;
  // An overly large penalty pushes some good sunsets (45) below poor ones (50–55): re-selected lines cannot fix that, P0.5 can.
  // The weight members are copies of C0.
  const wKeys = m.familyKeys('W').filter(k => k !== 'C0');
  for (let d = 0; d < 40; d++) for (const [gt, c0, p] of [[1, 52, 52], [0, 50, 50], [1, 55, 55], [2, 45, 58], [3, 72, 72], [2, 60, 60], [1, 30, 30], [0, 20, 20], [2, 40, 41], [1, 63, 62]]) {
    // The last two rows overlap the classes, as real data does, so the unpenalised logistic fit converges.
    const id = String(n++).padStart(4, '0'), pool = d < 16 ? 'DEV' : d < 28 ? 'H1' : 'H2';
    rows.push({ snapshot_id: 's' + id, event_id: 'e' + id, event_date_local: `2026-${d < 30 ? '10' : '11'}-${String(d % 30 + 1).padStart(2, '0')}`, pool, slot: d % 3 ? '1213' : 'EVENING',
      lead_time_minutes: 30, gt_ordinal: gt, gt_confidence: 0.6, weight: 1, weather_penalty: c0 !== p ? 10 : 0, recall_exempt: false, review_kind: null,
      scores: { C0: c0, 'P0.5': p, 'P0.75': Math.round((c0 + p) / 2), ...Object.fromEntries(wKeys.map(k => [k, c0])) } });
  }
  const fam = m.evaluateFamilies(rows);
  assert.deepEqual(Object.keys(fam.P.gates), ['G1_better_than_L0', 'G2_cloud_type_ge2_recall_cv5_cv11_at_floor', 'G3_cross_period_both_lower', 'G4_auc_ge2_lower_above_minus_tolerance', 'G5_overall_ge2_recall_cv5_cv11_at_floor']);
  assert.equal(fam.P.cv5.folds.length, 5); assert.equal(fam.P.cv11.folds.length, 11);
  assert.ok(fam.P.cv5.folds.every(f => f.member !== 'C0'), 'the separating penalty member is chosen in every fold');
  assert.ok(fam.W.cv5.folds.every(f => f.member === 'C0'), 'C0 is listed first, so copies of C0 never displace it on a tie');
  assert.equal(fam.W.decision === 'WORTH_H4', false, 'a family identical to C0 cannot beat lines-only');
  assert.equal(m.needsCombination(fam), false);
  const e = m.evaluateAll(rows, m.PW_POLICY, fam);
  assert.equal(e.combination, null);
  assert.equal(e.recommended, fam.P.decision === 'WORTH_H4' ? 'P' : null);
  assert.equal(e.report_only.weight_sensitivity.length, 37);
  assert.equal(fam.P.report.penalised.snapshots, rows.filter(r => r.weather_penalty > 0).length);
  // When both families pass, the combination members are the pairs the folds actually chose, and rows are required.
  const both = { ...fam, W: { ...fam.P, cv5: { ...fam.P.cv5, folds: fam.P.cv5.folds.map(f => ({ ...f, member: 'W_s0.1_h0.475' })) },
    cv11: { ...fam.P.cv11, folds: fam.P.cv11.folds.map(f => ({ ...f, member: 'W_s0.1_h0.475' })) },
    cross_period: fam.P.cross_period.map(c => ({ ...c, member: 'W_s0.1_h0.475' })), full_data_choice: { key: 'W_s0.1_h0.475' }, decision: 'WORTH_H4' }, P: { ...fam.P, decision: 'WORTH_H4' } };
  const pairs = m.combinationPairs(both.P, both.W);
  assert.ok([...pairs.keys()].every(k => /^(P0\.5|P0\.75|C0)?\+?W_s0\.1_h0\.475$|^W_s0\.1_h0\.475$/.test(k)));
  assert.throws(() => m.evaluateAll(rows, m.PW_POLICY, both), /PW_COMBINATION_ROWS_MISSING/);
});
