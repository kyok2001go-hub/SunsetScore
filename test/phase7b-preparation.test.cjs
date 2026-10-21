const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { modules, metricFixture, annotations } = require('./helpers/phase7b.cjs');
const { createSyntheticPipeline } = require('./evaluation-fixture.cjs');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-phase7b-'));
  t.after(async () => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'sunset-phase7b-'))); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
test('fixed mapping keeps integer boundaries and rejects decimals; old policies remain exploratory', async () => {
  const { scoreToOrdinal } = await import('../tools/evaluation/metrics.mjs');
  assert.deepEqual([0,19,20,39,40,59,60,89,90,100].map(scoreToOrdinal), [0,0,1,1,2,2,3,3,4,4]);
  for (const value of [19.5, NaN, -1, 101, '20']) assert.throws(() => scoreToOrdinal(value));
  const { tuningContract } = await import('../tools/tuning/v2/contract.mjs');
  assert.equal(tuningContract(3).policy.formal_capable, false); assert.equal(tuningContract(4).policy.tuning_schema_version, 3);
  const { validationPolicy } = await import('../tools/validation/validation-policy.mjs');
  assert.equal(validationPolicy(2).formal_capable, false); assert.equal(validationPolicy(3).formal_capable, true);
  assert.equal(validationPolicy(4).formal_capable, false);
  assert.deepEqual(validationPolicy(4).modes, ['DEVELOPMENT_VALIDATION']);
  assert.throws(() => validationPolicy(6));
});
test('single-reviewer preparation cannot become READY; frozen review emits a safe blind template', async t => {
  const f = await metricFixture(await temporary(t));
  const pilot = await f.inspectMetricPackage(f.pilot.directory);
  assert.equal(pilot.files['summary.json'].metric_readiness, 'WAITING_INDEPENDENT_REVIEW');
  assert.equal(f.plan.files['summary.json'].metric_readiness, 'WAITING_INDEPENDENT_REVIEW');
  const blind = f.plan.files['blind_template.json'];
  for (const row of blind.annotations) assert.deepEqual(Object.keys(row).sort(), ['rating','reason','sample_key']);
  assert.ok(blind.annotations.every(x => x.rating === null));
  assert.ok(f.plan.files['blind_evidence.json'].samples.every(x => !('event_id' in x) && !('rating' in x)));
  const checked = await f.inspectMetricPackage(f.semantic.directory);
  assert.equal(checked.files['summary.json'].status, 'REVIEWED_PASS');
  assert.equal(checked.files['summary.json'].result_usage, 'TEST_FIXTURE_ONLY');
  assert.ok(checked.files['summary.json'].limitations.includes('EXCELLENT_PERFORMANCE_NOT_ESTABLISHED'));
});
test('independent reviewer, chronology, scope, disputed cases and frozen rules are enforced', async t => {
  const f = await metricFixture(await temporary(t));
  const same = structuredClone(f.second); same.reviewer.reviewer_id = f.first.reviewer.reviewer_id;
  assert.throws(() => f.reviewPayloads(f.plan, same, f.conclusion, f.test), e => e.reason_code === 'INDEPENDENT_SECOND_HUMAN_REQUIRED');
  const ai = structuredClone(f.second); ai.reviewer.kind = 'AI_ASSISTANT';
  assert.throws(() => f.reviewPayloads(f.plan, ai, f.conclusion, f.test));
  const early = structuredClone(f.second); early.submitted_at_utc = '2025-01-04T00:00:00Z';
  assert.throws(() => f.reviewPayloads(f.plan, early, f.conclusion, f.test), e => e.reason_code === 'SECOND_REVIEW_BEFORE_PLAN');
  const changed = structuredClone(f.second); changed.annotations[0].rating = 'excellent';
  assert.throws(() => f.reviewPayloads(f.plan, changed, f.conclusion, f.test), e => e.reason_code === 'ADJUDICATION_COVERAGE_INCOMPLETE');
  const conclusion = structuredClone(f.conclusion);
  conclusion.adjudications = [{ sample_key: changed.annotations[0].sample_key, final_rating: 'excellent', reason: 'Fixture dispute', major_ambiguity_resolved: false }];
  assert.equal(f.reviewPayloads(f.plan, changed, conclusion, f.test)['summary.json'].status, 'REVIEWED_FAIL');
  const missing = structuredClone(f.specification); delete missing.acceptance_rules.rationale;
  assert.throws(() => f.reviewPlanPayloads({ rubric: f.rubricPacket, pilot: f.pilotPacket, imported: f.reviewInput, firstAnnotations: f.first, specification: missing }, f.test));
});
test('pilot/review Event and content overlap, missing rows and unassessable coercion are rejected', async t => {
  const f = await metricFixture(await temporary(t));
  assert.throws(() => f.reviewPlanPayloads({ rubric: f.rubricPacket, pilot: f.pilotPacket, imported: f.pilotInput,
    firstAnnotations: annotations(f.pilotInput, 'fixture_first_human', '2025-01-04T00:00:00Z'), specification: f.specification }, f.test),
    e => e.reason_code === 'PILOT_REVIEW_OVERLAP');
  const missing = structuredClone(f.first); missing.annotations.pop();
  assert.throws(() => f.pilotPayloads(f.rubricPacket, f.reviewInput, missing, f.test), e => e.reason_code === 'ANNOTATION_COVERAGE_INCOMPLETE');
  const outside = structuredClone(f.reviewInput); outside.index.samples[0].observed_at_utc = '2025-01-03T11:00:00Z';
  assert.throws(() => f.pilotPayloads(f.rubricPacket, outside, f.first, f.test), e => e.reason_code === 'OBSERVATION_OUTSIDE_WINDOW');
  const labels = structuredClone(f.first); labels.annotations[0].rating = 'UNASSESSABLE';
  const result = f.pilotPayloads(f.rubricPacket, outside, labels, f.test);
  assert.equal(result['summary.json'].by_level.UNASSESSABLE, 1);
});
test('canonical package revalidation detects semantic tampering and source identity conflicts', async t => {
  const f = await metricFixture(await temporary(t));
  const packet = await f.inspectMetricPackage(f.semantic.directory);
  const altered = structuredClone(packet); altered.files['summary.json'].status = 'REVIEWED_PASS_BYPASS';
  assert.throws(() => f.inspectMetricSnapshot(altered));
  const { historyOverlap } = await import('../tools/campaign/campaign.mjs');
  const member = { event_id: 'new_id', location_key: 'same_location', event_date_local: '2025-01-01' };
  const history = [{ key: 'primary', rows: [{ action: 'FIRST_ACCESS_RESERVED', plan_id: 'plan_a',
    entry_sha256: 'a'.repeat(64), members: [{ ...member, event_id: 'old_id' }] }] }];
  assert.equal(historyOverlap(history, [member]).length, 1);
  assert.equal(historyOverlap(history, [member], { allowPlanId: 'plan_a' }).length, 0);
});

