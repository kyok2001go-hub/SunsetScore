import { ValidationError, sha256 } from './event-dataset.js';

export const REPLAY_SCHEMA_VERSION = 1;
export const REPLAY_MAX_BODY_BYTES = 1536 * 1024;

const TOP_FIELDS = new Set([
  'replay_schema_version', 'identity', 'context', 'effective_config',
  'nwp', 'air_quality', 'minute_precip', 'radar', 'satellite',
  'cloud_motion', 'engine_inputs'
]);
const IDENTITY_FIELDS = new Set([
  'prediction_time_utc', 'model_version', 'engine_code_version',
  'engine_build_sha', 'config_hash', 'snapshot_id', 'event_id'
]);
const CONTEXT_FIELDS = new Set([
  'city', 'admin1', 'country', 'latitude', 'longitude', 'timezone',
  'utc_offset_seconds', 'sunset_time_utc', 'civil_dusk_utc',
  'golden_hour_start_utc', 'golden_hour_end_utc', 'sunset_azimuth_deg',
  'twilight_minutes', 'dataset_schema_version', 'app_version',
  'model_version', 'asset_revision'
]);
const ENGINE_INPUT_FIELDS = new Set([
  'sampling_mode', 'cache_status', 'data_age_minutes', 'expected_sample_count',
  'total_sky_node_count', 'spatial_completeness', 'spatial_fallback_reason',
  'actual_sky_node_keys', 'actual_corridor_nodes', 'source_degradation_flags'
]);
const NWP_FIELDS = new Set(['time_axis', 'units', 'nodes']);
const NWP_NODE_FIELDS = new Set([
  'key', 'direction', 'azimuth', 'distance_km', 'azimuth_offset', 'latitude',
  'longitude', 'weight', 'timezone', 'utc_offset_seconds', 'time_utc', 'variables'
]);
const AIR_FIELDS = new Set(['available', 'time_axis', 'time_utc', 'units', 'variables']);
const MINUTE_FIELDS = new Set(['available', 'source', 'time_axis', 'coverage_start', 'coverage_end', 'step_ms', 'interval_anchor', 'minute_series']);
const VISUAL_FIELDS = new Set(['available', 'source', 'source_status', 'layer', 'coverage_series']);
const MOTION_FIELDS = new Set(['input_mode', 'base_time_utc', 'forecast_horizons_minutes', 'wind_source_flags', 'source_quality_flags']);
const CORRIDOR_FIELDS = new Set(['latitude', 'longitude', 'distance_km', 'azimuth_offset', 'role', 'weight', 'source_node_keys', 'interpolation_policy_version']);
const NWP_UNITS = Object.freeze({
  cloud_cover: 'percent', cloud_cover_low: 'percent', cloud_cover_mid: 'percent', cloud_cover_high: 'percent',
  visibility: 'meter', relative_humidity_2m: 'percent', precipitation: 'millimeter',
  precipitation_probability: 'percent', wind_speed_10m: 'km/h', wind_direction_10m: 'degree_from_north',
  wind_gusts_10m: 'km/h', surface_pressure: 'hPa', wind_speed_850hPa: 'km/h',
  wind_direction_850hPa: 'degree_from_north', wind_speed_700hPa: 'km/h',
  wind_direction_700hPa: 'degree_from_north', wind_speed_500hPa: 'km/h',
  wind_direction_500hPa: 'degree_from_north'
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(label + ' 必须是对象');
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(label + ' 包含未知字段：' + key);
  }
}

function requiredString(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ValidationError(label + ' 非法');
  }
  return value;
}

function finite(value, label, min = -1e12, max = 1e12, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(label + ' 非法');
  }
  return value;
}

function epochMs(value, label) {
  return finite(value, label, 0, 8.64e15);
}

function iso(value, label, nullable = false) {
  if (nullable && value == null) return null;
  requiredString(value, label, 40);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ValidationError(label + ' 必须是 UTC ISO-8601');
  }
  return value;
}

