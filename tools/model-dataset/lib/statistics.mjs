import { compare } from '../../dataset/lib/common.mjs';
import { POLICY, Q } from '../model-dataset-policy.mjs';
export function distribution(rows, key, values = null) {
  const counts = new Map((values || []).map(v => [v, 0]));
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return (values || [...counts.keys()].sort((a, b) => a === null ? -1 : b === null ? 1 : compare(a, b))).map(value => ({ value, count: counts.get(value) || 0 }));
}
export function metrics(values) {
  if (!values.length) return { min: null, mean: null, median: null, max: null };
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { min: sorted[0], mean: Q(values.reduce((a, b) => a + b, 0) / n),
    median: Q(n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2), max: sorted.at(-1) };
}
const eventDistributions = events => ({ gt_label: distribution(events, 'gt_label', [...POLICY.labels, null]),
  gt_status: distribution(events, 'gt_status', POLICY.statuses), city: distribution(events, 'city') });
const sampleDistributions = rows => ({ lead_time_bucket: distribution(rows, 'lead_time_bucket', POLICY.lead_buckets),
  model_version: distribution(rows, 'model_version'), engine_build_sha: distribution(rows, 'engine_build_sha'), config_hash: distribution(rows, 'config_hash') });
export function statistics(events, rows, counts, inputSummary, version = 2) {
  const primary = events.filter(e => e.eligibility === 'PRIMARY');
  const summarize = (es, rs) => ({ events: es.length, samples: rs.length,
    date_range: es.length ? { from: es[0].event_date_local, to: es.at(-1).event_date_local } : null,
    event_distributions: { ...eventDistributions(es), ...(version === 2 ? { gt_basis: distribution(es, 'gt_basis', POLICY.basis_order) } : {}) }, sample_distributions: sampleDistributions(rs) });
  return { counts, ...(version === 2 ? { basis_distribution: distribution(events, 'gt_basis', POLICY.basis_order) } : {}),
    splits: Object.fromEntries(POLICY.splits.map(k => [k, summarize(events.filter(e => e.split === k), rows.filter(r => r.split === k))])),
    eligibility: Object.fromEntries(POLICY.eligibility.map(k => [k, summarize(events.filter(e => e.eligibility === k), rows.filter(r => r.eligibility === k))])),
    primary_snapshots_per_event: metrics(primary.map(e => e.primary_snapshot_count)),
    total_snapshots_per_event: distribution(events.map(e => ({ count: e.primary_snapshot_count + e.diagnostic_snapshot_count + e.excluded_snapshot_count })), 'count',
      [...new Set(events.map(e => e.primary_snapshot_count + e.diagnostic_snapshot_count + e.excluded_snapshot_count))].sort((a, b) => a - b)),
    gt_confidence: { all_events: metrics(events.map(e => e.gt_confidence)), primary_events: metrics(primary.map(e => e.gt_confidence)) },
    input_validation_summary: inputSummary };
}
