const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { gzipSync } = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { database } = require('./d1-helper.cjs');
const ROOT = path.join(__dirname, '..');
const at = '2026-09-10T00:00:00.000Z';
let modules;
async function api() {
  if (!modules) modules = Promise.all([
    import('../tools/dataset/export-dataset.mjs'), import('../tools/dataset/validate-dataset.mjs'),
    import('../tools/dataset/dataset-schema.mjs'), import('../tools/dataset/lib/common.mjs'),
    import('../tools/dataset/lib/selection.mjs'), import('../tools/dataset/lib/csv.mjs'),
    import('../tools/replay/replay-fixture.mjs'), import('../server/event-dataset.js'),
    import('../tools/dataset/lib/replay-cache.mjs'), import('../tools/dataset/lib/wrangler.mjs')
  ]).then(([exp, validate, schema, common, selection, csv, fixture, event, cache, wrangler]) =>
    ({ ...exp, ...validate, ...schema, ...common, ...selection, ...csv, ...fixture, ...event, ...cache, ...wrangler }));
  return modules;
}
async function setup(t, count = 3) {
  const m = await api(), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-dataset-'));
  const { sqlite } = database(), objects = new Map();
  t.after(async () => { sqlite.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const locationKey = 'qweather:101280601', eventId = `evt_v1_${m.hash(locationKey).slice(0, 20)}_2026-09-09`;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const replay = await m.createSizedReplay(5000, { eventId, snapshotId: `snap_test_${String(i).padStart(6, '0')}`,
      engineBuildSha: (i % 2 ? 'b' : 'a').repeat(40) });
    const bytes = Buffer.from(m.canonicalJson(replay)), compressed = gzipSync(bytes);
    const row = Object.fromEntries(m.SNAPSHOT_OFFLINE_FIELDS.filter(x => x !== 'lead_time_minutes').map(name => [name, null]));
    Object.assign(row, m.snapshotRowForReplay(replay, { score: 0, level: '很差' }));
    for (const key of Object.keys(row)) if (row[key] === undefined) row[key] = null;
    Object.assign(row, { idempotency_key: `key_${i}`, location_key: locationKey, location_source: 'qweather', location_id: '101280601',
      query_id: `q_${i}`, sunset_time_local: '2026-09-09T18:30:00+08:00',
      prediction_time_epoch: Date.parse(row.prediction_time_utc), submitted_at_epoch: Date.parse('2026-09-09T04:14:00Z'),
      submitted_at_utc: '2026-09-09T04:14:00.000Z', is_real_sounding: 1, replay_sha256: m.hash(bytes), replay_size_bytes: compressed.length,
      replay_saved_at_utc: '2026-09-09T04:15:00.000Z', replay_updated_at_utc: '2026-09-09T04:15:00.000Z' });
    const keys = Object.keys(row);
    sqlite.prepare(`INSERT INTO prediction_snapshots (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]));
    objects.set(row.id, compressed); rows.push(row);
  }
  const obs = { id: 'obs_test_1', submission_id: 'sub_test_1', event_id: eventId, snapshot_id: null,
    event_date_local: '2026-09-09', location_key: locationKey, city: 'Shenzhen', country: '中国', admin1: '广东',
    latitude: 22.5431, longitude: 114.0579, location_source: 'qweather', location_id: '101280601', timezone: 'Asia/Shanghai',
    sunset_time_utc: '2026-09-09T10:30:00.000Z', sunset_time_local: '2026-09-09T18:30:00+08:00',
    submitted_at_utc: '2026-09-09T11:00:00.000Z', submitted_at_epoch: Date.parse('2026-09-09T11:00:00Z'),
    rating: 'good', rating_label: m.RATING_LABELS.good, source: 'rednote_manual', confidence: null,
    evidence_count: 0, dataset_schema_version: 3, comment: '中文, "引号"\r\n第二行', user_ip_hash: 'must-not-query', client_ua: 'must-not-query' };
  const keys = Object.keys(obs);
  sqlite.prepare(`INSERT INTO sunset_observations (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => obs[k]));
  const queries = [];
  let downloads = 0;
  const source = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('AS cutoff_epoch')) return [{ cutoff_epoch: Date.parse(at) }];
      return sqlite.prepare(sql).all().map(x => ({ ...x }));
    },
    async download(row) { downloads++; return objects.get(row.id); }
  };
  const options = m.parseExportArgs(['--from', '2026-09-09', '--to', '2026-09-09', '--cutoff', at, '--output', dir]);
  return { m, dir, sqlite, rows, obs, objects, source, options, queries, downloads: () => downloads };
}

