// V2.5.5.7 bypass capture V1 (record-only): strict validation of the object written next to a READY Replay.
// The Replay contract is unchanged; this object is never consumed by scoring. PRD: ref_docs/PRD/V2.5.5.7--旁路采集V1方案.md
import { ValidationError } from './event-dataset.js';
import { canonicalJson } from './replay-schema.js';

export const BYPASS_SCHEMA_VERSION = 1;
export const MAX_BYPASS_UNCOMPRESSED_BYTES = 512 * 1024;
export const BYPASS_LEVELS = Object.freeze([925, 850, 700, 500, 300, 250]);
export const BYPASS_GRID_VARIABLES = Object.freeze(['dew_point_2m', 'boundary_layer_height',
  ...BYPASS_LEVELS.flatMap((level) => ['cloud_cover', 'relative_humidity', 'geopotential_height'].map((name) => `${name}_${level}hPa`))]);
export const BYPASS_FAR_VARIABLES = Object.freeze(['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', ...BYPASS_GRID_VARIABLES]);
const UNIT_OF = (name) => name === 'dew_point_2m' ? 'celsius'
  : name === 'boundary_layer_height' || name.startsWith('geopotential_height_') ? 'meter' : 'percent';
const RANGE_OF = (name) => UNIT_OF(name) === 'percent' ? [0, 100] : name === 'dew_point_2m' ? [-90, 60] : [-1000, 20000];

const TOP_FIELDS = new Set(['bypass_schema_version', 'record_only', 'snapshot_id', 'prediction_time_utc', 'sunset_time_utc',
  'sunset_azimuth_deg', 'latitude', 'longitude', 'source', 'requests', 'time_axis', 'units', 'grid_nodes', 'far_nodes', 'quality',
  'satellite_shadow']);
const SOURCE_FIELDS = new Set(['api', 'model', 'fetched_at_utc', 'issue_time_utc', 'issue_time_status']);
const REQUEST_FIELDS = new Set(['status', 'reason_code', 'variables']);
const REQUEST_STATUS = new Set(['OK', 'FAILED', 'RATE_LIMITED', 'NOT_REQUESTED']);
const GRID_NODE_FIELDS = new Set(['key', 'direction', 'azimuth', 'distance_km', 'latitude', 'longitude', 'elevation_m', 'time_utc', 'variables']);
const FAR_NODE_FIELDS = new Set(['key', 'bearing_deg', 'distance_km', 'latitude', 'longitude', 'elevation_m', 'time_utc', 'variables']);
const MISSING_REASONS = new Set(['NOT_RETURNED', 'REQUEST_FAILED', 'RATE_LIMITED', 'UNIT_MISMATCH']);

const fail = (message) => { throw new ValidationError(message); };
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' 必须是对象'); return value; }
function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(label + ' 包含未知字段：' + key);
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(label + ' 缺少字段：' + key);
}
function finite(value, label, min, max, nullable = false) {
  if (nullable && value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label + ' 非法');
}
function iso(value, label, nullable = false) {
  if (nullable && value == null) return;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(label + ' 必须是 UTC ISO-8601');
}
function string(value, label, max = 80, nullable = false) {
  if (nullable && value == null) return;
  if (typeof value !== 'string' || !value || value.length > max) fail(label + ' 非法');
}
function sameList(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) fail(label + ' 变量列表不符');
}

function nodes(list, fields, variables, max, label) {
  if (!Array.isArray(list) || list.length > max) fail(label + ' 数量非法');
  for (const [index, node] of list.entries()) {
    const where = `${label}[${index}]`;
    object(node, where); exactKeys(node, fields, where);
    string(node.key, where + '.key');
    finite(node.latitude, where + '.latitude', -90, 90); finite(node.longitude, where + '.longitude', -180, 180);
    finite(node.distance_km, where + '.distance_km', 0, 2000, true);
    if (fields.has('azimuth')) { finite(node.azimuth, where + '.azimuth', 0, 360, true); if (typeof node.direction !== 'string' || node.direction.length > 20) fail(where + '.direction 非法'); }
    if (fields.has('bearing_deg')) finite(node.bearing_deg, where + '.bearing_deg', 0, 360);
    finite(node.elevation_m, where + '.elevation_m', -500, 9000, true);
    if (!Array.isArray(node.time_utc) || node.time_utc.length > 96) fail(where + ' 时间序列长度非法');
    node.time_utc.forEach((time, i) => iso(time, `${where}.time_utc[${i}]`));
    object(node.variables, where + '.variables'); exactKeys(node.variables, new Set(variables), where + '.variables');
    for (const name of variables) {
      const values = node.variables[name], [min, max] = RANGE_OF(name);
      if (!Array.isArray(values) || values.length !== node.time_utc.length) fail(`${where} 变量长度与时间轴不一致：${name}`);
      values.forEach((value, i) => finite(value, `${where}.${name}[${i}]`, min, max, true));
    }
  }
}

