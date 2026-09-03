const test = require('node:test');
const assert = require('node:assert/strict');
const { database, request } = require('./d1-helper.cjs');

function exportContext(DB, query = '') {
  return {
    request: new Request('https://example.test/api/export' + (query ? '?' + query : '')),
    env: { DB }
  };
}

function insertSnapshot(sqlite) {
  sqlite.prepare(`
    INSERT INTO prediction_snapshots (
      id, idempotency_key, event_id, event_date_local, location_key,
      city, latitude, longitude, timezone, sunset_time_utc, sunset_time_local,
      query_id, prediction_time_utc, prediction_time_epoch,
      submitted_at_utc, submitted_at_epoch, snapshot_source, scheduled_slot,
      app_version, model_version, schema_version, dataset_schema_version,
      predicted_score, predicted_level, raw_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'snap-export-1', 'snap-key-export-1', 'evt-export-1', '2026-09-03', 'qweather:101190401',
    '苏州', 31.2989, 120.5853, 'Asia/Shanghai', '2026-09-03T10:20:00.000Z', '2026-09-03 18:20',
    'qid-export-1', '2026-09-03T07:01:40.000Z', 1788418900000,
    '2026-09-03T07:01:43.409Z', 1788418903409, 'github_manual', '1501',
    '2.4.0', '2.4.0', 3, 1, 48, '一般', JSON.stringify({ note: '西侧,\n"好看"' })
  );
}

function insertObservation(sqlite) {
  sqlite.prepare(`
    INSERT INTO sunset_observations (
      id, submission_id, event_id, event_date_local, location_key,
      city, latitude, longitude, timezone, sunset_time_utc, sunset_time_local,
      submitted_at_utc, submitted_at_epoch, rating, rating_label, comment,
      source, user_ip_hash, client_ua, dataset_schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'obs-export-1', 'submission-export-1', 'evt-export-1', '2026-09-03', 'qweather:101190401',
    '苏州', 31.2989, 120.5853, 'Asia/Shanghai', '2026-09-03T10:20:00.000Z', '2026-09-03 18:20',
    '2026-09-03T11:00:00.000Z', 1788433200000, 'good', '✨ 普通有霞', '西侧有霞',
    'user', 'private-ip-hash', 'private-user-agent', 1
  );
}

for (const legacy of [false, true]) {
  test(`default CSV and JSON export remain compatible with ${legacy ? 'legacy' : 'current'} feedback table`, async () => {
    const feedback = await import('../functions/api/feedback.js');
    const exporter = await import('../functions/api/export.js');
    const { DB, sqlite } = database(legacy);
    try {
      const empty = await exporter.onRequestGet(exportContext(DB, 'format=csv'));
      assert.equal(empty.status, 200);
      assert.match(await empty.text(), /created_at_epoch/);
      await feedback.onRequestPost({ request: request({
        city: '上海', user_rating: 'good', user_comment: '西侧,有霞\n"好看"',
        model_version: '2.3.1', app_version: '2.3.1', schema_version: 3,
        raw_snapshot_json: JSON.stringify({ app_version: '2.3.1', schema_version: 3 })
      }), env: { DB } });
      const csv = await exporter.onRequestGet(exportContext(DB, 'format=csv'));
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-disposition'), /sunset_feedback_/);
      assert.equal(csv.headers.get('cache-control'), 'private, no-store');
      assert.match(await csv.text(), /"西侧,有霞\n""好看"""/);
      const json = await exporter.onRequestGet(exportContext(DB, 'format=json'));
      assert.equal(json.status, 200);
      const rows = await json.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].schema_version, 3);
      assert.equal(rows[0].app_version, '2.3.1');
      assert.ok(Math.abs(Date.now() - rows[0].created_at_epoch) < 10000);
      assert.match(rows[0].created_at_utc, /T.*Z$/);
    } finally { sqlite.close(); }
  });
}

