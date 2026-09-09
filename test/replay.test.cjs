const test = require('node:test');
const assert = require('node:assert/strict');
const { database, request } = require('./d1-helper.cjs');

function bucket(failFirst = false) {
  const objects = new Map();
  let puts = 0;
  return {
    objects,
    get puts() { return puts; },
    async head(key) { return objects.get(key) || null; },
    async put(key, bytes, options) {
      puts += 1;
      if (failFirst && puts === 1) throw new Error('fixture outage');
      if (objects.has(key) && options.onlyIf && options.onlyIf.etagDoesNotMatch === '*') return null;
      const object = { key, etag: 'etag-' + puts, size: bytes.byteLength, customMetadata: options.customMetadata };
      objects.set(key, object);
      return object;
    }
  };
}

async function envelope(overrides = {}) {
  const schema = await import('../server/replay-schema.js');
  const dataset = await import('../server/event-dataset.js');
  const effectiveConfig = { levels: [{ min: 0, label: '一般' }], algorithm: { cloud: true } };
  const configHash = await dataset.sha256(schema.canonicalJson(effectiveConfig));
  const units = {
    cloud_cover: 'percent', cloud_cover_low: 'percent', cloud_cover_mid: 'percent', cloud_cover_high: 'percent',
    visibility: 'meter', relative_humidity_2m: 'percent', precipitation: 'millimeter',
    precipitation_probability: 'percent', wind_speed_10m: 'km/h', wind_direction_10m: 'degree_from_north',
    wind_gusts_10m: 'km/h', surface_pressure: 'hPa', wind_speed_850hPa: 'km/h',
    wind_direction_850hPa: 'degree_from_north', wind_speed_700hPa: 'km/h',
    wind_direction_700hPa: 'degree_from_north', wind_speed_500hPa: 'km/h', wind_direction_500hPa: 'degree_from_north'
  };
  const variables = Object.fromEntries(Object.keys(units).map((name) => [name, name === 'cloud_cover' ? [40, null] : [null, null]]));
  return {
    snapshot: {
      event_context: {
        event_date_local: '2026-09-09', city: '深圳', admin1: '广东', country: '中国',
        latitude: 22.5431, longitude: 114.0579, location_source: 'qweather', location_id: '101280601',
        timezone: 'Asia/Shanghai', sunset_time_utc: '2026-09-09T10:30:00.000Z', sunset_time_local: '2026-09-09 18:30'
      },
      snapshot_source: 'github_schedule', scheduled_slot: '1213', query_id: 'qid-replay',
      prediction_time_utc: '2026-09-09T04:13:00.000Z', app_version: '2.4.6', model_version: '2.4.6',
      schema_version: 3, dataset_schema_version: 3, asset_revision: 'replay1', predicted_score: 68,
      predicted_level: '很好', raw_snapshot_json: JSON.stringify({ query: 'qid-replay' })
    },
    replay: {
      replay_schema_version: 1,
      identity: { prediction_time_utc: '2026-09-09T04:13:00.000Z', model_version: '2.4.6',
        engine_code_version: '2.4.6', engine_build_sha: 'replay1', config_hash: configHash },
      context: { city: '深圳', admin1: '广东', country: '中国', latitude: 22.5431, longitude: 114.0579,
        timezone: 'Asia/Shanghai', utc_offset_seconds: 28800, sunset_time_utc: '2026-09-09T10:30:00.000Z',
        civil_dusk_utc: '2026-09-09T10:55:00.000Z', golden_hour_start_utc: '2026-09-09T09:55:00.000Z',
        golden_hour_end_utc: '2026-09-09T10:30:00.000Z', sunset_azimuth_deg: 278,
        twilight_minutes: 25, app_version: '2.4.6', model_version: '2.4.6', asset_revision: 'replay1',
        dataset_schema_version: 3 },
      effective_config: effectiveConfig,
      nwp: { time_axis: 'utc_iso8601', units, nodes: [{
        key: 'CENTER_0', latitude: 22.5431, longitude: 114.0579,
        time_utc: ['2026-09-09T04:00:00.000Z', '2026-09-09T05:00:00.000Z'],
        variables
      }] },
      air_quality: { available: false }, minute_precip: { available: false },
      radar: { available: false }, satellite: { available: false },
      cloud_motion: { input_mode: 'nwp_samples', base_time_utc: '2026-09-09T04:13:00.000Z',
        forecast_horizons_minutes: [30, 60, 120], wind_source_flags: {}, source_quality_flags: {} },
      engine_inputs: { sampling_mode: 'LOCAL_ONLY', cache_status: 'MISS', data_age_minutes: 0,
        expected_sample_count: 1, total_sky_node_count: 1, spatial_completeness: 1,
        spatial_fallback_reason: 'fixture', actual_sky_node_keys: ['CENTER_0'],
        actual_corridor_nodes: [{ latitude: 22.5431, longitude: 114.0579, distance_km: 0,
          azimuth_offset: 0, role: 'local', weight: 1, source_node_keys: ['CENTER_0'], interpolation_policy_version: 0 }],
        source_degradation_flags: {} },
      ...overrides
    }
  };
}

function replayRequest(payload, secret = 'fixture-secret') {
  return request(payload, '/api/replay-snapshot', { authorization: 'Bearer ' + secret });
}

