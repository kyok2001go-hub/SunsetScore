import { fail } from '../dataset/lib/common.mjs';
import { canonicalizeCandidate } from '../optimization/lib/candidate.mjs';
import { objectiveRank } from '../optimization/lib/selection.mjs';
import { diagnosticPolicy, diagnosticSchema } from './policy.mjs';
import { cohortDigest, dateFolds, diagnosticMetrics, digest, evaluator, fixedMatrix, members,
  procedureDecision, qualityRecord, searchCohort, summarizeSearch } from './engine.mjs';
import { evaluateCandidateDetailed } from '../tuning/lib/candidate.mjs';

export function makeDiagnosticPlan({ cohort, searchSpace, sourceManifest }) {
  const base = id => searchSpace.units.find(u => u.parameter_id === id)?.baseline_value;
  if (base('atmosphere_quality_base') !== 0.7 || base('atmosphere_quality_scale') !== 0.3) fail('DIAGNOSTIC_CONTROL_MISMATCH');
  const { registry_units, base_config, optimization_input_id, ...space } = searchSpace;
  return { diagnostic_schema_version: 1, diagnostic_policy_version: 1, result_usage: 'DEVELOPMENT_ONLY',
    policy: diagnosticPolicy(), source_manifest_sha256: digest(sourceManifest), cohort_sha256: cohortDigest(cohort),
    train_members: members(cohort), search_space: space, matrix: fixedMatrix(searchSpace),
    fold_assignments: dateFolds(cohort), computation_access_policy: 'TRAIN_ONLY', test_evaluated: false,
    validation_evaluated: false };
}

export function compactRecord({ rows, candidate, ...record }) {
  const { effective_config, ...identity } = candidate;
  return { ...record, candidate: identity };
}
const compactSearch = search => ({ ...search, records: search.records.map(compactRecord), ...summarizeSearch(search) });

