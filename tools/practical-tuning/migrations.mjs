import { fail } from '../dataset/lib/common.mjs';
import { weightedRows } from '../product-evaluation/metrics.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { q } from './policy.mjs';

export const MIGRATION_KEYS = ['recovered_from_2', 'recovered_from_0_1', 'recognized_high_lost', 'new_ge3_false_alarms', 'ge3_false_alarms_removed'];
export function pairedMigrations(rows, baselineScores, candidateScores) {
  if (rows.length !== baselineScores.length || rows.length !== candidateScores.length) fail('MIGRATION_COHORT_MISMATCH');
  // Join predictions before weightedRows sorts. Normalize once on the entire cohort, never on migration subsets.
  const full = weightedRows(rows.map((r, i) => ({ ...r, before: scoreToOrdinal(baselineScores[i]), after: scoreToOrdinal(candidateScores[i]) })));
  const sum = rs => rs.reduce((n, r) => n + r.weight, 0);
  const summarize = rs => ({ snapshot_count: rs.length, event_count: new Set(rs.map(r => r.event_id)).size, weighted_amount: q(sum(rs)) });
  const filters = [r => r.gt_ordinal >= 3 && r.before === 2 && r.after >= 3,
    r => r.gt_ordinal >= 3 && r.before <= 1 && r.after >= 3,
    r => r.gt_ordinal >= 3 && r.before >= 3 && r.after < 3,
    r => r.gt_ordinal <= 2 && r.before < 3 && r.after >= 3,
    r => r.gt_ordinal <= 2 && r.before >= 3 && r.after < 3];
  const subsets = filters.map(f => full.filter(f)), target = full.filter(r => r.gt_ordinal >= 3), targetWeight = sum(target);
  const net = sum(subsets[0]) + sum(subsets[1]) - sum(subsets[2]);
  const before = sum(target.filter(r => r.before >= 3)), after = sum(target.filter(r => r.after >= 3));
  return { weight_basis: 'FULL_POOL_EVENT_NORMALIZED_NO_SUBSET_RENORMALIZATION', event_counts_are_non_additive: true,
    ...Object.fromEntries(MIGRATION_KEYS.map((key, i) => [key, summarize(subsets[i])])),
    new_false_alarms_by_actual: [0, 1, 2].map(ordinal => ({ ordinal, ...summarize(subsets[3].filter(r => r.gt_ordinal === ordinal)) })),
    net_recovered_weight: q(net), gt_ge3_weighted_support: q(targetWeight),
    recall_ge3_delta_from_net: targetWeight ? q(net / targetWeight) : null,
    recall_ge3_delta: targetWeight ? q(after / targetWeight - before / targetWeight) : null };
}

export function migrationCsvFields(record) {
  const m = record.paired_migrations;
  return Object.fromEntries([
    ...MIGRATION_KEYS.flatMap(k => ['snapshot_count', 'event_count', 'weighted_amount'].map(unit => [`${k}_${unit}`, m?.[k][unit] ?? null])),
    ...[0, 1, 2].flatMap(y => ['snapshot_count', 'event_count', 'weighted_amount'].map(unit => [`new_false_actual${y}_${unit}`, m?.new_false_alarms_by_actual[y][unit] ?? null])),
    ...['net_recovered_weight', 'gt_ge3_weighted_support', 'recall_ge3_delta_from_net'].map(k => [k, m?.[k] ?? null])]);
}
