import { canonicalJson, compare } from '../../dataset/lib/common.mjs';
import { compareRecords } from './finalist.mjs';

// Strict comparisons on quantized numbers are transitive; epsilon comparisons are not.
const q = value => Number.isFinite(value) ? Number(value.toFixed(12)) : null;
const objective = record => [q(record.metrics.mae), q(Math.abs(record.metrics.bias ?? NaN)), q(record.metrics.qwk)];
export function dominates(a, b) {
  const left = objective(a), right = objective(b);
  const relation = left.map((x, i) => {
    const y = right[i];
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return i === 2 ? (x > y ? -1 : 1) : (x < y ? -1 : 1);
  });
  return relation.every(x => x <= 0) && relation.some(x => x < 0);
}
export function objectiveRank(records) {
  return [...records].sort((a, b) => compareRecords({ ...a, promotable: false }, { ...b, promotable: false }, 0));
}
export function uniqueRecords(records) {
  const seen = new Set();
  return objectiveRank(records.filter(r => r.status === 'FEASIBLE' && r.metrics)).filter(r => {
    const key = canonicalJson(r.candidate.canonical_vector);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function paretoLayers(records) {
  let rest = uniqueRecords(records), layers = [];
  while (rest.length) {
    const front = rest.filter(r => !rest.some(other => other !== r && dominates(other, r)));
    layers.push(objectiveRank(front));
    const ids = new Set(front.map(r => r.candidate.candidate_id));
    rest = rest.filter(r => !ids.has(r.candidate.candidate_id));
  }
  return layers;
}
const support = r => Object.keys(r.candidate.canonical_vector).sort(compare).join('|');

/** Used at every beam and refinement selection, including the initial parents. */
export function selectParents(records, width = 8) {
  const pool = uniqueRecords(records), seats = [], used = new Set(), groups = new Set();
  const take = (list, count, source) => {
    let remaining = list.filter(r => !used.has(r.candidate.candidate_id)), n = 0;
    while (n < count && seats.length < width && remaining.length) {
      const different = remaining.findIndex(r => !groups.has(support(r)));
      const record = remaining.splice(different < 0 ? 0 : different, 1)[0];
      const id = record.candidate.candidate_id;
      used.add(id); groups.add(support(record)); n++;
      seats.push({ record, seat: seats.length + 1, source, candidate_id: id,
        quality: record.quality, reason_codes: record.reason_codes || [], gates: record.gates || [] });
    }
  };
  const all = pool.filter(r => r.train_all_guards_pass);
  const basic = pool.filter(r => !r.train_all_guards_pass && r.basic_guards_pass);
  const other = pool.filter(r => !r.basic_guards_pass);
  take(objectiveRank(all), 4, 'TRAIN_ALL_GUARDS_PASS');
  take(paretoLayers(basic)[0] || [], 2, 'BASIC_PARETO_FRONT');
  take(paretoLayers(other)[0] || [], 2, 'EXPLORATORY_PARETO_FRONT');
  take(objectiveRank(all), width, 'FILL_TRAIN_ALL');
  take(objectiveRank(basic), width, 'FILL_BASIC');
  for (const layer of paretoLayers(other)) take(layer, width, 'FILL_OTHER_PARETO_LAYER');
  return seats;
}

export function candidateQuality(args) {
  // Reuse the frozen formal *quality* rules, without granting formal provenance.
  const gates = args.gates;
  const basicNames = new Set(['COVERAGE_CONTROL_SOURCE', 'COVERAGE_CANDIDATE_CONTROL', 'PARTIAL_COVERAGE',
    'WEIGHTED_MAE_STRICTLY_BETTER', 'SEVERE_ERROR_RATE_NOT_WORSE', 'WITHIN_1_ACCURACY_NOT_WORSE',
    'ABSOLUTE_BIAS_NOT_WORSE', 'QWK_NOT_WORSE']);
  const basic = [...basicNames].every(name => gates.some(g => g.gate === name && g.status !== 'FAIL'));
  const all = basic && ['NO_SKILL_MAE_STRICTLY_BETTER', 'DATE_ROBUSTNESS', 'LODO_ROBUSTNESS', 'SLICE_REGRESSION']
    .every(name => gates.some(g => g.gate === name && g.status === 'PASS'));
  return { basic_guards_pass: basic, train_all_guards_pass: all,
    quality: all ? 'TRAIN_ALL_GUARDS_PASS' : basic ? 'BASIC_GUARDS_PASS' : 'SEARCH_DIAGNOSTIC_ONLY' };
}
