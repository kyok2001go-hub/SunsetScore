const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  const snap = sqlite.prepare(`INSERT INTO prediction_snapshots (
    id, idempotency_key, event_id, event_date_local, location_key, city, latitude, longitude,
    timezone, sunset_time_utc, sunset_time_local, query_id, prediction_time_utc,
    prediction_time_epoch, submitted_at_utc, submitted_at_epoch, snapshot_source,
    app_version, model_version, schema_version, dataset_schema_version,
    predicted_score, predicted_level, baseline_level, regime_label, sky_evolution_state, raw_snapshot_json
  ) VALUES (?, ?, ?, ?, 'loc', ?, 22, 114, 'Asia/Shanghai', '2026-09-23T10:00:00Z',
    '2026-09-23 18:00', 'query', '2026-09-23T04:00:00Z', 1,
    '2026-09-23T04:00:00Z', ?, ?, '2.4.6', '2.4.6', 3, 3, 50, ?, ?, ?, ?, ?)`) ;
  [
    ['s4', '深圳', '2026-09-23', '很好', null, '多云间晴', 'OPENING', 'github_schedule'],
    ['s3', '深圳', '2026-09-23', '一般', '一般', '晴', 'STABLE', 'github_manual'],
    ['s2', '广州', '2026-09-22', '很好', null, null, 'OPENING', 'user_feedback'],
    ['s1', '深%圳', '2026-09-23', '很好', null, '多云间晴', 'OPENING', 'github_schedule']
  ].forEach(([id, city, date, level, baseline, regime, sky, source]) => {
    snap.run(id, 'key-' + id, 'event-' + id, date, city, 1000, source,
      level, baseline, regime, sky, '{"private":"never list"}');
  });
  sqlite.prepare(`INSERT INTO sunset_observations (
    id, submission_id, event_id, event_date_local, location_key, city, latitude,
    longitude, timezone, sunset_time_utc, sunset_time_local, submitted_at_utc,
    submitted_at_epoch, rating, rating_label, comment, source, user_ip_hash,
    client_ua, dataset_schema_version
  ) VALUES ('o1', 'sub1', 'event-s4', '2026-09-23', 'loc', '深圳', 22, 114,
    'Asia/Shanghai', '2026-09-23T10:00:00Z', '2026-09-23 18:00',
    '2026-09-23T11:00:00Z', 1000, 'good', '普通有霞', '<img src=x onerror=alert(1)>',
    'rednote_manual', 'secret-ip', 'secret-ua', 3)`).run();
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; }
      };
    }
  };
  return { sqlite, db };
}

function context(db, path, method = 'GET') {
  return {
    request: new Request('https://admin.sunsetscore.ky-ok.com' + path, { method }),
    env: { DB: db }, data: { adminActor: { type: 'human', subject: 'test' } }
  };
}

