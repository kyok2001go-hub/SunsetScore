// V2.5.5.7 bypass capture V1 (record-only): strict validation of the object written next to a READY Replay.
// The Replay contract is unchanged; this object is never consumed by scoring. PRD: ref_docs/PRD/V2.5.5.7--旁路采集V1方案.md
import { ValidationError } from './event-dataset.js';
import { canonicalJson } from './replay-schema.js';

// v1 (V2.5.5.7): satellite_shadow must be null. v2 (V2.5.5.8): null or the Band13 shadow object below.
export const BYPASS_SCHEMA_VERSION = 2;
export const BYPASS_SCHEMA_VERSIONS = Object.freeze([1, 2]);
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

const SHADOW_FIELDS = new Set(['shadow_schema_version', 'record_only', 'classifier_version', 'status', 'reason_code', 'satellite', 'layer',
  'tile_matrix_set', 'zoom', 'sample_step_px', 'geometry', 'domain', 'frames', 'samples', 'colormap']);
const SHADOW_STATUS = new Set(['OK', 'NO_COVERAGE', 'STALE', 'GAP', 'DOMAIN_FAILED', 'TILES_FAILED', 'INSUFFICIENT_SAMPLES', 'TIME_MISMATCH', 'CAPTURE_ERROR']);
const FRAME_STATUS = new Set(['OK', 'TILES_FAILED', 'TIME_MISMATCH', 'INSUFFICIENT_SAMPLES']);
const SATELLITE_LAYERS = Object.freeze({ himawari: 'Himawari_AHI_Band13_Clean_Infrared',
  'goes-west': 'GOES-West_ABI_Band13_Clean_Infrared', 'goes-east': 'GOES-East_ABI_Band13_Clean_Infrared' });
const MAX_SHADOW_POINTS = 1000;
function integer(value, label, min, max) { if (!Number.isInteger(value) || value < min || value > max) fail(label + ' 非法'); }
function ratio(value, label) { finite(value, label, 0, 1, true); }
function bt(value, label) { finite(value, label, -100, 60, true); }

