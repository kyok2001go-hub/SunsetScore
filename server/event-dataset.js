const EVENT_CONTEXT_FIELDS = new Set([
  'event_id', 'location_key', 'event_date_local', 'city', 'admin1', 'country',
  'latitude', 'longitude', 'location_source', 'location_id', 'timezone',
  'sunset_time_utc', 'sunset_time_local'
]);

export const SNAPSHOT_FIELDS = Object.freeze([
  'id', 'idempotency_key', 'event_id', 'event_date_local', 'location_key',
  'city', 'country', 'admin1', 'latitude', 'longitude', 'location_source',
  'location_id', 'timezone', 'sunset_time_utc', 'sunset_time_local',
  'sunset_azimuth', 'twilight_minutes', 'best_viewing_window', 'query_id',
  'prediction_time_utc', 'prediction_time_epoch', 'submitted_at_utc',
  'submitted_at_epoch', 'snapshot_source', 'scheduled_slot', 'app_version',
  'model_version', 'schema_version', 'dataset_schema_version', 'asset_revision',
  'predicted_score', 'predicted_level', 'baseline_score', 'baseline_level',
  'regime_label', 'regime_strength', 'sky_evolution_state',
  'sky_evolution_factor', 'gw_factor', 'comp_sky_canvas', 'comp_horizon',
  'comp_illumination', 'comp_atmosphere', 'comp_weather', 'cloud_cover_total',
  'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'corridor_cloud_mid',
  'corridor_cloud_high', 'anti_sunset_score', 'spatial_variance',
  'cloud_continuity', 'aod', 'pm25', 'humidity', 'surface_pressure',
  'visibility_km', 'precipitation', 'layer_wind_850_speed',
  'layer_wind_850_dir', 'layer_wind_700_speed', 'layer_wind_700_dir',
  'layer_wind_500_speed', 'layer_wind_500_dir', 'is_real_sounding',
  'open_prob_30m', 'open_prob_60m', 'open_prob_120m', 'arrival_risk_30m',
  'arrival_risk_60m', 'tile_radar_available', 'tile_sat_available',
  'dyn_weight_canvas', 'dyn_weight_horizon', 'dyn_weight_illum',
  'dyn_weight_atmo', 'dyn_weight_weather', 'raw_snapshot_json'
]);

export const OBSERVATION_FIELDS = Object.freeze([
  'id', 'submission_id', 'event_id', 'event_date_local', 'location_key',
  'snapshot_id', 'city', 'country', 'admin1', 'latitude', 'longitude',
  'location_source', 'location_id', 'timezone', 'sunset_time_utc',
  'sunset_time_local', 'submitted_at_utc', 'submitted_at_epoch', 'rating',
  'rating_label', 'comment', 'source', 'confidence', 'evidence_count',
  'user_ip_hash', 'client_ua', 'dataset_schema_version'
]);

const SNAPSHOT_INPUT_FIELDS = new Set(SNAPSHOT_FIELDS.filter((field) => ![
  'id', 'event_id', 'event_date_local', 'location_key',
  'city', 'country', 'admin1', 'latitude', 'longitude', 'location_source',
  'location_id', 'timezone', 'sunset_time_utc', 'sunset_time_local',
  'prediction_time_epoch', 'submitted_at_utc', 'submitted_at_epoch'
].includes(field)).concat('event_context'));

const OBSERVATION_INPUT_FIELDS = new Set([
  'submission_id', 'event_context', 'rating', 'comment', 'source',
  'confidence', 'evidence_count'
]);

export const RATING_LABELS = Object.freeze({
  great: '🔥 极佳彩霞',
  good: '✨ 普通有霞',
  fair: '⛅ 仅微霞',
  poor: '🌧️ 完全无霞'
});

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(label + ' 必须是对象');
  }
  return value;
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(label + ' 包含未知字段：' + key);
  }
}