test('dataset exports real SQLite pages, mixed builds, replay cache, deterministic dedup and read-only validation', async t => {
  const f = await setup(t), { m } = f;
  const first = await m.exportDataset(f.options, { source: f.source, pageSize: 2, createdAt: at });
  assert.equal(first.status, 'EXPORTED', JSON.stringify(first));
  assert.equal(first.counts.snapshots, 3); assert.equal(first.counts.observations, 1);
  assert.equal(f.downloads(), 3);
  const validated = await m.validateDataset(first.directory);
  assert.equal(validated.report.status, 'PASS', JSON.stringify(validated.report));
  assert.equal(validated.manifest.versions.engine_build_shas.length, 2);
  assert.equal(validated.tables.prediction_snapshots[0].predicted_score, 0);
  assert.ok(validated.report.issues.some(x => x.error_code === 'EVENT_DISPLAY_CONTEXT_VARIANT'));
  assert.equal(validated.tables.replay_index[0].replay_size_bytes, 5000);
  assert.notEqual(validated.tables.replay_index[0].replay_compressed_size_bytes, 5000);
  assert.ok(f.queries.every(sql => !/user_ip_hash|client_ua|\bcomment\b|SELECT \*/.test(sql)));
  const before = await m.inventory(first.directory);
  const hashes = await Promise.all(before.map(async name => m.hash(await fs.readFile(path.join(first.directory, name)))));
  const second = await m.exportDataset(f.options, { source: f.source, pageSize: 1, createdAt: '2026-09-11T00:00:00.000Z' });
  assert.equal(second.status, 'DEDUPLICATED', JSON.stringify(second));
  assert.equal(second.dataset_id, first.dataset_id); assert.equal(f.downloads(), 3);
  assert.equal(second.cache_hits, 3);
  for (const script of ['validate-dataset.mjs', 'dataset-stats.mjs']) {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'tools/dataset', script), first.directory], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr + run.stdout);
  }
  assert.deepEqual(await m.inventory(first.directory), before);
  assert.deepEqual(await Promise.all(before.map(async name => m.hash(await fs.readFile(path.join(first.directory, name))))), hashes);
  await assert.rejects(m.reportOutside(first.directory, path.join(first.directory, 'reports'), 'new.json', {}), /REPORT_DIRECTORY_INSIDE_DATASET/);
  const copy = path.join(f.dir, 'copied', first.dataset_id);
  await fs.cp(first.directory, copy, { recursive: true });
  await fs.rm(path.join(f.dir, 'cache'), { recursive: true });
  assert.equal((await m.validateDataset(copy)).report.status, 'PASS');
});