test('admin Snapshot API has exactly 39 safe columns, deterministic order and combined filters', async () => {
  const { sqlite, db } = fixture();
  try {
    const { onRequest } = await import('../functions/api/admin/snapshots.js');
    const all = await (await onRequest(context(db, '/api/admin/snapshots?include_filter_options=1'))).json();
    assert.equal(all.columns.length, 39);
    assert.deepEqual([all.columns[0], all.columns.at(-1)], ['id', 'gw_factor']);
    assert.deepEqual(all.items.map(row => row.id), ['s4', 's3', 's2', 's1']);
    assert.ok(!('raw_snapshot_json' in all.items[0]));
    assert.ok(!('replay_object_key' in all.items[0]));
    const levels = ['极佳', '很好', '一般', '较差', '很差'];
    assert.deepEqual(all.filter_options.predicted_level, levels);
    assert.deepEqual(all.filter_options.baseline_level, [...levels, '__NULL__']);
    assert.deepEqual(all.filter_options.regime_label, [
      '晴朗', '多云间晴', '雨后转晴', '雨后转晴（强）', '锋面过境', '阴天', '雾霾', '风暴逼近',
      '__NULL__', '晴'
    ]);
    assert.deepEqual(all.filter_options.sky_evolution_state, [
      'CLEAR', 'OPENING', 'STABLE', 'CLOSING', 'CLOUD_ARRIVING', 'UNCERTAIN', '__NULL__'
    ]);
    const model = {};
    vm.runInNewContext(readFileSync(join(ROOT, 'js/config.js'), 'utf8'), model);
    vm.runInNewContext(readFileSync(join(ROOT, 'js/sky_state.js'), 'utf8'), model);
    assert.deepEqual(all.filter_options.predicted_level,
      Array.from(model.SunsetScore.config.levels, level => level.label));
    const regimeLabels = Object.values(model.SunsetScore.config.regimeLabels);
    const expectedRegimes = regimeLabels.flatMap(label => label === '雨后转晴'
      ? [label, label + '（强）'] : [label]);
    assert.deepEqual(all.filter_options.regime_label.slice(0, expectedRegimes.length), expectedRegimes);
    assert.deepEqual(all.filter_options.sky_evolution_state.slice(0, -1),
      Object.keys(model.SunsetScore.skyState.STATE_META));
    const query = '/api/admin/snapshots?event_date_local=2026-09-23&city=%E6%B7%B1' +
      '&predicted_level=%E5%BE%88%E5%A5%BD&baseline_level=__NULL__' +
      '&regime_label=%E5%A4%9A%E4%BA%91%E9%97%B4%E6%99%B4&sky_evolution_state=OPENING' +
      '&snapshot_source=github_schedule';
    const filtered = await (await onRequest(context(db, query))).json();
    assert.deepEqual(filtered.items.map(row => row.id), ['s4', 's1']);
    assert.equal(filtered.pagination.total, 2);
    for (const [city, expected] of [['%', ['s1']], ['_', []], ['\\', []]]) {
      const result = await (await onRequest(context(db, '/api/admin/snapshots?city=' + encodeURIComponent(city)))).json();
      assert.deepEqual(result.items.map(row => row.id), expected);
    }
    const onlyNull = await (await onRequest(context(db, '/api/admin/snapshots?regime_label=__NULL__'))).json();
    assert.deepEqual(onlyNull.items.map(row => row.id), ['s2']);
    const empty = await (await onRequest(context(db, '/api/admin/snapshots?baseline_level='))).json();
    assert.equal(empty.pagination.total, 4);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM prediction_snapshots').get().n, 4);
  } finally { sqlite.close(); }
});

test('admin Observation API shares public export columns and filters by rating and source', async () => {
  const { sqlite, db } = fixture();
  try {
    const { onRequest } = await import('../functions/api/admin/observations.js');
    const response = await onRequest(context(db, '/api/admin/observations?rating=good&source=rednote_manual&city=%E6%B7%B1&include_filter_options=1'));
    const result = await response.json();
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.columns.length, 25);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].comment, '<img src=x onerror=alert(1)>');
    assert.ok(!('user_ip_hash' in result.items[0]));
    assert.ok(!('client_ua' in result.items[0]));
    assert.deepEqual(result.filter_options.rating, ['excellent', 'very_good', 'good', 'fair', 'poor']);
    assert.equal(result.filter_labels.source.rednote_manual, '管理员补录');
  } finally { sqlite.close(); }
});

test('both admin lists default to newest submission first and break timestamp ties by id', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.exec(`UPDATE prediction_snapshots SET submitted_at_epoch = CASE id
      WHEN 's2' THEN 3000 WHEN 's1' THEN 2000 ELSE 1000 END`);
    const insert = sqlite.prepare(`INSERT INTO sunset_observations (
      id, submission_id, event_id, event_date_local, location_key, city, latitude, longitude,
      timezone, sunset_time_utc, sunset_time_local, submitted_at_utc, submitted_at_epoch,
      rating, rating_label, source, dataset_schema_version
    ) VALUES (?, ?, 'event-s4', '2026-09-23', 'loc', '深圳', 22, 114,
      'Asia/Shanghai', '2026-09-23T10:00:00Z', '2026-09-23 18:00',
      '2026-09-23T11:00:00Z', ?, 'good', '普通有霞', 'user', 3)`);
    for (const [id, epoch] of [['o2', 2000], ['o3', 3000], ['o4', 1000]]) {
      insert.run(id, 'sub-' + id, epoch);
    }
    const { onRequest: snapshots } = await import('../functions/api/admin/snapshots.js');
    const { onRequest: observations } = await import('../functions/api/admin/observations.js');
    const snapshotRows = await (await snapshots(context(db, '/api/admin/snapshots'))).json();
    const observationRows = await (await observations(context(db, '/api/admin/observations'))).json();
    assert.deepEqual(snapshotRows.items.map(row => row.id), ['s2', 's1', 's4', 's3']);
    assert.deepEqual(observationRows.items.map(row => row.id), ['o3', 'o2', 'o4', 'o1']);
    assert.deepEqual(snapshotRows.items.map(row => row.submitted_at_epoch), [3000, 2000, 1000, 1000]);
    assert.deepEqual(observationRows.items.map(row => row.submitted_at_epoch), [3000, 2000, 1000, 1000]);
  } finally { sqlite.close(); }
});

