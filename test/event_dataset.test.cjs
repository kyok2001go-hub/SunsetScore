const test = require('node:test');
const assert = require('node:assert/strict');
const { database, request } = require('./d1-helper.cjs');

function eventContext(overrides = {}) {
  const sunset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const eventDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(sunset));
  return {
    event_date_local: eventDate,
    city: '深圳', admin1: '广东', country: '中国',
    latitude: 22.5431, longitude: 114.0579,
    location_source: 'qweather', location_id: 'qweather:101280601',
    timezone: 'Asia/Shanghai', sunset_time_utc: sunset,
    sunset_time_local: '2026-09-03 18:39',
    ...overrides
  };
}

function snapshot(context = eventContext(), overrides = {}) {
  return {
    event_context: context,
    snapshot_source: 'github_schedule', scheduled_slot: '1213',
    query_id: 'qid-test', prediction_time_utc: new Date().toISOString(),
    app_version: '2.4.2', model_version: '2.4.2', schema_version: 3,
    dataset_schema_version: 1, predicted_score: 68, predicted_level: '很好',
    raw_snapshot_json: JSON.stringify({ query: 'qid-test' }),
    ...overrides
  };
}

test('snapshot API recomputes stable event identity and deduplicates scheduled retries', async () => {
  const api = await import('../functions/api/snapshot.js');
  const { DB, sqlite } = database();
  try {
    const payload = snapshot();
    const first = await api.onRequestPost({ request: request(payload, '/api/snapshot'), env: { DB } });
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await first.json();
    assert.equal(firstBody.deduplicated, false);
    const second = await api.onRequestPost({ request: request(payload, '/api/snapshot'), env: { DB } });
    const secondBody = await second.json();
    assert.equal(secondBody.deduplicated, true);
    assert.equal(secondBody.id, firstBody.id);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count, 1);
    const row = sqlite.prepare('SELECT * FROM prediction_snapshots').get();
    assert.match(row.event_id, /^evt_v1_[a-f0-9]{20}_\d{4}-\d{2}-\d{2}$/);
    assert.equal(row.location_key, 'qweather:101280601');
    assert.equal(row.snapshot_source, 'github_schedule');
    assert.equal(row.scheduled_slot, '1213');
    assert.notEqual(row.submitted_at_utc, payload.prediction_time_utc);
  } finally { sqlite.close(); }
});

test('snapshot API rejects tampered identity, invalid source/slot and unknown fields without auth', async () => {
  const api = await import('../functions/api/snapshot.js');
  const { DB, sqlite } = database();
  try {
    for (const payload of [
      snapshot(eventContext({ event_id: 'evt_v1_tampered_2026-09-03' })),
      snapshot(eventContext(), { idempotency_key: 'snap_v1_tampered' }),
      snapshot(eventContext(), { snapshot_source: 'attacker' }),
      snapshot(eventContext(), { scheduled_slot: '25:00' }),
      { ...snapshot(), rating: 'poor' }
    ]) {
      const response = await api.onRequestPost({ request: request(payload, '/api/snapshot'), env: { DB } });
      assert.equal(response.status, 400, await response.clone().text());
    }
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count, 0);
  } finally { sqlite.close(); }
});

test('observation API derives label and server time, atomically saves an in-window snapshot, then deduplicates retry', async () => {
  const api = await import('../functions/api/observation.js');
  const { DB, sqlite } = database();
  try {
    const context = eventContext();
    const payload = {
      observation: {
        submission_id: 'submission-atomic-1', event_context: context,
        rating: 'good', comment: '西侧有霞', source: 'rednote_agent',
        confidence: 0.8, evidence_count: 3
      },
      snapshot: snapshot(context, { snapshot_source: 'user_feedback', scheduled_slot: null })
    };
    const response = await api.onRequestPost({ request: request(payload, '/api/observation'), env: { DB } });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.snapshotSaved, true);
    const observation = sqlite.prepare('SELECT * FROM sunset_observations').get();
    const storedSnapshot = sqlite.prepare('SELECT * FROM prediction_snapshots').get();
    assert.equal(observation.rating_label, '✨ 普通有霞');
    assert.equal(observation.source, 'rednote_agent');
    assert.equal(observation.snapshot_id, storedSnapshot.id);
    assert.equal(storedSnapshot.snapshot_source, 'user_feedback');
    assert.equal(storedSnapshot.scheduled_slot, null);
    assert.ok(Date.now() - observation.submitted_at_epoch < 5000);
    const retry = await api.onRequestPost({ request: request(payload, '/api/observation'), env: { DB } });
    assert.equal((await retry.json()).deduplicated, true);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sunset_observations').get().count, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count, 1);
  } finally { sqlite.close(); }
});

test('observation batch rolls back the snapshot when the observation insert fails', async () => {
  const api = await import('../functions/api/observation.js');
  const { DB, sqlite } = database();
  try {
    sqlite.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON sunset_observations BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END");
    const context = eventContext();
    const payload = {
      observation: { submission_id: 'submission-rollback', event_context: context, rating: 'fair', source: 'user' },
      snapshot: snapshot(context, { snapshot_source: 'user_feedback', scheduled_slot: null })
    };
    const response = await api.onRequestPost({ request: request(payload, '/api/observation'), env: { DB } });
    assert.equal(response.status, 503);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sunset_observations').get().count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count, 0);
  } finally { sqlite.close(); }
});

test('post-window observation is stored without a snapshot and spoofed labels are rejected', async () => {
  const api = await import('../functions/api/observation.js');
  const { DB, sqlite } = database();
  try {
    const context = eventContext({ sunset_time_utc: new Date(Date.now() - 46 * 60 * 1000).toISOString() });
    const payload = {
      observation: { submission_id: 'submission-late', event_context: context, rating: 'poor', source: 'user' },
      snapshot: null
    };
    const response = await api.onRequestPost({ request: request(payload, '/api/observation'), env: { DB } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).snapshotSaved, false);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count, 0);
    const spoofed = structuredClone(payload);
    spoofed.observation.submission_id = 'submission-spoof';
    spoofed.observation.rating_label = '我自己定义';
    const rejected = await api.onRequestPost({
      request: request(spoofed, '/api/observation', { 'cf-connecting-ip': '203.0.113.8' }), env: { DB }
    });
    assert.equal(rejected.status, 400);
  } finally { sqlite.close(); }
});
