// Offline V1 is frozen independently of the online database contract.
export const OFFLINE_DATASET_SCHEMA_VERSION = 1;
export const CONSISTENCY_POLICY = 'cutoff_ready_time_recheck_v1';
export const SNAPSHOT_OFFLINE_FIELDS = Object.freeze([
  "id",
  "idempotency_key",
  "event_id",
  "event_date_local",
  "location_key",
  "city",
  "country",
  "admin1",
  "latitude",
  "longitude",
  "location_source",
  "location_id",
  "timezone",
  "sunset_time_utc",
  "sunset_time_local",
  "sunset_azimuth",
  "twilight_minutes",
  "best_viewing_window",
  "query_id",
  "prediction_time_utc",
  "prediction_time_epoch",
  "submitted_at_utc",
  "submitted_at_epoch",
  "snapshot_source",
  "scheduled_slot",
  "app_version",
  "model_version",
  "schema_version",
  "dataset_schema_version",
  "asset_revision",
  "predicted_score",
  "predicted_level",
  "baseline_score",
  "baseline_level",
  "regime_label",
  "regime_strength",
  "sky_evolution_state",
  "sky_evolution_factor",
  "gw_factor",
  "comp_sky_canvas",
  "comp_horizon",
  "comp_illumination",
  "comp_atmosphere",
  "comp_weather",
  "cloud_cover_total",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "corridor_cloud_mid",
  "corridor_cloud_high",
  "anti_sunset_score",
  "spatial_variance",
  "cloud_continuity",
  "aod",
  "pm25",
  "humidity",
  "surface_pressure",
  "visibility_km",
  "precipitation",
  "layer_wind_850_speed",
  "layer_wind_850_dir",
  "layer_wind_700_speed",
  "layer_wind_700_dir",
  "layer_wind_500_speed",
  "layer_wind_500_dir",
  "is_real_sounding",
  "open_prob_30m",
  "open_prob_60m",
  "open_prob_120m",
  "arrival_risk_30m",
  "arrival_risk_60m",
  "tile_radar_available",
  "tile_sat_available",
  "dyn_weight_canvas",
  "dyn_weight_horizon",
  "dyn_weight_illum",
  "dyn_weight_atmo",
  "dyn_weight_weather",
  "lead_time_minutes"
]);
export const OBSERVATION_OFFLINE_FIELDS = Object.freeze([
  "id",
  "submission_id",
  "event_id",
  "snapshot_id",
  "event_date_local",
  "location_key",
  "city",
  "country",
  "admin1",
  "latitude",
  "longitude",
  "location_source",
  "location_id",
  "timezone",
  "sunset_time_utc",
  "sunset_time_local",
  "submitted_at_utc",
  "submitted_at_epoch",
  "rating",
  "rating_label",
  "source",
  "confidence",
  "evidence_count",
  "dataset_schema_version"
]);
export const EVENT_OFFLINE_FIELDS = Object.freeze([
  "event_id",
  "event_date_local",
  "location_key",
  "city",
  "admin1",
  "country",
  "latitude",
  "longitude",
  "timezone",
  "sunset_time_utc",
  "sunset_time_local",
  "snapshot_count",
  "observation_count",
  "replay_count",
  "first_prediction_time_utc",
  "last_prediction_time_utc",
  "max_lead_time_minutes",
  "min_lead_time_minutes",
  "has_snapshot",
  "has_observation",
  "has_replay"
]);
export const REPLAY_INDEX_FIELDS = Object.freeze([
  "snapshot_id",
  "event_id",
  "replay_schema_version",
  "engine_build_sha",
  "config_hash",
  "replay_sha256",
  "replay_size_bytes",
  "replay_compressed_size_bytes",
  "replay_saved_at_utc",
  "local_path"
]);