test('CLI cannot authorize fixtures or accept a numeric future-version shortcut', async t => {
  const f = await metricFixture(await temporary(t));
  const { metricOperation, parseMetricArgs } = await import('../tools/metric-semantics/metric.mjs');
  await assert.rejects(metricOperation({ command: 'validate', path: f.semantic.directory }), e => e.reason_code === 'TEST_FIXTURE_CLI_FORBIDDEN');
  assert.throws(() => parseMetricArgs(['review', '--test-fixture', 'true']));
  const { assertExecutableUsage, utc, day } = await modules();
  assert.throws(() => assertExecutableUsage('TEST_FIXTURE_ONLY', {}));
  assert.throws(() => utc('2026-02-30T00:00:00Z'));
  assert.throws(() => day('2026-02-30'));
  const { optimizationPolicy } = await import('../tools/optimization/optimization-policy.mjs');
  const { tuningContract } = await import('../tools/tuning/v2/contract.mjs');
  assert.equal(optimizationPolicy(4).formal_capable, false);
  assert.deepEqual(optimizationPolicy(4).modes, ['EXPLORATORY_SEARCH']);
  assert.throws(() => optimizationPolicy(6)); assert.throws(() => tuningContract(5));
});

test('formal concentration uses canonical locations while historical profiles keep display-city behavior', async () => {
  const { cohortProfile } = await import('../tools/optimization/lib/readiness.mjs');
  const { cohortProfiles } = await import('../tools/tuning/lib/metrics.mjs');
  const rows = Array.from({ length: 8 }, (_, i) => ({ event_id: `e${i}`, city: 'same display name', location_key: `location_${i % 4}`,
    event_date_local: `2026-01-0${Math.floor(i / 4) + 1}`, gt_ordinal: i % 3 }));
  for (const profile of [cohortProfile, cohortProfiles]) {
    assert.equal(profile(rows).max_city_event_share, 1);
    assert.equal(profile(rows, { canonicalLocations: true }).max_city_event_share, .25);
  }
});

