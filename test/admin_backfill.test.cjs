const test = require('node:test');
const assert = require('node:assert/strict');
const { database, request } = require('./d1-helper.cjs');

const ACTOR = { type: 'human', subject: 'admin@example.test', email: 'admin@example.test' };

function eventContext(index, city = '深圳', overrides = {}) {
  return {
    event_date_local: '2026-09-05',
    city,
    admin1: '广东',
    country: '中国',
    latitude: 22.5431 + index / 100,
    longitude: 114.0579 + index / 100,
    location_source: 'qweather',
    location_id: 'qweather:' + String(101280600 + index),
    timezone: 'Asia/Shanghai',
    sunset_time_utc: '2026-09-05T10:30:00.000Z',
    sunset_time_local: '2026-09-05 18:30',
    ...overrides
  };
}

function snapshot(context, slot) {
  return {
    event_context: context,
    snapshot_source: 'github_schedule',
    scheduled_slot: slot,
    query_id: 'qid-' + context.location_id + '-' + slot,
    prediction_time_utc: slot === '1213' ? '2026-09-05T04:13:00.000Z' : '2026-09-05T08:13:00.000Z',
    app_version: '2.4.5',
    model_version: '2.4.5',
    schema_version: 3,
    dataset_schema_version: 3,
    predicted_score: 68,
    predicted_level: '很好',
    raw_snapshot_json: JSON.stringify({ slot })
  };
}

async function addSnapshot(DB, sqlite, context, slot = '1213') {
  const api = await import('../functions/api/snapshot.js');
  const response = await api.onRequestPost({ request: request(snapshot(context, slot), '/api/snapshot'), env: { DB } });
  assert.equal(response.status, 200, await response.clone().text());
  return sqlite.prepare('SELECT event_id FROM prediction_snapshots WHERE query_id = ?').get(snapshot(context, slot).query_id).event_id;
}

function adminRequest(payload, host = 'admin.sunsetscore.ky-ok.com') {
  return new Request('https://' + host + '/api/admin/observation-backfill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function call(api, DB, payload, data = { adminActor: ACTOR }) {
  return api.onRequestPost({ request: adminRequest(payload), env: { DB }, data });
}

function previewItem(overrides = {}) {
  return {
    client_item_id: 'row-1',
    city: '深圳',
    event_date_local: '2026-09-05',
    rating: 'very_good',
    confidence: 0.9,
    evidence_count: 5,
    comment: '历史核验',
    ...overrides
  };
}

function commitItem(eventId, overrides = {}) {
  return {
    client_item_id: 'row-' + eventId.slice(7, 13),
    event_id: eventId,
    rating: 'very_good',
    confidence: 0.9,
    evidence_count: 5,
    comment: '历史核验',
    ...overrides
  };
}

test('preview groups multiple snapshots per Event and refuses automatic ambiguous matching', async () => {
  const api = await import('../functions/api/admin/observation-backfill.js');
  const { DB, sqlite } = database();
  try {
    await addSnapshot(DB, sqlite, eventContext(1), '1213');
    await addSnapshot(DB, sqlite, eventContext(1), '1613');
    let response = await call(api, DB, { mode: 'preview', items: [previewItem()] });
    let body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.items[0].status, 'matched');
    assert.equal(body.items[0].candidates.length, 1);
    assert.equal(body.items[0].candidates[0].snapshot_count, 2);

    await addSnapshot(DB, sqlite, eventContext(2), '1213');
    response = await call(api, DB, { mode: 'preview', items: [previewItem()] });
    body = await response.json();
    assert.equal(body.items[0].status, 'ambiguous');
    assert.equal(body.items[0].candidates.length, 2);

    response = await call(api, DB, { mode: 'preview', items: [previewItem({ city: '不存在' })] });
    body = await response.json();
    assert.equal(body.items[0].status, 'no_snapshot');
  } finally { sqlite.close(); }
});

test('preview blocks an Event whose historical Snapshots disagree on core context', async () => {
  const api = await import('../functions/api/admin/observation-backfill.js');
  const { DB, sqlite } = database();
  try {
    const context = eventContext(8);
    await addSnapshot(DB, sqlite, context, '1213');
    await addSnapshot(DB, sqlite, context, '1613');
    sqlite.prepare("UPDATE prediction_snapshots SET timezone = 'UTC' WHERE scheduled_slot = '1613'").run();

    const response = await call(api, DB, { mode: 'preview', items: [previewItem()] });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.items[0].status, 'context_conflict');
    assert.equal(body.items[0].candidates[0].context_conflict, true);
  } finally { sqlite.close(); }
});

