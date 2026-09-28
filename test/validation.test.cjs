const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeFormalFixture } = require('./validation-fixture.cjs');

const root = '../tools/validation/';
const load = name => import(root + name);

test('plan identity and bootstrap seed are deterministic', async () => {
  const { planIdentity } = await load('plan-validation.mjs');
  const { bootstrapIndices } = await load('lib/stability.mjs');
  const a = planIdentity({ mode: 'DEVELOPMENT_VALIDATION', candidates: ['a', 'b'] });
  const b = planIdentity({ mode: 'DEVELOPMENT_VALIDATION', candidates: ['a', 'b'] });
  assert.deepEqual(a, b);
  assert.notEqual(a.planId, planIdentity({ mode: 'DEVELOPMENT_VALIDATION', candidates: ['b', 'a'] }).planId);
  assert.deepEqual(bootstrapIndices(a.payload.bootstrap_seed, 3, 4),
    bootstrapIndices(a.payload.bootstrap_seed, 3, 4));
  assert.deepEqual(bootstrapIndices(0, 3, 3), [[0, 1, 1], [1, 1, 0], [2, 0, 2]]);
});

test('support counts unique events and blocks concentrated cohorts', async () => {
  const { validationSupport } = await load('validation-policy.mjs');
  const rows = Array.from({ length: 32 }, (_, index) => ({
    snapshot_id: `s${index}`, event_id: `e${index}`, location_key: 'one',
    event_date_local: `2026-09-${String(1 + index % 8).padStart(2, '0')}`,
    gt_ordinal: index % 4
  }));
  rows.push({ ...rows[0], snapshot_id: 'duplicate-event-snapshot' });
  const result = validationSupport(rows);
  assert.equal(result.event_count, 32);
  assert.equal(result.sample_count, 33);
  assert.ok(result.reasons.includes('CITY_CONCENTRATION_TOO_HIGH'));
});

test('formal planning blocks proxy upstream without touching VALIDATION', async () => {
  const { planValidation } = await load('plan-validation.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-formal-gate-'));
  try {
    await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify({
      optimization_mode: 'EXPLORATORY_SEARCH', candidate_freeze_allowed: false,
      validation_promotion_allowed: false, evaluation_policy_version: 2,
      tuning_policy_version: 2
    }));
    const result = await planValidation({ mode: 'formal', optimization: temp,
      disclosureEvidence: path.join(temp, 'missing-evidence.json') });
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.blocking_reasons.includes('CANDIDATE_FREEZE_MISSING'));
    assert.ok(result.blocking_reasons.includes('UPSTREAM_POLICY_3_MISSING'));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('date-block bootstrap A/A is exactly zero and B is deterministic', async () => {
  const { dateBlockBootstrap } = await load('lib/stability.mjs');
  const rows = Array.from({ length: 12 }, (_, index) => ({
    snapshot_id: `s${index}`, event_id: `e${index}`, event_date_local: `d${index % 4}`,
    gt_ordinal: index % 4, gt_confidence: 1, control_ordinal: (index + 1) % 4,
    experiment_ordinal: (index + 1) % 4
  }));
  const aa = dateBlockBootstrap(rows, 123);
  assert.equal(aa.point_delta_mae, 0);
  assert.equal(aa.ci_upper, 0);
  const ab = rows.map(row => ({ ...row, experiment_ordinal: row.gt_ordinal }));
  assert.deepEqual(dateBlockBootstrap(ab, 123), dateBlockBootstrap(ab, 123));
  assert.ok(dateBlockBootstrap(ab, 123).ci_upper < 0);
  const opposite = [
    { snapshot_id: 'a', event_id: 'a', event_date_local: 'A', gt_ordinal: 1,
      gt_confidence: 1, control_ordinal: 2, experiment_ordinal: 1 },
    { snapshot_id: 'b', event_id: 'b', event_date_local: 'B', gt_ordinal: 1,
      gt_confidence: 1, control_ordinal: 1, experiment_ordinal: 2 },
    { snapshot_id: 'c', event_id: 'c', event_date_local: 'C', gt_ordinal: 1,
      gt_confidence: 1, control_ordinal: 1, experiment_ordinal: 1 }
  ];
  assert.equal(dateBlockBootstrap(opposite, 123, [[0, 0, 1]]).ci_upper, -0.333333333333);
});

