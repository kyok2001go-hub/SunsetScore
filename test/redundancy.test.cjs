const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.21 three single-parameter redundancy checks (Policy 16). PRD: ref_docs/PRD/V2.5.5.21--三项单参数去冗余评估方案.md

let modules;
const api = () => modules ||= Promise.all(['practical-tuning/redundancy', 'model-release/release', 'model-release/holdout'].map(n => import(`../tools/${n}.mjs`)))
  .then(([rd, release, holdout]) => ({ ...rd, release, holdout }));
const plain = v => JSON.parse(JSON.stringify(v));

test('Policy 16 plan is frozen around the PRD candidates, gates, lines, baseline and pools', async () => {
  const m = await api(), p = m.RD_POLICY;
  assert.deepEqual([p.practical_tuning_schema_version, p.practical_tuning_policy_version, p.search_space, p.baseline, p.h3_first_date], [16, 16, 'redundancy', 'RELEASE_LINE_2.5.5.19', '2026-11-16']);
  assert.deepEqual([...p.candidate_order], ['T0', 'W0', 'G1']);
  assert.deepEqual([...p.lines.current], [19, 49, 66, 90]);
  assert.deepEqual([p.gates.overall_ge2_recall_floor, p.gates.auc_drop_tolerance, plain(p.gates.period_split)], [0.6, 0.02, [['DEV'], ['H1', 'H2']]]);
  assert.deepEqual([p.report_only.W0_02, p.report_only.GREF_reference], [0.02, 0.839856]);
  assert.equal(p.baseline_reference.run_id, 'practical_tuning_v15_462a4c08949a2e9bba34');
  assert.deepEqual(p.pools.map(x => x.name), ['DEV', 'H1', 'H2']);
});

test('candidate configs differ from 2.5.5.19 only in the declared keys; G1 never touches the config', async () => {
  const m = await api(), C0 = (await m.holdout.releaseConfigs())['2.5.5.19'];
  const paths = cfg => m.release.differences(C0, cfg).map(d => d.path).sort();
  assert.deepEqual(paths(m.candidateConfig(C0, ['T0'])), ['weatherRegime.transitionBonusLimit']);
  assert.deepEqual(paths(m.candidateConfig(C0, ['W0'])), ['weatherRegime.minimumWeatherWeight']);
  assert.deepEqual(paths(m.candidateConfig(C0, ['G1'])), []);
  assert.deepEqual(paths(m.candidateConfig(C0, ['T0', 'W0', 'G1'])), ['weatherRegime.minimumWeatherWeight', 'weatherRegime.transitionBonusLimit']);
  assert.deepEqual(paths(m.candidateConfig(C0, [], { reference: 0.839856 })), ['goldenWindow.reference']);
  assert.equal(m.candidateConfig(C0, [], { minimumWeatherWeight: 0.02 }).weatherRegime.minimumWeatherWeight, 0.02);
  assert.equal(C0.weatherRegime.transitionBonusLimit, 5, 'the base config is not mutated');
  assert.deepEqual(['C0', 'T0', 'G1', 'T0W0', 'T0G1', 'W0G1', 'T0W0G1'].map((k, i) => k),
    [[], ['T0'], ['G1'], ['W0', 'T0'], ['G1', 'T0'], ['W0', 'G1'], ['G1', 'W0', 'T0']].map(m.keyOf));
});

// Engine behaviour of T0 and W0 on a changing sky (the regime improves towards sunset).
function runEngine(patch) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  patch(SS.config);
  const layers = { cloud: [95, 90, 60, 30, 20], low: [80, 70, 30, 10, 5], mid: 40, high: 50, precipitation: [1.5, 0.8, 0, 0, 0] };
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(layers) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  let trace = null;
  const result = SS.engine.compute({ location: { name: 'Fixture', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: SS.cloudField.buildCloudField(sky, sunset), expectedSampleCount: 13,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0, offlineTrace: t => { trace = t; } });
  return { result, trace };
}
test('T0 sets the transition bonus to zero; W0 removes the weather weight and keeps the other four in proportion', () => {
  const base = runEngine(() => {}), t0 = runEngine(c => { c.weatherRegime.transitionBonusLimit = 0; }), w0 = runEngine(c => { c.weatherRegime.minimumWeatherWeight = 0; });
  assert.equal(t0.result.transition_bonus, 0);
  assert.equal(w0.trace.dynamic_weights.weather, 0);
  assert.ok(base.trace.dynamic_weights.weather > 0, 'the floor keeps a weather weight in production');
  const ratio = k => w0.trace.dynamic_weights[k] / base.trace.dynamic_weights[k];
  for (const k of ['skyCanvas', 'illumination', 'atmosphere']) assert.ok(Math.abs(ratio(k) - ratio('horizon')) < 1e-9, k + ' keeps its proportion');
  assert.ok(Math.abs(['skyCanvas', 'horizon', 'illumination', 'atmosphere'].reduce((s, k) => s + w0.trace.dynamic_weights[k], 0) - 1) < 1e-9);
});

