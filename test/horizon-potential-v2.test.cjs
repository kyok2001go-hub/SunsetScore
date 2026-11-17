const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
// V2.5.5.18 horizon conditioning, second version (Policy 15). PRD: ref_docs/PRD/V2.5.5.18--地平线条件化第二版与评估口径调整方案.md

let modules;
const api = () => modules ||= Promise.all(['practical-tuning/horizon-potential-v2', 'practical-tuning/horizon-potential-v2-workflow', 'practical-tuning/horizon-potential', 'practical-tuning/policy']
  .map(n => import(`../tools/${n}.mjs`))).then(([v2, flow, v1, policy]) => ({ ...v2, ...flow, v1, digest: policy.digest }));
const codeOf = async fn => { try { await fn(); } catch (e) { return e.code; } return null; };

let serial = 0;
const row = (gt, scores, extra = {}) => { const n = serial++; return { snapshot_id: `s${String(n).padStart(4, '0')}`, event_id: `e${String(n).padStart(4, '0')}`,
  event_date_local: `2026-10-${String(n % 12 + 1).padStart(2, '0')}`, pool: n % 2 ? 'DEV' : 'H1', slot: '1613', lead_time_minutes: 30, gt_ordinal: gt, gt_confidence: 1, weight: 1,
  t_avg: 10, cloud_potential: 0, review_kind: null, recall_exempt: false, scores, ...extra }; };

test('Policy 15 plan is frozen around the PRD candidate, floors, review table and reference', async () => {
  const m = await api(), p = m.HP2_POLICY;
  assert.deepEqual([p.practical_tuning_schema_version, p.practical_tuning_policy_version, p.search_space, p.baseline, p.h3_first_date], [15, 15, 'horizon-potential-v2', 'RELEASE_LINE_2.5.5.11', '2026-11-16']);
  assert.deepEqual([{ ...p.candidate }, p.radius_km, p.sensitivity.map(m.keyOf)], [{ f: 0.7, k: 5 }, 100, ['HA_f0.7_k3', 'HA_f0.7_k8', 'HA_f0.5_k5']]);
  assert.deepEqual([p.lines.ge2_recall_floor, p.lines.ge2_recall_scope, p.lines.ge3_recall_floor, p.lines.overall_ge2_recall_floor, [...p.lines.current], [...p.folds], p.auc_drop_tolerance],
    [0.65, 'CLOUD_TYPE', 0.2, 0.6, [19, 49, 66, 90], [5, 11], 0.02]);
  assert.deepEqual([p.review.events, p.review.exempt_kind, p.brier.logistic.lambda, p.reference.run_id, m.keyOf(p.reference)], [44, 'CLEAR_GLOW', 0, 'practical_tuning_v14_1e9a94ef82985c4b19c0', 'HA_f0.7_k15']);
  assert.deepEqual(p.pools.map(x => x.name), ['DEV', 'H1', 'H2']);
  assert.deepEqual(m.variantConfig({ x: 1 }, p.candidate), { x: 1, horizonCloudPotential: { f: 0.7, k: 5, radiusKm: 100 } });
});

