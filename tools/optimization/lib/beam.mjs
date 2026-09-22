import { canonicalJson, compare } from '../../dataset/lib/common.mjs';
import { candidateKey, canonicalizeCandidate } from './candidate.mjs';
import { coarseProposals, coordinateExpansions, refinementProposals } from './generator.mjs';

/**
 * Deterministic Constrained Beam Coordinate Search.
 *
 * The search is a pure driver over an injected `evaluate(candidate)` callback: it owns ordering,
 * de-duplication, budget accounting and beam selection, and the caller owns Replay and metrics.
 * That split is what makes the search itself unit-testable without a Replay engine.
 */

export const SEARCH_STATUSES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  DUPLICATE: 'DUPLICATE',
  INFEASIBLE: 'INFEASIBLE',
  UNEVALUABLE: 'UNEVALUABLE'
});

function makeBudget(policy) {
  return {
    limit_ab: Math.min(policy.algorithm.stage_a_b_budget, policy.algorithm.max_unique_candidates),
    limit_c: Math.min(policy.algorithm.stage_c_budget, policy.algorithm.max_unique_candidates),
    used_ab: 0,
    used_c: 0
  };
}

function budgetFor(budget, stage) {
  return stage === 'REFINEMENT'
    ? { used: budget.used_c, limit: budget.limit_c }
    : { used: budget.used_ab, limit: budget.limit_ab };
}

function charge(budget, stage) {
  if (stage === 'REFINEMENT') budget.used_c += 1;
  else budget.used_ab += 1;
}

export async function runBeamSearch({ searchSpace, policy, mode, evaluate, rank, onProgress = () => {} }) {
  const budget = makeBudget(policy);
  const seen = new Map();
  const records = [];
  const traces = [];
  let traceOrder = 0;
  let budgetIndex = 0;
  let converged = false;

  const sortedByRank = list => rank([...list]).map(record => record.candidate.candidate_id);

  async function processProposal(proposal, { round = null, parentId = null } = {}) {
    const stage = proposal.stage;
    const scope = budgetFor(budget, stage);
    const candidate = canonicalizeCandidate({
      vector: proposal.vector,
      searchSpace,
      baseConfig: searchSpace.base_config,
      optimizationInputId: searchSpace.optimization_input_id
    });
    const key = candidateKey(candidate);
    if (seen.has(key)) {
      traceOrder += 1;
      traces.push(traceRecord({
        trace_order: traceOrder, stage, round, parent_candidate_id: parentId,
        parameter_id: proposal.parameter_id, change_json: proposal.change_json,
        candidate_id: seen.get(key), outcome: SEARCH_STATUSES.DUPLICATE,
        reason_code: 'DUPLICATE_CANDIDATE', budget_index: null
      }));
      return { accepted: false, duplicate: true, record: null };
    }
    if (scope.used >= scope.limit) {
      return { accepted: false, exhausted: true, record: null };
    }
    charge(budget, stage);
    budgetIndex += 1;
    seen.set(key, candidate.candidate_id);
    if (candidate.status === 'INFEASIBLE') {
      traceOrder += 1;
      traces.push(traceRecord({
        trace_order: traceOrder, stage, round, parent_candidate_id: parentId,
        parameter_id: proposal.parameter_id, change_json: proposal.change_json,
        candidate_id: null, outcome: SEARCH_STATUSES.INFEASIBLE,
        reason_code: candidate.reason_code, budget_index: budgetIndex
      }));
      return { accepted: false, infeasible: true, record: null };
    }
    const evaluated = await evaluate(candidate, { stage, round, parentId });
    const record = { ...evaluated, candidate, stage, round, parent_candidate_id: parentId };
    records.push(record);
    traceOrder += 1;
    traces.push(traceRecord({
      trace_order: traceOrder, stage, round, parent_candidate_id: parentId,
      parameter_id: proposal.parameter_id, change_json: proposal.change_json,
      candidate_id: candidate.candidate_id,
      outcome: record.status === 'FEASIBLE' ? SEARCH_STATUSES.ACCEPTED : SEARCH_STATUSES.UNEVALUABLE,
      reason_code: record.reason_code ?? null, budget_index: budgetIndex
    }));
    onProgress(`已评估 ${records.length} 个候选点（预算 ${budget.used_ab}/${budget.limit_ab} + ${budget.used_c}/${budget.limit_c}）`);
    return { accepted: record.status === 'FEASIBLE', duplicate: false, record };
  }

  // Stage A: Control first, then the frozen single-unit coarse seeds.
  await processProposal({
    stage: 'CONTROL', parameter_id: null, change_json: canonicalJson({}), vector: {}
  });
  const seedProposals = coarseProposals(searchSpace);
  for (const proposal of seedProposals) {
    if (budget.used_ab >= budget.limit_ab) break;
    await processProposal(proposal);
  }
  const seedRecords = records.filter(record => record.status === 'FEASIBLE');

  // Stage B: beam coordinate search over the joint space.
  let beamIds = sortedByRank(seedRecords).slice(0, policy.algorithm.beam_width);
  for (let round = 1; round <= policy.algorithm.max_rounds; round++) {
    const before = records.filter(record => record.status === 'FEASIBLE').length;
    for (const parentId of beamIds) {
      const parent = records.find(record => record.candidate.candidate_id === parentId);
      if (!parent) continue;
      if (budget.used_ab >= budget.limit_ab) break;
      for (const proposal of coordinateExpansions({ searchSpace, parent: parent.candidate })) {
        if (budget.used_ab >= budget.limit_ab) break;
        await processProposal(proposal, { round, parentId });
      }
    }
    const feasible = records.filter(record => record.status === 'FEASIBLE');
    beamIds = sortedByRank(feasible).slice(0, policy.algorithm.beam_width);
    if (feasible.length === before) {
      converged = true;
      break;
    }
    if (budget.used_ab >= budget.limit_ab) break;
  }

  // Stage C: local refinement around the best points found so far.
  let refineIds = sortedByRank(records.filter(record => record.status === 'FEASIBLE'))
    .slice(0, policy.algorithm.beam_width);
  for (let round = 1; round <= policy.algorithm.refinement_rounds; round++) {
    for (const parentId of refineIds) {
      const parent = records.find(record => record.candidate.candidate_id === parentId);
      if (!parent) continue;
      if (budget.used_c >= budget.limit_c) break;
      for (const proposal of refinementProposals({ searchSpace, parent: parent.candidate, round, stepFactor: policy.algorithm.refinement_step_factor })) {
        if (budget.used_c >= budget.limit_c) break;
        await processProposal(proposal, { round, parentId });
      }
    }
    refineIds = sortedByRank(records.filter(record => record.status === 'FEASIBLE'))
      .slice(0, policy.algorithm.beam_width);
    if (budget.used_c >= budget.limit_c) break;
  }

  return {
    records,
    traces,
    budget: {
      limit_ab: budget.limit_ab, limit_c: budget.limit_c,
      used_ab: budget.used_ab, used_c: budget.used_c,
      unique_candidates: budget.used_ab + budget.used_c
    },
    converged,
    beam_ids: beamIds,
    refinement_ids: refineIds
  };
}

function traceRecord(entry) {
  return entry;
}

/** Deterministic candidate ordering by candidate_id, used by tests and packaging. */
export function sortRecordsByCandidateId(records) {
  return [...records].sort((a, b) => compare(a.candidate.candidate_id, b.candidate.candidate_id));
}
