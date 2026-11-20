const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.31 sky-canvas / illumination merge (Policy 19). PRD: ref_docs/PRD/V2.5.5.31--云幕与光照组件合并方案.md

let modules;
const api = () => modules ||= Promise.all(['practical-tuning/canvas-merge', 'practical-tuning/canvas-merge-workflow', 'model-release/holdout', 'tuning/parameter-registry']
  .map(n => import(`../tools/${n}.mjs`))).then(([cm, wf, holdout, registry]) => ({ ...cm, wf, holdout, registry }));
const LAYERS = { cloud: 60, low: 10, mid: 45, high: 50, precipitation: 0, precipitationProbability: 5, visibility: 20000 };
const plain = x => JSON.parse(JSON.stringify(x));   // engine objects come from another realm
const close = (x, y, tol = 1e-9) => assert.ok(Math.abs(x - y) <= tol, `${x} vs ${y}`);

function runEngine(patch = () => {}, { layers = LAYERS, twilight = 30 } = {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  delete SS.config.canvasMerge; patch(SS.config);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(layers) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  let trace = null;
  const result = SS.engine.compute({ location: { name: 'Fixture', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: twilight },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: SS.cloudField.buildCloudField(sky, sunset), expectedSampleCount: 13, illuminationTrace: true,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0, offlineTrace: t => { trace = t; } });
  return { result, trace: plain(trace), regime: result.regime };
}
const merge = (s, k, f = null) => c => { c.canvasMerge = { skyCanvasShare: s, scale: k, twilightFloor: f }; };

test('key absent: production config carries no canvasMerge; trace has no canvas_merge and keeps the illumination component', () => {
  const SS = load(createRuntime(), CORE_FILES);
  assert.equal('canvasMerge' in SS.config, false);
  const base = runEngine();
  assert.equal('canvas_merge' in base.trace, false);
  assert.equal(typeof base.trace.components.illumination, 'number');
  assert.ok(base.trace.dynamic_weights.illumination > 0);
});

test('Canvas = k × [s × SkyCanvas + (1 − s) × cbp × data factor]; s = 0 / 1 ends; k = 0.885 and 1; illumination leaves the score', () => {
  const base = runEngine(), S = base.trace.components.skyCanvas, cbp = base.trace.illumination_internal.formula.cloud_bank_potential;
  assert.notEqual(Math.round(S), Math.round(cbp), 'fixture separates the two parts');
  for (const [s, k] of [[1 / 3, 0.885], [1 / 3, 1], [0, 0.885], [1, 1], [0, 1]]) {
    const run = runEngine(merge(s, k)), cm = run.trace.canvas_merge;
    close(cm.sky_canvas_original, S); close(cm.cloud_bank_potential, cbp); assert.equal(cm.data_factor, 1);
    close(cm.value, k * (s * S + (1 - s) * cbp));
    close(run.trace.components.skyCanvas, cm.value);
    assert.equal(run.trace.components.illumination, null);
    assert.equal(run.trace.dynamic_weights.illumination, 0); assert.equal(run.trace.contributions.illumination, 0);
    close(run.trace.contributions.skyCanvas, run.trace.dynamic_weights.skyCanvas * cm.value);
    close(run.trace.P, Object.values(run.trace.contributions).reduce((a, x) => a + x, 0));
    assert.equal(run.result.components.sky_canvas, Math.round(cm.value));
    assert.equal(cm.twilight_factor, 1); assert.equal(cm.twilight_minutes, 30);
  }
  // Same P as the component-level rebuild used in the 2026-11-20 exploration.
  const m1 = runEngine(merge(1 / 3, 0.885)), dw = base.trace.dynamic_weights;
  close(m1.trace.P, base.trace.P - dw.skyCanvas * S - dw.illumination * base.trace.components.illumination + (dw.skyCanvas + dw.illumination) * m1.trace.canvas_merge.value);
});

test('merged dynamic weight equals the two original weights in all seven regimes; the other weights are unchanged', () => {
  const regime = runEngine().regime, SS = load(createRuntime(), CORE_FILES), all = Object.keys(SS.config.weatherRegime.weights);
  assert.equal(all.length, 7);
  for (const R of all) {
    const use = extra => c => { c.weatherRegime.weights[regime] = { ...c.weatherRegime.weights[R] }; extra(c); };
    const a = runEngine(use(() => {})), b = runEngine(use(merge(1 / 3, 0.885))), m = SS.config.weatherRegime.weights[R], w = SS.config.weights;
    close(b.trace.dynamic_weights.skyCanvas, a.trace.dynamic_weights.skyCanvas + a.trace.dynamic_weights.illumination, 1e-12);
    for (const k of ['horizon', 'atmosphere', 'weather']) close(b.trace.dynamic_weights[k], a.trace.dynamic_weights[k], 1e-12);
    close(b.trace.canvas_merge.merged_multiplier, (w.skyCanvas * m.skyCanvas + w.illumination * m.illumination) / (w.skyCanvas + w.illumination), 1e-12);
  }
});

test('twilightFloor: factor f + (1 − f) × clamp(t / 35) at 0 / 17.5 / 35 / 50 minutes; null ignores twilight', () => {
  const f = 0.53;
  for (const [t, factor] of [[0, 0.53], [17.5, 0.765], [35, 1], [50, 1]]) {
    const run = runEngine(merge(1 / 3, 1, f), { twilight: t }), plainRun = runEngine(merge(1 / 3, 1), { twilight: t }), cm = run.trace.canvas_merge;
    close(cm.twilight_factor, factor); close(cm.value, plainRun.trace.canvas_merge.value * factor);
    assert.equal(plainRun.trace.canvas_merge.twilight_factor, 1);
  }
  // Without twilightFloor the merged score does not depend on twilight; the original model does.
  assert.equal(runEngine(merge(1 / 3, 0.885), { twilight: 10 }).trace.canvas_merge.value, runEngine(merge(1 / 3, 0.885), { twilight: 30 }).trace.canvas_merge.value);
  assert.notEqual(runEngine(() => {}, { twilight: 10 }).trace.components.illumination, runEngine(() => {}, { twilight: 30 }).trace.components.illumination);
});

test('data factor fallback (no usable distance band) multiplies the cbp part only', () => {
  const noBands = c => { c.spatialField.distanceBands = {}; };
  const base = runEngine(noBands), run = runEngine(c => { noBands(c); merge(1 / 3, 1)(c); }), cm = run.trace.canvas_merge;
  assert.equal(base.trace.illumination_internal.spatial.data_factor, cm.data_factor);
  assert.ok(cm.data_factor < 1, `data factor ${cm.data_factor}`);
  close(cm.value, base.trace.components.skyCanvas / 3 + (2 / 3) * base.trace.illumination_internal.formula.cloud_bank_potential * cm.data_factor);
});

test('invalid canvasMerge values are rejected', () => {
  for (const bad of [{ skyCanvasShare: -0.1, scale: 1 }, { skyCanvasShare: 1.2, scale: 1 }, { skyCanvasShare: 0.5, scale: 0 }, { skyCanvasShare: 0.5 },
    { skyCanvasShare: 0.5, scale: 1, twilightFloor: 1.5 }, { skyCanvasShare: 'x', scale: 1 }])
    assert.throws(() => runEngine(c => { c.canvasMerge = bad; }), /INVALID_CANVAS_MERGE/);
});

test('Policy 19 plan is frozen: members, primary, rule thresholds, lines, baseline', async () => {
  const m = await api(), p = m.CM_POLICY;
  assert.deepEqual([p.practical_tuning_schema_version, p.practical_tuning_policy_version, p.search_space, p.baseline, p.h3_first_date, p.primary],
    [19, 19, 'canvas-merge', 'RELEASE_LINE_2.5.5.19', '2026-11-16', 'M1']);
  assert.deepEqual(plain(Object.fromEntries(Object.entries(p.members).map(([k, v]) => [k, [v.role, v.canvasMerge.skyCanvasShare, v.canvasMerge.scale, v.canvasMerge.twilightFloor]]))),
    { M1: ['PRIMARY', 1 / 3, 0.885, null], M1L: ['REPORT_ONLY', 1 / 3, 0.855, null], M2: ['REPORT_ONLY', 1 / 3, 1, null], M3: ['REPORT_ONLY', 1 / 3, 1, 0.53], M4: ['REPORT_ONLY', 0, 0.885, null] });
  assert.deepEqual(plain(p.rule), { lines: [19, 49, 66, 90], n1_auc_ge2_lower_above: -0.01, n2_auc_ge3_lower_above: -0.02, n3_loss_point_at_most: 0.03, n3_loss_upper_below: 0.05,
    n4_recall_drop_at_most: 0.01, n4_overall_ge2_recall_floor: 0.60, n4_cloud_type_ge2_recall_floor: 0.65 });
  assert.equal(p.baseline_reference.signature_sha256, 'ae1ded3b0eceb491c1d7fd54679befd5f5239cc8c12730250038fc78de730f1c');
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.members.M1.canvasMerge) && Object.isFrozen(p.rule));
});

