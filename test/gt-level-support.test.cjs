const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeFormalFixture } = require('./validation-fixture.cjs');
const load = name => import('../tools/' + name + '.mjs');

function cohort(counts) {
  const rows = [];
  for (const [ordinal, count] of counts.entries()) for (let i = 0; i < count; i++) {
    const index = rows.length;
    rows.push({ snapshot_id: `s${String(index).padStart(4, '0')}`, event_id: `e${index}`,
      location_key: `city${index % 7}`, city: `City ${index % 7}`,
      event_date_local: `2026-09-${String(1 + index % 14).padStart(2, '0')}`,
      gt_ordinal: ordinal, gt_confidence: 1 });
  }
  return rows;
}

async function readiness(rows, version) {
  const [tuning, metrics, optimization] = await Promise.all([
    load('tuning/lib/readiness'), load('tuning/lib/metrics'), load('optimization/lib/readiness')]);
  return {
    tuning: tuning.computeGlobalReadiness({ rows, profiles: metrics.cohortProfiles(rows),
      replaySummary: { replay_usable_rate: 1, pass_count: rows.length, fail_count: 0 },
      integrity: { checks: [] }, supportPolicyVersion: version === 2 ? 3 : undefined }),
    optimization: optimization.computeOptimizationReadiness({ rows,
      profile: optimization.cohortProfile(rows), replayUsableRate: 1, policyVersion: version,
      sensitivityLinkage: { engineering_readiness: { status: 'READY', reasons: [] },
        metric_readiness: { status: 'PROVISIONAL_PROXY', reasons: ['PROXY_MAPPING_NOT_VALIDATED'] },
        result_usage: 'EXPLORATORY_ONLY', tuning_policy_version: version === 2 ? 3 : 2 } })
  };
}

for (const rareCount of [0, 1, 4, 5]) test(`excellent=${rareCount}: Phase 5–7 share support, never formal permission`, async () => {
  const rows = cohort([0, 40, 30, 30 - rareCount, rareCount]);
  const { gtLevelSupport } = await load('gt-level-support');
  const { validationSupport } = await load('validation/validation-policy');
  const support = gtLevelSupport(rows);
  assert.deepEqual(support.reasons, []);
  assert.equal(support.by_level.length, 5);
  assert.equal(support.by_level[4].event_count, rareCount);
  assert.equal(support.by_level[4].status, rareCount === 0 ? 'ABSENT' : rareCount < 5 ? 'INSUFFICIENT' : 'SUPPORTED');
  assert.equal(support.warnings.length, rareCount < 5 ? 1 : 0);
  assert.equal(support.limitation_codes.length, rareCount < 5 ? 1 : 0);
  assert.equal(support.supported_gt_levels.length, rareCount < 5 ? 3 : 4);
  const result = await readiness(rows, 2);
  assert.equal(result.tuning.global_readiness, 'EXPLORATORY');
  assert.equal(result.optimization.data_readiness.status, 'READY');
  assert.equal(result.optimization.optimization_mode, 'EXPLORATORY_SEARCH');
  assert.deepEqual(result.optimization.gt_level_support, support);
  assert.equal(validationSupport(rows, 2).status, 'READY');
  assert.equal(validationSupport(rows, 2).gt_level_support.split, 'VALIDATION');
  if (rareCount > 0 && rareCount < 5) {
    assert.ok((await readiness(rows, 1)).tuning.reasons.includes('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM'));
    assert.ok(validationSupport(rows, 1).reasons.includes('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM'));
  }
});