test('new packages retain their declared source edges and exact supported schema-policy pairs', async () => {
  const { dependenciesOf, phaseByKey, isSupportedVersion } = await import('../tools/maintenance/maintenance-policy.mjs');
  const edges = dependenciesOf(phaseByKey('campaign'), { semantic_evidence_id: 'semantic', semantic_evidence_manifest_sha256: 'a'.repeat(64),
    runtime_bundle_id: 'runtime', runtime_bundle_manifest_sha256: 'b'.repeat(64), source_ids: { model: { id: 'model', manifest_sha256: 'c'.repeat(64) } },
    build_runtime_sources: [{ id: 'build_runtime', manifest_sha256: 'd'.repeat(64) }] });
  assert.deepEqual(edges.map(x => x.id).sort(), ['build_runtime','model','runtime','semantic']);
  assert.ok(isSupportedVersion(phaseByKey('sensitivity'), 3, 4));
  assert.ok(!isSupportedVersion(phaseByKey('sensitivity'), 3, 3));
  assert.ok(isSupportedVersion(phaseByKey('validation'), 2, 3));
});

test('actual semantic disk packages have a complete acyclic maintenance graph', async t => {
  const root = await temporary(t);
  await metricFixture(root);
  const { scanDataset } = await import('../tools/maintenance/lib/scan.mjs');
  const graph = await scanDataset({ datasetRoot: root });
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.edges.length, 4);
  assert.deepEqual(graph.diagnostics, []);
  assert.ok(graph.edges.every(edge => edge.parent_id !== edge.child_id));
});

test('frozen CLI forwards host output, input declarations and audit ledger for every new formal entry', async () => {
  const { bundleArgs } = await import('../tools/experiment-runtime/lib/execute.mjs');
  for (const [family, command] of [['metric-semantics','rubric'],['tuning','readiness'],['tuning','plan'],['optimization','plan'],['campaign','disclosure']]) {
    const args = bundleArgs([...(family === 'metric-semantics' || family === 'campaign' ? [command] : []), '--runtime-bundle','bundle',
      ...(family === 'tuning' || family === 'optimization' ? ['--campaign','campaign'] : [])], command, family);
    assert.ok(path.isAbsolute(args[args.indexOf('--output') + 1]));
    assert.ok(path.isAbsolute(args[args.indexOf('--access-ledger') + 1]));
    assert.ok(!args.includes('--runtime-bundle'));
  }
  const args = bundleArgs(['disclosure','--runtime-bundle','bundle','--declaration','declaration.json'], 'disclosure', 'campaign');
  assert.equal(args[args.indexOf('--declaration') + 1], path.resolve('declaration.json'));
  const validated = bundleArgs(['validate','artifact','--runtime-bundle','bundle'], 'validate', 'metric-semantics');
  assert.equal(validated[1], path.resolve('artifact'));
});

test('legacy Evaluation V1 records VAL exposure in the immutable Model source root even with a different output root', async t => {
  const root = await temporary(t), pipeline = await createSyntheticPipeline(root);
  t.after(pipeline.close);
  const { evaluateBaseline } = await import('../tools/evaluation/evaluate-baseline.mjs');
  const { historySnapshots, historyOverlap } = await import('../tools/campaign/campaign.mjs');
  await evaluateBaseline(pipeline.modelDir, pipeline.rawDir, pipeline.gtDir, { evaluationVersion: 1, output: path.join(root, 'other_root/evaluation') });
  const current = await historySnapshots({ model: pipeline.modelDir, accessLedger: path.join(root, 'fresh_root/validation/access-ledger') });
  const source = current.history.find(x => x.key === 'model_root');
  assert.ok(source.rows.some(x => x.stage === 'EVALUATION_V1' && x.members.length === 8));
  assert.ok(historyOverlap(current.history, source.rows[0].members).length > 0);
});