test('member configs differ from 2.5.5.19 only in canvasMerge', async () => {
  const m = await api(), C0 = (await m.holdout.releaseConfigs())['2.5.5.19'];
  assert.equal('canvasMerge' in C0, false);
  for (const key of m.MEMBER_KEYS) {
    const c = m.memberConfig(C0, key), { canvasMerge, ...rest } = c;
    assert.deepEqual(rest, C0); assert.deepEqual(canvasMerge, { ...m.CM_POLICY.members[key].canvasMerge });
  }
  assert.throws(() => m.memberConfig(C0, 'M9'), /CM_BAD_MEMBER_KEY/);
});

test('N1–N4 decision rule, including the relative recall condition', async () => {
  const m = await api(), iv = (point, lo, hi) => ({ point, ci95: [lo, hi], status: 'COMPUTED' });
  const F = (o = {}) => ({ auc_ge2: { delta: iv(0, -0.005, 0.005) }, auc_ge3: { delta: iv(0, -0.015, 0.01) }, loss_delta: iv(0.018, 0.001, 0.038),
    C0: { ge2_recall: 0.630, ge2_recall_cloud_type: 0.681 }, candidate: { ge2_recall: 0.627, ge2_recall_cloud_type: 0.677 }, ...o });
  assert.equal(m.decide(F()).decision, 'NON_INFERIOR');
  const fails = (o, name) => { const d = m.decide(F(o)); assert.equal(d.decision, 'INFERIOR'); assert.deepEqual(d.failed, [name]); };
  fails({ auc_ge2: { delta: iv(0, -0.0101, 0.005) } }, 'N1_auc_ge2_lower_above_minus_0_01');
  fails({ auc_ge3: { delta: iv(0, -0.02, 0.01) } }, 'N2_auc_ge3_lower_above_minus_0_02');
  fails({ loss_delta: iv(0.031, 0.01, 0.045) }, 'N3_loss_point_at_most_0_03_and_upper_below_0_05');
  fails({ loss_delta: iv(0.02, 0.01, 0.05) }, 'N3_loss_point_at_most_0_03_and_upper_below_0_05');
  fails({ candidate: { ge2_recall: 0.619, ge2_recall_cloud_type: 0.677 } }, 'N4_recall_not_lower_by_more_than_0_01_and_floors');   // 0.011 below C0
  fails({ candidate: { ge2_recall: 0.627, ge2_recall_cloud_type: 0.670 } }, 'N4_recall_not_lower_by_more_than_0_01_and_floors');
  fails({ C0: { ge2_recall: 0.60, ge2_recall_cloud_type: 0.66 }, candidate: { ge2_recall: 0.595, ge2_recall_cloud_type: 0.66 } }, 'N4_recall_not_lower_by_more_than_0_01_and_floors');   // absolute floor
  assert.equal(m.decide(F({ C0: { ge2_recall: 0.630, ge2_recall_cloud_type: 0.681 }, candidate: { ge2_recall: 0.620, ge2_recall_cloud_type: 0.671 } })).decision, 'NON_INFERIOR', 'exactly 0.01 lower passes');
  assert.equal(m.decide(F({ auc_ge2: { delta: { point: 0, ci95: [null, null], status: 'NOT_ESTIMABLE' } } })).decision, 'INFERIOR');
});

