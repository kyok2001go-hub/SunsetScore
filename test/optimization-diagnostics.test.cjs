const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let modules;
async function api() {
  return modules ||= Promise.all(['optimization-diagnostics/policy', 'optimization-diagnostics/engine',
    'optimization-diagnostics/workflow', 'optimization/lib/selection', 'optimization/lib/search-space',
    'optimization/lib/generator', 'optimization/lib/candidate', 'optimization/lib/beam',
    'optimization/optimization-policy', 'validation/validation-policy', 'validation/validation-schema',
    'optimization-diagnostics/package', 'experiment-runtime/lib/package', 'maintenance/maintenance-policy']
    .map(name => import(`../tools/${name}.mjs`))).then(list => Object.assign({}, ...list));
}
async function fixture() {
  const m = await api();
  const config = { w: { x: 0.5, y: 0.5 }, base: 0.7, scale: 0.3, center: 60, width: 25,
    horizonGate: [{ min: 10, gate: 30 }, { min: 5, gate: 20 }] };
  const oat = (id, key, values, range) => ({ parameter_id: id, canonical_path: key, probe_absolute: values,
    range, unit_category: 'OAT', optimizable: true, wired_status: 'WIRED', replay_class: 'REPLAY_SAFE' });
  const registry = { units: [
    { parameter_id: 'component_weights', canonical_path: 'w', members: ['x', 'y'], probe_factors: [0.8, 1.2],
      unit_category: 'SIMPLEX', optimizable: true, wired_status: 'WIRED', replay_class: 'REPLAY_SAFE' },
    oat('atmosphere_quality_base', 'base', [0.49, 0.595, 0.7, 0.805, 0.91], [0, 1]),
    oat('atmosphere_quality_scale', 'scale', [0.21, 0.255, 0.3, 0.345, 0.39], [0, 1]),
    oat('high_cloud_center', 'center', [42, 51, 60, 69, 78], [0, 100]),
    oat('high_cloud_width', 'width', [18, 21, 25, 29, 33], [1, 60]) ] };
  const baseConfig = { config, sha256: m.digest(config) }, linkage = { parameter_registry_sha256: m.digest(registry) };
  const space = { ...m.buildSearchSpace({ mode: 'EXPLORATORY_SEARCH', registry, baseConfig, linkage,
    readiness: { parameter_readiness: [] }, policyVersion: 4 }), base_config: baseConfig };
  const cohort = Array.from({ length: 20 * 4 }, (_, i) => ({ snapshot_id: `s${String(i).padStart(3, '0')}`, event_id: `e${i}`,
    event_date_local: `2026-09-${String(1 + Math.floor(i / 4)).padStart(2, '0')}`, location_key: `city${i % 4}`,
    gt_ordinal: i % 4, gt_label: ['poor', 'fair', 'good', 'very_good'][i % 4], gt_confidence: 1,
    event_normalized_weight: 1, lead_time_bucket: 'T_0_30M', regime_label: '晴',
    replay: { target: [10, 30, 50, 70][i % 4] } }));
  const runner = async (replay, { modelConfig, reference } = {}) => ({ pass: reference ? true : null, actual: {
    score: replay.target + (modelConfig?.scoring.base === 0.7 ? 20 : 0), gw_factor: 1, sky_evolution_factor: 1 } });
  const sourceManifest = { runtime: { engine_runtime_sha256: 'fixture' } };
  return { m, config, registry, baseConfig, linkage, space, cohort, runner, sourceManifest };
}
test('explicit version matrix preserves defaults and refuses unknown/formal development capabilities', async () => {
  const m = await api();
  assert.equal(m.optimizationPolicy().optimization_policy_version, 1);
  assert.equal(m.validationPolicy().validation_policy_version, 1);
  assert.equal(m.optimizationPolicy(4).optimization_schema_version, 2);
  assert.deepEqual(m.optimizationPolicy(4).modes, ['EXPLORATORY_SEARCH']);
  assert.equal(m.validationPolicy(4).formal_capable, false);
  assert.throws(() => m.optimizationPolicy(6)); assert.throws(() => m.validationPolicy(6));
  assert.throws(() => m.diagnosticPolicy(2)); assert.throws(() => m.diagnosticSchema(2));
  assert.throws(() => m.validationSchema({ policyVersion: 4, includeSelected: true }));
});
test('matrix expands legal canonical SIMPLEX vectors, exact single changes and hard budget', async () => {
  const { m, space } = await fixture();
  const matrix = m.fixedMatrix(space);
  assert.ok(matrix.length <= 40); assert.deepEqual(matrix[0].canonical_vector, {});
  assert.deepEqual(matrix.find(r => r.label === 'ATMOSPHERE_BASE_0.595').canonical_vector, { atmosphere_quality_base: 0.595 });
  assert.deepEqual(matrix.find(r => r.label === 'AGGRESSIVE_NEGATIVE_CONTROL').canonical_vector,
    { atmosphere_quality_base: 0.4375, atmosphere_quality_scale: 0.21 });
  assert.equal(new Set(matrix.map(r => m.digest(r.canonical_vector))).size, matrix.length);
  for (const entry of matrix.filter(r => r.label === 'COMPONENT_WEIGHTS_PROBE')) {
    assert.equal(Object.keys(entry.canonical_vector).length, 1);
    assert.ok(Math.abs(Object.values(entry.canonical_vector.component_weights).reduce((s, x) => s + x) - 1) < 1e-12);
  }
  assert.throws(() => m.fixedMatrix(space, 1), e => e.code === 'PLAN_BUDGET_EXCEEDED');
});
test('Policy 4 Registry space is independent of whole-TRAIN Sensitivity effects', async () => {
  const { m, registry, linkage, baseConfig, space } = await fixture();
  const hostile = { parameter_readiness: registry.units.map(u => ({ parameter_id: u.parameter_id,
    parameter_readiness: 'NOT_READY', observability_status: 'NOT_OBSERVABLE', support_events: 0 })) };
  const changed = m.buildSearchSpace({ mode: 'EXPLORATORY_SEARCH', registry, linkage, baseConfig, readiness: hostile, policyVersion: 4 });
  const { base_config, ...original } = space;
  assert.deepEqual(changed, original);
});
test('SIMPLEX coordinate/refinement preserves parent scalars and proportions in new policy', async () => {
  const { m, space } = await fixture();
  const parent = { canonical_vector: { atmosphere_quality_base: 0.595 } };
  for (const p of [...m.coordinateExpansions({ searchSpace: space, parent }),
    ...m.refinementProposals({ searchSpace: space, parent, round: 1 })].filter(p => p.parameter_id === 'component_weights')) {
    assert.equal(p.vector.atmosphere_quality_base, 0.595);
    const c = m.canonicalizeCandidate({ vector: p.vector, searchSpace: space, baseConfig: space.base_config, optimizationInputId: 'fixture' });
    assert.equal(c.ok, true);
  }
});
test('independent weighted grade Golden: repeated Snapshots, null support and high recall', async () => {
  const m = await api();
  const rows = [
    { event_id: 'a', snapshot_id: 'a1', gt_ordinal: 0, control_ordinal: 1, experiment_ordinal: 0 },
    { event_id: 'a', snapshot_id: 'a2', gt_ordinal: 0, control_ordinal: 1, experiment_ordinal: 2 },
    { event_id: 'b', snapshot_id: 'b1', gt_ordinal: 2, control_ordinal: 2, experiment_ordinal: 1 }
  ].map(r => ({ ...r, gt_confidence: 1 }));
  const metrics = m.diagnosticMetrics(rows);
  assert.equal(metrics.control.mae, 0.5); assert.equal(metrics.candidate.mae, 1);
  assert.equal(metrics.grades[0].candidate_recall, 0.5);
  assert.equal(metrics.grades[1].candidate_recall, null); assert.equal(metrics.grades[1].reason_code, 'NO_GT_SUPPORT');
  assert.equal(metrics.high_grade_recall.control, 1); assert.equal(metrics.high_grade_recall.candidate, 0);
  assert.deepEqual(metrics.confusion.candidate[0], [0.5, 0, 0.5, 0, 0]);
});
test('MAE compression with worse Bias/QWK is feasible but diagnostic only', async () => {
  const { m, space } = await fixture();
  const candidate = m.canonicalizeCandidate({ vector: { atmosphere_quality_base: 0.49 }, searchSpace: space,
    baseConfig: space.base_config, optimizationInputId: 'fixture' });
  const rows = Array.from({ length: 40 }, (_, i) => ({ event_id: `e${i}`, snapshot_id: `s${i}`,
    event_date_local: `2026-09-${String(i % 20 + 1).padStart(2, '0')}`, gt_confidence: 1,
    gt_ordinal: i % 4 === 0 ? 3 : 1, control_ordinal: i % 4 === 0 || i % 4 === 2 ? 3 : 0, experiment_ordinal: 1 }));
  const record = m.qualityRecord({ status: 'EVALUABLE', rows,
    coverage: { control_source_coverage_rate: 1, candidate_control_coverage_rate: 1 } }, candidate, 1);
  assert.equal(record.status, 'FEASIBLE'); assert.ok(record.metrics.mae < record.control.mae);
  assert.equal(record.train_all_guards_pass, false); assert.equal(record.quality, 'SEARCH_DIAGNOSTIC_ONLY');
  assert.ok(record.reason_codes.includes('ABSOLUTE_BIAS_WORSE_THAN_CONTROL'));
  assert.ok(record.reason_codes.includes('QWK_WORSE_THAN_CONTROL'));
  assert.equal(record.metrics.severe_error_rate, record.control.severe_error_rate);
  assert.deepEqual(m.diagnosticMetrics(rows).high_grade_recall, { denominator: 10, reason_code: null, control: 1, candidate: 0 });
  assert.equal(m.candidateQuality({ gates: [] }).train_all_guards_pass, false);
});
function point(id, mae, bias, qwk, quality = 0, vector = { [id]: 1 }) {
  return { status: 'FEASIBLE', candidate: { candidate_id: id, canonical_vector: vector,
    changed_unit_count: 1, normalized_parameter_distance: 1 }, metrics: { mae, bias, qwk, severe_error_rate: 0, within_1_accuracy: 1 },
  train_all_guards_pass: quality === 2, basic_guards_pass: quality > 0, quality: ['SEARCH_DIAGNOSTIC_ONLY', 'BASIC_GUARDS_PASS', 'TRAIN_ALL_GUARDS_PASS'][quality] };
}
test('Pareto Golden includes null QWK, strict quantization, deterministic layers and exact dedup', async () => {
  const m = await api();
  const a = point('a', 0.3, 0.1, 0.5), b = point('b', 0.4, 0.1, 0.5), c = point('c', 0.2, 0.2, null);
  assert.equal(m.dominates(a, b), true); assert.equal(m.dominates(a, c), false);
  assert.equal(m.dominates(point('x', 0.3 + 1e-14, 0.1, 0.5), a), false);
  assert.deepEqual(m.paretoLayers([b, c, a]).map(l => l.map(r => r.candidate.candidate_id)), [['c', 'a'], ['b']]);
  const duplicate = point('z', 0.3, 0.1, 0.5, 0, { a: 1 });
  assert.deepEqual(m.selectParents([b, c, a, duplicate]).map(s => s.candidate_id),
    m.selectParents([duplicate, a, c, b]).map(s => s.candidate_id));
  assert.equal(m.uniqueRecords([a, duplicate]).length, 1);
});
test('parent seats Golden has 4/2/2 quotas, unique support preference and deterministic fallback', async () => {
  const m = await api();
  const all = Array.from({ length: 5 }, (_, i) => point(`a${i}`, 0.2 + i / 100, 0.1, 0.7, 2));
  const basic = [point('b1', 0.1, 0.1, 0.8, 1), point('b2', 0.09, 0.2, 0.8, 1)];
  const other = [point('d1', 0.05, 0.5, 0.1), point('d2', 0.04, 0.6, 0.2)];
  const seats = m.selectParents([...all, ...basic, ...other]);
  assert.deepEqual(seats.map(s => s.source), [...Array(4).fill('TRAIN_ALL_GUARDS_PASS'),
    ...Array(2).fill('BASIC_PARETO_FRONT'), ...Array(2).fill('EXPLORATORY_PARETO_FRONT')]);
  assert.equal(m.selectParents(all).length, 5);
});
test('date folds use exact 10/4,14/3,17/3 blocks and refuse cross-date Events or insufficient support', async () => {
  const { m, cohort } = await fixture();
  const folds = m.dateFolds(cohort);
  assert.equal(folds.status, 'READY');
  assert.deepEqual(folds.folds.map(f => [f.train_dates.length, f.held_dates.length]), [[10, 4], [14, 3], [17, 3]]);
  assert.equal(m.dateFolds(cohort.slice(0, 18 * 4)).status, 'INNER_CV_INSUFFICIENT');
  assert.throws(() => m.dateFolds([...cohort, { ...cohort[0], snapshot_id: 'new', event_date_local: '2026-09-30' }]));
  for (const fold of folds.folds) assert.equal(new Set([...fold.train_members, ...fold.held_members].map(r => r.snapshot_id)).size,
    fold.train_members.length + fold.held_members.length);
});
test('fold no-skill counts each Event once and is independently re-estimated', async () => {
  const m = await api();
  assert.equal(m.estimateNoSkill([{ event_id: 'a', gt_ordinal: 0, gt_confidence: 1 },
    ...Array(10).fill({ event_id: 'b', gt_ordinal: 4, gt_confidence: 0.6 })]), 0);
  assert.equal(m.estimateNoSkill([{ event_id: 'b', gt_ordinal: 4, gt_confidence: 0.6 }]), 4);
});
test('search unique budgets include invalid attempts and all beam/refinement selections emit quality traces', async () => {
  const { m, cohort, space, runner } = await fixture();
  const result = await m.searchCohort({ cohort: cohort.slice(0, 40), searchSpace: space, runReplay: runner });
  assert.ok(result.budget.unique_candidates <= 100); assert.ok(result.budget.used_ab <= 80); assert.ok(result.budget.used_c <= 20);
  assert.ok(result.selection_trace.some(t => t.stage === 'BEAM'));
  assert.ok(result.selection_trace.some(t => t.stage === 'REFINEMENT'));
  assert.equal(result.converged, false); assert.equal(result.termination, 'BUDGET_EXHAUSTED');
  assert.equal(result.budget.unique_candidates, result.traces.filter(t => t.budget_index !== null).length);
});
test('held labels/future data cannot change an earlier fold search trace, candidate or no-skill', async () => {
  const { m, cohort, space, runner } = await fixture();
  const fold = m.dateFolds(cohort).folds[0];
  const search = data => m.searchCohort({ cohort: data.filter(r => fold.train_dates.includes(r.event_date_local)), searchSpace: space, runReplay: runner });
  const first = await search(cohort);
  const changed = cohort.map(r => fold.train_dates.includes(r.event_date_local) ? r :
    { ...r, gt_ordinal: 4, replay: { target: 95 } });
  const second = await search(changed);
  assert.deepEqual(first, second);
  const changedSource = { ...space, units: space.units.map(u => ({ ...u,
    sensitivity_evidence: { ...u.sensitivity_evidence, sensitivity_id: 'different_full_train_history' } })) };
  const third = await m.searchCohort({ cohort: changed.filter(r => fold.train_dates.includes(r.event_date_local)),
    searchSpace: changedSource, runReplay: runner });
  assert.deepEqual(first, third);
});
test('full diagnostic workflow supports synthetic improvement, byte determinism and proposal cap', async () => {
  const { m, cohort, space, runner, sourceManifest } = await fixture();
  const plan = m.makeDiagnosticPlan({ cohort, searchSpace: space, sourceManifest });
  const run = () => m.computeDiagnostics({ plan, cohort, searchSpace: space, sourceManifest, runReplay: runner });
  const first = await run(), second = await run();
  assert.equal(m.digest(first.payloads), m.digest(second.payloads));
  assert.equal(first.payloads['decision.json'].status, 'DEVELOPMENT_CANDIDATES_FROZEN');
  assert.ok(first.payloads['reports/summary.json'].proposals <= 440);
  assert.ok(first.candidates.length > 0 && first.candidates.length <= 5);
  assert.equal(first.payloads['decision.json'].formal_promotion_allowed, false);
  assert.equal(first.payloads['oof_summary.json'].status, 'PROCEDURE_SUPPORTED');
  const ids = new Set(first.payloads['matrix_metrics.json'].map(r => r.candidate.candidate_id));
  for (const file of ['grade_metrics.json', 'prediction_distribution.json', 'slice_metrics.json']) {
    assert.ok(first.payloads[file].length > 0);
    assert.ok(first.payloads[file].every(r => ids.has(r.candidate_id)), `${file} must identify each probe`);
  }
  const weightIds = new Set(first.payloads['matrix_metrics.json'].filter(r => r.label === 'COMPONENT_WEIGHTS_PROBE').map(r => r.candidate.candidate_id));
  assert.deepEqual(new Set(first.payloads['grade_metrics.json'].filter(r => r.matrix_label === 'COMPONENT_WEIGHTS_PROBE').map(r => r.candidate_id)), weightIds);
});
test('missing fold candidates/Replay failures stop before full TRAIN and never fill candidate quotas', async () => {
  const { m, cohort, space, sourceManifest } = await fixture();
  const plan = m.makeDiagnosticPlan({ cohort, searchSpace: space, sourceManifest });
  const result = await m.computeDiagnostics({ plan, cohort, searchSpace: space, sourceManifest,
    runReplay: async replay => ({ pass: false, actual: { score: replay.target, gw_factor: 1, sky_evolution_factor: 1 } }) });
  assert.equal(result.finalSearch, null); assert.deepEqual(result.candidates, []);
  assert.equal(result.payloads['decision.json'].status, 'INCONCLUSIVE');
  assert.ok(result.payloads['fold_metrics.json'].every(f => f.status === 'NO_FOLD_CANDIDATE'));
  assert.equal(result.payloads['decision.json'].auto_validation_allowed, false);
});
test('diagnostic immutable publication deduplicates, detects tampering and registers lineage', async t => {
  const m = await api();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-v45-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { cohort, space, sourceManifest } = await fixture();
  const payloads = { 'schema.json': m.diagnosticSchema(), 'policy.json': m.diagnosticPolicy(),
    'plan.json': m.makeDiagnosticPlan({ cohort, searchSpace: space, sourceManifest }), 'source_manifest.json': sourceManifest };
  const options = { output: temp, kind: 'optimization_diagnostic_plan', idField: 'diagnostic_plan_id',
    links: { diagnostic_schema_version: 1, diagnostic_policy_version: 1, result_usage: 'DEVELOPMENT_ONLY' },
    payloads, validateStaging: m.inspectDiagnostic };
  const [first, second] = await Promise.all([m.publishGovernancePackage(options), m.publishGovernancePackage(options)]);
  assert.deepEqual([first.status, second.status].sort(), ['DEDUPLICATED', 'EXPORTED']);
  assert.ok(m.PHASES.some(p => p.key === 'optimization_diagnostic'));
  await fs.appendFile(path.join(first.directory, 'plan.json'), ' ');
  await assert.rejects(() => m.inspectDiagnostic(first.directory));
});

