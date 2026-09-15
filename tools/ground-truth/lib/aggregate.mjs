import { compare, fail, safeId } from '../../dataset/lib/common.mjs';
import { POLICY, LABELS, SOURCES, Q, clamp, groundTruthPolicy } from '../ground-truth-policy.mjs';
export const order = (a, b) => compare(a.event_id, b.event_id) || compare(a.observation_id ?? a.id, b.observation_id ?? b.id);
export function contribution(row) {
  safeId(row.id); safeId(row.event_id);
  if (!LABELS.includes(row.rating) || !SOURCES.includes(row.source) ||
      !(row.confidence === null || Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1) ||
      !(row.evidence_count === null || Number.isSafeInteger(row.evidence_count) && row.evidence_count >= 0 && row.evidence_count <= 10000)) fail('RAW_INPUT_INVALID');
  const p = POLICY.observation_confidence;
  const factor = row.confidence === null ? p.missing : p.base + p.multiplier * row.confidence;
  return { event_id: row.event_id, observation_id: row.id, source: row.source, rating: row.rating,
    ordinal: LABELS.indexOf(row.rating), confidence: row.confidence, evidence_count: row.evidence_count,
    source_weight: POLICY.source_weights[row.source], confidence_factor: factor,
    effective_weight: Q(POLICY.source_weights[row.source] * factor), included: true, exclusion_reason: null };
}
export function weightedMedian(rows, value = x => x.ordinal) {
  const bins = [0, 0, 0, 0, 0]; let total = 0;
  for (const row of rows) { bins[value(row)] += row.effective_weight; total += row.effective_weight; }
  let cumulative = 0;
  for (let k = 0; k < bins.length; k++) {
    cumulative += bins[k];
    if (bins[k] > 0 && Q(cumulative / total) >= 0.5) return k;
  }
  fail('GT_VALIDATION_FAILED');
}
export function statusFor(n, effective, consensus, spread) {
  const t = POLICY.thresholds;
  if (!n) return 'UNLABELED';
  if (spread >= t.disputed_spread || consensus < t.disputed_consensus) return 'DISPUTED';
  if (n === 1 || effective < t.weak_effective_n) return 'WEAK';
  if (effective >= t.strong_effective_n && consensus >= t.strong_consensus && spread <= t.strong_spread) return 'STRONG';
  return 'MEDIUM';
}
export function aggregateEvent(event, rows, policy = POLICY) {
  const out = { event_id: event.event_id, event_date_local: event.event_date_local, city: event.city,
    gt_label: null, gt_ordinal: null, weighted_ordinal_mean: null, gt_confidence: 0, gt_status: 'UNLABELED',
    observation_count: rows.length, effective_n: 0, source_count: 0, consensus_ratio: null,
    normalized_entropy: null, ordinal_mad: null, min_ordinal: null, max_ordinal: null,
    user_count: 0, rednote_agent_count: 0, rednote_manual_count: 0 };
  const admin = policy.gt_policy_version === 2 ? rows.filter(r => r.source === policy.admin_adjudication.source) : [];
  if (admin.length > 1) fail('MULTIPLE_ADMIN_OBSERVATIONS');
  if (policy.gt_policy_version === 2) out.gt_basis = admin.length ? 'ADMIN_ADJUDICATED' : 'OBSERVATION_AGGREGATED';
  if (!rows.length) return out;
  const bins = [0, 0, 0, 0, 0]; let w = 0, squared = 0, mean = 0;
  for (const r of rows) {
    w += r.effective_weight; squared += r.effective_weight ** 2; mean += r.effective_weight * r.ordinal;
    bins[r.ordinal] += r.effective_weight; out[`${r.source}_count`]++;
  }
  out.gt_ordinal = admin.length ? admin[0].ordinal : weightedMedian(rows); out.gt_label = LABELS[out.gt_ordinal];
  out.weighted_ordinal_mean = Q(mean / w); out.effective_n = Q(w ** 2 / squared);
  out.consensus_ratio = Q(clamp(bins[out.gt_ordinal] / w));
  out.normalized_entropy = Q(clamp(-bins.reduce((sum, b) => b ? sum + b / w * Math.log(b / w) : sum, 0) / Math.log(LABELS.length)));
  out.ordinal_mad = weightedMedian(rows, r => Math.abs(r.ordinal - out.gt_ordinal));
  out.min_ordinal = bins.findIndex(x => x > 0); out.max_ordinal = bins.findLastIndex(x => x > 0);
  out.source_count = SOURCES.filter(s => out[`${s}_count`]).length;
  const spread = out.max_ordinal - out.min_ordinal, c = POLICY.confidence;
  out.gt_status = statusFor(rows.length, out.effective_n, out.consensus_ratio, spread);
  if (admin.length && out.gt_status === 'WEAK') out.gt_status = 'MEDIUM';
  const agreement = c.consensus * out.consensus_ratio + c.entropy * (1 - out.normalized_entropy) + c.spread * (1 - Q(spread / 4));
  out.gt_confidence = Q(clamp(Math.min(Math.min(1, out.effective_n / c.support_n) * agreement, c.caps[out.gt_status])));
  if (admin.length && out.gt_status === 'MEDIUM') out.gt_confidence = Q(Math.min(c.caps.MEDIUM, Math.max(policy.admin_adjudication.medium_confidence_floor, out.gt_confidence)));
  return out;
}
export function derive(events, observations, policyVersion = 1, onEvent = () => {}) {
  const policy = groundTruthPolicy(policyVersion);
  const contributions = observations.map(contribution).sort(order), groups = new Map();
  for (const r of contributions) { if (!groups.has(r.event_id)) groups.set(r.event_id, []); groups.get(r.event_id).push(r); }
  const gt = [...events].sort((a, b) => compare(a.event_id, b.event_id)).map((e, i) => { const row = aggregateEvent(e, groups.get(e.event_id) || [], policy); onEvent(i + 1, events.length); return row; });
  const agreement = POLICY.source_pairs.map(([a, b]) => {
    const differences = [];
    for (const e of gt) {
      const rows = groups.get(e.event_id) || [], left = rows.filter(r => r.source === a), right = rows.filter(r => r.source === b);
      if (left.length && right.length) differences.push(weightedMedian(right) - weightedMedian(left));
    }
    const n = differences.length;
    return { source_a: a, source_b: b, paired_event_count: n,
      exact_agreement_rate: n ? Q(differences.filter(x => x === 0).length / n) : null,
      within_1_level_rate: n ? Q(differences.filter(x => Math.abs(x) <= 1).length / n) : null,
      mean_ordinal_difference: n ? Q(differences.reduce((s, x) => s + x, 0) / n) : null,
      mean_absolute_ordinal_difference: n ? Q(differences.reduce((s, x) => s + Math.abs(x), 0) / n) : null };
  });
  const labeled = gt.filter(x => x.gt_status !== 'UNLABELED');
  const confidence = rows => {
    const xs = rows.map(x => x.gt_confidence).sort((a, b) => a - b), n = xs.length;
    return { mean: n ? Q(xs.reduce((s, x) => s + x, 0) / n) : null,
      median: n ? Q((xs[Math.floor((n - 1) / 2)] + xs[Math.floor(n / 2)]) / 2) : null };
  };
  const counts = new Map(); for (const e of gt) counts.set(e.observation_count, (counts.get(e.observation_count) || 0) + 1);
  const statistics = { total_events: gt.length, labeled_events: labeled.length, unlabeled_events: gt.length - labeled.length,
    label_coverage_ratio: gt.length ? Q(labeled.length / gt.length) : 0,
    status_counts: Object.fromEntries(POLICY.status_order.map(s => [s, gt.filter(e => e.gt_status === s).length])),
    label_distribution: LABELS.map(label => ({ label, count: labeled.filter(e => e.gt_label === label).length })),
    observations_per_event: [...counts].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count })),
    source_distribution: SOURCES.map(source => ({ source, count: contributions.filter(r => r.source === source).length })),
    gt_confidence: { all_events: confidence(gt), labeled_events: confidence(labeled) }, source_agreement: agreement };
  if (policyVersion === 2) statistics.basis_distribution = policy.basis_order.map(value => ({ value, count: gt.filter(e => e.gt_basis === value).length }));
  return { gt, contributions, agreement, statistics, ...(policyVersion === 2 ? { policy_version: 2 } : {}) };
}