test('two supported levels, thin non-rare grades and Event identity errors remain hard failures', async () => {
  const { gtLevelSupport } = await load('gt-level-support');
  assert.deepEqual(gtLevelSupport(cohort([0, 50, 46, 0, 4])).reasons, ['SUPPORTED_GT_LEVELS_BELOW_MINIMUM']);
  const thin = gtLevelSupport(cohort([1, 40, 29, 29, 1]));
  assert.ok(thin.reasons.includes('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM'));
  assert.equal(thin.insufficient_non_rare_levels[0].gt_level, 'poor');
  assert.deepEqual(gtLevelSupport(cohort([0, 50, 45, 0, 5])).reasons, []);
  const rows = cohort([0, 40, 30, 29, 1]);
  const rare = rows.at(-1);
  const duplicate = [...rows, ...Array.from({ length: 8 }, (_, i) => ({ ...rare, snapshot_id: `extra${i}` }))];
  const support = gtLevelSupport(duplicate);
  assert.equal(support.by_level[4].event_count, 1);
  assert.equal(support.by_level[4].snapshot_count, 9);
  for (const invalid of [
    [...rows, { ...rare, snapshot_id: 'conflict', gt_ordinal: 3 }],
    [...rows, { ...rare, snapshot_id: 'conflict', location_key: 'other' }],
    [...rows, { ...rare, snapshot_id: 'conflict', event_date_local: '2026-10-01' }],
    [{ ...rare, gt_ordinal: 5 }], [{ ...rare, event_id: '' }], [...rows, rare]
  ]) assert.throws(() => gtLevelSupport(invalid), error => error.code === 'GT_LEVEL_SUPPORT_INVALID');
});

test('total/date/Replay/concentration gates do not change; rare rows stay in metric denominators', async () => {
  const rows = cohort([0, 40, 30, 29, 1]);
  const { computeGlobalReadiness } = await load('tuning/lib/readiness');
  const { cohortProfiles } = await load('tuning/lib/metrics');
  const { computeOptimizationReadiness, cohortProfile } = await load('optimization/lib/readiness');
  const { pairMetrics } = await load('optimization/lib/metrics');
  const decide = (set, rate = 1) => computeGlobalReadiness({ rows: set, profiles: cohortProfiles(set),
    replaySummary: { replay_usable_rate: rate }, integrity: { checks: [] }, supportPolicyVersion: 3 });
  assert.ok(decide(rows.slice(1)).reasons.includes('TRAIN_PRIMARY_EVENTS_BELOW_MINIMUM'));
  assert.ok(decide(rows.map((row, i) => ({ ...row, event_date_local: String(i % 13) }))).reasons.includes('TRAIN_UNIQUE_DATES_BELOW_MINIMUM'));
  assert.ok(decide(rows, 0.99).reasons.includes('REPLAY_USABLE_RATE_BELOW_REQUIRED'));
  assert.ok(decide(rows.map(row => ({ ...row, city: 'same' }))).reasons.includes('SINGLE_CITY_EVENT_SHARE_ABOVE_MAXIMUM'));
  const concentrated = cohort([0, 61, 20, 18, 1]);
  const result = computeOptimizationReadiness({ rows: concentrated, profile: cohortProfile(concentrated),
    replayUsableRate: 1, policyVersion: 2, sensitivityLinkage: { tuning_policy_version: 3 } });
  assert.equal(result.label_concentration.max_single_gt_level_event_share, 0.61);
  assert.ok(result.reasons.includes('INSUFFICIENT_LABEL_BALANCE'));
  const { validationSupport } = await load('validation/validation-policy');
  assert.ok(validationSupport(rows.slice(0, 29), 2).reasons.includes('PRIMARY_EVENTS_BELOW_MINIMUM'));
  assert.ok(validationSupport(rows.map((row, i) => ({ ...row, event_date_local: String(i % 6) })), 2)
    .reasons.includes('DATES_BELOW_MINIMUM'));
  assert.ok(validationSupport(rows.map(row => ({ ...row, location_key: 'one' })), 2)
    .reasons.includes('CITY_CONCENTRATION_TOO_HIGH'));
  assert.ok(validationSupport(rows.map((row, i) => ({ ...row, event_date_local: i < 36 ? 'one-date' : row.event_date_local })), 2)
    .reasons.includes('DATE_CONCENTRATION_TOO_HIGH'));
  const predictions = rows.map(row => ({ ...row, control_ordinal: row.gt_ordinal,
    experiment_ordinal: row.gt_ordinal === 4 ? 0 : row.gt_ordinal }));
  assert.equal(pairMetrics(predictions).candidate.mae, 0.04);
  assert.equal(pairMetrics(predictions.filter(row => row.gt_ordinal !== 4)).candidate.mae, 0);
});