test('commit atomically creates five-level manual Observations and immutable audit without Snapshots', async () => {
  const api = await import('../functions/api/admin/observation-backfill.js');
  const { DB, sqlite } = database();
  const ratings = ['excellent', 'very_good', 'good', 'fair', 'poor'];
  try {
    const eventIds = [];
    for (let index = 0; index < ratings.length; index += 1) {
      eventIds.push(await addSnapshot(DB, sqlite, eventContext(index + 10, '城市' + index)));
    }
    const beforeSnapshots = sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count;
    const items = eventIds.map((id, index) => commitItem(id, {
      client_item_id: 'row-' + index,
      rating: ratings[index]
    }));
    const payload = { mode: 'commit', request_id: 'request-five-ratings', items };
    let response = await call(api, DB, payload);
    let body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.deduplicated, false);
    assert.equal(body.items.length, 5);
    const observations = sqlite.prepare('SELECT * FROM sunset_observations ORDER BY rating').all();
    assert.equal(observations.length, 5);
    assert.ok(observations.every((row) => row.source === 'rednote_manual'));
    assert.ok(observations.every((row) => row.snapshot_id === null));
    assert.ok(observations.every((row) => row.dataset_schema_version === 3));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM observation_admin_audit').get().count, 5);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count, beforeSnapshots);
    const audit = sqlite.prepare('SELECT * FROM observation_admin_audit LIMIT 1').get();
    assert.equal(audit.actor_type, 'human');
    assert.equal(audit.actor_subject, ACTOR.subject);
    assert.equal(audit.action, 'create');

    response = await call(api, DB, payload);
    body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.deduplicated, true);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sunset_observations').get().count, 5);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM observation_admin_audit').get().count, 5);

    const changed = structuredClone(payload);
    changed.items[0].rating = 'poor';
    response = await call(api, DB, changed);
    assert.equal(response.status, 409);

    response = await call(api, DB, { ...payload, request_id: 'another-request' });
    assert.equal(response.status, 409);
  } finally { sqlite.close(); }
});

test('commit rejects stale or invalid batches with zero partial writes and rolls audit failures back', async () => {
  const api = await import('../functions/api/admin/observation-backfill.js');
  const { DB, sqlite } = database();
  try {
    const validEvent = await addSnapshot(DB, sqlite, eventContext(30, '广州'));
    const missingEvent = 'evt_v1_00000000000000000000_2026-09-05';
    let response = await call(api, DB, {
      mode: 'commit',
      request_id: 'request-invalid-batch',
      items: [
        commitItem(validEvent, { client_item_id: 'valid' }),
        commitItem(missingEvent, { client_item_id: 'missing' })
      ]
    });
    assert.equal(response.status, 409);
    const conflict = await response.json();
    assert.deepEqual(conflict.items.map((item) => item.status), ['not_committed', 'no_snapshot']);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sunset_observations').get().count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM observation_admin_audit').get().count, 0);

    sqlite.exec("CREATE TRIGGER reject_admin_audit BEFORE INSERT ON observation_admin_audit BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END");
    response = await call(api, DB, {
      mode: 'commit', request_id: 'request-audit-rollback', items: [commitItem(validEvent)]
    });
    assert.equal(response.status, 503);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sunset_observations').get().count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM observation_admin_audit').get().count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM prediction_snapshots').get().count, 1);
  } finally { sqlite.close(); }
});

test('admin API fails closed without middleware identity and validates strict batch envelopes', async () => {
  const api = await import('../functions/api/admin/observation-backfill.js');
  const { DB, sqlite } = database();
  try {
    let response = await api.onRequestPost({
      request: adminRequest({ mode: 'preview', items: [previewItem()] }),
      env: {
        DB,
        CF_ACCESS_TEAM_DOMAIN: 'https://sunsetscore-test.cloudflareaccess.com',
        CF_ACCESS_AUD: 'test-audience'
      }
    });
    assert.equal(response.status, 401);

    response = await call(api, DB, { mode: 'preview', items: [{ ...previewItem(), source: 'rednote_manual' }] });
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.items[0].client_item_id, 'row-1');
    assert.equal(body.items[0].status, 'invalid');
    assert.match(body.items[0].error, /未知字段/);

    response = await call(api, DB, {
      mode: 'preview',
      items: [previewItem({ client_item_id: 'calendar-row', event_date_local: '2026-02-30' })]
    });
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.items[0].client_item_id, 'calendar-row');
    assert.equal(body.items[0].status, 'invalid');
    const tooMany = Array.from({ length: 21 }, (_, index) => previewItem({ client_item_id: 'row-' + index }));
    response = await call(api, DB, { mode: 'preview', items: tooMany });
    assert.equal(response.status, 400);
  } finally { sqlite.close(); }
});

test('public Observation API cannot spoof the administrator-only source', async () => {
  const api = await import('../functions/api/observation.js');
  const { DB, sqlite } = database();
  try {
    const response = await api.onRequestPost({
      request: request({
        observation: {
          submission_id: 'spoof-manual-source',
          event_context: eventContext(50, '珠海'),
          rating: 'good',
          source: 'rednote_manual'
        },
        snapshot: null
      }, '/api/observation'),
      env: { DB }
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /source 非法/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sunset_observations').get().count, 0);
  } finally { sqlite.close(); }
});
