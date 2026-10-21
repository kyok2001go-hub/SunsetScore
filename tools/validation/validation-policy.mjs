import { canonicalJson, fail, hash, unique } from '../dataset/lib/common.mjs';
import { validationSelectionRuleDocument } from '../optimization/lib/finalist.mjs';
import { optimizationPolicy } from '../optimization/optimization-policy.mjs';
import { gtLevelSupport, SUPPORT_POLICY, supportCohort, supportDigest } from '../gt-level-support.mjs';
import { formalContextIdentity, inspectFormalContext } from '../formal/context.mjs';

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

export const POLICY_V2 = Object.freeze({ ...POLICY_V1, validation_policy_version: 2,
  selection_adapter: 'OPTIMIZATION_V2_TO_VALIDATION_V2', gt_level_support_policy: SUPPORT_POLICY,
  required_optimization_policy_version: 2, formal_capable: false });
export const POLICY_V3 = Object.freeze({ ...POLICY_V2, validation_schema_version: 2, validation_policy_version: 3,
  selection_adapter: 'OPTIMIZATION_V3_TO_VALIDATION_V3', required_optimization_policy_version: 3,
  formal_contract_revision: 1, formal_capable: true });
export const POLICY_V4 = Object.freeze({ ...POLICY_V2, validation_schema_version: 2, validation_policy_version: 4,
  selection_adapter: 'OPTIMIZATION_V4_TO_DEVELOPMENT_VALIDATION_V4', required_optimization_policy_version: 4,
  modes: ['DEVELOPMENT_VALIDATION'], result_usage: 'DEVELOPMENT_ONLY', formal_capable: false });
export const POLICY_V5=Object.freeze({...POLICY_V4,validation_policy_version:5,required_optimization_policy_version:5,
  selection_adapter:'PRODUCT_EVALUATION_1_TO_DEVELOPMENT_VALIDATION_5',product_evaluation_policy_version:1,
  qualification_contract:'FROZEN_PRODUCT_POLICY_1_NOT_LEGACY_FORMAL_GATES',test_effect_access:false,
  result_files:['schema.json','policy.json','product_policy.json','plan.json','source_manifest.json','candidate_sample_predictions.json','candidate_product_metrics.json','legacy_gate_comparison.json','slice_metrics.json','bootstrap.json','decision.json','reports/summary.md']});

export function validationPolicy(version = 1) {
  if (![1, 2, 3, 4, 5].includes(version)) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_POLICY' });
  return version === 5 ? POLICY_V5 : version === 4 ? POLICY_V4 : version === 3 ? POLICY_V3 : version === 2 ? POLICY_V2 : POLICY_V1;
}

export function effectiveSelectionPolicy(sourceRule, version = 1) {
  const policy = validationPolicy(version);
  const expected = validationSelectionRuleDocument(optimizationPolicy(version));
  if (canonicalJson(sourceRule) !== canonicalJson(expected)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'SELECTION_RULE_UNSUPPORTED' });
  }
  return {
    adapter: policy.selection_adapter,
    source_validation_selection_rule_sha256: hash(canonicalJson(sourceRule)),
    evaluated_split: 'VALIDATION',
    epsilon: policy.numeric.epsilon,
    coverage: { control_source: 1, candidate_control: 1 },
    eligibility: [...sourceRule.eligibility, 'SUPPORTED_SLICE_NO_DOUBLE_REGRESSION',
      'DATE_BLOCK_BOOTSTRAP_CI_UPPER_STRICTLY_NEGATIVE'],
    ranking: [...sourceRule.ranking],
    on_no_validation_pass: 'NO_ELIGIBLE_CANDIDATE'
  };
}

export function validationSupport(rows, version = 1) {
  const support = version >= 2 ? gtLevelSupport(rows, 'VALIDATION') : null;
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
  const s = validationPolicy(version).support;
  const reasons = [];
  if (n < s.min_primary_events) reasons.push('PRIMARY_EVENTS_BELOW_MINIMUM');
  if (Object.keys(byDate).length < s.min_dates) reasons.push('DATES_BELOW_MINIMUM');
  if (!support && Object.keys(byLevel).length < s.min_gt_levels) reasons.push('GT_LEVELS_BELOW_MINIMUM');
  if (!support && Object.values(byLevel).some(count => count < s.min_events_per_present_level)) reasons.push('GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM');
  if (support) reasons.push(...support.reasons);
  if (n && Math.max(...Object.values(byCity)) / n > s.max_single_city_share) reasons.push('CITY_CONCENTRATION_TOO_HIGH');
  if (n && Math.max(...Object.values(byDate)) / n > s.max_single_date_share) reasons.push('DATE_CONCENTRATION_TOO_HIGH');
  return {
    sample_count: rows.length, event_count: n, date_count: Object.keys(byDate).length,
    by_level: byLevel, by_city: byCity, by_date: byDate,
    status: reasons.length ? 'INSUFFICIENT' : 'READY', reasons: version >= 2 ? [...new Set(reasons)].sort() : reasons,
    ...(support ? { gt_level_support: support, gt_level_support_sha256: supportDigest(support),
      warnings: support.warnings } : {})
  };
}