test('typed CSV preserves null, quoted empty, multiline text, SLOT, boolean and negative zero', async () => {
  const m = await api();
  const fields = [
    { name: 'text', type: 'string', nullable: true }, { name: 'scheduled_slot', type: 'string', nullable: false },
    { name: 'number', type: 'number', nullable: false }, { name: 'boolean', type: 'boolean', nullable: false }
  ];
  const rows = [null, '', '中文,"\r\n下一行', ' a  b '].map(text => ({ text, scheduled_slot: '0413', number: 0, boolean: false }));
  const bytes = m.writeCsv(fields, rows);
  assert.deepEqual(m.readCsv(fields, bytes), rows);
  assert.ok(bytes.startsWith('\uFEFF')); assert.ok(bytes.endsWith('\r\n'));
  assert.deepEqual(m.readCsv(fields, m.writeCsv(fields, [])), []);
  for (const broken of [bytes.slice(1), bytes.replaceAll('\r\n', '\n'), bytes.replace('text,scheduled_slot', 'text,text')]) {
    assert.throws(() => m.readCsv(fields, broken));
  }
  assert.throws(() => m.writeCsv(fields, [{ ...rows[0], extra: 'no' }]));
});

test('selection normalization, SQL literals and strict D1 parsing', async () => {
  const m = await api(), base = ['--from', '2026-09-01', '--to', '2026-09-30'];
  const a = m.parseExportArgs([...base, '--city', ' 深圳,上海,深圳 ', '--scheduled-slot', '0413']);
  const b = m.parseExportArgs([...base, '--city', '上海,深圳', '--scheduled-slot', '0413']);
  assert.deepEqual(a.selection, b.selection); assert.equal(a.selection.scheduled_slots[0], '0413');
  for (const args of [[...base, '--city', 'a,'], [...base, '--from', '2026-09-02'],
    ['--from', '2026-02-30', '--to', '2026-03-01'], [...base, '--cutoff', '2026-09-01T00:00:00+08:00'], [...base, '--include-legacy-raw-snapshot']]) {
    assert.throws(() => m.parseExportArgs(args));
  }
  assert.equal(m.compactSql("SELECT  *\n FROM x WHERE city = 'O''Brien  City'"), "SELECT * FROM x WHERE city = 'O''Brien  City'");
  assert.equal(m.literal("O'Brien"), "'O''Brien'");
  assert.deepEqual(m.parseD1Output('[{"success":true,"results":[]}]'), []);
  for (const json of ['{}', '[]', 'not-json', '[{"success":false,"results":[]}]']) assert.throws(() => m.parseD1Output(json));
});

test('comments affect selection/schema/id, excluded comments do not; no observations remains valid', async t => {
  const f = await setup(t, 1), { m } = f;
  const first = await m.exportDataset(f.options, { source: f.source });
  assert.equal(first.status, 'EXPORTED', JSON.stringify(first));
  f.sqlite.prepare('UPDATE sunset_observations SET comment = ?').run('changed');
  assert.equal((await m.exportDataset(f.options, { source: f.source })).dataset_id, first.dataset_id);
  const included = await m.exportDataset({ ...f.options, selection: { ...f.options.selection, include_comments: true } }, { source: f.source });
  assert.equal(included.status, 'EXPORTED', JSON.stringify(included));
  assert.notEqual(included.dataset_id, first.dataset_id);
  assert.equal((await m.validateDataset(included.directory)).tables.sunset_observations[0].comment, 'changed');
  const noObs = await m.exportDataset({ ...f.options, selection: { ...f.options.selection, observation_sources: ['user'] } }, { source: f.source });
  assert.equal(noObs.status, 'EXPORTED', JSON.stringify(noObs));
  assert.equal(noObs.counts.observations, 0);
});

