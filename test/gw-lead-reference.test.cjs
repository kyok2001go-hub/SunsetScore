const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.35 golden-window reference by lead time (Policy 20). PRD: ref_docs/PRD/V2.5.5.35--晚间黄金窗口分数水平修正方案.md

let modules;
const api = () => modules ||= Promise.all(['practical-tuning/gw-lead-reference', 'practical-tuning/gw-lead-reference-workflow', 'model-release/holdout', 'practical-tuning/policy']
  .map(n => import(`../tools/${n}.mjs`))).then(([gl, wf, holdout, policy]) => ({ ...gl, wf, holdout, digest: policy.digest }));
const TABLE = [{ maxLeadMinutes: 30, reference: 0.851567 }, { maxLeadMinutes: 60, reference: 0.845156 }, { maxLeadMinutes: 90, reference: 0.828776 },
  { maxLeadMinutes: 120, reference: 0.824235 }, { maxLeadMinutes: 180, reference: 0.744737 }];
const close = (x, y, tol = 1e-12) => assert.ok(Math.abs(x - y) <= tol, `${x} vs ${y}`);
const sunsetMs = Date.parse('2026-08-26T18:30:00Z');
function setup(table) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47;
  if (table !== undefined) SS.config.goldenWindow.referenceByLead = table;
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast({ low: 5, mid: 10, high: 20, cloud: 25 }) }));
  return { SS, corridor: SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]) };
}
const radar = pct => ({ available: true, coverageSeries: [0, 1, 2].map(i => ({ pct, t: sunsetMs - (80 - i * 10) * 60000 })) });
const fuse = (SS, corridor, minutes) => SS.evolution.fuseEvolution({ forecastTrend: null, precip: null, radar: radar(10), satellite: null, motionForecast: null,
  sunsetCloudCover: 20, corridorSamples: corridor, nowMs: sunsetMs - minutes * 60000, sunsetMs });

test('key absent: production config carries no referenceByLead; factor and range are unchanged with or without a lead time', () => {
  const { SS } = setup();
  assert.equal('referenceByLead' in SS.config.goldenWindow, false);
  const g = SS.modelConfig.goldenWindow, ref = g.reference, range = SS.evolution.goldenWindowFactorRange();
  close(range[0], g.floor / ref); close(range[1], 1 / ref);
  assert.deepEqual(SS.evolution.goldenWindowFactorRange(20), range);
  for (const p of [0, 0.37, 0.8, 1]) for (const t of [undefined, 0, 45, 150]) close(SS.evolution.calculateGoldenWindowFactor(p, t), Math.min(1 / ref, (g.floor + (1 - g.floor) * p) / ref));
});

test('factor = (floor + (1 − floor)·P) / r(t) with the bucket chosen by t ≤ maxLeadMinutes; after sunset uses the first bucket; beyond the last uses the last', () => {
  const { SS } = setup(TABLE), floor = SS.modelConfig.goldenWindow.floor;
  const cases = [[-20, 0.851567], [0, 0.851567], [30, 0.851567], [30.0001, 0.845156], [60, 0.845156], [75, 0.828776], [120, 0.824235], [121, 0.744737], [180, 0.744737], [240, 0.744737]];
  for (const [t, r] of cases) for (const p of [0, 0.5, 0.98]) {
    close(SS.evolution.calculateGoldenWindowFactor(p, t), Math.min(1 / r, Math.max(floor / r, (floor + (1 - floor) * p) / r)));
    const range = SS.evolution.goldenWindowFactorRange(t); close(range[0], floor / r); close(range[1], 1 / r);
  }
  // Without a lead time the range is the union over buckets, so outer clamps never cut a bucket factor.
  const u = SS.evolution.goldenWindowFactorRange(); close(u[0], floor / 0.851567); close(u[1], 1 / 0.744737);
});

