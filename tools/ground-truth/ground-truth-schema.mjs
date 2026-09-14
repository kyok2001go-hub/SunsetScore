import { LABELS, SOURCES, POLICY } from './ground-truth-policy.mjs';
const field = (name, type = 'string', nullable = false, range = null, values = null) =>
  ({ name, type, nullable, range, enum: values, unit: null });
const count = name => field(name, 'integer', false, [0, Number.MAX_SAFE_INTEGER]);
export const EVENT_FIELDS = [field('event_id'), field('event_date_local'), field('city'),
  field('gt_label', 'string', true, null, LABELS), field('gt_ordinal', 'integer', true, [0, 4]),
  field('weighted_ordinal_mean', 'number', true, [0, 4]), field('gt_confidence', 'number', false, [0, 1]),
  field('gt_status', 'string', false, null, POLICY.status_order), count('observation_count'),
  field('effective_n', 'number', false, [0, Number.MAX_SAFE_INTEGER]), count('source_count'),
  field('consensus_ratio', 'number', true, [0, 1]), field('normalized_entropy', 'number', true, [0, 1]),
  ...['ordinal_mad', 'min_ordinal', 'max_ordinal'].map(x => field(x, 'integer', true, [0, 4])),
  ...SOURCES.map(x => count(`${x}_count`))];
export const CONTRIBUTION_FIELDS_V1 = [field('event_id'), field('observation_id'),
  field('source', 'string', false, null, SOURCES), field('rating', 'string', false, null, LABELS),
  field('ordinal', 'integer', false, [0, 4]), field('confidence', 'number', true, [0, 1]),
  field('evidence_count', 'integer', true, [0, 10000]),
  ...['source_weight', 'confidence_factor', 'effective_weight'].map(x => field(x, 'number', false, [0.75, 1])),
  field('included', 'boolean'), field('exclusion_reason', 'string', true)];
export const ERROR_FIELDS = [field('severity', 'string', false, null, ['ERROR', 'WARNING', 'INFO']),
  field('entity_type', 'string', false, null, ['dataset', 'event', 'observation', 'ground_truth']),
  field('entity_id', 'string', true), field('event_id', 'string', true), field('error_code')];
export const CONTRIBUTION_FIELDS = [CONTRIBUTION_FIELDS_V1[0], field('event_date_local'), field('city'), ...CONTRIBUTION_FIELDS_V1.slice(1)];
export function groundTruthSchema(version = 2) {
  if (![1, 2].includes(version)) throw new Error('UNSUPPORTED_GT_SCHEMA');
  return { ground_truth_schema_version: version,
  csv: { encoding: 'UTF-8 BOM', record_separator: 'CRLF', final_record_separator: true,
    null: 'unquoted empty', empty_string: 'quoted empty', boolean: '0/1' },
  tables: { event_ground_truth: EVENT_FIELDS, observation_contributions: version === 1 ? CONTRIBUTION_FIELDS_V1 : CONTRIBUTION_FIELDS, errors: ERROR_FIELDS } };
}
export const SCHEMA = groundTruthSchema();
