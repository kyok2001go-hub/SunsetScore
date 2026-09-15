const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { gzipSync } = require('node:zlib');
const { spawnSync, spawn } = require('node:child_process');
const { database } = require('./d1-helper.cjs');
let modules;
async function api() {
  return modules ||= Promise.all(['model-dataset/lib/core', 'model-dataset/split-events', 'model-dataset/model-dataset-schema',
    'model-dataset/lib/package', 'model-dataset/lib/input', 'model-dataset/build-model-dataset', 'model-dataset/validate-model-dataset',
    'model-dataset/plan-model-dataset', 'model-dataset/lib/cli', 'dataset/lib/common', 'dataset/lib/csv', 'dataset/dataset-schema',
    'replay/replay-fixture'].map(n => import(`../tools/${n}.mjs`))).then(xs => Object.assign({}, ...xs));
}
const date = i => `2026-09-${String(i + 1).padStart(2, '0')}`;
async function pure(blocks = [30, 10, 10]) {
  const m = await api(), events = [], snapshots = [], gt = [], replays = [];
  for (let d = 0; d < blocks.length; d++) for (let n = 0; n < blocks[d]; n++) {
    const id = `snap_${d}_${n}`, event_id = `evt_${d}_${n}`, dt = date(d);
    const row = Object.fromEntries(m.RAW_FIELDS.map(f => [f.name === 'snapshot_id' ? 'id' : f.name,
      f.nullable ? null : f.type === 'string' ? 'fixture' : f.type === 'boolean' ? false : 1]));
    Object.assign(row, { id, event_id, event_date_local: dt, city: '人工样本', timezone: 'Asia/Shanghai',
      sunset_time_utc: `${dt}T10:30:00.000Z`, prediction_time_utc: `${dt}T04:30:00.000Z`, prediction_time_epoch: Date.parse(`${dt}T04:30:00.000Z`),
      submitted_at_utc: `${dt}T04:30:00.000Z`, submitted_at_epoch: Date.parse(`${dt}T04:30:00.000Z`),
      scheduled_slot: '1213', snapshot_source: 'github_manual', model_version: '2.4.6', predicted_level: '一般', baseline_level: null,
      predicted_score: 40, lead_time_minutes: 360 });
    snapshots.push(row); events.push({ event_id, event_date_local: dt, city: '人工Event' });
    gt.push({ event_id, gt_label: 'good', gt_ordinal: 2, gt_confidence: 1, gt_status: 'STRONG' });
    replays.push({ snapshot_id: id, event_id, local_path: `replay/${id}.json`, engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64) });
  }
  const run = (selection = m.selection(), version = 2) => m.derive(events, snapshots, gt, replays, selection, undefined, version);
  return { m, events, snapshots, gt, replays, run };
}
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-model-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
const fakeSource = { source_dataset_id: `raw_v1_20260901_20260903_${'a'.repeat(12)}`, ground_truth_id: `gt_v2_${'a'.repeat(12)}_${'b'.repeat(12)}`,
  source_dataset_manifest_sha256: 'c'.repeat(64), ground_truth_manifest_sha256: 'd'.repeat(64), source_descriptor_sha256: 'a'.repeat(64),
  ground_truth_descriptor_sha256: 'b'.repeat(64), source_versions: { raw_schema: 1, gt_schema: 2, gt_policy: 1 } };
