const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
let modules;
async function api() {
  return modules ||= Promise.all([
    import('../tools/ground-truth/lib/aggregate.mjs'), import('../tools/ground-truth/lib/input.mjs'),
    import('../tools/ground-truth/build-ground-truth.mjs'), import('../tools/ground-truth/validate-ground-truth.mjs'),
    import('../tools/ground-truth/lib/package.mjs'), import('../tools/ground-truth/lib/cli.mjs'),
    import('../tools/dataset/dataset-schema.mjs'), import('../tools/dataset/lib/common.mjs'),
    import('../tools/dataset/lib/csv.mjs'), import('../tools/dataset/build-manifest.mjs'),
    import('../server/event-dataset.js')
  ]).then(xs => Object.assign({}, ...xs));
}
const obs = (rating, i, confidence = null, source = 'user') => ({ id: `obs_${i}`, event_id: 'evt_1', rating, source, confidence, evidence_count: null });
const event = { event_id: 'evt_1', event_date_local: '2026-09-09', city: '深圳' };
test('GT Schema V2 adds Event display columns, detects tampering and preserves V1 validation', async t => {
  const f = await fixture(t), { m } = f;
  f.events[0].city = '深圳,城区'; f.observations[0].city = 'Shenzhen'; await f.save();
  const input = await m.loadInput(f.raw), result = m.derive(input.events, input.observations);
  const current = await m.buildGroundTruth(f.raw, { output: f.output });
  assert.match(current.ground_truth_id, /^gt_v2_/);
  const file = path.join(current.directory, 'observation_contributions.csv');
  const bytes = await fs.readFile(file), schema = JSON.parse(await fs.readFile(path.join(current.directory, 'schema.json')));
  assert.equal(schema.ground_truth_schema_version, 2);
  assert.ok(bytes.toString('utf8').startsWith('\uFEFFevent_id,event_date_local,city,observation_id,'));
  const rows = m.readCsv(schema.tables.observation_contributions, bytes);
  assert.ok(rows.every(r => r.city === '深圳,城区' && r.event_date_local === '2026-09-09'));
  const oldFiles = m.contents(result, input.issues, 1), manifest = m.makeManifest(input.source, result, oldFiles);
  const oldDir = path.join(f.dir, manifest.ground_truth_id); await fs.mkdir(path.join(oldDir, 'reports'), { recursive: true });
  for (const [name, text] of Object.entries({ ...oldFiles, 'manifest.json': m.canonicalJson(manifest) })) await fs.writeFile(path.join(oldDir, name), text);
  assert.match(manifest.ground_truth_id, /^gt_v1_/);
  assert.equal((await m.inspectGroundTruth(oldDir, { source: f.raw })).status, 'PASS');
  const oldStats = (await m.inspectGroundTruth(oldDir)).statistics;
  assert.deepEqual((await m.inspectGroundTruth(current.directory, { source: f.raw })).statistics, oldStats);
  rows[0].city = '错误城市';
  const altered = m.writeCsv(schema.tables.observation_contributions, rows); await fs.writeFile(file, altered);
  const currentManifestPath = path.join(current.directory, 'manifest.json');
  const currentManifest = JSON.parse(await fs.readFile(currentManifestPath));
  Object.assign(currentManifest.files['observation_contributions.csv'], { sha256: m.hash(altered), bytes: Buffer.byteLength(altered) });
  await fs.writeFile(currentManifestPath, m.canonicalJson(currentManifest));
  await assert.rejects(m.inspectGroundTruth(current.directory), /GT_VALIDATION_FAILED/);
});
async function fixture(t, ratings = ['good', 'good'], sources = []) {
  const m = await api(), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-gt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const raw = path.join(dir, 'raw-source'), output = path.join(dir, 'gt'); await fs.mkdir(path.join(raw, 'raw'), { recursive: true });
  const schema = m.datasetSchema(false), key = 'qweather:101280601', id = `evt_v1_${m.hash(key).slice(0, 20)}_2026-09-09`;
  const context = { event_id: id, event_date_local: '2026-09-09', location_key: key, city: '深圳', admin1: '广东', country: '中国',
    latitude: 22.5431, longitude: 114.0579, timezone: 'Asia/Shanghai', sunset_time_utc: '2026-09-09T10:30:00.000Z', sunset_time_local: '2026-09-09T18:30:00+08:00' };
  const events = [{ ...context, snapshot_count: 1, observation_count: ratings.length, replay_count: 1,
    first_prediction_time_utc: '2026-09-09T04:13:00.000Z', last_prediction_time_utc: '2026-09-09T04:13:00.000Z',
    max_lead_time_minutes: 377, min_lead_time_minutes: 377, has_snapshot: true, has_observation: !!ratings.length, has_replay: true }];
  const observations = ratings.map((rating, i) => ({ ...context, id: `obs_${i}`, submission_id: `sub_${i}`, snapshot_id: null,
    location_source: 'qweather', location_id: '101280601', submitted_at_utc: '2026-09-09T11:00:00.000Z', submitted_at_epoch: Date.parse('2026-09-09T11:00:00Z'),
    rating, rating_label: m.RATING_LABELS[rating], source: sources[i] || 'user', confidence: null, evidence_count: null, dataset_schema_version: 3 }));
  const selection = { event_date_from: '2026-09-09', event_date_to: '2026-09-09', cities: null, model_versions: null,
    snapshot_sources: null, scheduled_slots: null, observation_sources: null, include_comments: false };
  const cutoff = Date.parse('2026-09-10T00:00:00.000Z');
  async function save() {
    const bytes = { 'schema.json': m.canonicalJson(schema), 'raw/events.csv': m.writeCsv(schema.tables.events, events),
      'raw/sunset_observations.csv': m.writeCsv(schema.tables.sunset_observations, observations) };
    const files = Object.fromEntries(m.REGISTERED_FILES.map(f => [f, { sha256: m.hash(bytes[f] || ''), bytes: Buffer.byteLength(bytes[f] || '') }]));
    for (const f of m.RAW_FILES) files[f].rows = f === 'raw/events.csv' ? events.length : f === 'raw/sunset_observations.csv' ? observations.length : 1;
    const descriptor = m.makeDescriptor(selection, cutoff, files, []);
    const manifest = { offline_dataset_schema_version: 1, consistency_policy: m.CONSISTENCY_POLICY, selection,
      ...m.descriptorIdentity(descriptor), descriptor, replay_set_sha256: descriptor.replay_set_sha256,
      export_cutoff_epoch: cutoff, export_cutoff_utc: new Date(cutoff).toISOString(), created_at_utc: new Date(cutoff).toISOString(),
      counts: { events: events.length, observations: observations.length }, files };
    for (const [f, text] of Object.entries({ ...bytes, 'manifest.json': m.canonicalJson(manifest) })) await fs.writeFile(path.join(raw, f), text);
    return manifest;
  }
  await save(); return { m, dir, raw, output, events, observations, save };
}

