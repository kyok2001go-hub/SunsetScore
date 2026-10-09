import { canonicalJson, compare, fail, hash } from './dataset/lib/common.mjs';
import { computeHeadlineMetrics } from './evaluation/metrics.mjs';

export const SUPPORT_POLICY = Object.freeze({
  support_policy_id: 'EXCELLENT_SOFT_SUPPORT', support_policy_version: 1,
  count_unit: 'EVENT', min_supported_levels: 3, min_events_per_supported_level: 5,
  rare_gt_levels: Object.freeze([Object.freeze({ gt_level: 'excellent', ordinal: 4 })])
});
export const GT_LEVELS = Object.freeze(['poor', 'fair', 'good', 'very_good', 'excellent']);
export const SUPPORT_FILE = 'gt_level_support.json';

// The entire frozen Primary cohort, not the successful Replay subset, supplies support.
export function supportCohort(rows) {
  const snapshots = new Set(), events = new Map();
  const cohort = rows.map(row => {
    if (![row.snapshot_id, row.event_id, row.location_key, row.event_date_local]
      .every(value => typeof value === 'string' && value.trim()) ||
      !Number.isInteger(row.gt_ordinal) || row.gt_ordinal < 0 || row.gt_ordinal > 4 ||
      !Number.isFinite(row.gt_confidence) || row.gt_confidence <= 0 || row.gt_confidence > 1) {
      fail('GT_LEVEL_SUPPORT_INVALID', { reason_code: 'COHORT_IDENTITY_INVALID' });
    }
    if (snapshots.has(row.snapshot_id)) fail('GT_LEVEL_SUPPORT_INVALID', { reason_code: 'DUPLICATE_SNAPSHOT' });
    snapshots.add(row.snapshot_id);
    const member = Object.fromEntries(['snapshot_id', 'event_id', 'location_key', 'event_date_local',
      'gt_ordinal', 'gt_confidence'].map(key => [key, row[key]]));
    member.city = typeof row.city === 'string' ? row.city : row.location_key;
    const prior = events.get(row.event_id);
    if (prior && ['location_key', 'event_date_local', 'gt_ordinal', 'gt_confidence']
      .some(key => prior[key] !== member[key])) {
      fail('GT_LEVEL_SUPPORT_INVALID', { reason_code: 'EVENT_GT_INCONSISTENCY' });
    }
    events.set(row.event_id, member);
    return member;
  });
  return cohort.sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
}

export function gtLevelSupport(rows, split = 'TRAIN') {
  if (!['TRAIN', 'VALIDATION'].includes(split)) fail('GT_LEVEL_SUPPORT_INVALID', { reason_code: 'INVALID_SPLIT' });
  const cohort = supportCohort(rows);
  const byLevel = GT_LEVELS.map((gt_level, ordinal) => {
    const subset = cohort.filter(row => row.gt_ordinal === ordinal);
    const eventCount = new Set(subset.map(row => row.event_id)).size;
    return { gt_level, ordinal, event_count: eventCount, snapshot_count: subset.length,
      date_count: new Set(subset.map(row => row.event_date_local)).size,
      status: eventCount === 0 ? 'ABSENT' : eventCount < 5 ? 'INSUFFICIENT' : 'SUPPORTED' };
  });
  const supported = byLevel.filter(row => row.status === 'SUPPORTED').map(row => row.gt_level);
  const thin = byLevel.filter(row => row.ordinal !== 4 && row.status === 'INSUFFICIENT');
  const rare = byLevel[4], reasons = [], warnings = [];
  if (supported.length < 3) reasons.push('SUPPORTED_GT_LEVELS_BELOW_MINIMUM');
  if (thin.length) reasons.push('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM');
  if (rare.status === 'ABSENT') warnings.push('EXCELLENT_GT_LEVEL_ABSENT');
  if (rare.status === 'INSUFFICIENT') warnings.push('EXCELLENT_GT_LEVEL_INSUFFICIENT_SUPPORT');
  return { ...SUPPORT_POLICY, split, by_level: byLevel,
    present_gt_levels: byLevel.filter(row => row.event_count > 0).map(row => row.gt_level),
    supported_gt_levels: supported, insufficient_non_rare_levels: thin,
    reasons: reasons.sort(compare), warnings,
    limitation_codes: rare.event_count < 5 ? ['EXCELLENT_PERFORMANCE_NOT_ESTABLISHED'] : [],
    conclusion_limitations: rare.event_count < 5 ? [
      `excellent（极佳）观测支持不足；整体结果${rare.event_count ? '包含可用的 excellent 样本' : '本轮没有可用的 excellent 样本'}，但不证明该等级的识别效果、改善或稳定性。`
    ] : [] };
}

