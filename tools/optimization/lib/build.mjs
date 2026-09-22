import { canonicalJson, compare, hash } from '../../dataset/lib/common.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';
import { silentProgress } from '../../progress.mjs';
import { runReplay } from '../../replay/replay-runner.mjs';
import { evaluateCandidateDetailed, prepareCandidateRun } from '../../tuning/lib/candidate.mjs';
import { candidatePolicy } from '../../tuning/candidate-policy.mjs';
import { optimizationPolicy, objectivePolicyDocument, guardrailPolicyDocument } from '../optimization-policy.mjs';
import { FILES, FREEZE_FILE, MANIFEST_FILE, SCHEMA } from '../optimization-schema.mjs';
import { loadOptimizationInput, sourceIdentity, verifiedSourceIdentities } from './input.mjs';
import { buildSearchSpace, publicSearchSpace } from './search-space.mjs';
import { coarseProposals } from './generator.mjs';
import { runBeamSearch } from './beam.mjs';
import { dateRobustness, noSkillMae, pairMetrics, sliceAnalysis } from './metrics.mjs';
import { evaluateGuardrails } from './guardrails.mjs';
import { buildFreezeDocument, rankRecords, selectFinalists, validationSelectionRuleDocument } from './finalist.mjs';
import { cohortProfile, computeOptimizationReadiness } from './readiness.mjs';
import { csvFor, descriptorOf, filesMetadata, identity } from './package.mjs';

export function optimizationInputIdentity({ source, searchSpaceSha256, policy }) {
  return {
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    source,
    search_space_id: policy.search_space.id,
    search_space_sha256: searchSpaceSha256,
    algorithm: { ...policy.algorithm },
    numeric: { ...policy.numeric },
    objective_policy_sha256: hash(canonicalJson(objectivePolicyDocument())),
    guardrail_policy_sha256: hash(canonicalJson(guardrailPolicyDocument()))
  };
}

export function searchResultIdentity({ optimizationInputId, records }) {
  return `search_result_${hash(canonicalJson({
    optimization_input_id: optimizationInputId,
    results: records.map(record => [
      record.candidate.candidate_id,
      record.status,
      record.promotable === true,
      record.metrics ? record.metrics.mae : null,
      record.metrics ? record.metrics.severe_error_rate : null
    ])
  })).slice(0, 16)}`;
}

export function candidateSetIdentity({ searchResultId, finalistIds }) {
  return `candidate_set_${hash(canonicalJson({
    search_result_id: searchResultId, candidate_ids: finalistIds
  })).slice(0, 16)}`;
}

function header(value, keys) {
  return Object.fromEntries(keys.map(key => [key, value?.[key] ?? null]));
}

function pairGap(value, reference) {
  const left = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const right = typeof reference === 'number' && Number.isFinite(reference) ? reference : null;
  return left === null || right === null ? null : formatMetric(left - right);
}