function text(value, label, max, required = false) {
  if (value == null || value === '') {
    if (required) throw new ValidationError(label + ' 不能为空');
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(label + ' 必须是字符串');
  const result = value.trim();
  if (!result && required) throw new ValidationError(label + ' 不能为空');
  if (result.length > max) throw new ValidationError(label + ' 过长');
  return result || null;
}

function number(value, label, min, max, required = false) {
  if (value == null || value === '') {
    if (required) throw new ValidationError(label + ' 不能为空');
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(label + ' 非法');
  }
  return value;
}

function integer(value, label, min, max, required = false) {
  const result = number(value, label, min, max, required);
  if (result != null && !Number.isInteger(result)) throw new ValidationError(label + ' 必须是整数');
  return result;
}

function isoTime(value, label) {
  const result = text(value, label, 40, true);
  const epoch = Date.parse(result);
  if (!Number.isFinite(epoch)) throw new ValidationError(label + ' 非法');
  return { iso: new Date(epoch).toISOString(), epoch };
}

function normalizeLocationSource(value) {
  const source = text(value, 'location_source', 32, false);
  if (source && !/^[a-z0-9_-]+$/i.test(source)) throw new ValidationError('location_source 非法');
  return source ? source.toLowerCase() : null;
}

function normalizeLocationId(source, value) {
  let id = text(value == null ? null : String(value), 'location_id', 120, false);
  if (!id) return null;
  if (source && id.toLowerCase().startsWith(source + ':')) id = id.slice(source.length + 1);
  if (!/^[a-z0-9_.:-]+$/i.test(id)) throw new ValidationError('location_id 非法');
  return id;
}

function dateInTimezone(epoch, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(epoch));
    const values = {};
    for (const part of parts) values[part.type] = part.value;
    if (!values.year || !values.month || !values.day) throw new Error('missing date parts');
    return values.year + '-' + values.month + '-' + values.day;
  } catch {
    throw new ValidationError('timezone 非法');
  }
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value) {
  const data = new TextEncoder().encode(String(value));
  return bytesToHex(await crypto.subtle.digest('SHA-256', data));
}