test('GT golden labels, lower ties, MAD, support and confidence are fixed', async () => {
  const m = await api();
  for (const [ratings, label, status, n, confidence] of [
    [[], null, 'UNLABELED', 0, 0], [['good'], 'good', 'WEAK', 1, .333333333333],
    [['good', 'good'], 'good', 'STRONG', 2, .666666666667], [['good', 'good', 'good'], 'good', 'STRONG', 3, 1],
    [['good', 'very_good'], 'good', 'MEDIUM', 2, undefined], [['poor', 'excellent'], 'poor', 'DISPUTED', 2, undefined],
    [['poor', 'good', 'excellent'], 'good', 'DISPUTED', 3, undefined]
  ]) {
    const r = m.derive([event], ratings.map((x, i) => obs(x, i))).gt[0];
    assert.equal(r.gt_label, label); assert.equal(r.gt_status, status); assert.equal(r.effective_n, n);
    if (confidence !== undefined) assert.equal(r.gt_confidence, confidence);
  }
  const r = m.derive([event], [obs('poor', 0), obs('good', 1), obs('excellent', 2)]).gt[0];
  assert.equal(r.ordinal_mad, 2); assert.equal(r.consensus_ratio, .333333333333);
  assert.equal(m.derive([event], [obs('good', 0), obs('very_good', 1)]).gt[0].ordinal_mad, 0);
  const five = m.derive([event], ['poor', 'fair', 'good', 'very_good', 'excellent'].map((x, i) => obs(x, i))).gt[0];
  assert.equal(five.normalized_entropy, 1); assert.equal(five.gt_ordinal, 2);
});