test('development mode never selects; eligible ranking is stable', async () => {
  const { rankEligible, selectOutcome, classifyCandidate } = await load('lib/selection.mjs');
  const records = [
    { candidate_id: 'z', classification: 'ELIGIBLE', mae: 0.5, severe_error_rate: 0,
      within_1_accuracy: 1, abs_bias: 0, qwk: 0.8, changed_unit_count: 2,
      normalized_parameter_distance: 0.2 },
    { candidate_id: 'a', classification: 'ELIGIBLE', mae: 0.5, severe_error_rate: 0,
      within_1_accuracy: 1, abs_bias: 0, qwk: 0.8, changed_unit_count: 2,
      normalized_parameter_distance: 0.2 }
  ];
  assert.equal(rankEligible(records)[0].candidate_id, 'a');
  assert.deepEqual(selectOutcome(records, 'DEVELOPMENT_VALIDATION'),
    { outcome: 'DEVELOPMENT_ONLY', selected_candidate_id: null });
  const assessment = classifyCandidate({
    coverage: { cohort_sample_count: 30, control_success_count: 30, candidate_success_count: 30 },
    control: { mae: 1, severe_error_rate: 0.2, within_1_accuracy: 0.8, bias: 0.2, qwk: 0.5 },
    candidate: { mae: 0.8, severe_error_rate: 0.1, within_1_accuracy: 0.9, bias: 0.1, qwk: 0.6 },
    noSkill: 1.2, slices: [], bootstrap: { status: 'COMPUTED', ci_upper: 0 }
  });
  assert.equal(assessment.status, 'STATISTICALLY_INCONCLUSIVE');
});

test('formal selection distinguishes an eligible winner, uncertain evidence and hard regression', async () => {
  const { classifyCandidate, selectOutcome } = await load('lib/selection.mjs');
  const base = {
    coverage: { cohort_sample_count: 32, control_success_count: 32, candidate_success_count: 32 },
    control: { mae: 1, severe_error_rate: 0.2, within_1_accuracy: 0.8, bias: 0.2, qwk: 0.5 },
    candidate: { mae: 0.8, severe_error_rate: 0.1, within_1_accuracy: 0.9, bias: 0.1, qwk: 0.6 },
    noSkill: 1.2, slices: [], bootstrap: { status: 'COMPUTED', ci_upper: -0.05 }
  };
  const eligible = classifyCandidate(base);
  const uncertain = classifyCandidate({ ...base, bootstrap: { status: 'COMPUTED', ci_upper: 0.02 } });
  const hardRegression = classifyCandidate({ ...base,
    candidate: { ...base.candidate, severe_error_rate: 0.3 } });
  assert.equal(eligible.status, 'ELIGIBLE');
  assert.equal(uncertain.status, 'STATISTICALLY_INCONCLUSIVE');
  assert.equal(hardRegression.status, 'INELIGIBLE');
  assert.ok(hardRegression.reason_codes.includes('SEVERE_WORSE'));
  const records = [
    { candidate_id: 'C', classification: hardRegression.status, mae: 0.7 },
    { candidate_id: 'B', classification: uncertain.status, mae: 0.75 },
    { candidate_id: 'A', classification: eligible.status, mae: 0.8 }
  ];
  assert.deepEqual(selectOutcome(records, 'FORMAL_VALIDATION'),
    { outcome: 'SELECTED', selected_candidate_id: 'A' });
  assert.deepEqual(selectOutcome(records.slice(0, 2), 'FORMAL_VALIDATION'),
    { outcome: 'INCONCLUSIVE', selected_candidate_id: null });
  assert.deepEqual(selectOutcome(records.slice(0, 1), 'FORMAL_VALIDATION'),
    { outcome: 'NO_ELIGIBLE_CANDIDATE', selected_candidate_id: null });
  assert.deepEqual(selectOutcome(records, 'DEVELOPMENT_VALIDATION'),
    { outcome: 'DEVELOPMENT_ONLY', selected_candidate_id: null });
});

