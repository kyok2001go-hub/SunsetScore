import { compare, unique } from '../../dataset/lib/common.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';
import { optimizationPolicy } from '../optimization-policy.mjs';

/**
 * Phase 6 readiness. EXPLORATORY_SEARCH still produces a complete package; FORMAL_OPTIMIZATION
 * additionally requires an upstream that can legally declare READY / FORMAL. The current
 * Sensitivity V2 policy pins PROVISIONAL_PROXY / EXPLORATORY_ONLY, so no amount of extra data
 * flips that flag: a newer upstream Policy has to.
 */

export function cohortProfile(rows) {
  const events = unique(rows.map(row => row.event_id));
  const byDate = new Map();
  const byCity = new Map();
  const ordinalByEvent = new Map();
  for (const row of rows) {
    if (!byDate.has(row.event_date_local)) byDate.set(row.event_date_local, new Set());
    byDate.get(row.event_date_local).add(row.event_id);
    const city = row.city ?? row.location_key ?? null;
    if (city !== null) {
      if (!byCity.has(city)) byCity.set(city, new Set());
      byCity.get(city).add(row.event_id);
    }
    if (!ordinalByEvent.has(row.event_id)) ordinalByEvent.set(row.event_id, row.gt_ordinal);
  }
  const levelCounts = {};
  for (const ordinal of ordinalByEvent.values()) {
    levelCounts[`ordinal_${ordinal}`] = (levelCounts[`ordinal_${ordinal}`] || 0) + 1;
  }
  const counts = Object.values(levelCounts);
  return {
    samples: rows.length,
    primary_events: events.length,
    unique_dates: byDate.size,
    gt_levels: counts.length,
    gt_level_event_counts: levelCounts,
    max_date_event_share: byDate.size ? Math.max(...[...byDate.values()].map(set => set.size)) / events.length : 0,
    max_city_event_share: byCity.size ? Math.max(...[...byCity.values()].map(set => set.size)) / events.length : 0,
    max_gt_level_event_share: counts.length ? Math.max(...counts) / events.length : 0
  };
}

function dataReadiness(profile, replayUsableRate) {
  const thresholds = optimizationPolicy().readiness_thresholds;
  const reasons = [];
  if (profile.primary_events < thresholds.min_train_primary_events) reasons.push('TRAIN_PRIMARY_EVENTS_BELOW_MINIMUM');
  if (profile.unique_dates < thresholds.min_train_unique_dates) reasons.push('TRAIN_UNIQUE_DATES_BELOW_MINIMUM');
  if (replayUsableRate < thresholds.required_replay_usable_rate) reasons.push('REPLAY_USABLE_RATE_BELOW_REQUIRED');
  if (profile.gt_levels < thresholds.min_gt_levels) reasons.push('GT_LEVELS_BELOW_MINIMUM');
  const counts = Object.values(profile.gt_level_event_counts);
  if (counts.length < thresholds.min_gt_levels || Math.min(...counts) < thresholds.min_events_per_gt_level) {
    reasons.push('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM');
  }
  if (profile.max_date_event_share > thresholds.max_single_date_event_share) reasons.push('SINGLE_DATE_EVENT_SHARE_ABOVE_MAXIMUM');
  if (profile.max_city_event_share > thresholds.max_single_city_event_share) reasons.push('SINGLE_CITY_EVENT_SHARE_ABOVE_MAXIMUM');
  return { status: reasons.length ? 'INSUFFICIENT' : 'READY', reasons: [...new Set(reasons)].sort(compare) };
}

function labelConcentration(profile) {
  const threshold = optimizationPolicy().readiness_thresholds.max_single_gt_level_event_share;
  const share = formatMetric(profile.max_gt_level_event_share);
  return {
    status: profile.max_gt_level_event_share <= threshold ? 'PASS' : 'FAIL',
    max_single_gt_level_event_share: share,
    threshold,
    gt_level_event_counts: profile.gt_level_event_counts
  };
}

export function computeOptimizationReadiness({ profile, replayUsableRate, sensitivityLinkage }) {
  const policy = optimizationPolicy();
  const engineering = {
    status: sensitivityLinkage.engineering_readiness?.status ?? 'UNKNOWN',
    reasons: [...(sensitivityLinkage.engineering_readiness?.reasons ?? [])]
  };
  const data = dataReadiness(profile, replayUsableRate);
  const metric = {
    status: sensitivityLinkage.metric_readiness?.status ?? 'UNKNOWN',
    reasons: [...(sensitivityLinkage.metric_readiness?.reasons ?? [])]
  };
  const concentration = labelConcentration(profile);
  const reasons = [];
  if (engineering.status !== policy.formal_preconditions.engineering_readiness) reasons.push('ENGINEERING_NOT_READY');
  if (data.status !== policy.formal_preconditions.data_readiness) reasons.push('DATA_SUPPORT_INSUFFICIENT', ...data.reasons);
  if (metric.status !== policy.formal_preconditions.metric_readiness) reasons.push('METRIC_NOT_READY', ...metric.reasons);
  if (sensitivityLinkage.result_usage !== policy.formal_preconditions.sensitivity_result_usage) {
    reasons.push('SENSITIVITY_RESULT_USAGE_NOT_FORMAL');
  }
  // Policy 2 permanently defines PROVISIONAL_PROXY / EXPLORATORY_ONLY. A tampered V2 manifest
  // must never unlock FORMAL; only a newer, separately versioned Tuning policy may do so.
  if (!Number.isInteger(sensitivityLinkage.tuning_policy_version) || sensitivityLinkage.tuning_policy_version <= 2) {
    reasons.push('SENSITIVITY_POLICY_NOT_FORMAL_CAPABLE');
  }
  if (concentration.status === 'FAIL') reasons.push('INSUFFICIENT_LABEL_BALANCE');
  const uniqueReasons = [...new Set(reasons)].sort(compare);
  const formal = uniqueReasons.length === 0;
  return {
    optimization_mode: formal ? 'FORMAL_OPTIMIZATION' : 'EXPLORATORY_SEARCH',
    optimization_readiness: formal ? 'READY' : 'EXPLORATORY',
    engineering_readiness: engineering,
    data_readiness: data,
    metric_readiness: metric,
    label_concentration: concentration,
    reasons: uniqueReasons,
    thresholds: policy.readiness_thresholds,
    metrics: {
      samples: profile.samples,
      primary_events: profile.primary_events,
      unique_dates: profile.unique_dates,
      gt_levels: profile.gt_levels,
      gt_level_event_counts: profile.gt_level_event_counts,
      max_date_event_share: formatMetric(profile.max_date_event_share),
      max_city_event_share: formatMetric(profile.max_city_event_share),
      replay_usable_rate: formatMetric(replayUsableRate)
    }
  };
}