test('GT confidence weights, effective n, boundaries and evidence audit only', async () => {
  const m = await api(), rows = [obs('good', 0, 1), obs('good', 1, 0)];
  const r = m.derive([event], rows);
  assert.equal(r.gt[0].effective_n, 1.96); assert.equal(r.gt[0].gt_status, 'MEDIUM');
  assert.deepEqual(r.contributions.map(x => x.effective_weight), [1, .75]);
  assert.deepEqual(m.derive([event], rows.map(x => ({ ...x, evidence_count: 9999 }))).gt, r.gt);
  assert.equal(m.statusFor(3, 1.2, .8, 3), 'DISPUTED');
  assert.equal(m.statusFor(4, 4, .75, 1), 'STRONG');
  assert.equal(m.statusFor(2, 2, .5, 1), 'MEDIUM');
  assert.equal(m.statusFor(2, 1.5, .5, 1), 'MEDIUM');
  assert.equal(m.statusFor(2, 1.499999999999, .5, 1), 'WEAK');
  for (const c of [-.01, 1.01, NaN, Infinity, undefined]) assert.throws(() => m.contribution({ ...obs('good', 0), confidence: c }), /RAW_INPUT_INVALID/);
  for (const evidence_count of [-1, 10001, .5]) assert.throws(() => m.contribution({ ...obs('good', 0), evidence_count }), /RAW_INPUT_INVALID/);
});

test('GT source pairing is one event per pair and preserves signed and absolute differences', async () => {
  const m = await api();
  const events = [event, { ...event, event_id: 'evt_2' }];
  const rows = [obs('poor', 0), obs('poor', 1), obs('excellent', 2, null, 'rednote_agent'),
    { ...obs('excellent', 3), event_id: 'evt_2' }, { ...obs('poor', 4, null, 'rednote_agent'), event_id: 'evt_2' }];
  const r = m.derive(events, rows);
  assert.deepEqual(r.agreement[0], { source_a: 'user', source_b: 'rednote_agent', paired_event_count: 2,
    exact_agreement_rate: 0, within_1_level_rate: 0, mean_ordinal_difference: 0, mean_absolute_ordinal_difference: 4 });
  assert.equal(r.agreement[1].paired_event_count, 0); assert.equal(r.agreement[1].exact_agreement_rate, null);
  assert.deepEqual(m.derive([...events].reverse(), [...rows].reverse()), r);
});

test('GT reads only four Raw files, publishes, validates both scopes, deduplicates and copies offline', async t => {
  const f = await fixture(t), { m } = f;
  // No Prediction, Replay, or Raw report file exists; full Raw inspection could not pass.
  const fingerprints = (await m.loadInput(f.raw)).fingerprints;
  const a = await m.buildGroundTruth(f.raw, { output: f.output }); assert.equal(a.status, 'EXPORTED');
  const original = await fs.readFile(path.join(a.directory, 'manifest.json'));
  assert.equal((await m.inspectGroundTruth(a.directory)).validation_scope, 'PACKAGE_INTERNAL');
  assert.equal((await m.inspectGroundTruth(a.directory, { source: f.raw })).validation_scope, 'SOURCE_LINKED');
  const b = await m.buildGroundTruth(f.raw, { output: f.output }); assert.equal(b.status, 'DEDUPLICATED'); assert.equal(b.ground_truth_id, a.ground_truth_id);
  assert.deepEqual(await fs.readFile(path.join(a.directory, 'manifest.json')), original);
  assert.deepEqual((await m.loadInput(f.raw)).fingerprints, fingerprints);
  const copy = path.join(f.dir, 'copy', a.ground_truth_id); await fs.cp(a.directory, copy, { recursive: true });
  assert.equal((await m.inspectGroundTruth(copy)).status, 'PASS');
  await assert.rejects(m.inspectGroundTruth(copy, { requireSource: true }), /SOURCE_DATASET_REQUIRED/);
  const other = await m.buildGroundTruth(f.raw, { output: path.join(f.dir, 'other') }); assert.equal(other.ground_truth_id, a.ground_truth_id);
});