/** Per-Candidate metric row. Every value is a primitive so the CSV stays canonical. */
function metricRow(record) {
  const candidate = record.candidate;
  const coverage = record.coverage || {};
  const control = record.control || {};
  const metrics = record.metrics || {};
  const deltas = record.deltas || {};
  const perDate = record.date_stats?.per_date_summary || {};
  const lodo = record.date_stats?.lodo_summary || {};
  return {
    candidate_id: candidate.candidate_id,
    candidate_label: record.stage,
    stage: record.stage,
    status: record.status,
    promotable: record.promotable === true,
    changed_unit_count: candidate.changed_unit_count,
    normalized_parameter_distance: candidate.normalized_parameter_distance,
    cohort_sample_count: coverage.cohort_sample_count ?? null,
    control_success_count: coverage.control_success_count ?? null,
    candidate_success_count: coverage.candidate_success_count ?? null,
    control_source_coverage_rate: coverage.control_source_coverage_rate ?? null,
    candidate_control_coverage_rate: coverage.candidate_control_coverage_rate ?? null,
    coverage_pass: record.coverage_pass === true,
    control_mae: control.mae ?? null,
    candidate_mae: metrics.mae ?? null,
    delta_mae: deltas.delta_mae ?? null,
    paired_no_skill_mae: record.no_skill_mae ?? null,
    candidate_mae_gap_to_no_skill: pairGap(metrics.mae, record.no_skill_mae),
    control_mae_gap_to_no_skill: pairGap(control.mae, record.no_skill_mae),
    control_severe_error_rate: control.severe_error_rate ?? null,
    candidate_severe_error_rate: metrics.severe_error_rate ?? null,
    delta_severe_error_rate: deltas.delta_severe_error_rate ?? null,
    control_within_1_accuracy: control.within_1_accuracy ?? null,
    candidate_within_1_accuracy: metrics.within_1_accuracy ?? null,
    control_abs_bias: control.bias === null || control.bias === undefined ? null : Math.abs(control.bias),
    candidate_abs_bias: metrics.bias === null || metrics.bias === undefined ? null : Math.abs(metrics.bias),
    control_qwk: control.qwk ?? null,
    candidate_qwk: metrics.qwk ?? null,
    date_count: record.date_stats?.date_count ?? null,
    per_date_improved_count: perDate.improved_count ?? null,
    per_date_degraded_count: perDate.degraded_count ?? null,
    per_date_neutral_count: perDate.neutral_count ?? null,
    date_improvement_rate: perDate.improvement_rate ?? null,
    median_date_delta_mae: perDate.median_delta_mae ?? null,
    worst_date_delta_mae: perDate.worst_delta_mae ?? null,
    lodo_fold_count: lodo.evaluated_count ?? null,
    lodo_improved_count: lodo.improved_count ?? null,
    lodo_degraded_count: lodo.degraded_count ?? null,
    lodo_neutral_count: lodo.neutral_count ?? null,
    lodo_improvement_rate: lodo.improvement_rate ?? null,
    median_lodo_delta_mae: lodo.median_delta_mae ?? null,
    worst_lodo_delta_mae: lodo.worst_delta_mae ?? null,
    canonical_vector_json: canonicalJson(candidate.canonical_vector)
  };
}

function leaderboardRow(record, rank) {
  const metrics = record.metrics || {};
  return {
    rank,
    candidate_id: record.candidate.candidate_id,
    status: record.status,
    promotable: record.promotable === true,
    objective_value: metrics.mae ?? null,
    candidate_mae: metrics.mae ?? null,
    delta_mae: record.deltas?.delta_mae ?? null,
    severe_error_rate: metrics.severe_error_rate ?? null,
    within_1_accuracy: metrics.within_1_accuracy ?? null,
    abs_bias: metrics.bias === null || metrics.bias === undefined ? null : Math.abs(metrics.bias),
    qwk: metrics.qwk ?? null,
    changed_unit_count: record.candidate.changed_unit_count,
    normalized_parameter_distance: record.candidate.normalized_parameter_distance
  };
}

/**
 * Builds the whole Optimization package in memory. No timestamps and no absolute paths enter the
 * contents, so identical inputs and Policy always produce identical bytes.
 */
