import { compare } from '../../dataset/lib/common.mjs';
import { evaluationSchema } from '../evaluation-schema.mjs';

const field = (name, type = 'string', nullable = false, range = null, values = null) =>
  ({ name, type, nullable, range, enum: values, unit: null });
const count = name => field(name, 'integer', false, [0, Number.MAX_SAFE_INTEGER]);
const metricRange = name => name === 'mae' ? [0, 4] : name === 'bias' ? [-4, 4] :
  name === 'qwk' ? [-1, 1] : [0, 1];

export const V2_EXPORT_FILES = Object.freeze([
  ...evaluationSchema(1).files.export,
  'no_skill_comparison.csv'
].sort(compare));

const metrics = ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate',
  'overprediction_rate', 'underprediction_rate', 'qwk'];

export const NO_SKILL_FIELDS = Object.freeze([
  field('benchmark_mode', 'string', false, null, ['ALL_PRIMARY', 'CLOSEST_PRE_SUNSET']),
  field('split', 'string', false, null, ['TRAIN']),
  field('weighting', 'string', false, null, ['weighted', 'unweighted']),
  field('comparator', 'string', false, null, ['TRAIN_WEIGHTED_MEDIAN_ORDINAL']),
  field('reference_ordinal', 'integer', true, [0, 4]),
  field('reference_gt_label', 'string', true, null, ['poor', 'fair', 'good', 'very_good', 'excellent']),
  count('sample_count'), count('event_count'),
  field('weight_sum', 'number', false, [0, Number.MAX_SAFE_INTEGER]),
  ...['final', 'reference'].flatMap(side => metrics.flatMap(name => [
    field(`${side}_${name}`, 'number', true, metricRange(name)),
    field(`${side}_${name}_reason_code`, 'string', true)
  ])),
  field('delta_mae', 'number', true, [-4, 4]),
  field('delta_mae_reason_code', 'string', true)
]);

function trainFields(fields) {
  return fields.map(f => f.name === 'split' ? { ...f, enum: ['TRAIN'] } : f);
}

export function evaluationSchemaV2() {
  const schema = structuredClone(evaluationSchema(1));
  schema.evaluation_schema_version = 2;
  schema.files.export = V2_EXPORT_FILES;
  schema.json.manifest.required = [
    ...schema.json.manifest.required,
    'validation_evaluated', 'validation_evaluation_sample_count',
    'computation_access_policy', 'validation_access_policy',
    'mapping_basis', 'mapping_status', 'interpretation_scope', 'no_skill_reference'
  ].sort(compare);
  schema.json.summary.required = [
    ...schema.json.summary.required,
    'validation_evaluated', 'mapping_basis', 'mapping_status',
    'interpretation_scope', 'no_skill_reference'
  ].sort(compare);
  for (const [name, fields] of Object.entries(schema.tables)) schema.tables[name] = trainFields(fields);
  schema.tables.confusion_matrix = schema.tables.confusion_matrix.map(f =>
    f.name === 'predicted_label' ? { ...f, enum: ['很差', '较差', '一般', '很好', '极佳'] } : f);
  schema.tables.no_skill_comparison = NO_SKILL_FIELDS;
  return schema;
}