test('GT detects invalid source identity, duplicate observation/submission, orphan and cutoff', async t => {
  const f = await fixture(t), { m } = f, original = structuredClone(f.observations);
  for (const [change, code] of [
    [rows => { rows[1].id = rows[0].id; }, 'DUPLICATE_OBSERVATION_ID'],
    [rows => { rows[1].submission_id = rows[0].submission_id; }, 'DUPLICATE_SUBMISSION_ID'],
    [rows => { rows[1].event_id = 'evt_orphan'; }, 'OBSERVATION_EVENT_MISSING'],
    [rows => { rows[0].submitted_at_epoch++; }, 'RAW_INPUT_INVALID']
  ]) {
    f.observations.splice(0, f.observations.length, ...structuredClone(original)); change(f.observations); await f.save();
    await assert.rejects(m.loadInput(f.raw), new RegExp(code));
  }
});

test('GT source tampering, extra package files, policy changes and output-in-source fail closed', async t => {
  const f = await fixture(t), { m } = f;
  await assert.rejects(m.buildGroundTruth(f.raw, { output: path.join(f.raw, 'gt') }), /OUTPUT_DIRECTORY_INSIDE_DATASET/);
  const a = await m.buildGroundTruth(f.raw, { output: f.output });
  await fs.writeFile(path.join(a.directory, 'extra'), 'x');
  await assert.rejects(m.inspectGroundTruth(a.directory), /GT_VALIDATION_FAILED/);
  await assert.rejects(m.buildGroundTruth(f.raw, { output: f.output }), /GROUND_TRUTH_ID_CONFLICT/);
  await fs.unlink(path.join(a.directory, 'extra'));
  const before = (await m.loadInput(f.raw)).fingerprints;
  await fs.appendFile(path.join(f.raw, 'raw/events.csv'), 'broken');
  await assert.rejects(m.recheckInput(f.raw, before), /SOURCE_CHANGED_DURING_GT_BUILD/);
  await assert.rejects(m.loadInput(f.raw), /SOURCE_FILE_HASH_MISMATCH/);
});

test('GT source-linked validation catches internally consistent replacement of contributions', async t => {
  const f = await fixture(t), { m } = f, input = await m.loadInput(f.raw);
  const replaced = m.derive(input.events, input.observations.map(o => ({ ...o, rating: 'poor' })));
  const files = m.contents(replaced), manifest = m.makeManifest(input.source, replaced, files);
  const dir = path.join(f.dir, manifest.ground_truth_id); await fs.mkdir(path.join(dir, 'reports'), { recursive: true });
  for (const [name, text] of Object.entries({ ...files, 'manifest.json': m.canonicalJson(manifest) })) await fs.writeFile(path.join(dir, name), text);
  assert.equal((await m.inspectGroundTruth(dir)).status, 'PASS');
  await assert.rejects(m.inspectGroundTruth(dir, { source: f.raw }), /GT_VALIDATION_FAILED/);
});

test('GT parallel publishers serialize and return EXPORTED plus DEDUPLICATED', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.m.buildGroundTruth(f.raw, { output: f.output }), f.m.buildGroundTruth(f.raw, { output: f.output })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['DEDUPLICATED', 'EXPORTED']);
  assert.equal(results[0].ground_truth_id, results[1].ground_truth_id);
});