export async function normalizeEventContext(input) {
  const sourceInput = object(input, 'event_context');
  rejectUnknown(sourceInput, EVENT_CONTEXT_FIELDS, 'event_context');
  const eventDate = text(sourceInput.event_date_local, 'event_date_local', 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new ValidationError('event_date_local 非法');
  const latitude = number(sourceInput.latitude, 'latitude', -90, 90, true);
  const longitude = number(sourceInput.longitude, 'longitude', -180, 180, true);
  const timezone = text(sourceInput.timezone, 'timezone', 80, true);
  const source = normalizeLocationSource(sourceInput.location_source);
  const locationId = normalizeLocationId(source, sourceInput.location_id);
  if ((source && !locationId) || (!source && locationId)) {
    throw new ValidationError('location_source 与 location_id 必须同时提供');
  }
  const locationKey = source && locationId
    ? source + ':' + locationId
    : latitude.toFixed(4) + ',' + longitude.toFixed(4) + ':' + timezone;
  const locationHash = (await sha256(locationKey)).slice(0, 20);
  const sunset = isoTime(sourceInput.sunset_time_utc, 'sunset_time_utc');
  if (dateInTimezone(sunset.epoch, timezone) !== eventDate) {
    throw new ValidationError('event_date_local 与当地日落日期不一致');
  }
  const eventId = 'evt_v1_' + locationHash + '_' + eventDate;
  if (sourceInput.location_key != null && sourceInput.location_key !== locationKey) {
    throw new ValidationError('location_key 校验失败');
  }
  if (sourceInput.event_id != null && sourceInput.event_id !== eventId) {
    throw new ValidationError('event_id 校验失败');
  }
  return {
    event_id: eventId,
    location_key: locationKey,
    event_date_local: eventDate,
    city: text(sourceInput.city, 'city', 100, true),
    admin1: text(sourceInput.admin1, 'admin1', 100),
    country: text(sourceInput.country, 'country', 100),
    latitude,
    longitude,
    location_source: source,
    location_id: locationId,
    timezone,
    sunset_time_utc: sunset.iso,
    sunset_time_local: text(sourceInput.sunset_time_local, 'sunset_time_local', 40, true),
    sunset_epoch: sunset.epoch
  };
}

function optionalNumberMap(input, target, names, min = -1000000, max = 1000000) {
  for (const name of names) target[name] = number(input[name], name, min, max);
}

export async function buildSnapshotRow(input, options = {}) {
  const payload = object(input, 'snapshot');
  rejectUnknown(payload, SNAPSHOT_INPUT_FIELDS, 'snapshot');
  const event = await normalizeEventContext(payload.event_context);
  const source = options.source || text(payload.snapshot_source, 'snapshot_source', 30, true);
  if (!['github_schedule', 'github_manual', 'user_feedback'].includes(source)) {
    throw new ValidationError('snapshot_source 非法');
  }
  let slot = payload.scheduled_slot == null ? null : text(payload.scheduled_slot, 'scheduled_slot', 4, true);
  if (source === 'user_feedback') slot = null;
  else if (!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(slot || '')) throw new ValidationError('scheduled_slot 非法');
  const prediction = isoTime(payload.prediction_time_utc, 'prediction_time_utc');
  const submittedAt = options.submittedAt || new Date();
  const submissionId = options.submissionId || null;
  const modelVersion = text(payload.model_version, 'model_version', 30, true);
  const keyMaterial = source === 'user_feedback'
    ? [event.event_id, source, submissionId, modelVersion].join('|')
    : [event.event_id, source, slot, modelVersion].join('|');
  if (source === 'user_feedback' && !submissionId) throw new ValidationError('用户快照缺少 submission_id');
  const idempotencyKey = 'snap_v1_' + (await sha256(keyMaterial));
  if (payload.idempotency_key != null &&
      text(payload.idempotency_key, 'idempotency_key', 80, true) !== idempotencyKey) {
    throw new ValidationError('idempotency_key 校验失败');
  }
  const row = {
    id: options.id || 'snap_' + submittedAt.getTime() + '_' + crypto.randomUUID(),
    idempotency_key: idempotencyKey,
    ...event,
    sunset_epoch: undefined,
    sunset_azimuth: number(payload.sunset_azimuth, 'sunset_azimuth', 0, 360),
    twilight_minutes: integer(payload.twilight_minutes, 'twilight_minutes', 0, 240),
    best_viewing_window: text(payload.best_viewing_window, 'best_viewing_window', 120),
    query_id: text(payload.query_id, 'query_id', 120, true),
    prediction_time_utc: prediction.iso,
    prediction_time_epoch: prediction.epoch,
    submitted_at_utc: submittedAt.toISOString(),
    submitted_at_epoch: submittedAt.getTime(),
    snapshot_source: source,
    scheduled_slot: slot,
    app_version: text(payload.app_version, 'app_version', 30, true),
    model_version: modelVersion,
    schema_version: integer(payload.schema_version, 'schema_version', 1, 1000, true),
    dataset_schema_version: integer(payload.dataset_schema_version, 'dataset_schema_version', 1, 1000, true),
    asset_revision: text(payload.asset_revision, 'asset_revision', 50),
    predicted_score: integer(payload.predicted_score, 'predicted_score', 0, 100, true),
    predicted_level: text(payload.predicted_level, 'predicted_level', 30, true),
    baseline_score: integer(payload.baseline_score, 'baseline_score', 0, 100),
    baseline_level: text(payload.baseline_level, 'baseline_level', 30),
    regime_label: text(payload.regime_label, 'regime_label', 100),
    regime_strength: number(payload.regime_strength, 'regime_strength', 0, 1),
    sky_evolution_state: text(payload.sky_evolution_state, 'sky_evolution_state', 50),
    sky_evolution_factor: number(payload.sky_evolution_factor, 'sky_evolution_factor', 0, 5),
    gw_factor: number(payload.gw_factor, 'gw_factor', 0, 5),
    raw_snapshot_json: text(payload.raw_snapshot_json, 'raw_snapshot_json', 250000)
  };
  if (row.raw_snapshot_json != null) {
    try {
      const rawSnapshot = JSON.parse(row.raw_snapshot_json);
      if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) throw new Error('not an object');
    } catch {
      throw new ValidationError('raw_snapshot_json 不是有效对象 JSON');
    }
  }
  optionalNumberMap(payload, row, [
    'comp_sky_canvas', 'comp_horizon', 'comp_illumination', 'comp_atmosphere',
    'comp_weather', 'cloud_cover_total', 'cloud_cover_low', 'cloud_cover_mid',
    'cloud_cover_high', 'corridor_cloud_mid', 'corridor_cloud_high',
    'anti_sunset_score', 'spatial_variance', 'cloud_continuity', 'aod', 'pm25',
    'humidity', 'surface_pressure', 'visibility_km', 'precipitation',
    'layer_wind_850_speed', 'layer_wind_850_dir', 'layer_wind_700_speed',
    'layer_wind_700_dir', 'layer_wind_500_speed', 'layer_wind_500_dir',
    'open_prob_30m', 'open_prob_60m', 'open_prob_120m', 'arrival_risk_30m',
    'arrival_risk_60m', 'dyn_weight_canvas', 'dyn_weight_horizon',
    'dyn_weight_illum', 'dyn_weight_atmo', 'dyn_weight_weather'
  ]);
  for (const flag of ['is_real_sounding', 'tile_radar_available', 'tile_sat_available']) {
    row[flag] = integer(payload[flag] == null ? 0 : payload[flag], flag, 0, 1, true);
  }
  return row;
}