test('fixed-line comparison and evaluateAll on a synthetic pool', async () => {
  const m = await api(), rows = [];
  for (let d = 0; d < 30; d++) for (let j = 0; j < 4; j++) {
    const gt = (d + j) % 5, base = [10, 35, 55, 75, 92][gt] + ((d * 7 + j * 3) % 9) - 4, date = `2026-0${7 + Math.floor(d / 10)}-${String(1 + d % 10).padStart(2, '0')}`;
    rows.push({ snapshot_id: `s${d}_${j}`, event_id: `e${d}_${j}`, event_date_local: date, pool: d < 15 ? 'DEV' : 'H1', city: j === 0 ? '昆明' : '上海', slot: 'EVENING',
      lead_time_minutes: 60, gt_ordinal: gt, gt_confidence: 1, weight: 1, recall_exempt: j === 3 && gt >= 2,
      scores: Object.fromEntries(Object.entries({ C0: base, M1: base + (d % 3 === 0 ? -1 : 0), M1L: base - 2, M2: base + 5, M3: base + 4, M4: base - 1 }).map(([k, v]) => [k, Math.max(0, Math.min(100, v))])) });
  }
  const F = m.fixedCompare(rows, 'M1');
  assert.deepEqual(F.lines, [19, 49, 66, 90]);
  assert.equal(F.grade_changes, m.gradeChanges(rows, 'M1').length);
  const same = m.fixedCompare(rows.map(r => ({ ...r, scores: { ...r.scores, M1: r.scores.C0 } })), 'M1');
  assert.equal(same.loss_delta.point, 0); assert.equal(same.ge2_recall_delta.point, 0); assert.equal(same.auc_ge2.delta.point, 0); assert.equal(same.grade_changes, 0);
  assert.equal(m.decide(same).conditions.N3_loss_point_at_most_0_03_and_upper_below_0_05, true);
  const e = m.evaluateAll(rows);
  assert.ok(['NON_INFERIOR', 'INFERIOR'].includes(e.decision));
  assert.deepEqual(Object.keys(e.report_only.members_at_current_lines), ['M1L', 'M2', 'M3', 'M4']);
  assert.deepEqual(Object.keys(e.report_only.relined_cv), ['M1', 'M2']);
  assert.deepEqual(Object.keys(e.report_only.breakdowns.by_region).sort(), ['OTHER', 'SOUTH']);
  assert.equal(e.report_only.m3_minus_m1l.p50, 6); assert.equal(e.report_only.m3_minus_m1l.within_1_share, 0);
  assert.equal(e.role, 'DEVELOPMENT_EVIDENCE_ONLY_NO_RELEASE');
});