// V2.5.5.8 satellite shadow (Band13, record-only). PRD: ref_docs/PRD/V2.5.5.8--卫星影子采集方案.md §3.5
export function validateSatelliteShadow(shadow) {
  const L = 'satellite_shadow';
  object(shadow, L); exactKeys(shadow, SHADOW_FIELDS, L);
  if (shadow.shadow_schema_version !== 1 || shadow.record_only !== true || shadow.classifier_version !== 1) fail(L + ' 版本或标记非法');
  if (!SHADOW_STATUS.has(shadow.status)) fail(L + '.status 非法');
  string(shadow.reason_code, L + '.reason_code', 40, true);
  if (shadow.satellite === null ? shadow.layer !== null : SATELLITE_LAYERS[shadow.satellite] !== shadow.layer) fail(L + ' 卫星与图层不符');
  if (shadow.tile_matrix_set !== 'GoogleMapsCompatible_Level6') fail(L + '.tile_matrix_set 非法');
  integer(shadow.zoom, L + '.zoom', 0, 6); integer(shadow.sample_step_px, L + '.sample_step_px', 1, 8);
  if (shadow.geometry !== null) {
    object(shadow.geometry, L + '.geometry');
    exactKeys(shadow.geometry, new Set(['sunset_azimuth_deg', 'half_width_deg', 'max_radius_km', 'bands_km']), L + '.geometry');
    finite(shadow.geometry.sunset_azimuth_deg, L + '.geometry.sunset_azimuth_deg', 0, 360, true);
    finite(shadow.geometry.half_width_deg, L + '.geometry.half_width_deg', 1, 90); finite(shadow.geometry.max_radius_km, L + '.geometry.max_radius_km', 1, 1000);
    if (!Array.isArray(shadow.geometry.bands_km) || shadow.geometry.bands_km.length > 6 ||
        shadow.geometry.bands_km.some((b) => !Array.isArray(b) || b.length !== 2 || !b.every(Number.isFinite))) fail(L + '.geometry.bands_km 非法');
  }
  if (shadow.domain !== null) {
    object(shadow.domain, L + '.domain'); exactKeys(shadow.domain, new Set(['requested_window_utc', 'fetched_at_utc', 'available_times_count']), L + '.domain');
    if (!Array.isArray(shadow.domain.requested_window_utc) || shadow.domain.requested_window_utc.length !== 2) fail(L + '.domain.requested_window_utc 非法');
    shadow.domain.requested_window_utc.forEach((t, i) => iso(t, `${L}.domain.requested_window_utc[${i}]`));
    iso(shadow.domain.fetched_at_utc, L + '.domain.fetched_at_utc'); integer(shadow.domain.available_times_count, L + '.domain.available_times_count', 0, 5000);
  }
  if (!Array.isArray(shadow.frames) || shadow.frames.length > 3) fail(L + '.frames 数量非法');
  for (const [index, frame] of shadow.frames.entries()) {
    const W = `${L}.frames[${index}]`;
    object(frame, W);
    exactKeys(frame, new Set(['time_utc', 'time_actual_utc', 'age_minutes', 'status', 'tiles_requested', 'tiles_ok', 'valid_sample_ratio', 'summary']), W);
    iso(frame.time_utc, W + '.time_utc'); iso(frame.time_actual_utc, W + '.time_actual_utc', true);
    finite(frame.age_minutes, W + '.age_minutes', -10, 1440);
    if (!FRAME_STATUS.has(frame.status)) fail(W + '.status 非法');
    integer(frame.tiles_requested, W + '.tiles_requested', 0, 64); integer(frame.tiles_ok, W + '.tiles_ok', 0, frame.tiles_requested);
    ratio(frame.valid_sample_ratio, W + '.valid_sample_ratio');
    if ((frame.status === 'OK') !== (frame.summary !== null)) fail(W + '.summary 与状态不符');
    if (frame.summary !== null) {
      const S = frame.summary;
      object(S, W + '.summary');
      exactKeys(S, new Set(['frac_cold_high', 'frac_mid', 'frac_cloud_v1', 'bt_p10', 'bt_p50', 'bt_p90', 'bands']), W + '.summary');
      ['frac_cold_high', 'frac_mid', 'frac_cloud_v1'].forEach((k) => ratio(S[k], `${W}.summary.${k}`));
      ['bt_p10', 'bt_p50', 'bt_p90'].forEach((k) => bt(S[k], `${W}.summary.${k}`));
      if (!Array.isArray(S.bands) || S.bands.length > 6) fail(W + '.summary.bands 非法');
      for (const band of S.bands) {
        object(band, W + '.summary.bands'); exactKeys(band, new Set(['band_km', 'valid', 'frac_cloud_v1']), W + '.summary.bands');
        if (!Array.isArray(band.band_km) || band.band_km.length !== 2 || !band.band_km.every(Number.isFinite)) fail(W + '.summary.bands.band_km 非法');
        integer(band.valid, W + '.summary.bands.valid', 0, MAX_SHADOW_POINTS); ratio(band.frac_cloud_v1, W + '.summary.bands.frac_cloud_v1');
      }
    }
  }
  if (shadow.status === 'OK' && !shadow.frames.some((f) => f.status === 'OK')) fail(L + ' 状态为 OK 但没有有效帧');
  if (shadow.samples !== null) {
    object(shadow.samples, L + '.samples'); exactKeys(shadow.samples, new Set(['points', 'bt_c_by_frame']), L + '.samples');
    const points = shadow.samples.points;
    if (!Array.isArray(points) || points.length > MAX_SHADOW_POINTS) fail(L + '.samples.points 数量非法');
    points.forEach((p, i) => { if (!Array.isArray(p) || p.length !== 2) fail(`${L}.samples.points[${i}] 非法`);
      finite(p[0], `${L}.samples.points[${i}][0]`, -180, 180); finite(p[1], `${L}.samples.points[${i}][1]`, 0, 2000); });
    const byFrame = shadow.samples.bt_c_by_frame;
    if (!Array.isArray(byFrame) || byFrame.length !== shadow.frames.length) fail(L + '.samples.bt_c_by_frame 与帧数不符');
    byFrame.forEach((row, f) => { if (!Array.isArray(row) || row.length !== points.length) fail(`${L}.samples.bt_c_by_frame[${f}] 长度非法`);
      row.forEach((v, i) => bt(v, `${L}.samples.bt_c_by_frame[${f}][${i}]`)); });
  }
  if (shadow.colormap !== null) {
    object(shadow.colormap, L + '.colormap'); exactKeys(shadow.colormap, new Set(['url', 'sha256', 'match_max_rgb_distance', 'ambiguous_colors']), L + '.colormap');
    integer(shadow.colormap.match_max_rgb_distance, L + '.colormap.match_max_rgb_distance', 0, 16);
    integer(shadow.colormap.ambiguous_colors, L + '.colormap.ambiguous_colors', 0, 256);
    string(shadow.colormap.url, L + '.colormap.url', 200);
    if (typeof shadow.colormap.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(shadow.colormap.sha256)) fail(L + '.colormap.sha256 非法');
  }
  return shadow;
}

// expected: { prediction_time_utc, sunset_time_utc, latitude, longitude } taken from the validated Replay of the same request.
export function validateBypassPayload(bypass, expected) {
  object(bypass, 'bypass'); exactKeys(bypass, TOP_FIELDS, 'bypass');
  if (!BYPASS_SCHEMA_VERSIONS.includes(bypass.bypass_schema_version)) fail('bypass_schema_version 不受支持');
  if (bypass.record_only !== true) fail('bypass.record_only 必须为 true');
  if (bypass.snapshot_id !== null) fail('bypass.snapshot_id 由服务端写入，提交时必须为 null');
  // v1 reserved satellite_shadow (always null); v2 defines it (V2.5.5.8).
  if (bypass.bypass_schema_version === 1 && bypass.satellite_shadow !== null) fail('BYPASS_SATELLITE_SHADOW_NOT_DEFINED');
  if (bypass.bypass_schema_version === 2 && bypass.satellite_shadow !== null) validateSatelliteShadow(bypass.satellite_shadow);
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