export async function buildObservationRow(input, options = {}) {
  const payload = object(input, 'observation');
  rejectUnknown(payload, OBSERVATION_INPUT_FIELDS, 'observation');
  const event = await normalizeEventContext(payload.event_context);
  const rating = text(payload.rating, 'rating', 10, true);
  if (!RATING_LABELS[rating]) throw new ValidationError('rating 非法');
  const source = text(payload.source, 'source', 30, true);
  if (!['user', 'rednote_agent'].includes(source)) throw new ValidationError('source 非法');
  const submittedAt = options.submittedAt || new Date();
  return {
    id: options.id || 'obs_' + submittedAt.getTime() + '_' + crypto.randomUUID(),
    submission_id: text(payload.submission_id, 'submission_id', 120, true),
    event_id: event.event_id,
    event_date_local: event.event_date_local,
    location_key: event.location_key,
    snapshot_id: options.snapshotId || null,
    city: event.city,
    country: event.country,
    admin1: event.admin1,
    latitude: event.latitude,
    longitude: event.longitude,
    location_source: event.location_source,
    location_id: event.location_id,
    timezone: event.timezone,
    sunset_time_utc: event.sunset_time_utc,
    sunset_time_local: event.sunset_time_local,
    submitted_at_utc: submittedAt.toISOString(),
    submitted_at_epoch: submittedAt.getTime(),
    rating,
    rating_label: RATING_LABELS[rating],
    comment: text(payload.comment, 'comment', 200),
    source,
    confidence: number(payload.confidence, 'confidence', 0, 1),
    evidence_count: integer(payload.evidence_count, 'evidence_count', 0, 10000),
    user_ip_hash: options.userIpHash || null,
    client_ua: options.clientUa || null,
    dataset_schema_version: options.datasetSchemaVersion || 1,
    sunset_epoch: event.sunset_epoch
  };
}

export async function readJsonBody(request, maxBytes = 320000) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ValidationError('请求体过大');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new ValidationError('请求体过大');
  try { return JSON.parse(raw); }
  catch { throw new ValidationError('请求体不是有效 JSON'); }
}

export function insertStatement(db, table, fields, row) {
  const placeholders = fields.map(() => '?').join(', ');
  const sql = 'INSERT INTO ' + table + ' (' + fields.join(', ') + ') VALUES (' + placeholders + ')';
  return db.prepare(sql).bind(...fields.map((field) => row[field] == null ? null : row[field]));
}

export async function hashClientIp(request) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  return ip ? sha256(ip + '_ss_salt') : null;
}

export function isUniqueError(error) {
  return /UNIQUE constraint failed|constraint failed/i.test(String(error && error.message || error));
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
