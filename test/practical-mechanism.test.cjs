const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/mechanism-targeted', 'practical-tuning/mechanism-trace',
  'practical-tuning/mechanism-workflow', 'practical-tuning/workflow', 'practical-tuning/compute', 'practical-tuning/data',
  'practical-tuning/policy', 'practical-tuning/high-cloud', 'practical-tuning/migrations', 'tuning/lib/base-config', 'tuning/parameter-registry',
  'practical-tuning/worker'].map(n => import(`../tools/${n}.mjs`))).then(ms => Object.assign({}, ...ms)); }
const row = (id, gt) => ({ snapshot_id: id, event_id: id, event_date_local: '2026-09-01', location_key: id,
  gt_ordinal: gt, gt_confidence: .6, event_normalized_weight: .6, scheduled_slot: '1613' });
const config = () => ({ weights: { skyCanvas: .2, horizon: .375, illumination: .4, atmosphere: .025, weather: 0 },
  atmosphereQuality: { base: .7, scale: .3 }, goldenWindow: { floor: .5 }, weatherRegime: { minimumWeatherWeight: .05 },
  hardGate: { scoreCap: 15 }, highCloudCenter: 60, highCloudWidth: 25, midCloudCenter: 54, midCloudWidth: 34 });
function syntheticTrace({ score = 0, active = false } = {}) {
  const components = { skyCanvas: 80, horizon: 60, illumination: 20, atmosphere: 10, weather: 30 };
  const weights = Object.fromEntries(Object.keys(components).map(k => [k, .2])), contributions = Object.fromEntries(Object.keys(components).map(k => [k, components[k] * .2]));
  let previous = 40;
  const stage = (name, output) => { const s = { stage: name, input_score: previous, output_score: output, reason_code: 'OBSERVED_REPLAY_EXECUTION' }; previous = output; return s; };
  return { score, ordinal: score >= 60 ? 3 : 0, trace: { P: 40, Q: .8, horizon_gate: .5, components, dynamic_weights: weights, contributions,
    hard_gate_reasons: [], golden_window_active: active,
    golden_window_observation: active ? { sunset_open_probability: .5, applied_factor: .75 } : { status: 'NOT_EXECUTED' },
    stages: [{ stage: 'weighted_components', input_score: null, output_score: 40 }, stage('atmosphere_quality', 32), stage('horizon_gate', 16),
      stage('structure_bonus', 19), stage('transition_bonus', 17), stage('weather_penalty', score === 1 ? 1.3 : -8), stage('core_clamp', score === 1 ? 1.3 : 0), stage('hard_gate', score === 1 ? 1.3 : 0),
      stage('core_round', score), stage('sky_evolution', score), stage('golden_window', score), stage('final_clamp', score), stage('final_round', score)], final_score: score,
    nowcast: { status: 'NOT_EXECUTED' }, internal_trace_limits: ['SKY_PARTIAL'], executed_regime: { label: '晴朗', strength: .8 } } };
}
test('Mechanism trace conserves dynamic P, multipliers, negative clamp and rounding, retaining partial/unexecuted states', async () => {
  const m = await api(), r = row('high', 3), t = m.decomposeTrace(r, syntheticTrace(), config());
  assert.equal(t.P, 40); assert.equal(t.conservation.final_reconstructed, 0); assert.equal(t.conservation.total_stage_delta, -40);
  assert.equal(t.stages.find(s => s.stage === 'core_clamp').delta_score, 8);
  assert.equal(t.stages.find(s => s.stage === 'golden_window').status, 'NOT_EXECUTED');
  assert.equal(t.stages.find(s => s.stage === 'sky_evolution').status, 'PARTIAL_TRACE');
  assert.equal(t.nowcast.status, 'NOT_EXECUTED'); assert.equal(t.score_gap_to_ge3, 60);
  const rounding = m.decomposeTrace(r, syntheticTrace({ score: 1 }), config()); assert.ok(Math.abs(rounding.stages.find(s => s.stage === 'core_round').delta_score + .3) < 1e-12);
  const bad = syntheticTrace(); bad.trace.contributions.weather++; assert.throws(() => m.decomposeTrace(r, bad, config()), /COMPONENTS_INVALID/);
  const broken = syntheticTrace(); broken.trace.stages[3].input_score++;
  assert.throws(() => m.decomposeTrace(r, broken, config()), /CHAIN_BROKEN/);
  const missing = syntheticTrace(); missing.trace.stages.splice(6, 1);
  assert.throws(() => m.decomposeTrace(r, missing, config()), /STAGE_COVERAGE_INVALID/);
});
test('Mechanism groups include all low controls and partition misses; group means and pool contributions have distinct denominators', async () => {
  const m = await api(), rows = [row('hi', 3), row('lo', 1)], c = config();
  const traces = [m.decomposeTrace(rows[0], syntheticTrace({ active: true }), c), m.decomposeTrace(rows[1], syntheticTrace(), c)];
  const summary = m.summarizeMechanismTraces(rows, traces), miss = summary.groups.find(g => g.group === 'high_missed'), low = summary.groups.find(g => g.group === 'low_control');
  assert.equal(miss.snapshot_count, 1); assert.equal(low.snapshot_count, 1);
  const q = miss.stages.find(s => s.stage === 'atmosphere_quality');
  assert.equal(q.delta.group_conditional_weighted_mean, -8); assert.equal(q.delta.full_pool_weighted_mean_contribution, -4);
  assert.equal(low.stages.find(s => s.stage === 'golden_window').not_executed.snapshot_count, 1);
  assert.equal(low.stages.find(s => s.stage === 'golden_window').delta.group_conditional_weighted_mean, null);
  assert.equal(summary.causal_claim, false);
  assert.equal(summary.groups.find(g => g.group === 'low_actual_1').snapshot_count, 1);
});
test('Evidence target plan is deterministic, bounded, excludes unobserved/partial mechanisms and changes one scalar only', async () => {
  const m = await api(), rows = [row('hi', 3), row('lo', 1)], c = config();
  const traces = rows.map(r => m.decomposeTrace(r, syntheticTrace({ active: true }), c)), summary = m.summarizeMechanismTraces(rows, traces);
  const plan = m.buildTargetPlan(rows, traces, summary, c); assert.deepEqual(m.buildTargetPlan(rows, traces, summary, c), plan);
  assert.ok(plan.selected.length <= 3); assert.ok(plan.selected.every(p => p.probe_values.length <= 4 && p.wired_status === 'WIRED'));
  assert.ok(plan.not_selected.some(p => p.parameter_id === 'hard_gate_score_cap' && !p.actionable));
  assert.ok(plan.not_selected.some(p => p.parameter_id === 'skyState.factorRange' && p.selection_reason.includes('PARTIALLY_WIRED')));
  const next = m.installMechanism(c, { parameter_id: 'golden_window_floor', value: .6 });
  assert.equal(next.goldenWindow.floor, .6); assert.equal(c.goldenWindow.floor, .5);
  next.goldenWindow.floor = .5; assert.deepEqual(next, c);
  const model = m.buildModelConfig(m.installMechanism(c, { parameter_id: 'golden_window_floor', value: .6 }));
  assert.equal(model.goldenWindow, model.scoring.goldenWindow);
  for (const p of [{ parameter_id: 'component_weights', value: .3 }, { parameter_id: 'mid_cloud_center', value: 40 }, { parameter_id: 'golden_window_floor', value: 1.1 },
    { parameter_id: 'hard_gate_score_cap', value: 25.5 }]) assert.throws(() => m.installMechanism(c, p));
  assert.deepEqual(m.probeValues(m.registryUnit('hard_gate_score_cap'), 15), [5, 10, 25, 40]);
  assert.equal(m.digest(m.MECHANISM_POLICY), m.digest(JSON.parse(JSON.stringify(m.MECHANISM_POLICY))));
});
test('Targeted trial probes at most three scalars and refines only one, resumes deterministically and records whole-point errors', async () => {
  const m = await api(), c = config(), original = c, rows = [row('high', 3), row('low', 1)], baseMetrics = m.highCloudMetrics(rows, [60, 30]);
  const plan = { selected: [{ parameter_id: 'golden_window_floor', probe_values: [.4, .45, .55, .6] },
    { parameter_id: 'atmosphere_quality_base', probe_values: [.6, .65, .75, .8] }, { parameter_id: 'minimum_weather_weight', probe_values: [0, .02, .1, .15] }] };
  let calls = 0;
  const opts = { current: c, original, engine_sha256: 'e', plan, originalMetrics: baseMetrics, evaluate: async candidate => {
    calls++; const p = candidate.parameters; if (p.parameter_id === 'minimum_weather_weight' && p.value === .15) throw Error('TEST_POINT_ERROR');
    const loss = p.parameter_id === null ? 1 : p.parameter_id === 'golden_window_floor' ? 1 - (p.value - .5) : 1.2;
    return { metrics: { ...baseMetrics, product_loss: loss }, paired_migrations: { net_recovered_weight: 0 } };
  } };
  const s = await m.searchMechanisms(opts); assert.ok(s.records.length <= 25); assert.equal(s.budget.errors, 1);
  assert.equal(s.refinement.parameter_id, 'golden_window_floor'); assert.equal(s.refinement.values.length, 12);
  assert.ok(s.refinement.values.every(v => v > .5 && v < .6));
  assert.equal(new Set(s.records.filter(r => r.stage === 'REFINEMENT').map(r => r.parameters.parameter_id)).size, 1);
  const n = calls; assert.deepEqual(await m.searchMechanisms({ ...opts, restored: s.records, frozenRefinement: s.refinement }), s); assert.equal(calls, n);
  await assert.rejects(m.searchMechanisms({ ...opts, restored: s.records, frozenRefinement: { ...s.refinement, values: [] } }), /RESUME_REFINEMENT_PLAN_MISMATCH/);
  assert.equal((await m.searchMechanisms({ ...opts, maxCandidates: 2 })).budget.termination, 'BUDGET_REACHED');
  await assert.rejects(m.searchMechanisms({ ...opts, evaluate: async () => { throw Error('BASE_FAIL'); } }), /NO_VALID_BASELINE/);
});
test('Refinement falls back only to positive net recovery; selection must beat latest C and loss-only gain is not recognition gain', async () => {
  const m = await api(), c = config(), metrics = m.highCloudMetrics([row('h', 3), row('l', 1)], [60, 30]);
  const rec = (id, loss, recall, net = 0) => ({ candidate_id: id, stage: id === 'C' ? 'C_BASELINE' : 'PROBE', parameters: { parameter_id: 'golden_window_floor', value: .6 },
    status: 'EVALUATED', parameter_distance: .1, metrics: { ...metrics, product_loss: loss, target_ge3: { ...metrics.target_ge3, recall } }, paired_migrations: { net_recovered_weight: net } });
  const baseline = rec('C', 1.1, .2), b0 = { ...metrics, product_loss: 1.2, target_ge3: { recall: .2 } };
  const onlyB0 = rec('onlyB0', 1.15, .25, .1), collapse = rec('collapse', .8, .1), lossGain = rec('loss', 1.09, .2);
  assert.equal(m.selectMechanism([baseline, onlyB0, collapse], 'C', b0).selection_status, 'KEEP_CONTROL');
  assert.equal(m.selectMechanism([baseline, lossGain], 'C', b0).high_grade_recognition_improved, false);
  assert.equal(m.selectMechanism([baseline, rec('recognized', 1.09, .21, .1)], 'C', b0).high_grade_recognition_improved, true);
  const plan = { selected: [{ parameter_id: 'golden_window_floor' }] };
  assert.equal(m.chooseRefinement([baseline, onlyB0], 'C', b0, c, plan).status, 'REFINE_LOWEST_LOSS_POSITIVE_NET_RECOVERY');
  assert.equal(m.chooseRefinement([baseline, rec('no', 1.2, .2)], 'C', b0, c, plan).status, 'STOP_NO_IMPROVEMENT_OR_NET_RECOVERY');
});
test('Trace collection rejects observer prediction drift and never silently excludes a failing member', async () => {
  const m = await api(), r = row('r', 3), calc = { assertConfig() {}, calculate: async (_, __, trace) => ({ score: trace ? 1 : 0, ordinal: 0, trace: syntheticTrace().trace }) };
  await assert.rejects(m.collectMechanismTraces([r], config(), [0], calc), /MECHANISM_TRACE_SWITCH_CHANGED_PREDICTION/);
});
test('No actionable parameter keeps C and completes Phase7 without inventing an intervention', async () => {
  const m = await api(), r = row('r', 3), c = config(), value = syntheticTrace();
  value.trace.P = 0; value.trace.Q = 1;
  for (const k of Object.keys(value.trace.components)) { value.trace.components[k] = 0; value.trace.contributions[k] = 0; }
  for (const s of value.trace.stages) { if (s.input_score !== null) s.input_score = 0; s.output_score = 0; }
  const traces = [m.decomposeTrace(r, value, c)], summary = m.summarizeMechanismTraces([r], traces), plan = m.buildTargetPlan([r], traces, summary, c);
  assert.equal(plan.diagnostic_status, 'NO_ACTIONABLE_PARAMETER'); assert.deepEqual(plan.selected, []);
  const metrics = m.highCloudMetrics([r], [0]), search = await m.searchMechanisms({ current: c, original: c, engine_sha256: 'e', plan, originalMetrics: metrics,
    evaluate: async () => ({ metrics, paired_migrations: m.pairedMigrations([r], [0], [0]) }) });
  assert.equal(search.records.length, 1); const result = m.selectMechanism(search.records, search.baseline_id, metrics);
  assert.equal(result.selection_status, 'KEEP_CONTROL'); assert.equal(result.phase7_completed, true);
});
test('Mechanism disk pipeline loads V3 selected C, traces full pool, exports, resumes and verifies V1–4', { timeout: 300000 }, async t => {
  const m = await api(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'mechanism-p12-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await require('./evaluation-fixture.cjs').createSyntheticPipeline(root); t.after(fixture.close);
  // Historical workflow prerequisites are frozen at the original 2.4.6 base.
  await require('./helpers.cjs').pinLegacyTuningBase(t);
  const sources = { raw: fixture.rawDir, gt: fixture.gtDir, model: fixture.modelDir }, output = path.join(root, 'runs');
  const v1 = await m.practicalRun({ ...sources, output, recognitionFirst: true, maxCandidates: 4 });
  const v2 = await m.practicalRun({ ...sources, output, searchSpace: 'high-cloud', baselineRun: v1.directory, maxCandidates: 4 });
  const v3 = await m.practicalRun({ ...sources, output, searchSpace: 'mid-cloud', baselineRun: v2.directory, maxCandidates: 4 });
  const parent = await m.loadMechanismParent(v3.directory);
  assert.deepEqual(parent.baseline, JSON.parse(await fs.readFile(path.join(v3.directory, 'selected_effective_config.json'))));
  const opts = { ...sources, output, searchSpace: 'mechanism-targeted', baselineRun: v3.directory, maxCandidates: 5 };
  const run = await m.practicalRun(opts), inspected = await m.inspectPractical(run.directory), req = JSON.parse(await fs.readFile(path.join(run.directory, 'verification_request.json')));
  assert.equal(inspected.manifest.practical_tuning_schema_version, 4); assert.equal(run.phase7_completed, true);
  assert.equal(req.trace_rows.length, req.pool.included.length); assert.ok(req.trace_rows.every(t => t.conservation.status === 'PASS'));
  assert.deepEqual(req.spec.baseline_config, parent.baseline);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run.directory, 'rollback_config.json'))), parent.baseline);
  assert.ok(req.target_plan.selected.length <= 3); assert.match(await fs.readFile(path.join(run.directory, 'report.md'), 'utf8'), /唯一优先后续动作/);
  assert.equal((await m.verifyPractical(run.directory)).trace_switch_parity_and_conservation, true);
  const bad = structuredClone(req); bad.trace_rows[0].contributions.weather++;
  await assert.rejects(m.verifyMechanismRequest(bad), /FINAL_TRACE_RECOMPUTE_MISMATCH/);
  const wrong = structuredClone(req); wrong.selected.scores[0]++;
  await assert.rejects(m.verifyMechanismRequest(wrong), /FINAL_RECOMPUTE_MISMATCH/);
  const plan = structuredClone(req); plan.target_plan.selected.reverse();
  if (plan.target_plan.selected.length > 1) assert.throws(() => m.validateMechanismRequest(plan), /PLAN_OR_TRACE_BINDING_MISMATCH/);
  for (const v of [v1, v2, v3]) assert.equal((await m.verifyPractical(v.directory)).status, 'PASS');
  const preparation = path.join(output, '.work', `practical_preparation_v4_${req.spec.identity.base_identity_sha256.slice(0, 20)}`);
  await fs.rename(run.directory, preparation); await fs.rm(path.join(preparation, 'manifest.json'));
  const before = await fs.readFile(path.join(preparation, 'target_plan.json'));
  assert.equal((await m.practicalRun({ ...opts, resume: true })).run_id, run.run_id);
  assert.deepEqual(await fs.readFile(path.join(run.directory, 'target_plan.json')), before);
  assert.equal((await m.practicalRun(opts)).deduplicated, true);
  await fs.appendFile(path.join(run.directory, 'trace_rows.jsonl'), ' ');
  await assert.rejects(m.inspectPractical(run.directory), /PRACTICAL_OUTPUT_HASH_MISMATCH/);
});
