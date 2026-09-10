import { createHash } from 'node:crypto';
import { canonicalJson, utf8ByteLength, validateReplayPayload } from '../../server/replay-schema.js';

const NWP_UNITS = Object.freeze({
  cloud_cover: 'percent', cloud_cover_low: 'percent', cloud_cover_mid: 'percent', cloud_cover_high: 'percent',
  visibility: 'meter', relative_humidity_2m: 'percent', precipitation: 'millimeter',
  precipitation_probability: 'percent', wind_speed_10m: 'km/h', wind_direction_10m: 'degree_from_north',
  wind_gusts_10m: 'km/h', surface_pressure: 'hPa', wind_speed_850hPa: 'km/h',
  wind_direction_850hPa: 'degree_from_north', wind_speed_700hPa: 'km/h',
  wind_direction_700hPa: 'degree_from_north', wind_speed_500hPa: 'km/h',
  wind_direction_500hPa: 'degree_from_north'
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicPadding(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x24704701;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = alphabet.charCodeAt((state >>> 0) & 63);
  }
  return bytes.toString('ascii');
}

export async function createSizedReplay(targetBytes, options = {}) {
  if (!Number.isInteger(targetBytes) || targetBytes < 4096) throw new Error('INVALID_TARGET_SIZE');
  const effectiveConfig = {
    goldenWindow: { enabled: true, beforeSunsetMinutes: 180, afterSunsetMinutes: 30, floor: 0.5 },
    scoring: { levels: [
      { min: 90, label: '极佳' }, { min: 60, label: '很好' }, { min: 40, label: '一般' },
      { min: 20, label: '较差' }, { min: 0, label: '很差' }
    ] }
  };
  const times = ['2026-09-09T04:00:00.000Z', '2026-09-09T05:00:00.000Z'];
  const variables = Object.fromEntries(Object.keys(NWP_UNITS).map((name) => {
    if (name === 'cloud_cover') return [name, [45, 50]];
    if (name === 'cloud_cover_low') return [name, [20, 22]];
    if (name === 'cloud_cover_mid') return [name, [40, 44]];
    if (name === 'cloud_cover_high') return [name, [65, 68]];
    if (name === 'visibility') return [name, [24000, 24000]];
    return [name, [null, null]];
  }));
  const replay = {
    replay_schema_version: 1,
    identity: {
      prediction_time_utc: '2026-09-09T04:13:00.000Z', model_version: '2.4.6',
      engine_code_version: '2.4.6', engine_build_sha: options.engineBuildSha || 'a'.repeat(40),
      config_hash: digest(canonicalJson(effectiveConfig)),
      snapshot_id: options.snapshotId || 'snap_replay_fixture', event_id: options.eventId || 'evt_v1_fixture_2026-09-09'
    },
    context: {
      city: '深圳', admin1: '广东', country: '中国', latitude: 22.5431, longitude: 114.0579,
      timezone: 'Asia/Shanghai', utc_offset_seconds: 28800, sunset_time_utc: '2026-09-09T10:30:00.000Z',
      civil_dusk_utc: '2026-09-09T10:55:00.000Z', golden_hour_start_utc: '2026-09-09T09:55:00.000Z',
      golden_hour_end_utc: '2026-09-09T10:30:00.000Z', sunset_azimuth_deg: 278, twilight_minutes: 25,
      dataset_schema_version: 3, app_version: '2.4.6', model_version: '2.4.6', asset_revision: 'replay1'
    },
    effective_config: effectiveConfig,
    nwp: { time_axis: 'utc_iso8601', units: NWP_UNITS, nodes: [{
      key: 'CENTER_0', direction: 'CENTER', azimuth: 0, distance_km: 0, azimuth_offset: 0,
      latitude: 22.5431, longitude: 114.0579, weight: 1, timezone: 'Asia/Shanghai',
      utc_offset_seconds: 28800, time_utc: times, variables
    }] },
    air_quality: { available: false },
    minute_precip: { available: false },
    radar: { available: false, source: null, source_status: 'NOT_REQUESTED', layer: null, coverage_series: [] },
    satellite: { available: false, source: null, source_status: 'NOT_REQUESTED', layer: null, coverage_series: [] },
    cloud_motion: {
      input_mode: 'nwp_samples', base_time_utc: '2026-09-09T04:13:00.000Z',
      forecast_horizons_minutes: [30, 60, 120], wind_source_flags: {}, source_quality_flags: {}
    },
    engine_inputs: {
      sampling_mode: 'LOCAL_ONLY', cache_status: 'MISS', data_age_minutes: 0,
      expected_sample_count: 1, total_sky_node_count: 1, spatial_completeness: 1,
      spatial_fallback_reason: 'fixture', actual_sky_node_keys: ['CENTER_0'],
      actual_corridor_nodes: [{ latitude: 22.5431, longitude: 114.0579, distance_km: 0,
        azimuth_offset: 0, role: 'local', weight: 1, source_node_keys: ['CENTER_0'], interpolation_policy_version: 0 }],
      source_degradation_flags: { padding: '' }
    }
  };
  const baseBytes = utf8ByteLength(canonicalJson(replay));
  if (baseBytes > targetBytes) throw new Error('TARGET_SIZE_TOO_SMALL');
  replay.engine_inputs.source_degradation_flags.padding = deterministicPadding(targetBytes - baseBytes);
  if (utf8ByteLength(canonicalJson(replay)) !== targetBytes) throw new Error('TARGET_SIZE_MISMATCH');
  return validateReplayPayload(replay);
}

export function snapshotRowForReplay(replay, actual = {}) {
  return {
    id: replay.identity.snapshot_id,
    event_id: replay.identity.event_id,
    event_date_local: '2026-09-09',
    city: replay.context.city,
    admin1: replay.context.admin1,
    country: replay.context.country,
    latitude: replay.context.latitude,
    longitude: replay.context.longitude,
    timezone: replay.context.timezone,
    sunset_time_utc: replay.context.sunset_time_utc,
    prediction_time_utc: replay.identity.prediction_time_utc,
    snapshot_source: 'github_manual',
    scheduled_slot: '1213',
    app_version: replay.context.app_version,
    model_version: replay.context.model_version,
    schema_version: 3,
    dataset_schema_version: replay.context.dataset_schema_version,
    asset_revision: replay.context.asset_revision,
    replay_status: 'READY',
    replay_schema_version: replay.replay_schema_version,
    replay_object_key: 'replay/v1/2026/09/09/' + replay.identity.event_id + '/' + replay.identity.snapshot_id + '.json.gz',
    replay_size_bytes: null,
    replay_sha256: null,
    replay_object_etag: 'fixture-etag',
    replay_compression: 'gzip',
    predicted_score: actual.score,
    predicted_level: actual.level,
    baseline_score: actual.baseline_score,
    baseline_level: actual.baseline_level,
    regime_label: actual.regime_label,
    regime_strength: actual.regime_strength,
    sky_evolution_state: actual.sky_evolution_state,
    sky_evolution_factor: actual.sky_evolution_factor,
    gw_factor: actual.gw_factor,
    comp_sky_canvas: actual.components && actual.components.sky_canvas,
    comp_horizon: actual.components && actual.components.horizon,
    comp_illumination: actual.components && actual.components.illumination,
    comp_atmosphere: actual.components && actual.components.atmosphere,
    comp_weather: actual.components && actual.components.weather,
    tile_radar_available: 0,
    tile_sat_available: 0,
    open_prob_30m: null,
    open_prob_60m: null,
    open_prob_120m: null
  };
}