async function savePackage(root, m, result, source = fakeSource) {
  const files = m.contents(result), manifest = m.makeManifest(source, result, files, '2026-09-14T00:00:00.000Z');
  const dir = path.join(root, manifest.model_dataset_id);
  await fs.mkdir(path.join(dir, 'reports'), { recursive: true }); await fs.mkdir(path.join(dir, 'splits'), { recursive: true });
  for (const [f, bytes] of Object.entries({ ...files, 'manifest.json': m.canonicalJson(manifest) })) await fs.writeFile(path.join(dir, f), bytes);
  return { dir, files, manifest };
}
test('Model schema freezes all 79 inherited columns, roles and 94-column sample contract', async () => {
  const m = await api(), upstream = m.datasetSchema().tables.prediction_snapshots;
  assert.equal(m.RAW_FIELDS.length, 79); assert.equal(m.SAMPLE_FIELDS.length, 94);
  for (let i = 0; i < 79; i++) {
    const { role, prediction_feature_allowed, ...raw } = m.RAW_FIELDS[i];
    assert.deepEqual(raw, { ...upstream[i], name: i === 0 ? 'snapshot_id' : upstream[i].name });
    assert.equal(prediction_feature_allowed, role === 'feature');
  }
  assert.equal(m.RAW_FIELDS.filter(f => f.role === 'feature').length, 20);
  assert.ok(m.SAMPLE_FIELDS.filter(f => f.name.startsWith('gt_')).every(f => !f.prediction_feature_allowed));
  assert.equal(m.SAMPLE_FIELDS.find(f => f.name === 'predicted_score').role, 'baseline_output');
});
test('Model lead bucket exact boundaries, qualification priority and per-event mixed-model weights', async () => {
  const f = await pure([1]), { m } = f;
  assert.deepEqual([-1, 0, 29.9, 30, 60, 180, 360].map(m.bucket), ['POST_SUNSET', 'T_0_30M', 'T_0_30M', 'T_30_60M', 'T_1_3H', 'T_3_6H', 'T_6H_PLUS']);
  for (let i = 1; i < 4; i++) { f.snapshots.push({ ...f.snapshots[0], id: `more_${i}`, model_version: i === 1 ? 'other' : '2.4.6' });
    f.replays.push({ ...f.replays[0], snapshot_id: `more_${i}`, local_path: `replay/more_${i}.json` }); }
  const post = f.snapshots[3]; post.lead_time_minutes = -1; post.prediction_time_epoch = Date.parse(post.sunset_time_utc) + 60000;
  post.prediction_time_utc = new Date(post.prediction_time_epoch).toISOString();
  let r = f.run(); assert.equal(r.events[0].primary_snapshot_count, 3);
  assert.ok(r.rows.filter(r => r.eligibility === 'PRIMARY').every(r => r.event_normalized_weight === 1 / 3));
  assert.equal(r.rows.find(r => r.snapshot_id === post.id).diagnostic_reason, 'POST_SUNSET');
  r = f.run(m.selection('2.4.6')); assert.equal(r.events[0].primary_snapshot_count, 2);
  assert.equal(r.rows.find(r => r.snapshot_id === 'more_1').exclusion_reason, 'MODEL_VERSION_FILTERED');
  f.gt[0].gt_status = 'WEAK'; f.gt[0].gt_confidence = .3;
  r = f.run(); assert.ok(r.rows.every(r => r.diagnostic_reason === 'WEAK_GT' && r.event_normalized_weight === 0 && r.gt_weight === .3));
  for (const [status, reason] of [['DISPUTED', 'DISPUTED_GT'], ['UNLABELED', 'UNLABELED']]) {
    Object.assign(f.gt[0], { gt_status: status, gt_confidence: status === 'UNLABELED' ? 0 : .2, gt_label: status === 'UNLABELED' ? null : 'good', gt_ordinal: status === 'UNLABELED' ? null : 2 });
    assert.ok(f.run().rows.every(r => r.exclusion_reason === reason));
  }
  assert.ok(f.run(m.selection('missing')).rows.every(r => r.exclusion_reason === 'MODEL_VERSION_FILTERED'));
});
test('Model split independently enumerates date-boundary objective, minima and earliest ties', async () => {
  const m = await api();
  const reference = counts => {
    let best = null;
    for (let i = 1; i < counts.length; i++) for (let j = i + 1; j < counts.length; j++) {
      const sizes = [counts.slice(0, i), counts.slice(i, j), counts.slice(j)].map(ns => ns.reduce((a, b) => a + b, 0));
      if (sizes[0] < 30 || sizes[1] < 10 || sizes[2] < 10) continue;
      const total = sizes.reduce((a, b) => a + b), score = Math.abs(sizes[0] * 100 - total * 70) + Math.abs(sizes[1] * 100 - total * 15) + Math.abs(sizes[2] * 100 - total * 15);
      if (!best || score < best.score) best = { i, j, score };
    } return best;
  };
  for (let seed = 0; seed < 100; seed++) {
    const counts = Array.from({ length: 3 + seed % 5 }, (_, i) => 1 + ((seed * 13 + i * 17) % 35));
    const events = counts.flatMap((n, i) => Array.from({ length: n }, () => ({ event_date_local: date(i) })));
    const expected = reference(counts), actual = m.splitEvents(events).selected_split;
    assert.equal(actual?.validation_boundary || null, expected ? date(expected.i) : null);
    assert.equal(actual?.test_boundary || null, expected ? date(expected.j) : null);
    if (actual) assert.equal(actual.objective, expected.score);
  }
  const exact = (await pure()).run();
  assert.deepEqual(Object.values(exact.plan.selected_split.splits).map(s => s.events), [30, 10, 10]);
  assert.equal((await pure([10, 30, 10])).run().plan.publishable, false);
  assert.equal((await pure([100])).run().plan.theoretical_split, null);
  assert.equal((await pure([1, 1, 1])).run().plan.theoretical_split.splits.TRAIN.events, 1);
  assert.equal((await pure([])).run().plan.minimum_total_event_deficit, 50);
});
test('Model plan preserves every source row and original fields, independent of input order', async () => {
  const f = await pure(), { m } = f;
  const first = f.run(); f.events.reverse(); f.snapshots.reverse(); f.gt.reverse(); f.replays.reverse();
  assert.deepEqual(f.run(), first);
  for (const row of first.rows) {
    const raw = f.snapshots.find(s => s.id === row.snapshot_id);
    for (const field of m.RAW_FIELDS) assert.equal(row[field.name], raw[field.name === 'snapshot_id' ? 'id' : field.name]);
  }
  const none = f.run(m.selection('missing'));
  assert.equal(none.counts.excluded_samples, 50); assert.equal(none.counts.primary_events, 0);
  assert.ok(none.plan.blockers.includes('MODEL_FILTER_MATCHED_NO_SNAPSHOTS'));
});
test('Model rejects missing/duplicate JOIN inputs and nonfinite/inconsistent lead', async () => {
  const f = await pure([1]);
  f.snapshots[0].lead_time_minutes = Infinity; assert.throws(f.run, /MODEL_DATASET_VALIDATION_FAILED/);
  f.snapshots[0].lead_time_minutes = 359; assert.throws(f.run, /MODEL_DATASET_VALIDATION_FAILED/);
  f.snapshots[0].lead_time_minutes = 360; f.gt[0].gt_status = 'UNKNOWN'; assert.throws(f.run, /MODEL_DATASET_VALIDATION_FAILED/);
  f.gt[0].gt_status = 'STRONG'; f.replays.length = 0; assert.throws(f.run, /MODEL_DATASET_VALIDATION_FAILED/);
});
test('Model canonical package, independently computed count/identity vectors and tamper detection', async t => {
  const f = await pure(), m = { ...f.m, SAMPLE_FIELDS: f.m.SAMPLE_FIELDS_V1 }, root = await temp(t);
  const p = await savePackage(root, m, f.run(undefined, 1));
  const inspected = await m.inspectModelDataset(p.dir);
  assert.equal(inspected.validation_scope, 'PACKAGE_INTERNAL');
  assert.equal(inspected.statistics.counts.train_samples, 30);
  assert.equal(inspected.statistics.gt_confidence.all_events.mean, 1);
  assert.equal(inspected.statistics.primary_snapshots_per_event.median, 1);
  assert.ok(p.files['model_samples.csv'].startsWith('\uFEFFsnapshot_id,'));
  assert.ok(p.files['model_samples.csv'].endsWith('\r\n'));
  // Independent CSV encoder and manually assigned 30/10/10 split/weight expectations.
  const encode = v => v === null ? '' : typeof v === 'boolean' ? (v ? '1' : '0') :
    String(v) === '' || /[,"\r\n]/.test(String(v)) ? '"' + String(v).replaceAll('"', '""') + '"' : String(v);
  const ordered = [...f.snapshots].sort((a, b) => a.event_date_local < b.event_date_local ? -1 : a.event_date_local > b.event_date_local ? 1 : a.event_id < b.event_id ? -1 : 1);
  const expectedLines = ordered.map(s => [...m.RAW_FIELDS.map(field => s[field.name === 'snapshot_id' ? 'id' : field.name]),
    'T_6H_PLUS', 'a'.repeat(40), 'b'.repeat(64), `replay/${s.id}.json`, 'good', 2, 1, 'STRONG', 'PRIMARY',
    s.event_date_local === date(0) ? 'TRAIN' : s.event_date_local === date(1) ? 'VALIDATION' : 'TEST', 1, 1, null, null].map(encode).join(','));
  assert.equal(p.files['model_samples.csv'], '\uFEFF' + [m.SAMPLE_FIELDS.map(f => f.name).join(','), ...expectedLines].join('\r\n') + '\r\n');
  assert.equal(m.hash(p.files['model_samples.csv']), 'f407144d401bba868e1b4fa553a351e542270baf6fa52a489ed3128effec7925');
  assert.equal(p.manifest.model_dataset_id, 'model_v1_aaaaaaaaaaaa_bbbbbbbbbbbb_1b8801bde404');
  const current = await savePackage(root, m, f.run());
  const index = m.SAMPLE_FIELDS.findIndex(f=>f.name==='gt_status')+1;
  const currentExpected = expectedLines.map(line=>{const cells=line.split(',');cells.splice(index,0,'OBSERVATION_AGGREGATED');return cells.join(',');});
  assert.equal(current.files['model_samples.csv'], '\uFEFF'+[f.m.SAMPLE_FIELDS.map(f=>f.name).join(','),...currentExpected].join('\r\n')+'\r\n');
  assert.equal(current.manifest.model_dataset_id, 'model_v2_aaaaaaaaaaaa_bbbbbbbbbbbb_4331a9959fac');
  assert.equal((await m.inspectModelDataset(current.dir)).status,'PASS');
});
test('Model detects semantic row, schema-role and nonoptimal split tampering despite repaired hashes', async t => {
  const f = await pure([35, 10, 10, 10]), { m } = f, root = await temp(t);
  for (const type of ['weight', 'split', 'role', 'extra', 'row']) {
    const p = await savePackage(path.join(root, type), m, f.run());
    let target, bytes;
    if (type === 'role') {
      target = 'schema.json'; const schema = JSON.parse(p.files[target]); schema.tables.samples.find(x => x.name === 'predicted_score').prediction_feature_allowed = true;
      bytes = m.canonicalJson(schema);
    } else if (type === 'extra') { await fs.writeFile(path.join(p.dir, 'extra.txt'), 'unexpected'); }
    else {
      target = 'model_samples.csv'; const rows = m.readCsv(m.SAMPLE_FIELDS, p.files[target]);
      if (type === 'weight') rows[0].event_normalized_weight = .1;
      if (type === 'split') rows[0].split = 'TEST';
      if (type === 'row') rows.pop();
      bytes = m.writeCsv(m.SAMPLE_FIELDS, rows);
    }
    if (target) {
      await fs.writeFile(path.join(p.dir, target), bytes);
      Object.assign(p.manifest.files[target], { bytes: Buffer.byteLength(bytes), sha256: m.hash(bytes) });
      await fs.writeFile(path.join(p.dir, 'manifest.json'), m.canonicalJson(p.manifest));
    }
    await assert.rejects(m.inspectModelDataset(p.dir), /MODEL_DATASET_VALIDATION_FAILED/);
  }
});
test('Model rejects a fully rehashed feasible but nonoptimal split and changed GT labels', async t => {
  const f = await pure([30, 10, 10, 10]), { m } = f, root = await temp(t), result = f.run();
  // Optimal TRAIN is 40. The alternative 30/20/10 meets minima but must be rejected.
  assert.equal(result.plan.selected_split.splits.TRAIN.events, 40);
  for (const e of result.events) e.split = e.event_date_local < date(1) ? 'TRAIN' : e.event_date_local < date(3) ? 'VALIDATION' : 'TEST';
  for (const r of result.rows) r.split = r.event_date_local < date(1) ? 'TRAIN' : r.event_date_local < date(3) ? 'VALIDATION' : 'TEST';
  result.plan.selected_split = { validation_boundary: date(1), test_boundary: date(3), objective: 2400,
    splits: { TRAIN: { events: 30, date_range: { from: date(0), to: date(0) }, ratio: .5 },
      VALIDATION: { events: 20, date_range: { from: date(1), to: date(2) }, ratio: .333333333333 },
      TEST: { events: 10, date_range: { from: date(3), to: date(3) }, ratio: .166666666667 } } };
  Object.assign(result.counts, { train_samples: 30, validation_samples: 20, test_samples: 10 });
  const stats = await import('../tools/model-dataset/lib/statistics.mjs');
  result.statistics = stats.statistics(result.events, result.rows, result.counts, result.statistics.input_validation_summary); result.balance = result.statistics.splits;
  const p = await savePackage(root, m, result);
  await assert.rejects(m.inspectModelDataset(p.dir), /MODEL_DATASET_VALIDATION_FAILED/);
  const changed = f.run(); changed.rows[0].gt_label = 'poor'; changed.rows[0].gt_ordinal = 0;
  const q = await savePackage(root, m, changed);
  await assert.rejects(m.inspectModelDataset(q.dir), /MODEL_DATASET_VALIDATION_FAILED/);
});
test('Model CLI rejects duplicate/unknown/missing arguments, filters normalize by codepoint', async () => {
  const m = await api();
  assert.deepEqual(m.selection(' b,a,b '), { model_versions: ['a', 'b'] });
  assert.deepEqual(m.selection(Array(101).fill('a').join(',')), { model_versions: ['a'] });
  for (const v of ['', 'a,,b', Array.from({ length: 101 }, (_, i) => String(i)).join(',')]) assert.throws(() => m.selection(v), /INVALID_ARGUMENTS/);
  for (const args of [['--raw', 'r'], ['--raw', 'r', '--gt', 'g', '--raw', 'r'], ['--raw', 'r', '--gt', 'g', '--bad', 'x']]) assert.throws(() => m.parseArgs(args, 'build'), /INVALID_ARGUMENTS/);
  assert.throws(() => m.parseArgs(['p', '--raw', 'r'], 'validate'), /INVALID_ARGUMENTS/);
});
test('Model report paths reject input nesting, traversal, symlinks and overwrites', async t => {
  const m = await api(), root = await temp(t), raw = path.join(root, 'raw'); await fs.mkdir(raw);
  await assert.rejects(m.outside(path.join(raw, 'reports'), [raw]), /UNSAFE_PATH/);
  await assert.rejects(m.outside(root + '/x/../reports', []), /UNSAFE_PATH/);
  await fs.symlink(raw, path.join(root, 'linked'), 'junction');
  await assert.rejects(m.outside(path.join(root, 'linked', 'out'), []), /UNSAFE_PATH/);
  await m.writeReport(path.join(root, 'reports'), 'plan.json', { ok: true }, [raw]);
  await assert.rejects(m.writeReport(path.join(root, 'reports'), 'plan.json', {}, [raw]), /UNSAFE_PATH/);
});

// Full artificial Raw fixture uses an in-memory D1 adapter and real Replay validation.
async function linkedFixture(t) {
  const m = await api(), dir = await temp(t), { sqlite } = database(); t.after(() => sqlite.close());
  const exporter = await import('../tools/dataset/export-dataset.mjs');
  const parser = await import('../tools/dataset/lib/selection.mjs');
  const { buildGroundTruth } = await import('../tools/ground-truth/build-ground-truth.mjs');
  const objects = new Map();
  const insert = (table, row) => { const keys = Object.keys(row); sqlite.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?')})`).run(...keys.map(k => row[k])); };
  for (let i = 0; i < 51; i++) {
    const dt = date(i < 31 ? 0 : i < 41 ? 1 : 2), location_id = String(101000000 + i), location_key = `qweather:${location_id}`;
    const eventId = `evt_v1_${m.hash(location_key).slice(0, 20)}_${dt}`, snapshotId = `snap_fixture_${i}`;
    let replay = await m.createSizedReplay(5000, { eventId, snapshotId });
    replay = JSON.parse(JSON.stringify(replay).replaceAll('2026-09-09', dt));
    const bytes = Buffer.from(m.canonicalJson(replay)), compressed = gzipSync(bytes); objects.set(snapshotId, compressed);
    const row = Object.fromEntries(m.SNAPSHOT_OFFLINE_FIELDS.filter(x => x !== 'lead_time_minutes').map(n => [n, null]));
    Object.assign(row, m.snapshotRowForReplay(replay, { score: 0, level: '很差' }));
    for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null;
    Object.assign(row, { event_date_local: dt, idempotency_key: `key_${i}`, location_key, location_source: 'qweather', location_id,
      query_id: `q_${i}`, sunset_time_local: `${dt}T18:30:00+08:00`, prediction_time_epoch: Date.parse(row.prediction_time_utc),
      submitted_at_epoch: Date.parse(`${dt}T04:14:00Z`), submitted_at_utc: `${dt}T04:14:00.000Z`, is_real_sounding: 1,
      replay_sha256: m.hash(bytes), replay_size_bytes: compressed.length, replay_saved_at_utc: `${dt}T04:15:00.000Z`, replay_updated_at_utc: `${dt}T04:15:00.000Z` });
    insert('prediction_snapshots', row);
    for (let j = 0; j < 2; j++) insert('sunset_observations', {
      id: `obs_${i}_${j}`, submission_id: `sub_${i}_${j}`, event_id: eventId, snapshot_id: null,
      ...Object.fromEntries(['event_date_local', 'location_key', 'city', 'country', 'admin1', 'latitude', 'longitude', 'location_source', 'location_id', 'timezone', 'sunset_time_utc', 'sunset_time_local'].map(k => [k, row[k]])),
      submitted_at_utc: `${dt}T11:00:00.000Z`, submitted_at_epoch: Date.parse(`${dt}T11:00:00Z`), rating: 'good', rating_label: (await import('../server/event-dataset.js')).RATING_LABELS.good,
      source: j === 0 ? 'rednote_manual' : 'user', confidence: null, evidence_count: null, dataset_schema_version: 3 });
  }
  const cutoff = '2026-09-14T00:00:00.000Z';
  const source = { async query(sql) { return sql.includes('AS cutoff_epoch') ? [{ cutoff_epoch: Date.parse(cutoff) }] : sqlite.prepare(sql).all().map(x => ({ ...x })); }, async download(row) { return objects.get(row.id); } };
  const raw = await exporter.exportDataset(parser.parseExportArgs(['--from', date(0), '--to', date(2), '--cutoff', cutoff, '--output', path.join(dir, 'raw')]), { source, createdAt: cutoff });
  assert.equal(raw.status, 'EXPORTED', JSON.stringify(raw));
  const gt = await buildGroundTruth(raw.directory, { output: path.join(dir, 'gt') });
  return { m, dir, raw: raw.directory, gt: gt.directory, output: path.join(dir, 'model') };
}
test('Model full-source build, linked validation, dedup, GT V1 support and source omission rejection', async t => {
  const f = await linkedFixture(t), { m } = f;
  const before = { raw: await m.fingerprints(f.raw), gt: await m.fingerprints(f.gt) };
  const p = await m.planModelDataset(f.raw, f.gt); assert.equal(p.status, 'READY');
  const first = await m.buildModelDataset(f.raw, f.gt, { output: f.output }); assert.equal(first.status, 'EXPORTED');
  assert.equal((await m.inspectModelDataset(first.directory, { raw: f.raw, gt: f.gt })).validation_scope, 'SOURCE_LINKED');
  const filesBefore = await m.fingerprints(first.directory);
  const { createProgress } = await import('../tools/progress.mjs');
  let logs = ''; const progress = createProgress({ stream: { isTTY: true, write: s => { logs += s; } }, interval: 0 });
  try { assert.equal((await m.buildModelDataset(f.raw, f.gt, { output: f.output, progress })).status, 'DEDUPLICATED'); } finally { progress.finish('完成'); }
  assert.match(logs, /Snapshot 51\/51/); assert.match(logs, /日期边界搜索/); assert.match(logs, /来源关联/);
  assert.deepEqual(await m.fingerprints(first.directory), filesBefore);
  assert.deepEqual({ raw: await m.fingerprints(f.raw), gt: await m.fingerprints(f.gt) }, before);
  const concurrent = await Promise.all([m.buildModelDataset(f.raw, f.gt, { output: f.output }), m.buildModelDataset(f.raw, f.gt, { output: f.output })]);
  assert.ok(concurrent.every(r => r.status === 'DEDUPLICATED'));
  const zeroPlan = await m.planModelDataset(f.raw, f.gt, { selection: m.selection('missing') });
  assert.equal(zeroPlan.counts.primary_events, 0);
  const insufficientOutput = path.join(f.dir, 'insufficient');
  await assert.rejects(m.buildModelDataset(f.raw, f.gt, { output: insufficientOutput, selection: m.selection('missing') }), /INSUFFICIENT_SPLIT_DATA/);
  await assert.rejects(fs.stat(insufficientOutput), { code: 'ENOENT' });
  for (const [mode, args, exit] of [
    ['plan', ['--raw', f.raw, '--gt', f.gt, '--model-version', 'missing'], 0],
    ['build', ['--raw', f.raw, '--gt', f.gt, '--model-version', 'missing'], 1],
    ['validate', [first.directory, '--raw', f.raw, '--gt', f.gt], 0],
    ['stats', [first.directory, '--quiet'], 0]
  ]) {
    const entry = { plan: 'plan-model-dataset', build: 'build-model-dataset', validate: 'validate-model-dataset', stats: 'model-dataset-stats' }[mode];
    const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools/model-dataset', entry + '.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(cli.status, exit, cli.stdout + cli.stderr); assert.doesNotThrow(() => JSON.parse(cli.stdout));
    if (mode === 'stats') assert.equal(cli.stderr, '');
    else assert.match(cli.stderr, mode === 'build' ? /样本门禁未通过/ : mode === 'plan' ? /预检完成：样本不足/ : /校验 Model/);
  }
  const input = await m.loadInputs(f.raw, f.gt);
  // Omit one original Event while preserving 30/10/10 minima: only source-linking can detect this self-consistent forgery.
  const omitted = input.snapshots[0].event_id;
  const forged = await savePackage(path.join(f.dir, 'forged'), m, m.derive(input.events.filter(e => e.event_id !== omitted),
    input.snapshots.filter(e => e.event_id !== omitted), input.gt.filter(e => e.event_id !== omitted), input.replays.filter(e => e.event_id !== omitted), m.selection(), input.inputSummary), input.source);
  assert.equal((await m.inspectModelDataset(forged.dir)).status, 'PASS');
  await assert.rejects(m.inspectModelDataset(forged.dir, { raw: f.raw, gt: f.gt }), /MODEL_DATASET_VALIDATION_FAILED/);
  const gtInput = await import('../tools/ground-truth/lib/input.mjs'), gtAggregate = await import('../tools/ground-truth/lib/aggregate.mjs'), gtPackage = await import('../tools/ground-truth/lib/package.mjs');
  const gi = await gtInput.loadInput(f.raw), gr = gtAggregate.derive(gi.events, gi.observations), oldFiles = gtPackage.contents(gr, gi.issues, 1);
  const oldManifest = gtPackage.makeManifest(gi.source, gr, oldFiles), oldDir = path.join(f.dir, oldManifest.ground_truth_id);
  await fs.mkdir(path.join(oldDir, 'reports'), { recursive: true });
  for (const [n, b] of Object.entries({ ...oldFiles, 'manifest.json': m.canonicalJson(oldManifest) })) await fs.writeFile(path.join(oldDir, n), b);
  assert.equal((await m.planModelDataset(f.raw, oldDir)).status, 'READY');
  const legacyInput=await m.loadInputs(f.raw,oldDir);
  const legacyResult=m.derive(legacyInput.events,legacyInput.snapshots,legacyInput.gt,legacyInput.replays,m.selection(),legacyInput.inputSummary,1);
  const legacy=await savePackage(path.join(f.dir,'legacy-model'),m,legacyResult,legacyInput.source);
  assert.equal((await m.inspectModelDataset(legacy.dir,{raw:f.raw,gt:oldDir})).validation_scope,'SOURCE_LINKED');
  assert.ok((await m.loadInputs(f.raw,f.gt)).gt.every(e=>e.gt_basis==='ADMIN_ADJUDICATED'));
  const current=await m.inspectModelDataset(first.directory);assert.equal(current.manifest.model_dataset_schema_version,2);
  assert.equal(current.statistics.basis_distribution[0].count,51);
  const moved = path.join(f.dir, 'moved', first.model_dataset_id); await fs.mkdir(path.dirname(moved)); await fs.cp(first.directory, moved, { recursive: true });
  assert.equal((await m.inspectModelDataset(moved)).status, 'PASS');
  const filtered = m.derive(input.events, input.snapshots, input.gt, input.replays, m.selection('2.4.6'), input.inputSummary);
  assert.notEqual(m.makeManifest(input.source, filtered, m.contents(filtered)).model_dataset_id, first.model_dataset_id);
  const replayFile = path.join(f.raw, input.replays[0].local_path), originalReplay = await fs.readFile(replayFile);
  const changingOutput = path.join(f.dir, 'changing');
  const changing = m.buildModelDataset(f.raw, f.gt, { output: changingOutput }).then(() => null, e => e);
  await waitForStaging(changingOutput);
  await fs.writeFile(replayFile, '{}');
  assert.equal((await changing).code, 'SOURCE_CHANGED_DURING_MODEL_BUILD');
  await fs.writeFile(replayFile, originalReplay);
  await assert.rejects(fs.stat(path.join(changingOutput, 'exports')), { code: 'ENOENT' });
  const interruptedOutput = path.join(f.dir, 'interrupted');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools/model-dataset/build-model-dataset.mjs'), '--raw', f.raw, '--gt', f.gt, '--output', interruptedOutput], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await waitForStaging(interruptedOutput); child.kill(); await exited;
  await assert.rejects(fs.stat(path.join(interruptedOutput, 'exports')), { code: 'ENOENT' });
  await fs.writeFile(path.join(first.directory, 'policy.json'), '{}');
  await assert.rejects(m.buildModelDataset(f.raw, f.gt, { output: f.output }), /MODEL_DATASET_ID_CONFLICT/);
  // Raw Replay corruption returns report FAIL rather than throwing; the builder must still stop.
  await fs.writeFile(path.join(f.raw, input.replays[0].local_path), '{}');
  await assert.rejects(m.planModelDataset(f.raw, f.gt), /SOURCE_PACKAGE_INVALID/);
  await assert.rejects(m.recheckInputs(f.raw, f.gt, input.fingerprints), /SOURCE_CHANGED_DURING_MODEL_BUILD/);
  await fs.writeFile(replayFile, originalReplay);
  const manifestPath = path.join(f.raw, 'manifest.json'), alteredManifest = JSON.parse(await fs.readFile(manifestPath));
  alteredManifest.created_at_utc = '2026-09-14T01:00:00.000Z'; await fs.writeFile(manifestPath, m.canonicalJson(alteredManifest));
  await assert.rejects(m.planModelDataset(f.raw, f.gt), /SOURCE_DATASET_MISMATCH/);
});

async function waitForStaging(output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fs.readdir(path.join(output, 'staging'))).length) return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('STAGING_NOT_CREATED');
}
test('Model lock serializes writers, releases on failure, and times out without removing an existing lock', async t => {
  const m = await api(), root = await temp(t), lock = path.join(root, 'package.lock'), order = [];
  await Promise.all([m.withModelLock(lock, async () => { order.push(1); await new Promise(r => setTimeout(r, 50)); order.push(2); }),
    m.withModelLock(lock, async () => { order.push(3); })]);
  assert.ok(JSON.stringify(order) === '[1,2,3]' || JSON.stringify(order) === '[3,1,2]'); // Exclusion, not FIFO scheduling.
  await assert.rejects(m.withModelLock(lock, async () => { throw new Error('WRITE_FAILURE'); }), /WRITE_FAILURE/);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  await fs.mkdir(lock); const start = performance.now();
  await assert.rejects(m.withModelLock(lock, async () => assert.fail('must not acquire')), /MODEL_DATASET_LOCK_BUSY/);
  assert.ok(performance.now() - start >= 9900); assert.ok((await fs.stat(lock)).isDirectory());
});