export function auditSupportPlan(core) {
  const version = core.validation_policy_version ?? 1;
  validationPolicy(version);
  if (version < 2) return;
  const check = (ok, reason_code) => { if (!ok) fail('VALIDATION_VALIDATION_FAILED', { reason_code }); };
  const equal = (a, b, reason) => check(canonicalJson(a) === canonicalJson(b), reason);
  equal(core.policy, validationPolicy(version), 'PLAN_POLICY_MISMATCH');
  if (version === 4) check(core.mode === 'DEVELOPMENT_VALIDATION' && core.result_usage === 'DEVELOPMENT_ONLY' &&
    core.validation_schema_version === 2 && typeof core.diagnostic_plan_id === 'string' && typeof core.diagnostic_id === 'string' &&
    core.validation_disclosure_status === 'DEVELOPMENT_EXPOSED', 'POLICY_4_DEVELOPMENT_REQUIRED');
  const cohort = supportCohort(core.gt_level_support_cohort);
  equal(cohort.map(({ snapshot_id, event_id, location_key, event_date_local }) =>
    ({ snapshot_id, event_id, location_key, event_date_local })),
  [...core.validation_members].sort((a, b) => a.snapshot_id < b.snapshot_id ? -1 : a.snapshot_id > b.snapshot_id ? 1 : 0),
  'SUPPORT_MEMBERSHIP_MISMATCH');
  equal(core.validation_members_sha256, hash(canonicalJson(core.validation_members)), 'SUPPORT_MEMBERSHIP_SHA_MISMATCH');
  const support = validationSupport(cohort, version);
  equal(core.support, support, 'PLAN_SUPPORT_MISMATCH');
  equal(core.gt_level_support, support.gt_level_support, 'GT_LEVEL_SUPPORT_MISMATCH');
  equal(core.gt_level_support_sha256, support.gt_level_support_sha256, 'GT_LEVEL_SUPPORT_SHA_MISMATCH');
  const upstream = core.upstream_train_support;
  check(upstream?.gt_level_support?.split === 'TRAIN' &&
    upstream.gt_level_support_sha256 === supportDigest(upstream.gt_level_support), 'UPSTREAM_SUPPORT_MISMATCH');
  equal(upstream.limitation_codes, upstream.gt_level_support.limitation_codes, 'UPSTREAM_LIMITATION_MISMATCH');
  equal(upstream.conclusion_limitations, upstream.gt_level_support.conclusion_limitations, 'UPSTREAM_LIMITATION_MISMATCH');
  if (core.source?.sensitivity) check(upstream.sensitivity_id === core.source.sensitivity.id, 'UPSTREAM_SUPPORT_ID_MISMATCH');
  const selection = effectiveSelectionPolicy(core.source_validation_selection_rule, version);
  equal(selection, core.effective_selection_policy, 'PLAN_SELECTION_POLICY_MISMATCH');
  equal(hash(canonicalJson(selection)), core.effective_selection_policy_sha256, 'PLAN_SELECTION_SHA_MISMATCH');
  equal(selection.source_validation_selection_rule_sha256, core.source_validation_selection_rule_sha256,
    'PLAN_SOURCE_RULE_SHA_MISMATCH');
  if (version === 3) {
    const context = inspectFormalContext(core.formal_context);
    for (const [key, value] of Object.entries(formalContextIdentity(context))) equal(core[key], value, 'FORMAL_PLAN_CONTEXT_MISMATCH');
    check(core.mode === 'FORMAL_VALIDATION' && core.validation_schema_version === 2 &&
      ['FORMAL', 'TEST_FIXTURE_ONLY'].includes(core.result_usage), 'POLICY_3_FORMAL_REQUIRED');
    if (core.status === 'READY_FORMAL') check(core.support.status === 'READY' && core.candidates.length > 0 &&
      core.candidates.length <= 5 && core.runtime_compatibility?.status === 'ATTESTED_RUNTIME_BUNDLE_BYTES', 'FORMAL_PLAN_NOT_READY');
  } else check(core.mode === 'DEVELOPMENT_VALIDATION' && core.result_usage === 'DEVELOPMENT_ONLY', 'POLICY_2_FORMAL_FORBIDDEN');
}