function assertSafeJson(value, label, depth = 0) {
  if (depth > 16) throw new ValidationError(label + ' 嵌套过深');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(label + ' 包含非有限数值');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new ValidationError(label + ' 数组过长');
    value.forEach((item, index) => assertSafeJson(item, label + '[' + index + ']', depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 256) throw new ValidationError(label + ' 字段过多');
    keys.forEach((key) => assertSafeJson(value[key], label + '.' + key, depth + 1));
    return;
  }
  throw new ValidationError(label + ' 包含不可序列化值');
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function validateNwp(nwp) {
  object(nwp, 'sources.nwp');
  exactKeys(nwp, NWP_FIELDS, 'sources.nwp');
  if (nwp.time_axis !== 'utc_iso8601') throw new ValidationError('NWP 时间轴必须为 UTC ISO-8601');
  object(nwp.units, 'sources.nwp.units');
  exactKeys(nwp.units, new Set(Object.keys(NWP_UNITS)), 'sources.nwp.units');
  for (const [name, unit] of Object.entries(NWP_UNITS)) {
    if (nwp.units[name] !== unit) throw new ValidationError('NWP 单位非法：' + name);
  }
  if (!Array.isArray(nwp.nodes) || !nwp.nodes.length || nwp.nodes.length > 40) {
    throw new ValidationError('NWP 节点数量非法');
  }
  for (const [index, node] of nwp.nodes.entries()) {
    object(node, 'NWP node');
    exactKeys(node, NWP_NODE_FIELDS, 'NWP node');
    requiredString(node.key, 'NWP node.key', 80);
    finite(node.latitude, 'NWP latitude', -90, 90);
    finite(node.longitude, 'NWP longitude', -180, 180);
    if (!Array.isArray(node.time_utc) || !node.time_utc.length || node.time_utc.length > 96) {
      throw new ValidationError('NWP 时间序列长度非法');
    }
    node.time_utc.forEach((time, timeIndex) => iso(time, `NWP node ${index} time ${timeIndex}`));
    object(node.variables, 'NWP node.variables');
    exactKeys(node.variables, new Set(Object.keys(NWP_UNITS)), 'NWP node.variables');
    for (const name of Object.keys(NWP_UNITS)) {
      if (!Array.isArray(node.variables[name])) throw new ValidationError('NWP 缺少变量：' + name);
    }
    for (const [name, values] of Object.entries(node.variables)) {
      if (!Object.prototype.hasOwnProperty.call(nwp.units, name)) throw new ValidationError('NWP 变量缺少单位：' + name);
      if (!Array.isArray(values) || values.length !== node.time_utc.length) {
        throw new ValidationError('NWP 变量长度与时间轴不一致：' + name);
      }
      values.forEach((value, valueIndex) => {
        if (value != null) finite(value, `NWP ${name}[${valueIndex}]`);
      });
    }
  }
}

function validateAir(air) {
  object(air, 'air_quality');
  exactKeys(air, AIR_FIELDS, 'air_quality');
  if (typeof air.available !== 'boolean') throw new ValidationError('air_quality.available 非法');
  if (!air.available) return;
  if (air.time_axis !== 'utc_iso8601' || !Array.isArray(air.time_utc) || !air.time_utc.length) throw new ValidationError('AQ 时间轴非法');
  air.time_utc.forEach((value, index) => iso(value, 'AQ time ' + index));
  object(air.units, 'air_quality.units');
  object(air.variables, 'air_quality.variables');
  for (const name of ['aerosol_optical_depth', 'pm2_5']) {
    if (!Array.isArray(air.variables[name]) || air.variables[name].length !== air.time_utc.length) throw new ValidationError('AQ 数组长度非法：' + name);
    if (typeof air.units[name] !== 'string') throw new ValidationError('AQ 单位缺失：' + name);
    air.variables[name].forEach((value, index) => { if (value != null) finite(value, `AQ ${name}[${index}]`); });
  }
  if (air.units.aerosol_optical_depth !== 'dimensionless' || air.units.pm2_5 !== 'µg/m³') throw new ValidationError('AQ 单位非法');
}

function validateMinute(value) {
  object(value, 'minute_precip');
  exactKeys(value, MINUTE_FIELDS, 'minute_precip');
  if (typeof value.available !== 'boolean') throw new ValidationError('minute_precip.available 非法');
  if (!value.available) return;
  if (value.time_axis !== 'utc_epoch_ms') throw new ValidationError('minute_precip 时间轴非法');
  epochMs(value.coverage_start, 'coverage_start'); epochMs(value.coverage_end, 'coverage_end');
  finite(value.step_ms, 'step_ms', 1); requiredString(value.interval_anchor, 'interval_anchor', 30);
  const series = object(value.minute_series, 'minute_series');
  const times = series.time_utc_ms, precip = series.precipitation_mm;
  if (!Array.isArray(times) || !Array.isArray(precip) || !times.length || times.length !== precip.length || times.length > 600) throw new ValidationError('minute_series 数组长度非法');
  times.forEach((item, index) => epochMs(item, 'minute time ' + index));
  precip.forEach((item, index) => { if (item != null) finite(item, 'minute precip ' + index, 0); });
}

function validateVisual(value, label) {
  object(value, label); exactKeys(value, VISUAL_FIELDS, label);
  if (typeof value.available !== 'boolean') throw new ValidationError(label + '.available 非法');
  if (!value.available && value.coverage_series == null) return;
  if (!Array.isArray(value.coverage_series) || value.coverage_series.length > 100) throw new ValidationError(label + '.coverage_series 非法');
  value.coverage_series.forEach((entry, index) => {
    object(entry, label + ' coverage'); exactKeys(entry, new Set(['t', 'pct']), label + ' coverage');
    epochMs(entry.t, label + ' t ' + index); finite(entry.pct, label + ' pct ' + index, 0, 100);
  });
}

export async function validateReplayPayload(input, snapshotRow) {
  const replay = object(input, 'replay');
  exactKeys(replay, TOP_FIELDS, 'replay');
  if (replay.replay_schema_version !== REPLAY_SCHEMA_VERSION) {
    throw new ValidationError('replay_schema_version 不受支持');
  }
  const identity = object(replay.identity, 'identity');
  exactKeys(identity, IDENTITY_FIELDS, 'identity');
  iso(identity.prediction_time_utc, 'identity.prediction_time_utc');
  requiredString(identity.model_version, 'identity.model_version', 30);
  requiredString(identity.engine_code_version, 'identity.engine_code_version', 50);
  requiredString(identity.engine_build_sha, 'identity.engine_build_sha', 80);
  if (!/^[a-f0-9]{64}$/.test(requiredString(identity.config_hash, 'identity.config_hash', 64))) {
    throw new ValidationError('config_hash 非法');
  }
  if (snapshotRow) {
    if (identity.prediction_time_utc !== snapshotRow.prediction_time_utc || identity.model_version !== snapshotRow.model_version) {
      throw new ValidationError('Replay 与 Snapshot 身份不一致');
    }
    if (identity.snapshot_id != null && identity.snapshot_id !== snapshotRow.id) throw new ValidationError('snapshot_id 校验失败');
    if (identity.event_id != null && identity.event_id !== snapshotRow.event_id) throw new ValidationError('event_id 校验失败');
  }

  const context = object(replay.context, 'context');
  exactKeys(context, CONTEXT_FIELDS, 'context');
  requiredString(context.city, 'context.city', 100);
  finite(context.latitude, 'context.latitude', -90, 90);
  finite(context.longitude, 'context.longitude', -180, 180);
  requiredString(context.timezone, 'context.timezone', 80);
  finite(context.utc_offset_seconds, 'context.utc_offset_seconds', -86400, 86400);
  iso(context.sunset_time_utc, 'context.sunset_time_utc');
  iso(context.civil_dusk_utc, 'context.civil_dusk_utc');
  iso(context.golden_hour_start_utc, 'context.golden_hour_start_utc', true);
  iso(context.golden_hour_end_utc, 'context.golden_hour_end_utc', true);
  finite(context.sunset_azimuth_deg, 'context.sunset_azimuth_deg', 0, 360);
  finite(context.twilight_minutes, 'context.twilight_minutes', 0, 240);
  if (context.dataset_schema_version !== 3) throw new ValidationError('dataset_schema_version 必须保持 3');
  requiredString(context.app_version, 'context.app_version', 30);
  requiredString(context.model_version, 'context.model_version', 30);
  requiredString(context.asset_revision, 'context.asset_revision', 50);
  if (snapshotRow && (context.app_version !== snapshotRow.app_version || context.model_version !== snapshotRow.model_version ||
      context.asset_revision !== snapshotRow.asset_revision || context.sunset_time_utc !== snapshotRow.sunset_time_utc ||
      context.latitude !== snapshotRow.latitude || context.longitude !== snapshotRow.longitude)) {
    throw new ValidationError('Replay context 与 Snapshot 不一致');
  }

  object(replay.effective_config, 'effective_config');
  assertSafeJson(replay.effective_config, 'effective_config');
  if (await sha256(canonicalJson(replay.effective_config)) !== identity.config_hash) {
    throw new ValidationError('config_hash 校验失败');
  }
  validateNwp(replay.nwp);
  validateAir(replay.air_quality);
  validateMinute(replay.minute_precip);
  validateVisual(replay.radar, 'radar');
  validateVisual(replay.satellite, 'satellite');
  const motion = object(replay.cloud_motion, 'cloud_motion');
  exactKeys(motion, MOTION_FIELDS, 'cloud_motion');
  requiredString(motion.input_mode, 'cloud_motion.input_mode', 30);
  iso(motion.base_time_utc, 'cloud_motion.base_time_utc');
  if (!Array.isArray(motion.forecast_horizons_minutes) || !motion.forecast_horizons_minutes.length) throw new ValidationError('forecast_horizons_minutes 非法');
  motion.forecast_horizons_minutes.forEach((value, index) => finite(value, 'forecast horizon ' + index, 1, 1440));
  object(motion.wind_source_flags, 'wind_source_flags'); object(motion.source_quality_flags, 'source_quality_flags');

  const execution = object(replay.engine_inputs, 'engine_inputs');
  exactKeys(execution, ENGINE_INPUT_FIELDS, 'engine_inputs');
  requiredString(execution.sampling_mode, 'engine_inputs.sampling_mode', 40);
  requiredString(execution.cache_status, 'engine_inputs.cache_status', 20);
  finite(execution.data_age_minutes, 'engine_inputs.data_age_minutes', 0, 100000, true);
  finite(execution.expected_sample_count, 'engine_inputs.expected_sample_count', 1, 100, false);
  finite(execution.total_sky_node_count, 'engine_inputs.total_sky_node_count', 1, 100, false);
  finite(execution.spatial_completeness, 'engine_inputs.spatial_completeness', 0, 1);
  if (!Array.isArray(execution.actual_sky_node_keys) || !execution.actual_sky_node_keys.length) {
    throw new ValidationError('actual_sky_node_keys 非法');
  }
  if (!Array.isArray(execution.actual_corridor_nodes) || !execution.actual_corridor_nodes.length) {
    throw new ValidationError('actual_corridor_nodes 非法');
  }
  execution.actual_corridor_nodes.forEach((entry, index) => {
    object(entry, 'actual_corridor_nodes'); exactKeys(entry, CORRIDOR_FIELDS, 'actual_corridor_nodes');
    finite(entry.latitude, 'corridor latitude', -90, 90); finite(entry.longitude, 'corridor longitude', -180, 180);
    finite(entry.distance_km, 'corridor distance', 0, 1000); finite(entry.azimuth_offset, 'corridor azimuth_offset', -360, 360);
    requiredString(entry.role, 'corridor role', 30); finite(entry.weight, 'corridor weight', 0, 10, true);
    if (!Array.isArray(entry.source_node_keys) || !entry.source_node_keys.length) throw new ValidationError('corridor source_node_keys 非法：' + index);
  });
  assertSafeJson(replay, 'replay');
  return canonicalize(replay);
}