test('The frozen review table loads, a missing or altered table stops the run, and rows are tagged by Event', async () => {
  const m = await api(), table = await m.loadReviewTable();
  assert.equal(table.events.length, 44);
  assert.deepEqual(['LIT_CLOUD', 'FAR_HORIZON', 'CLEAR_GLOW'].map(k => table.events.filter(e => e.kind === k).length), [18, 12, 14]);
  assert.ok(table.events.every(e => e.gt_ordinal >= 2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp2-review-'));
  try {
    assert.equal(await codeOf(() => m.loadReviewTable(m.HP2_POLICY, dir)), 'HP2_REVIEW_TABLE_MISSING');
    const file = path.join(dir, m.HP2_POLICY.review.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...table, events: table.events.map((e, i) => i ? e : { ...e, kind: 'CLEAR_GLOW' }) }));
    assert.equal(await codeOf(() => m.loadReviewTable(m.HP2_POLICY, dir)), 'HP2_REVIEW_TABLE_HASH_MISMATCH');
    // Line endings and key order do not matter: only the content is pinned.
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(table).reverse()), null, 1));
    assert.equal((await m.loadReviewTable(m.HP2_POLICY, dir)).events.length, 44);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Tagging on a small table with its own pinned digest.
  const rows = [row(2, { C0: 50 }), row(2, { C0: 50 }), row(1, { C0: 50 })];
  const small = { events: [{ event_id: rows[0].event_id, event_date_local: rows[0].event_date_local, gt_ordinal: 2, kind: 'CLEAR_GLOW' },
    { event_id: rows[1].event_id, event_date_local: rows[1].event_date_local, gt_ordinal: 2, kind: 'LIT_CLOUD' }] };
  const policy = { ...m.HP2_POLICY, review: { ...m.HP2_POLICY.review, content_sha256: m.digest(small), events: 2 } };
  assert.deepEqual(m.attachReview(rows, small, policy).map(r => [r.review_kind, r.recall_exempt]), [['CLEAR_GLOW', true], ['LIT_CLOUD', false], [null, false]]);
  assert.equal(await codeOf(() => m.attachReview(rows, small)), 'HP2_REVIEW_TABLE_HASH_MISMATCH');
  for (const bad of [{ ...small.events[0], event_id: rows[2].event_id }, { ...small.events[0], event_date_local: '2026-01-01' }, { ...small.events[0], event_id: 'unknown' }]) {
    const t = { events: [bad, small.events[1]] };
    assert.equal(await codeOf(() => m.attachReview(rows, t, { ...policy, review: { ...policy.review, content_sha256: m.digest(t) } })), 'HP2_REVIEW_EVENT_MISMATCH');
  }
});

test('Line selection: scope ALL is the Policy 14 rule; scope CLOUD_TYPE keeps exempt Events out of the ≥2 recall floor only', async () => {
  const m = await api(), rows = [];
  for (let i = 0; i < 12; i++) rows.push(row(i % 2, { C0: 45 + i % 8 }));
  for (let i = 0; i < 4; i++) rows.push(row(2, { C0: 60 }));
  for (let i = 0; i < 2; i++) rows.push(row(3, { C0: 72 }));
  const noExempt = m.selectLines(rows, 'C0', m.HP2_POLICY, 'ALL');
  assert.deepEqual(noExempt, m.v1.selectLines(rows, 'C0'));
  assert.deepEqual(m.selectLines(rows, 'C0'), noExempt, 'without exempt rows both scopes agree');
  // Four clear-sky-glow good Events at 40: counting them, a ≥2 recall of 0.65 forces the 1/2 line down to 40 or below.
  const withGlow = [...rows, ...Array.from({ length: 4 }, () => row(2, { C0: 40 }, { review_kind: 'CLEAR_GLOW', recall_exempt: true }))];
  const all = m.selectLines(withGlow, 'C0', m.HP2_POLICY, 'ALL'), cloud = m.selectLines(withGlow, 'C0');
  assert.deepEqual(all, m.v1.selectLines(withGlow, 'C0'));
  assert.ok(all.lines[1] <= 40, `ALL: ${all.lines}`);
  assert.ok(cloud.lines[1] > 52 && cloud.lines[1] <= 60, `CLOUD_TYPE: ${cloud.lines}`);
  assert.ok(cloud.train_loss < all.train_loss, 'the loss still counts the missed glow Events, yet the higher line is cheaper');
  // Hand-computed metrics for the CLOUD_TYPE lines: GT ≥ 2 = 10 rows, 6 of them cloud-type and all predicted ≥ 2; no GT ≤ 1 row is predicted ≥ 2.
  const s = m.summarize2(withGlow, r => m.v1.grade(r.scores.C0, cloud.lines));
  assert.deepEqual([s.ge2_recall, s.ge2_recall_cloud_type, s.false_alarm_rate, s.ge3_recall], [0.6, 1, 0, 1]);
  const t = m.summarize2(withGlow, r => m.v1.grade(r.scores.C0, [19, 49, 66, 90]));
  // Current lines: 4 of the 12 GT ≤ 1 rows score 49 or more.
  assert.deepEqual([t.ge2_recall, t.ge2_recall_cloud_type, t.false_alarm_rate], [0.6, 1, 0.333333]);
});

