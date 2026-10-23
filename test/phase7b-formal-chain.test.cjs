const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSyntheticPipeline } = require('./evaluation-fixture.cjs');
const { metricFixture } = require('./helpers/phase7b.cjs');

test('registered formal constructors publish an immutable disk chain; fixture evidence never authorizes production', { timeout: 1800000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-phase7b-chain-'));
  t.after(async () => { assert.ok(temp.startsWith(path.join(os.tmpdir(), 'sunset-phase7b-chain-'))); await fs.rm(temp, { recursive: true, force: true }); });
  const { freezeRuntime } = await import('../tools/experiment-runtime/lib/bundle.mjs');
  // The formal mapping contract (revision 1) grades with 20/40/60/90 and the chain refuses other grade lines.
  // From V2.5.5.2 production uses other lines, so the chain is exercised on a copy of this runtime restored to the
  // V2.5.5.1 scoring configuration (grade lines, golden-window open thresholds, uncentred factor) whose fixture
  // outcomes this test pins.
  const legacySource = path.join(temp, 'legacy_grade_source'), app = path.resolve(__dirname, '..');
  for (const name of ['package.json', 'package-lock.json', 'index.html', 'admin/backfill.html', 'js', 'tools', 'server']) {
    await fs.cp(path.join(app, name), path.join(legacySource, name), { recursive: true });
  }
  const configFile = path.join(legacySource, 'js/config.js');
  let legacyConfig = await fs.readFile(configFile, 'utf8');
  for (const [label, min] of [['极佳', 90], ['很好', 60], ['一般', 40], ['较差', 20], ['很差', 0]]) {
    const pattern = new RegExp("\\{ min: \\d+, label: '" + label + "' \\}");
    assert.match(legacyConfig, pattern);
    legacyConfig = legacyConfig.replace(pattern, "{ min: " + min + ", label: '" + label + "' }");
  }
  assert.match(legacyConfig, /app: '[\d.]+',(\s*)model: '[\d.]+'/);
  legacyConfig = legacyConfig.replace(/app: '[\d.]+',(\s*)model: '[\d.]+'/, "app: '2.5.5.1',$1model: '2.5.5.1'");
  for (const [pattern, value] of [[/openCoverageThreshold: \d+,/, 'openCoverageThreshold: 20,'],
    [/satelliteOpenThreshold: \d+ /, 'satelliteOpenThreshold: 25 '], [/reference: [\d.]+/, 'reference: 1']]) {
    assert.match(legacyConfig, pattern);
    legacyConfig = legacyConfig.replace(pattern, value);
  }
  await fs.writeFile(configFile, legacyConfig);
  const frozen = await freezeRuntime({ sourceRoot: legacySource, output: path.join(temp, 'experiment_runtime'), protocolVersion: 2 });
  const root = path.join(frozen.directory, 'source');
  const { executeBundleCli, bundleArgs } = await import('../tools/experiment-runtime/lib/execute.mjs');
  const metricEntry = path.resolve(__dirname, '../tools/metric-semantics/metric.mjs');
  const draftArgs = ['rubric', '--runtime-bundle', frozen.directory, '--specification', path.resolve(__dirname, '../tools/metric-semantics/templates/rubric.specification.json'),
    '--output', path.join(temp, 'cli_metric_semantics'), '--access-ledger', path.join(temp, 'validation/access-ledger')];
  const cliDraft = await executeBundleCli(frozen.directory, metricEntry, bundleArgs(draftArgs, 'rubric', 'metric-semantics'));
  assert.equal(cliDraft.result_usage, 'PREPARATION_ONLY');
  assert.ok(cliDraft.execution_receipt_id);
  const cliVerified = await executeBundleCli(frozen.directory, metricEntry, ['validate', cliDraft.directory]);
  assert.equal(cliVerified.validation_scope, 'PACKAGE_INTERNAL');
  const { runReplay } = await import('../tools/replay/replay-runner.mjs');
  const date = d => new Date(Date.UTC(2026, 6, 1 + d)).toISOString().slice(0, 10);
  const locations = Array.from({ length: 4 }, (_, i) => `qweather:${101000000 + i}`);
  const fixture = await metricFixture(temp, { applicationScope: { locations, date_from: '2025-01-01', date_to: '2027-12-31',
    source_kinds: ['rednote_manual', 'user'], limitations: ['TEST_FIXTURE_ONLY'] } });
  t.diagnostic('Runtime v2 and independently reviewed synthetic semantic package constructed');
  const pipeline = await createSyntheticPipeline(temp, { counts: Array(56).fill(4), date, locationCount: 4, modelPolicyVersion: 4,
    cutoff: '2026-09-01T00:00:00.000Z', ratingOverride: i => ['poor','fair','good','good'][i % 4],
    replayTransform: async (replay, i) => {
      const day = replay.identity.prediction_time_utc.slice(0, 10);
      replay.identity.prediction_time_utc = `${day}T09:30:00.000Z`;
      const node = replay.nwp.nodes[0], [cloud, low] = [[20,80],[85,0],[20,30],[0,0]][i % 4];
      node.time_utc = [`${day}T09:00:00.000Z`, `${day}T11:00:00.000Z`];
      for (const [key, value] of Object.entries({ cloud_cover: cloud, cloud_cover_high: cloud, cloud_cover_mid: 0, cloud_cover_low: low })) node.variables[key] = [value,value];
      return replay;
    }, actualPrediction: async replay => (await runReplay(replay, { engineRoot: root })).actual });
  t.after(pipeline.close);
  t.diagnostic('Raw, Ground Truth and Model constructed from SQLite and captured Replay bytes');
  const { CAMPAIGN_POLICY, CAMPAIGN_POLICY_V2, campaignPreflight, freezeCampaign, inspectCampaign } = await import('../tools/campaign/campaign.mjs');
  const options = { ...fixture.test, root, raw: pipeline.rawDir, gt: pipeline.gtDir, model: pipeline.modelDir,
    metricEvidence: fixture.semantic.directory, runtimeBundle: frozen.directory, accessLedger: fixture.accessLedger,
    buildRuntimes: [{ engine_build_sha: 'a'.repeat(40), directory: frozen.directory }],
    specification: { campaign_specification_version: 2, name: 'TEST_FIXTURE_ONLY constructor campaign', frozen_at_utc: '2026-09-01T00:00:00Z',
      locations, date_from: date(0), date_to: date(55), source_kinds: ['rednote_manual','user'],
      gt_review: { reviewer_id: 'fixture_human', annotation_procedure: 'Synthetic fixture', dispute_rule: 'Synthetic fixture', audit_rule: 'Synthetic fixture' },
      ...Object.fromEntries(['split_strategy','percentages','search_space_id','search_algorithm','selection_policy_version'].map(key => [key, CAMPAIGN_POLICY_V2[key]])),
      stopping_rule: 'Frozen 500 candidate budget; no TEST effect access.',
      history_declaration: { reviewer_id: 'fixture_human', reviewed_at_utc: '2026-09-01T00:00:00Z', all_known_ledgers_declared: true,
        validation_not_used_for_search_or_rubric: true, test_not_used_for_search_or_rubric: true, remarks: 'Synthetic fixture only.' } } };
  const planned = await campaignPreflight(options);
  assert.equal(planned.status, 'READY_CAMPAIGN', JSON.stringify(planned.blocking_reasons));
  const realAttempt = await campaignPreflight({ ...options, testFixture: undefined });
  assert.equal(realAttempt.status, 'BLOCKED');
  assert.ok(realAttempt.blocking_reasons.includes('SEMANTIC_FIXTURE_NOT_FORMAL'));
  const campaign = await freezeCampaign({ ...options, output: path.join(temp, 'campaign') });
  options.campaign = campaign.directory;
  assert.equal((await inspectCampaign(campaign.directory)).files['summary.json'].result_usage, 'TEST_FIXTURE_ONLY');
  assert.equal((await inspectCampaign(campaign.directory)).files['policy.json'].campaign_policy_version, 2);
  const { buildModelDataset } = await import('../tools/model-dataset/build-model-dataset.mjs');
  const oldModel = await buildModelDataset(options.raw, options.gt, { output: path.join(temp, 'model'), modelPolicyVersion: 3 });
  await assert.rejects(campaignPreflight({ ...options, model: oldModel.directory }), error => error.reason_code === 'CAMPAIGN_MODEL_POLICY_MISMATCH');
  const oldSpecification = { ...options.specification, campaign_specification_version: 1, percentages: CAMPAIGN_POLICY.percentages };
  await assert.rejects(campaignPreflight({ ...options, specification: oldSpecification }), error => error.reason_code === 'MODEL_SPLIT_RATIO_MISMATCH');
  const oldCampaign = await freezeCampaign({ ...options, specification: oldSpecification, model: oldModel.directory,
    output: path.join(temp, 'campaign') });
  const oldCampaignBytes = await fs.readFile(path.join(oldCampaign.directory, 'manifest.json'));
  assert.equal((await inspectCampaign(oldCampaign.directory)).files['policy.json'].campaign_policy_version, 1);
  assert.deepEqual(await fs.readFile(path.join(oldCampaign.directory, 'manifest.json')), oldCampaignBytes);
  const { evaluateBaseline } = await import('../tools/evaluation/evaluate-baseline.mjs');
  const { inspectEvaluation } = await import('../tools/evaluation/validate-evaluation.mjs');
  const baseline = await evaluateBaseline(options.model, options.raw, options.gt, { ...options, evaluationVersion: 3, output: path.join(temp, 'evaluation') });
  options.baseline = baseline.directory;
  assert.equal((await inspectEvaluation(baseline.directory, { ...options })).status, 'PASS');
  const { runSensitivity } = await import('../tools/tuning/run-sensitivity.mjs');
  const sensitivity = await runSensitivity({ ...options, tuningVersion: 4, output: path.join(temp, 'tuning') });
  options.sensitivity = sensitivity.directory;
  assert.equal(sensitivity.result_usage, 'TEST_FIXTURE_ONLY');
  t.diagnostic('Evaluation 3/3 and Sensitivity 3/4 constructed and source linked');
  const { runOptimization } = await import('../tools/optimization/run-optimization.mjs');
  const optimization = await runOptimization({ ...options, optimizationPolicyVersion: 3, output: path.join(temp, 'optimization') });
  options.optimization = optimization.directory;
  assert.equal(optimization.result_usage, 'TEST_FIXTURE_ONLY');
  const opt = JSON.parse(await fs.readFile(path.join(optimization.directory, 'manifest.json')));
  assert.equal(opt.optimization_mode, 'FORMAL_OPTIMIZATION');
  assert.equal(opt.candidate_freeze_allowed, true);
  t.diagnostic('Optimization 2/3 constructed a real Candidate Freeze');
  const { createFormalDisclosure } = await import('../tools/validation/lib/formal-evidence.mjs');
  const evidence = await createFormalDisclosure({ ...options, output: path.join(temp, 'validation'), declaration: {
    reviewer_id: 'fixture_human', reviewed_at_utc: '2026-09-02T00:00:00Z', validation_unexposed: true,
    test_unexposed: true, all_known_access_declared: true, remarks: 'Synthetic fixture only.' } });
  options.disclosureEvidence = evidence.directory;
  const { scanDataset } = await import('../tools/maintenance/lib/scan.mjs');
  const disclosureGraph = await scanDataset({ datasetRoot: temp });
  assert.ok(!disclosureGraph.diagnostics.some(x => x.code === 'VALIDATION_EXPOSURE_NOT_RECORDED' && x.node_id === evidence.evidence_id));
  const { planValidation } = await import('../tools/validation/plan-validation.mjs');
  const plan = await planValidation({ ...options, validationPolicyVersion: 3, mode: 'formal', output: path.join(temp, 'validation') });
  assert.equal(plan.status, 'READY_FORMAL', JSON.stringify(plan));
  options.plan = plan.plan_dir;
  const { runValidation } = await import('../tools/validation/run-validation.mjs');
  const result = await runValidation({ ...options, output: path.join(temp, 'validation') });
  assert.equal(result.result_usage, 'TEST_FIXTURE_ONLY');
  const manifest = JSON.parse(await fs.readFile(path.join(result.directory, 'manifest.json')));
  assert.equal(manifest.formal_promotion_allowed, false);
  assert.equal(manifest.test_evaluated, false);
  assert.equal(manifest.validation_outcome, 'SELECTED');
  const { validateValidation } = await import('../tools/validation/validate-validation.mjs');
  const verified = await validateValidation({ ...options, path: result.directory, accessLedger: fixture.accessLedger });
  assert.equal(verified.status, 'PASS');
  assert.equal(verified.validation_scope, 'SOURCE_LINKED_RECOMPUTED');
  t.diagnostic('Validation 2/3 Plan, Run, publication recompute and independent full-source Verify passed');
  // Reuse the actual published constructor inputs for pure fixture outcome checks.
  // These calculations create no publication, exposure receipt or promotion permission.
  const { readValidationInput } = await import('../tools/validation/lib/source.mjs');
  const { readPlan } = await import('../tools/validation/lib/package.mjs');
  const { buildValidationResult } = await import('../tools/validation/lib/build.mjs');
  const planPacket = await readPlan(options.plan);
  const json = async (dir, file) => JSON.parse(await fs.readFile(path.join(dir, file)));
  const audited = { manifest: opt, finalists: await json(options.optimization, 'finalists.json'),
    searchSpace: await json(options.optimization, 'search_space.json'), formalContext: await json(options.optimization, 'formal_context.json'),
    sourceManifestHashes: { model: planPacket.plan_core.source.model.manifest_sha256 } };
  const input = await readValidationInput(options, audited, { root, mode: 'FORMAL_VALIDATION', validationPolicyVersion: 3, loadReplay: true });
  const noEligible = await buildValidationResult({ plan: planPacket, input, audited,
    runReplay: async (replay, runOptions) => runReplay(replay, { engineRoot: root, ...(runOptions.reference ? runOptions : {}) }) });
  assert.equal(JSON.parse(noEligible.files['selection_result.json']).outcome, 'NO_ELIGIBLE_CANDIDATE');
  assert.ok(!Object.hasOwn(noEligible.files, 'selected_candidate.json'));
  const firstDate = input.cohort.map(x => x.event_date_local).sort()[0];
  const inconclusive = await buildValidationResult({ plan: planPacket, input, audited,
    runReplay: async (replay, runOptions) => runReplay(replay, { engineRoot: root,
      ...(runOptions.reference || replay.context.sunset_time_utc.slice(0, 10) === firstDate ? runOptions : {}) }) });
  assert.equal(JSON.parse(inconclusive.files['selection_result.json']).outcome, 'INCONCLUSIVE');
  assert.ok(!Object.hasOwn(inconclusive.files, 'selected_candidate.json'));
  const { recordLedger } = await import('../tools/validation/lib/disclosure.mjs');
  const { historySnapshots, historyOverlap } = await import('../tools/campaign/campaign.mjs');
  const valMember = planPacket.plan_core.formal_context.campaign.files['summary.json'].split_members.VALIDATION[0];
  await recordLedger(fixture.accessLedger, { action: 'MANUAL_EFFECT_ACCESS', members: [{ ...valMember, event_id: 'renamed_fixture_event' }] });
  assert.ok(historyOverlap((await historySnapshots(options)).history, [valMember]).length > 0);
  await assert.rejects(createFormalDisclosure({ ...options, output: path.join(temp, 'new_validation'), declaration: {
    reviewer_id: 'fixture_human', reviewed_at_utc: '2026-09-03T00:00:00Z', validation_unexposed: true, test_unexposed: true,
    all_known_access_declared: true, remarks: 'Synthetic fixture only.' } }), e => e.reason_code === 'VALIDATION_PREVIOUSLY_EXPOSED');
  t.diagnostic('All three formal outcomes tested; changing output root or Event ID does not reset exposure');
});
