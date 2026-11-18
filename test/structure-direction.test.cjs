const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.24 necessary-condition structure and direction fixes (Policy 18). PRD: ref_docs/PRD/V2.5.5.24--必要条件结构与方向纠正评估方案.md

let modules;
const api = () => modules ||= Promise.all(['practical-tuning/structure-direction', 'model-release/release', 'model-release/holdout'].map(n => import(`../tools/${n}.mjs`)))
  .then(([sd, release, holdout]) => ({ ...sd, release, holdout }));
const KEYS = ['canvasLightAccess', 'gradientDirection', 'viewOcclusion'];

// Engine with a sky whose layers may depend on the node distance (km); sunset azimuth 270 lies exactly on the W ray.
function runEngine(layersAt, patch = () => {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  for (const k of KEYS) delete SS.config[k]; patch(SS.config);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(typeof layersAt === 'function' ? layersAt(p.distanceKm) : layersAt) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  let trace = null;
  const result = SS.engine.compute({ location: { name: 'Fixture', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: SS.cloudField.buildCloudField(sky, sunset), expectedSampleCount: 13,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0, offlineTrace: t => { trace = t; } });
  return { result, trace };
}
const HALF_LOW = { cloud: 70, low: 50, mid: 40, high: 50, precipitation: 0, precipitationProbability: 5, visibility: 20000 };
const ramp = values => d => ({ cloud: 60, low: 5, mid: values[d], high: values[d], precipitation: 0, precipitationProbability: 5, visibility: 20000 });
const FAR_BANK = ramp({ 0: 10, 50: 10, 100: 20, 200: 60, 300: 70 }), NEAR_CLOUD = ramp({ 0: 70, 50: 70, 100: 60, 200: 20, 300: 10 });

test('keys absent: identical to identity values; trace carries structure_direction only when a key is configured', () => {
  for (const layers of [HALF_LOW, FAR_BANK, NEAR_CLOUD]) {
    const base = runEngine(layers), neutral = runEngine(layers, c => { c.canvasLightAccess = { gamma: 0 }; c.viewOcclusion = { alpha: 0 }; });
    assert.equal(neutral.result.score, base.result.score); assert.equal(neutral.trace.P, base.trace.P);
    assert.deepEqual(JSON.parse(JSON.stringify(neutral.trace.contributions)), JSON.parse(JSON.stringify(base.trace.contributions)));   // engine objects come from another realm
    assert.equal('structure_direction' in base.trace, false);
    assert.equal(neutral.trace.structure_direction.access_factor, 1);
  }
});

test('A and C: sky-canvas and illumination contributions are scaled; horizon, atmosphere and weather are not', () => {
  // Low cloud 50% everywhere: corridor opening 50, local low 50.
  const base = runEngine(HALF_LOW), a = runEngine(HALF_LOW, c => { c.canvasLightAccess = { gamma: 1 }; }), v = runEngine(HALF_LOW, c => { c.viewOcclusion = { alpha: 0.6 }; });
  const both = runEngine(HALF_LOW, c => { c.canvasLightAccess = { gamma: 1 }; c.viewOcclusion = { alpha: 0.6 }; });
  assert.ok(Math.abs(a.trace.structure_direction.corridor_opening - 50) < 1e-9); assert.equal(v.trace.structure_direction.local_low, 50);
  const close = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
  for (const [run, f] of [[a, 0.5], [v, 0.7], [both, 0.35]]) {
    close(run.trace.structure_direction.access_factor, f);
    close(run.trace.contributions.skyCanvas, base.trace.contributions.skyCanvas * f);
    close(run.trace.contributions.illumination, base.trace.contributions.illumination * f);
    for (const k of ['horizon', 'atmosphere', 'weather']) close(run.trace.contributions[k], base.trace.contributions[k]);
    close(run.trace.P, Object.values(run.trace.contributions).reduce((s, x) => s + x, 0));
    assert.ok(run.result.score <= base.result.score);
  }
});

test('B: NEUTRAL drops the far-bank bonus; REVERSED moves it to near-cloud / far-clear skies', () => {
  const g = (layers, d) => runEngine(layers, c => { if (d) c.gradientDirection = d; c.canvasLightAccess = { gamma: 0 }; }).trace;
  const far = g(FAR_BANK), near = g(NEAR_CLOUD);
  assert.ok(far.structure_direction.gradient > 30 && near.structure_direction.gradient < -30, 'fixtures sit beyond ±30');
  assert.equal(far.structure_bonus, 5); assert.equal(near.structure_bonus, 0);
  assert.equal(g(FAR_BANK, 'NEUTRAL').structure_bonus, 0); assert.equal(g(NEAR_CLOUD, 'NEUTRAL').structure_bonus, 0);
  assert.equal(g(FAR_BANK, 'REVERSED').structure_bonus, 0); assert.equal(g(NEAR_CLOUD, 'REVERSED').structure_bonus, 5);
  // The gradient enters the sky canvas (structure score) with the configured sign: far bank loses, near cloud gains under REVERSED.
  assert.ok(g(FAR_BANK, 'NEUTRAL').components.skyCanvas < far.components.skyCanvas);
  assert.ok(g(NEAR_CLOUD, 'REVERSED').components.skyCanvas > near.components.skyCanvas);
  assert.equal(g(NEAR_CLOUD, 'NEUTRAL').components.skyCanvas, near.components.skyCanvas, 'clamp(g, 0, 100) is already 0 for a negative gradient');
});

test('Policy 18 plan: grids, line rule, gates and baseline are frozen; member keys round-trip', async () => {
  const m = await api(), p = m.SD_POLICY;
  assert.deepEqual([p.practical_tuning_schema_version, p.practical_tuning_policy_version, p.search_space, p.baseline, p.h3_first_date], [18, 18, 'structure-direction', 'RELEASE_LINE_2.5.5.19', '2026-11-16']);
  assert.deepEqual([[...p.grids.A], [...p.grids.B], [...p.grids.C]], [[0, 0.5, 1, 2], [null, 'NEUTRAL', 'REVERSED'], [0, 0.3, 0.6, 0.9]]);
  assert.deepEqual([p.lines.ge2_recall_floor, p.lines.ge2_recall_scope, p.lines.ge3_recall_floor, p.lines.overall_ge2_recall_floor, [...p.lines.current]], [0.65, 'CLOUD_TYPE', 0.2, 0.6, [19, 49, 66, 90]]);
  assert.equal(p.baseline_reference.signature_sha256, 'ae1ded3b0eceb491c1d7fd54679befd5f5239cc8c12730250038fc78de730f1c');
  assert.deepEqual(m.familyKeys('A'), ['C0', 'A_g0.5', 'A_g1', 'A_g2']);
  assert.deepEqual(m.familyKeys('B'), ['C0', 'B_NEUTRAL', 'B_REVERSED']);
  assert.deepEqual(m.familyKeys('C'), ['C0', 'C_a0.3', 'C_a0.6', 'C_a0.9']);
  for (const key of ['C0', 'A_g2', 'B_REVERSED', 'C_a0.6', 'A_g0.5+B_NEUTRAL', 'A_g1+B_REVERSED+C_a0.9']) assert.equal(m.memberKey(m.parseMemberKey(key)), key);
  assert.throws(() => m.parseMemberKey('Z_1'), /SD_BAD_MEMBER_KEY/);
});

test('candidate configs differ from 2.5.5.19 only in the configured keys', async () => {
  const m = await api(), C0 = (await m.holdout.releaseConfigs())['2.5.5.19'];
  const paths = cfg => m.release.differences(C0, cfg).map(d => d.path).sort();
  assert.deepEqual(paths(m.candidateConfig(C0, m.parseMemberKey('C0'))), []);
  assert.deepEqual(paths(m.candidateConfig(C0, m.parseMemberKey('A_g1'))), ['canvasLightAccess.gamma']);
  assert.deepEqual(paths(m.candidateConfig(C0, m.parseMemberKey('B_NEUTRAL'))), ['gradientDirection']);
  assert.deepEqual(paths(m.candidateConfig(C0, m.parseMemberKey('C_a0.3'))), ['viewOcclusion.alpha']);
  assert.deepEqual(paths(m.candidateConfig(C0, m.parseMemberKey('A_g2+B_REVERSED+C_a0.9'))), ['canvasLightAccess.gamma', 'gradientDirection', 'viewOcclusion.alpha']);
  assert.ok(KEYS.every(k => !(k in C0)), 'the released config carries none of the three keys');
  assert.deepEqual(paths(m.neutralConfig(C0)), ['canvasLightAccess.gamma', 'viewOcclusion.alpha']);
});

test('selection, cross-validation, gates, combination members and the decision follow §5 on a synthetic pool', async () => {
  const m = await api(), rows = [];
  let n = 0;
  // A_g1 separates good sunsets (45 → 58) from poor ones; every other member is a copy of C0.
  const copies = ['A_g0.5', 'A_g2', 'B_NEUTRAL', 'B_REVERSED', 'C_a0.3', 'C_a0.6', 'C_a0.9'];
  for (let d = 0; d < 40; d++) for (const [gt, c0, a] of [[1, 52, 52], [0, 50, 50], [1, 55, 55], [2, 45, 58], [3, 72, 72], [2, 60, 60], [1, 30, 30], [0, 20, 20], [2, 40, 41], [1, 63, 62]]) {
    const id = String(n++).padStart(4, '0'), pool = d < 16 ? 'DEV' : d < 28 ? 'H1' : 'H2';
    rows.push({ snapshot_id: 's' + id, event_id: 'e' + id, event_date_local: `2026-${d < 30 ? '10' : '11'}-${String(d % 30 + 1).padStart(2, '0')}`, pool, slot: d % 3 ? '1213' : 'EVENING',
      lead_time_minutes: 30, gt_ordinal: gt, gt_confidence: 0.6, weight: 1, recall_exempt: false, review_kind: null,
      corridor_opening: c0 === 45 ? 70 : 95, local_low: c0 === 30 ? 60 : 10, gradient: c0 === 72 ? -40 : 0,
      scores: { C0: c0, A_g1: a, ...Object.fromEntries(copies.map(k => [k, c0])) } });
  }
  const fam = m.evaluateFamilies(rows);
  assert.deepEqual(Object.keys(fam.A.gates), ['G1_better_than_L0', 'G2_cloud_type_ge2_recall_cv5_cv11_at_floor', 'G3_cross_period_both_lower', 'G4_auc_ge2_lower_above_minus_tolerance', 'G5_overall_ge2_recall_cv5_cv11_at_floor']);
  assert.equal(fam.A.cv5.folds.length, 5); assert.equal(fam.A.cv11.folds.length, 11);
  assert.ok(fam.A.cv5.folds.every(f => f.member === 'A_g1'), 'the separating member is chosen in every fold');
  for (const f of ['B', 'C']) { assert.ok(fam[f].cv5.folds.every(x => x.member === 'C0'), `${f}: C0 is listed first, so copies never displace it`); assert.notEqual(fam[f].decision, 'WORTH_H4'); }
  assert.equal(m.needsCombination(fam), false);
  const e = m.evaluateAll(rows, m.SD_POLICY, fam);
  assert.equal(e.combination, null); assert.equal(e.recommended, fam.A.decision === 'WORTH_H4' ? 'A' : null);
  assert.equal(Object.keys(e.report_only.members_at_current_lines).length, 1 + 3 + 2 + 3);
  const r = fam.A.report;
  assert.equal(r.corridor_opening_below.snapshots, 40); assert.equal(r.local_low_at_least.snapshots, 40); assert.equal(r.gradient_at_most_minus.snapshots, 40); assert.equal(r.gradient_at_least.snapshots, 0);
  assert.equal(r.corridor_opening_below.mean_score_change, 13, 'the 45 → 58 rows sit in the low-opening subgroup');
  // Two passing families: combination members are the tuples the folds chose, and rows carrying them are required.
  const asPassing = (F, key) => ({ ...F, decision: 'WORTH_H4', cv5: { ...F.cv5, folds: F.cv5.folds.map(f => ({ ...f, member: key })) },
    cv11: { ...F.cv11, folds: F.cv11.folds.map(f => ({ ...f, member: key })) }, cross_period: F.cross_period.map(c => ({ ...c, member: key })), full_data_choice: { key } });
  const two = { ...fam, A: asPassing(fam.A, 'A_g1'), C: asPassing(fam.C, 'C_a0.6') };
  assert.equal(m.needsCombination(two), true);
  assert.deepEqual(m.combinationMembers(two), ['A_g1+C_a0.6']);
  assert.throws(() => m.evaluateAll(rows, m.SD_POLICY, two), /SD_COMBINATION_ROWS_MISSING/);
});
