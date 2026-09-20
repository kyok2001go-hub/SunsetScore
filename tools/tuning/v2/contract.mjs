import { tuningPolicy } from '../tuning-policy.mjs';
import { tuningSchema, CSV_TABLES } from '../tuning-schema.mjs';

const field = (name, type = 'string', nullable = false, range = null) =>
  ({ name, type, nullable, range, enum: null, unit: null });
const metricFields = [
  field('no_skill_reference_ordinal', 'integer', true, [0, 4]),
  field('paired_no_skill_mae', 'number', true, [0, 4]),
  field('paired_no_skill_mae_reason_code', 'string', true),
  field('control_mae_gap_to_no_skill', 'number', true),
  field('control_mae_gap_reason_code', 'string', true),
  field('experiment_mae_gap_to_no_skill', 'number', true),
  field('experiment_mae_gap_reason_code', 'string', true)
];

export const ALIGNMENT_FIELDS = [
  field('snapshot_id'), field('event_id'), field('engine_build_sha'), field('config_hash'),
  field('historical_score', 'integer', false, [0, 100]),
  field('historical_ordinal', 'integer', false, [0, 4]),
  field('control_score', 'integer', true, [0, 100]),
  field('control_ordinal', 'integer', true, [0, 4]),
  field('score_delta', 'integer', true),
  field('ordinal_changed', 'boolean', true),
  field('reason_code', 'string', true)
];

const policy = structuredClone(tuningPolicy());
policy.tuning_schema_version = 2;
policy.tuning_policy_version = 2;
policy.evaluation_contract = {
  schema_version: 2, policy_version: 2, evaluated_splits: ['TRAIN'],
  mapping_status: 'PROVISIONAL', interpretation_scope: 'PROXY_ORDINAL_ONLY',
  validation_scope: 'MODEL_LINKED', no_skill_comparator: 'TRAIN_WEIGHTED_MEDIAN_ORDINAL'
};
policy.metric_usage = 'PROXY_EXPLORATORY';
policy.result_usage = { exploratory: 'EXPLORATORY_ONLY' };
policy.package.export_files.push('control_alignment.csv');
policy.package.export_files.sort();
export const POLICY_V2 = Object.freeze(policy);

const schema = structuredClone(tuningSchema());
schema.tuning_schema_version = 2;
schema.files.export = [...POLICY_V2.package.export_files];
schema.tables.control_alignment = ALIGNMENT_FIELDS;
for (const table of ['experiment_metrics', 'ablation_metrics', 'slice_deltas']) {
  schema.tables[table].push(...metricFields);
}
schema.tables.parameter_summary.push(field('metric_usage'));
schema.tables.sample_deltas.push(
  field('location_key', 'string', true), field('gt_status', 'string', true),
  field('gt_basis', 'string', true), field('regime_label', 'string', true),
  field('sky_evolution_state', 'string', true), field('scheduled_slot', 'string', true),
  field('snapshot_source', 'string', true),
  field('tile_radar_available', 'boolean', true), field('tile_sat_available', 'boolean', true)
);
schema.json.manifest.required.push(
  'evaluation_schema_version', 'evaluation_policy_version', 'evaluation_validation_scope',
  'evaluation_evaluated_splits', 'mapping_status', 'interpretation_scope',
  'no_skill_reference_ordinal', 'no_skill_reference_gt_label',
  'validation_disclosure_status', 'validation_disclosure_evidence_id',
  'validation_disclosure_evidence_sha256', 'validation_access_ledger_sha256',
  'engineering_readiness', 'data_readiness', 'metric_readiness'
);
schema.json.readiness.required.push('engineering_readiness', 'data_readiness', 'metric_readiness');
schema.json.summary.required.push('engineering_readiness', 'data_readiness', 'metric_readiness',
  'mapping_status', 'interpretation_scope');
export const SCHEMA_V2 = Object.freeze(schema);
export const CSV_TABLES_V2 = Object.freeze({
  ...CSV_TABLES,
  'control_alignment.csv': ALIGNMENT_FIELDS,
  'experiment_metrics.csv': schema.tables.experiment_metrics,
  'ablation_metrics.csv': schema.tables.ablation_metrics,
  'slice_deltas.csv': schema.tables.slice_deltas,
  'sample_deltas.csv': schema.tables.sample_deltas,
  'parameter_summary.csv': schema.tables.parameter_summary
});
export const FILES_V2 = Object.freeze([...POLICY_V2.package.export_files]);