test('Replay endpoint authenticates before ingest and fails closed when bindings are missing', async () => {
  const api = await import('../functions/api/replay-snapshot.js');
  const payload = await envelope();
  assert.equal((await api.onRequestPost({ request: replayRequest(payload, 'wrong'), env: {
    REPLAY_INGEST_SECRET: 'fixture-secret'
  } })).status, 401);
  assert.equal((await api.onRequestPost({ request: replayRequest(payload), env: {
    REPLAY_INGEST_SECRET: 'fixture-secret'
  } })).status, 503);
  const { DB, sqlite } = database();
  try {
    const oversized = new Request('https://example.test/api/replay-snapshot', { method: 'POST',
      headers: { authorization: 'Bearer fixture-secret', 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
      body: '{}' });
    const response = await api.onRequestPost({ request: oversized, env: {
      DB, REPLAY_BUCKET: bucket(), REPLAY_INGEST_SECRET: 'fixture-secret'
    } });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).errorCode, 'REPLAY_TOO_LARGE');
  } finally { sqlite.close(); }
});

test('Replay endpoint writes PENDING -> READY, stores gzip in R2 and deduplicates exact retry', async () => {
  const api = await import('../functions/api/replay-snapshot.js');
  const { DB, sqlite } = database();
  const R2 = bucket();
  const env = { DB, REPLAY_BUCKET: R2, REPLAY_INGEST_SECRET: 'fixture-secret' };
  try {
    const payload = await envelope();
    const first = await api.onRequestPost({ request: replayRequest(payload), env });
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await first.json();
    assert.equal(firstBody.replayStatus, 'READY');
    assert.equal(firstBody.replaySaved, true);
    assert.equal(R2.objects.size, 1);
    const row = sqlite.prepare('SELECT * FROM prediction_snapshots').get();
    assert.equal(row.replay_status, 'READY');
    assert.equal(row.replay_schema_version, 1);
    assert.match(row.replay_object_key, /^replay\/v1\/2026\/09\/09\//);
    assert.match(row.replay_sha256, /^[a-f0-9]{64}$/);
    assert.equal(row.dataset_schema_version, 3);

    const retry = await api.onRequestPost({ request: replayRequest(payload), env });
    const retryBody = await retry.json();
    assert.equal(retryBody.deduplicated, true);
    assert.equal(retryBody.id, firstBody.id);
    assert.equal(R2.puts, 1);

    const conflictPayload = structuredClone(payload);
    conflictPayload.replay.nwp.nodes[0].variables.cloud_cover[0] = 41;
    const conflict = await api.onRequestPost({ request: replayRequest(conflictPayload), env });
    assert.equal(conflict.status, 409);
  } finally { sqlite.close(); }
});

test('Replay endpoint preserves Snapshot and retries FAILED R2 writes to READY', async () => {
  const api = await import('../functions/api/replay-snapshot.js');
  const { DB, sqlite } = database();
  const R2 = bucket(true);
  const env = { DB, REPLAY_BUCKET: R2, REPLAY_INGEST_SECRET: 'fixture-secret' };
  try {
    const payload = await envelope();
    const failed = await api.onRequestPost({ request: replayRequest(payload), env });
    const failedBody = await failed.json();
    assert.equal(failedBody.snapshotSaved, true);
    assert.equal(failedBody.replayStatus, 'FAILED');
    assert.equal(sqlite.prepare('SELECT replay_status FROM prediction_snapshots').get().replay_status, 'FAILED');
    const recovered = await api.onRequestPost({ request: replayRequest(payload), env });
    assert.equal((await recovered.json()).replayStatus, 'READY');
    const row = sqlite.prepare('SELECT replay_status, replay_attempt_count FROM prediction_snapshots').get();
    assert.equal(row.replay_status, 'READY');
    assert.equal(row.replay_attempt_count, 2);
  } finally { sqlite.close(); }
});

test('R2 success with READY update failure stays PENDING and stale retry recovers by HEAD', async () => {
  const api = await import('../functions/api/replay-snapshot.js');
  const { DB, sqlite } = database();
  const R2 = bucket();
  const env = { DB, REPLAY_BUCKET: R2, REPLAY_INGEST_SECRET: 'fixture-secret' };
  try {
    sqlite.exec("CREATE TRIGGER fail_ready BEFORE UPDATE OF replay_status ON prediction_snapshots WHEN NEW.replay_status = 'READY' BEGIN SELECT RAISE(ABORT, 'fixture ready failure'); END");
    const payload = await envelope();
    const first = await api.onRequestPost({ request: replayRequest(payload), env });
    const firstBody = await first.json();
    assert.equal(firstBody.replayStatus, 'PENDING');
    assert.equal(firstBody.errorCode, 'READY_UPDATE_FAILED');
    assert.equal(R2.objects.size, 1);
    sqlite.exec('DROP TRIGGER fail_ready');
    sqlite.prepare("UPDATE prediction_snapshots SET replay_updated_at_utc = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(firstBody.id);
    const recovered = await api.onRequestPost({ request: replayRequest(payload), env });
    assert.equal((await recovered.json()).replayStatus, 'READY');
    assert.equal(R2.puts, 1, 'recovery must use HEAD instead of overwriting the object');
  } finally { sqlite.close(); }
});

test('invalid Replay is recorded as FAILED without entering R2', async () => {
  const api = await import('../functions/api/replay-snapshot.js');
  const { DB, sqlite } = database();
  const R2 = bucket();
  try {
    const payload = await envelope();
    payload.replay.identity.config_hash = '0'.repeat(64);
    const response = await api.onRequestPost({ request: replayRequest(payload), env: {
      DB, REPLAY_BUCKET: R2, REPLAY_INGEST_SECRET: 'fixture-secret'
    } });
    const body = await response.json();
    assert.equal(body.snapshotSaved, true);
    assert.equal(body.replayStatus, 'FAILED');
    assert.equal(R2.puts, 0);
    assert.equal(sqlite.prepare('SELECT replay_error_code FROM prediction_snapshots').get().replay_error_code, 'INVALID_REPLAY');
  } finally { sqlite.close(); }
});