test('package verification rejects tampering even with a rewritten manifest hash', async () => {
  const [{ planIdentity }, { packageManifest, inspectValidation },
    { validationSchema, CSV_TABLES }, { validationPolicy }, { writeCsv }, { canonicalJson }] = await Promise.all([
      load('plan-validation.mjs'), load('lib/package.mjs'), load('validation-schema.mjs'),
      load('validation-policy.mjs'), import('../tools/dataset/lib/csv.mjs'),
      import('../tools/dataset/lib/common.mjs')
    ]);
  const plan = planIdentity({ mode: 'DEVELOPMENT_VALIDATION', status: 'READY_DEVELOPMENT', candidates: [],
    validation_members: [], no_skill_reference_ordinal: 1, source: {} });
  const files = {
    'schema.json': canonicalJson(validationSchema()),
    'policy.json': canonicalJson(validationPolicy()),
    'validation_plan.json': canonicalJson(plan.payload),
    'verified_source_identities.json': canonicalJson({}),
    'validation_disclosure_evidence.json': canonicalJson({}),
    'selection_result.json': canonicalJson({ mode: 'DEVELOPMENT_VALIDATION',
      result_usage: 'DEVELOPMENT_ONLY', formal_promotion_allowed: false,
      selected_candidate_id: null, outcome: 'DEVELOPMENT_ONLY', candidates: [],
      reference_parity: { fail_count: 0 }, control_failure_count: 0 }),
    'reports/summary.json': canonicalJson({ mode: 'DEVELOPMENT_VALIDATION',
      status: 'DEVELOPMENT_ONLY', plan_id: plan.planId,
      selection_outcome: 'DEVELOPMENT_ONLY', candidate_count: 0,
      selected_candidate_id: null, test_evaluated: false,
      evaluated_splits: ['VALIDATION'] })
  };
  for (const [name, schema] of Object.entries(CSV_TABLES)) files[name] = writeCsv(schema, []);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-package-'));
  try {
    const write = async () => {
      for (const [name, contents] of Object.entries(files)) {
        const file = path.join(temp, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents);
      }
      await fs.writeFile(path.join(temp, 'manifest.json'), canonicalJson(packageManifest(files, plan.planId)));
    };
    await write();
    assert.equal((await inspectValidation(temp)).status, 'PASS');
    files['selection_result.json'] = canonicalJson({ ...JSON.parse(files['selection_result.json']),
      selected_candidate_id: 'forged' });
    await write();
    await assert.rejects(inspectValidation(temp), { reason_code: 'DEVELOPMENT_PROMOTION_FORBIDDEN' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('synthetic VALIDATION replay builds a self-verifying development package', async () => {
  const [{ planIdentity }, { buildValidationResult }, { packageManifest, inspectValidation },
    { loadFrozenBaseConfig }, { UNITS }, { canonicalJson, hash }] = await Promise.all([
      load('plan-validation.mjs'), load('lib/build.mjs'), load('lib/package.mjs'),
      import('../tools/tuning/lib/base-config.mjs'),
      import('../tools/tuning/parameter-registry.mjs'),
      import('../tools/dataset/lib/common.mjs')
    ]);
  const config = (await loadFrozenBaseConfig()).config;
  const members = Array.from({ length: 8 }, (_, index) => ({
    snapshot_id: `v${index}`, event_id: `e${index}`,
    location_key: `loc${index % 3}`, event_date_local: `2026-09-${String(index + 1).padStart(2, '0')}`
  }));
  const cohort = members.map((member, index) => ({ ...member,
    city: `City ${index % 3}`, lead_time_bucket: 'T_1_3H',
    lead_time_minutes: 60 + index, prediction_time_epoch: 1780000000000 + index,
    gt_label: 'fair',
    gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1,
    gt_status: 'STRONG', gt_basis: 'OBSERVATION_AGGREGATED',
    regime_label: 'CLEAR', sky_evolution_state: 'STABLE',
    scheduled_slot: '1755', snapshot_source: 'github_schedule',
    tile_radar_available: true, tile_sat_available: true,
    predicted_score: 30 + index, engine_build_sha: 'a'.repeat(40),
    replay: { score: 30 + index }
  }));
  const candidate = { candidate_id: 'phase6_baseline_fixture', canonical_vector: {},
    effective_config_sha256: hash(canonicalJson(config)),
    resolved: { changed_unit_count: 0, normalized_parameter_distance: 0 } };
  const core = { mode: 'DEVELOPMENT_VALIDATION', status: 'READY_DEVELOPMENT',
    candidates: [{ candidate_id: candidate.candidate_id,
      canonical_vector: candidate.canonical_vector,
      effective_config_sha256: candidate.effective_config_sha256,
      changed_unit_count: 0, normalized_parameter_distance: 0 }],
    validation_members: members, no_skill_reference_ordinal: 2,
    source: {} };
  const plan = planIdentity(core);
  const stub = async (replay, options) => ({
    actual: { score: replay.score, gw_factor: 1, sky_evolution_factor: 1 },
    reference: { score: replay.score }, deltas: { components: {} }, pass: true,
    comparison_errors: []
  });
  const built = await buildValidationResult({ plan: plan.payload, input: {
    cohort, candidates: [candidate], sensitivity: { baseConfig: { config } },
    searchSpace: { registry_units: Object.fromEntries(UNITS.map(unit => [unit.parameter_id, unit])) }
  }, runReplay: stub, progress: { stage() {}, update() {} } });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-build-'));
  try {
    for (const [name, contents] of Object.entries(built.files)) {
      const file = path.join(temp, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }
    const manifest = packageManifest(built.files, plan.planId);
    await fs.writeFile(path.join(temp, 'manifest.json'), canonicalJson(manifest));
    assert.equal(manifest.result_usage, 'DEVELOPMENT_ONLY');
    assert.equal(manifest.descriptor.result_usage, 'DEVELOPMENT_ONLY');
    assert.equal(manifest.descriptor.manifest_contract_revision, 2);
    assert.deepEqual(manifest.coverage_by_candidate, [{
      candidate_id: candidate.candidate_id,
      control_source_coverage_rate: 1,
      candidate_control_coverage_rate: 1
    }]);
    assert.equal((await inspectValidation(temp)).status, 'PASS');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('Phase B Model reader has a closed VALIDATION-only allowlist', async () => {
  const [{ MODEL_ALLOW_FILES }, { readRestrictedFile }] = await Promise.all([
    load('lib/source.mjs'), import('../tools/tuning/lib/input.mjs')
  ]);
  assert.deepEqual(MODEL_ALLOW_FILES, [
    'manifest.json', 'schema.json', 'policy.json', 'splits/validation.csv'
  ]);
  for (const forbidden of ['splits/test.csv', 'model_samples.csv', 'event_splits.csv',
    'reports/statistics.json', 'foreign/replay.json']) {
    await assert.rejects(readRestrictedFile('.', forbidden, { allowFiles: MODEL_ALLOW_FILES }),
      { reason_code: 'TEST_ACCESS_FORBIDDEN' });
  }
});

test('forged Policy 3 manifest and missing disclosure cannot unlock formal CLI', async () => {
  const { planValidation } = await load('plan-validation.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-forged-formal-'));
  try {
    await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify({
      optimization_mode: 'FORMAL_OPTIMIZATION', candidate_freeze_allowed: true,
      validation_promotion_allowed: true, evaluation_policy_version: 3,
      tuning_policy_version: 3
    }));
    await assert.rejects(planValidation({ mode: 'formal', optimization: temp }),
      { code: 'INVALID_ARGUMENTS' });
    const result = await planValidation({ mode: 'formal', optimization: temp,
      disclosureEvidence: path.join(temp, 'forged-evidence') });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.plan_id, null);
    assert.ok(result.blocking_reasons.includes('UPSTREAM_FORMAL_NOT_READY'));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('test-only formal Builder → Result → Validator covers select, inconclusive and no eligible', async () => {
  const [{ buildValidationResult }, { packageManifest, inspectValidation },
    { validateValidation }, { canonicalJson }] = await Promise.all([
      load('lib/build.mjs'), load('lib/package.mjs'), load('validate-validation.mjs'),
      import('../tools/dataset/lib/common.mjs')
    ]);
  for (const [scenario, expected] of [
    ['mixed', 'SELECTED'], ['all-uncertain', 'INCONCLUSIVE'],
    ['all-hard', 'NO_ELIGIBLE_CANDIDATE']
  ]) {
    const fixture = await makeFormalFixture(scenario);
    await assert.rejects(buildValidationResult({ plan: fixture.plan, input: fixture.input,
      runReplay: fixture.runReplay }), { reason_code: 'PLAN_NOT_RUNNABLE' });
    const built = await buildValidationResult({ plan: fixture.plan, input: fixture.input,
      runReplay: fixture.runReplay, testFixtureFormal: true,
      progress: { stage() {}, update() {} } });
    assert.equal(built.selection.outcome, expected);
    assert.equal(built.selection.result_usage, 'TEST_FIXTURE_ONLY');
    assert.equal(built.selection.formal_promotion_allowed, false);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-formal-fixture-'));
    try {
      for (const [name, contents] of Object.entries(built.files)) {
        const file = path.join(temp, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents);
      }
      const manifest = packageManifest(built.files, fixture.planId);
      await fs.writeFile(path.join(temp, 'manifest.json'), canonicalJson(manifest));
      assert.equal(manifest.result_usage, 'TEST_FIXTURE_ONLY');
      assert.equal(manifest.test_fixture_only, true);
      assert.equal((await inspectValidation(temp)).status, 'PASS');
      assert.equal((await validateValidation({ path: temp })).validation_scope, 'PACKAGE_INTERNAL');
      await assert.rejects(validateValidation({ path: temp, model: temp, optimization: temp }),
        { reason_code: 'TEST_FIXTURE_SOURCE_LINK_FORBIDDEN' });
      assert.equal('selected_candidate.json' in built.files, expected === 'SELECTED');
      if (expected === 'SELECTED') {
        const selected = JSON.parse(built.files['selected_candidate.json']);
        assert.equal(selected.candidate_id, fixture.candidates[0].candidate_id);
        assert.equal(selected.eligible_for_phase8, false);
      }
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
});

test('one deterministic Candidate failure is isolated, while transient Replay aborts the attempt', async () => {
  const [{ buildValidationResult }, { readCsv }, { CSV_TABLES }] = await Promise.all([
    load('lib/build.mjs'), import('../tools/dataset/lib/csv.mjs'),
    load('validation-schema.mjs')
  ]);
  const fixture = await makeFormalFixture('candidate-failure');
  const built = await buildValidationResult({ plan: fixture.plan, input: fixture.input,
    runReplay: fixture.runReplay, testFixtureFormal: true,
    progress: { stage() {}, update() {} } });
  assert.equal(built.selection.outcome, 'SELECTED');
  assert.equal(built.selection.selected_candidate_id, fixture.candidates[0].candidate_id);
  assert.equal(built.selection.candidates[1].classification, 'INELIGIBLE');
  const failures = readCsv(CSV_TABLES['replay_failures.csv'], built.files['replay_failures.csv']);
  assert.equal(failures.length, 5);
  assert.ok(failures.every(row => row.phase === 'CANDIDATE' &&
    row.candidate_id === fixture.candidates[1].candidate_id &&
    row.error_code === 'SYNTHETIC_DETERMINISTIC_FAILURE'));
  assert.ok(!built.files['replay_failures.csv'].includes('synthetic failure details'));
  const parity = readCsv(CSV_TABLES['replay_reference_parity.csv'],
    built.files['replay_reference_parity.csv']);
  assert.ok(parity.every(row => row.split === 'VALIDATION'));
  const transient = await makeFormalFixture('transient');
  await assert.rejects(buildValidationResult({ plan: transient.plan, input: transient.input,
    runReplay: transient.runReplay, testFixtureFormal: true,
    progress: { stage() {}, update() {} } }), { reason_code: 'REPLAY_TRANSIENT_FAILURE' });
});

test('formal fixture rejects selected, ranking and summary tampering after manifest rehash', async () => {
  const [{ buildValidationResult }, { packageManifest, inspectValidation },
    { canonicalJson }, { readCsv, writeCsv }, { CSV_TABLES }] = await Promise.all([
      load('lib/build.mjs'), load('lib/package.mjs'),
      import('../tools/dataset/lib/common.mjs'), import('../tools/dataset/lib/csv.mjs'),
      load('validation-schema.mjs')
    ]);
  const fixture = await makeFormalFixture('mixed');
  const built = await buildValidationResult({ plan: fixture.plan, input: fixture.input,
    runReplay: fixture.runReplay, testFixtureFormal: true,
    progress: { stage() {}, update() {} } });
  const original = structuredClone(built.files);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-formal-tamper-'));
  try {
    const write = async files => {
      for (const [name, contents] of Object.entries(files)) {
        const file = path.join(temp, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, contents);
      }
      await fs.writeFile(path.join(temp, 'manifest.json'),
        canonicalJson(packageManifest(files, fixture.planId)));
    };
    await write(original);
    assert.equal((await inspectValidation(temp)).status, 'PASS');
    const selected = JSON.parse(original['selected_candidate.json']);
    await write({ ...original, 'selected_candidate.json': canonicalJson({ ...selected,
      eligible_for_phase8: true }) });
    await assert.rejects(inspectValidation(temp), { reason_code: 'FIXTURE_SELECTED_MISMATCH' });
    const comparison = readCsv(CSV_TABLES['candidate_comparison.csv'],
      original['candidate_comparison.csv']);
    comparison[0].rank = 99;
    await write({ ...original, 'candidate_comparison.csv':
      writeCsv(CSV_TABLES['candidate_comparison.csv'], comparison) });
    await assert.rejects(inspectValidation(temp), { reason_code: 'CANDIDATE_RANKING_MISMATCH' });
    const summary = JSON.parse(original['reports/summary.json']);
    await write({ ...original, 'reports/summary.json': canonicalJson({ ...summary,
      selected_candidate_id: 'forged' }) });
    await assert.rejects(inspectValidation(temp), { reason_code: 'SUMMARY_MISMATCH' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('disclosure ledger is append-only and detects a rewritten entry', async () => {
  const { appendLedger, readLedger, ledgerPrefixMatches, withLedgerLock } = await load('lib/disclosure.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-ledger-'));
  try {
    await withLedgerLock(temp, async () => {
      const genesis = await readLedger(temp);
      assert.equal(genesis.sequence, 0);
      const first = await appendLedger(temp, { action: 'PLAN_REGISTERED', plan_id: 'p1' });
      await appendLedger(temp, { action: 'FIRST_ACCESS_RESERVED', plan_id: 'p1' });
      const current = await readLedger(temp);
      assert.equal(current.sequence, 2);
      assert.ok(ledgerPrefixMatches(current, { sequence: 1, sha256: first.entry_sha256 }));
    });
    const file = path.join(temp, 'access.jsonl');
    const content = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, content.replace('PLAN_REGISTERED', 'PLAN_REGISTEREX'));
    await assert.rejects(readLedger(temp), { reason_code: 'LEDGER_CHAIN_INVALID' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('access lock rejects concurrent first use and a failed attempt stays exposed on retry', async () => {
  const { appendLedger, readLedger, ledgerPrefixMatches, withLedgerLock } =
    await load('lib/disclosure.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-ledger-retry-'));
  try {
    let prefix;
    await assert.rejects(withLedgerLock(temp, async () => {
      const registered = await appendLedger(temp, { action: 'PLAN_REGISTERED', plan_id: 'fixture-plan' });
      prefix = { sequence: registered.sequence, sha256: registered.entry_sha256 };
      await assert.rejects(withLedgerLock(temp, async () => {}), { code: 'VALIDATION_ACCESS_BUSY' });
      await appendLedger(temp, { action: 'FIRST_ACCESS_RESERVED', plan_id: 'fixture-plan' });
      await appendLedger(temp, { action: 'RUN_STARTED', plan_id: 'fixture-plan' });
      await appendLedger(temp, { action: 'RUN_FAILED', plan_id: 'fixture-plan' });
      throw Error('injected fixture failure');
    }), /injected fixture failure/);
    await withLedgerLock(temp, async () => {
      const before = await readLedger(temp);
      assert.ok(ledgerPrefixMatches(before, prefix));
      assert.equal(before.rows.filter(row => row.action === 'FIRST_ACCESS_RESERVED').length, 1);
      await appendLedger(temp, { action: 'RETRY', plan_id: 'fixture-plan' });
      await appendLedger(temp, { action: 'RUN_COMPLETED', plan_id: 'fixture-plan',
        result_id: 'fixture-only-result' });
    });
    const after = await readLedger(temp);
    assert.equal(after.sequence, 6);
    assert.equal(after.rows[3].action, 'RUN_FAILED');
    assert.ok(ledgerPrefixMatches(after, prefix));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('publishing a formal fixture detects source change before export and then deduplicates', async () => {
  const [{ buildValidationResult }, { packageManifest, publishValidation, inspectValidation },
    { canonicalJson, fail }] = await Promise.all([
      load('lib/build.mjs'), load('lib/package.mjs'),
      import('../tools/dataset/lib/common.mjs')
    ]);
  const fixture = await makeFormalFixture('mixed');
  const built = await buildValidationResult({ plan: fixture.plan, input: fixture.input,
    runReplay: fixture.runReplay, testFixtureFormal: true,
    progress: { stage() {}, update() {} } });
  const manifest = packageManifest(built.files, fixture.planId);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-publish-fixture-'));
  try {
    await assert.rejects(publishValidation({ output: temp, files: built.files, manifest,
      sourceCheck: async () => fail('VALIDATION_VALIDATION_FAILED',
        { reason_code: 'SOURCE_CHANGED_DURING_VALIDATION' }) }),
    { reason_code: 'SOURCE_CHANGED_DURING_VALIDATION' });
    await assert.rejects(fs.access(path.join(temp, 'exports', manifest.validation_id)));
    assert.equal((await fs.readdir(path.join(temp, 'staging'))).length, 1);
    const first = await publishValidation({ output: temp, files: built.files, manifest,
      sourceCheck: async () => {} });
    assert.equal(first.status, 'EXPORTED');
    const second = await publishValidation({ output: temp, files: built.files, manifest,
      sourceCheck: async () => {} });
    assert.equal(second.status, 'DEDUPLICATED');
    assert.equal((await inspectValidation(first.directory)).status, 'PASS');
    assert.equal(canonicalJson((await fs.readdir(path.join(temp, 'exports')))),
      canonicalJson([manifest.validation_id]));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('maintenance treats Evidence as a node and refuses prune without its persistent ledger', async () => {
  const [{ makeDevelopmentEvidence, publishEvidence, appendLedger, withLedgerLock },
    { scanDataset }, { buildPrunePlan }, { planIdentity, planManifest },
    { canonicalJson, hash }] = await Promise.all([
      load('lib/disclosure.mjs'), import('../tools/maintenance/lib/scan.mjs'),
      import('../tools/maintenance/lib/plan.mjs'), load('plan-validation.mjs'),
      import('../tools/dataset/lib/common.mjs')
    ]);
  const dataset = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-maintenance-'));
  try {
    const evidence = makeDevelopmentEvidence({ rows: [{ event_id: 'e1',
      location_key: 'loc', event_date_local: '2026-09-01' }],
    modelId: 'model_fixture', csvSha256: 'a'.repeat(64),
    prefix: { sequence: 0, sha256: '0'.repeat(64) } });
    await publishEvidence(path.join(dataset, 'validation'), evidence, 'b'.repeat(64));
    const graph = await scanDataset({ datasetRoot: dataset });
    assert.ok(graph.nodes.some(node => node.id === evidence.evidence_id));
    assert.ok(graph.diagnostics.some(item => item.code === 'VALIDATION_LEDGER_INVALID_OR_MISSING' &&
      item.node_id === evidence.evidence_id));
    const plan = buildPrunePlan({ graph, targetId: evidence.evidence_id, datasetRoot: dataset });
    assert.equal(plan.status, 'BLOCKED');
    const ledgerRoot = path.join(dataset, 'validation', 'access-ledger');
    await withLedgerLock(ledgerRoot, async () => {
      await appendLedger(ledgerRoot, { action: 'PLAN_REGISTERED', plan_id: 'p1',
        evidence_id: evidence.evidence_id, evidence_sha256: evidence.sha256 });
    });
    const after = await scanDataset({ datasetRoot: dataset });
    assert.equal(after.validation_ledger.status, 'VALID');
    assert.ok(!after.diagnostics.some(item => item.code.startsWith('VALIDATION_LEDGER')));
    const evidenceManifestBytes = await fs.readFile(path.join(dataset,
      'validation', 'evidence', 'exports', evidence.evidence_id, 'manifest.json'));
    const planned = planIdentity({ mode: 'DEVELOPMENT_VALIDATION', status: 'READY_DEVELOPMENT',
      source: {}, candidates: [], validation_members: [], evidence_id: evidence.evidence_id });
    const planDir = path.join(dataset, 'validation', 'plans', planned.planId);
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(path.join(planDir, 'validation_plan.json'), canonicalJson(planned.payload));
    await fs.writeFile(path.join(planDir, 'plan_manifest.json'), canonicalJson(planManifest(planned,
      hash(evidenceManifestBytes))));
    const resultId = 'validation_v1_fixture';
    const resultDir = path.join(dataset, 'validation', 'exports', resultId);
    await fs.mkdir(resultDir, { recursive: true });
    const descriptor = { validation_plan_id: planned.planId, evidence_id: evidence.evidence_id };
    await fs.writeFile(path.join(resultDir, 'manifest.json'), canonicalJson({
      validation_schema_version: 1, validation_policy_version: 1,
      validation_id: resultId, validation_plan_id: planned.planId,
      evidence_id: evidence.evidence_id, source_ids: {},
      descriptor, descriptor_sha256: hash(canonicalJson(descriptor))
    }));
    const chain = await scanDataset({ datasetRoot: dataset });
    const edges = chain.edges.map(edge => `${edge.parent_id}->${edge.child_id}`);
    assert.ok(edges.includes(`${evidence.evidence_id}->${planned.planId}`));
    assert.ok(edges.includes(`${planned.planId}->${resultId}`));
    assert.deepEqual(buildPrunePlan({ graph: chain, targetId: evidence.evidence_id,
      datasetRoot: dataset }).execution_order.map(row => row.id),
    [resultId, planned.planId, evidence.evidence_id]);
  } finally { await fs.rm(dataset, { recursive: true, force: true }); }
});

test('validation acquires and releases every distinct source/output maintenance root', async () => {
  const { withValidationLeases } = await load('lib/lease.mjs');
  const { inspectMaintenanceState } = await import('../tools/maintenance/lib/lease.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-leases-'));
  const a = path.join(temp, 'a'), b = path.join(temp, 'b');
  try {
    const paths = {
      raw: path.join(a, 'exports', 'raw_fixture'),
      gt: path.join(b, 'ground_truth', 'exports', 'gt_fixture'),
      model: path.join(b, 'model', 'exports', 'model_fixture'),
      baseline: path.join(b, 'evaluation', 'exports', 'evaluation_fixture'),
      sensitivity: path.join(b, 'tuning', 'exports', 'sensitivity_fixture'),
      optimization: path.join(b, 'optimization', 'exports', 'optimization_fixture')
    };
    await Promise.all(Object.values(paths).map(dir => fs.mkdir(dir, { recursive: true })));
    await withValidationLeases('validation_test', paths, path.join(b, 'validation'), async () => {
      assert.equal((await inspectMaintenanceState(a)).active_leases.length, 1);
      assert.equal((await inspectMaintenanceState(b)).active_leases.length, 1);
    });
    assert.equal((await inspectMaintenanceState(a)).active_leases.length, 0);
    assert.equal((await inspectMaintenanceState(b)).active_leases.length, 0);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