test('fuseEvolution applies the bucket of the minutes to sunset and reports gwReference; without the key no gwReference field', () => {
  const on = setup(TABLE), off = setup(), floor = on.SS.modelConfig.goldenWindow.floor;
  for (const minutes of [20, 50, 80, 110, 150]) {
    const a = fuse(on.SS, on.corridor, minutes), b = fuse(off.SS, off.corridor, minutes);
    assert.equal(a.sunsetOpenProbability, b.sunsetOpenProbability, 'probability path unchanged');
    const r = TABLE.find(x => minutes <= x.maxLeadMinutes).reference;
    assert.equal(a.gwReference, r); assert.equal('gwReference' in b, false);
    assert.equal(a.gwFactor, Math.round(Math.min(1 / r, Math.max(floor / r, (floor + (1 - floor) * a.sunsetOpenProbability) / r)) * 1000) / 1000);
    const ref = off.SS.modelConfig.goldenWindow.reference;
    assert.equal(b.gwFactor, Math.round(Math.min(1 / ref, Math.max(floor / ref, (floor + (1 - floor) * b.sunsetOpenProbability) / ref)) * 1000) / 1000);
  }
});

test('invalid tables fall back to the single reference exactly', () => {
  const base = setup(), ref = base.SS.modelConfig.goldenWindow.reference;
  for (const bad of [[], 'x', [{ maxLeadMinutes: 60, reference: 0.8 }, { maxLeadMinutes: 30, reference: 0.8 }], [{ maxLeadMinutes: 60, reference: 0 }],
    [{ maxLeadMinutes: null, reference: 0.8 }], [null], [{ maxLeadMinutes: 60, reference: -1 }]]) {
    const { SS } = setup(bad);
    for (const t of [undefined, 10, 150]) assert.deepEqual([...SS.evolution.goldenWindowFactorRange(t)], [...base.SS.evolution.goldenWindowFactorRange()]);   // separate VM realms
    close(SS.evolution.calculateGoldenWindowFactor(0.6, 40), (SS.modelConfig.goldenWindow.floor + (1 - SS.modelConfig.goldenWindow.floor) * 0.6) / ref);
  }
});

test('Policy 20 plan: frozen tables, only goldenWindow.referenceByLead added, released configs untouched', async () => {
  const { GL_POLICY, MEMBER_KEYS, memberConfig, referenceAt, expectedFactor, holdout, digest } = await api();
  assert.deepEqual(MEMBER_KEYS, ['K1', 'K1P']); assert.equal(GL_POLICY.primary, 'K1');
  assert.deepEqual(GL_POLICY.members.K1.referenceByLead.map(b => ({ ...b })), TABLE);
  assert.deepEqual(GL_POLICY.members.K1P.referenceByLead.map(b => [b.maxLeadMinutes, b.reference]), [[120, 0.838085], [180, 0.744737]]);
  const C0 = (await holdout.releaseConfigs())['2.5.5.19'];
  assert.equal('referenceByLead' in C0.goldenWindow, false);
  const K1 = memberConfig(C0, 'K1'), clean = structuredClone(K1); delete clean.goldenWindow.referenceByLead;
  assert.equal(digest(clean), digest(C0)); assert.equal('referenceByLead' in C0.goldenWindow, false, 'base config not mutated');
  assert.equal(referenceAt(TABLE, -5), 0.851567); assert.equal(referenceAt(TABLE, 999), 0.744737);
  assert.equal(expectedFactor(0.98, 10, 0.507692307692, TABLE), Math.round(Math.min(1 / 0.851567, (0.507692307692 + 0.492307692308 * 0.98) / 0.851567) * 1000) / 1000);
  assert.throws(() => memberConfig(C0, 'X'), /GL_BAD_MEMBER_KEY/);
});