export async function buildOptimizationPackage(options) {
  const progress = options.progress || silentProgress;
  const policy = optimizationPolicy();
  const input = options.input ?? await loadOptimizationInput({
    model: options.model, raw: options.raw, gt: options.gt,
    baseline: options.baseline, sensitivity: options.sensitivity,
    root: options.root, progress
  });
  const replayRunner = options.runReplay ?? runReplay;
  const source = sourceIdentity(input);
  const profile = cohortProfile(input.model.rows);
  const replayUsableRate = input.sensitivity.readiness?.metrics?.replay_usable_rate ?? 1;
  const readiness = computeOptimizationReadiness({
    profile, replayUsableRate, sensitivityLinkage: input.sensitivity.linkage
  });
  const mode = readiness.optimization_mode;

  progress.stage('冻结 Search Space');
  const searchSpaceBase = buildSearchSpace({
    mode, registry: input.sensitivity.registry, readiness: input.sensitivity.readiness,
    baseConfig: input.sensitivity.baseConfig, linkage: input.sensitivity.linkage
  });
  const publicSpace = publicSearchSpace(searchSpaceBase);
  const searchSpaceSha256 = hash(canonicalJson(publicSpace));
  const optimizationInputId = `optimization_input_${hash(canonicalJson(
    optimizationInputIdentity({ source, searchSpaceSha256, policy })
  )).slice(0, 16)}`;
  const searchSpace = {
    ...searchSpaceBase,
    base_config: input.sensitivity.baseConfig,
    optimization_input_id: optimizationInputId
  };

  const epsilon = policy.numeric.metric_compare_epsilon;
  const units = Object.values(searchSpace.registry_units);
  const prepared = await prepareCandidateRun({
    cohort: input.cohort, config: input.sensitivity.baseConfig.config, units,
    runReplay: replayRunner, progress, policy: candidatePolicy()
  });

  progress.stage('执行受约束联合搜索');
  const search = await runBeamSearch({
    searchSpace, policy, mode,
    rank: records => rankRecords(records, epsilon),
    onProgress: value => progress.update(value),
    evaluate: async candidate => {
      const detailed = await evaluateCandidateDetailed({ prepared, vector: candidate.canonical_vector });
      if (detailed.status !== 'EVALUABLE') {
        return {
          status: detailed.status === 'INFEASIBLE' ? 'INFEASIBLE' : 'UNEVALUABLE',
          reason_code: detailed.reason_code, detail: detailed.detail ?? null,
          promotable: false, reason_codes: detailed.reason_code ? [detailed.reason_code] : [],
          coverage: detailed.coverage, metrics: null, control: null, deltas: null,
          no_skill_mae: null, date_stats: null, slices: [], gates: []
        };
      }
      const pair = pairMetrics(detailed.rows);
      const dates = dateRobustness(detailed.rows, epsilon);
      const slices = sliceAnalysis(detailed.rows, epsilon, policy.slice_support);
      const noSkill = noSkillMae(detailed.rows, source.no_skill_reference_ordinal);
      const gates = evaluateGuardrails({
        candidate, coverage: detailed.coverage, control: pair.control, metrics: pair.candidate,
        noSkill, dateStats: dates, slices, mode, policy
      });
      const coverageFailure = gates.gates.find(gate =>
        (gate.gate === 'COVERAGE_CONTROL_SOURCE' || gate.gate === 'COVERAGE_CANDIDATE_CONTROL') && gate.status === 'FAIL');
      return {
        status: gates.coverage_pass ? 'FEASIBLE' : 'UNEVALUABLE',
        reason_code: coverageFailure?.reason_code ?? null,
        coverage_pass: gates.coverage_pass,
        search_eligible: gates.search_eligible,
        promotable: gates.promotable, reason_codes: gates.reason_codes,
        coverage: detailed.coverage, metrics: pair.candidate, control: pair.control, deltas: pair.deltas,
        no_skill_mae: noSkill, date_stats: dates, slices, gates: gates.gates
      };
    }
  });

  progress.stage('汇总 Leaderboard 与 Finalist');
  const ranked = rankRecords(search.records, epsilon);
  const feasible = ranked.filter(record => record.status === 'FEASIBLE');
  const finalists = selectFinalists(search.records, { maxCount: policy.finalist_count_max, epsilon, mode });
  const freezeAllowed = mode === 'FORMAL_OPTIMIZATION' && finalists.length > 0;
  const outcome = mode === 'FORMAL_OPTIMIZATION'
    ? (finalists.length ? 'CANDIDATES_PROMOTED' : 'NO_PROMOTABLE_CANDIDATE')
    : (finalists.length ? 'EXPLORATORY_POINTS_GENERATED' : 'NO_EXPLORATORY_POINT');
  const searchResultId = searchResultIdentity({ optimizationInputId, records: search.records });
  const candidateSetId = candidateSetIdentity({
    searchResultId, finalistIds: finalists.map(record => record.candidate.candidate_id)
  });

  const traceRows = search.traces.map(entry => header(entry, [
    'trace_order', 'stage', 'round', 'parent_candidate_id', 'parameter_id', 'change_json',
    'candidate_id', 'outcome', 'reason_code', 'budget_index'
  ]));
  const metricRows = ranked.map(metricRow);
  const guardrailRows = [];
  for (const record of ranked) {
    for (const gate of record.gates || []) {
      guardrailRows.push(header(gate, ['candidate_id', 'gate', 'status', 'observed', 'threshold', 'reason_code']));
    }
  }
  const dateRows = [];
  const sliceRows = [];
  for (const record of ranked) {
    if (!record.date_stats) continue;
    const candidateId = record.candidate.candidate_id;
    for (const [scope, rows] of [['PER_DATE', record.date_stats.per_date], ['LODO', record.date_stats.lodo]]) {
      for (const row of rows) {
        dateRows.push({
          candidate_id: candidateId, scope,
          event_date_local: row.event_date_local,
          sample_count: row.sample_count, event_count: row.event_count,
          control_mae: row.control_mae, candidate_mae: row.candidate_mae,
          delta_mae: row.delta_mae, direction: row.direction
        });
      }
    }
    for (const slice of record.slices || []) {
      sliceRows.push({
        candidate_id: candidateId,
        slice_dimension: slice.slice_dimension,
        slice_value: slice.slice_value,
        slice_value_is_null: slice.slice_value_is_null,
        sample_count: slice.sample_count, event_count: slice.event_count, date_count: slice.date_count,
        supported: slice.supported, support_reason: slice.support_reason,
        control_mae: slice.control_mae, candidate_mae: slice.candidate_mae,
        delta_mae: slice.delta_mae, delta_severe_error_rate: slice.delta_severe_error_rate,
        regression: slice.regression
      });
    }
  }

  const warningMap = new Map();
  const pushWarning = (warning_code, scope, candidateId = null, detail = null) => {
    const key = `${warning_code}|${scope}|${candidateId ?? ''}|${detail ?? ''}`;
    if (!warningMap.has(key)) warningMap.set(key, { warning_code, scope, candidate_id: candidateId, detail });
  };
  for (const reason of readiness.reasons) pushWarning(reason, 'readiness');
  if (mode === 'EXPLORATORY_SEARCH') pushWarning('EXPLORATORY_ONLY_RESULT', 'mode');
  if (!finalists.length) pushWarning(
    mode === 'FORMAL_OPTIMIZATION' ? 'NO_PROMOTABLE_CANDIDATE' : 'NO_EXPLORATORY_POINT', 'outcome'
  );
  for (const record of feasible) {
    for (const reason of record.reason_codes || []) pushWarning(reason, 'candidate', record.candidate.candidate_id);
  }
  const warningRows = [...warningMap.values()].sort((a, b) =>
    compare(a.warning_code, b.warning_code) || compare(a.candidate_id ?? '', b.candidate_id ?? ''));
  const warningCounts = {};
  for (const row of warningRows) warningCounts[row.warning_code] = (warningCounts[row.warning_code] || 0) + 1;

  const plan = {
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    optimization_input_id: optimizationInputId,
    optimization_mode: mode,
    optimization_readiness: readiness.optimization_readiness,
    search_space_id: searchSpace.search_space_id,
    search_space_sha256: searchSpaceSha256,
    declared_units: [...searchSpace.declared_units],
    active_units: [...searchSpace.unit_order],
    excluded_units: searchSpace.excluded_units,
    candidate_normalization_version: searchSpace.candidate_normalization_version,
    algorithm: { ...policy.algorithm },
    numeric: { ...policy.numeric },
    declared_probe_count: 1 + coarseProposals(searchSpace).length,
    units: searchSpace.units,
    freeze_eligibility: {
      mode,
      candidate_freeze_allowed: mode === 'FORMAL_OPTIMIZATION',
      blocking_reasons: readiness.reasons
    }
  };
  const searchPoints = {
    usage: mode === 'FORMAL_OPTIMIZATION' ? 'FORMAL' : 'EXPLORATORY_ONLY',
    optimization_input_id: optimizationInputId,
    optimization_mode: mode,
    budget: search.budget,
    converged: search.converged,
    points: ranked.map((record, index) => ({
      order: index + 1,
      candidate_id: record.candidate.candidate_id,
      stage: record.stage,
      status: record.status,
      promotable: record.promotable === true,
      selection_status: mode === 'FORMAL_OPTIMIZATION' ?
        (record.promotable === true ? 'FORMAL_FINALIST_ELIGIBLE' : 'NOT_ELIGIBLE') :
        (record.status === 'FEASIBLE' ? 'EXPLORATORY_SEARCH_ELIGIBLE' : 'NOT_ELIGIBLE'),
      changed_unit_count: record.candidate.changed_unit_count,
      normalized_parameter_distance: record.candidate.normalized_parameter_distance,
      canonical_vector: record.candidate.canonical_vector,
      candidate_mae: record.metrics ? record.metrics.mae : null,
      delta_mae: record.deltas ? record.deltas.delta_mae : null,
      reason_codes: [...(record.reason_codes || [])]
    }))
  };
  const finalistDocument = {
    usage: freezeAllowed ? 'FORMAL' : 'EXPLORATORY_ONLY',
    optimization_mode: mode,
    optimization_outcome: outcome,
    candidate_freeze_allowed: freezeAllowed,
    validation_promotion_allowed: freezeAllowed,
    finalist_count: finalists.length,
    finalist_count_max: policy.finalist_count_max,
    finalists: finalists.map((record, index) => ({
      order: index + 1,
      candidate_id: record.candidate.candidate_id,
      stage: record.stage,
      selection_status: freezeAllowed ? 'FORMAL_FINALIST' : 'TOP_SEARCH_POINT',
      canonical_vector: record.candidate.canonical_vector,
      effective_config_sha256: record.candidate.effective_config_sha256,
      changed_unit_count: record.candidate.changed_unit_count,
      normalized_parameter_distance: record.candidate.normalized_parameter_distance,
      train_metrics: record.metrics,
      train_control_metrics: record.control,
      train_deltas: record.deltas,
      no_skill_mae: record.no_skill_mae ?? null,
      date_robustness: record.date_stats ? {
        date_count: record.date_stats.date_count,
        per_date: record.date_stats.per_date_summary,
        lodo: record.date_stats.lodo_summary
      } : null
    }))
  };
  const readinessDocument = {
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    optimization_mode: mode,
    optimization_readiness: readiness.optimization_readiness,
    engineering_readiness: readiness.engineering_readiness,
    data_readiness: readiness.data_readiness,
    metric_readiness: readiness.metric_readiness,
    label_concentration: readiness.label_concentration,
    reasons: readiness.reasons,
    thresholds: readiness.thresholds,
    metrics: readiness.metrics,
    coverage_policy: { ...policy.coverage },
    search_budget: search.budget,
    warnings: warningRows.map(row => row.warning_code)
  };

  const files = {
    'schema.json': canonicalJson(SCHEMA),
    'policy.json': canonicalJson(policy),
    'objective_policy.json': canonicalJson(objectivePolicyDocument()),
    'guardrail_policy.json': canonicalJson(guardrailPolicyDocument()),
    'search_space.json': canonicalJson(publicSpace),
    'optimization_plan.json': canonicalJson(plan),
    'verified_source_identities.json': canonicalJson(verifiedSourceIdentities(input)),
    'readiness.json': canonicalJson(readinessDocument),
    'candidate_trace.csv': csvFor('candidate_trace.csv', traceRows),
    'candidate_metrics.csv': csvFor('candidate_metrics.csv', metricRows),
    'candidate_guardrails.csv': csvFor('candidate_guardrails.csv', guardrailRows),
    'candidate_date_stability.csv': csvFor('candidate_date_stability.csv', dateRows),
    'candidate_slice_regressions.csv': csvFor('candidate_slice_regressions.csv', sliceRows),
    'leaderboard.csv': csvFor('leaderboard.csv', feasible.map((record, index) => leaderboardRow(record, index + 1))),
    'search_points.json': canonicalJson(searchPoints),
    'finalists.json': canonicalJson(finalistDocument),
    'reports/warnings.csv': csvFor('reports/warnings.csv', warningRows)
  };

  const counts = {
    optimization_mode: mode,
    optimization_outcome: outcome,
    candidate_freeze_allowed: freezeAllowed,
    validation_promotion_allowed: freezeAllowed,
    cohort_sample_count: input.summary.sample_count,
    cohort_event_count: input.summary.event_count,
    cohort_date_count: input.summary.date_count,
    candidate_count: search.records.length,
    feasible_candidate_count: feasible.length,
    finalist_count: finalists.length
  };
  const resultUsage = freezeAllowed ? 'FORMAL' : 'EXPLORATORY_ONLY';
  const summary = {
    optimization_id: null,
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    optimization_input_id: optimizationInputId,
    search_result_id: searchResultId,
    candidate_set_id: candidateSetId,
    optimization_mode: mode,
    optimization_outcome: outcome,
    candidate_freeze_allowed: freezeAllowed,
    validation_promotion_allowed: freezeAllowed,
    search_space_id: searchSpace.search_space_id,
    search_space_sha256: searchSpaceSha256,
    candidate_count: counts.candidate_count,
    feasible_candidate_count: counts.feasible_candidate_count,
    finalist_count: counts.finalist_count,
    cohort: {
      samples: input.summary.sample_count,
      events: input.summary.event_count,
      dates: input.summary.date_count
    },
    engineering_readiness: readiness.engineering_readiness,
    data_readiness: readiness.data_readiness,
    metric_readiness: readiness.metric_readiness,
    global_readiness: readiness.optimization_readiness,
    result_usage: resultUsage,
    search_budget: search.budget,
    search_converged: search.converged,
    reasons: readiness.reasons,
    warnings_summary: warningCounts,
    top_candidates: finalists.map((record, index) => ({
      order: index + 1,
      candidate_id: record.candidate.candidate_id,
      candidate_mae: record.metrics.mae,
      control_mae: record.control.mae,
      delta_mae: record.deltas.delta_mae
    }))
  };
  files['reports/summary.json'] = canonicalJson(summary);

  if (freezeAllowed) {
    files[FREEZE_FILE] = canonicalJson(buildFreezeDocument({
      optimizationInputId, searchResultId, candidateSetId, finalists,
      source, searchSpace, searchSpaceSha256
    }));
  }
  const descriptorFiles = [...FILES, ...(freezeAllowed ? [FREEZE_FILE] : [])];
  const metadata = filesMetadata(files, descriptorFiles);
  const descriptor = descriptorOf({
    source: { ...source, ...input.sensitivity.linkage },
    metadata, searchSpace, searchSpaceSha256, mode, counts
  });
  const id = identity(descriptor);
  summary.optimization_id = id.optimization_id;
  files['reports/summary.json'] = canonicalJson(summary);

  const manifest = {
    optimization_schema_version: policy.optimization_schema_version,
    optimization_policy_version: policy.optimization_policy_version,
    optimization_id: id.optimization_id,
    descriptor_sha256: id.descriptor_sha256,
    descriptor,
    optimization_mode: mode,
    optimization_outcome: outcome,
    candidate_freeze_allowed: freezeAllowed,
    validation_promotion_allowed: freezeAllowed,
    search_space_id: searchSpace.search_space_id,
    search_space_sha256: searchSpaceSha256,
    optimization_input_id: optimizationInputId,
    search_result_id: searchResultId,
    candidate_set_id: candidateSetId,
    model_dataset_id: source.model_dataset_id,
    model_dataset_manifest_sha256: source.model_dataset_manifest_sha256,
    model_dataset_descriptor_sha256: source.model_dataset_descriptor_sha256,
    model_dataset_schema_version: source.model_dataset_schema_version,
    model_dataset_policy_version: source.model_dataset_policy_version,
    source_dataset_id: source.source_dataset_id,
    ground_truth_id: source.ground_truth_id,
    evaluation_id: source.evaluation_id,
    evaluation_manifest_sha256: source.evaluation_manifest_sha256,
    sensitivity_id: source.sensitivity_id,
    sensitivity_manifest_sha256: source.sensitivity_manifest_sha256,
    sensitivity_descriptor_sha256: source.sensitivity_descriptor_sha256,
    engine_runtime_sha256: source.engine_runtime_sha256,
    tuning_base_config_sha256: source.tuning_base_config_sha256,
    parameter_registry_version: source.parameter_registry_version,
    parameter_registry_sha256: source.parameter_registry_sha256,
    evaluated_splits: [policy.computation_split],
    validation_evaluated: false,
    test_evaluated: false,
    source_validation_scope: 'SOURCE_LINKED',
    computation_access_policy: 'TRAIN_ONLY',
    result_usage: resultUsage,
    cohort_sample_count: counts.cohort_sample_count,
    cohort_event_count: counts.cohort_event_count,
    cohort_date_count: counts.cohort_date_count,
    candidate_count: counts.candidate_count,
    feasible_candidate_count: counts.feasible_candidate_count,
    finalist_count: counts.finalist_count,
    engineering_readiness: readiness.engineering_readiness,
    data_readiness: readiness.data_readiness,
    metric_readiness: readiness.metric_readiness,
    mapping_status: source.mapping_status,
    interpretation_scope: source.interpretation_scope,
    no_skill_reference_ordinal: source.no_skill_reference_ordinal,
    validation_disclosure_status: source.validation_disclosure_status,
    validation_disclosure_evidence_id: source.validation_disclosure_evidence_id,
    validation_disclosure_evidence_sha256: source.validation_disclosure_evidence_sha256,
    validation_access_ledger_sha256: source.validation_access_ledger_sha256,
    validation_selection_rule: validationSelectionRuleDocument(policy),
    schema_sha256: metadata['schema.json'].sha256,
    policy_sha256: metadata['policy.json'].sha256,
    files: {}
  };
  manifest.files = filesMetadata(files, descriptorFiles);
  files[MANIFEST_FILE] = canonicalJson(manifest);
  return { input, source, searchSpace, search, readiness, files, manifest, counts, finalists, mode };
}