test('golden-window cap only lowers boosted scores; the V2.5.5.2 reference rule is reproduced', async () => {
  const m = await api();
  assert.deepEqual([[50, 1.2], [50, 1], [50, 0.8], [90, 1.15], [0, 1.1], [100, 0.5]].map(([s, f]) => m.capGoldenWindow(s, f)), [50, 50, 40, 90, 0, 50]);
  const floor = 0.507692307692;
  assert.equal(m.referenceByRule([0, 1], floor), Number(((floor + 1) / 2).toFixed(6)));
  assert.equal(m.referenceByRule([NaN, 1], floor), 1);
  assert.equal(m.referenceByRule([], floor), null);
});

test('gates and decision follow §5: four conditions, combination only when two or more pass, best single otherwise', async () => {
  const m = await api(), rows = [];
  let n = 0;
  // 24 dates × 2 pools; GT 0/1 rows boosted in C0 (scores 50–56) and lowered by T0 and W0; good rows unchanged; G1 changes nothing.
  for (let d = 0; d < 24; d++) for (const [gt, c0, t0, w0] of [[1, 52, 45, 47], [0, 50, 44, 46], [1, 56, 48, 48], [2, 60, 60, 60], [3, 70, 70, 70], [2, 58, 58, 58]]) {
    const pool = d < 12 ? 'DEV' : d < 18 ? 'H1' : 'H2', id = String(n++).padStart(4, '0');
    rows.push({ snapshot_id: 's' + id, event_id: 'e' + id, event_date_local: `2026-10-${String(d + 1).padStart(2, '0')}`, pool, slot: d % 2 ? 'EVENING' : '1213',
      lead_time_minutes: 30, gt_ordinal: gt, gt_confidence: 0.6, weight: 1,
      scores: { C0: c0, T0: t0, W0: w0, G1: c0, T0W0: Math.min(t0, w0) - 1, T0G1: t0, W0G1: w0, T0W0G1: Math.min(t0, w0) - 1, W0_02: c0, GREF: c0 } });
  }
  const e = m.evaluateAll(rows);
  assert.deepEqual(Object.keys(e.singles.T0.gates), ['G1_loss_upper_below_0', 'G2_auc_ge2_lower_above_minus_tolerance', 'G3_overall_ge2_recall_at_floor', 'G4_both_periods_lower']);
  assert.equal(e.singles.T0.decision, 'ADOPT_CANDIDATE'); assert.equal(e.singles.W0.decision, 'ADOPT_CANDIDATE');
  assert.equal(e.singles.G1.decision, 'NO_GAIN', 'no change is no gain');
  assert.deepEqual(e.adopted, ['T0', 'W0']);
  assert.equal(e.combination.key, 'T0W0'); assert.deepEqual(e.combination.parts, ['T0', 'W0']);
  // T0 and W0 already remove every false alarm; the combination is not lower than the best single, so the best single is recommended.
  assert.equal(e.singles.T0.candidate.product_loss, e.singles.W0.candidate.product_loss);
  assert.equal(e.recommended, 'T0', 'ties go to the earlier candidate');
  assert.equal(e.decision, 'ADOPT_CANDIDATE');
  assert.deepEqual(e.singles.T0.changes, { score_up: 0, score_down: 72, grade_up: 0, grade_down: 72 });
  assert.deepEqual(Object.keys(e.report_only.extra), ['W0_02', 'GREF']);
  assert.deepEqual(Object.keys(e.report_only.by_slot), ['1213', 'EVENING']);
  // Nothing passes → NO_GAIN and no combination.
  const none = m.evaluateAll(rows.map(r => ({ ...r, scores: { ...r.scores, T0: r.scores.C0, W0: r.scores.C0 } })));
  assert.deepEqual([none.decision, none.recommended, none.combination], ['NO_GAIN', null, null]);
  // A candidate that lowers recall below 0.60 fails G3 even when the loss improves.
  const harsh = m.evaluateAll(rows.map(r => ({ ...r, scores: { ...r.scores, T0: r.gt_ordinal === 2 ? 40 : Math.min(r.scores.T0, r.scores.C0) } })));
  assert.equal(harsh.singles.T0.gates.G3_overall_ge2_recall_at_floor, false); assert.equal(harsh.singles.T0.decision, 'NO_GAIN');
});
