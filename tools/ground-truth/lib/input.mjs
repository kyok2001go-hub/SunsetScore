import path from 'node:path';
import { datasetSchema, canonicalUtc, CONSISTENCY_POLICY } from '../../dataset/dataset-schema.mjs';
import { descriptorIdentity, RAW_FILES, REGISTERED_FILES } from '../../dataset/build-manifest.mjs';
import { assertSelection } from '../../dataset/lib/selection.mjs';
import { canonicalJson, hash, readSafe, fail, safeId, compare } from '../../dataset/lib/common.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
import { normalizeEventContext, RATING_LABELS } from '../../../server/event-dataset.js';
import { contribution } from './aggregate.mjs';

export const INPUT_FILES = ['manifest.json', 'schema.json', 'raw/events.csv', 'raw/sunset_observations.csv'];
export function equal(a, b, code = 'GT_VALIDATION_FAILED') { if (canonicalJson(a) !== canonicalJson(b)) fail(code); }
export function parseJson(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJson(value)))) fail('JSON_NOT_CANONICAL');
  return value;
}
export const issueOrder = (a, b) => {
  for (const key of ['severity', 'entity_type', 'entity_id', 'event_id', 'error_code']) {
    const n = compare(a[key] ?? '', b[key] ?? ''); if (n) return n;
  }
  return 0;
};
export const issue = (code, row = {}, severity = 'ERROR') => ({ severity, entity_type: row.id ? 'observation' : 'dataset',
  entity_id: row.id || null, event_id: row.event_id || null, error_code: code });

