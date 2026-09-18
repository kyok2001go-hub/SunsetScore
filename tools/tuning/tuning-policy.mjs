import { REPLAY_RUNTIME_FILES } from '../replay/replay-runner.mjs';

export const TUNING_SCHEMA_VERSION = 1;
export const TUNING_POLICY_VERSION = 1;

export const REPLAY_CLASSES = Object.freeze(['REPLAY_SAFE', 'CONDITIONALLY_REPLAYABLE', 'REPLAY_UNSAFE']);
export const WIRED_STATUSES = Object.freeze(['WIRED', 'PARTIALLY_WIRED', 'NOT_WIRED', 'OPERATIONAL_ONLY']);
export const CONSTRAINT_TYPES = Object.freeze(['RANGE', 'INTEGER', 'ENUM', 'SIMPLEX', 'MONOTONIC', 'MIN_MAX', 'DEPENDENT']);
export const PARAMETER_STATES = Object.freeze(['READY', 'EXPLORATORY', 'INSUFFICIENT_SUPPORT', 'NOT_OBSERVABLE', 'EXCLUDED']);
export const GLOBAL_STATES = Object.freeze(['NOT_READY', 'EXPLORATORY', 'TUNING_READY']);
export const OBSERVABILITY_STATES = Object.freeze(['OBSERVABLE', 'PARTIALLY_OBSERVABLE', 'NOT_OBSERVABLE', 'NOT_EVALUATED']);
export const EXPERIMENT_KINDS = Object.freeze(['OAT', 'SIMPLEX', 'ABLATION']);
export const ABLATION_LAYERS = Object.freeze(['RUNNER', 'ENGINE']);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export const POLICY_V1 = deepFreeze({
  tuning_schema_version: TUNING_SCHEMA_VERSION,
  tuning_policy_version: TUNING_POLICY_VERSION,
  splits: ['TRAIN'],
  result_usage: { exploratory: 'EXPLORATORY_ONLY', formal: 'FORMAL' },
  // Phase B may only read these files. Any other path fails with TEST_ACCESS_FORBIDDEN.
  whitelist_files: ['manifest.json', 'schema.json', 'policy.json', 'splits/train.csv'],
  forbidden_files: [
    'splits/validation.csv', 'splits/test.csv', 'model_samples.csv', 'event_splits.csv',
    'diagnostic_samples.csv', 'excluded_samples.csv',
    'reports/statistics.json', 'reports/split-balance.json', 'reports/errors.csv'
  ],
  runtime_files: [...REPLAY_RUNTIME_FILES],
  // References reached only from the network-acquisition path, never from the Replay scoring path.
  non_scoring_namespace_references: {
    'js/data.js': ['citySearch'],
    'js/nowcast.js': ['cache', 'cacheKeys', 'corridor']
  },
  numeric: {
    decimals: 12,
    weight_tolerance_factor: 1e-12,
    accumulation: 'snapshot_id_codepoint_asc'
  },
  // Global Tuning Readiness gates (TRAIN cohort only).
  readiness_thresholds: {
    min_train_primary_events: 100,
    min_train_unique_dates: 14,
    required_replay_usable_rate: 1,
    min_gt_levels: 3,
    min_events_per_gt_level: 5,
    max_single_date_event_share: 0.5,
    max_single_city_event_share: 0.5
  },
  // Parameter Readiness gates.
  parameter_thresholds: {
    min_support_events: 5,
    min_support_dates: 2,
    ready_events: 20,
    ready_dates: 5
  },
  observability: {
    not_observable_changed_rate: 0,
    partially_observable_changed_rate: 0.5
  },
  // A failed Replay drops that Snapshot from the paired cohort for the affected experiment
  // instead of aborting the run, but the drop is reported and cannot exceed this share.
  coverage_policy: {
    min_coverage_rate: 0.95,
    fail_run_below_minimum: true
  },
  stability: {
    ready_dates: 5,
    limited_date_coverage_marker: 'LIMITED_DATE_COVERAGE'
  },
  declared_constraints: {
    monotonic: [
      {
        group_id: 'horizon_gate_steps', path: 'horizonGate', member_key: 'min',
        order: 'STRICTLY_DECREASING', optimizable: false,
        note: 'engine.js 按数组顺序取第一条 horizon >= min 的规则，因此 min 必须严格递减'
      },
      {
        group_id: 'horizon_gate_gates', path: 'horizonGate', member_key: 'gate',
        order: 'STRICTLY_DECREASING', optimizable: false,
        note: '地平线开口越大允许的 gate 越高'
      }
    ],
    dependent: [
      { group_id: 'nowcast_weights', requires: 'nowcast.enabled', equals: true }
    ]
  },
  package: {
    export_files: [
      'ablation_metrics.csv', 'experiment_metrics.csv', 'experiment_plan.csv', 'engine_runtime.json',
      'experiment_failures.csv',
      'parameter_registry.json', 'parameter_summary.csv', 'policy.json', 'readiness.json',
      'replay_parity.csv', 'sample_deltas.csv', 'schema.json', 'slice_deltas.csv',
      'reports/summary.json', 'reports/warnings.csv', 'tuning_base_config.json'
    ],
    manifest_file: 'manifest.json'
  }
});

export function tuningPolicy(version = TUNING_POLICY_VERSION) {
  if (version !== TUNING_POLICY_VERSION) {
    throw Object.assign(new Error('UNSUPPORTED_TUNING_POLICY'), { code: 'UNSUPPORTED_TUNING_POLICY' });
  }
  return POLICY_V1;
}