test('cutoff excludes late READY and submitted rows; invalid readiness and empty selection fail', async t => {
  const f = await setup(t), { m } = f;
  f.sqlite.prepare('UPDATE prediction_snapshots SET replay_saved_at_utc = ? WHERE id = ?').run('2026-09-11T00:00:00.000Z', f.rows[0].id);
  f.sqlite.prepare('UPDATE prediction_snapshots SET submitted_at_epoch = ?, submitted_at_utc = ? WHERE id = ?').run(Date.parse('2026-09-11T00:00:00Z'), '2026-09-11T00:00:00.000Z', f.rows[1].id);
  const result = await m.exportDataset(f.options, { source: f.source, pageSize: 1 });
  assert.equal(result.status, 'EXPORTED', JSON.stringify(result)); assert.equal(result.counts.snapshots, 1);
  f.sqlite.prepare('UPDATE prediction_snapshots SET replay_saved_at_utc = NULL WHERE id = ?').run(f.rows[2].id);
  assert.equal((await m.exportDataset(f.options, { source: f.source })).error_code, 'REPLAY_READY_TIME_INVALID');
  f.sqlite.exec("UPDATE prediction_snapshots SET replay_status = 'PENDING'");
  assert.equal((await m.exportDataset(f.options, { source: f.source })).error_code, 'EMPTY_SELECTION');
  assert.equal((await m.exportDataset({ ...f.options, cutoff: '2026-09-11T00:00:00.000Z' }, { source: f.source })).error_code, 'INVALID_CUTOFF');
});

test('source changes during download prevent publishing a partial package', async t => {
  const f = await setup(t, 1), { m } = f;
  const download = f.source.download;
  f.source.download = async row => { f.sqlite.exec("UPDATE sunset_observations SET confidence = 0.5"); return download(row); };
  const result = await m.exportDataset(f.options, { source: f.source });
  assert.equal(result.status, 'FAIL'); assert.equal(result.error_code, 'SOURCE_CHANGED_DURING_EXPORT');
  assert.equal(await fs.stat(path.join(f.dir, 'exports')).then(() => true, () => false), false);
  assert.match(await fs.readFile(path.join(result.staging, 'reports/errors.csv'), 'utf8'), /SOURCE_CHANGED_DURING_EXPORT/);
});

test('corrupted cache and corrupted existing export fail without overwriting either', async t => {
  const f = await setup(t, 1), { m } = f;
  const first = await m.exportDataset(f.options, { source: f.source });
  assert.equal(first.status, 'EXPORTED', JSON.stringify(first));
  const cache = path.join(f.dir, 'cache/replay', `${f.rows[0].replay_sha256}.json`);
  await fs.writeFile(cache, 'broken');
  const broken = await m.exportDataset(f.options, { source: f.source });
  assert.equal(broken.error_code, 'CACHE_HASH_CONFLICT'); assert.equal(f.downloads(), 1);
  await fs.writeFile(cache, require('node:zlib').gunzipSync(f.objects.get(f.rows[0].id)));
  const csv = path.join(first.directory, 'raw/events.csv');
  await fs.writeFile(csv, 'broken');
  const conflict = await m.exportDataset(f.options, { source: f.source });
  assert.equal(conflict.error_code, 'DATASET_ID_CONFLICT');
  assert.equal(await fs.readFile(csv, 'utf8'), 'broken');
  assert.equal((await m.validateDataset(first.directory)).report.status, 'FAIL');
});

test('cache concurrent writers deduplicate and retry only transient network errors', async t => {
  const f = await setup(t, 1), { m } = f;
  const cache = path.join(f.dir, 'cache/replay');
  const results = await Promise.all([1, 2].map(() => m.cachedReplay(f.rows[0], cache, f.source.download)));
  assert.equal(f.downloads(), 1); assert.equal(results.filter(x => x.hit).length, 1);
  const delays = []; let calls = 0;
  const bytes = await m.retryDownload(async () => { if (++calls < 3) throw new Error('NETWORK_TRANSIENT'); return 'ok'; }, {}, async ms => delays.push(ms));
  assert.equal(bytes, 'ok'); assert.deepEqual(delays, [1000, 2000]);
  calls = 0;
  await assert.rejects(m.retryDownload(async () => { calls++; throw new Error('CONTENT_HASH_MISMATCH'); }, {}));
  assert.equal(calls, 1);
});

