import { normalizeEventContext, RATING_LABELS } from '../../../server/event-dataset.js';
import { buildEventIndex } from '../build-event-index.mjs';
import { canonicalJson, compare, errorCode, safeId } from './common.mjs';

export const ERROR_FIELDS = ['severity', 'entity_type', 'entity_id', 'event_id', 'error_code'].map(name =>
  ({ name, type: 'string', nullable: ['entity_id', 'event_id'].includes(name), unit: null, range: null, enum: null }));
export function issue(code, row = {}, entity = 'dataset', severity = 'ERROR') {
  return { severity, entity_type: entity, entity_id: row.id || row.snapshot_id || null, event_id: row.event_id || null, error_code: code };
}
export const sortIssues = rows => rows.sort((a, b) => {
  for (const key of ['severity', 'entity_type', 'event_id', 'entity_id', 'error_code']) {
    const diff = compare(a[key] ?? '', b[key] ?? ''); if (diff) return diff;
  }
  return 0;
});
export const qualityReport = errors => ({ status: errors.some(x => x.severity === 'ERROR') ? 'FAIL' : 'PASS',
  counts: Object.fromEntries(['ERROR', 'WARNING', 'INFO'].map(level => [level, errors.filter(x => x.severity === level).length])),
  issues: sortIssues(errors) });
const contextFields = ['event_date_local', 'location_key', 'latitude', 'longitude', 'location_source', 'location_id', 'timezone'];
const displayFields = ['city', 'admin1', 'country', 'sunset_time_local'];
export function isGoldenWindow(replay) {
  const config = replay.effective_config.goldenWindow;
  const lead = (Date.parse(replay.context.sunset_time_utc) - Date.parse(replay.identity.prediction_time_utc)) / 60000;
  return !!config && config.enabled !== false && lead <= config.beforeSunsetMinutes && lead >= -config.afterSunsetMinutes;
}
export async function validateTables(tables, selection, cutoff, replaySummary) {
  const errors = [], snapshots = tables.prediction_snapshots, observations = tables.sunset_observations;
  const events = new Map(tables.events.map(row => [row.event_id, row]));
  const snapshotMap = new Map(snapshots.map(row => [row.id, row]));
  for (const [name, rows] of Object.entries(tables)) {
    const key = name === 'events' ? 'event_id' : name === 'replay_index' ? 'snapshot_id' : 'id';
    const seen = new Set();
    for (const row of rows) {
      try { safeId(row[key]); safeId(row.event_id); } catch { errors.push(issue('INVALID_ENTITY_ID', row, name)); }
      if (seen.has(row[key])) errors.push(issue(`DUPLICATE_${name === 'prediction_snapshots' ? 'SNAPSHOT' : name === 'sunset_observations' ? 'OBSERVATION' : name === 'events' ? 'EVENT' : 'REPLAY'}_ID`, row, name));
      seen.add(row[key]);
    }
  }
  if (!snapshots.length) errors.push(issue('EMPTY_SELECTION'));
  const contexts = new Map();
  for (const [entity, rows] of [['snapshot', snapshots], ['observation', observations]]) {
    for (const row of rows) {
      const add = (code, severity) => errors.push(issue(code, row, entity, severity));
      if (!events.has(row.event_id)) add('EVENT_MISSING');
      if (row.submitted_at_epoch !== Date.parse(row.submitted_at_utc) || row.submitted_at_epoch > cutoff) add('CUTOFF_INVALID');
      try {
        const context = Object.fromEntries(['event_id', ...contextFields, ...displayFields, 'sunset_time_utc'].map(key => [key, row[key]]));
        await normalizeEventContext(context);
      } catch { add('EVENT_CONTEXT_INVALID'); }
      const reference = contexts.get(row.event_id);
      if (!reference) contexts.set(row.event_id, row);
      else {
        if (contextFields.some(key => reference[key] !== row[key]) || Date.parse(reference.sunset_time_utc) !== Date.parse(row.sunset_time_utc)) add('EVENT_CONTEXT_CONFLICT');
        if (displayFields.some(key => reference[key] !== row[key])) add('EVENT_DISPLAY_CONTEXT_VARIANT', 'WARNING');
      }
      if (entity === 'snapshot') {
        if (row.prediction_time_epoch !== Date.parse(row.prediction_time_utc) || row.lead_time_minutes !== (Date.parse(row.sunset_time_utc) - row.prediction_time_epoch) / 60000) add('PREDICTION_TIME_INVALID');
        if ((row.snapshot_source === 'user_feedback') !== (row.scheduled_slot === null)) add('SNAPSHOT_SLOT_INVALID');
        if (row.event_date_local < selection.event_date_from || row.event_date_local > selection.event_date_to ||
            [['cities', 'city'], ['model_versions', 'model_version'], ['snapshot_sources', 'snapshot_source'], ['scheduled_slots', 'scheduled_slot']].some(([filter, field]) => selection[filter] && !selection[filter].includes(row[field]))) add('SNAPSHOT_OUT_OF_SELECTION');
      } else {
        if (!Object.hasOwn(RATING_LABELS, row.rating)) add('INVALID_OBSERVATION_RATING');
        else if (row.rating_label !== RATING_LABELS[row.rating]) add('OBSERVATION_LABEL_INVALID');
        if (selection.observation_sources && !selection.observation_sources.includes(row.source)) add('OBSERVATION_OUT_OF_SELECTION');
        if (row.snapshot_id !== null) {
          if (!snapshotMap.has(row.snapshot_id)) add('OBSERVATION_SNAPSHOT_OUT_OF_SCOPE', 'WARNING');
          else if (snapshotMap.get(row.snapshot_id).event_id !== row.event_id) add('OBSERVATION_SNAPSHOT_EVENT_MISMATCH');
        }
      }
    }
  }
  const replayIds = new Set();
  for (const row of tables.replay_index) {
    replayIds.add(row.snapshot_id);
    if (snapshotMap.get(row.snapshot_id)?.event_id !== row.event_id) errors.push(issue('REPLAY_SNAPSHOT_MISMATCH', row, 'replay'));
    if (Date.parse(row.replay_saved_at_utc) > cutoff) errors.push(issue('REPLAY_CUTOFF_INVALID', row, 'replay'));
  }
  for (const row of snapshots) if (!replayIds.has(row.id)) errors.push(issue('REPLAY_MISSING', row, 'snapshot'));
  try {
    if (canonicalJson(buildEventIndex(snapshots, observations, tables.replay_index)) !== canonicalJson(tables.events)) errors.push(issue('EVENT_INDEX_MISMATCH'));
  } catch (error) { errors.push(issue(errorCode(error))); }
  for (const row of tables.events) if (!row.observation_count) errors.push(issue('EVENT_WITHOUT_OBSERVATION', { ...row, id: row.event_id }, 'event', 'WARNING'));
  if (replaySummary && !replaySummary.hasGoldenWindow) errors.push(issue('NO_GOLDEN_WINDOW_SAMPLE', {}, 'dataset', 'WARNING'));
  return qualityReport(errors);
}