test('rare audit retains every rare Snapshot and missing pair, recomputes null reasons and detects metadata tampering', async () => {
  const { supportDocument, inspectSupportDocument } = await load('gt-level-support');
  const rows = cohort([0, 40, 30, 29, 1]);
  const predictions = [{ ...rows.at(-1), control_ordinal: 4, experiment_ordinal: 1 }];
  const doc = supportDocument(rows, 'TRAIN', [{ id: 'all', rows: predictions }, { id: 'failed', rows: [] }]);
  assert.equal(doc.rare_level_audit[0].experiment_metrics.mae, 3);
  assert.equal(doc.rare_level_audit[1].unpaired_snapshot_ids.length, 1);
  assert.equal(doc.rare_level_audit[1].experiment_metrics.mae, null);
  assert.equal(doc.rare_level_audit[1].reason_code, 'NO_PAIRED_SAMPLES');
  const failed = supportDocument(rows, 'TRAIN', [{ id: 'failed', rows: [],
    failures: [{ snapshot_id: rows.at(-1).snapshot_id, stage: 'CONTROL', error_code: 'SYNTHETIC_FAILURE' }] }]);
  assert.equal(failed.rare_level_audit[0].unpaired_failures[0].phase, 'CONTROL');
  assert.equal(failed.rare_level_audit[0].unpaired_failures[0].error_code, 'SYNTHETIC_FAILURE');
  inspectSupportDocument(failed, 'TRAIN', 'TUNING_VALIDATION_FAILED', rows);
  inspectSupportDocument(doc, 'TRAIN', 'TUNING_VALIDATION_FAILED', rows);
  for (const mutate of [
    d => d.gt_level_support.by_level[4].event_count++,
    d => d.gt_level_support.supported_gt_levels.push('excellent'),
    d => d.gt_level_support.warnings = [],
    d => d.gt_level_support.limitation_codes = [],
    d => d.gt_level_support_sha256 = '0'.repeat(64),
    d => d.rare_level_audit[0].experiment_metrics.mae = 0
  ]) {
    const forged = structuredClone(doc); mutate(forged);
    assert.throws(() => inspectSupportDocument(forged, 'TRAIN', 'TUNING_VALIDATION_FAILED'),
      error => error.reason_code === 'GT_LEVEL_SUPPORT_MISMATCH');
  }
  const absent = supportDocument(cohort([0, 40, 30, 30, 0]), 'TRAIN', [{ id: 'absent', rows: [] }]);
  assert.equal(absent.rare_level_audit[0].experiment_metrics.mae, null);
  assert.equal(absent.rare_level_audit[0].reason_code, 'NO_EXCELLENT_SAMPLES');
});

test('explicit versions leave historical contracts and adapters unchanged; run cannot override a frozen plan', async () => {
  const { tuningContract, POLICY_V2, SCHEMA_V2 } = await load('tuning/v2/contract');
  const { optimizationPolicy } = await load('optimization/optimization-policy');
  const { validationPolicy, effectiveSelectionPolicy } = await load('validation/validation-policy');
  const { validationSelectionRuleDocument } = await load('optimization/lib/finalist');
  const { parseArgs: tuningArgs } = await load('tuning/lib/cli');
  const { parseArgs: optimizationArgs } = await load('optimization/lib/cli');
  const { parseArgs: validationArgs } = await load('validation/lib/cli');
  const { phaseByKey, isSupportedVersion } = await load('maintenance/maintenance-policy');
  assert.equal(tuningContract(3).policy.formal_capable, false);
  assert.ok(!POLICY_V2.package.export_files.includes('gt_level_support.json'));
  assert.ok(!SCHEMA_V2.json.manifest.required.includes('gt_level_support'));
  assert.equal(optimizationPolicy().optimization_policy_version, 1);
  assert.equal(validationPolicy().validation_policy_version, 1);
  assert.equal(effectiveSelectionPolicy(validationSelectionRuleDocument(optimizationPolicy(2)), 2).adapter,
    'OPTIMIZATION_V2_TO_VALIDATION_V2');
  assert.throws(() => effectiveSelectionPolicy(validationSelectionRuleDocument(), 2));
  assert.throws(() => effectiveSelectionPolicy(validationSelectionRuleDocument(optimizationPolicy(2)), 1));
  const sourceArgs = ['--model', 'm', '--raw', 'r', '--gt', 'g', '--baseline', 'b'];
  assert.equal(tuningArgs([...sourceArgs, '--tuning-version', '3'], 'readiness').tuningVersion, 3);
  assert.equal(optimizationArgs([...sourceArgs, '--sensitivity', 's', '--optimization-policy-version', '2'], 'plan').optimizationPolicyVersion, 2);
  assert.throws(() => optimizationArgs(['package', '--model', 'm'], 'validate'));
  const sixSources = [...sourceArgs, '--sensitivity', 's', '--optimization', 'o'];
  assert.equal(validationArgs([...sixSources, '--mode', 'development', '--validation-policy-version', '2'], 'plan').validationPolicyVersion, 2);
  assert.throws(() => validationArgs([...sixSources, '--plan', 'p', '--validation-policy-version', '2'], 'run'));
  for (const [key, schema, policy] of [['sensitivity', 2, 3], ['optimization', 1, 2], ['validation', 1, 2]]) {
    assert.equal(isSupportedVersion(phaseByKey(key), schema, policy), true);
  }
  assert.equal(isSupportedVersion(phaseByKey('evaluation'), 2, 3), false);
});