test('concurrent full exports publish once and preserve first manifest', async t => {
  const f = await setup(t, 1);
  const results = await Promise.all([1, 2].map(() => f.m.exportDataset(f.options, { source: f.source })));
  assert.deepEqual(results.map(x => x.status).sort(), ['DEDUPLICATED', 'EXPORTED'], JSON.stringify(results));
  assert.equal((await f.m.validateDataset(results[0].directory)).report.status, 'PASS');
});

test('event entity conflicts fail, out-of-selection references warn', async t => {
  const f = await setup(t, 1), { m } = f;
  f.sqlite.prepare('UPDATE sunset_observations SET snapshot_id = ?').run('snap_external');
  const first = await m.exportDataset(f.options, { source: f.source });
  assert.equal(first.status, 'EXPORTED', JSON.stringify(first));
  assert.ok((await m.validateDataset(first.directory)).report.issues.some(x => x.error_code === 'OBSERVATION_SNAPSHOT_OUT_OF_SCOPE'));
  f.sqlite.exec('UPDATE sunset_observations SET latitude = 23');
  const conflict = await m.exportDataset(f.options, { source: f.source });
  assert.equal(conflict.status, 'FAIL');
  assert.ok(conflict.report.issues.some(x => x.error_code === 'EVENT_CONTEXT_CONFLICT'));
});

test('pagination enforces advancing cursor and fixed order on equal epochs', async () => {
  const m = await api();
  await assert.rejects(m.paginate(async () => [{ id: 'snap_a', submitted_at_epoch: 1 }], 'prediction_snapshots', ['id', 'submitted_at_epoch'], '1=1', 1), /PAGINATION_NOT_ADVANCING/);
  await assert.rejects(m.paginate(async () => [{ id: 'snap_z', submitted_at_epoch: 1 }, { id: 'snap_a', submitted_at_epoch: 1 }], 'prediction_snapshots', ['id', 'submitted_at_epoch'], '1=1', 2), /PAGINATION_NOT_ADVANCING/);
});