const words = value => new Set(value.split(/\s+/));
const strings = words(`id idempotency_key event_id event_date_local location_key city country admin1 location_source location_id timezone sunset_time_utc sunset_time_local best_viewing_window query_id prediction_time_utc submitted_at_utc snapshot_source scheduled_slot app_version model_version asset_revision predicted_level baseline_level regime_label sky_evolution_state submission_id snapshot_id rating rating_label source comment engine_build_sha config_hash replay_sha256 replay_saved_at_utc local_path first_prediction_time_utc last_prediction_time_utc`);
const booleans = words('is_real_sounding tile_radar_available tile_sat_available has_snapshot has_observation has_replay');
const integers = words('prediction_time_epoch submitted_at_epoch schema_version dataset_schema_version replay_schema_version predicted_score baseline_score twilight_minutes evidence_count snapshot_count observation_count replay_count replay_size_bytes replay_compressed_size_bytes');
const snapshotRequired = words(`id idempotency_key event_id event_date_local location_key city latitude longitude timezone sunset_time_utc sunset_time_local query_id prediction_time_utc prediction_time_epoch submitted_at_utc submitted_at_epoch snapshot_source app_version model_version schema_version dataset_schema_version predicted_score predicted_level is_real_sounding tile_radar_available tile_sat_available lead_time_minutes`);
const observationNullable = words('snapshot_id country admin1 location_source location_id confidence evidence_count comment');
const enumValues = {
  rating: ['poor', 'fair', 'good', 'very_good', 'excellent'],
  source: ['user', 'rednote_agent', 'rednote_manual'],
  snapshot_source: ['github_schedule', 'github_manual', 'user_feedback']
};
function unit(name, type) {
  if (name.endsWith('_epoch')) return 'ms';
  if (name.endsWith('_bytes')) return 'byte';
  if (name.endsWith('_count')) return 'count';
  if (name.includes('lead_time') || name === 'twilight_minutes') return 'minute';
  if (['latitude', 'longitude', 'sunset_azimuth'].includes(name) || name.endsWith('_dir')) return 'degree';
  if (/^cloud_cover_|^corridor_cloud_|^humidity$/.test(name)) return 'percent';
  if (name === 'spatial_variance') return 'percentage point';
  if (/^comp_|_score$|^cloud_continuity$/.test(name)) return 'score point';
  if (name === 'pm25') return 'µg/m³';
  if (name === 'surface_pressure') return 'hPa';
  if (name === 'visibility_km') return 'km';
  if (name === 'precipitation') return 'mm';
  if (name.endsWith('_speed')) return 'km/h';
  return type === 'number' ? 'dimensionless' : null;
}
function bounds(name) {
  if (name === 'latitude') return [-90, 90];
  if (name === 'longitude') return [-180, 180];
  if (['predicted_score', 'baseline_score'].includes(name)) return [0, 100];
  if (name === 'twilight_minutes') return [0, 240];
  if (name === 'sunset_azimuth') return [0, 360];
  if (/^open_prob_|^arrival_risk_|^dyn_weight_|^confidence$|^regime_strength$/.test(name)) return [0, 1];
  if (['sky_evolution_factor', 'gw_factor'].includes(name)) return [0, 5];
  if (name.endsWith('_schema_version') || name === 'schema_version') return [1, 1000];
  if (name.endsWith('_epoch') || name.endsWith('_count') || name.endsWith('_bytes')) return [0, Number.MAX_SAFE_INTEGER];
  if (strings.has(name) || booleans.has(name) || name.includes('lead_time')) return null;
  // Existing online optionalNumberMap accepts this range. Do not invent model-specific limits.
  return [-1000000, 1000000];
}
const descriptions = {
  id: 'Original database row identifier',
  idempotency_key: 'Snapshot ingestion deduplication identity',
  event_id: 'Sunset event identity derived from location key and local date',
  event_date_local: 'Calendar date of sunset in the location timezone',
  location_key: 'Provider location identity, or rounded WGS84 coordinates and timezone',
  city: 'Original city display name; not a unique event identity',
  country: 'Original country display value', admin1: 'Original first-level administrative area',
  latitude: 'WGS84 latitude', longitude: 'WGS84 longitude',
  location_source: 'Location identity provider namespace', location_id: 'Provider location identifier',
  timezone: 'Location IANA timezone identifier', sunset_time_utc: 'Sunset instant in UTC',
  sunset_azimuth: 'Sunset bearing clockwise from north', twilight_minutes: 'Civil twilight duration',
  best_viewing_window: 'Original recommended viewing-window display text',
  query_id: 'Prediction query identifier', prediction_time_utc: 'Prediction instant in UTC',
  prediction_time_epoch: 'Prediction instant as UTC epoch milliseconds',
  submitted_at_utc: 'Application-server submission timestamp in UTC',
  submitted_at_epoch: 'Application-server submission timestamp in epoch milliseconds, not a commit sequence',
  snapshot_source: 'Original snapshot collection source', app_version: 'Application version at prediction',
  model_version: 'Model version at prediction', schema_version: 'Overall prediction result schema version',
  dataset_schema_version: 'Online event dataset contract version of this row',
  asset_revision: 'Application static-asset revision at prediction',
  predicted_score: 'Final viewing-quality score, not a calibrated occurrence probability',
  predicted_level: 'Original final prediction level label', baseline_score: 'Baseline comparator score',
  baseline_level: 'Original baseline comparator level label', regime_label: 'Weather-regime label',
  regime_strength: 'Weather-regime intensity', sky_evolution_state: 'All-day sky evolution state',
  sky_evolution_factor: 'All-day sky score multiplier', gw_factor: 'Golden-window score multiplier; missing remains null',
  comp_sky_canvas: 'Sky canvas component score', comp_horizon: 'Horizon clarity component score',
  comp_illumination: 'Cloud illumination component score', comp_atmosphere: 'Atmospheric quality component score',
  comp_weather: 'Weather stability component score',
  cloud_cover_total: 'Local total cloud cover', cloud_cover_low: 'Local low-level cloud cover',
  cloud_cover_mid: 'Local middle-level cloud cover', cloud_cover_high: 'Local high-level cloud cover',
  corridor_cloud_mid: 'Sunset corridor mean middle-level cloud cover', corridor_cloud_high: 'Sunset corridor mean high-level cloud cover',
  anti_sunset_score: 'Opposite-sunset reflection diagnostic score', cloud_continuity: 'Sunset corridor cloud continuity score',
  aod: 'Aerosol optical depth', pm25: 'Fine particulate concentration', humidity: 'Relative humidity at sunset',
  surface_pressure: 'Surface air pressure', visibility_km: 'Horizontal visibility', precipitation: 'Precipitation amount',
  tile_radar_available: 'Radar analysis availability, not whether used in score fusion',
  tile_sat_available: 'Satellite analysis availability, not whether used in score fusion',
  submission_id: 'Observation interaction deduplication identity', snapshot_id: 'Related prediction snapshot identifier',
  rating: 'Original five-level observed rating, not aggregated ground truth', rating_label: 'Authoritative observed-rating display label',
  source: 'Original observation source', confidence: 'Original submitted observation confidence', evidence_count: 'Number of submitted evidence items',
  snapshot_count: 'Number of selected snapshots in this event', observation_count: 'Number of selected observations in this event',
  replay_count: 'Number of selected replay files in this event',
  first_prediction_time_utc: 'Earliest selected prediction instant for this event', last_prediction_time_utc: 'Latest selected prediction instant for this event',
  min_lead_time_minutes: 'Minimum selected lead time for this event', max_lead_time_minutes: 'Maximum selected lead time for this event',
  has_snapshot: 'Event has at least one selected snapshot', has_observation: 'Event has at least one selected observation',
  has_replay: 'Event has at least one selected replay', replay_schema_version: 'Replay input contract version',
  engine_build_sha: 'Full Git SHA of the engine recorded by replay capture', config_hash: 'SHA256 of canonical effective_config',
  replay_sha256: 'SHA256 of uncompressed canonical replay bytes',
  replay_saved_at_utc: 'Extracted D1 replay readiness time; may change after recovery', local_path: 'Portable relative path to the local replay JSON',
  lead_time_minutes: 'UTC sunset minus prediction time, in minutes; negative after sunset',
  replay_size_bytes: 'Canonical local JSON UTF-8 bytes, NOT compressed object size',
  replay_compressed_size_bytes: 'D1 replay_size_bytes, compressed R2 object size',
  scheduled_slot: 'Four-character business HHMM, preserving leading zeros',
  is_real_sounding: 'Legacy name: pressure-level NWP winds, not balloon observations',
  spatial_variance: 'Cloud-cover standard deviation in percentage points',
  sunset_time_local: 'Original display string; not an ordering key',
  comment: 'Optional original observation text, excluded by default'
};
export function datasetSchema(includeComments = false) {
  const lists = {
    prediction_snapshots: SNAPSHOT_OFFLINE_FIELDS,
    sunset_observations: [...OBSERVATION_OFFLINE_FIELDS, ...(includeComments ? ['comment'] : [])],
    events: EVENT_OFFLINE_FIELDS,
    replay_index: REPLAY_INDEX_FIELDS
  };
  return {
    offline_dataset_schema_version: 1,
    csv: { encoding: 'UTF-8 BOM', record_separator: 'CRLF', final_record_separator: true,
      null: 'unquoted empty', empty_string: 'quoted empty', boolean: '0/1' },
    tables: Object.fromEntries(Object.entries(lists).map(([table, names]) => [table, names.map(name => {
      const type = strings.has(name) ? 'string' : booleans.has(name) ? 'boolean' : integers.has(name) ? 'integer' : 'number';
      const nullable = table === 'prediction_snapshots' ? !snapshotRequired.has(name)
        : table === 'sunset_observations' ? observationNullable.has(name)
          : table === 'events' ? ['admin1', 'country'].includes(name) : false;
      return { name, type, nullable, unit: unit(name, type), range: bounds(name),
        enum: enumValues[name] || null,
        description: descriptions[name] || (/^layer_wind_/.test(name)
          ? `${name.split('_')[2]} hPa NWP wind ${name.endsWith('_speed') ? 'speed' : 'direction clockwise from north'}`
          : /^open_prob_/.test(name) ? `Golden-window corridor opening probability at +${name.split('_').at(-1)}`
            : /^arrival_risk_/.test(name) ? `Upstream cloud arrival risk at +${name.split('_').at(-1)}`
              : /^dyn_weight_/.test(name) ? `Dynamic score weight for ${name.slice(11)}` : `${table}.${name}`) };
    })]))
  };
}