test('Policy 2 development Builder → Validator preserves rare rows and rejects support rehash tampering', async t => {
  const fixture = await makeFormalFixture();
  const common = await load('dataset/lib/common');
  const support = await load('gt-level-support');
  const policy = await load('validation/validation-policy');
  const { optimizationPolicy } = await load('optimization/optimization-policy');
  const { validationSelectionRuleDocument } = await load('optimization/lib/finalist');
  const { planIdentity } = await load('validation/plan-validation');
  const { buildValidationResult } = await load('validation/lib/build');
  const { inspectValidation, packageManifest } = await load('validation/lib/package');
  const rows = fixture.input.cohort.map((row, i) => ({ ...row, gt_ordinal: i === 34 ? 4 : row.gt_ordinal }));
  const train = support.gtLevelSupport(rows, 'TRAIN');
  const upstream = { sensitivity_id: 'synthetic_v3', gt_level_support: train,
    gt_level_support_sha256: support.supportDigest(train), limitation_codes: train.limitation_codes,
    conclusion_limitations: train.conclusion_limitations };
  const sourceRule = validationSelectionRuleDocument(optimizationPolicy(2));
  const selectionPolicy = policy.effectiveSelectionPolicy(sourceRule, 2);
  const core = { ...fixture.plan.plan_core, fixture_only: false,
    validation_schema_version: 1, validation_policy_version: 2,
    validation_members_sha256: common.hash(common.canonicalJson(fixture.plan.plan_core.validation_members)),
    mode: 'DEVELOPMENT_VALIDATION', status: 'READY_DEVELOPMENT', result_usage: 'DEVELOPMENT_ONLY',
    support: policy.validationSupport(rows, 2), gt_level_support: support.gtLevelSupport(rows, 'VALIDATION'),
    gt_level_support_sha256: support.supportDigest(support.gtLevelSupport(rows, 'VALIDATION')),
    gt_level_support_cohort: support.supportCohort(rows), upstream_train_support: upstream,
    policy: policy.validationPolicy(2), source_validation_selection_rule: sourceRule,
    source_validation_selection_rule_sha256: selectionPolicy.source_validation_selection_rule_sha256,
    effective_selection_policy: selectionPolicy,
    effective_selection_policy_sha256: common.hash(common.canonicalJson(selectionPolicy)) };
  const plan = planIdentity(core);
  const scores = [10, 30, 50, 70, 95];
  const runReplay = async replay => ({ actual: { score: scores[replay.gtOrdinal], gw_factor: 1, sky_evolution_factor: 1 },
    reference: { score: replay.historicalScore }, deltas: { components: {} }, pass: true, comparison_errors: [] });
  const built = await buildValidationResult({ plan: plan.payload, input: { ...fixture.input, cohort: rows }, runReplay });
  assert.equal(built.selection.result_usage, 'DEVELOPMENT_ONLY');
  assert.equal(built.selection.selected_candidate_id, null);
  assert.equal(built.summary.gt_level_support.by_level[4].event_count, 1);
  assert.equal(built.summary.rare_level_audit.length, 3);
  assert.equal(built.tables['candidate_sample_predictions.csv'].filter(row => row.gt_ordinal === 4).length, 3);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-support-v2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  async function write(files) {
    for (const [name, value] of Object.entries({ ...files, 'manifest.json': common.canonicalJson(packageManifest(files, plan.planId)) })) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), value);
    }
  }
  await write(built.files);
  assert.equal((await inspectValidation(dir)).status, 'PASS');
  const forged = { ...built.files };
  const payload = JSON.parse(forged['validation_plan.json']);
  payload.plan_core.gt_level_support.warnings = [];
  const rehashed = planIdentity(payload.plan_core);
  forged['validation_plan.json'] = common.canonicalJson(rehashed.payload);
  await write(forged);
  await assert.rejects(() => inspectValidation(dir), error => error.reason_code === 'GT_LEVEL_SUPPORT_MISMATCH');
});