test('1001+ rows and 100+ events paginate without omissions; query plans expose sorting costs', async t => {
  const f = await setup(t, 1), { m } = f;
  const template = f.rows[0], keys = Object.keys(template);
  const insert = f.sqlite.prepare(`INSERT INTO prediction_snapshots (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
  f.sqlite.exec('BEGIN');
  for (let i = 1; i <= 1200; i++) {
    const row = { ...template, id: `snap_scale_${String(i).padStart(6, '0')}`, idempotency_key: `scale_key_${i}`,
      event_id: `evt_scale_${String(i % 105).padStart(3, '0')}` };
    insert.run(...keys.map(k => row[k]));
  }
  const obsKeys = Object.keys(f.obs);
  const insertObs = f.sqlite.prepare(`INSERT INTO sunset_observations (${obsKeys.join(',')}) VALUES (${obsKeys.map(() => '?').join(',')})`);
  for (let i = 0; i < 105; i++) {
    const row = { ...f.obs, id: `obs_scale_${i}`, submission_id: `sub_scale_${i}`, event_id: `evt_scale_${String(i).padStart(3, '0')}` };
    insertObs.run(...obsKeys.map(k => row[k]));
  }
  f.sqlite.exec('COMMIT');
  const metrics = [], cutoff = Date.parse(at);
  const snapshots = await m.extractSnapshots(f.source, f.options.selection, cutoff, 1000, metrics);
  assert.equal(snapshots.length, 1201); assert.equal(new Set(snapshots.map(x => x.id)).size, 1201);
  const observations = await m.extractObservations(f.source, f.options.selection, cutoff, m.eventIdsFor(snapshots), 20, metrics);
  assert.equal(observations.length, 106); assert.equal(new Set(observations.map(x => x.id)).size, 106);
  assert.deepEqual(observations, [...observations].sort(m.rowOrder));
  const sql = f.queries.find(sql => sql.includes('FROM prediction_snapshots'));
  const plans = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  assert.ok(plans.some(x => /idx_snapshot_replay_status/.test(x.detail)));
  assert.ok(plans.some(x => /TEMP B-TREE/.test(x.detail)));
  t.diagnostic(JSON.stringify({ snapshots: snapshots.length, observations: observations.length,
    pages: metrics.length, response_bytes: metrics.reduce((sum, x) => sum + x.response_bytes, 0),
    sqlite_query_ms: metrics.reduce((sum, x) => sum + x.duration_ms, 0), plan: plans.map(x => x.detail) }));
});

test('long SQL uses temporary --file; errors never leak output; timeout and buffer are bounded', async t => {
  const f = await setup(t, 1), { m } = f;
  let captured, sqlText;
  const query = "SELECT '" + 'a  b'.repeat(2000) + "' AS city";
  const result = await m.d1Rows('sunset-db', query, null, { tempDir: f.dir,
    execute: async args => {
      captured = args; sqlText = await fs.readFile(args[args.indexOf('--file') + 1], 'utf8');
      return '[{"success":true,"results":[{"city":"ok"}]}]';
    } });
  assert.equal(result[0].city, 'ok'); assert.equal(sqlText, query); assert.ok(captured.includes('--remote'));
  assert.equal(await fs.stat(captured[captured.indexOf('--file') + 1]).then(() => true, () => false), false);
  assert.throws(() => m.wrangler(['d1', 'execute'], null, { spawn: (command, args, options) => {
    assert.equal(options.windowsHide, true); assert.equal(options.timeout, 120000); assert.ok(options.maxBuffer <= 10 * 1024 * 1024);
    return { status: 1, stderr: 'secret-private-account-output' };
  } }), /^Error: WRANGLER_FAILED$/);
});

test('replay cache hit revalidates identity and transparent download remains canonical', async t => {
  const f = await setup(t, 1), { m } = f, row = f.rows[0];
  const cache = path.join(f.dir, 'cache/replay'), plain = require('node:zlib').gunzipSync(f.objects.get(row.id));
  const cached = await m.cachedReplay(row, cache, async () => plain);
  assert.equal(cached.hit, false); assert.ok(cached.bytes.equals(plain));
  await assert.rejects(m.cachedReplay({ ...row, id: 'snap_other' }, cache, async () => { throw new Error('SHOULD_NOT_DOWNLOAD'); }), /IDENTITY_MISMATCH/);
});

test('staging reports distinguish READY metadata changes and missing downloads', async t => {
  const f = await setup(t, 1), { m } = f;
  const download = f.source.download;
  f.source.download = async row => {
    f.sqlite.exec("UPDATE prediction_snapshots SET replay_status = 'PENDING'");
    return download(row);
  };
  const changed = await m.exportDataset(f.options, { source: f.source });
  assert.equal(changed.error_code, 'SOURCE_CHANGED_DURING_EXPORT');
  f.sqlite.exec("UPDATE prediction_snapshots SET replay_status = 'READY'");
  await fs.rm(path.join(f.dir, 'cache'), { recursive: true });
  f.source.download = async () => { throw new Error('OBJECT_NOT_FOUND'); };
  const missing = await m.exportDataset(f.options, { source: f.source });
  assert.equal(missing.status, 'FAIL');
  assert.equal(missing.report.issues[0].entity_id, f.rows[0].id);
  assert.equal(missing.report.issues[0].error_code, 'OBJECT_NOT_FOUND');
});

test('malformed schema, unsafe paths and byte corruption cannot validate', async t => {
  const f = await setup(t, 1), { m } = f;
  const first = await m.exportDataset(f.options, { source: f.source });
  assert.equal(first.status, 'EXPORTED', JSON.stringify(first));
  const schemaFile = path.join(first.directory, 'schema.json'), original = await fs.readFile(schemaFile);
  const schema = JSON.parse(original); schema.tables.events[0].nullable = true;
  await fs.writeFile(schemaFile, m.canonicalJson(schema));
  assert.equal((await m.validateDataset(first.directory)).report.issues[0].error_code, 'DATASET_SCHEMA_INVALID');
  await fs.writeFile(schemaFile, original);
  const replayFile = path.join(first.directory, 'replay', `${f.rows[0].id}.json`);
  await fs.appendFile(replayFile, '\n');
  assert.equal((await m.validateDataset(first.directory)).report.issues[0].error_code, 'REPLAY_HASH_MISMATCH');
  assert.throws(() => m.safeId('../escape'), /INVALID_ENTITY_ID/);
});

test('short-ID collision uses the full descriptor and cannot replace an existing package', async t => {
  const f = await setup(t, 1), { m } = f;
  const exported = await m.exportDataset(f.options, { source: f.source });
  assert.equal(exported.status, 'EXPORTED', JSON.stringify(exported));
  const original = await fs.readFile(path.join(exported.directory, 'manifest.json'));
  const manifest = JSON.parse(original);
  await assert.rejects(m.publishDataset(path.join(f.dir, 'unused-staging'), exported.directory,
    { ...manifest, descriptor_sha256: 'f'.repeat(64) }), /DATASET_ID_CONFLICT/);
  assert.ok((await fs.readFile(path.join(exported.directory, 'manifest.json'))).equals(original));
});

test('default server cutoff, negative lead and mixed selection semantics are preserved', async t => {
  const f = await setup(t, 2), { m } = f;
  const plain = JSON.parse(require('node:zlib').gunzipSync(f.objects.get(f.rows[1].id)));
  plain.identity.prediction_time_utc = '2026-09-09T10:45:00.000Z';
  plain.identity.model_version = '2.5.0'; plain.context.model_version = '2.5.0';
  const bytes = Buffer.from(m.canonicalJson(plain)), compressed = gzipSync(bytes);
  f.objects.set(f.rows[1].id, compressed);
  f.sqlite.prepare(`UPDATE prediction_snapshots SET prediction_time_utc=?,prediction_time_epoch=?,model_version=?,replay_sha256=?,replay_size_bytes=? WHERE id=?`)
    .run(plain.identity.prediction_time_utc, Date.parse(plain.identity.prediction_time_utc), '2.5.0', m.hash(bytes), compressed.length, f.rows[1].id);
  const all = await m.exportDataset({ ...f.options, cutoff: null }, { source: f.source });
  assert.equal(all.status, 'EXPORTED', JSON.stringify(all));
  const data = await m.validateDataset(all.directory);
  assert.equal(data.manifest.export_cutoff_utc, at);
  assert.equal(data.tables.prediction_snapshots[1].lead_time_minutes, -15);
  const selected = await m.exportDataset({ ...f.options, selection: { ...f.options.selection, model_versions: ['2.4.6'] } }, { source: f.source });
  assert.equal(selected.status, 'EXPORTED', JSON.stringify(selected));
  assert.equal(selected.counts.snapshots, 1); assert.equal(selected.counts.observations, 1);
});

test('file and descriptor hashes are independent of process timezone and locale', async () => {
  const script = `import { datasetSchema } from './tools/dataset/dataset-schema.mjs';
    import { canonicalJson,hash,unique } from './tools/dataset/lib/common.mjs';
    console.log(hash(canonicalJson({ schema:datasetSchema(), cities:unique(['深圳','上海','😀','a']) })));`;
  const hashes = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map(TZ => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT, env: { ...process.env, TZ, LANG: TZ === 'UTC' ? 'C' : 'zh_CN.UTF-8' }, encoding: 'utf8', windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
  assert.equal(new Set(hashes).size, 1);
});

test('Git ignores root data assets while keeping dataset tooling trackable', () => {
  const ignored = spawnSync('git', ['check-ignore', 'dataset/exports/example/manifest.json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const source = spawnSync('git', ['check-ignore', 'tools/dataset/export-dataset.mjs'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(ignored.status, 0); assert.equal(source.status, 1);
});
