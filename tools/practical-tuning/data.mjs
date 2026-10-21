import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, hash, fail, readSafe, safePath, within, inventory, compare } from '../dataset/lib/common.mjs';
import { readCsv, parseCsv } from '../dataset/lib/csv.mjs';
import { modelSchema } from '../model-dataset/model-dataset-schema.mjs';
import { groundTruthSchema } from '../ground-truth/ground-truth-schema.mjs';
import { LABEL_TO_ORDINAL } from '../evaluation/metrics.mjs';
import { REPLAY_RUNTIME_FILES } from '../replay/replay-runner.mjs';
import { digest, POLICY } from './policy.mjs';
export const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
export async function codeIdentity() {
  // Fingerprints only: no Runtime archive, Campaign, or evidence package is required.
  const files = {};
  for (const family of ['js', 'server', 'tools']) for (const name of await inventory(path.join(APP_ROOT, family))) {
    if (/\.(?:mjs|js|cjs)$/.test(name)) files[`${family}/${name}`] = hash(await readSafe(path.join(APP_ROOT, family, name)));
  }
  files['package.json'] = hash(await readSafe(path.join(APP_ROOT, 'package.json')));
  let git = { available: false };
  try {
    const [head, state] = await Promise.all([exec('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, windowsHide: true }),
      exec('git', ['status', '--porcelain'], { cwd: APP_ROOT, windowsHide: true })]);
    git = { available: true, head: head.stdout.trim(), dirty: Boolean(state.stdout.trim()), status_sha256: hash(state.stdout) };
  } catch { /* A source checkout without Git remains executable. */ }
  return { files, sha256: digest(files), engine_sha256: digest(Object.fromEntries(REPLAY_RUNTIME_FILES.map(f => [f, files[f]]))),
    policy_sha256: digest(POLICY), node_version: process.version, git };
}
const csvObjects = bytes => {
  const rows = parseCsv(bytes.toString('utf8')), names = rows.shift().map(c => c.value);
  if (new Set(names).size !== names.length || rows.some(r => r.length !== names.length)) fail('CSV_COLUMNS_INVALID');
  return rows.map(r => Object.fromEntries(names.map((k, i) => [k, r[i].value])));
};
export function mergeRows(partitions) {
  const bySnapshot = new Map(), byEvent = new Map(); let duplicates = 0;
  for (const { split, rows } of partitions) for (const row of rows) {
    if (row.split !== split) fail('PRACTICAL_PARTITION_MISMATCH');
    const { split: ignored, event_normalized_weight, ...content } = row;
    const old = bySnapshot.get(row.snapshot_id);
    if (old) {
      const { historical_splits, ...oldContent } = old;
      if (digest(content) !== digest(oldContent)) fail('CONFLICTING_DUPLICATE_SNAPSHOT');
      old.historical_splits = [...new Set([...historical_splits, split])].sort(compare); duplicates++; continue;
    }
    const event = byEvent.get(row.event_id);
    if (event && ['gt_label', 'gt_ordinal', 'gt_confidence', 'gt_status', 'gt_basis', 'event_date_local', 'location_key'].some(k => event[k] !== row[k])) fail('CONFLICTING_EVENT_LABEL');
    byEvent.set(row.event_id, row); bySnapshot.set(row.snapshot_id, { ...content, historical_splits: [split] });
  }
  return { rows: [...bySnapshot.values()].sort((a, b) => compare(a.snapshot_id, b.snapshot_id)), duplicates };
}
export async function loadPool({ raw, gt, model }, progress = () => {}) {
  const roots = { raw: await safePath(raw), gt: await safePath(gt), model: await safePath(model) }, fingerprints = {};
  const read = async (source, relative, expected) => {
    const bytes = await readSafe(path.join(roots[source], relative)), sha = hash(bytes);
    if (expected && sha !== expected) fail('SOURCE_FILE_HASH_MISMATCH', { detail: `${source}/${relative}` });
    fingerprints[`${source}/${relative}`] = sha; return bytes;
  };
  const manifests = {};
  for (const key of Object.keys(roots)) manifests[key] = JSON.parse(await read(key, 'manifest.json'));
  const { raw: rm, gt: gm, model: mm } = manifests;
  if (gm.source_dataset_id !== rm.dataset_id || mm.source_dataset_id !== rm.dataset_id || mm.ground_truth_id !== gm.ground_truth_id) fail('PRACTICAL_SOURCE_MISMATCH');
  const expected = (m, f) => { const h = m.files?.[f]?.sha256; if (!h) fail('SOURCE_FILE_UNDECLARED', { detail: f }); return h; };
  if (mm.descriptor?.ground_truth_manifest_sha256 !== fingerprints['gt/manifest.json'] ||
      mm.descriptor?.source_dataset_manifest_sha256 !== fingerprints['raw/manifest.json']) fail('PRACTICAL_SOURCE_MISMATCH');
  const partitions = [];
  for (const split of ['TRAIN', 'VALIDATION', 'TEST']) {
    const file = `splits/${split.toLowerCase()}.csv`;
    partitions.push({ split, rows: readCsv(modelSchema(mm.model_dataset_schema_version).tables.samples, await read('model', file, expected(mm, file))) });
  }
  const merged = mergeRows(partitions);
  const gtRows = readCsv(groundTruthSchema(gm.ground_truth_schema_version).tables.event_ground_truth,
    await read('gt', 'event_ground_truth.csv', expected(gm, 'event_ground_truth.csv')));
  const uniqueIndex = (rows, key) => { const map = new Map(); for (const r of rows) { if (map.has(r[key])) fail('SOURCE_DUPLICATE_ID'); map.set(r[key], r); } return map; };
  const truths = uniqueIndex(gtRows, 'event_id');
  const snapshots = uniqueIndex(csvObjects(await read('raw', 'raw/prediction_snapshots.csv', expected(rm, 'raw/prediction_snapshots.csv'))), 'id');
  const index = uniqueIndex(csvObjects(await read('raw', 'raw/replay_index.csv', expected(rm, 'raw/replay_index.csv'))), 'snapshot_id');
  const rows = [], exclusions = [];
  for (const row of merged.rows) {
    const truth = truths.get(row.event_id), snapshot = snapshots.get(row.snapshot_id);
    if (!truth || !snapshot || snapshot.event_id !== row.event_id || snapshot.event_date_local !== row.event_date_local || snapshot.location_key !== row.location_key) fail('PRACTICAL_MEMBER_MISMATCH');
    if (['gt_label', 'gt_ordinal', 'gt_confidence', 'gt_status'].some(k => truth[k] !== row[k]) ||
        (truth.gt_basis != null && truth.gt_basis !== row.gt_basis)) fail('PRACTICAL_GT_MISMATCH');
    if (row.eligibility !== 'PRIMARY' || !['STRONG', 'MEDIUM'].includes(row.gt_status) ||
        LABEL_TO_ORDINAL[row.gt_label] !== row.gt_ordinal || !(row.gt_confidence > 0)) {
      exclusions.push({ snapshot_id: row.snapshot_id, event_id: row.event_id, historical_splits: row.historical_splits, reason_code: 'NOT_LABELED_PRIMARY' }); continue;
    }
    try {
      const entry = index.get(row.snapshot_id);
      if (!entry || entry.local_path !== row.replay_path || entry.event_id !== row.event_id) fail('REPLAY_INDEX_MISMATCH');
      const file = await safePath(path.resolve(roots.raw, row.replay_path));
      if (!within(roots.raw, file)) fail('UNSAFE_PATH');
      const bytes = await read('raw', row.replay_path, entry.replay_sha256), replay = JSON.parse(bytes);
      if (replay.replay_schema_version !== 1 || ['snapshot_id', 'event_id', 'config_hash', 'engine_build_sha', 'prediction_time_utc'].some(k => replay.identity?.[k] !== row[k])) fail('REPLAY_IDENTITY_MISMATCH');
      rows.push({ ...row, replay, input_sha256: hash(bytes) });
    } catch (e) {
      if (e.code === 'UNSAFE_PATH') throw e;
      exclusions.push({ snapshot_id: row.snapshot_id, event_id: row.event_id, historical_splits: row.historical_splits,
        reason_code: 'REPLAY_UNAVAILABLE', detail: /^[A-Z_]+$/.test(e.code ?? '') ? e.code : 'INVALID_REPLAY_INPUT' });
    }
  }
  progress(`开发池来源 TRAIN=${partitions[0].rows.length}, VALIDATION=${partitions[1].rows.length}, TEST=${partitions[2].rows.length}；预检 ${rows.length} 条 Replay`);
  return { roots, rows, exclusions, fingerprints, duplicate_count: merged.duplicates,
    source_ids: { raw: rm.dataset_id, gt: gm.ground_truth_id, model: mm.model_dataset_id },
    historical_partitions: Object.fromEntries(partitions.map(p => [p.split, p.rows.length])) };
}
export async function checkInputs(loaded) {
  for (const [key, expected] of Object.entries(loaded.fingerprints)) {
    const at = key.indexOf('/'), source = key.slice(0, at), file = key.slice(at + 1);
    if (hash(await readSafe(path.join(loaded.roots[source], file))) !== expected) fail('SOURCE_CHANGED_DURING_RUN');
  }
}
