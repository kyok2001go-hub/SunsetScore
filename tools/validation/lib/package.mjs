import path from 'node:path';
import { mkdir, readFile, rename, writeFile, lstat } from 'node:fs/promises';
import { canonicalJson, compare, fail, hash, inventory, readSafe, removeOwned, runId, safePath, unique } from '../../dataset/lib/common.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
import { formatMetric, scoreToOrdinal } from '../../evaluation/metrics.mjs';
import { pairMetrics, dateRobustness, sliceAnalysis, noSkillMae } from '../../optimization/lib/metrics.mjs';
import { CSV_TABLES, SELECTED_FILES, validationSchema, validationResultFiles } from '../validation-schema.mjs';
import { validationPolicy, auditSupportPlan } from '../validation-policy.mjs';
import { SUPPORT_FILE, inspectSupportDocument, supportDocument } from '../../gt-level-support.mjs';
import { planIdentity, planManifest } from '../plan-validation.mjs';
import { dateBlockBootstrap } from './stability.mjs';
import { classifyCandidate, rankEligible, selectOutcome } from './selection.mjs';
import { closestPreSunset } from './benchmark.mjs';
import { withOptimizationLock } from '../../optimization/lib/publish.mjs';

function assert(condition, reason) {
  if (!condition) fail('VALIDATION_VALIDATION_FAILED', { reason_code: reason });
}

export function packageManifest(files, planId, { legacy = false } = {}) {
  const plan = JSON.parse(files['validation_plan.json']);
  const core = plan.plan_core;
  const policyVersion = core.validation_policy_version ?? 1;
  const baseFiles = validationResultFiles(policyVersion);
  const selection = JSON.parse(files['selection_result.json']);
  const fixture = selection.result_usage === 'TEST_FIXTURE_ONLY';
  const selected = fixture && selection.outcome === 'SELECTED';
  const names = selected ? [...baseFiles, ...SELECTED_FILES] : baseFiles;
  const contents = Object.fromEntries(names.map(name => {
    assert(typeof files[name] === 'string', 'RESULT_FILE_MISSING');
    return [name, { sha256: hash(files[name]), bytes: Buffer.byteLength(files[name]) }];
  }));
  const resultFiles = baseFiles.filter(name => name !== 'reports/summary.json');
  const evaluationResultsSha256 = hash(canonicalJson(resultFiles.map(name => [name, contents[name].sha256])));
  const summaryTemplateSha256 = contents['reports/summary.json'].sha256;
  const coverageByCandidate = readCsv(CSV_TABLES['candidate_validation_metrics.csv'],
    files['candidate_validation_metrics.csv']).map(row => ({
    candidate_id: row.candidate_id,
    control_source_coverage_rate: row.control_source_coverage_rate,
    candidate_control_coverage_rate: row.candidate_control_coverage_rate
  }));
  const supportFields = policyVersion === 2 ? { gt_level_support: core.gt_level_support,
    gt_level_support_sha256: core.gt_level_support_sha256, upstream_train_support: core.upstream_train_support } : {};
  const descriptor = { validation_schema_version: 1, validation_policy_version: policyVersion,
    ...supportFields,
    ...(legacy ? {} : { manifest_contract_revision: 2 }),
    validation_plan_id: planId, validation_plan_sha256: hash(files['validation_plan.json']),
    evaluation_results_sha256: evaluationResultsSha256,
    summary_template_sha256: summaryTemplateSha256,
    result_usage: selection.result_usage,
    ...(legacy ? {} : { coverage_by_candidate: coverageByCandidate }),
    files: contents };
  const digest = hash(canonicalJson(descriptor));
  return { validation_schema_version: 1, validation_policy_version: policyVersion,
    ...supportFields,
    validation_id: `validation_v1_${digest.slice(0, 16)}`,
    descriptor, descriptor_sha256: digest, files: contents,
    validation_plan_id: planId, validation_plan_sha256: hash(files['validation_plan.json']),
    validation_mode: core.mode, validation_outcome: selection.outcome,
    ...(legacy ? {} : { result_usage: selection.result_usage }),
    ...(legacy ? {} : { coverage_by_candidate: coverageByCandidate }),
    ...(fixture ? { test_fixture_only: true } : {}),
    source_ids: core.source, optimization_input_id: core.optimization_input_id ?? null,
    candidate_set_id: core.candidate_set_id ?? null,
    engine_runtime_sha256: core.engine_runtime_sha256 ?? null,
    tuning_base_config_sha256: core.tuning_base_config_sha256 ?? null,
    parameter_registry_sha256: core.parameter_registry_sha256 ?? null,
    mapping_status: core.mapping_status ?? null,
    evidence_id: core.evidence_id ?? null, evidence_sha256: core.evidence_sha256 ?? null,
    ledger_prefix_sequence: core.ledger_prefix_sequence ?? null,
    ledger_prefix_sha256: core.ledger_prefix_sha256 ?? null,
    source_validation_selection_rule_sha256: core.source_validation_selection_rule_sha256 ?? null,
    effective_selection_policy_sha256: core.effective_selection_policy_sha256 ?? null,
    evaluation_results_sha256: evaluationResultsSha256,
    selection_evidence_sha256: evaluationResultsSha256,
    formal_promotion_allowed: false,
    evaluated_splits: ['VALIDATION'], test_evaluated: false,
    test_evaluation_sample_count: 0 };
}

