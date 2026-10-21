const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/high-cloud', 'practical-tuning/mid-cloud',
  'practical-tuning/mid-cloud-workflow', 'practical-tuning/high-cloud-workflow', 'practical-tuning/migrations',
  'practical-tuning/workflow', 'practical-tuning/compute', 'practical-tuning/data', 'practical-tuning/policy',
  'practical-tuning/worker', 'product-evaluation/metrics'].map(n => import(`../tools/${n}.mjs`))).then(ms => Object.assign({}, ...ms)); }
const row = (id, event, gt, confidence = .6) => ({ snapshot_id: id, event_id: event, event_date_local: '2026-09-01',
  location_key: event, gt_ordinal: gt, gt_confidence: confidence });
const config = () => ({ midCloudCenter: 40, midCloudWidth: 25, highCloudCenter: 60, highCloudWidth: 25,
  weights: { skyCanvas: .2, horizon: .375, illumination: .4, atmosphere: .025, weather: 0 },
  corridor: { midCloudCenter: 35, midCloudWidth: 20 }, other: { thresholds: [20, 40, 60, 90] } });
test('Mid-cloud adapter changes only registered root integers, retaining fixed weights and high cloud', async () => {
  const m = await api(), base = config(), next = m.installMidCloud(base, { mid_cloud_center: 45, mid_cloud_width: 30 });
  assert.deepEqual(m.withoutMidCloud(next), m.withoutMidCloud(base)); assert.equal(base.midCloudCenter, 40);
  assert.deepEqual(next.corridor, base.corridor);
  for (const p of [{ mid_cloud_center: -1, mid_cloud_width: 25 }, { mid_cloud_center: 101, mid_cloud_width: 25 },
    { mid_cloud_center: 40.5, mid_cloud_width: 25 }, { mid_cloud_center: 40, mid_cloud_width: 0 },
    { mid_cloud_center: 40, mid_cloud_width: 61 }, { mid_cloud_center: 40, mid_cloud_width: 25, extra: 0 }]) assert.throws(() => m.midCloudParameters(p));
  const c = m.midCloudCandidate({ mid_cloud_center: 45, mid_cloud_width: 30 }, { baseline: base, original: base, engine_sha256: 'e' });
  assert.equal(c.parameter_distance, m.q(.05 + 5 / 59)); assert.match(c.candidate_id, /^practical_candidate_v3_/);
  assert.equal(m.MID_CLOUD_POLICY.search_space, 'mid-cloud'); assert.equal(m.HIGH_CLOUD_POLICY.practical_tuning_policy_version, 2);
  assert.equal(m.digest(m.HIGH_CLOUD_POLICY), '47a83db91c24ea505531452d0e72016e732b8aa21fd02e28ccad003c219c467e');
});
test('Paired migrations match hand-computed whole-pool weights, including crossing Event rows and actual 0/1/2', async () => {
  const m = await api();
  const rows = [row('z1', 'A', 3), row('z2', 'A', 3), row('z3', 'A', 3), row('b1', 'B', 4, 1), row('b2', 'B', 4, 1),
    row('c', 'C', 0), row('d1', 'D', 1), row('d2', 'D', 1), row('e', 'E', 2, 1)];
  const before = [50, 10, 70, 50, 70, 10, 50, 70, 50], after = [70, 70, 50, 70, 70, 70, 70, 50, 70];
  const paired = m.pairedMigrations(rows, before, after);
  assert.deepEqual(paired.recovered_from_2, { snapshot_count: 2, event_count: 2, weighted_amount: .7 });
  assert.deepEqual(paired.recovered_from_0_1, { snapshot_count: 1, event_count: 1, weighted_amount: .2 });
  assert.deepEqual(paired.recognized_high_lost, { snapshot_count: 1, event_count: 1, weighted_amount: .2 });
  assert.deepEqual(paired.new_ge3_false_alarms, { snapshot_count: 3, event_count: 3, weighted_amount: 1.9 });
  assert.equal(paired.ge3_false_alarms_removed.weighted_amount, .3);
  assert.deepEqual(paired.new_false_alarms_by_actual.map(x => x.weighted_amount), [.6, .3, 1]);
  assert.equal(paired.net_recovered_weight, .7); assert.equal(paired.gt_ge3_weighted_support, 1.6);
  assert.equal(paired.recall_ge3_delta_from_net, .4375); assert.equal(paired.recall_ge3_delta, .4375);
  const b = m.highCloudMetrics(rows, before), c = m.highCloudMetrics(rows, after);
  assert.ok(Math.abs(c.target_ge3.recall - b.target_ge3.recall - .4375) < 1e-12);
  assert.equal(paired.event_counts_are_non_additive, true);
  const keep = m.pairedMigrations(rows, before, before); assert.equal(keep.net_recovered_weight, 0);
  for (const key of m.MIGRATION_KEYS) assert.deepEqual(keep[key], { snapshot_count: 0, event_count: 0, weighted_amount: 0 });
  assert.equal(m.pairedMigrations([row('x', 'x', 2)], [50], [70]).recall_ge3_delta_from_net, null);
  assert.throws(() => m.pairedMigrations(rows, before.slice(1), after), /MIGRATION_COHORT_MISMATCH/);
});
test('Mid-cloud bounded search resumes deterministically and cumulative floors reject collapse or improvement only over B0', async () => {
  const m = await api(), base = config(), metrics = m.highCloudMetrics([row('a', 'a', 1), row('b', 'b', 2), row('c', 'c', 3)], [30, 50, 70]);
  const original = { ...metrics, product_loss: 1.17, target_ge2: { recall: .803206997085 }, target_ge3: { recall: .134210526316 } };
  let calls = 0;
  const opts = { baseline: base, original: base, engine_sha256: 'e', originalMetrics: original, evaluate: async c => {
    calls++; if (c.parameters.mid_cloud_center === 25 && c.parameters.mid_cloud_width === 15) throw Error('TEST_POINT_FAILURE');
    return { metrics: { ...original, product_loss: ((c.parameters.mid_cloud_center - 43) ** 2 + (c.parameters.mid_cloud_width - 23) ** 2) / 1000 } }; } };
  assert.equal(m.midCloudGrid().length, 42); assert.equal(new Set(m.midCloudGrid().map(m.digest)).size, 42);
  const result = await m.searchMidCloud(opts); assert.ok(result.records.length <= 74); assert.equal(result.budget.errors, 1);
  assert.ok(result.records.some(r => r.stage === 'LOCAL_2')); assert.ok(result.records.some(r => r.stage === 'LOCAL_1'));
  const previous = calls; assert.deepEqual(await m.searchMidCloud({ ...opts, restored: result.records }), result); assert.equal(calls, previous);
  assert.equal((await m.searchMidCloud({ ...opts, maxCandidates: 3 })).budget.termination, 'BUDGET_REACHED');
  await assert.rejects(m.searchMidCloud({ ...opts, evaluate: async () => { throw Error('FAIL'); } }), /NO_VALID_BASELINE/);
  const r = (id, loss, r2, r3) => ({ candidate_id: id, status: 'EVALUATED', parameter_distance: 0,
    metrics: { ...metrics, product_loss: loss, target_ge2: { recall: r2 }, target_ge3: { recall: r3 } } });
  const baseline = r('B1', 1.11, .785714285714, .134210526316);
  const failures = [r('collapse', .7, .2, .01), r('erosion', 1, .77, .134210526316), r('only_vs_B0', 1.12, .8, .2), r('null', .8, .8, null)];
  const keep = m.selectMidCloud([baseline, ...failures], 'B1', original); assert.equal(keep.selection_status, 'KEEP_CONTROL'); assert.equal(keep.phase7_completed, true);
  assert.equal(keep.practical_tuning_schema_version, 3); assert.equal(keep.search_space, 'mid-cloud');
  assert.equal(m.selectMidCloud([baseline, ...failures, r('good', 1.10, .784, .14)], 'B1', original).selected_candidate, 'good');
});
test('Mid-cloud pipeline loads V2 original B0, replays both mid parameters, exports migrations, resumes, verifies old versions', { timeout: 240000 }, async t => {
  const m = await api(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'mid-cloud-p11-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await require('./evaluation-fixture.cjs').createSyntheticPipeline(root); t.after(fixture.close);
  // Historical workflow prerequisites are frozen at the original 2.4.6 base.
  await require('./helpers.cjs').pinLegacyTuningBase(t);
  const sources = { raw: fixture.rawDir, gt: fixture.gtDir, model: fixture.modelDir }, output = path.join(root, 'runs');
  const v1 = await m.practicalRun({ ...sources, output, recognitionFirst: true, maxCandidates: 4 });
  const v2 = await m.practicalRun({ ...sources, output, searchSpace: 'high-cloud', baselineRun: v1.directory, maxCandidates: 4 });
  const parent = await m.loadMidCloudParent(v2.directory), loaded = await m.loadPool(sources), code = await m.codeIdentity(), calc = m.replayCalculator(code.engine_sha256);
  assert.deepEqual(parent.original, JSON.parse(await fs.readFile(path.join(v2.directory, 'original_control_config.json'))));
  const anchors = await m.reproduceMidCloudBaselines(loaded, parent, code, calc);
  const center = await m.evaluateConfig(anchors.checked.rows, m.installMidCloud(parent.baseline, { mid_cloud_center: 0, mid_cloud_width: 25 }), calc);
  const width = await m.evaluateConfig(anchors.checked.rows, m.installMidCloud(parent.baseline, { mid_cloud_center: 40, mid_cloud_width: 1 }), calc);
  assert.ok(center.scores.some((s, i) => s !== anchors.B1.scores[i])); assert.ok(width.scores.some((s, i) => s !== anchors.B1.scores[i]));
  await assert.rejects(m.reproduceMidCloudBaselines({ ...loaded, rows: loaded.rows.slice(1) }, parent, code, calc), /PARENT_COHORT_OR_B0_SCORES_DIFFER/);
  await assert.rejects(m.reproduceMidCloudBaselines(loaded, parent, { ...code, engine_sha256: 'bad' }, calc), /PARENT_ENGINE_DIFFERS/);
  const opts = { ...sources, output, searchSpace: 'mid-cloud', baselineRun: v2.directory, maxCandidates: 4 };
  const result = await m.practicalRun(opts), inspected = await m.inspectPractical(result.directory);
  assert.equal(inspected.manifest.practical_tuning_schema_version, 3); assert.equal(result.phase7_completed, true);
  assert.equal(inspected.result.selection_mode, 'CUMULATIVE_RECOGNITION_FIRST');
  const reqFile = path.join(result.directory, 'verification_request.json'), request = JSON.parse(await fs.readFile(reqFile));
  assert.deepEqual(m.withoutMidCloud(request.selected_effective_config), m.withoutMidCloud(parent.baseline));
  assert.ok(request.search_records.every(r => r.status !== 'EVALUATED' || r.paired_migrations));
  const paired = JSON.parse(await fs.readFile(path.join(result.directory, 'paired_migrations.json'))); assert.equal(paired.candidates.length, 4);
  assert.match(await fs.readFile(path.join(result.directory, 'report.md'), 'utf8'), /净找回加权量/);
  const proof = await m.verifyPractical(result.directory); assert.equal(proof.status, 'PASS'); assert.equal(proof.paired_migrations_equal, true);
  const tampered = structuredClone(request); tampered.search_records[0].paired_migrations.net_recovered_weight++;
  await assert.rejects(m.verifyMidCloudRequest(tampered), /BINDING_MISMATCH|MIGRATIONS_MISMATCH/);
  request.selected.scores[0] = (request.selected.scores[0] + 1) % 101;
  await assert.rejects(m.verifyMidCloudRequest(request), /FINAL_RECOMPUTE_MISMATCH/);
  assert.equal((await m.verifyPractical(v2.directory)).status, 'PASS'); assert.equal((await m.verifyPractical(v1.directory)).status, 'PASS');
  const oldV2 = JSON.parse(await fs.readFile(path.join(v2.directory, 'verification_request.json'))); oldV2.spec.code.sha256 = 'historical-v2-tools';
  await assert.rejects(m.verifyRequest(oldV2), /PRACTICAL_CODE_MISMATCH/);
  assert.equal((await m.verifyRequest(oldV2, { compatibleTools: true })).status, 'PASS');
  oldV2.spec.identity.policy.budget++;
  await assert.rejects(m.verifyRequest(oldV2, { compatibleTools: true }), /HIGH_CLOUD_POLICY_MISMATCH/);
  const work = path.join(output, '.work', result.run_id); await fs.rename(result.directory, work); await fs.rm(path.join(work, 'manifest.json'));
  assert.equal((await m.practicalRun({ ...opts, resume: true })).run_id, result.run_id);
});
