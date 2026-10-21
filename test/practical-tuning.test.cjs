const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/policy', 'practical-tuning/search', 'practical-tuning/data',
  'practical-tuning/compute', 'practical-tuning/workflow', 'practical-tuning/worker', 'product-evaluation/metrics',
  'tuning/lib/base-config', 'dataset/lib/common'].map(n => import(`../tools/${n}.mjs`))).then(ms => Object.assign({}, ...ms)); }
const weights = { skyCanvas: .3, horizon: .2, illumination: .2, atmosphere: .2, weather: .1 };
const row = (id, y, p = y) => ({ snapshot_id: `s${id}`, event_id: `e${id}`, event_date_local: '2026-09-01',
  location_key: `l${id}`, gt_ordinal: y, gt_confidence: 1, predicted_ordinal: p, control_ordinal: y,
  city: 'Fixture', lead_time_bucket: 'T_1_3H', regime_label: 'CLEAR', historical_splits: ['TEST'], replay: { id }, input_sha256: `input${id}` });
test('Recognition-first rejects cheap loss from collapsed recall, handles missing support, and preserves legacy selection', async () => {
  const m = await api(), metrics = m.productMetrics([row(1, 2), row(2, 3)]);
  const make = (id, loss, r2, r3) => ({ candidate_id: id, status: 'EVALUATED', control_weight_distance: 0,
    metrics: { ...metrics, product_loss: loss, target_ge2: { ...metrics.target_ge2, recall: r2 }, target_ge3: { ...metrics.target_ge3, recall: r3 } } });
  const c = make('control', 1, .8, .2), collapsed = make('collapsed', .5, .15, .02), balanced = make('balanced', .95, .79, .2);
  assert.equal(m.selectPhase7([c, collapsed, balanced], 'control').selected_candidate, 'collapsed');
  assert.equal(m.selectPhase7([c, collapsed, balanced], 'control', 'EFFECTIVE', true).selected_candidate, 'balanced');
  assert.equal(m.rankRecognition([collapsed, balanced, c], c)[0].candidate_id, 'balanced');
  assert.equal(m.preservesRecognition(make('edge', .9, .78, .2), c), true);
  assert.equal(m.preservesRecognition(make('bad', .9, .779, .2), c), false);
  assert.equal(m.preservesRecognition(make('null', .9, .8, null), c), false);
  assert.equal(m.selectPhase7([c, collapsed], 'control', 'EFFECTIVE', true).selection_status, 'KEEP_CONTROL');
});
test('Recognition search uses fixed seeds, interior comparisons and recognition-ranked local parents within budget', async () => {
  const m = await api(), control = { weights }, metrics = m.productMetrics([row(1, 2), row(2, 3)]);
  const evaluate = async c => ({ metrics: { ...metrics, product_loss: 1 - c.weights.horizon }, scores: [40, 60] });
  const r = await m.searchWeights({ control, engine_sha256: 'e', evaluate, recognitionFirst: true, maxCandidates: 100 });
  assert.ok(r.records.length <= 100);
  assert.ok(r.records.some(x => x.stage === 'RECOGNITION_SEED'));
  assert.ok(r.records.some(x => x.stage === 'INTERIOR_SEED' && Object.values(x.weights).every(v => v > 0)));
  assert.ok(r.records.some(x => x.stage === 'LOCAL_0.025'));
  assert.ok(!r.records.some(x => x.stage.startsWith('COARSE')));
  const rerun = await m.searchWeights({ control, engine_sha256: 'e', evaluate: async () => { throw Error('must reuse'); }, recognitionFirst: true, maxCandidates: 100, restored: r.records });
  assert.deepEqual(rerun, r);
});
test('Practical weights preserve five-member simplex, range, nonweights, and reject malformed registries', async () => {
  const m = await api(), base = { weights, other: { a: 9 } };
  for (const bad of [{ ...weights, weather: -.1 }, { ...weights, weather: NaN }, { ...weights, weather: .2 }, { ...weights, x: 0 }]) assert.throws(() => m.normalizeWeights(bad));
  assert.throws(() => m.normalizeWeights(weights, { unit_category: 'SIMPLEX', canonical_path: 'weights', members: ['x'] }));
  const next = m.installWeights(base, { skyCanvas: 1 / 3, horizon: 1 / 3, illumination: 1 / 3, atmosphere: 0, weather: 0 });
  assert.ok(Math.abs(Object.values(next.weights).reduce((s, n) => s + n) - 1) < 1e-12);
  assert.deepEqual(next.other, base.other); assert.deepEqual(base.weights, weights);
});
test('Practical grid is exactly 126 unique legal vectors and search/refinement/resume is deterministic', async () => {
  const m = await api(), grid = m.coarseGrid(); assert.equal(grid.length, 126);
  assert.equal(new Set(grid.map(m.digest)).size, 126); grid.forEach(w => m.normalizeWeights(w));
  let calls = 0; const control = { weights }, metrics = m.productMetrics([row(1, 0), row(2, 1)]);
  const evaluate = async c => { calls++; if (c.weights.weather === 1) throw Error('CANDIDATE_FAILURE'); return { metrics: { ...metrics, product_loss: c.weights.skyCanvas }, scores: [10, 30] }; };
  const first = await m.searchWeights({ control, engine_sha256: 'engine', evaluate });
  assert.ok(first.records.length <= 500); assert.equal(first.records.filter(r => r.status === 'ERROR').length, 1);
  assert.ok(first.audit.some(r => r.status === 'DUPLICATE')); assert.ok(first.audit.some(r => r.status === 'INVALID'));
  assert.ok(first.records.some(r => r.stage === 'LOCAL_0.025')); const before = calls;
  const second = await m.searchWeights({ control, engine_sha256: 'engine', evaluate, restored: first.records });
  assert.equal(calls, before); assert.deepEqual(second, first);
  const limited = await m.searchWeights({ control, engine_sha256: 'engine', evaluate, maxCandidates: 8 });
  assert.equal(limited.records.length, 8); assert.equal(limited.budget.termination, 'BUDGET_REACHED');
  const failed = async () => { throw Error('FAIL'); };
  await assert.rejects(m.searchWeights({ control, engine_sha256: 'e', evaluate: failed }), /NO_VALID_CONTROL/);
});
test('Product ordering handles epsilon, null recall last, severe 4→1 cost and missing grades without gates', async () => {
  const m = await api(), metrics = m.productMetrics([row(1, 1, 4)]);
  assert.equal(metrics.product_loss, 16); assert.equal(metrics.critical_overprediction.conditional_on_predicted4, 1);
  const base = { status: 'EVALUATED', candidate_id: 'a', metrics, control_weight_distance: 0 };
  const known = { ...base, candidate_id: 'z', metrics: { ...metrics, product_loss: metrics.product_loss + 1e-13, target_ge3: { recall: 0 } } };
  assert.equal(m.rank([base, known])[0].candidate_id, 'z');
  const no4 = m.productMetrics([row(2, 1, 1)]); assert.equal(no4.predicted4_actual_ge3_precision, null); assert.equal(no4.grade4_status, 'NOT_ASSESSED');
});
test('Phase 7 always selects improvement, tradeoff or Control; no grade support or constant-model gate', async () => {
  const m = await api();
  const record = (id, rows) => ({ candidate_id: id, weights, status: 'EVALUATED', metrics: m.productMetrics(rows), control_weight_distance: 0 });
  const control = record('control', [row(1, 1, 2), row(2, 3, 3), row(3, 4, 4), row(4, 0, 0), row(5, 2, 2)]);
  const perfect = record('perfect', [row(1, 1), row(2, 3), row(3, 4), row(4, 0), row(5, 2)]);
  assert.equal(m.selectPhase7([control, perfect], 'control').selection_status, 'SELECTED_IMPROVED');
  const sparseControl = record('control', [row(1, 0, 3), row(2, 1, 3), row(3, 3, 3)]);
  const low = record('low', [row(1, 0, 0), row(2, 1, 1), row(3, 3, 1)]);
  const selected = m.selectPhase7([sparseControl, low], 'control');
  assert.equal(selected.selection_status, 'SELECTED_WITH_TRADEOFFS'); assert.equal(selected.selected_candidate, 'low');
  assert.equal(selected.phase7_completed, true); assert.equal(selected.independent_validation, false);
  assert.ok(selected.tradeoffs.includes('TARGET_GE3_RECALL_LOWER')); assert.ok(selected.tradeoffs.includes('PREDICTION_4_NOT_ASSESSED'));
  assert.equal(m.selectPhase7([perfect, control], 'perfect').selection_status, 'KEEP_CONTROL');
  assert.equal(m.selectPhase7([perfect], 'perfect', 'WEIGHTS_NOT_EFFECTIVE').phase7_completed, true);
});
test('Pool dedup retains historical partitions and rejects conflicting snapshots and Event labels', async () => {
  const m = await api(), a = { ...row(1, 1), split: 'TRAIN' }; delete a.historical_splits;
  const b = { ...a, split: 'TEST', event_normalized_weight: .4 };
  const merged = m.mergeRows([{ split: 'TRAIN', rows: [a] }, { split: 'TEST', rows: [b] }]);
  assert.equal(merged.rows.length, 1); assert.equal(merged.duplicates, 1); assert.deepEqual(merged.rows[0].historical_splits, ['TEST', 'TRAIN']);
  assert.throws(() => m.mergeRows([{ split: 'TRAIN', rows: [a, { ...a, gt_ordinal: 2 }] }]), /CONFLICTING_DUPLICATE/);
  assert.throws(() => m.mergeRows([{ split: 'TRAIN', rows: [a, { ...a, snapshot_id: 's2', gt_ordinal: 2 }] }]), /CONFLICTING_EVENT/);
});
test('Pure Replay cache is isolated by input, full config and engine; failed candidates never lose rows', async () => {
  const m = await api(); let calls = 0;
  const runner = async (replay, { modelConfig }) => { calls++; return { actual: { score: Math.round(100 * modelConfig.scoring.weights.skyCanvas) } }; };
  const calc = m.replayCalculator('engine1', runner), r = row(1, 1), c = { weights };
  assert.equal((await calc.calculate(r, c)).score, 30); await calc.calculate(r, c); assert.equal(calls, 1);
  assert.equal((await calc.calculate(r, { weights: { ...weights, skyCanvas: .4, horizon: .1 } })).score, 40);
  await calc.calculate({ ...r, input_sha256: 'different' }, c); assert.equal(calls, 3);
  await m.replayCalculator('engine2', runner).calculate(r, c); assert.equal(calls, 4);
  const bad = m.replayCalculator('e', async replay => { if (replay.id === 2) throw Error('FAIL'); return { actual: { score: 30 } }; });
  await assert.rejects(m.evaluateWeights([row(1, 0), row(2, 1)], c, weights, bad));
  const mutating = m.replayCalculator('e', async (_, { modelConfig }) => { modelConfig.scoring.other = 1; return { actual: { score: 30 } }; });
  await assert.rejects(m.evaluateWeights([row(1, 0)], c, weights, mutating), /REPLAY_MUTATED_CONFIG/);
});
test('Control preflight alone fixes exclusions and recomputes Event confidence; empty input is execution error', async () => {
  const m = await api(), c = { weights }, a = row(1, 1), b = { ...a, snapshot_id: 's2', input_sha256: 'input2', replay: { id: 2 } }, d = row(3, 3);
  const calc = m.replayCalculator('e', async replay => { if (replay.id === 2) throw Error('BAD_INPUT'); return { actual: { score: 30 } }; });
  const result = await m.preflight({ rows: [a, b, d], exclusions: [] }, c, calc);
  assert.equal(result.rows.length, 2); assert.equal(result.exclusions.length, 1); assert.equal(result.rows[0].event_normalized_weight, 1);
  await assert.rejects(m.preflight({ rows: [], exclusions: [] }, c, calc), /NO_VALID_CONTROL_SAMPLES/);
  const wiring = await m.wiringCheck(result.rows, c, calc); assert.equal(wiring.status, 'WEIGHTS_NOT_EFFECTIVE');
});
test('Resume recovers only an exited lock owner, and refuses an active PID', async t => {
  const m = await api(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'practical-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'run.lock');
  await m.acquireRunLock(lock, false); await assert.rejects(m.acquireRunLock(lock, true), /PRACTICAL_RUN_ACTIVE_LOCK/);
  const { execFile } = require('node:child_process');
  const child = execFile(process.execPath, ['-e', ''], { windowsHide: true }); const pid = child.pid;
  await new Promise(resolve => child.on('exit', resolve));
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid }));
  await m.acquireRunLock(lock, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'))).pid, process.pid);
});
test('Real disk lightweight pipeline merges all splits, exports, fresh-recomputes, resumes, and detects corruption', { timeout: 120000 }, async t => {
  const m = await api(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'practical-v49-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await require('./evaluation-fixture.cjs').createSyntheticPipeline(root);
  // Historical workflow prerequisites are frozen at the original 2.4.6 base.
  await require('./helpers.cjs').pinLegacyTuningBase(t);
  t.after(fixture.close);
  const options = { raw: fixture.rawDir, gt: fixture.gtDir, model: fixture.modelDir, output: path.join(root, 'practical'), maxCandidates: 8 };
  const loaded = await m.loadPool(options); assert.deepEqual(loaded.historical_partitions, { TRAIN: 25, VALIDATION: 8, TEST: 8 });
  const result = await m.practicalRun(options); assert.equal(result.phase7_completed, true);
  const inspected = await m.inspectPractical(result.directory); assert.equal(inspected.status, 'PASS');
  assert.ok(inspected.result.selected_candidate); assert.equal(inspected.result.trial_config_available, true);
  const proof = await m.verifyPractical(result.directory); assert.equal(proof.status, 'PASS'); assert.equal(proof.recomputed_snapshots, 41);
  const requestFile = path.join(result.directory, 'verification_request.json'), request = JSON.parse(await fs.readFile(requestFile));
  request.selected_predictions[0] = (request.selected_predictions[0] + 1) % 101;
  await assert.rejects(m.verifyRequest(request), /FINAL_RECOMPUTE_MISMATCH/);
  const work = path.join(options.output, '.work', result.run_id); await fs.rename(result.directory, work);
  await fs.rm(path.join(work, 'manifest.json')); await fs.rm(path.join(work, 'candidates', (await fs.readdir(path.join(work, 'candidates')))[0]));
  const resumed = await m.practicalRun({ ...options, resume: true }); assert.equal(resumed.run_id, result.run_id);
  const history = (await fs.readFile(path.join(options.output, 'usage_history.jsonl'), 'utf8')).trim().split('\n'); assert.equal(history.length, 1);
  await fs.appendFile(path.join(resumed.directory, 'selected_effective_config.json'), ' ');
  await assert.rejects(m.inspectPractical(resumed.directory), /PRACTICAL_OUTPUT_HASH_MISMATCH/);
});
