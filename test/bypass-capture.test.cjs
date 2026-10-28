const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
const { database, request } = require('./d1-helper.cjs');

const SERVICE_FILES = [
  'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
  'js/vendor/suncalc.js', 'js/solar.js', 'js/baseline.js', 'js/cache.js',
  'js/data.js', 'js/city_search.js', 'js/cloud_field.js', 'js/wind.js', 'js/cloud_motion.js',
  'js/sky_state.js', 'js/engine.js', 'js/sampling.js', 'js/corridor.js',
  'js/nowcast.js', 'js/evolution.js', 'js/replay_service.js', 'js/prediction_service.js', 'js/feedback_service.js'
];
const LOCATION = { latitude: 22.5431, longitude: 114.0579 };
const SOLAR = { sunset: new Date('2026-09-09T10:30:00.000Z'), sunsetAzimuthDeg: 278 };
const NOW = Date.parse('2026-09-09T04:13:00.000Z');

// One Open-Meteo location: local times in UTC+8, every requested variable present with its Open-Meteo unit symbol.
function omLocation(variables, overrides = {}) {
  const time = Array.from({ length: 24 }, (_, h) => `2026-09-09T${String(h).padStart(2, '0')}:00`);
  const unit = name => name === 'dew_point_2m' ? '°C' : (name === 'boundary_layer_height' || name.startsWith('geopotential_height_')) ? 'm' : '%';
  const value = name => name === 'dew_point_2m' ? 21.5 : name === 'boundary_layer_height' ? 640 : name.startsWith('geopotential_height_') ? 5800 : 35;
  return { utc_offset_seconds: 28800, timezone: 'Asia/Shanghai', elevation: 12,
    hourly_units: Object.fromEntries([['time', 'iso8601'], ...variables.map(n => [n, overrides.units?.[n] ?? unit(n)])]),
    hourly: Object.fromEntries([['time', time], ...variables.map(n => [n, time.map(() => value(n))])]) };
}
function openMeteoFetch(calls, { status = 200, units } = {}) {
  return async url => {
    calls.push(url);
    const u = new URL(url), variables = u.searchParams.get('hourly').split(','), count = u.searchParams.get('latitude').split(',').length;
    if (status !== 200) return new Response('{}', { status });
    const body = Array.from({ length: count }, () => omLocation(variables, { units }));
    return new Response(JSON.stringify(count === 1 ? body[0] : body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
function clientRuntime(fetch) {
  return load(createRuntime({ fetch }), [...CORE_FILES, 'js/bypass_capture.js']);
}
const plain = value => JSON.parse(JSON.stringify(value));
const expected = { prediction_time_utc: new Date(NOW).toISOString(), sunset_time_utc: SOLAR.sunset.toISOString(), ...LOCATION };

test('Client request lists equal the server schema, one 33-node request and one far-point request at 400 / 550 km', async () => {
  const schema = await import('../server/bypass-schema.js'), calls = [];
  const SS = clientRuntime(openMeteoFetch(calls));
  assert.deepEqual([...SS.bypassCapture.CONFIG.gridVariables], [...schema.BYPASS_GRID_VARIABLES]);
  assert.deepEqual([...SS.bypassCapture.CONFIG.farVariables], [...schema.BYPASS_FAR_VARIABLES]);
  assert.equal(schema.BYPASS_GRID_VARIABLES.length, 20); assert.equal(schema.BYPASS_FAR_VARIABLES.length, 24);
  const bypass = plain(await SS.bypassCapture.capture({ location: LOCATION, solar: SOLAR, nowUtcMs: NOW }));
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]).searchParams.get('latitude').split(',').length, 33);
  assert.equal(new URL(calls[1]).searchParams.get('latitude').split(',').length, 2);
  assert.deepEqual(bypass.far_nodes.map(n => [n.key, n.distance_km, n.bearing_deg]), [['SUNSET_400', 400, 278], ['SUNSET_550', 550, 278]]);
  const p = SS.data.destinationPoint(LOCATION.latitude, LOCATION.longitude, 278, 550);
  assert.ok(Math.abs(bypass.far_nodes[1].latitude - p.latitude) < 1e-9 && Math.abs(bypass.far_nodes[1].longitude - p.longitude) < 1e-9);
  assert.equal(bypass.grid_nodes.length, 33); assert.equal(bypass.grid_nodes[0].elevation_m, 12);
  assert.ok(bypass.grid_nodes[0].time_utc.every(t => /Z$/.test(t)) && bypass.grid_nodes[0].time_utc.length > 0);
  assert.equal(bypass.satellite_shadow, null); assert.equal(bypass.snapshot_id, null); assert.equal(bypass.record_only, true);
  assert.deepEqual([bypass.requests.A.status, bypass.requests.B.status], ['OK', 'OK']);
  assert.deepEqual(bypass.quality.missing_reason, {}); assert.equal(bypass.source.issue_time_status, 'NOT_PROVIDED_BY_API');
  assert.doesNotThrow(() => schema.validateBypassPayload(bypass, expected));
});

test('HTTP 429 is recorded as RATE_LIMITED without any retry; units that differ are nulled as UNIT_MISMATCH', async () => {
  const schema = await import('../server/bypass-schema.js'), calls = [];
  const limited = plain(await clientRuntime(openMeteoFetch(calls, { status: 429 })).bypassCapture.capture({ location: LOCATION, solar: SOLAR, nowUtcMs: NOW }));
  assert.equal(calls.length, 2, 'one attempt per request, no retry');
  assert.deepEqual([limited.requests.A.status, limited.requests.A.reason_code, limited.requests.B.status], ['RATE_LIMITED', 'HTTP_429', 'RATE_LIMITED']);
  assert.equal(limited.quality.missing_reason.cloud_cover_850hPa, 'RATE_LIMITED'); assert.equal(limited.grid_nodes[0].time_utc.length, 0);
  assert.doesNotThrow(() => schema.validateBypassPayload(limited, expected));
  const failed = plain(await clientRuntime(openMeteoFetch([], { status: 503 })).bypassCapture.capture({ location: LOCATION, solar: SOLAR, nowUtcMs: NOW }));
  assert.deepEqual([failed.requests.A.status, failed.requests.A.reason_code, failed.quality.missing_reason.dew_point_2m], ['FAILED', 'HTTP_503', 'REQUEST_FAILED']);
  const kelvin = plain(await clientRuntime(openMeteoFetch([], { units: { dew_point_2m: 'K' } })).bypassCapture.capture({ location: LOCATION, solar: SOLAR, nowUtcMs: NOW }));
  assert.equal(kelvin.quality.missing_reason.dew_point_2m, 'UNIT_MISMATCH'); assert.ok(kelvin.grid_nodes[0].variables.dew_point_2m.every(v => v === null));
  assert.doesNotThrow(() => schema.validateBypassPayload(kelvin, expected));
});

test('Schema keeps satellite_shadow reserved, binds to the Replay and rejects unknown, mismatched or oversized objects', async () => {
  const schema = await import('../server/bypass-schema.js');
  const base = plain(await clientRuntime(openMeteoFetch([])).bypassCapture.capture({ location: LOCATION, solar: SOLAR, nowUtcMs: NOW }));
  const mutate = fn => { const copy = structuredClone(base); fn(copy); return () => schema.validateBypassPayload(copy, expected); };
  assert.throws(mutate(b => { b.satellite_shadow = { frames: [] }; }), /BYPASS_SATELLITE_SHADOW_NOT_DEFINED/);
  assert.throws(mutate(b => { delete b.satellite_shadow; }), /缺少字段：satellite_shadow/);
  assert.throws(mutate(b => { b.snapshot_id = 'snap_x'; }), /snapshot_id/);
  assert.throws(mutate(b => { b.latitude += 0.001; }), /BYPASS_BINDING_MISMATCH/);
  assert.throws(mutate(b => { b.extra = 1; }), /未知字段：extra/);
  assert.throws(mutate(b => { b.grid_nodes[0].variables.dew_point_2m.pop(); }), /变量长度与时间轴不一致/);
  assert.throws(mutate(b => { b.requests.A.variables = b.requests.A.variables.slice(1); }), /变量列表不符/);
  assert.throws(mutate(b => { b.units.dew_point_2m = 'kelvin'; }), /单位非法/);
  assert.throws(mutate(b => { b.grid_nodes[0].variables.cloud_cover_850hPa[0] = 140; }), /非法/);
  assert.throws(mutate(b => { for (const n of b.grid_nodes) { n.time_utc = Array.from({ length: 96 }, (_, i) => new Date(NOW + i * 3600000).toISOString());
    for (const k of Object.keys(n.variables)) n.variables[k] = n.time_utc.map(() => 12.345678901234567); } }), /BYPASS_TOO_LARGE/);
  assert.equal(schema.bypassObjectKey('replay/v1/2026/09/09/evt/snap_replay_x.json.gz'), 'replay/v1/2026/09/09/evt/snap_replay_x.bypass.json.gz');
  assert.throws(() => schema.bypassObjectKey('replay/x.json'), /BYPASS_KEY_INVALID/);
});

function bucket({ failBypassPut = false } = {}) {
  const objects = new Map();
  return { objects,
    async head(key) { return objects.get(key) || null; },
    async put(key, bytes, options) {
      if (failBypassPut && key.endsWith('.bypass.json.gz')) throw new Error('fixture outage');
      if (objects.has(key) && options.onlyIf && options.onlyIf.etagDoesNotMatch === '*') return null;
      const object = { key, etag: 'etag-' + objects.size, size: bytes.byteLength, customMetadata: options.customMetadata };
      objects.set(key, object); return object;
    } };
}
async function envelope(bypass) {
  const schema = await import('../server/replay-schema.js'), dataset = await import('../server/event-dataset.js');
  const effectiveConfig = { levels: [{ min: 0, label: '一般' }] }, configHash = await dataset.sha256(schema.canonicalJson(effectiveConfig));
  const units = { cloud_cover: 'percent', cloud_cover_low: 'percent', cloud_cover_mid: 'percent', cloud_cover_high: 'percent', visibility: 'meter',
    relative_humidity_2m: 'percent', precipitation: 'millimeter', precipitation_probability: 'percent', wind_speed_10m: 'km/h',
    wind_direction_10m: 'degree_from_north', wind_gusts_10m: 'km/h', surface_pressure: 'hPa', wind_speed_850hPa: 'km/h',
    wind_direction_850hPa: 'degree_from_north', wind_speed_700hPa: 'km/h', wind_direction_700hPa: 'degree_from_north',
    wind_speed_500hPa: 'km/h', wind_direction_500hPa: 'degree_from_north' };
  const out = {
    snapshot: { event_context: { event_date_local: '2026-09-09', city: '深圳', admin1: '广东', country: '中国', ...LOCATION,
      location_source: 'qweather', location_id: '101280601', timezone: 'Asia/Shanghai', sunset_time_utc: expected.sunset_time_utc, sunset_time_local: '2026-09-09 18:30' },
      snapshot_source: 'github_schedule', scheduled_slot: '1213', query_id: 'qid-bypass', prediction_time_utc: expected.prediction_time_utc,
      app_version: '2.5.5.7', model_version: '2.5.5.4', schema_version: 3, dataset_schema_version: 3, asset_revision: 'app2557',
      predicted_score: 50, predicted_level: '一般', raw_snapshot_json: JSON.stringify({ query: 'qid-bypass' }) },
    replay: { replay_schema_version: 1,
      identity: { prediction_time_utc: expected.prediction_time_utc, model_version: '2.5.5.4', engine_code_version: '2.5.5.4', engine_build_sha: 'b'.repeat(40), config_hash: configHash },
      context: { city: '深圳', admin1: '广东', country: '中国', ...LOCATION, timezone: 'Asia/Shanghai', utc_offset_seconds: 28800,
        sunset_time_utc: expected.sunset_time_utc, civil_dusk_utc: '2026-09-09T10:55:00.000Z', golden_hour_start_utc: '2026-09-09T09:55:00.000Z',
        golden_hour_end_utc: '2026-09-09T10:30:00.000Z', sunset_azimuth_deg: 278, twilight_minutes: 25, app_version: '2.5.5.7',
        model_version: '2.5.5.4', asset_revision: 'app2557', dataset_schema_version: 3 },
      effective_config: effectiveConfig,
      nwp: { time_axis: 'utc_iso8601', units, nodes: [{ key: 'CENTER_0', ...LOCATION, time_utc: ['2026-09-09T04:00:00.000Z'],
        variables: Object.fromEntries(Object.keys(units).map(n => [n, [null]])) }] },
      air_quality: { available: false }, minute_precip: { available: false }, radar: { available: false }, satellite: { available: false },
      cloud_motion: { input_mode: 'nwp_samples', base_time_utc: expected.prediction_time_utc, forecast_horizons_minutes: [30, 60, 120], wind_source_flags: {}, source_quality_flags: {} },
      engine_inputs: { sampling_mode: 'LOCAL_ONLY', cache_status: 'MISS', data_age_minutes: 0, expected_sample_count: 1, total_sky_node_count: 1,
        spatial_completeness: 1, spatial_fallback_reason: 'fixture', actual_sky_node_keys: ['CENTER_0'],
        actual_corridor_nodes: [{ ...LOCATION, distance_km: 0, azimuth_offset: 0, role: 'local', weight: 1, source_node_keys: ['CENTER_0'], interpolation_policy_version: 0 }],
        source_degradation_flags: {} } } };
  if (bypass !== undefined) out.bypass = bypass;
  return out;
}
const post = async (api, payload, env) => (await api.onRequestPost({ request: request(payload, '/api/replay-snapshot', { authorization: 'Bearer fixture-secret' }), env })).json();

test('Endpoint stores the bypass object next to a READY Replay; its failures never change the Replay outcome', async () => {
  const api = await import('../functions/api/replay-snapshot.js');
  const bypass = plain(await clientRuntime(openMeteoFetch([])).bypassCapture.capture({ location: LOCATION, solar: SOLAR, nowUtcMs: NOW }));
  const run = async (payload, R2) => { const { DB, sqlite } = database();
    try { const env = { DB, REPLAY_BUCKET: R2, REPLAY_INGEST_SECRET: 'fixture-secret' };
      const first = await post(api, payload, env), retry = await post(api, payload, env);
      return { first, retry, row: sqlite.prepare('SELECT replay_status, replay_object_key FROM prediction_snapshots').get() };
    } finally { sqlite.close(); } };
  const R2 = bucket(), ok = await run(await envelope(structuredClone(bypass)), R2);
  assert.deepEqual([ok.first.replayStatus, ok.first.bypassStatus, ok.retry.deduplicated, ok.retry.bypassStatus], ['READY', 'SAVED', true, 'EXISTS']);
  assert.equal(R2.objects.size, 2);
  const stored = R2.objects.get(ok.row.replay_object_key.replace(/\.json\.gz$/, '.bypass.json.gz'));
  assert.equal(stored.customMetadata.snapshot_id, ok.first.id); assert.equal(stored.customMetadata.bypass_schema_version, '1');
  const noBypass = await run(await envelope(), bucket());
  assert.deepEqual([noBypass.first.replayStatus, noBypass.first.bypassStatus], ['READY', 'ABSENT']);
  const reserved = structuredClone(bypass); reserved.satellite_shadow = { frames: [] };
  const R2b = bucket(), invalid = await run(await envelope(reserved), R2b);
  assert.deepEqual([invalid.first.replayStatus, invalid.first.bypassStatus, R2b.objects.size], ['READY', 'BYPASS_SATELLITE_SHADOW_NOT_DEFINED', 1]);
  const outage = await run(await envelope(structuredClone(bypass)), bucket({ failBypassPut: true }));
  assert.deepEqual([outage.first.replayStatus, outage.first.bypassStatus, outage.row.replay_status], ['READY', 'R2_PUT_FAILED', 'READY']);
});

test('Ordinary predictions send no bypass request; capture runs attach it, and scores are identical either way', async () => {
  const calls = [], runtime = createRuntime({ fetch: openMeteoFetch(calls) });
  const SS = load(runtime, [...SERVICE_FILES, 'js/event_service.js', 'js/snapshot_service.js', 'js/bypass_capture.js']);
  const fc = forecast({ cloud: 48, low: 18, mid: 44, high: 62 }); fc.timezone = 'Asia/Shanghai'; fc.utc_offset_seconds = 28800;
  SS.data.fetchForecastWithRetry = async () => fc; SS.data.fetchAirQuality = async () => null;
  SS.data.gather = async (nodes) => ({ samples: nodes.map((point) => ({ point, forecast: fc })), successCount: nodes.length });
  const nowUtcMs = Date.parse('2026-08-26T02:00:00Z');
  const ordinary = await SS.prediction.predict('31.23,121.47', { nowUtcMs });
  const bypassCalls = () => calls.filter(u => u.includes('geopotential_height')).length;
  assert.equal(bypassCalls(), 0); assert.equal(ordinary.bypass_payload, undefined);
  const captured = await SS.prediction.predict('31.23,121.47', { nowUtcMs, captureReplay: true });
  assert.equal(bypassCalls(), 2); assert.equal(captured.bypass_payload.satellite_shadow, null);
  assert.equal(captured.score, ordinary.score);
  const env1 = await SS.snapshotService.buildReplayEnvelope(captured, { source: 'github_manual', scheduledSlot: '1613' });
  assert.deepEqual(Object.keys(env1), ['snapshot', 'replay', 'bypass']); assert.equal(env1.bypass, captured.bypass_payload);
  const env0 = await SS.snapshotService.buildReplayEnvelope({ ...captured, bypass_payload: null }, { source: 'github_manual', scheduledSlot: '1613' });
  assert.deepEqual(Object.keys(env0), ['snapshot', 'replay']);
  // A failing bypass leaves the score and the Replay payload untouched.
  const failingRuntime = createRuntime({ fetch: openMeteoFetch([], { status: 429 }) });
  const SF = load(failingRuntime, [...SERVICE_FILES, 'js/bypass_capture.js']);
  SF.data.fetchForecastWithRetry = async () => fc; SF.data.fetchAirQuality = async () => null; SF.data.gather = SS.data.gather;
  const limited = await SF.prediction.predict('31.23,121.47', { nowUtcMs, captureReplay: true });
  assert.equal(limited.score, captured.score); assert.equal(limited.bypass_payload.requests.A.status, 'RATE_LIMITED');
  assert.equal(JSON.stringify(limited.replay_payload.nwp), JSON.stringify(captured.replay_payload.nwp));
  assert.equal(limited.replay_payload.identity.config_hash, captured.replay_payload.identity.config_hash);
});
