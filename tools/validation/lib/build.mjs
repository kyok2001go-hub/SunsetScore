import { canonicalJson, compare, fail, hash, unique } from '../../dataset/lib/common.mjs';
import { writeCsv } from '../../dataset/lib/csv.mjs';
import { pairMetrics, dateRobustness, sliceAnalysis, noSkillMae } from '../../optimization/lib/metrics.mjs';
import { prepareCandidateRun, evaluateCandidateDetailed } from '../../tuning/lib/candidate.mjs';
import { verifyReplayParity } from '../../tuning/lib/replay-cohort.mjs';
import { runReplay as defaultRunReplay } from '../../replay/replay-runner.mjs';
import { CSV_TABLES, validationSchema, validationResultFiles } from '../validation-schema.mjs';
import { validationPolicy, validationSupport, auditSupportPlan } from '../validation-policy.mjs';
import { SUPPORT_FILE, supportDocument, supportCohort } from '../../gt-level-support.mjs';
import { dateBlockBootstrap } from './stability.mjs';
import { classifyCandidate, rankEligible, selectOutcome } from './selection.mjs';
import { planIdentity } from '../plan-validation.mjs';
import { closestPreSunset } from './benchmark.mjs';

const sortById = (a, b) => compare(a.snapshot_id, b.snapshot_id);
const countEvents = rows => unique(rows.map(row => row.event_id)).length;
const TRANSIENT_REPLAY_CODES = new Set([
  'ETIMEDOUT', 'ETIMEOUT', 'EAI_AGAIN', 'ENOMEM', 'ENOSPC', 'ERR_WORKER_OUT_OF_MEMORY'
]);

function scoreGuard(runReplay) {
  return async (...args) => {
    let report;
    try { report = await runReplay(...args); }
    catch (error) {
      if (TRANSIENT_REPLAY_CODES.has(error?.code)) {
        fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'REPLAY_TRANSIENT_FAILURE' });
      }
      throw error;
    }
    if (!Number.isInteger(report?.actual?.score) || report.actual.score < 0 || report.actual.score > 100) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'REPLAY_SCORE_INVALID' });
    }
    return report;
  };
}

function bootstrapRow(candidateId, result, seed) {
  return { candidate_id: candidateId, benchmark: 'ALL_PRIMARY',
    cohort_sha256: result.cohort_sha256 ?? null, date_count: result.date_count,
    replicate_count: result.replicate_count ?? null, seed,
    algorithm: result.algorithm ?? null, point_delta_mae: result.point_delta_mae ?? null,
    ci_lower: result.ci_lower ?? null, ci_upper: result.ci_upper ?? null,
    status: result.status, reason_code: result.status === 'COMPUTED' ? null : result.status };
}