// expected: { prediction_time_utc, sunset_time_utc, latitude, longitude } taken from the validated Replay of the same request.
export function validateBypassPayload(bypass, expected) {
  object(bypass, 'bypass'); exactKeys(bypass, TOP_FIELDS, 'bypass');
  if (bypass.bypass_schema_version !== BYPASS_SCHEMA_VERSION) fail('bypass_schema_version 不受支持');
  if (bypass.record_only !== true) fail('bypass.record_only 必须为 true');
  if (bypass.snapshot_id !== null) fail('bypass.snapshot_id 由服务端写入，提交时必须为 null');
  // Reserved for V2.5.5.8 (satellite shadow capture); its format is not defined yet.
  if (bypass.satellite_shadow !== null) fail('BYPASS_SATELLITE_SHADOW_NOT_DEFINED');
  iso(bypass.prediction_time_utc, 'bypass.prediction_time_utc'); iso(bypass.sunset_time_utc, 'bypass.sunset_time_utc');
  finite(bypass.latitude, 'bypass.latitude', -90, 90); finite(bypass.longitude, 'bypass.longitude', -180, 180);
  finite(bypass.sunset_azimuth_deg, 'bypass.sunset_azimuth_deg', 0, 360, true);
  if (bypass.prediction_time_utc !== expected.prediction_time_utc || bypass.sunset_time_utc !== expected.sunset_time_utc ||
      bypass.latitude !== expected.latitude || bypass.longitude !== expected.longitude) fail('BYPASS_BINDING_MISMATCH');
  object(bypass.source, 'bypass.source'); exactKeys(bypass.source, SOURCE_FIELDS, 'bypass.source');
  if (bypass.source.api !== 'open-meteo/forecast' || bypass.source.model !== 'best_match') fail('bypass.source 非法');
  iso(bypass.source.fetched_at_utc, 'bypass.source.fetched_at_utc');
  if (bypass.source.issue_time_utc !== null || bypass.source.issue_time_status !== 'NOT_PROVIDED_BY_API') fail('bypass.source.issue_time 非法');
  object(bypass.requests, 'bypass.requests'); exactKeys(bypass.requests, new Set(['A', 'B']), 'bypass.requests');
  for (const [id, variables] of [['A', BYPASS_GRID_VARIABLES], ['B', BYPASS_FAR_VARIABLES]]) {
    const request = object(bypass.requests[id], 'bypass.requests.' + id);
    exactKeys(request, REQUEST_FIELDS, 'bypass.requests.' + id);
    if (!REQUEST_STATUS.has(request.status)) fail('bypass.requests.' + id + '.status 非法');
    string(request.reason_code, 'bypass.requests.' + id + '.reason_code', 40, true);
    sameList(request.variables, variables, 'bypass.requests.' + id);
  }
  if (bypass.time_axis !== 'utc_iso8601') fail('bypass.time_axis 非法');
  object(bypass.units, 'bypass.units'); exactKeys(bypass.units, new Set(BYPASS_FAR_VARIABLES), 'bypass.units');
  for (const name of BYPASS_FAR_VARIABLES) if (bypass.units[name] !== UNIT_OF(name)) fail('bypass 单位非法：' + name);
  nodes(bypass.grid_nodes, GRID_NODE_FIELDS, BYPASS_GRID_VARIABLES, 33, 'bypass.grid_nodes');
  nodes(bypass.far_nodes, FAR_NODE_FIELDS, BYPASS_FAR_VARIABLES, 2, 'bypass.far_nodes');
  object(bypass.quality, 'bypass.quality'); exactKeys(bypass.quality, new Set(['null_counts', 'missing_reason']), 'bypass.quality');
  const known = new Set(BYPASS_FAR_VARIABLES);
  object(bypass.quality.null_counts, 'bypass.quality.null_counts'); object(bypass.quality.missing_reason, 'bypass.quality.missing_reason');
  for (const [name, count] of Object.entries(bypass.quality.null_counts)) { if (!known.has(name)) fail('bypass.quality 未知变量：' + name); finite(count, 'bypass.quality.null_counts', 0, 1e6); }
  for (const [name, reason] of Object.entries(bypass.quality.missing_reason)) { if (!known.has(name) || !MISSING_REASONS.has(reason)) fail('bypass.quality.missing_reason 非法：' + name); }
  if (new TextEncoder().encode(canonicalJson(bypass)).byteLength > MAX_BYPASS_UNCOMPRESSED_BYTES) fail('BYPASS_TOO_LARGE');
  return bypass;
}

// Deterministic key next to the Replay object: replay/v1/…/<id>.json.gz → replay/v1/…/<id>.bypass.json.gz
export function bypassObjectKey(replayObjectKey) {
  if (typeof replayObjectKey !== 'string' || !replayObjectKey.endsWith('.json.gz')) throw new Error('BYPASS_KEY_INVALID');
  return replayObjectKey.slice(0, -'.json.gz'.length) + '.bypass.json.gz';
}