test('Optimization Policy 2 freezes full TRAIN support and cannot promote a proxy package', async t => {
  const common = await load('dataset/lib/common');
  const support = await load('gt-level-support');
  const { buildOptimizationPackage } = await load('optimization/lib/build');
  const { inspectOptimization } = await load('optimization/validate-optimization');
  const { filesMetadata, identity } = await load('optimization/lib/package');
  const { optimizationPolicy } = await load('optimization/optimization-policy');
  const config = { a: 10, horizonGate: [{ min: 10, gate: 30 }, { min: 5, gate: 20 }] };
  const registry = { units: [{ parameter_id: 'high_cloud_center', canonical_path: 'a',
    unit_category: 'OAT', group_id: null, optimizable: true, wired_status: 'WIRED',
    replay_class: 'REPLAY_SAFE', integer: false, range: [0, 20], probe_absolute: [5, 10, 15] }] };
  const digest = value => common.hash(common.canonicalJson(value));
  const rows = cohort([0, 40, 30, 29, 1]).map(row => ({ ...row,
    replay: { ordinal: row.gt_ordinal }, gt_label: support.GT_LEVELS[row.gt_ordinal],
    event_normalized_weight: 1 }));
  const gtSupport = support.gtLevelSupport(rows);
  const linkage = { sensitivity_id: 'synthetic_v3', tuning_schema_version: 2, tuning_policy_version: 3,
    sensitivity_manifest_sha256: '1'.repeat(64), sensitivity_descriptor_sha256: '2'.repeat(64),
    model_dataset_id: 'model_fixture', model_dataset_manifest_sha256: '3'.repeat(64),
    model_dataset_descriptor_sha256: '4'.repeat(64), source_dataset_id: 'raw_fixture', ground_truth_id: 'gt_fixture',
    evaluation_id: 'baseline_fixture', evaluation_manifest_sha256: '5'.repeat(64),
    parameter_registry_version: 1, parameter_registry_sha256: digest(registry),
    tuning_base_config_sha256: digest(config), engine_runtime_sha256: '6'.repeat(64),
    engineering_readiness: { status: 'READY', reasons: [] }, data_readiness: { status: 'READY', reasons: [] },
    metric_readiness: { status: 'PROVISIONAL_PROXY', reasons: ['PROXY_MAPPING_NOT_VALIDATED'] },
    result_usage: 'EXPLORATORY_ONLY', mapping_status: 'PROVISIONAL', interpretation_scope: 'PROXY_ORDINAL_ONLY',
    no_skill_reference_ordinal: 2, validation_disclosure_status: 'DEVELOPMENT_EXPOSED',
    validation_disclosure_evidence_id: null, validation_disclosure_evidence_sha256: null,
    validation_access_ledger_sha256: null,
    upstream_train_support: { sensitivity_id: 'synthetic_v3', gt_level_support: gtSupport,
      gt_level_support_sha256: support.supportDigest(gtSupport), limitation_codes: gtSupport.limitation_codes,
      conclusion_limitations: gtSupport.conclusion_limitations } };
  const input = { upstream: { status: 'PASS', validation_scope: 'SOURCE_LINKED' }, sourceFingerprints: {},
    model: { manifest: { model_dataset_id: linkage.model_dataset_id, source_dataset_id: linkage.source_dataset_id,
      ground_truth_id: linkage.ground_truth_id }, manifestSha256: linkage.model_dataset_manifest_sha256,
      schemaVersion: 2, policyVersion: 3, rows, fingerprints: {} },
    evaluation: { evaluation_id: linkage.evaluation_id, evaluation_manifest_sha256: linkage.evaluation_manifest_sha256,
      evaluation_schema_version: 2, evaluation_policy_version: 2, evaluation_validation_scope: 'MODEL_LINKED' },
    sensitivity: { linkage, registry, baseConfig: { config, sha256: linkage.tuning_base_config_sha256 },
      runtime: {}, readiness: { metrics: { replay_usable_rate: 1 }, parameter_readiness: [{
        parameter_id: 'high_cloud_center', observability_status: 'OBSERVABLE', parameter_readiness: 'READY',
        support_samples: 100, support_events: 100, support_dates: 14, metric_usage: 'PROXY_EXPLORATORY'
      }] }, fingerprints: {} },
    runtime: {}, cohort: rows, summary: { sample_count: 100, event_count: 100, date_count: 14 } };
  const scores = [10, 30, 50, 70, 95];
  const runReplay = async (replay, { modelConfig }) => ({ actual: {
    score: scores[modelConfig.scoring.a === 10 ? Math.min(4, replay.ordinal + 1) : replay.ordinal],
    gw_factor: 1, sky_evolution_factor: 1 } });
  const built = await buildOptimizationPackage({ input, runReplay, optimizationPolicyVersion: 2 });
  const duplicate = await buildOptimizationPackage({ input, runReplay, optimizationPolicyVersion: 2 });
  assert.deepEqual(built.files, duplicate.files);
  assert.equal(built.manifest.data_readiness.status, 'READY');
  assert.equal(built.manifest.optimization_mode, 'EXPLORATORY_SEARCH');
  assert.equal(built.manifest.candidate_freeze_allowed, false);
  assert.equal(built.files['candidate_freeze.json'], undefined);
  assert.equal(built.manifest.gt_level_support.by_level[4].event_count, 1);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'optimization-soft-support-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  async function write(files, manifest) {
    for (const [name, value] of Object.entries({ ...files, 'manifest.json': common.canonicalJson(manifest) })) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), value);
    }
  }
  await write(built.files, built.manifest);
  assert.equal((await inspectOptimization(dir, { staging: true })).status, 'PASS');
  // Rehash every outer identity after forging the frozen support; semantic audit still rejects it.
  const files = { ...built.files };
  const doc = JSON.parse(files['gt_level_support.json']);
  doc.gt_level_support.by_level[4].event_count = 5;
  files['gt_level_support.json'] = common.canonicalJson(doc);
  const metadata = filesMetadata(files, optimizationPolicy(2).package.export_files);
  const descriptor = structuredClone(built.manifest.descriptor);
  descriptor.file_sha256['gt_level_support.json'] = metadata['gt_level_support.json'].sha256;
  const derived = identity(descriptor);
  const summary = JSON.parse(files['reports/summary.json']); summary.optimization_id = derived.optimization_id;
  files['reports/summary.json'] = common.canonicalJson(summary);
  const manifest = { ...built.manifest, descriptor, ...derived,
    files: filesMetadata(files, optimizationPolicy(2).package.export_files) };
  await write(files, manifest);
  await assert.rejects(() => inspectOptimization(dir, { staging: true }),
    error => error.reason_code === 'GT_LEVEL_SUPPORT_MISMATCH');
  await assert.rejects(() => buildOptimizationPackage({ input, runReplay }),
    error => error.reason_code === 'TUNING_OPTIMIZATION_POLICY_COMBINATION_UNSUPPORTED');
});