test('decision rule: RELEASE_CANDIDATE / LEVEL_FIXED_BUT_COSTLY / NOT_EFFECTIVE by hand', async () => {
  const { decide } = await api();
  const iv = (point, lo, hi) => ({ status: 'COMPUTED', point, ci95: [lo, hi] });
  const F = (o = {}) => ({ auc_ge2: { delta: iv(0, -0.005, 0.005) }, auc_ge3: { delta: iv(0, -0.01, 0.01) }, loss_delta: iv(0, -0.01, 0.015),
    C0: { ge2_recall: 0.70, ge2_recall_cloud_type: 0.72 }, candidate: { ge2_recall: 0.695, ge2_recall_cloud_type: 0.715 }, ...o });
  assert.equal(decide(F(), { candidate_mean: 0.4 }).decision, 'RELEASE_CANDIDATE');
  assert.equal(decide(F(), { candidate_mean: 1.0 }).decision, 'RELEASE_CANDIDATE');
  assert.equal(decide(F(), { candidate_mean: 1.01 }).decision, 'NOT_EFFECTIVE');
  const costly = decide(F({ candidate: { ge2_recall: 0.68, ge2_recall_cloud_type: 0.715 } }), { candidate_mean: 0.2 });
  assert.equal(costly.decision, 'LEVEL_FIXED_BUT_COSTLY'); assert.deepEqual(costly.failed, ['N4_recall_not_lower_by_more_than_0_01']);
  assert.equal(decide(F({ loss_delta: iv(0.01, -0.001, 0.021) }), { candidate_mean: 0.2 }).decision, 'LEVEL_FIXED_BUT_COSTLY');
  assert.equal(decide(F({ auc_ge2: { delta: iv(-0.004, -0.0101, 0.002) } }), { candidate_mean: 0.2 }).decision, 'LEVEL_FIXED_BUT_COSTLY');
  assert.equal(decide(F({ auc_ge3: { delta: iv(-0.01, -0.021, 0.0) } }), { candidate_mean: 0.2 }).decision, 'LEVEL_FIXED_BUT_COSTLY');
});

test('T1 evening gap: latest evening Snapshot minus the 16:13 Snapshot, per Event, unweighted', async () => {
  const { eveningGap } = await api();
  const row = (ev, slot, lead, c0, k1) => ({ event_id: ev, slot, lead_time_minutes: lead, scores: { C0: c0, K1: k1 } });
  const rows = [row('a', '1613', 100, 50, 52), row('a', 'EVENING', 40, 55, 53), row('a', 'EVENING', 10, 57, 54), row('b', '1613', 90, 30, 31), row('b', 'EVENING', 20, 33, 31),
    row('c', '1213', 300, 40, 40), row('c', 'EVENING', 20, 45, 44)];
  const g = eveningGap(rows, 'K1');
  assert.equal(g.events, 2); assert.equal(g.C0_mean, 5); assert.equal(g.candidate_mean, 1); assert.equal(g.C0_abs_ge5, 1); assert.equal(g.candidate_abs_ge5, 0);
});

test('factor check rejects a K1 factor that does not follow the table', async () => {
  const { wf, GL_POLICY, holdout } = await api(), C0 = (await holdout.releaseConfigs())['2.5.5.19'], floor = C0.goldenWindow.floor;
  const obs = f => ({ golden_window_active: true, golden_window_observation: { sunset_open_probability: 0.9, applied_factor: f, probability_source: 'EVOLUTION_30M' } });
  const e0 = Math.round(Math.min(1 / C0.goldenWindow.reference, (floor + (1 - floor) * 0.9) / C0.goldenWindow.reference) * 1000) / 1000;
  const e1 = Math.round(Math.min(1 / 0.851567, (floor + (1 - floor) * 0.9) / 0.851567) * 1000) / 1000;
  const ok = wf.factorCheck({ snapshot_id: 's', lead_time_minutes: 20 }, obs(e0), obs(e1), C0, GL_POLICY);
  assert.equal(ok.K1, e1); assert.equal(ok.C0, e0);
  assert.throws(() => wf.factorCheck({ snapshot_id: 's', lead_time_minutes: 20 }, obs(e0), obs(e0 + 0.01), C0, GL_POLICY), /GL_K1_FACTOR_MISMATCH/);
  const inactive = { golden_window_active: false, golden_window_observation: { status: 'NOT_EXECUTED' } };
  assert.deepEqual(wf.factorCheck({ snapshot_id: 's', lead_time_minutes: 300 }, inactive, inactive, C0, GL_POLICY), { active: false, C0: 1, K1: 1 });
});