test('Brier: the logistic fit on the training dates reproduces group rates; held-out error matches the hand calculation', async () => {
  const m = await api(), cand = m.keyOf(m.HP2_POLICY.candidate), rows = [];
  let n = 0;
  const add = (date, score, ys) => { for (const y of ys) { const id = String(n++).padStart(3, '0');
    rows.push({ snapshot_id: `b${id}`, event_id: `be${id}`, event_date_local: date, lead_time_minutes: 30, gt_ordinal: y ? 2 : 1, gt_confidence: 1, weight: 1, scores: { C0: score, [cand]: 100 - score } }); } };
  add('2026-10-01', 40, [1, 0, 0, 0]); add('2026-10-01', 60, [1, 1, 1, 0]);   // rates 0.25 / 0.75
  add('2026-10-02', 40, [1, 0]); add('2026-10-02', 60, [1, 1, 0, 0]);         // rates 0.5 / 0.5
  const b = m.brierCv(rows, 2, 'TEST');
  // Held-out 10-01 (model from 10-02, p = 0.5 everywhere): 8 × 0.25. Held-out 10-02 (p = 0.25 at 40, 0.75 at 60): 0.5625 + 0.0625 + 2 × 0.0625 + 2 × 0.5625.
  const expected = (8 * 0.25 + 1.875) / 14;
  assert.equal(b.events, 14);
  assert.ok(Math.abs(b.C0 - expected) < 1e-6, `${b.C0} vs ${expected}`);
  assert.ok(Math.abs(b.candidate - expected) < 1e-6, 'a mirrored score carries the same information');
  assert.ok(Math.abs(b.delta.point) < 1e-6);
});

test('Evaluation: gates follow §5, G1 has two paths, and the decision uses the registered rule', async () => {
  const m = await api(), cand = m.keyOf(m.HP2_POLICY.candidate), sens = m.HP2_POLICY.sensitivity.map(m.keyOf), rows = [];
  // Cloud-free GT 0/1 rows sit at 55–62 under C0 (overlapping the cloud-type good rows at 58–65) and drop by 10 under the candidate;
  // cloud-type rows keep their score; glow rows drop with the cloud-free ones.
  const scores = (c0, drop) => ({ C0: c0, [cand]: c0 - drop, ...Object.fromEntries(sens.map(k => [k, c0 - drop])) });
  for (let i = 0; i < 96; i++) rows.push(row(i % 3 === 0 ? 0 : 1, scores(55 + i % 8, 10), { cloud_potential: 0 }));
  for (let i = 0; i < 36; i++) rows.push(row(1, scores(30 + i % 15, 0), { cloud_potential: 30, t_avg: 50 }));
  for (let i = 0; i < 48; i++) rows.push(row(2, scores(58 + i % 8, 0), { cloud_potential: 30, t_avg: 50 }));
  for (let i = 0; i < 24; i++) rows.push(row(3, scores(70 + i % 10, 0), { cloud_potential: 40, t_avg: 60 }));
  for (let i = 0; i < 12; i++) rows.push(row(2, scores(56, 10), { cloud_potential: 0, review_kind: 'CLEAR_GLOW', recall_exempt: true }));
  const e = m.evaluateAll(rows);
  assert.deepEqual(Object.keys(e.gates), ['G1_better_than_L0', 'G2_cloud_type_ge2_recall_cv5_cv11_at_floor', 'G3_cross_period_both_lower', 'G4_auc_ge2_lower_above_minus_tolerance', 'G5_overall_ge2_recall_cv5_cv11_at_floor']);
  assert.equal(e.gates.G1_better_than_L0, e.G1_paths.loss_interval_upper_below_0 || e.G1_paths.both_points_below_0_and_brier_upper_below_0);
  const A = e.A, worth = Object.values(e.gates).every(Boolean);
  assert.equal(e.gates.G2_cloud_type_ge2_recall_cv5_cv11_at_floor, A.cv5.candidate.ge2_recall_cloud_type >= 0.65 && A.cv11.candidate.ge2_recall_cloud_type >= 0.65);
  assert.equal(e.gates.G5_overall_ge2_recall_cv5_cv11_at_floor, A.cv5.candidate.ge2_recall >= 0.6 && A.cv11.candidate.ge2_recall >= 0.6);
  assert.equal(e.decision, worth ? 'WORTH_H3' : !e.gates.G1_better_than_L0 && A.cv5.reference.product_loss < e.current_lines_C0.product_loss ? 'LINES_SUFFICIENT' : 'NO_GAIN');
  // The candidate separates the cloud-free GT 0/1 rows from the cloud-type good rows, so it must not lose to lines-only here.
  assert.ok(A.cv5.candidate.product_loss < A.cv5.reference.product_loss);
  assert.ok(A.cv5.candidate.false_alarm_rate < A.cv5.reference.false_alarm_rate);
  assert.equal(A.cv5.candidate.ge2_recall_cloud_type, 1);
  assert.equal(A.cv5.folds.length, 5); assert.equal(A.cv11.folds.length, 11);
  assert.equal(A.report.by_review.CLEAR_GLOW.events, 12);
  assert.equal(A.report.low_potential.snapshots, 108);
  assert.deepEqual(Object.keys(e.report_only.sensitivity), sens);
  assert.ok(e.report_only.A2_current_lines.false_alarm_rate < e.current_lines_C0.false_alarm_rate, 'with the current lines the candidate raises fewer false alarms');
});

