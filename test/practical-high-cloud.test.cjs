const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/high-cloud', 'practical-tuning/high-cloud-workflow',
  'practical-tuning/workflow', 'practical-tuning/compute', 'practical-tuning/data', 'practical-tuning/policy',
  'practical-tuning/worker', 'product-evaluation/metrics', 'tuning/lib/base-config'].map(n => import(`../tools/${n}.mjs`))).then(ms => Object.assign({}, ...ms)); }
const weights = { skyCanvas: .2, horizon: .375, illumination: .4, atmosphere: .025, weather: 0 };
const config = () => ({ highCloudCenter: 60, highCloudWidth: 25, weights, corridor: { highCloudCenter: 45, highCloudWidth: 25 }, other: .7 });
const row = (id, y) => ({ snapshot_id: `s${id}`, event_id: `e${id}`, event_date_local: '2026-09-01', location_key: `l${id}`, gt_ordinal: y, gt_confidence: 1, predicted_ordinal: y });
async function makeMetrics() { const m = await api(); return m.productMetrics([row(1, 1), row(2, 2), row(3, 3)]); }
test('High-cloud adapter validates Registry integers and changes only the two root paths', async () => {
  const m = await api(), base = config(), p = { high_cloud_center: 65, high_cloud_width: 20 }, next = m.installHighCloud(base, p);
  assert.equal(next.highCloudCenter, 65); assert.equal(next.highCloudWidth, 20);
  assert.deepEqual(next.corridor, base.corridor); assert.deepEqual(next.weights, base.weights);
  assert.deepEqual(m.withoutHighCloud(next), m.withoutHighCloud(base)); assert.equal(base.highCloudCenter, 60);
  for (const bad of [{ ...p, high_cloud_width: 0 }, { ...p, high_cloud_center: 101 }, { ...p, high_cloud_center: 55.5 },
    { ...p, high_cloud_width: NaN }, { ...p, extra: 1 }]) assert.throws(() => m.highCloudParameters(bad));
  const c = m.highCloudCandidate(p, { baseline: base, original: base, engine_sha256: 'e' });
  assert.equal(c.parameter_distance, m.q(5 / 100 + 5 / 59));
  assert.notEqual(c.candidate_id, m.highCloudCandidate(p, { baseline: base, original: base, engine_sha256: 'other' }).candidate_id);
  assert.equal(m.HIGH_CLOUD_POLICY.practical_tuning_schema_version, 2);
});
test('Cumulative B0 floors cannot erode each round and improvement must beat B1, not merely B0', async () => {
  const m = await api(), metrics = await makeMetrics();
  const make = (id, loss, ge2, ge3) => ({ candidate_id: id, parameters: { high_cloud_center: 60, high_cloud_width: 25 }, status: 'EVALUATED', parameter_distance: 0,
    metrics: { ...metrics, product_loss: loss, target_ge2: { ...metrics.target_ge2, recall: ge2 }, target_ge3: { ...metrics.target_ge3, recall: ge3 } } });
  const original = make('B0', 1.17, .803207, .134211).metrics, baseline = make('B1', 1.11, .785714, .134211);
  const collapsed = make('collapsed', .5, .15, .02), erosion = make('erosion', .9, .77, .134211), belowOriginal = make('belowB0', 1.12, .8, .2);
  const improved = make('improved', 1.10, .784, .134211), highest = make('highest', 1.2, .79, .4);
  assert.equal(m.meetsHighCloudRecognition(erosion, original), false);
  assert.equal(m.meetsHighCloudRecognition(make('edge', 1, .783207, .134211), original), true);
  assert.equal(m.meetsHighCloudRecognition(make('null', 1, .8, null), original), false);
  assert.equal(m.selectHighCloud([baseline, collapsed, erosion, belowOriginal], 'B1', original).selection_status, 'KEEP_CONTROL');
  const selected = m.selectHighCloud([baseline, collapsed, erosion, belowOriginal, improved, highest], 'B1', original);
  assert.equal(selected.selected_candidate, 'improved'); assert.equal(selected.phase7_completed, true);
  assert.equal(selected.lowest_loss_candidate, 'collapsed'); assert.equal(selected.highest_ge3_recall_with_ge2_floor, 'highest');
  assert.equal(selected.recognition_floor.anchor, 'B0'); assert.ok(selected.selection_status.startsWith('SELECTED'));
  assert.equal(m.selectHighCloud([baseline], 'B1', { ...original, target_ge3: { recall: null } }).selection_status, 'KEEP_CONTROL');
  assert.throws(() => m.selectHighCloud([], 'B1', original), /NO_VALID_BASELINE/);
});
test('High-cloud search enumerates 42 points and two deterministic local rounds, resumes, and isolates failures', async () => {
  const m = await api(), base = config(), metrics = await makeMetrics(); assert.equal(m.highCloudGrid().length, 42);
  assert.equal(new Set(m.highCloudGrid().map(m.digest)).size, 42);
  const original = { ...metrics, target_ge2: { recall: .8 }, target_ge3: { recall: .2 } }; let calls = 0;
  const evaluate = async c => { calls++; if (c.parameters.high_cloud_center === 45 && c.parameters.high_cloud_width === 15) throw Error('FAIL_POINT');
    return { metrics: { ...original, product_loss: ((c.parameters.high_cloud_center - 63) ** 2 + (c.parameters.high_cloud_width - 23) ** 2) / 1000 }, scores: [30, 50, 70] }; };
  const options = { baseline: base, original: base, engine_sha256: 'e', originalMetrics: original, evaluate };
  const search = await m.searchHighCloud(options);
  assert.ok(search.records.length <= 74); assert.equal(search.records[0].stage, 'B1_BASELINE');
  assert.equal(search.budget.errors, 1); assert.ok(search.audit.some(r => r.status === 'DUPLICATE'));
  assert.ok(search.records.some(r => r.stage === 'LOCAL_2')); assert.ok(search.records.some(r => r.stage === 'LOCAL_1'));
  const before = calls; assert.deepEqual(await m.searchHighCloud({ ...options, restored: search.records }), search); assert.equal(calls, before);
  const limited = await m.searchHighCloud({ ...options, maxCandidates: 5 }); assert.equal(limited.records.length, 5); assert.equal(limited.budget.termination, 'BUDGET_REACHED');
  await assert.rejects(m.searchHighCloud({ ...options, evaluate: async () => { throw Error('FAIL'); } }), /NO_VALID_BASELINE/);
});
test('Parent-node ranking prioritizes cumulative recall, then risk, recall and baseline parameter distance', async () => {
  const m = await api(), metrics = await makeMetrics(), original = { ...metrics, target_ge2: { recall: .8 }, target_ge3: { recall: .2 } };
  const r = (id, distance, recall) => ({ candidate_id: id, status: 'EVALUATED', parameter_distance: distance,
    metrics: { ...original, target_ge3: { recall }, product_loss: 1 } });
  assert.equal(m.rankHighCloud([r('low', 0, .1), r('good', .1, .2)], original)[0].candidate_id, 'good');
  assert.equal(m.rankHighCloud([r('far', .2, .2), r('near', .1, .2)], original)[0].candidate_id, 'near');
  assert.equal(m.rankHighCloud([r('null', 0, null), r('known', 0, .2)], original, false)[0].candidate_id, 'known');
});
test('Three-way metrics retain 4→2 price, support and null precision when no prediction4', async () => {
  const m = await api(), four = m.highCloudMetrics([row(1, 2)], [95]);
  assert.equal(four.product_loss, 4); assert.equal(four.predicted4_actual2.rate, 1); assert.equal(four.predicted4_actual2.conditional_on_predicted4, 1);
  assert.equal(four.confusion_matrix.count[4][2], 1);
  const no4 = m.highCloudMetrics([row(1, 3)], [60]); assert.equal(no4.predicted4_actual2.conditional_on_predicted4, null); assert.equal(no4.predicted4_actual_ge3_precision, null);
  assert.throws(() => m.highCloudMetrics([row(1, 1)], [101]));
});
test('High-cloud actual pipeline reproduces V1 parent, exports/recovers V2, verifies 3 configs and rejects mismatch', { timeout: 180000 }, async t => {
  const m = await api(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'high-cloud-p10-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await require('./evaluation-fixture.cjs').createSyntheticPipeline(root); t.after(fixture.close);
  // Historical workflow prerequisites are frozen at the original 2.4.6 base.
  await require('./helpers.cjs').pinLegacyTuningBase(t);
  const sources = { raw: fixture.rawDir, gt: fixture.gtDir, model: fixture.modelDir };
  const parentRun = await m.practicalRun({ ...sources, output: path.join(root, 'runs'), recognitionFirst: true, maxCandidates: 4 });
  const before = await fs.readFile(path.join(parentRun.directory, 'manifest.json'));
  const options = { ...sources, searchSpace: 'high-cloud', baselineRun: parentRun.directory, output: path.join(root, 'runs'), maxCandidates: 4 };
  const result = await m.practicalRun(options); assert.equal(result.phase7_completed, true); assert.equal(result.evaluated_candidates, 4);
  const inspected = await m.inspectPractical(result.directory); assert.equal(inspected.manifest.practical_tuning_schema_version, 2);
  assert.equal(inspected.result.selection_mode, 'CUMULATIVE_RECOGNITION_FIRST');
  const parent = await m.loadHighCloudParent(parentRun.directory), loaded = await m.loadPool(sources), code = await m.codeIdentity();
  const calc = m.replayCalculator(code.engine_sha256);
  const normal = await m.evaluateConfig(loaded.rows, parent.baseline, calc);
  const center = await m.evaluateConfig(loaded.rows, m.installHighCloud(parent.baseline, { high_cloud_center: 0, high_cloud_width: 25 }), calc);
  const width = await m.evaluateConfig(loaded.rows, m.installHighCloud(parent.baseline, { high_cloud_center: 60, high_cloud_width: 1 }), calc);
  assert.ok(center.scores.some((s, i) => s !== normal.scores[i])); assert.ok(width.scores.some((s, i) => s !== normal.scores[i]));
  await assert.rejects(m.reproduceHighCloudBaselines({ ...loaded, rows: loaded.rows.slice(1) }, parent, code, calc), /PARENT_COHORT_OR_B0_SCORES_DIFFER/);
  await assert.rejects(m.reproduceHighCloudBaselines(loaded, parent, { ...code, engine_sha256: 'wrong' }, calc), /PARENT_ENGINE_DIFFERS/);
  assert.equal((await m.verifyPractical(result.directory)).status, 'PASS');
  assert.equal((await m.verifyPractical(parentRun.directory)).status, 'PASS');
  const request = JSON.parse(await fs.readFile(path.join(result.directory, 'verification_request.json')));
  request.selected.scores[0] = (request.selected.scores[0] + 1) % 101;
  await assert.rejects(m.verifyHighCloudRequest(request), /FINAL_RECOMPUTE_MISMATCH/);
  const oldRequest = JSON.parse(await fs.readFile(path.join(parentRun.directory, 'verification_request.json')));
  oldRequest.spec.code.sha256 = 'historical-tool-version';
  await assert.rejects(m.verifyRequest(oldRequest), /PRACTICAL_CODE_MISMATCH/);
  assert.equal((await m.verifyRequest(oldRequest, { compatibleV1Tools: true })).status, 'PASS');
  oldRequest.spec.code.engine_sha256 = 'different-engine';
  await assert.rejects(m.verifyRequest(oldRequest, { compatibleV1Tools: true }), /PRACTICAL_CODE_MISMATCH/);
  const selected = JSON.parse(await fs.readFile(path.join(result.directory, 'selected_effective_config.json')));
  assert.deepEqual(m.withoutHighCloud(selected), m.withoutHighCloud(parent.baseline));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.directory, 'rollback_config.json'))), parent.baseline);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.directory, 'original_control_config.json'))), parent.original);
  const work = path.join(options.output, '.work', result.run_id); await fs.rename(result.directory, work); await fs.rm(path.join(work, 'manifest.json'));
  await fs.rm(path.join(work, 'candidates', (await fs.readdir(path.join(work, 'candidates')))[0]));
  const resumed = await m.practicalRun({ ...options, resume: true }); assert.equal(resumed.run_id, result.run_id);
  assert.deepEqual(await fs.readFile(path.join(parentRun.directory, 'manifest.json')), before);
  const history = (await fs.readFile(path.join(options.output, 'usage_history.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(history.filter(r => r.run_id === result.run_id).length, 1);
  await fs.appendFile(path.join(result.directory, 'baseline_config.json'), ' ');
  await assert.rejects(m.inspectPractical(result.directory), /PRACTICAL_OUTPUT_HASH_MISMATCH/);
});