test('invalid proposals consume budget, duplicates do not, and no quality candidates are manufactured', async () => {
  const { m, cohort, space, runner } = await fixture();
  const altered = { ...space, units: space.units.map(unit => unit.parameter_id === 'atmosphere_quality_base' ?
    { ...unit, coarse_values: [-1, 0.7, 2] } : unit) };
  const result = await m.searchCohort({ cohort: cohort.slice(0, 40), searchSpace: altered, runReplay: runner });
  const invalid = result.traces.filter(r => r.outcome === 'INFEASIBLE');
  assert.ok(invalid.length >= 2);
  assert.equal(result.budget.unique_candidates, result.records.length + invalid.length);
  assert.deepEqual(m.summarizeSearch({ records: result.records.map(r => ({ ...r, train_all_guards_pass: false })) }).train_qualified_candidates, []);
});

test('Policy 4 validation uses bound history registry and rejects caller path substitutions', async t => {
  const { developmentValidationOptions } = await import('../tools/optimization-diagnostics/validation-options.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-sources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = path.join(root, 'sources.json');
  const doc = { sources_schema_version: 1, ...Object.fromEntries(['raw','gt','model','baseline','sensitivity',
    'runtimeBundle','historyLedgers','accessLedger'].map(key => [key, key])) };
  await fs.writeFile(sources, JSON.stringify(doc));
  const resolved = await developmentValidationOptions({ sources });
  assert.equal(resolved.historyLedgers, path.join(root, 'historyLedgers'));
  assert.equal(resolved.accessLedger, path.join(root, 'accessLedger'));
  await assert.rejects(() => developmentValidationOptions({ sources, accessLedger: path.join(root, 'different') }),
    e => e.code === 'DIAGNOSTIC_SOURCE_PATH_MISMATCH');
});

test('pure Replay cache separates config/input hashes and freezes nested captured inputs', async () => {
  const m = await api(); let calls = 0;
  const run = m.cachedReplay(async replay => { calls++; return { actual: { score: replay.nwp.value } }; }, 'runtime');
  const replay = { nwp: { value: 30 } }, config = { scoring: { base: 0.7 } };
  await run(replay, { modelConfig: config }); await run(replay, { modelConfig: config });
  await run({ nwp: { value: 30 } }, { modelConfig: { scoring: { base: 0.7 } } });
  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(replay.nwp), true); assert.equal(Object.isFrozen(config.scoring), true);
  await run({ nwp: { value: 31 } }, { modelConfig: config });
  await run(replay, { modelConfig: { scoring: { base: 0.8 } } }); assert.equal(calls, 3);
});