test('prediction snapshots export through fixed JSON and CSV dataset links', async () => {
  const exporter = await import('../functions/api/export.js');
  const { DB, sqlite } = database();
  try {
    insertSnapshot(sqlite);
    const json = await exporter.onRequestGet(exportContext(DB, 'dataset=prediction_snapshots&format=json'));
    assert.equal(json.status, 200);
    assert.equal(json.headers.get('x-export-dataset'), 'prediction_snapshots');
    assert.equal(json.headers.get('x-export-row-count'), '1');
    const rows = await json.json();
    assert.equal(rows[0].city, '苏州');
    assert.equal(rows[0].snapshot_source, 'github_manual');
    assert.equal(rows[0].scheduled_slot, '1501');
    assert.equal(rows[0].raw_snapshot_json, JSON.stringify({ note: '西侧,\n"好看"' }));

    const csv = await exporter.onRequestGet(exportContext(DB, 'dataset=prediction_snapshots&format=csv'));
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /prediction_snapshots_/);
    const body = await csv.text();
    assert.match(body, /id,idempotency_key,event_id/);
    assert.match(body, /苏州/);
    assert.match(body, /"\{""note"":""西侧,\\n\\""好看\\""""\}"/);
  } finally { sqlite.close(); }
});

test('public observations export excludes client fingerprint fields', async () => {
  const exporter = await import('../functions/api/export.js');
  const { DB, sqlite } = database();
  try {
    insertObservation(sqlite);
    const json = await exporter.onRequestGet(exportContext(DB, 'dataset=sunset_observations&format=json'));
    assert.equal(json.status, 200);
    const rows = await json.json();
    assert.equal(rows[0].rating, 'good');
    assert.equal(rows[0].comment, '西侧有霞');
    assert.equal('user_ip_hash' in rows[0], false);
    assert.equal('client_ua' in rows[0], false);

    const csv = await exporter.onRequestGet(exportContext(DB, 'dataset=sunset_observations&format=csv'));
    assert.equal(csv.status, 200);
    const header = (await csv.text()).split('\r\n')[0];
    assert.doesNotMatch(header, /user_ip_hash|client_ua/);
    assert.match(header, /submission_id/);
  } finally { sqlite.close(); }
});

test('export accepts only fixed datasets and csv/json format', async () => {
  const exporter = await import('../functions/api/export.js');
  const { DB, sqlite } = database();
  try {
    const invalidDataset = await exporter.onRequestGet(exportContext(DB, 'dataset=sqlite_schema&format=json'));
    assert.equal(invalidDataset.status, 400);
    const inheritedName = await exporter.onRequestGet(exportContext(DB, 'dataset=constructor&format=json'));
    assert.equal(inheritedName.status, 400);
    const invalidFormat = await exporter.onRequestGet(exportContext(DB, 'dataset=prediction_snapshots&format=xlsx'));
    assert.equal(invalidFormat.status, 400);
    const unsupportedFilter = await exporter.onRequestGet(exportContext(DB, 'dataset=prediction_snapshots&format=csv&limit=1'));
    assert.equal(unsupportedFilter.status, 400);
  } finally { sqlite.close(); }
});

test('export rejects more than 5000 rows instead of returning a partial dataset', async () => {
  const exporter = await import('../functions/api/export.js');
  const statements = [];
  const DB = {
    prepare(sql) {
      statements.push(sql);
      return { first: async () => ({ total: 5001 }) };
    }
  };
  const response = await exporter.onRequestGet(exportContext(DB, 'dataset=prediction_snapshots&format=csv'));
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), {
    success: false,
    error: '数据量超过单次导出上限，请等待后续版本提供分批导出',
    dataset: 'prediction_snapshots',
    totalRows: 5001,
    maxRows: 5000
  });
  assert.equal(statements.length, 1, 'oversized export must not load dataset rows');
});

test('optional ADMIN_SECRET is still enforced, never bypassed by dataset or CSV format', async () => {
  const api = await import('../functions/api/export.js');
  const response = await api.onRequestGet({
    request: new Request('https://example.test/api/export?dataset=prediction_snapshots&format=csv'),
    env: { DB: {}, ADMIN_SECRET: 'test-only' }
  });
  assert.equal(response.status, 401);
});