export const supportDigest = support => hash(canonicalJson(support));

// Every rare Snapshot is audited, including missing pairs. These diagnostics never add gates.
export function rareLevelAudit(cohort, predictions, runId, failures = []) {
  const members = supportCohort(cohort).filter(row => row.gt_ordinal === 4);
  const byId = new Map();
  for (const row of predictions.filter(row => row.gt_ordinal === 4)) {
    if (byId.has(row.snapshot_id)) fail('GT_LEVEL_SUPPORT_INVALID', { reason_code: 'DUPLICATE_PREDICTION' });
    const member = members.find(item => item.snapshot_id === row.snapshot_id);
    if (!member || ['event_id', 'gt_ordinal', 'gt_confidence'].some(key => member[key] !== row[key]) ||
      ![row.control_ordinal, row.experiment_ordinal].every(value => Number.isInteger(value) && value >= 0 && value <= 4)) {
      fail('GT_LEVEL_SUPPORT_INVALID', { reason_code: 'PREDICTION_IDENTITY_INVALID' });
    }
    byId.set(row.snapshot_id, row);
  }
  const paired = [...byId.values()].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
  const counts = new Map();
  for (const row of paired) counts.set(row.event_id, (counts.get(row.event_id) || 0) + 1);
  const metrics = key => computeHeadlineMetrics(paired.map(row => ({ snapshot_id: row.snapshot_id,
    gt_ordinal: 4, predicted_ordinal: row[key], weight: row.gt_confidence / counts.get(row.event_id) })), 'weighted');
  const missing = members.filter(row => !byId.has(row.snapshot_id));
  const failureById = new Map(failures.map(row => [row.snapshot_id, row]));
  return { run_id: runId, usage: 'DIAGNOSTIC_ONLY',
    support: gtLevelSupport(cohort).by_level[4],
    paired_sample_count: paired.length, paired_event_count: counts.size,
    reason_code: paired.length ? null : members.length ? 'NO_PAIRED_SAMPLES' : 'NO_EXCELLENT_SAMPLES',
    control_metrics: metrics('control_ordinal'), experiment_metrics: metrics('experiment_ordinal'),
    predictions: paired.map(row => ({ snapshot_id: row.snapshot_id, event_id: row.event_id,
      gt_ordinal: 4, gt_confidence: row.gt_confidence,
      control_ordinal: row.control_ordinal, experiment_ordinal: row.experiment_ordinal,
      control_abs_error: Math.abs(row.control_ordinal - 4),
      experiment_abs_error: Math.abs(row.experiment_ordinal - 4) })),
    unpaired_snapshot_ids: missing.map(row => row.snapshot_id),
    ...(missing.length ? { unpaired_failures: missing.map(row => ({ snapshot_id: row.snapshot_id,
      event_id: row.event_id, phase: failureById.get(row.snapshot_id)?.phase ||
        failureById.get(row.snapshot_id)?.stage || 'PAIRING',
      error_code: failureById.get(row.snapshot_id)?.error_code || 'NO_PAIRED_REPLAY' })) } : {}) };
}

export function supportDocument(rows, split, runs = []) {
  const cohort = supportCohort(rows), support = gtLevelSupport(cohort, split);
  return { cohort, cohort_sha256: hash(canonicalJson(cohort)), gt_level_support: support,
    gt_level_support_sha256: supportDigest(support),
    rare_level_audit: runs.map(run => rareLevelAudit(cohort, run.rows, run.id, run.failures)) };
}

export function inspectSupportDocument(document, split, errorCode, sourceRows) {
  const rebuilt = supportDocument(document.cohort, split,
    document.rare_level_audit.map(run => ({ id: run.run_id, rows: run.predictions, failures: run.unpaired_failures })));
  if (canonicalJson(document) !== canonicalJson(rebuilt) || (sourceRows &&
    canonicalJson(document.cohort) !== canonicalJson(supportCohort(sourceRows)))) {
    fail(errorCode, { reason_code: 'GT_LEVEL_SUPPORT_MISMATCH' });
  }
  return document.gt_level_support;
}