test('frozen Optimization Plan is a declared lineage parent and rejects changed search evidence', async t => {
  const m = await api();
  const { optimizationPlanReference } = await import('../tools/optimization-diagnostics/plan-binding.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'optimization-plan-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const h = '1'.repeat(64), sourceIds = { model: { id: 'model_fixture', manifest_sha256: h } };
  const evidence = { diagnostic_plan_id: 'diagnostic_plan_fixture', diagnostic_plan_manifest_sha256: h,
    diagnostic_id: 'diagnostic_fixture', diagnostic_manifest_sha256: h };
  const development = { evidence, candidates: [], frozen: { sourceManifest: { source_ids: sourceIds } } };
  const doc = { optimization_schema_version: 2, optimization_policy_version: 4, result_usage: 'DEVELOPMENT_ONLY',
    diagnostic_source: evidence, final_candidates: [], source_ids: sourceIds, search_policy: m.optimizationPolicy(4) };
  const published = await m.publishGovernancePackage({ output: root, kind: 'optimization_search_plan', idField: 'optimization_plan_id',
    payloads: { 'optimization_plan.json': doc }, links: { ...evidence, source_ids: sourceIds, result_usage: 'DEVELOPMENT_ONLY' } });
  const reference = await optimizationPlanReference(published.directory, development);
  assert.equal(reference.optimization_plan_id, published.optimization_plan_id);
  assert.ok(m.dependenciesOf(m.phaseByKey('optimization'), reference).some(e => e.id === reference.optimization_plan_id));
  await assert.rejects(() => optimizationPlanReference(published.directory, { ...development,
    evidence: { ...evidence, diagnostic_id: 'changed' } }));
  const changed = structuredClone(doc); changed.search_policy.algorithm.stage_a_b_budget = 79;
  const bad = await m.publishGovernancePackage({ output: root, kind: 'optimization_search_plan', idField: 'optimization_plan_id',
    payloads: { 'optimization_plan.json': changed }, links: { ...evidence, source_ids: sourceIds, result_usage: 'DEVELOPMENT_ONLY' } });
  await assert.rejects(() => optimizationPlanReference(bad.directory, development));
});

test('new Optimization package validates quality-only finalists and stays permanently development only', async t => {
  const { m, cohort, space, registry, baseConfig, runner } = await fixture();
  const [{ buildOptimizationPackage, optimizationInputIdentity }, { sourceIdentity }, { inspectOptimization },
    { canonicalJson }, { supportDocument }, { TEST_FIXTURE }] = await Promise.all([
    import('../tools/optimization/lib/build.mjs'), import('../tools/optimization/lib/input.mjs'),
    import('../tools/optimization/validate-optimization.mjs'), import('../tools/dataset/lib/common.mjs'),
    import('../tools/gt-level-support.mjs'), import('../tools/formal/contracts.mjs')]);
  const h = '1'.repeat(64), support = supportDocument(cohort, 'TRAIN');
  const linkage = { sensitivity_id: 'sensitivity_fixture', tuning_schema_version: 2, tuning_policy_version: 3,
    sensitivity_manifest_sha256: h, sensitivity_descriptor_sha256: h, parameter_registry_version: 1,
    parameter_registry_sha256: m.digest(registry), tuning_base_config_sha256: baseConfig.sha256, engine_runtime_sha256: h,
    model_dataset_id: 'model_fixture', model_dataset_manifest_sha256: h, model_dataset_descriptor_sha256: h,
    source_dataset_id: 'raw_fixture', ground_truth_id: 'gt_fixture', evaluation_id: 'baseline_fixture',
    evaluation_manifest_sha256: h, engineering_readiness: { status: 'READY', reasons: [] },
    metric_readiness: { status: 'PROVISIONAL_PROXY', reasons: [] }, result_usage: 'EXPLORATORY_ONLY',
    mapping_status: 'PROVISIONAL', interpretation_scope: 'ORDINAL', no_skill_reference_ordinal: 1,
    validation_disclosure_status: 'DEVELOPMENT_EXPOSED', validation_disclosure_evidence_id: null,
    validation_disclosure_evidence_sha256: null, validation_access_ledger_sha256: null,
    upstream_train_support: { sensitivity_id: 'sensitivity_fixture', gt_level_support: support.gt_level_support,
      gt_level_support_sha256: support.gt_level_support_sha256, limitation_codes: support.gt_level_support.limitation_codes,
      conclusion_limitations: support.gt_level_support.conclusion_limitations } };
  const input = { optimizationPolicyVersion: 4, upstream: { status: 'PASS', validation_scope: 'SOURCE_LINKED' },
    sourceFingerprints: {}, model: { manifest: { model_dataset_id: 'model_fixture', descriptor_sha256: h,
      source_dataset_id: 'raw_fixture', ground_truth_id: 'gt_fixture' }, manifestSha256: h,
      schemaVersion: 2, policyVersion: 4, rows: cohort, fingerprints: {} },
    evaluation: { evaluation_id: 'baseline_fixture', evaluation_manifest_sha256: h,
      evaluation_schema_version: 2, evaluation_policy_version: 2 },
    sensitivity: { linkage, registry, baseConfig, readiness: { metrics: { replay_usable_rate: 1 } }, fingerprints: {} },
    cohort, summary: { sample_count: cohort.length, event_count: cohort.length, date_count: 20 } };
  const source = { ...sourceIdentity(input), diagnostic_plan_id: 'diagnostic_plan_fixture',
    diagnostic_plan_manifest_sha256: h, test_fixture_only: true };
  const publicSpace = m.buildSearchSpace({ mode: 'EXPLORATORY_SEARCH', registry, baseConfig, linkage,
    readiness: input.sensitivity.readiness, policyVersion: 4 });
  const { registry_units, ...frozenSpace } = publicSpace;
  const inputId = `optimization_input_${m.digest(optimizationInputIdentity({ source,
    searchSpaceSha256: m.digest(frozenSpace), policy: m.optimizationPolicy(4) })).slice(0, 16)}`;
  const search = await m.searchCohort({ cohort, searchSpace: { ...publicSpace, base_config: baseConfig }, runReplay: runner, scopeId: inputId });
  const evidence = { diagnostic_plan_id: source.diagnostic_plan_id, diagnostic_plan_manifest_sha256: h,
    diagnostic_id: 'diagnostic_fixture', diagnostic_manifest_sha256: h,
    procedure_status: 'PROCEDURE_SUPPORTED', result_usage: 'DEVELOPMENT_ONLY' };
  const built = await buildOptimizationPackage({ input, runReplay: runner, optimizationPolicyVersion: 4,
    testFixture: TEST_FIXTURE, developmentFixture: { finalSearch: search, source: {
      diagnostic_plan_id: source.diagnostic_plan_id, diagnostic_plan_manifest_sha256: h }, evidence } });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'optimization-v4-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(built.files)) {
    await fs.mkdir(path.dirname(path.join(temp, name)), { recursive: true }); await fs.writeFile(path.join(temp, name), value);
  }
  assert.equal(built.manifest.result_usage, 'DEVELOPMENT_ONLY'); assert.equal(built.manifest.optimization_schema_version, 2);
  assert.equal(built.manifest.candidate_freeze_allowed, false); assert.equal(built.files['candidate_freeze.json'], undefined);
  assert.ok(built.finalists.length > 0); assert.ok(built.finalists.every(r => r.train_all_guards_pass));
  assert.equal((await inspectOptimization(temp, { staging: true })).status, 'PASS');
  await assert.rejects(() => inspectOptimization(temp, { staging: true, model: temp, raw: temp, gt: temp, baseline: temp, sensitivity: temp }),
    e => e.reason_code === 'FIXTURE_SOURCE_LINK_FORBIDDEN');
  assert.equal(JSON.parse(built.files['finalists.json']).finalists[0].selection_status, 'TRAIN_QUALIFIED_DEVELOPMENT_CANDIDATE');
});