test('GT zero observations, source display warnings and CLI report safety', async t => {
  const f = await fixture(t, []), { m } = f;
  const a = await m.buildGroundTruth(f.raw, { output: f.output });
  const result = await m.inspectGroundTruth(a.directory, { source: f.raw });
  assert.equal(result.statistics.unlabeled_events, 1); assert.equal(result.statistics.gt_confidence.labeled_events.mean, null);
  const script = path.join(__dirname, '../tools/ground-truth/validate-ground-truth.mjs');
  const child = spawnSync(process.execPath, [script, a.directory, '--source', f.raw, '--report-dir', path.join(f.raw, 'new')], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.match(child.stdout, /REPORT_DIRECTORY_INSIDE_DATASET/);
  assert.throws(() => m.parseArgs(['x', '--source', 'a', '--source', 'b'], 'validate'), /INVALID_ARGUMENTS/);
  assert.throws(() => m.parseArgs(['x', '--policy', 'anything'], 'build'), /INVALID_ARGUMENTS/);
});

test('GT source display variants are audited without influencing label and statistics', async t => {
  const f = await fixture(t), { m } = f;
  f.observations[0].city = 'Shenzhen'; await f.save();
  const a = await m.buildGroundTruth(f.raw, { output: f.output });
  const r = await m.inspectGroundTruth(a.directory, { source: f.raw });
  assert.equal(r.statistics.status_counts.STRONG, 1);
  assert.match(await fs.readFile(path.join(a.directory, 'reports/errors.csv'), 'utf8'), /EVENT_DISPLAY_CONTEXT_VARIANT/);
});

test('GT fixed canonical byte vectors are identical across supported operating systems', async () => {
  const m = await api();
  const rows = ['poor', 'fair', 'good', 'very_good', 'excellent'].map((rating, i) => ({
    ...obs(rating, i, [null, 0, 1, .1234567890123, .5][i], ['user', 'rednote_agent', 'rednote_manual'][i % 3]), evidence_count: i }));
  const files = m.contents(m.derive([event], rows), [], 1);
  // Byte contract snapshots complement the independent, hand-derived algorithm assertions above.
  assert.deepEqual(Object.fromEntries(Object.entries(files).map(([f, s]) => [f, m.hash(s)])), {
    'schema.json': 'c1a98854d6da630dd9c88d5f5b0c3fe54e36121bd079daf16a082452aed1cdd2',
    'policy.json': '228cfd3288b96a7dfcdce73db4cb8517f2fcd8671488c2c4b09e01217984f31b',
    'event_ground_truth.csv': '290232faea56cb1de6cea7cb06e7ef148c22ee236f2811cede410c7b89ce4ff2',
    'observation_contributions.csv': '527d083d2a8ddd5f56954ec3c9fd0b2ba9f1b24585d0c8b6a05a7aeb1b50c629',
    'reports/statistics.json': '6ec7d044c99fadc3708a54b36ab1a4bc7a031bf88ec9ce720deb97b669cec8be',
    'reports/source-agreement.json': 'd266ccd6a2bf6d2213a25b0957fdfe7483ad4cd566cb46d1d45c74f6171fc8a4',
    'reports/errors.csv': '7a36e545df4313927e304a635380a74722b5d99231c3bd375a11eee271f94362'
  });
});

function childScript(f, body) {
  const { pathToFileURL } = require('node:url');
  const builder = pathToFileURL(path.join(__dirname, '../tools/ground-truth/build-ground-truth.mjs')).href;
  const validator = pathToFileURL(path.join(__dirname, '../tools/ground-truth/validate-ground-truth.mjs')).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const raw=${JSON.stringify(f.raw)}, output=${JSON.stringify(f.output)};
    ${body}
  `], { encoding: 'utf8', env: { ...process.env, GT_TEST_BUILDER: builder, GT_TEST_VALIDATOR: validator }, timeout: 30000 });
}

test('GT I/O guard records four-file whitelist and disallows networking or subprocesses', async t => {
  const f = await fixture(t);
  const child = childScript(f, `
    const read=fs.readFile, seen=new Set(), allowed=new Set(['manifest.json','schema.json','raw/events.csv','raw/sunset_observations.csv']);
    fs.readFile=async function(file,...args){const rel=path.relative(raw,String(file)).split(path.sep).join('/');
      if(!rel.startsWith('../') && !path.isAbsolute(rel)){if(!allowed.has(rel)) throw Error('FORBIDDEN_READ');seen.add(rel);}
      return read.call(this,file,...args);};
    globalThis.fetch=()=>{throw Error('FORBIDDEN_NETWORK');};
    const cp=await import('node:child_process');cp.default.spawn=()=>{throw Error('FORBIDDEN_PROCESS');};
    cp.default.spawnSync=()=>{throw Error('FORBIDDEN_PROCESS');};syncBuiltinESMExports();
    const {buildGroundTruth}=await import(process.env.GT_TEST_BUILDER);
    const r=await buildGroundTruth(raw,{output});
    const {inspectGroundTruth}=await import(process.env.GT_TEST_VALIDATOR);await inspectGroundTruth(r.directory,{source:raw});
    console.log(JSON.stringify([...seen].sort()));
  `);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['manifest.json', 'raw/events.csv', 'raw/sunset_observations.csv', 'schema.json']);
});

test('GT detects source changes during build and retains only staging diagnostics', async t => {
  const f = await fixture(t);
  const child = childScript(f, `
    const write=fs.writeFile;let changed=false;
    fs.writeFile=async function(file,...args){const r=await write.call(this,file,...args);
      if(!changed && String(file).endsWith('event_ground_truth.csv')){changed=true;await fs.appendFile(path.join(raw,'raw/events.csv'),'broken');}return r;};
    syncBuiltinESMExports();const {buildGroundTruth}=await import(process.env.GT_TEST_BUILDER);
    try{await buildGroundTruth(raw,{output});process.exit(2);}catch(e){console.log(e.code);}
  `);
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /SOURCE_CHANGED_DURING_GT_BUILD/);
  assert.equal(await fs.stat(path.join(f.output, 'exports')).then(() => true, () => false), false);
});

test('GT interrupted rename never exposes a half-published package and does not delete abandoned lock', async t => {
  const f = await fixture(t);
  const child = childScript(f, `
    fs.rename=async()=>{process.exit(17);};syncBuiltinESMExports();
    const {buildGroundTruth}=await import(process.env.GT_TEST_BUILDER);await buildGroundTruth(raw,{output});
  `);
  assert.equal(child.status, 17, child.stderr);
  const entries = await fs.readdir(path.join(f.output, 'exports'));
  assert.equal(entries.length, 1); assert.ok(entries[0].endsWith('.lock'));
  const staged = await fs.readdir(path.join(f.output, 'staging')); assert.equal(staged.length, 1);
});

test('GT lock timeout is explicit and preserves owner lock', async t => {
  const f = await fixture(t), input = await f.m.loadInput(f.raw), r = f.m.derive(input.events, input.observations);
  const manifest = f.m.makeManifest(input.source, r, f.m.contents(r));
  const lock = path.join(f.output, 'exports', manifest.ground_truth_id + '.lock'); await fs.mkdir(lock, { recursive: true });
  await assert.rejects(f.m.buildGroundTruth(f.raw, { output: f.output }), /GROUND_TRUTH_LOCK_BUSY/);
  assert.ok((await fs.stat(lock)).isDirectory());
});

test('GT rejects changed policy even with repaired hashes and invalid source enums', async t => {
  const f = await fixture(t), { m } = f;
  const a = await m.buildGroundTruth(f.raw, { output: f.output });
  const policyPath = path.join(a.directory, 'policy.json'), manifestPath = path.join(a.directory, 'manifest.json');
  const policy = JSON.parse(await fs.readFile(policyPath, 'utf8')); policy.source_weights.user = .9;
  const text = m.canonicalJson(policy); await fs.writeFile(policyPath, text);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files['policy.json'] = { sha256: m.hash(text), bytes: Buffer.byteLength(text) }; await fs.writeFile(manifestPath, m.canonicalJson(manifest));
  await assert.rejects(m.inspectGroundTruth(a.directory), /UNSUPPORTED_GT_POLICY/);
  // Bypass CSV writer only to model a malformed input, then repair manifest hashes via a raw edit.
  const csvPath = path.join(f.raw, 'raw/sunset_observations.csv'), rawManifestPath = path.join(f.raw, 'manifest.json');
  const csv = (await fs.readFile(csvPath, 'utf8')).replace(',good,', ',unknown,'); await fs.writeFile(csvPath, csv);
  const rm = JSON.parse(await fs.readFile(rawManifestPath, 'utf8'));
  rm.files['raw/sunset_observations.csv'].sha256 = m.hash(csv); rm.files['raw/sunset_observations.csv'].bytes = Buffer.byteLength(csv);
  rm.descriptor.raw_files['raw/sunset_observations.csv'] = m.hash(csv); Object.assign(rm, m.descriptorIdentity(rm.descriptor));
  await fs.writeFile(rawManifestPath, m.canonicalJson(rm)); await assert.rejects(m.loadInput(f.raw), /FIELD_INVALID/);
});

test('GT full validation rejects an internally consistent package omitting an unlabeled source event', async t => {
  const f = await fixture(t), { m } = f;
  const location = 'qweather:101020100';
  f.events.push({ ...f.events[0], event_id: `evt_v1_${m.hash(location).slice(0, 20)}_2026-09-09`, location_key: location,
    city: '上海', observation_count: 0, has_observation: false });
  await f.save(); const input = await m.loadInput(f.raw), r = m.derive(input.events.slice(0, 1), input.observations);
  const files = m.contents(r), manifest = m.makeManifest(input.source, r, files);
  const dir = path.join(f.dir, manifest.ground_truth_id); await fs.mkdir(path.join(dir, 'reports'), { recursive: true });
  for (const [name, text] of Object.entries({ ...files, 'manifest.json': m.canonicalJson(manifest) })) await fs.writeFile(path.join(dir, name), text);
  assert.equal((await m.inspectGroundTruth(dir)).status, 'PASS');
  await assert.rejects(m.inspectGroundTruth(dir, { source: f.raw }), /GT_VALIDATION_FAILED/);
});

test('GT write failure retains sanitized diagnostics and never publishes', async t => {
  const f = await fixture(t);
  const child = childScript(f, `
    const write=fs.writeFile;fs.writeFile=async function(file,...args){
      if(String(file).endsWith('event_ground_truth.csv'))throw Object.assign(Error('private text must not escape'),{code:'ENOSPC'});
      return write.call(this,file,...args);};syncBuiltinESMExports();
    const {buildGroundTruth}=await import(process.env.GT_TEST_BUILDER);
    try{await buildGroundTruth(raw,{output});process.exit(2);}catch(e){console.log(e.code);}
  `);
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /ENOSPC/);
  const [run] = await fs.readdir(path.join(f.output, 'staging'));
  const report = await fs.readFile(path.join(f.output, 'staging', run, 'failure.json'), 'utf8');
  assert.equal(JSON.parse(report).error_code, 'ENOSPC'); assert.doesNotMatch(report, /private text/);
  assert.equal(await fs.stat(path.join(f.output, 'exports')).then(() => true, () => false), false);
});

test('GT rejects a staging junction before any write into Raw input', async t => {
  const f = await fixture(t), before = await fs.readdir(f.raw); await fs.mkdir(f.output);
  try { await fs.symlink(f.raw, path.join(f.output, 'staging'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Host does not permit creating links'); return; } throw e; }
  await assert.rejects(f.m.buildGroundTruth(f.raw, { output: f.output }), /UNSAFE_PATH/);
  assert.deepEqual(await fs.readdir(f.raw), before);
});
