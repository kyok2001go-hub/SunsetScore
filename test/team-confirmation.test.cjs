const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSyntheticPipeline } = require('./evaluation-fixture.cjs');

test('prior team confirmation qualifies exact source labels without inventing blind review or clearing exposure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-team-confirmation-'));
  t.after(async () => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'sunset-team-confirmation-'))); await fs.rm(root, { recursive: true, force: true }); });
  const pipeline = await createSyntheticPipeline(root);
  t.after(pipeline.close);
  const { canonicalJson, hash } = await import('../tools/dataset/lib/common.mjs');
  const { TEST_FIXTURE, snapshot } = await import('../tools/formal/contracts.mjs');
  const { teamConfirmationPayloads } = await import('../tools/metric-semantics/team-confirmation.mjs');
  const { publishMetric, inspectMetricPackage, semanticPreparationMembers } = await import('../tools/metric-semantics/semantics.mjs');
  const { metricOperation, parseMetricArgs } = await import('../tools/metric-semantics/metric.mjs');
  const json = async (dir, file) => JSON.parse(await fs.readFile(path.join(dir, file)));
  const sources = { raw_manifest: await json(pipeline.rawDir, 'manifest.json'), gt_manifest: await json(pipeline.gtDir, 'manifest.json'),
    events_csv: await fs.readFile(path.join(pipeline.rawDir, 'raw/events.csv'), 'utf8'),
    observations_csv: await fs.readFile(path.join(pipeline.rawDir, 'raw/sunset_observations.csv'), 'utf8'),
    event_ground_truth_csv: await fs.readFile(path.join(pipeline.gtDir, 'event_ground_truth.csv'), 'utf8') };
  const declaration = { team_confirmation_version: 1, authority: 'PROJECT_OWNER_AND_TEAM', recorded_at_utc: '2026-10-13T00:00:00Z',
    statement: 'TEST_FIXTURE_ONLY synthetic prior team statement, not actual human qualification.',
    all_entered_observations_team_confirmed: true, task: 'SUNSET_AESTHETIC_FIVE_LEVEL', fixed_mapping_retained: true,
    source_ids: { raw: { id: sources.raw_manifest.dataset_id, manifest_sha256: hash(canonicalJson(sources.raw_manifest)) },
      gt: { id: sources.gt_manifest.ground_truth_id, manifest_sha256: hash(canonicalJson(sources.gt_manifest)) } } };
  const bodies = teamConfirmationPayloads(declaration, sources, { testFixture: TEST_FIXTURE });
  assert.equal(bodies['summary.json'].metric_readiness, 'READY');
  assert.equal(bodies['summary.json'].result_usage, 'TEST_FIXTURE_ONLY');
  assert.ok(bodies['summary.json'].limitations.includes('INDEPENDENT_BLIND_AGREEMENT_NOT_MEASURED'));
  assert.equal(bodies['summary.json'].sample_count, 41);
  assert.ok(!('agreement_rate' in bodies['summary.json']));
  assert.ok(!('second_annotations.json' in bodies));
  const packetResult = await publishMetric('semantic_evidence', bodies, { output: path.join(root, 'metric_semantics'), accessLedger: path.join(root, 'validation/access-ledger') });
  const packet = await inspectMetricPackage(packetResult.directory);
  assert.deepEqual(semanticPreparationMembers(packet), []);
  await assert.rejects(metricOperation({ command: 'validate', path: packetResult.directory }), e => e.reason_code === 'TEST_FIXTURE_CLI_FORBIDDEN');
  assert.equal(parseMetricArgs(['confirm', '--raw', pipeline.rawDir, '--gt', pipeline.gtDir, '--declaration', 'declaration.json']).command, 'confirm');
  assert.throws(() => parseMetricArgs(['confirm', '--skip-history', 'true']));
  assert.throws(() => teamConfirmationPayloads({ ...declaration, all_entered_observations_team_confirmed: false }, sources));
  const changed = structuredClone(sources); changed.event_ground_truth_csv += '\r\n';
  assert.throws(() => teamConfirmationPayloads(declaration, changed), e => e.reason_code === 'TEAM_SOURCE_FILE_MISMATCH');
  const wrong = structuredClone(declaration); wrong.source_ids.gt.manifest_sha256 = '0'.repeat(64);
  assert.throws(() => teamConfirmationPayloads(wrong, sources), e => e.reason_code === 'TEAM_DECLARATION_SOURCE_MISMATCH');
  const { CAMPAIGN_POLICY, campaignSummary, historySnapshots } = await import('../tools/campaign/campaign.mjs');
  const { readCsv } = await import('../tools/dataset/lib/csv.mjs');
  const { modelSchema } = await import('../tools/model-dataset/model-dataset-schema.mjs');
  const modelManifest = await json(pipeline.modelDir, 'manifest.json');
  const eventRows = readCsv(modelSchema(modelManifest.model_dataset_schema_version).tables.event_splits, await fs.readFile(path.join(pipeline.modelDir, 'event_splits.csv'))).filter(x => x.eligibility === 'PRIMARY');
  const confirmed = new Map(bodies['summary.json'].confirmed_members.map(x => [x.event_id, x]));
  const cohort = eventRows.map(x => ({ ...confirmed.get(x.event_id), split: x.split }));
  const scope = bodies['mapping_contract.json'].scope;
  const spec = { campaign_specification_version: 1, name: 'TEST_FIXTURE_ONLY', frozen_at_utc: '2026-10-13T00:00:00Z', ...scope,
    gt_review: { reviewer_id: 'fixture', annotation_procedure: 'Fixture', dispute_rule: 'Fixture', audit_rule: 'Fixture' },
    ...Object.fromEntries(['split_strategy','percentages','search_space_id','search_algorithm','selection_policy_version'].map(key => [key, CAMPAIGN_POLICY[key]])),
    stopping_rule: 'Fixture budget', history_declaration: { reviewer_id: 'fixture', reviewed_at_utc: '2026-10-13T00:00:00Z',
      all_known_ledgers_declared: true, validation_not_used_for_search_or_rubric: true, test_not_used_for_search_or_rubric: true, remarks: 'Fixture' } };
  const descriptor = { experiment_runtime_protocol_version: 2, formal_contract_revision: 1, result_usage: 'FORMAL_EXECUTION_CAPABLE',
    engine_runtime_sha256: '1'.repeat(64), parameter_registry_sha256: '2'.repeat(64) };
  const digest = hash(canonicalJson(descriptor));
  const manifest = { descriptor, experiment_runtime_protocol_version: 2, descriptor_sha256: digest, runtime_bundle_id: `experiment_runtime_v2_${digest.slice(0, 16)}` };
  const runtimes = { execution: manifest, builds: [{ engine_build_sha: 'a'.repeat(40), manifest }] };
  const linked = { ...Object.fromEntries([['raw',sources.raw_manifest],['gt',sources.gt_manifest],['model',modelManifest]].map(([key, value]) => [key, { manifest: value, manifest_sha256: hash(canonicalJson(value)) }])),
    observed_source_kinds: scope.source_kinds, history_registry_sha256: null, observed_engine_build_shas: ['a'.repeat(40)] };
  const ledgerOptions = { model: pipeline.modelDir, accessLedger: path.join(root, 'validation/access-ledger') };
  let history = (await historySnapshots(ledgerOptions)).history;
  const summary = campaignSummary(spec, snapshot(packet), runtimes, linked, history, cohort, 'TEST_FIXTURE_ONLY');
  assert.equal(summary.status, 'READY_CAMPAIGN', JSON.stringify(summary));
  assert.deepEqual(summary.semantic_train_overlap, []);
  const { recordLedger } = await import('../tools/validation/lib/disclosure.mjs');
  await recordLedger(ledgerOptions.accessLedger, { action: 'MANUAL_EFFECT_ACCESS', members: summary.split_members.VALIDATION });
  history = (await historySnapshots(ledgerOptions)).history;
  assert.ok(campaignSummary(spec, snapshot(packet), runtimes, linked, history, cohort, 'TEST_FIXTURE_ONLY').blocking_reasons.includes('HOLDOUT_PREVIOUSLY_EXPOSED'));
  const mismatched = structuredClone(linked); mismatched.raw.manifest_sha256 = '0'.repeat(64);
  assert.throws(() => campaignSummary(spec, snapshot(packet), runtimes, mismatched, history, cohort, 'TEST_FIXTURE_ONLY'));
  const { dependenciesOf, phaseByKey } = await import('../tools/maintenance/maintenance-policy.mjs');
  assert.deepEqual(dependenciesOf(phaseByKey('semantic_evidence'), packet.manifest).map(x => x.id).sort(), [declaration.source_ids.raw.id, declaration.source_ids.gt.id].sort());
});