export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function canonicalUtc(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function assertValue(field, value) {
  const invalid = () => { throw Object.assign(new Error('FIELD_INVALID'), { code: 'FIELD_INVALID', field: field.name }); };
  if (value === null) { if (!field.nullable) invalid(); return; }
  if (field.type === 'string') {
    if (typeof value !== 'string') invalid();
    if (!field.nullable && !value.length) invalid();
    if (field.enum && !field.enum.includes(value)) invalid();
    if (field.name.endsWith('_utc') && !canonicalUtc(value)) invalid();
    if (field.name === 'event_date_local' && !validDate(value)) invalid();
    if (field.name === 'scheduled_slot' && !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(value)) invalid();
    if (field.name === 'timezone') { try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { invalid(); } }
    if (field.name === 'engine_build_sha' && !/^[a-f0-9]{40}$/.test(value)) invalid();
    if (['config_hash', 'replay_sha256'].includes(field.name) && !/^[a-f0-9]{64}$/.test(value)) invalid();
  } else if (field.type === 'boolean') {
    if (typeof value !== 'boolean') invalid();
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value))) invalid();
    if (field.range && (value < field.range[0] || value > field.range[1])) invalid();
  }
}
export function projectRow(row, fields) {
  return Object.fromEntries(fields.map(field => {
    if (!Object.hasOwn(row, field.name)) throw new Error('FIELD_MISSING');
    let value = row[field.name];
    if (field.type === 'boolean' && [0, 1].includes(value)) value = !!value;
    assertValue(field, value);
    return [field.name, value];
  }));
}
