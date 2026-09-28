import { canonicalJson, fail, hash, unique } from '../dataset/lib/common.mjs';
import { validationSelectionRuleDocument } from '../optimization/lib/finalist.mjs';

export const VALIDATION_SCHEMA_VERSION = 1;
export const VALIDATION_POLICY_VERSION = 1;
export const VALIDATION_MODES = Object.freeze(['DEVELOPMENT_VALIDATION', 'FORMAL_VALIDATION']);

export const POLICY_V1 = Object.freeze({
  validation_schema_version: VALIDATION_SCHEMA_VERSION,
  validation_policy_version: VALIDATION_POLICY_VERSION,
  selection_adapter: 'OPTIMIZATION_V1_TO_VALIDATION_V1',
  evaluated_split: 'VALIDATION',
  forbidden_split: 'TEST',
  benchmark: 'ALL_PRIMARY',
  diagnostic_benchmark: 'CLOSEST_PRE_SUNSET',
  support: Object.freeze({
    min_primary_events: 30,
    min_dates: 7,
    min_gt_levels: 3,
    min_events_per_present_level: 5,
    max_single_city_share: 0.5,
    max_single_date_share: 0.35,
    slice_min_events: 5,
    slice_min_dates: 2
  }),
  bootstrap: Object.freeze({ algorithm: 'DATE_BLOCK_PERCENTILE_BOOTSTRAP_V1',
    prng: 'xorshift32-v1', replicates: 2000, lower_quantile: 0.025, upper_quantile: 0.975 }),
  numeric: Object.freeze({ precision_decimal_places: 12, epsilon: 1e-12 })
});

export function validationPolicy(version = 1) {
  if (version !== 1) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_POLICY' });
  return POLICY_V1;
}

export function effectiveSelectionPolicy(sourceRule) {
  const expected = validationSelectionRuleDocument();
  if (canonicalJson(sourceRule) !== canonicalJson(expected)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'SELECTION_RULE_UNSUPPORTED' });
  }
  return {
    adapter: POLICY_V1.selection_adapter,
    source_validation_selection_rule_sha256: hash(canonicalJson(sourceRule)),
    evaluated_split: 'VALIDATION',
    epsilon: POLICY_V1.numeric.epsilon,
    coverage: { control_source: 1, candidate_control: 1 },
    eligibility: [...sourceRule.eligibility, 'SUPPORTED_SLICE_NO_DOUBLE_REGRESSION',
      'DATE_BLOCK_BOOTSTRAP_CI_UPPER_STRICTLY_NEGATIVE'],
    ranking: [...sourceRule.ranking],
    on_no_validation_pass: 'NO_ELIGIBLE_CANDIDATE'
  };
}

export function validationSupport(rows) {
  const events = new Map();
  for (const row of rows) {
    if (!row.event_id || !row.location_key || !row.event_date_local ||
        !Number.isInteger(row.gt_ordinal) || row.gt_ordinal < 0 || row.gt_ordinal > 4) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'VALIDATION_IDENTITY_INVALID' });
    }
    const prior = events.get(row.event_id);
    if (prior && (prior.location_key !== row.location_key ||
        prior.event_date_local !== row.event_date_local || prior.gt_ordinal !== row.gt_ordinal)) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'EVENT_GT_INCONSISTENCY' });
    }
    events.set(row.event_id, row);
  }
  const values = [...events.values()];
  const tally = key => Object.fromEntries(unique(values.map(key)).map(value =>
    [value, values.filter(row => String(key(row)) === value).length]));
  const byLevel = tally(row => String(row.gt_ordinal));
  const byCity = tally(row => row.location_key);
  const byDate = tally(row => row.event_date_local);
  const n = values.length;
  const s = POLICY_V1.support;
  const reasons = [];
  if (n < s.min_primary_events) reasons.push('PRIMARY_EVENTS_BELOW_MINIMUM');
  if (Object.keys(byDate).length < s.min_dates) reasons.push('DATES_BELOW_MINIMUM');
  if (Object.keys(byLevel).length < s.min_gt_levels) reasons.push('GT_LEVELS_BELOW_MINIMUM');
  if (Object.values(byLevel).some(count => count < s.min_events_per_present_level)) reasons.push('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM');
  if (n && Math.max(...Object.values(byCity)) / n > s.max_single_city_share) reasons.push('CITY_CONCENTRATION_TOO_HIGH');
  if (n && Math.max(...Object.values(byDate)) / n > s.max_single_date_share) reasons.push('DATE_CONCENTRATION_TOO_HIGH');
  return {
    sample_count: rows.length, event_count: n, date_count: Object.keys(byDate).length,
    by_level: byLevel, by_city: byCity, by_date: byDate,
    status: reasons.length ? 'INSUFFICIENT' : 'READY', reasons
  };
}
