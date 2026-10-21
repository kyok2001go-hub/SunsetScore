import { fail } from '../dataset/lib/common.mjs';
import { optimizationPolicy } from '../optimization/optimization-policy.mjs';

export function diagnosticPolicy(version = 1) {
  if (version !== 1) fail('UNSUPPORTED_DIAGNOSTIC_POLICY');
  return { diagnostic_schema_version: 1, diagnostic_policy_version: 1, result_usage: 'DEVELOPMENT_ONLY',
    computation_split: 'TRAIN', forbidden_effect_splits: ['VALIDATION', 'TEST'],
    matrix_budget: 40, total_proposal_budget: 440, search_policy: optimizationPolicy(4),
    folds: { minimum_dates: 19, holdout_date_counts: [4, 3, 3], minimum_train_events: 30, minimum_train_dates: 7 },
    stability: { valid_folds: 3, minimum_improved_folds: 2, median_fold_delta_strictly_negative: true,
      oof_basic_guards_required: true, oof_beats_fold_fixed_no_skill: true },
    high_grade_recall: { true_ordinal_min: 2, predicted_ordinal_min: 2 },
    limitation: 'HISTORICALLY_INSPIRED_SEARCH_SPACE_DEVELOPMENT_ESTIMATE_ONLY' };
}
export function diagnosticSchema(version = 1) {
  if (version !== 1) fail('UNSUPPORTED_DIAGNOSTIC_SCHEMA');
  return { diagnostic_schema_version: 1, diagnostic_policy_version: 1,
    result_usage: 'DEVELOPMENT_ONLY', encoding: 'CANONICAL_JSON_UTF8',
    plan_files: ['schema.json', 'policy.json', 'plan.json', 'source_manifest.json'],
    result_files: ['schema.json', 'policy.json', 'plan.json', 'source_manifest.json', 'matrix_metrics.json',
      'sample_diagnostics.json', 'grade_metrics.json', 'prediction_distribution.json', 'slice_metrics.json',
      'fold_assignments.json', 'fold_candidates.json', 'fold_metrics.json', 'oof_summary.json',
      'searches.json', 'reference_parity.json', 'decision.json', 'reports/summary.json'] };
}