// Engine behaviour of the fixed candidate (the key itself was added in V2.5.5.17 and is off by default).
function runEngine(layers, patch = {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  delete SS.config.horizonCloudPotential; delete SS.config.canvasZeroFloor;
  Object.assign(SS.config, patch);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p, forecast: forecast(layers) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  let trace = null;
  const result = SS.engine.compute({ location: { name: 'Fixture City', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: SS.cloudField.buildCloudField(sky, sunset), expectedSampleCount: 13,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0, offlineTrace: t => { trace = t; } });
  return { result, trace };
}
test('Candidate f 0.7, k 5: g(0) = 0.7, g(2) = 0.82, and C ≥ 5 leaves the score unchanged; at C = 0 or C ≥ 15 it equals k = 15', async () => {
  const m = await api(), key = k => ({ horizonCloudPotential: { f: 0.7, k, radiusKm: 100 } });
  assert.deepEqual({ ...m.HP2_POLICY.candidate }, { f: 0.7, k: 5 });
  const factor = layers => { const h = runEngine(layers, key(5)).trace.horizon_cloud_potential; return [h.value, Number(h.factor.toFixed(9))]; };
  assert.deepEqual(factor({ low: 0, mid: 0, high: 0, cloud: 0 }), [0, 0.7]);
  assert.deepEqual(factor({ low: 0, mid: 1, high: 2, cloud: 3 }), [2, 0.82]);
  for (const layers of [{ low: 0, mid: 5, high: 3, cloud: 7 }, { low: 0, mid: 5, high: 10, cloud: 12 }, { low: 5, mid: 30, high: 40, cloud: 55 }])
    assert.equal(runEngine(layers, key(5)).result.score, runEngine(layers).result.score);
  for (const layers of [{ low: 0, mid: 0, high: 0, cloud: 0 }, { low: 5, mid: 30, high: 40, cloud: 55 }])
    assert.equal(runEngine(layers, key(5)).result.score, runEngine(layers, key(15)).result.score);
  assert.ok(runEngine({ low: 0, mid: 0, high: 0, cloud: 0 }, key(5)).result.score < runEngine({ low: 0, mid: 0, high: 0, cloud: 0 }).result.score);
});