// Deliberately no inventory or general Raw validator: these four reads are the entire input surface.
export async function loadInput(directory) {
  const bytes = {};
  for (const file of INPUT_FILES) bytes[file] = await readSafe(path.join(directory, file));
  const manifest = parseJson(bytes['manifest.json']), schema = parseJson(bytes['schema.json']);
  if (manifest.offline_dataset_schema_version !== 1 || manifest.consistency_policy !== CONSISTENCY_POLICY) fail('RAW_INPUT_INVALID');
  equal(assertSelection(manifest.selection), manifest.selection, 'RAW_INPUT_INVALID');
  equal(schema, datasetSchema(manifest.selection.include_comments), 'RAW_INPUT_INVALID');
  const d = manifest.descriptor, identity = descriptorIdentity(d);
  equal(Object.keys(d).sort(), ['offline_dataset_schema_version', 'consistency_policy', 'selection', 'export_cutoff_epoch', 'schema_sha256', 'raw_files', 'replay_set_sha256'].sort(), 'RAW_INPUT_INVALID');
  equal(d.selection, manifest.selection, 'RAW_INPUT_INVALID');
  if (identity.dataset_id !== manifest.dataset_id || identity.descriptor_sha256 !== manifest.descriptor_sha256 ||
      d.offline_dataset_schema_version !== 1 || d.consistency_policy !== CONSISTENCY_POLICY ||
      d.export_cutoff_epoch !== manifest.export_cutoff_epoch || d.replay_set_sha256 !== manifest.replay_set_sha256 ||
      !Number.isSafeInteger(d.export_cutoff_epoch) || d.export_cutoff_epoch < 0 ||
      !canonicalUtc(manifest.export_cutoff_utc) || Date.parse(manifest.export_cutoff_utc) !== d.export_cutoff_epoch ||
      !canonicalUtc(manifest.created_at_utc)) fail('RAW_INPUT_INVALID');
  equal(Object.keys(manifest.files).sort(), [...REGISTERED_FILES].sort(), 'RAW_INPUT_INVALID');
  equal(Object.keys(d.raw_files).sort(), [...RAW_FILES].sort(), 'RAW_INPUT_INVALID');
  for (const file of REGISTERED_FILES) {
    const m = manifest.files[file];
    if (!/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes < 0) fail('RAW_INPUT_INVALID');
    if (RAW_FILES.includes(file) && (m.sha256 !== d.raw_files[file] || !Number.isSafeInteger(m.rows) || m.rows < 0)) fail('RAW_INPUT_INVALID');
  }
  if (!/^[a-f0-9]{64}$/.test(d.replay_set_sha256) || d.schema_sha256 !== manifest.files['schema.json'].sha256) fail('RAW_INPUT_INVALID');
  const sourceFiles = {};
  for (const file of INPUT_FILES.slice(1)) {
    const m = manifest.files[file];
    if (hash(bytes[file]) !== m.sha256 || bytes[file].length !== m.bytes) fail('SOURCE_FILE_HASH_MISMATCH');
    sourceFiles[file] = { sha256: m.sha256, bytes: m.bytes };
  }
  const events = readCsv(schema.tables.events, bytes['raw/events.csv']);
  const observations = readCsv(schema.tables.sunset_observations, bytes['raw/sunset_observations.csv']);
  if (!events.length || events.length !== manifest.files['raw/events.csv'].rows || observations.length !== manifest.files['raw/sunset_observations.csv'].rows ||
      events.length !== manifest.counts.events || observations.length !== manifest.counts.observations) fail('RAW_INPUT_INVALID');
  const eventMap = new Map(), counts = new Map(), ids = new Set(), submissions = new Set(), issues = [];
  for (const e of events) {
    safeId(e.event_id);
    if (eventMap.has(e.event_id)) fail('DUPLICATE_EVENT_ID');
    if (e.event_id !== `evt_v1_${hash(e.location_key).slice(0, 20)}_${e.event_date_local}` ||
        e.event_date_local < manifest.selection.event_date_from || e.event_date_local > manifest.selection.event_date_to) fail('RAW_INPUT_INVALID');
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: e.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(e.sunset_time_utc));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` !== e.event_date_local) fail('RAW_INPUT_INVALID');
    eventMap.set(e.event_id, e);
  }
  for (const o of observations) {
    contribution(o); safeId(o.submission_id);
    if (ids.has(o.id)) fail('DUPLICATE_OBSERVATION_ID'); ids.add(o.id);
    if (submissions.has(o.submission_id)) fail('DUPLICATE_SUBMISSION_ID'); submissions.add(o.submission_id);
    const e = eventMap.get(o.event_id); if (!e) fail('OBSERVATION_EVENT_MISSING');
    counts.set(o.event_id, (counts.get(o.event_id) || 0) + 1);
    const contextKeys = ['event_id', 'event_date_local', 'location_key', 'city', 'admin1', 'country', 'latitude', 'longitude',
      'location_source', 'location_id', 'timezone', 'sunset_time_utc', 'sunset_time_local'];
    try { await normalizeEventContext(Object.fromEntries(contextKeys.map(k => [k, o[k]]))); } catch { fail('RAW_INPUT_INVALID'); }
    for (const key of ['location_key', 'event_date_local', 'latitude', 'longitude', 'timezone', 'sunset_time_utc']) if (o[key] !== e[key]) fail('RAW_INPUT_INVALID');
    if (o.submitted_at_epoch !== Date.parse(o.submitted_at_utc) || o.submitted_at_epoch > d.export_cutoff_epoch || o.rating_label !== RATING_LABELS[o.rating] ||
        manifest.selection.observation_sources && !manifest.selection.observation_sources.includes(o.source)) fail('RAW_INPUT_INVALID');
    if (['city', 'admin1', 'country', 'sunset_time_local'].some(k => o[k] !== e[k])) issues.push(issue('EVENT_DISPLAY_CONTEXT_VARIANT', o, 'WARNING'));
  }
  for (const e of events) if (e.observation_count !== (counts.get(e.event_id) || 0)) fail('RAW_INPUT_INVALID');
  const fingerprints = Object.fromEntries(INPUT_FILES.map(f => [f, hash(bytes[f])]));
  return { events, observations: observations.map(o => Object.fromEntries(['id', 'event_id', 'source', 'rating', 'confidence', 'evidence_count'].map(k => [k, o[k]]))),
    issues: issues.sort(issueOrder), fingerprints,
    source: { source_dataset_id: manifest.dataset_id, source_dataset_manifest_sha256: fingerprints['manifest.json'],
      source_descriptor_sha256: manifest.descriptor_sha256, source_input_files: sourceFiles } };
}
export async function recheckInput(directory, fingerprints) {
  for (const f of INPUT_FILES) {
    try { if (hash(await readSafe(path.join(directory, f))) !== fingerprints[f]) fail('SOURCE_CHANGED_DURING_GT_BUILD'); }
    catch { fail('SOURCE_CHANGED_DURING_GT_BUILD'); }
  }
}
