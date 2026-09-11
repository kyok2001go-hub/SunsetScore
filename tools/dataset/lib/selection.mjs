import path from 'node:path';
import { datasetSchema, SNAPSHOT_OFFLINE_FIELDS, canonicalUtc, validDate } from '../dataset-schema.mjs';
import { compare, fail, rowOrder, safeId, unique } from './common.mjs';

export const REPLAY_METADATA = ['replay_status', 'replay_schema_version', 'replay_object_key',
  'replay_size_bytes', 'replay_sha256', 'replay_object_etag', 'replay_compression',
  'replay_saved_at_utc', 'replay_updated_at_utc'];
const flags = {
  '--city': 'cities', '--model-version': 'model_versions', '--snapshot-source': 'snapshot_sources',
  '--scheduled-slot': 'scheduled_slots', '--observation-source': 'observation_sources'
};
const enumerations = {
  snapshot_sources: ['github_schedule', 'github_manual', 'user_feedback'],
  observation_sources: ['user', 'rednote_agent', 'rednote_manual']
};
export function parseExportArgs(args) {
  const options = { database: 'sunset-db', bucket: 'sunsetscore-replay', output: path.resolve('dataset'), config: null, cutoff: null };
  const selection = { event_date_from: null, event_date_to: null, cities: null, model_versions: null,
    snapshot_sources: null, scheduled_slots: null, observation_sources: null, include_comments: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) fail('DUPLICATE_ARGUMENT');
    seen.add(flag);
    if (flag === '--include-comments') { selection.include_comments = true; continue; }
    if (![...Object.keys(flags), '--from', '--to', '--cutoff', '--output', '--database', '--bucket', '--config'].includes(flag)) fail('INVALID_ARGUMENTS');
    const value = args[++i];
    if (!value || value.startsWith('--') || /[\x00-\x1f]/.test(value)) fail('INVALID_ARGUMENTS');
    if (flags[flag]) {
      const key = flags[flag], values = value.split(',').map(x => x.trim());
      if (values.length > 100 || values.some(x => !x || x.length > 100)) fail('INVALID_FILTER');
      if (enumerations[key] && values.some(x => !enumerations[key].includes(x))) fail('INVALID_FILTER');
      if (key === 'scheduled_slots' && values.some(x => !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(x))) fail('INVALID_FILTER');
      if (key === 'model_versions' && values.some(x => !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,29}$/.test(x))) fail('INVALID_FILTER');
      selection[key] = unique(values);
    } else if (flag === '--from') selection.event_date_from = value.trim();
    else if (flag === '--to') selection.event_date_to = value.trim();
    else options[flag.slice(2)] = value;
  }
  if (!validDate(selection.event_date_from) || !validDate(selection.event_date_to) || selection.event_date_from > selection.event_date_to) fail('INVALID_DATE_RANGE');
  for (const key of ['database', 'bucket']) if (!/^[a-z0-9_-]{1,64}$/i.test(options[key])) fail('INVALID_RESOURCE_NAME');
  if (options.cutoff !== null) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(options.cutoff) || !Number.isFinite(Date.parse(options.cutoff))) fail('INVALID_CUTOFF');
    const input = options.cutoff, normalized = new Date(input).toISOString();
    if (normalized.slice(0, 19) !== input.slice(0, 19)) fail('INVALID_CUTOFF');
    options.cutoff = normalized;
  }
  options.output = path.resolve(options.output);
  return { ...options, selection };
}
export function assertSelection(selection) {
  const args = ['--from', selection?.event_date_from, '--to', selection?.event_date_to];
  for (const [flag, key] of Object.entries(flags)) {
    if (selection?.[key] !== null) {
      if (!Array.isArray(selection?.[key])) fail('SELECTION_INVALID');
      args.push(flag, selection[key].join(','));
    }
  }
  if (typeof selection?.include_comments !== 'boolean') fail('SELECTION_INVALID');
  if (selection.include_comments) args.push('--include-comments');
  return parseExportArgs(args).selection;
}
export const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const listCondition = (column, values) => values ? `${column} COLLATE BINARY IN (${values.map(literal).join(',')})` : '1=1';
export function snapshotConditions(selection, cutoff) {
  return [
    `event_date_local >= ${literal(selection.event_date_from)}`,
    `event_date_local <= ${literal(selection.event_date_to)}`, `submitted_at_epoch <= ${cutoff}`,
    "replay_status = 'READY'", listCondition('city', selection.cities),
    listCondition('model_version', selection.model_versions), listCondition('snapshot_source', selection.snapshot_sources),
    listCondition('scheduled_slot', selection.scheduled_slots)
  ].join(' AND ');
}
export async function paginate(query, table, columns, condition, pageSize = 1000, metrics = []) {
  if (!['prediction_snapshots', 'sunset_observations'].includes(table) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) fail('PAGINATION_INVALID');
  const rows = [], ids = new Set();
  let last = null;
  for (;;) {
    const cursor = last ? ` AND (submitted_at_epoch > ${last.submitted_at_epoch} OR (submitted_at_epoch = ${last.submitted_at_epoch} AND id COLLATE BINARY > ${literal(last.id)}))` : '';
    const sql = `SELECT ${columns.join(',')} FROM ${table} WHERE (${condition})${cursor} ORDER BY submitted_at_epoch ASC,id COLLATE BINARY ASC LIMIT ${pageSize}`;
    if (Buffer.byteLength(sql) > 80_000) fail('SQL_BUDGET_EXCEEDED');
    const start = Date.now(), page = await query(sql);
    if (!Array.isArray(page) || page.length > pageSize) fail('D1_RESPONSE_INVALID');
    metrics.push({ table, rows: page.length, duration_ms: Date.now() - start, response_bytes: Buffer.byteLength(JSON.stringify(page)) });
    if (!page.length) break;
    for (const row of page) {
      safeId(row.id);
      if (!Number.isSafeInteger(row.submitted_at_epoch) || row.submitted_at_epoch < 0) fail('FIELD_INVALID');
      if (ids.has(row.id) || (last && rowOrder(last, row) >= 0)) fail('PAGINATION_NOT_ADVANCING');
      ids.add(row.id); rows.push(row); last = row;
    }
  }
  return rows;
}
export async function extractSnapshots(source, selection, cutoff, pageSize = 1000, metrics = []) {
  const columns = [...SNAPSHOT_OFFLINE_FIELDS.filter(x => x !== 'lead_time_minutes'), ...REPLAY_METADATA];
  const candidates = await paginate(source.query.bind(source), 'prediction_snapshots', columns,
    snapshotConditions(selection, cutoff), pageSize, metrics);
  return candidates.filter(row => {
    if (!canonicalUtc(row.replay_saved_at_utc)) fail('REPLAY_READY_TIME_INVALID', { entity_type: 'snapshot', entity_id: row.id, event_id: row.event_id });
    return Date.parse(row.replay_saved_at_utc) <= cutoff;
  });
}
export async function extractObservations(source, selection, cutoff, eventIds, pageSize = 1000, metrics = []) {
  const fields = datasetSchema(selection.include_comments).tables.sunset_observations.map(x => x.name);
  const rows = [];
  // At most 100 bounded IDs per statement; SQL is additionally checked by paginate.
  const ids = unique(eventIds);
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    batch.forEach(safeId);
    const condition = `event_id IN (${batch.map(literal).join(',')}) AND submitted_at_epoch <= ${cutoff} AND ${listCondition('source', selection.observation_sources)}`;
    rows.push(...await paginate(source.query.bind(source), 'sunset_observations', fields, condition, pageSize, metrics));
  }
  rows.sort(rowOrder);
  if (new Set(rows.map(x => x.id)).size !== rows.length) fail('DUPLICATE_OBSERVATION_ID');
  return rows;
}
export const eventIdsFor = snapshots => unique(snapshots.map(row => row.event_id));
