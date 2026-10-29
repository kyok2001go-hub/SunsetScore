// V2.5.5.9 bypass export: shared contract for the offline bypass package (record-only objects next to READY Replays).
// Reads only prediction_snapshots and the R2 bypass objects; never Observations or labels.
// PRD: ref_docs/PRD/V2.5.5.9--旁路对象导出与质量巡检方案.md
import { gunzipSync } from 'node:zlib';
import { bypassObjectKey, validateBypassPayload, MAX_BYPASS_UNCOMPRESSED_BYTES } from '../../../server/bypass-schema.js';
import { canonicalJson, fail, hash } from '../../dataset/lib/common.mjs';

export const BYPASS_PACKAGE_VERSION = 1;
export const BYPASS_TOOL_VERSION = '2.5.5.9';
// V2.5.5.7 went live on 2026-10-28; earlier Snapshots never carry a bypass object.
export const DEFAULT_FROM = '2026-10-28';
export const FIRST_BYPASS_APP_VERSION = '2.5.5.7';
export const AUTO_SOURCES = Object.freeze(['github_schedule', 'github_manual']);

export const SNAPSHOT_COLUMNS = Object.freeze(['id', 'event_id', 'event_date_local', 'city', 'latitude', 'longitude',
  'sunset_time_utc', 'prediction_time_utc', 'snapshot_source', 'scheduled_slot', 'app_version', 'model_version',
  'replay_status', 'replay_object_key', 'replay_sha256', 'replay_saved_at_utc', 'submitted_at_epoch']);

const REQUEST_STATUS = ['OK', 'FAILED', 'RATE_LIMITED', 'NOT_REQUESTED'];
export const OBJECT_STATUS = Object.freeze(['VALID', 'INVALID', 'MISSING', 'DOWNLOAD_FAILED', 'NOT_CHECKED']);
const s = (name, extra = {}) => ({ name, type: 'string', nullable: false, ...extra });
const n = (name, type, extra = {}) => ({ name, type, nullable: true, ...extra });
export const INDEX_FIELDS = Object.freeze([
  s('snapshot_id'), s('event_id'), s('event_date_local'), s('city'), s('scheduled_slot', { nullable: true }),
  s('snapshot_source', { enum: ['github_schedule', 'github_manual', 'user_feedback'] }), s('app_version'), s('model_version'),
  s('prediction_time_utc'), s('sunset_time_utc'), { name: 'latitude', type: 'number', nullable: false }, { name: 'longitude', type: 'number', nullable: false },
  s('replay_sha256'), s('bypass_object_key'), s('expected', { enum: ['EXPECTED', 'NOT_EXPECTED'] }), s('object_status', { enum: [...OBJECT_STATUS] }),
  s('error_code', { nullable: true }), n('bypass_schema_version', 'integer', { range: [1, 99] }),
  n('compressed_bytes', 'integer', { range: [0, 1e9] }), n('uncompressed_bytes', 'integer', { range: [0, 1e9] }),
  s('content_sha256', { nullable: true }), s('request_a_status', { nullable: true, enum: REQUEST_STATUS }),
  s('request_b_status', { nullable: true, enum: REQUEST_STATUS }), s('shadow_status', { nullable: true }),
  s('shadow_reason_code', { nullable: true }), s('local_path', { nullable: true })
]);

export function versionAtLeast(version, minimum) {
  const parts = value => String(value).split('.').map(Number);
  const a = parts(version), b = parts(minimum);
  if (a.some(x => !Number.isInteger(x))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

// Only automatic captures (?replay=1) on 2.5.5.7+ pages produce a bypass object; user feedback Snapshots never do.
export function expectation(row) {
  return AUTO_SOURCES.includes(row.snapshot_source) && versionAtLeast(row.app_version, FIRST_BYPASS_APP_VERSION) ? 'EXPECTED' : 'NOT_EXPECTED';
}

export const objectKeyFor = row => bypassObjectKey(row.replay_object_key);

/**
 * Decompress, bind and validate one stored object. The endpoint stores canonical JSON with snapshot_id set
 * to the Snapshot ID; the shared validator expects the submitted form (snapshot_id null).
 */
export function verifyObject(row, compressed) {
  let bytes;
  try { bytes = gunzipSync(compressed, { maxOutputLength: MAX_BYPASS_UNCOMPRESSED_BYTES }); }
  catch (error) { fail(error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'BYPASS_TOO_LARGE' : 'BYPASS_GZIP_INVALID'); }
  const text = bytes.toString('utf8');
  let payload;
  try { payload = JSON.parse(text); } catch { fail('BYPASS_JSON_INVALID'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('BYPASS_JSON_INVALID');
  if (canonicalJson(payload) !== text) fail('BYPASS_NOT_CANONICAL');
  if (payload.snapshot_id !== row.id) fail('BYPASS_SNAPSHOT_ID_MISMATCH');
  try {
    validateBypassPayload({ ...payload, snapshot_id: null }, { prediction_time_utc: row.prediction_time_utc,
      sunset_time_utc: row.sunset_time_utc, latitude: row.latitude, longitude: row.longitude });
  } catch (error) {
    fail(/^BYPASS_[A-Z_]+$/.test(error?.message || '') ? error.message : 'BYPASS_SCHEMA_INVALID', { detail: String(error?.message || '').slice(0, 200) });
  }
  return { payload, uncompressedBytes: bytes.length, contentSha256: hash(bytes) };
}

export function indexRow(row, fields) {
  return {
    snapshot_id: row.id, event_id: row.event_id, event_date_local: row.event_date_local, city: row.city,
    scheduled_slot: row.scheduled_slot ?? null, snapshot_source: row.snapshot_source, app_version: row.app_version,
    model_version: row.model_version, prediction_time_utc: row.prediction_time_utc, sunset_time_utc: row.sunset_time_utc,
    latitude: row.latitude, longitude: row.longitude, replay_sha256: row.replay_sha256, bypass_object_key: objectKeyFor(row),
    expected: expectation(row), object_status: 'NOT_CHECKED', error_code: null, bypass_schema_version: null,
    compressed_bytes: null, uncompressed_bytes: null, content_sha256: null, request_a_status: null, request_b_status: null,
    shadow_status: null, shadow_reason_code: null, local_path: null, ...fields
  };
}

export function payloadFields(payload) {
  const shadow = payload.satellite_shadow;
  return { bypass_schema_version: payload.bypass_schema_version, request_a_status: payload.requests.A.status,
    request_b_status: payload.requests.B.status, shadow_status: shadow ? shadow.status : null,
    shadow_reason_code: shadow ? shadow.reason_code : null };
}

// Index rows carry what verifyObject needs, so a package can be re-verified offline.
export const rowFromIndex = item => ({ id: item.snapshot_id, prediction_time_utc: item.prediction_time_utc,
  sunset_time_utc: item.sunset_time_utc, latitude: item.latitude, longitude: item.longitude });