/** Pure Replay cache: keys contain runtime, config and replay only, never labels or metrics. */
export function cachedReplay(runner, runtimeHash) {
  const cache = new Map();
  const identities = new WeakMap();
  const frozen = new WeakSet();
  const freeze = value => {
    if (!value || typeof value !== 'object' || frozen.has(value)) return;
    frozen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  const inputHash = value => {
    if (!value) return null;
    if (!identities.has(value)) { freeze(value); identities.set(value, digest(value)); }
    return identities.get(value);
  };
  return async (replay, options = {}) => {
    // Immutable captured inputs/config are hashed once, rather than serializing large NWP
    // payloads again for every candidate and fold. A nested mutation cannot stale the key.
    const key = digest({ runtime: runtimeHash, replay: inputHash(replay), config: inputHash(options.modelConfig) });
    if (!cache.has(key)) {
      const value = await runner(replay, options);
      if (!Number.isInteger(value?.actual?.score) || value.actual.score < 0 || value.actual.score > 100) fail('DIAGNOSTIC_REPLAY_SCORE_INVALID');
      cache.set(key, { pass: value.pass, issues: value.issues || [], actual: {
        score: value.actual.score, gw_factor: value.actual.gw_factor,
        sky_evolution_factor: value.actual.sky_evolution_factor } });
    }
    return cache.get(key);
  };
}

export async function computeDiagnostics({ plan, sourceManifest, cohort, searchSpace, runReplay, progress, finalOptimizationInputId }) {
  const expected = makeDiagnosticPlan({ cohort, searchSpace, sourceManifest });
  if (digest(expected) !== digest(plan)) fail('DIAGNOSTIC_PLAN_SOURCE_CHANGED');
  const policy = diagnosticPolicy(), schema = diagnosticSchema();
  const runner = cachedReplay(runReplay, sourceManifest.runtime.engine_runtime_sha256);
  const parity = [];
  for (const row of cohort) {
    // Reference comparison consumes only the matching TRAIN Snapshot, outside the pure score cache.
    try { const replay = await runReplay(row.replay, { reference: row }); parity.push({ snapshot_id: row.snapshot_id,
      pass: replay.pass === true, actual_score: replay.actual.score, reference_score: row.predicted_score ?? null,
      issue_codes: replay.issues || [] }); }
    catch { parity.push({ snapshot_id: row.snapshot_id, pass: false }); }
  }
  const parityById = new Map(parity.map(r => [r.snapshot_id, r.pass]));
  const ev = await evaluator({ cohort, searchSpace, runReplay: runner, progress, scopeId: `matrix_${digest(plan.matrix).slice(0, 16)}` });
  const matrix = [], samples = [], grades = [], distributions = [], slices = [];
  for (const entry of plan.matrix) {
    const candidate = canonicalizeCandidate({ vector: entry.canonical_vector, searchSpace,
      baseConfig: searchSpace.base_config, optimizationInputId: ev.space.optimization_input_id });
    const record = await ev.evaluate(candidate), metrics = diagnosticMetrics(record.rows);
    matrix.push({ label: entry.label, ...compactRecord(record), diagnostics: metrics });
    samples.push(...record.rows.map(r => ({ matrix_label: entry.label, candidate_id: candidate.candidate_id, ...r })));
    grades.push(...metrics.grades.map(r => ({ matrix_label: entry.label, candidate_id: candidate.candidate_id, ...r })));
    distributions.push(...metrics.prediction_distribution.map(r => ({ matrix_label: entry.label, candidate_id: candidate.candidate_id, ...r })));
    slices.push(...(record.slices || []).map(r => ({ matrix_label: entry.label, candidate_id: candidate.candidate_id, ...r })));
    progress?.update(`固定矩阵 ${matrix.length}/${plan.matrix.length}`);
  }
  const searches = [], folds = [], oof = [];
  if (plan.fold_assignments.status === 'READY') for (const fold of plan.fold_assignments.folds) {
    progress?.stage(`内层日期折 ${fold.fold}/3：独立搜索`);
    const training = cohort.filter(r => fold.train_dates.includes(r.event_date_local));
    const held = cohort.filter(r => fold.held_dates.includes(r.event_date_local));
    const search = await searchCohort({ cohort: training, searchSpace, runReplay: runner, progress });
    searches.push({ fold: fold.fold, ...compactSearch(search) });
    const best = objectiveRank(search.records.filter(r => r.basic_guards_pass))[0];
    const frozen = best ? { ...compactRecord(best), frozen_before_holdout: true,
      training_cohort_sha256: cohortDigest(training), reference_ordinal: search.reference_ordinal } : null;
    const entry = { fold: fold.fold, train_members_sha256: digest(fold.train_members), held_members_sha256: digest(fold.held_members),
      candidate: frozen, reference_ordinal: search.reference_ordinal };
    // Missing candidate is preserved as missing evidence; no alternate point is chosen on held effects.
    if (!best) { folds.push({ ...entry, status: 'NO_FOLD_CANDIDATE', held_metrics: null }); continue; }
    const heldEval = await evaluator({ cohort: held, searchSpace, runReplay: runner, progress, noSkillReference: search.reference_ordinal });
    const detailed = await evaluateCandidateDetailed({ prepared: heldEval.prepared, vector: best.candidate.canonical_vector });
    const heldRecord = qualityRecord({ ...detailed, controlFailures: heldEval.prepared.controlFailures }, best.candidate, search.reference_ordinal);
    const complete = heldRecord.status === 'FEASIBLE' && heldRecord.metrics.mae !== null &&
      [...training, ...held].every(r => parityById.get(r.snapshot_id));
    const heldMetrics = { ...diagnosticMetrics(heldRecord.rows), no_skill_mae: heldRecord.no_skill_mae,
      coverage: heldRecord.coverage, slices: heldRecord.slices || [], failures: heldRecord.failures || [] };
    folds.push({ ...entry, status: complete ? 'EVALUATED' : 'INCONCLUSIVE', held_metrics: heldMetrics });
    oof.push(...heldRecord.rows.map(r => ({ ...r, fold: fold.fold, candidate_id: best.candidate.candidate_id,
      fold_reference_ordinal: search.reference_ordinal })));
  }
  const stability = procedureDecision(folds, oof);
  let finalSearch = null, candidates = [];
  if (stability.status === 'PROCEDURE_SUPPORTED' && parity.every(r => r.pass)) {
    progress?.stage('过程稳定性通过：全 TRAIN 最终搜索');
    finalSearch = await searchCohort({ cohort, searchSpace, runReplay: runner, progress, scopeId: finalOptimizationInputId });
    candidates = objectiveRank(finalSearch.records.filter(r => r.train_all_guards_pass)).slice(0, 5).map(compactRecord);
    searches.push({ fold: 'FULL_TRAIN', ...compactSearch(finalSearch) });
  }
  const proposals = plan.matrix.length + searches.reduce((n, s) => n + s.budget.unique_candidates, 0);
  if (proposals > policy.total_proposal_budget) fail('PLAN_BUDGET_EXCEEDED');
  const status = !parity.every(r => r.pass) ? 'INCONCLUSIVE' : stability.status !== 'PROCEDURE_SUPPORTED' ? stability.status :
    candidates.length ? 'DEVELOPMENT_CANDIDATES_FROZEN' : 'NO_TRAIN_QUALIFIED_CANDIDATE';
  const decision = { status, procedure_status: stability.status, result_usage: 'DEVELOPMENT_ONLY',
    auto_validation_allowed: status === 'DEVELOPMENT_CANDIDATES_FROZEN',
    candidate_ids: candidates.map(r => r.candidate.candidate_id), candidates_sha256: digest(candidates),
    formal_promotion_allowed: false, test_evaluated: false,
    reason_codes: !parity.every(r => r.pass) ? ['REFERENCE_REPLAY_FAILED'] : plan.fold_assignments.status !== 'READY' ?
      ['INNER_CV_INSUFFICIENT'] : stability.reason_codes };
  const payloads = { 'schema.json': schema, 'policy.json': policy, 'plan.json': plan,
    'source_manifest.json': sourceManifest, 'matrix_metrics.json': matrix, 'sample_diagnostics.json': samples,
    'grade_metrics.json': grades, 'prediction_distribution.json': distributions, 'slice_metrics.json': slices,
    'fold_assignments.json': plan.fold_assignments, 'fold_candidates.json': folds.map(({ held_metrics, ...f }) => f),
    'fold_metrics.json': folds, 'oof_summary.json': { ...stability, samples: oof }, 'searches.json': searches,
    'reference_parity.json': parity, 'decision.json': decision,
    'reports/summary.json': { ...decision, matrix_vector_count: matrix.length, proposals,
      train_sample_count: cohort.length, train_event_count: new Set(cohort.map(r => r.event_id)).size,
      inner_cv_status: plan.fold_assignments.status, folds: folds.map(f => ({ fold: f.fold, status: f.status,
        candidate_id: f.candidate?.candidate.candidate_id || null, delta_mae: f.held_metrics?.deltas.delta_mae ?? null })),
      final_candidates: candidates, tool_completed: true, parameters_improved: candidates.length > 0,
      formal_ready: false, limitation: policy.limitation } };
  return { payloads, finalSearch, candidates };
}