export async function readPlan(directory) {
  const manifestBytes = await readSafe(path.join(directory, 'plan_manifest.json'));
  const planBytes = await readSafe(path.join(directory, 'validation_plan.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const plan = JSON.parse(planBytes.toString('utf8'));
  auditSupportPlan(plan.plan_core);
  const id = planIdentity(plan.plan_core);
  assert(canonicalJson(manifest) === manifestBytes.toString('utf8') &&
    canonicalJson(plan) === planBytes.toString('utf8'), 'PLAN_NOT_CANONICAL');
  assert(id.planId === manifest.validation_plan_id &&
    id.planSha256 === manifest.validation_plan_sha256 &&
    canonicalJson(id.payload) === canonicalJson(plan), 'PLAN_IDENTITY_MISMATCH');
  assert(canonicalJson(manifest) === canonicalJson(planManifest(id, manifest.evidence_manifest_sha256)),
    'PLAN_MANIFEST_MISMATCH');
  assert(canonicalJson((await inventory(directory)).sort(compare)) ===
    canonicalJson(['plan_manifest.json', 'validation_plan.json']), 'PLAN_INVENTORY_MISMATCH');
  return { ...plan, plan_id: id.planId };
}

export async function inspectPlan(directory) {
  const plan = await readPlan(directory);
  return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL', plan_id: plan.plan_id };
}

export async function inspectValidation(directory) {
  const manifestBytes = await readSafe(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const policyVersion = manifest.validation_policy_version;
  validationPolicy(policyVersion);
  assert(canonicalJson(manifest) === manifestBytes.toString('utf8'), 'MANIFEST_NOT_CANONICAL');
  const preliminarySelection = JSON.parse((await readSafe(path.join(directory,
    'selection_result.json'))).toString('utf8'));
  const includeSelected = preliminarySelection.result_usage === 'TEST_FIXTURE_ONLY' &&
    preliminarySelection.outcome === 'SELECTED';
  const baseFiles = validationResultFiles(policyVersion);
  const resultFiles = includeSelected ? [...baseFiles, ...SELECTED_FILES] : baseFiles;
  assert(canonicalJson((await inventory(directory)).sort(compare)) ===
    canonicalJson([...resultFiles, 'manifest.json'].sort(compare)), 'INVENTORY_MISMATCH');
  const files = {};
  for (const name of resultFiles) {
    const bytes = await readSafe(path.join(directory, name));
    assert(hash(bytes) === manifest.files?.[name]?.sha256 &&
      bytes.length === manifest.files?.[name]?.bytes, 'FILE_HASH_MISMATCH');
    files[name] = bytes.toString('utf8');
    if (name.endsWith('.csv')) readCsv(CSV_TABLES[name], bytes);
    else {
      const value = JSON.parse(files[name]);
      assert(canonicalJson(value) === files[name], 'JSON_NOT_CANONICAL');
    }
  }
  const plan = JSON.parse(files['validation_plan.json']);
  assert((plan.plan_core.validation_policy_version ?? 1) === policyVersion, 'PLAN_RESULT_POLICY_MISMATCH');
  auditSupportPlan(plan.plan_core);
  const identity = planIdentity(plan.plan_core);
  assert(canonicalJson(identity.payload) === canonicalJson(plan), 'PLAN_IDENTITY_MISMATCH');
  assert(canonicalJson(JSON.parse(files['schema.json'])) ===
      canonicalJson(validationSchema({ includeSelected, policyVersion })) &&
    canonicalJson(JSON.parse(files['policy.json'])) === canonicalJson(validationPolicy(policyVersion)),
  'SCHEMA_POLICY_MISMATCH');
  const legacy = manifest.descriptor?.manifest_contract_revision == null;
  assert(!legacy || manifest.validation_mode === 'DEVELOPMENT_VALIDATION',
    'LEGACY_FORMAL_PACKAGE_FORBIDDEN');
  const expected = packageManifest(files, identity.planId, { legacy });
  assert(canonicalJson(expected) === canonicalJson(manifest), 'MANIFEST_IDENTITY_MISMATCH');
  const selection = JSON.parse(files['selection_result.json']);
  const summary = JSON.parse(files['reports/summary.json']);
  if (policyVersion === 2) {
    const doc = JSON.parse(files[SUPPORT_FILE]);
    const support = inspectSupportDocument(doc, 'VALIDATION', 'VALIDATION_VALIDATION_FAILED',
      plan.plan_core.gt_level_support_cohort);
    for (const value of [selection, summary]) {
      assert(canonicalJson(value.gt_level_support) === canonicalJson(support) &&
        value.gt_level_support_sha256 === doc.gt_level_support_sha256 &&
        canonicalJson(value.upstream_train_support) === canonicalJson(plan.plan_core.upstream_train_support),
      'RESULT_SUPPORT_MISMATCH');
    }
    const samples = readCsv(CSV_TABLES['candidate_sample_predictions.csv'], files['candidate_sample_predictions.csv']);
    const failures = readCsv(CSV_TABLES['replay_failures.csv'], files['replay_failures.csv']);
    const rebuilt = supportDocument(doc.cohort, 'VALIDATION', plan.plan_core.candidates.map(item => ({
      id: item.candidate_id, rows: samples.filter(row => row.candidate_id === item.candidate_id)
        .map(row => ({ ...row, experiment_ordinal: row.candidate_ordinal })),
      failures: failures.filter(row => row.candidate_id === null || row.candidate_id === item.candidate_id)
    })));
    assert(canonicalJson(rebuilt) === canonicalJson(doc) &&
      canonicalJson(summary.rare_level_audit) === canonicalJson(doc.rare_level_audit), 'RARE_AUDIT_MISMATCH');
    const members = new Map(doc.cohort.map(row => [row.snapshot_id, row]));
    assert(samples.every(row => ['event_id', 'location_key', 'event_date_local', 'gt_ordinal', 'gt_confidence']
      .every(key => members.get(row.snapshot_id)?.[key] === row[key])), 'SUPPORT_SAMPLE_GT_MISMATCH');
    const warnings = readCsv(CSV_TABLES['reports/warnings.csv'], files['reports/warnings.csv']);
    assert(support.warnings.every(code => warnings.some(row => row.warning_code === code && row.candidate_id === null)),
      'RARE_WARNING_MISSING');
  }
  assert(canonicalJson(JSON.parse(files['verified_source_identities.json'])) ===
    canonicalJson(plan.plan_core.source), 'SOURCE_IDENTITY_MISMATCH');
  const fixtureFormal = plan.plan_core.mode === 'FORMAL_VALIDATION' &&
    plan.plan_core.status === 'READY_FORMAL' && plan.plan_core.fixture_only === true &&
    selection.result_usage === 'TEST_FIXTURE_ONLY' && selection.test_fixture_only === true;
  const development = plan.plan_core.mode === 'DEVELOPMENT_VALIDATION' &&
    plan.plan_core.status === 'READY_DEVELOPMENT' &&
    selection.result_usage === 'DEVELOPMENT_ONLY' && selection.test_fixture_only !== true;
  assert(selection.formal_promotion_allowed === false &&
    (fixtureFormal || (selection.selected_candidate_id === null && selection.outcome === 'DEVELOPMENT_ONLY')) &&
    manifest.test_evaluated === false && canonicalJson(manifest.evaluated_splits) === canonicalJson(['VALIDATION']),
  'DEVELOPMENT_PROMOTION_FORBIDDEN');
  assert((development || fixtureFormal) && summary.mode === plan.plan_core.mode &&
    summary.status === selection.result_usage &&
    summary.plan_id === identity.planId && summary.selection_outcome === selection.outcome &&
    summary.candidate_count === plan.plan_core.candidates.length &&
    summary.selected_candidate_id === selection.selected_candidate_id && summary.test_evaluated === false &&
    canonicalJson(summary.evaluated_splits) === canonicalJson(['VALIDATION']),
  'SUMMARY_MISMATCH');
  auditDerivedTables(files, plan, selection);
  if (fixtureFormal) auditFixtureSelection(files, manifest, selection);
  return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL', validation_id: manifest.validation_id,
    plan_id: identity.planId, result_usage: manifest.result_usage,
    candidate_count: selection.candidates.length, manifest, files };
}

function auditDerivedTables(files, plan, selection) {
  const table = name => readCsv(CSV_TABLES[name], files[name]);
  const samples = table('candidate_sample_predictions.csv');
  const metrics = table('candidate_validation_metrics.csv');
  const guardrails = table('candidate_guardrails.csv');
  const slices = table('candidate_slice_metrics.csv');
  const dates = table('candidate_date_stability.csv');
  const bootstraps = table('candidate_bootstrap.csv');
  const alignments = table('control_alignment.csv');
  const failures = table('replay_failures.csv');
  const parity = table('replay_reference_parity.csv');
  const comparison = table('candidate_comparison.csv');
  const policy = validationPolicy(plan.plan_core.validation_policy_version ?? 1);
  const expectedIds = plan.plan_core.candidates.map(item => item.candidate_id);
  const membersById = new Map(plan.plan_core.validation_members.map(row => [row.snapshot_id, row]));
  assert(membersById.size === plan.plan_core.validation_members.length &&
    samples.every(row => membersById.get(row.snapshot_id)?.event_id === row.event_id &&
      membersById.get(row.snapshot_id)?.event_date_local === row.event_date_local &&
      membersById.get(row.snapshot_id)?.location_key === row.location_key) &&
    new Set(samples.map(row => `${row.candidate_id}|${row.snapshot_id}`)).size === samples.length &&
    alignments.every(row => membersById.get(row.snapshot_id)?.event_id === row.event_id) &&
    parity.every(row => membersById.get(row.snapshot_id)?.event_id === row.event_id) &&
    new Set(alignments.map(row => row.snapshot_id)).size === alignments.length &&
    new Set(parity.map(row => row.snapshot_id)).size === parity.length,
  'VALIDATION_MEMBERSHIP_MISMATCH');
  assert(samples.every(row => row.gt_ordinal >= 0 && row.gt_ordinal <= 4 &&
    row.gt_confidence > 0 && row.gt_confidence <= 1 && row.event_normalized_weight > 0 &&
    row.control_score >= 0 && row.control_score <= 100 &&
    row.candidate_score >= 0 && row.candidate_score <= 100 &&
    scoreToOrdinal(row.control_score) === row.control_ordinal &&
    scoreToOrdinal(row.candidate_score) === row.candidate_ordinal),
  'SAMPLE_VALUE_INVALID');
  assert(canonicalJson(metrics.map(row => row.candidate_id)) === canonicalJson(expectedIds) &&
    canonicalJson(guardrails.map(row => row.candidate_id)) === canonicalJson(expectedIds) &&
    canonicalJson(bootstraps.map(row => row.candidate_id)) === canonicalJson(expectedIds) &&
    canonicalJson(selection.candidates.map(row => row.candidate_id)) === canonicalJson(expectedIds),
  'CANDIDATE_MEMBERSHIP_MISMATCH');
  assert(parity.length === plan.plan_core.validation_members.length &&
    parity.every(row => row.split === 'VALIDATION') &&
    selection.reference_parity.fail_count === parity.filter(row => !row.pass).length,
  'REFERENCE_PARITY_MISMATCH');
  const controlCount = alignments.length;
  const cohortCount = plan.plan_core.validation_members.length;
  assert(failures.filter(row => row.phase === 'CONTROL').length === cohortCount - controlCount &&
    selection.control_failure_count === cohortCount - controlCount &&
    canonicalJson(parity.map(row => row.snapshot_id).sort(compare)) ===
      canonicalJson([...membersById.keys()].sort(compare)),
  'CONTROL_REFERENCE_COVERAGE_MISMATCH');
  const partialCoverage = expectedIds.some(id => samples.filter(row => row.candidate_id === id).length !== cohortCount);
  const commonIds = partialCoverage ? expectedIds.reduce((set, id) => {
    const ids = new Set(samples.filter(row => row.candidate_id === id).map(row => row.snapshot_id));
    return new Set([...set].filter(snapshotId => ids.has(snapshotId)));
  }, new Set(plan.plan_core.validation_members.map(row => row.snapshot_id))) : null;
  for (const [index, id] of expectedIds.entries()) {
    const predictions = samples.filter(row => row.candidate_id === id);
    const source = predictions.map(row => ({ ...row, experiment_score: row.candidate_score,
      experiment_ordinal: row.candidate_ordinal }));
    const metric = metrics[index], bootstrap = bootstraps[index];
    assert(metric.sample_count === source.length && metric.event_count === unique(source.map(row => row.event_id)).length &&
      metric.cohort_sample_count === cohortCount && metric.control_success_count === controlCount &&
      metric.candidate_success_count === source.length &&
      metric.control_source_coverage_rate === (cohortCount ? formatMetric(controlCount / cohortCount) : null) &&
      metric.candidate_control_coverage_rate === (controlCount ? formatMetric(source.length / controlCount) : null) &&
      failures.filter(row => row.candidate_id === id).length === controlCount - source.length,
    'COVERAGE_MISMATCH');
    const pair = source.length ? pairMetrics(source) : { control: {}, candidate: {}, deltas: {} };
    const closest = closestPreSunset(source);
    const closestPair = closest.length ? pairMetrics(closest) : { control: {}, candidate: {}, deltas: {} };
    const skill = noSkillMae(source, plan.plan_core.no_skill_reference_ordinal);
    for (const [field, value] of [
      ['control_mae', pair.control.mae ?? null], ['candidate_mae', pair.candidate.mae ?? null],
      ['delta_mae', pair.deltas.delta_mae ?? null], ['no_skill_mae', skill],
      ['severe_error_rate', pair.candidate.severe_error_rate ?? null],
      ['within_1_accuracy', pair.candidate.within_1_accuracy ?? null],
      ['abs_bias', pair.candidate.bias == null ? null : Math.abs(pair.candidate.bias)],
      ['qwk', pair.candidate.qwk ?? null],
      ['closest_sample_count', closest.length],
      ['closest_event_count', unique(closest.map(row => row.event_id)).length],
      ['closest_control_mae', closestPair.control.mae ?? null],
      ['closest_candidate_mae', closestPair.candidate.mae ?? null],
      ['closest_delta_mae', closestPair.deltas.delta_mae ?? null]
    ]) assert(metric[field] === value, 'DERIVED_METRIC_MISMATCH');
    const calculatedSlices = source.length ? sliceAnalysis(source, policy.numeric.epsilon, {
      min_event_count: policy.support.slice_min_events, min_date_count: policy.support.slice_min_dates
    }) : [];
    const expectedSlices = calculatedSlices.map(row => ({
      candidate_id: id, slice_dimension: row.slice_dimension, slice_value: row.slice_value,
      slice_value_is_null: row.slice_value_is_null, sample_count: row.sample_count,
      event_count: row.event_count, date_count: row.date_count, supported: row.supported,
      delta_mae: row.delta_mae, delta_severe_error_rate: row.delta_severe_error_rate,
      regression: row.regression
    }));
    assert(canonicalJson(slices.filter(row => row.candidate_id === id)) === canonicalJson(expectedSlices),
      'DERIVED_SLICE_MISMATCH');
    const dateStats = source.length ? dateRobustness(source, policy.numeric.epsilon) : { per_date: [], lodo: [] };
    const expectedDates = [];
    for (const [scope, set] of [['PER_DATE', dateStats.per_date], ['LODO', dateStats.lodo]]) {
      expectedDates.push(...set.map(row => ({ candidate_id: id, scope,
        event_date_local: row.event_date_local, sample_count: row.sample_count,
        event_count: row.event_count, control_mae: row.control_mae,
        candidate_mae: row.candidate_mae, delta_mae: row.delta_mae,
        direction: row.direction })));
    }
    assert(canonicalJson(dates.filter(row => row.candidate_id === id)) === canonicalJson(expectedDates),
      'DERIVED_DATE_MISMATCH');
    const bootstrapSource = commonIds ? source.filter(row => commonIds.has(row.snapshot_id)) : source;
    const calculatedBootstrap = bootstrapSource.length ? dateBlockBootstrap(bootstrapSource, plan.bootstrap_seed) : {
      status: 'NO_PAIRED_ROWS', date_count: 0
    };
    assert(bootstrap.status === calculatedBootstrap.status &&
      bootstrap.date_count === calculatedBootstrap.date_count &&
      bootstrap.cohort_sha256 === (calculatedBootstrap.cohort_sha256 ?? null) &&
      bootstrap.ci_lower === (calculatedBootstrap.ci_lower ?? null) &&
      bootstrap.ci_upper === (calculatedBootstrap.ci_upper ?? null) &&
      bootstrap.point_delta_mae === (calculatedBootstrap.point_delta_mae ?? null) &&
      bootstrap.replicate_count === (calculatedBootstrap.replicate_count ?? null) &&
      bootstrap.algorithm === (calculatedBootstrap.algorithm ?? null) &&
      bootstrap.seed === plan.bootstrap_seed,
    'DERIVED_BOOTSTRAP_MISMATCH');
    const classified = classifyCandidate({
      coverage: { cohort_sample_count: cohortCount, control_success_count: controlCount,
        candidate_success_count: source.length }, control: pair.control,
      candidate: pair.candidate, noSkill: skill, slices: calculatedSlices,
      bootstrap: calculatedBootstrap
    });
    assert(guardrails[index].classification === classified.status &&
      selection.candidates[index].classification === classified.status,
    'DERIVED_GUARDRAIL_MISMATCH');
    const selectedRecord = selection.candidates[index];
    const frozenCandidate = plan.plan_core.candidates[index];
    assert(selectedRecord.mae === (pair.candidate.mae ?? null) &&
      selectedRecord.severe_error_rate === (pair.candidate.severe_error_rate ?? null) &&
      selectedRecord.within_1_accuracy === (pair.candidate.within_1_accuracy ?? null) &&
      selectedRecord.abs_bias === (pair.candidate.bias == null ? null : Math.abs(pair.candidate.bias)) &&
      selectedRecord.qwk === (pair.candidate.qwk ?? null) &&
      selectedRecord.changed_unit_count === frozenCandidate.changed_unit_count &&
      selectedRecord.normalized_parameter_distance === frozenCandidate.normalized_parameter_distance,
    'SELECTION_METRIC_MISMATCH');
  }
  const eligible = rankEligible(selection.candidates.filter(row => row.classification === 'ELIGIBLE'));
  const ranked = [...eligible, ...selection.candidates.filter(row => row.classification !== 'ELIGIBLE')
    .sort((a, b) => compare(a.candidate_id, b.candidate_id))];
  const eligibleRanks = new Map(eligible.map((row, index) => [row.candidate_id, index + 1]));
  const expectedComparison = ranked.map(row => ({
    candidate_id: row.candidate_id, classification: row.classification,
    rank: eligibleRanks.get(row.candidate_id) ?? null,
    mae: row.mae, severe_error_rate: row.severe_error_rate,
    within_1_accuracy: row.within_1_accuracy, abs_bias: row.abs_bias,
    qwk: row.qwk, changed_unit_count: row.changed_unit_count,
    normalized_parameter_distance: row.normalized_parameter_distance
  }));
  assert(canonicalJson(comparison) === canonicalJson(expectedComparison),
    'CANDIDATE_RANKING_MISMATCH');
  const expectedOutcome = selectOutcome(selection.candidates, plan.plan_core.mode);
  assert(selection.outcome === expectedOutcome.outcome &&
    selection.selected_candidate_id === expectedOutcome.selected_candidate_id,
  'SELECTION_OUTCOME_MISMATCH');
}

function auditFixtureSelection(files, manifest, selection) {
  assert(manifest.test_fixture_only === true && manifest.result_usage === 'TEST_FIXTURE_ONLY' &&
    manifest.formal_promotion_allowed === false &&
    manifest.descriptor.manifest_contract_revision === 2,
  'FIXTURE_IDENTITY_MISMATCH');
  if (selection.outcome !== 'SELECTED') return;
  const selected = JSON.parse(files['selected_candidate.json']);
  const config = JSON.parse(files['selected_effective_config.json']);
  const plan = JSON.parse(files['validation_plan.json']);
  const frozen = plan.plan_core.candidates.find(item => item.candidate_id === selection.selected_candidate_id);
  assert(frozen && selected.candidate_id === frozen.candidate_id &&
    canonicalJson(selected.canonical_candidate_vector) === canonicalJson(frozen.canonical_vector) &&
    selected.effective_config_sha256 === frozen.effective_config_sha256 &&
    hash(canonicalJson(config)) === frozen.effective_config_sha256 &&
    selected.selection_evidence_sha256 === manifest.evaluation_results_sha256 &&
    selected.eligible_for_phase8 === false && selected.test_fixture_only === true,
  'FIXTURE_SELECTED_MISMATCH');
}

export async function publishValidation({ output, files, manifest, sourceCheck }) {
  const stagingRoot = await safePath(path.join(output, 'staging'));
  await mkdir(stagingRoot, { recursive: true });
  const staging = await safePath(path.join(stagingRoot, runId()));
  await mkdir(staging);
  try {
    for (const [name, contents] of Object.entries({ ...files, 'manifest.json': canonicalJson(manifest) })) {
      const target = await safePath(path.join(staging, name));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, { flag: 'wx' });
    }
    await inspectValidation(staging);
    const exportsRoot = await safePath(path.join(output, 'exports'));
    await mkdir(exportsRoot, { recursive: true });
    const target = await safePath(path.join(exportsRoot, manifest.validation_id));
    return withOptimizationLock(await safePath(target + '.lock'), async () => {
      await sourceCheck();
      let exists = false;
      try { await lstat(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (exists) {
        const old = await inspectValidation(target);
        assert(canonicalJson(old.manifest) === canonicalJson(manifest), 'VALIDATION_ID_CONFLICT');
        await removeOwned(stagingRoot, staging);
        return { status: 'DEDUPLICATED', directory: target, validation_id: manifest.validation_id };
      }
      await rename(staging, target);
      return { status: 'EXPORTED', directory: target, validation_id: manifest.validation_id };
    });
  } catch (error) {
    // Keep staging for diagnosis; do not delete an unknown or partially published package.
    throw error;
  }
}
