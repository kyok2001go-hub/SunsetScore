#!/usr/bin/env node
import path from 'node:path';
import { readSafe, canonicalJson, hash, fail, inventory, safeId, compare, isMain } from '../dataset/lib/common.mjs';
import { canonicalUtc } from '../dataset/dataset-schema.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { POLICY } from './ground-truth-policy.mjs';
import { groundTruthSchema, EVENT_FIELDS, ERROR_FIELDS } from './ground-truth-schema.mjs';
import { equal, parseJson, loadInput, issueOrder } from './lib/input.mjs';
import { derive } from './lib/aggregate.mjs';
import { FILES, contents, makeManifest } from './lib/package.mjs';
import { cli, parseArgs } from './lib/cli.mjs';

export async function inspectGroundTruth(directory, options = {}) {
  const manifest = parseJson(await readSafe(path.join(directory, 'manifest.json')));
  const version = manifest.ground_truth_schema_version, schema = groundTruthSchema(version);
  if (manifest.gt_policy_version !== 1) fail('UNSUPPORTED_GT_POLICY');
  const files = {};
  equal(Object.keys(manifest.files).sort(), [...FILES].sort());
  equal(await inventory(directory), [...FILES, 'manifest.json'].sort(compare));
  for (const f of FILES) {
    const bytes = await readSafe(path.join(directory, f));
    if (hash(bytes) !== manifest.files[f].sha256 || bytes.length !== manifest.files[f].bytes) fail('GT_VALIDATION_FAILED');
    files[f] = bytes;
  }
  equal(parseJson(files['schema.json']), schema);
  equal(parseJson(files['policy.json']), POLICY, 'UNSUPPORTED_GT_POLICY');
  const gt = readCsv(EVENT_FIELDS, files['event_ground_truth.csv']), contributions = readCsv(schema.tables.observation_contributions, files['observation_contributions.csv']);
  const errors = readCsv(ERROR_FIELDS, files['reports/errors.csv']);
  if (!gt.length) fail('GT_VALIDATION_FAILED');
  equal(errors, [...errors].sort(issueOrder));
  for (const e of errors) {
    if (e.severity !== 'WARNING' || e.entity_type !== 'observation' || e.error_code !== 'EVENT_DISPLAY_CONTEXT_VARIANT') fail('GT_VALIDATION_FAILED');
    safeId(e.entity_id); safeId(e.event_id);
  }
  const events = new Set(), ids = new Set();
  for (const e of gt) { safeId(e.event_id); if (events.has(e.event_id)) fail('GT_VALIDATION_FAILED'); events.add(e.event_id); }
  for (const r of contributions) {
    safeId(r.observation_id);
    if (ids.has(r.observation_id) || !events.has(r.event_id)) fail('GT_VALIDATION_FAILED'); ids.add(r.observation_id);
  }
  const result = derive(gt, contributions.map(r => ({ ...r, id: r.observation_id })));
  const expected = contents(result, errors, version);
  for (const f of FILES) if (!files[f].equals(Buffer.from(expected[f]))) fail('GT_VALIDATION_FAILED');
  const source = Object.fromEntries(['source_dataset_id', 'source_dataset_manifest_sha256', 'source_descriptor_sha256', 'source_input_files'].map(k => [k, manifest[k]]));
  if (!/^raw_v1_\d{8}_\d{8}_[a-f0-9]{12}$/.test(source.source_dataset_id) ||
      !/^[a-f0-9]{64}$/.test(source.source_descriptor_sha256) || !/^[a-f0-9]{64}$/.test(source.source_dataset_manifest_sha256) ||
      !source.source_dataset_id.endsWith(source.source_descriptor_sha256.slice(0, 12))) fail('GT_VALIDATION_FAILED');
  equal(Object.keys(source.source_input_files).sort(), ['schema.json', 'raw/events.csv', 'raw/sunset_observations.csv'].sort());
  for (const m of Object.values(source.source_input_files)) {
    equal(Object.keys(m).sort(), ['bytes', 'sha256']);
    if (!/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.bytes) || m.bytes < 0) fail('GT_VALIDATION_FAILED');
  }
  if (!canonicalUtc(manifest.created_at_utc) || typeof manifest.builder_version !== 'string' || !manifest.builder_version.length) fail('GT_VALIDATION_FAILED');
  const rebuilt = makeManifest(source, result, expected, manifest.created_at_utc);
  rebuilt.builder_version = manifest.builder_version;
  equal(manifest, rebuilt);
  if (!options.staging && path.basename(path.resolve(directory)) !== manifest.ground_truth_id) fail('GROUND_TRUTH_DIRECTORY_MISMATCH');
  let input;
  if (options.requireSource && !options.source) fail('SOURCE_DATASET_REQUIRED');
  if (options.source) {
    input = await loadInput(options.source);
    equal(input.source, source, 'SOURCE_DATASET_MISMATCH');
    const linked = contents(derive(input.events, input.observations), input.issues, version);
    for (const f of FILES) if (!files[f].equals(Buffer.from(linked[f]))) fail('GT_VALIDATION_FAILED');
  }
  return { status: 'PASS', validation_scope: options.source ? 'SOURCE_LINKED' : 'PACKAGE_INTERNAL',
    ground_truth_id: manifest.ground_truth_id, manifest, statistics: result.statistics, input };
}
if (isMain(import.meta.url)) await cli('validate', async args => {
  const o = parseArgs(args, 'validate'), result = await inspectGroundTruth(o.path, o);
  return { options: o, data: { status: result.status, validation_scope: result.validation_scope, ground_truth_id: result.ground_truth_id } };
});
