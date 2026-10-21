import { digest, MEMBERS, normalizeWeights, POLICY, rank, q, RECOGNITION_POLICY, rankRecognition } from './policy.mjs';
import { fail, errorCode } from '../dataset/lib/common.mjs';

export function coarseGrid() {
  const out = [];
  function visit(prefix, left) {
    if (prefix.length === 4) { out.push(Object.fromEntries(MEMBERS.map((k, i) => [k, (prefix[i] ?? left) / 5]))); return; }
    for (let n = 0; n <= left; n++) visit([...prefix, n], left - n);
  }
  visit([], 5); return out;
}
export function localNeighbors(weights, step) {
  const out = [];
  for (const from of MEMBERS) for (const to of MEMBERS) if (from !== to) {
    const next = { ...weights, [from]: q(weights[from] - step), [to]: q(weights[to] + step) };
    out.push(next);
  }
  return out;
}
export function candidateFor(weights, { control, engine_sha256 }) {
  weights = normalizeWeights(weights);
  return { candidate_id: `practical_candidate_${digest({ weights, control: digest(control), engine_sha256 }).slice(0, 20)}`,
    weights, control_weight_distance: q(MEMBERS.reduce((s, k) => s + Math.abs(weights[k] - control.weights[k]), 0)) };
}
export async function searchWeights({ control, engine_sha256, evaluate, save = async () => {},
  restored = [], progress = () => {}, maxCandidates = POLICY.budget, skipSearch = false, probes = [], recognitionFirst = false }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > POLICY.budget) fail('INVALID_CANDIDATE_BUDGET');
  const records = [], audit = [], seen = new Set(), old = new Map(restored.map(r => [r.candidate_id, r]));
  let budgetHit = false;
  const propose = async (raw, stage) => {
    let candidate;
    try { candidate = candidateFor(raw, { control, engine_sha256 }); }
    catch (e) { audit.push({ stage, status: 'INVALID', weights: raw, reason_code: errorCode(e) }); return; }
    if (seen.has(candidate.candidate_id)) { audit.push({ stage, status: 'DUPLICATE', candidate_id: candidate.candidate_id }); return; }
    if (records.length >= maxCandidates) { budgetHit = true; return; }
    seen.add(candidate.candidate_id);
    let record = old.get(candidate.candidate_id);
    if (record && digest(record.weights) !== digest(candidate.weights)) fail('RESUME_CANDIDATE_MISMATCH');
    if (!record) {
      try { record = { ...candidate, stage, status: 'EVALUATED', ...await evaluate(candidate) }; }
      catch (e) { record = { ...candidate, stage, status: 'ERROR', reason_code: errorCode(e), metrics: null }; }
      await save(record);
    }
    records.push(record); audit.push({ stage, status: record.status, candidate_id: record.candidate_id });
    const best = rank(records)[0];
    progress({ count: records.length, stage, current: record.status, best: best?.metrics.product_loss ?? null,
      best_candidate: best?.candidate_id ?? null });
  };
  await propose(control.weights, 'CONTROL');
  if (records[0]?.status !== 'EVALUATED') fail('NO_VALID_CONTROL');
  for (const probe of probes) await propose(probe.weights, 'WIRING_PROBE');
  if (!skipSearch) {
    if (recognitionFirst) {
      for (const w of RECOGNITION_POLICY.seeds) await propose(w, 'RECOGNITION_SEED');
      for (const w of RECOGNITION_POLICY.seeds) await propose(Object.fromEntries(MEMBERS.map(k => [k, q((w[k] + control.weights[k]) / 2)])), 'INTERIOR_SEED');
    } else for (const w of coarseGrid()) await propose(w, 'COARSE_0.20');
    for (const step of recognitionFirst ? RECOGNITION_POLICY.local_steps : POLICY.local_steps) {
      const parents = (recognitionFirst ? rankRecognition(records, records[0]) : rank(records)).slice(0, recognitionFirst ? RECOGNITION_POLICY.local_parents : POLICY.local_parents);
      for (const parent of parents) for (const w of localNeighbors(parent.weights, step)) await propose(w, `LOCAL_${step}`);
    }
  }
  return { records, audit, control_id: records[0].candidate_id,
    budget: { maximum: maxCandidates, evaluated_unique: records.length, errors: records.filter(r => r.status === 'ERROR').length,
      invalid: audit.filter(a => a.status === 'INVALID').length, duplicates: audit.filter(a => a.status === 'DUPLICATE').length,
      termination: skipSearch ? 'WEIGHTS_NOT_EFFECTIVE' : budgetHit ? 'BUDGET_REACHED' : recognitionFirst ? 'RECOGNITION_LOCAL_SEARCH_COMPLETE' : 'GRID_AND_THREE_LOCAL_ROUNDS_COMPLETE',
      exhaustive_parameter_space: false } };
}