test('weight check rejects a merged weight that differs from the two original weights', async () => {
  const m = await api(), M = m.CM_POLICY.members.M1.canvasMerge;
  const c0 = { dynamic_weights: { skyCanvas: 0.2, horizon: 0.35, illumination: 0.4, atmosphere: 0.03, weather: 0.02 }, components: { skyCanvas: 50, illumination: 40 } };
  const m1 = (sky, o = {}) => ({ dynamic_weights: { skyCanvas: sky, horizon: 0.35, illumination: 0, atmosphere: 0.03, weather: 0.02 }, components: { skyCanvas: 45, illumination: null },
    canvas_merge: { sky_canvas_share: M.skyCanvasShare, scale: M.scale, twilight_factor: 1, sky_canvas_original: 50 }, ...o });
  assert.equal(m.wf.weightCheck(c0, m1(0.6)).merged_abs_diff <= 1e-12, true);
  assert.throws(() => m.wf.weightCheck(c0, m1(0.6 + 1e-9)), /CM_DYNAMIC_WEIGHT_MISMATCH/);
  assert.throws(() => m.wf.weightCheck(c0, m1(0.6, { components: { skyCanvas: 45, illumination: 3 } })), /CM_TRACE_INVALID/);
});

test('parameter registry: canvasMerge unwires illumination units without changing the registry document', async () => {
  const { registry } = await api();
  assert.deepEqual(registry.conditionalUnwiring({}), []);
  assert.deepEqual(plain(registry.conditionalUnwiring({ canvasMerge: { skyCanvasShare: 0.5, scale: 1 } })[0].canonical_paths),
    ['weights.illumination', 'illuminationModel.bankShare', 'illuminationModel.twilightSaturationMinutes']);
  assert.doesNotThrow(() => registry.assertNoConditionalUnwiring({ weights: {} }));
  assert.throws(() => registry.assertNoConditionalUnwiring({ canvasMerge: {} }), e => e.reason_code === 'CANVAS_MERGE_UNWIRES_ILLUMINATION');
  assert.equal('CONFIG_CONDITIONAL_UNWIRING' in registry.registryDocument(), false);
  for (const path of ['weights', 'illuminationModel.bankShare', 'illuminationModel.twilightSaturationMinutes'])
    assert.ok(registry.UNITS.some(u => u.canonical_path === path), `${path} is a registered unit`);
});
