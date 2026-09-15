#!/usr/bin/env node
import path from 'node:path';
import { readSafe, inventory, hash, canonicalJson, compare, fail, errorCode, isMain } from '../dataset/lib/common.mjs';
import { canonicalUtc } from '../dataset/dataset-schema.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { modelSchema, RAW_FIELDS } from './model-dataset-schema.mjs';
import { modelPolicy } from './model-dataset-policy.mjs';
import { equal, derive } from './lib/core.mjs';
import { loadInputs } from './lib/input.mjs';
import { FILES, contents, makeManifest } from './lib/package.mjs';
import { runCli } from './lib/cli.mjs';
export const parseJson = bytes => {
  const result = JSON.parse(bytes.toString('utf8'));
  if (!Buffer.from(canonicalJson(result)).equals(bytes)) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL' });
  return result;
};
const sourceKeys = ['source_dataset_id', 'ground_truth_id', 'source_dataset_manifest_sha256', 'ground_truth_manifest_sha256', 'source_descriptor_sha256', 'ground_truth_descriptor_sha256', 'source_versions'];
export async function inspectModelDataset(directory, options = {}) {
  try { return await inspect(directory, options); }
  catch (error) {
    if (['SOURCE_PACKAGE_INVALID', 'SOURCE_DATASET_MISMATCH', 'UNSAFE_PATH', 'UNSUPPORTED_MODEL_DATASET_SCHEMA', 'UNSUPPORTED_MODEL_DATASET_POLICY', 'INVALID_ARGUMENTS', 'MODEL_DATASET_VALIDATION_FAILED'].includes(errorCode(error))) throw error;
    fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: errorCode(error) });
  }
}
async function inspect(directory, options) {
  if (!!options.raw !== !!options.gt) fail('INVALID_ARGUMENTS');
  const manifest = parseJson(await readSafe(path.join(directory, 'manifest.json')));
  const version = manifest.model_dataset_schema_version, schema = modelSchema(version), policy = modelPolicy(manifest.model_dataset_policy_version);
  if (manifest.model_dataset_policy_version !== version) fail('UNSUPPORTED_MODEL_DATASET_POLICY');
  equal(Object.keys(manifest.files).sort(compare), [...FILES].sort(compare), 'FILES');
  equal(await inventory(directory), [...FILES, 'manifest.json'].sort(compare), 'INVENTORY');
  const files = {};
  for (const f of FILES) {
    const bytes = await readSafe(path.join(directory, f));
    if (hash(bytes) !== manifest.files[f].sha256 || bytes.length !== manifest.files[f].bytes) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'FILE_HASH' });
    files[f] = bytes;
  }
  equal(parseJson(files['schema.json']), schema, 'SCHEMA');
  equal(parseJson(files['policy.json']), policy, 'POLICY');
  const rows = ['model_samples.csv', 'diagnostic_samples.csv', 'excluded_samples.csv'].flatMap(f => readCsv(schema.tables.samples, files[f]));
  const events = readCsv(schema.tables.event_splits, files['event_splits.csv']);
  const stats = parseJson(files['reports/statistics.json']), summary = stats.input_validation_summary;
  equal(Object.keys(summary).sort(), ['gt', 'raw']);
  equal(summary.gt, { status: 'PASS', validation_scope: 'SOURCE_LINKED' });
  equal(Object.keys(summary.raw).sort(), ['ERROR', 'INFO', 'WARNING']);
  if (summary.raw.ERROR !== 0 || Object.values(summary.raw).some(x => !Number.isSafeInteger(x) || x < 0)) fail('MODEL_DATASET_VALIDATION_FAILED');
  const snapshots = rows.map(r => Object.fromEntries(RAW_FIELDS.map(f => [f.name === 'snapshot_id' ? 'id' : f.name, r[f.name]])));
  const replay = rows.map(r => ({ snapshot_id: r.snapshot_id, event_id: r.event_id, engine_build_sha: r.engine_build_sha, config_hash: r.config_hash, local_path: r.replay_path }));
  const result = derive(events, snapshots, events, replay, manifest.selection, summary, version);
  if (!result.plan.publishable) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'INSUFFICIENT_SPLIT_DATA' });
  const rebuiltFiles = contents(result);
  for (const f of FILES) if (!files[f].equals(Buffer.from(rebuiltFiles[f]))) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'RECOMPUTED_FILE_MISMATCH' });
  const source = Object.fromEntries(sourceKeys.map(k => [k, manifest[k]]));
  for (const key of sourceKeys.filter(k => k.endsWith('sha256'))) if (!/^[a-f0-9]{64}$/.test(source[key])) fail('MODEL_DATASET_VALIDATION_FAILED');
  const v = source.source_versions;
  if (!v || !policy.source_versions.raw_schema.includes(v.raw_schema) || !policy.source_versions.gt_schema.includes(v.gt_schema) || !policy.source_versions.gt_policy.includes(v.gt_policy) ||
    !/^raw_v1_\d{8}_\d{8}_[a-f0-9]{12}$/.test(source.source_dataset_id) || !source.source_dataset_id.endsWith(source.source_descriptor_sha256.slice(0, 12)) ||
    source.ground_truth_id !== `gt_v${v.gt_schema}_${source.source_descriptor_sha256.slice(0, 12)}_${source.ground_truth_descriptor_sha256.slice(0, 12)}` ||
    !canonicalUtc(manifest.created_at_utc) || typeof manifest.builder_version !== 'string' || !manifest.builder_version) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'MANIFEST_METADATA' });
  if ((v.gt_schema === 3) !== (v.gt_policy === 2)) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'SOURCE_VERSION_COMBINATION' });
  if (version === 2 && v.gt_schema < 3 && events.some(e => e.gt_basis !== 'OBSERVATION_AGGREGATED')) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'LEGACY_GT_BASIS' });
  equal(Object.keys(v).sort(), ['gt_policy', 'gt_schema', 'raw_schema']);
  const rebuilt = makeManifest(source, result, rebuiltFiles, manifest.created_at_utc);
  rebuilt.builder_version = manifest.builder_version;
  equal(manifest, rebuilt, 'MANIFEST');
  if (!options.staging && path.basename(path.resolve(directory)) !== manifest.model_dataset_id) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'DIRECTORY_ID' });
  if (options.raw) {
    const input = await loadInputs(options.raw, options.gt);
    if (canonicalJson(input.source) !== canonicalJson(source)) fail('SOURCE_DATASET_MISMATCH');
    const linked = derive(input.events, input.snapshots, input.gt, input.replays, manifest.selection, input.inputSummary, version);
    const expected = contents(linked);
    for (const f of FILES) if (!files[f].equals(Buffer.from(expected[f]))) fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'SOURCE_ROWS_MISMATCH' });
  }
  return { status: 'PASS', validation_scope: options.raw ? 'SOURCE_LINKED' : 'PACKAGE_INTERNAL', model_dataset_id: manifest.model_dataset_id, manifest, statistics: result.statistics };
}
if (isMain(import.meta.url)) await runCli('validate', o => inspectModelDataset(o.path, o));