test('Model V2 carries admin basis, keeps old GT weak, and excludes basis from X', async () => {
  const f=await pure([1]);
  Object.assign(f.gt[0],{gt_basis:'ADMIN_ADJUDICATED',gt_status:'MEDIUM',gt_confidence:.6});
  let result=f.run();assert.equal(result.counts.primary_events,1);assert.equal(result.rows[0].event_normalized_weight,.6);
  assert.equal(result.rows[0].gt_basis,'ADMIN_ADJUDICATED');
  assert.equal(f.m.SAMPLE_FIELDS.find(f=>f.name==='gt_basis').prediction_feature_allowed,false);
  f.snapshots[0].lead_time_minutes=-1;f.snapshots[0].prediction_time_epoch=Date.parse(f.snapshots[0].sunset_time_utc)+60000;
  f.snapshots[0].prediction_time_utc=new Date(f.snapshots[0].prediction_time_epoch).toISOString();
  assert.equal(f.run().rows[0].diagnostic_reason,'POST_SUNSET');
  delete f.gt[0].gt_basis;f.gt[0].gt_status='WEAK';
  result=f.run();assert.equal(result.rows[0].gt_basis,'OBSERVATION_AGGREGATED');assert.equal(result.rows[0].diagnostic_reason,'WEAK_GT');
});