export async function buildValidationResult({ plan, input, audited, runReplay = defaultRunReplay,
  progress, testFixtureFormal = false }) {
  const core = plan.plan_core;
  auditSupportPlan(core);
  const policyVersion = core.validation_policy_version ?? 1;
  if (policyVersion === 4 && (testFixtureFormal || core.fixture_only || core.mode !== 'DEVELOPMENT_VALIDATION' || core.result_usage !== 'DEVELOPMENT_ONLY')) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'POLICY_4_DEVELOPMENT_ONLY' });
  }
  const planIdentityResult = planIdentity(core);
  if (canonicalJson(planIdentityResult.payload) !== canonicalJson({
    plan_core: plan.plan_core, plan_core_sha256: plan.plan_core_sha256,
    bootstrap_seed: plan.bootstrap_seed
  })) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'PLAN_IDENTITY_MISMATCH' });
  const fixtureFormal = testFixtureFormal === true && core.fixture_only === true &&
    core.mode === 'FORMAL_VALIDATION' && core.status === 'READY_FORMAL';
  const formal = policyVersion === 3 && core.mode === 'FORMAL_VALIDATION' && core.status === 'READY_FORMAL';
  if (!formal && !fixtureFormal && (core.mode !== 'DEVELOPMENT_VALIDATION' ||
      core.status !== 'READY_DEVELOPMENT' || testFixtureFormal)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'PLAN_NOT_RUNNABLE' });
  }
  const policy = validationPolicy(policyVersion);
  const replay = scoreGuard(runReplay);
  const cohort = input.cohort;
  if (policyVersion >= 2 && (canonicalJson(supportCohort(cohort)) !== canonicalJson(core.gt_level_support_cohort) ||
      canonicalJson(validationSupport(cohort, policyVersion)) !== canonicalJson(core.support) ||
      (audited && canonicalJson(audited.manifest.upstream_train_support) !== canonicalJson(core.upstream_train_support)))) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'FROZEN_SUPPORT_CHANGED' });
  }
  if ((formal || fixtureFormal) && validationSupport(cohort, policyVersion).status !== 'READY') {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'VALIDATION_SUPPORT_INSUFFICIENT' });
  }
  const parity = await verifyReplayParity({ cohort, runReplay: replay, progress, split: 'VALIDATION' });
  if ((formal || fixtureFormal) && parity.summary.fail_count) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'REPLAY_REFERENCE_PARITY_FAILED' });
  }
  const parityRows = parity.rows.map(row => ({
    snapshot_id: row.snapshot_id, event_id: row.event_id, split: 'VALIDATION',
    engine_build_sha: row.engine_build_sha, pass: row.pass,
    actual_score: row.actual_score, reference_score: row.reference_score,
    score_delta: row.score_delta, issue_codes: row.issue_codes
  }));
  const units = Object.values(input.searchSpace.registry_units);
  const prepared = await prepareCandidateRun({
    cohort, config: input.sensitivity.baseConfig.config, units, runReplay: replay, progress
  });
  const tables = Object.fromEntries(Object.keys(CSV_TABLES).map(name => [name, []]));
  tables['replay_reference_parity.csv'] = parityRows;
  tables['control_alignment.csv'] = prepared.control.map(row => ({
    snapshot_id: row.snapshot_id, event_id: cohort[row.index].event_id,
    historical_score: cohort[row.index].predicted_score,
    control_score: row.control_score, score_delta: row.control_score - cohort[row.index].predicted_score,
    status: row.control_score === cohort[row.index].predicted_score ? 'MATCH' : 'DRIFT'
  }));
  tables['replay_failures.csv'].push(...prepared.controlFailures.map(row => ({
    candidate_id: null, snapshot_id: row.snapshot_id, event_id: row.event_id,
    phase: 'CONTROL', error_code: row.error_code
  })));
  const records = [];
  const detailed = [];
  for (const item of input.candidates) {
    detailed.push(await evaluateCandidateDetailed({ prepared, vector: item.canonical_vector }));
    progress?.update(`VALIDATION Replay ${detailed.length}/${input.candidates.length}`);
  }
  const partialCoverage = detailed.some(result =>
    result.coverage.candidate_success_count !== cohort.length);
  const commonIds = partialCoverage ? detailed.reduce((set, result) => {
    const ids = new Set(result.rows.map(row => row.snapshot_id));
    return new Set([...set].filter(id => ids.has(id)));
  }, new Set(cohort.map(row => row.snapshot_id))) : null;
  for (let index = 0; index < input.candidates.length; index++) {
    const item = input.candidates[index];
    const id = item.candidate_id;
    const detail = detailed[index];
    if (hash(canonicalJson(detail.config)) !== item.effective_config_sha256) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'CANDIDATE_CONFIG_DRIFT' });
    }
    tables['replay_failures.csv'].push(...detail.experimentFailures.map(row => ({ ...row, candidate_id: id })));
    const rows = [...detail.rows].sort(sortById);
    const pair = rows.length ? pairMetrics(rows) : { control: {}, candidate: {}, deltas: {} };
    const closest = closestPreSunset(rows);
    const closestPair = closest.length ? pairMetrics(closest) : { control: {}, candidate: {}, deltas: {} };
    const dates = rows.length ? dateRobustness(rows, policy.numeric.epsilon) : { per_date: [], lodo: [] };
    const slices = rows.length ? sliceAnalysis(rows, policy.numeric.epsilon, {
      min_event_count: policy.support.slice_min_events, min_date_count: policy.support.slice_min_dates
    }) : [];
    const bootstrapRows = commonIds ? rows.filter(row => commonIds.has(row.snapshot_id)) : rows;
    const bootstrap = bootstrapRows.length ? dateBlockBootstrap(bootstrapRows, plan.bootstrap_seed) : {
      status: 'NO_PAIRED_ROWS', date_count: 0
    };
    const skill = noSkillMae(rows, core.no_skill_reference_ordinal);
    const classification = classifyCandidate({ coverage: detail.coverage,
      control: pair.control, candidate: pair.candidate, noSkill: skill, slices, bootstrap });
    if (detail.status !== 'EVALUABLE') classification.reason_codes.unshift(detail.reason_code || detail.status);
    const record = {
      candidate_id: id, classification: classification.status,
      reason_codes: [...new Set(classification.reason_codes)],
      mae: pair.candidate.mae ?? null, severe_error_rate: pair.candidate.severe_error_rate ?? null,
      within_1_accuracy: pair.candidate.within_1_accuracy ?? null,
      abs_bias: pair.candidate.bias == null ? null : Math.abs(pair.candidate.bias),
      qwk: pair.candidate.qwk ?? null,
      changed_unit_count: item.resolved.changed_unit_count,
      normalized_parameter_distance: item.resolved.normalized_parameter_distance
    };
    records.push(record);
    tables['candidate_sample_predictions.csv'].push(...rows.map(row => ({
      candidate_id: id, snapshot_id: row.snapshot_id, event_id: row.event_id,
      event_date_local: row.event_date_local, location_key: row.location_key,
      lead_time_bucket: row.lead_time_bucket, lead_time_minutes: row.lead_time_minutes,
      prediction_time_epoch: row.prediction_time_epoch, city: row.city, gt_label: row.gt_label,
      gt_status: row.gt_status, gt_basis: row.gt_basis, regime_label: row.regime_label,
      sky_evolution_state: row.sky_evolution_state, scheduled_slot: row.scheduled_slot,
      snapshot_source: row.snapshot_source, tile_radar_available: row.tile_radar_available,
      tile_sat_available: row.tile_sat_available,
      gt_ordinal: row.gt_ordinal, gt_confidence: row.gt_confidence,
      event_normalized_weight: row.event_normalized_weight,
      control_score: row.control_score, candidate_score: row.experiment_score,
      control_ordinal: row.control_ordinal, candidate_ordinal: row.experiment_ordinal
    })));
    tables['candidate_validation_metrics.csv'].push({
      candidate_id: id, sample_count: rows.length, event_count: countEvents(rows),
      cohort_sample_count: detail.coverage.cohort_sample_count,
      control_success_count: detail.coverage.control_success_count,
      candidate_success_count: detail.coverage.candidate_success_count,
      control_source_coverage_rate: detail.coverage.control_source_coverage_rate,
      candidate_control_coverage_rate: detail.coverage.candidate_control_coverage_rate,
      control_mae: pair.control.mae ?? null, candidate_mae: pair.candidate.mae ?? null,
      delta_mae: pair.deltas.delta_mae ?? null, no_skill_mae: skill,
      severe_error_rate: pair.candidate.severe_error_rate ?? null,
      within_1_accuracy: pair.candidate.within_1_accuracy ?? null,
      abs_bias: record.abs_bias, qwk: record.qwk,
      closest_sample_count: closest.length, closest_event_count: countEvents(closest),
      closest_control_mae: closestPair.control.mae ?? null,
      closest_candidate_mae: closestPair.candidate.mae ?? null,
      closest_delta_mae: closestPair.deltas.delta_mae ?? null
    });
    tables['candidate_guardrails.csv'].push({ candidate_id: id,
      classification: classification.status, reason_codes_json: canonicalJson(record.reason_codes) });
    tables['candidate_slice_metrics.csv'].push(...slices.map(slice => ({
      candidate_id: id, slice_dimension: slice.slice_dimension, slice_value: slice.slice_value,
      slice_value_is_null: slice.slice_value_is_null, sample_count: slice.sample_count,
      event_count: slice.event_count, date_count: slice.date_count, supported: slice.supported,
      delta_mae: slice.delta_mae, delta_severe_error_rate: slice.delta_severe_error_rate,
      regression: slice.regression
    })));
    for (const [scope, set] of [['PER_DATE', dates.per_date], ['LODO', dates.lodo]]) {
      tables['candidate_date_stability.csv'].push(...set.map(date => ({ candidate_id: id,
        scope, event_date_local: date.event_date_local, sample_count: date.sample_count,
        event_count: date.event_count, control_mae: date.control_mae,
        candidate_mae: date.candidate_mae, delta_mae: date.delta_mae,
        direction: date.direction })));
    }
    tables['candidate_bootstrap.csv'].push(bootstrapRow(id, bootstrap, plan.bootstrap_seed));
    tables['reports/error_cases.csv'].push(...rows.filter(row => row.abs_error_delta > 0).map(row => ({
      candidate_id: id, snapshot_id: row.snapshot_id, abs_error_delta: row.abs_error_delta
    })));
    progress?.update(`VALIDATION 候选 ${records.length}/${input.candidates.length}`);
  }
  const eligible = rankEligible(records.filter(record => record.classification === 'ELIGIBLE'));
  const ranked = [...eligible, ...records.filter(record => record.classification !== 'ELIGIBLE')
    .sort((a, b) => compare(a.candidate_id, b.candidate_id))];
  const eligibleRanks = new Map(eligible.map((record, index) => [record.candidate_id, index + 1]));
  tables['candidate_comparison.csv'] = ranked.map(record => ({
    candidate_id: record.candidate_id, classification: record.classification,
    rank: eligibleRanks.get(record.candidate_id) ?? null,
    mae: record.mae, severe_error_rate: record.severe_error_rate,
    within_1_accuracy: record.within_1_accuracy, abs_bias: record.abs_bias,
    qwk: record.qwk, changed_unit_count: record.changed_unit_count,
    normalized_parameter_distance: record.normalized_parameter_distance
  }));
  if (parity.summary.fail_count) tables['reports/warnings.csv'].push({ warning_code: 'REFERENCE_PARITY_MISMATCH', candidate_id: null });
  if (prepared.controlFailures.length) tables['reports/warnings.csv'].push({ warning_code: 'CONTROL_REPLAY_FAILURE', candidate_id: null });
  for (const record of records) if (record.classification !== 'ELIGIBLE') {
    tables['reports/warnings.csv'].push({ warning_code: record.classification, candidate_id: record.candidate_id });
  }
  const outcome = selectOutcome(records, core.mode);
  const resultUsage = formal ? core.result_usage : fixtureFormal ? 'TEST_FIXTURE_ONLY' : 'DEVELOPMENT_ONLY';
  const includeSelected = (formal || fixtureFormal) && outcome.outcome === 'SELECTED';
  const supportDoc = policyVersion >= 2 ? supportDocument(cohort, 'VALIDATION', input.candidates.map(item => ({
    id: item.candidate_id, rows: tables['candidate_sample_predictions.csv'].filter(row => row.candidate_id === item.candidate_id)
      .map(row => ({ ...row, experiment_ordinal: row.candidate_ordinal })),
    failures: tables['replay_failures.csv'].filter(row => row.candidate_id === null || row.candidate_id === item.candidate_id)
  }))) : null;
  const supportFields = supportDoc ? { gt_level_support: supportDoc.gt_level_support,
    gt_level_support_sha256: supportDoc.gt_level_support_sha256,
    upstream_train_support: core.upstream_train_support } : {};
  for (const code of supportDoc?.gt_level_support.warnings || []) {
    tables['reports/warnings.csv'].push({ warning_code: code, candidate_id: null });
  }
  const promotion = formal && resultUsage === 'FORMAL' && outcome.outcome === 'SELECTED';
  const formalFields = formal ? (await import('../../formal/context.mjs')).formalContextIdentity(core.formal_context) : {};
  const selection = { validation_schema_version: formal || policyVersion === 4 ? 2 : 1, validation_policy_version: policyVersion,
    ...formalFields,
    ...supportFields,
    mode: core.mode, outcome: outcome.outcome, selected_candidate_id: outcome.selected_candidate_id,
    result_usage: resultUsage, formal_promotion_allowed: promotion,
    test_fixture_only: resultUsage === 'TEST_FIXTURE_ONLY',
    reference_parity: parity.summary, control_failure_count: prepared.controlFailures.length,
    candidates: records };
  const summary = { mode: core.mode, status: resultUsage,
    ...formalFields,
    ...supportFields,
    ...(supportDoc ? { rare_level_audit: supportDoc.rare_level_audit } : {}),
    plan_id: planIdentityResult.planId, cohort_sample_count: cohort.length,
    candidate_count: records.length, reference_parity_fail_count: parity.summary.fail_count,
    selection_outcome: outcome.outcome, selected_candidate_id: outcome.selected_candidate_id,
    evaluated_splits: ['VALIDATION'], test_evaluated: false };
  const files = {
    ...(formal ? { 'formal_context.json': canonicalJson(core.formal_context) } : {}),
    'schema.json': canonicalJson(validationSchema({ includeSelected, policyVersion })),
    'policy.json': canonicalJson(policy),
    'validation_plan.json': canonicalJson(planIdentityResult.payload),
    'verified_source_identities.json': canonicalJson(core.source),
    'validation_disclosure_evidence.json': canonicalJson({
      evidence_id: core.evidence_id, evidence_sha256: core.evidence_sha256,
      ledger_prefix_sequence: core.ledger_prefix_sequence,
      ledger_prefix_sha256: core.ledger_prefix_sha256,
      result_usage: resultUsage
    }),
    'selection_result.json': canonicalJson(selection),
    'reports/summary.json': canonicalJson(summary)
  };
  if (supportDoc) files[SUPPORT_FILE] = canonicalJson(supportDoc);
  for (const [name, fields] of Object.entries(CSV_TABLES)) {
    try { files[name] = writeCsv(fields, tables[name]); }
    catch (error) { error.table = name; throw error; }
  }
  if (includeSelected) {
    const selectedIndex = input.candidates.findIndex(item => item.candidate_id === outcome.selected_candidate_id);
    const candidate = input.candidates[selectedIndex];
    const config = detailed[selectedIndex].config;
    const evaluationResultsSha256 = hash(canonicalJson(validationResultFiles(policyVersion)
      .filter(name => name !== 'reports/summary.json')
      .map(name => [name, hash(files[name])])));
    files['selected_candidate.json'] = canonicalJson({
      candidate_id: candidate.candidate_id,
      optimization_id: core.source?.optimization?.id ?? null,
      canonical_candidate_vector: candidate.canonical_vector,
      effective_config_sha256: candidate.effective_config_sha256,
      engine_runtime_sha256: core.engine_runtime_sha256 ?? null,
      tuning_base_config_sha256: core.tuning_base_config_sha256 ?? null,
      parameter_registry_sha256: core.parameter_registry_sha256 ?? null,
      source_validation_selection_rule_sha256: core.source_validation_selection_rule_sha256 ?? null,
      effective_selection_policy_sha256: core.effective_selection_policy_sha256 ?? null,
      selection_evidence_sha256: evaluationResultsSha256,
      ...supportFields,
      ...formalFields,
      eligible_for_phase8: promotion, test_fixture_only: resultUsage === 'TEST_FIXTURE_ONLY'
    });
    files['selected_effective_config.json'] = canonicalJson(config);
  }
  return { files, selection, summary, tables };
}
