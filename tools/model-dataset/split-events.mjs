import { compare, fail } from '../dataset/lib/common.mjs';
import { POLICY, Q } from './model-dataset-policy.mjs';

export function splitEvents(events, onBoundary = () => {}, policy = POLICY) {
  const counts = new Map();
  for (const e of events) counts.set(e.event_date_local, (counts.get(e.event_date_local) || 0) + 1);
  const blocks = [...counts].sort((a, b) => compare(a[0], b[0])).map(([date, events]) => ({ date, events }));
  const D = blocks.length, N = events.length;
  const minimumTotal = policy.minimum_total_events ?? policy.minimum_events.reduce((a, b) => a + b, 0);
  if (D > policy.max_date_blocks) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DATE_BLOCK_LIMIT_EXCEEDED' });
  const prefix = [0];
  for (const b of blocks) prefix.push(prefix.at(-1) + b.events);
  let selected = null, theoretical = null;
  // Ascending enumeration makes equal objectives retain the earliest boundaries.
  for (let i = 1; i < D - 1; i++) for (let j = i + 1; j < D; j++) {
    if (j === D - 1) onBoundary(i, D - 2);
    const sizes = [prefix[i], prefix[j] - prefix[i], N - prefix[j]];
    const objective = sizes.reduce((sum, n, k) => sum + Math.abs(100 * n - policy.percentages[k] * N), 0);
    if (!theoretical || objective < theoretical.objective) theoretical = { i, j, sizes, objective };
    if (N >= minimumTotal && sizes.every((n, k) => n >= policy.minimum_events[k]) && (!selected || objective < selected.objective)) selected = { i, j, sizes, objective };
  }
  const describe = candidate => {
    if (!candidate) return null;
    const { i, j, sizes, objective } = candidate, edges = [0, i, j, D];
    return { validation_boundary: blocks[i].date, test_boundary: blocks[j].date, objective,
      splits: Object.fromEntries(policy.splits.map((s, k) => [s, { events: sizes[k],
        date_range: { from: blocks[edges[k]].date, to: blocks[edges[k + 1] - 1].date }, ratio: Q(sizes[k] / N) }])) };
  };
  const theoreticalResult = describe(theoretical);
  if (theoreticalResult) theoreticalResult.deficits = Object.fromEntries(policy.splits.map((s, k) => [s, Math.max(0, policy.minimum_events[k] - theoretical.sizes[k])]));
  const blockers = [];
  if (N < minimumTotal) blockers.push('TOO_FEW_PRIMARY_EVENTS');
  if (D < 3) blockers.push('TOO_FEW_DATE_BLOCKS');
  if (!selected) blockers.push('NO_FEASIBLE_DATE_BOUNDARIES');
  return { status: selected ? 'READY' : 'INSUFFICIENT_SPLIT_DATA', publishable: !!selected,
    primary_date_range: D ? { from: blocks[0].date, to: blocks.at(-1).date } : null,
    date_blocks: blocks, minimum_total_event_deficit: Math.max(0, minimumTotal - N), minimum_date_block_deficit: Math.max(0, 3 - D),
    selected_split: describe(selected), theoretical_split: theoreticalResult, blockers };
}

export function dateSplit(date, split) {
  return date < split.validation_boundary ? 'TRAIN' : date < split.test_boundary ? 'VALIDATION' : 'TEST';
}