test('admin APIs reject invalid filters, parameters and write methods', async () => {
  const { sqlite, db } = fixture();
  try {
    const { onRequest } = await import('../functions/api/admin/snapshots.js');
    for (const query of [
      'event_date_local=2026-02-29', 'event_date_local=2026-09-31', 'page=0',
      'page=1.5', 'page_size=101', 'page_size=20&page_size=50', 'sort=id',
      'snapshot_source=attacker', 'include_filter_options=true', 'city=' + '深'.repeat(101)
    ]) {
      const response = await onRequest(context(db, '/api/admin/snapshots?' + query));
      assert.equal(response.status, 400, query);
    }
    const write = await onRequest(context(db, '/api/admin/snapshots', 'POST'));
    assert.equal(write.status, 405);
    assert.equal(write.headers.get('allow'), 'GET');
  } finally { sqlite.close(); }
});

test('server pagination separates pages with tied timestamps and rejects unauthenticated hosts', async () => {
  const { sqlite, db } = fixture();
  try {
    const insert = sqlite.prepare(`INSERT INTO prediction_snapshots (
      id, idempotency_key, event_id, event_date_local, location_key, city, latitude, longitude,
      timezone, sunset_time_utc, sunset_time_local, query_id, prediction_time_utc,
      prediction_time_epoch, submitted_at_utc, submitted_at_epoch, snapshot_source,
      app_version, model_version, schema_version, dataset_schema_version, predicted_score, predicted_level
    ) VALUES (?, ?, ?, '2026-09-23', 'loc', '分页市', 22, 114,
      'Asia/Shanghai', '2026-09-23T10:00:00Z', '2026-09-23 18:00', 'q',
      '2026-09-23T04:00:00Z', 1, '2026-09-23T04:00:00Z', 1000,
      'github_manual', '2.4.6', '2.4.6', 3, 3, 50, '很好')`);
    for (let n = 1; n <= 45; n++) {
      const id = 'page-' + String(n).padStart(2, '0');
      insert.run(id, 'key-' + id, 'event-' + id);
    }
    const { onRequest } = await import('../functions/api/admin/snapshots.js');
    const path = '/api/admin/snapshots?city=%E5%88%86%E9%A1%B5%E5%B8%82&page_size=20&page=';
    const pages = [];
    for (const n of [1, 2, 3, 4]) {
      pages.push(await (await onRequest(context(db, path + n))).json());
    }
    assert.deepEqual(pages.map(p => p.items.length), [20, 20, 5, 0]);
    assert.ok(pages.every(p => p.pagination.total === 45 && p.pagination.total_pages === 3));
    const ids = pages.flatMap(p => p.items.map(row => row.id));
    assert.equal(new Set(ids).size, 45);
    assert.deepEqual(ids, Array.from({ length: 45 }, (_, i) =>
      'page-' + String(45 - i).padStart(2, '0')));
    const unauthenticated = await onRequest({
      request: new Request('https://sunsetscore.ky-ok.com/api/admin/snapshots'), env: { DB: db }
    });
    assert.equal(unauthenticated.status, 404);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM prediction_snapshots WHERE city = '分页市'").get().n, 45);
  } finally { sqlite.close(); }
});

test('admin page router preserves the old link and serves only known pages', async () => {
  const { onRequest } = await import('../functions/admin/[[path]].js');
  const { onRequest: adminIndex } = await import('../functions/admin/index.js');
  const assets = [];
  function page(path) {
    return {
      request: new Request('https://admin.sunsetscore.ky-ok.com' + path),
      env: { ASSETS: { fetch(url) { assets.push(String(url)); return new Response('page'); } } }
    };
  }
  assert.equal((await adminIndex(page('/admin'))).status, 302);
  assert.equal((await onRequest(page('/admin/backfill.html'))).status, 301);
  assert.equal((await onRequest(page('/admin/snapshot'))).status, 200);
  assert.deepEqual(assets, ['https://admin.sunsetscore.ky-ok.com/admin/snapshot']);
  assert.equal((await onRequest(page('/admin/missing'))).status, 404);
});
