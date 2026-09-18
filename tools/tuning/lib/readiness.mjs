import { formatMetric } from '../../evaluation/metrics.mjs';
import { cohortProfiles } from './metrics.mjs';
import { tuningPolicy } from '../tuning-policy.mjs';

/**
 * Global Tuning Readiness. NOT_READY blocks Sensitivity entirely; EXPLORATORY allows the run
 * but marks the package EXPLORATORY_ONLY; TUNING_READY is required before formal optimisation.
 */
export function computeGlobalReadiness({ profiles, replaySummary, integrity }) {
  const policy = tuningPolicy();
  const thresholds = policy.readiness_thresholds;
  const reasons = [];

  for (const check of integrity.checks) if (!check.ok) reasons.push(check.id);

  if (profiles.primary_events < thresholds.min_train_primary_events) reasons.push('TRAIN_PRIMARY_EVENTS_BELOW_MINIMUM');
  if (profiles.unique_dates < thresholds.min_train_unique_dates) reasons.push('TRAIN_UNIQUE_DATES_BELOW_MINIMUM');
  if (replaySummary.replay_usable_rate < thresholds.required_replay_usable_rate) reasons.push('REPLAY_USABLE_RATE_BELOW_REQUIRED');
  if (profiles.gt_levels < thresholds.min_gt_levels) reasons.push('GT_LEVELS_BELOW_MINIMUM');
  const thinnest = Object.values(profiles.gt_level_event_counts);
  if (thinnest.length < thresholds.min_gt_levels || Math.min(...thinnest) < thresholds.min_events_per_gt_level) {
    reasons.push('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM');
  }
  if (profiles.max_date_event_share > thresholds.max_single_date_event_share) reasons.push('SINGLE_DATE_EVENT_SHARE_ABOVE_MAXIMUM');
  if (profiles.max_city_event_share > thresholds.max_single_city_event_share) reasons.push('SINGLE_CITY_EVENT_SHARE_ABOVE_MAXIMUM');

  const blocking = new Set(['UPSTREAM_SOURCE_LINKED_FAILED', 'REPLAY_PARITY_FAILED', 'REGISTRY_AUDIT_FAILED',
    'ALIAS_IDENTITY_BROKEN', 'BASE_CONFIG_INVALID', 'COMPOSITION_PARITY_FAILED', 'RUNTIME_IMPORT_GRAPH_DRIFT']);
  const global = reasons.some(reason => blocking.has(reason)) ? 'NOT_READY'
    : (reasons.length ? 'EXPLORATORY' : 'TUNING_READY');

  return {
    global_readiness: global,
    reasons: [...new Set(reasons)].sort(),
    thresholds,
    metrics: {
      samples: profiles.samples,
      primary_events: profiles.primary_events,
      unique_dates: profiles.unique_dates,
      gt_levels: profiles.gt_levels,
      gt_level_event_counts: profiles.gt_level_event_counts,
      max_date_event_share: formatMetric(profiles.max_date_event_share),
      max_city_event_share: formatMetric(profiles.max_city_event_share),
      replay_usable_rate: formatMetric(replaySummary.replay_usable_rate),
      replay_pass_count: replaySummary.pass_count,
      replay_fail_count: replaySummary.fail_count
    }
  };
}

export function readinessFromCohort({ cohort, profiles }) {
  return {
    samples: profiles.samples,
    primary_events: profiles.primary_events,
    unique_dates: profiles.unique_dates,
    events: cohort.length
  };
}

/**
 * Per-parameter readiness combines wiring status, data support and observed response.
 * Wiring status is evaluated first: a partially wired parameter can never be READY.
 */
export function parameterReadiness({ unit, support, response, stability }) {
  const policy = tuningPolicy();
  const thresholds = policy.parameter_thresholds;
  const observable = policy.observability;

  if (unit.unit_category === 'DIAGNOSTIC' || unit.optimizable === false) {
    return {
      parameter_readiness: 'EXCLUDED',
      observability_status: 'NOT_EVALUATED',
      reason_code: unit.reason_code || 'DIAGNOSTIC_UNIT_EXCLUDED'
    };
  }
  if (unit.wired_status !== 'WIRED') {
    return { parameter_readiness: 'EXCLUDED', observability_status: 'NOT_EVALUATED', reason_code: 'WIRING_STATUS_NOT_READY' };
  }
  if (support.support_events < thresholds.min_support_events || support.support_dates < thresholds.min_support_dates) {
    return { parameter_readiness: 'INSUFFICIENT_SUPPORT', observability_status: 'NOT_EVALUATED', reason_code: 'SUPPORT_BELOW_MINIMUM' };
  }
  if (!response) {
    // Readiness without experiments: support decides, observability stays unevaluated.
    const ready = support.support_events >= thresholds.ready_events && support.support_dates >= thresholds.ready_dates;
    return {
      parameter_readiness: ready ? 'READY' : 'EXPLORATORY',
      observability_status: 'NOT_EVALUATED',
      reason_code: 'OBSERVABILITY_REQUIRES_SENSITIVITY_RUN'
    };
  }
  const changedRate = response.max_changed_score_rate;
  const observability = changedRate === observable.not_observable_changed_rate ? 'NOT_OBSERVABLE'
    : (changedRate < observable.partially_observable_changed_rate ? 'PARTIALLY_OBSERVABLE' : 'OBSERVABLE');
  if (observability === 'NOT_OBSERVABLE') {
    return { parameter_readiness: 'NOT_OBSERVABLE', observability_status: observability, reason_code: 'NO_SCORE_RESPONSE_ON_COHORT' };
  }
  const ready = support.support_events >= thresholds.ready_events && support.support_dates >= thresholds.ready_dates &&
    stability && !stability.limited_date_coverage;
  return {
    parameter_readiness: ready ? 'READY' : 'EXPLORATORY',
    observability_status: observability,
    reason_code: ready ? null : 'SUPPORT_BELOW_READY_THRESHOLD'
  };
}