test('development Validation Policy 4 reuses metrics/bootstrap and cannot emit selected files', async t => {
  const { makeFormalFixture } = require('./validation-fixture.cjs');
  const m = await api();
  const [{ buildValidationResult }, { packageManifest, inspectValidation }, { planIdentity },
    { supportCohort, supportDocument }, { canonicalJson }, { validationSelectionRuleDocument }] = await Promise.all([
    import('../tools/validation/lib/build.mjs'), import('../tools/validation/lib/package.mjs'),
    import('../tools/validation/plan-validation.mjs'), import('../tools/gt-level-support.mjs'),
    import('../tools/dataset/lib/common.mjs'), import('../tools/optimization/lib/finalist.mjs')]);
  const f = await makeFormalFixture();
  const core = { ...f.plan.plan_core, validation_schema_version: 2, validation_policy_version: 4,
    mode: 'DEVELOPMENT_VALIDATION', status: 'READY_DEVELOPMENT', result_usage: 'DEVELOPMENT_ONLY',
    diagnostic_id: 'diagnostic_fixture', diagnostic_plan_id: 'diagnostic_plan_fixture',
    validation_disclosure_status: 'DEVELOPMENT_EXPOSED', policy: m.validationPolicy(4) };
  core.source = { ...core.source, sensitivity: { id: 'sensitivity_fixture' } };
  core.validation_members_sha256 = m.digest(core.validation_members);
  delete core.fixture_only;
  const rows = f.input.cohort, support = supportDocument(rows, 'TRAIN');
  core.support = m.validationSupport(rows, 4); core.gt_level_support = core.support.gt_level_support;
  core.gt_level_support_sha256 = core.support.gt_level_support_sha256; core.gt_level_support_cohort = supportCohort(rows);
  core.upstream_train_support = { sensitivity_id: core.source.sensitivity.id, gt_level_support: support.gt_level_support,
    gt_level_support_sha256: support.gt_level_support_sha256, limitation_codes: support.gt_level_support.limitation_codes,
    conclusion_limitations: support.gt_level_support.conclusion_limitations };
  core.source_validation_selection_rule = validationSelectionRuleDocument(m.optimizationPolicy(4));
  core.effective_selection_policy = m.effectiveSelectionPolicy(core.source_validation_selection_rule, 4);
  core.source_validation_selection_rule_sha256 = m.digest(core.source_validation_selection_rule);
  core.effective_selection_policy_sha256 = m.digest(core.effective_selection_policy);
  const identity = planIdentity(core), plan = { ...identity.payload, plan_id: identity.planId };
  const built = await buildValidationResult({ plan, input: f.input, runReplay: f.runReplay });
  assert.equal(JSON.parse(built.files['selection_result.json']).outcome, 'DEVELOPMENT_ONLY');
  assert.equal(built.files['selected_candidate.json'], undefined);
  const manifest = packageManifest(built.files, identity.planId);
  assert.equal(manifest.validation_schema_version, 2); assert.equal(manifest.formal_promotion_allowed, false);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'validation-v4-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({ ...built.files, 'manifest.json': canonicalJson(manifest) })) {
    await fs.mkdir(path.dirname(path.join(temp, name)), { recursive: true }); await fs.writeFile(path.join(temp, name), value);
  }
  assert.equal((await inspectValidation(temp, { staging: true })).status, 'PASS');
});
