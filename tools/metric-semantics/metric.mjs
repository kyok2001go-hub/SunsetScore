#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson, errorCode, hash, isMain, readSafe } from '../dataset/lib/common.mjs';
import { bundleArgs, executeBundleCli } from '../experiment-runtime/lib/execute.mjs';
import { assert, equal, rejectCliFixture, sourceRef } from '../formal/contracts.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { recordLedger } from '../validation/lib/disclosure.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { artifactDatasetRoot, members } from '../formal/contracts.mjs';
import { publishTeamConfirmation } from './team-confirmation.mjs';
import { inspectGroundTruth } from '../ground-truth/validate-ground-truth.mjs';
import { importIndex, inspectMetricPackage, pilotPayloads, publishMetric, reviewPayloads,
  reviewPlanPayloads, rubricPayloads } from './semantics.mjs';

const FLAGS = {
  rubric: ['specification', 'output', 'access-ledger'],
  confirm: ['raw', 'gt', 'declaration', 'output', 'access-ledger'],
  template: ['rubric', 'index', 'output', 'access-ledger'],
  pilot: ['rubric', 'index', 'annotations', 'output', 'access-ledger'],
  'review-plan': ['rubric', 'pilot', 'index', 'annotations', 'specification', 'output', 'access-ledger'],
  review: ['plan', 'annotations', 'conclusion', 'output', 'access-ledger'],
  validate: ['rubric', 'pilot', 'plan', 'raw', 'gt']
};
const REQUIRED = { confirm: ['raw', 'gt', 'declaration'], rubric: ['specification'], template: ['rubric', 'index', 'output'], pilot: ['rubric', 'index', 'annotations'],
  'review-plan': ['rubric', 'pilot', 'index', 'annotations', 'specification'], review: ['plan', 'annotations', 'conclusion'] };
export function parseMetricArgs(argv) {
  const args = argv.slice(), command = args.shift(); assert(Object.hasOwn(FLAGS, command), 'METRIC_COMMAND_INVALID');
  const o = { command }; if (command === 'validate') { assert(args[0] && !args[0].startsWith('--'), 'METRIC_PATH_MISSING'); o.path = path.resolve(args.shift()); }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quiet') { assert(!o.quiet, 'DUPLICATE_ARGUMENT'); o.quiet = true; continue; }
    const key = args[i].replace(/^--/, ''), value = args[++i];
    assert(args[i - 1]?.startsWith('--') && [...FLAGS[command], 'runtime-bundle'].includes(key) &&
      value && !value.startsWith('--') && !Object.hasOwn(o, key), 'INVALID_ARGUMENTS'); o[key] = path.resolve(value);
  }
  assert((REQUIRED[command] || []).every(key => o[key]), 'INVALID_ARGUMENTS'); return o;
}
const json = async file => { const value = JSON.parse(await readSafe(file)); rejectCliFixture(value); return value; };
const packet = async dir => { const value = await inspectMetricPackage(dir); rejectCliFixture(value); return value; };
export async function metricOperation(o) {
  if (o.command === 'confirm') { await json(o.declaration); return publishTeamConfirmation(o); }
  if (o.command === 'template') {
    const rubric = await packet(o.rubric), imported = await importIndex(o.index);
    const output = await outside(o.output, [o.rubric, path.dirname(o.index)]); await mkdir(output, { recursive: true });
    const annotations = { annotation_schema_version: 1, reviewer: { reviewer_id: '<真实人工ID>', kind: 'HUMAN' },
      submitted_at_utc: '<实际UTC提交时间>', blind_declaration: { prediction_hidden: false, candidate_hidden: false, prior_annotation_hidden: false },
      annotations: imported.index.samples.map(x => ({ sample_key: x.sample_key, rating: null, reason: '' })) };
    const blind = { rubric: rubric.files['rubric.json'], samples: imported.index.samples.map(x => ({ sample_key: x.sample_key,
      evidence_sha256: x.evidence_sha256, minutes_relative_to_sunset: (Date.parse(x.observed_at_utc) - Date.parse(x.sunset_at_utc)) / 60000 })), assets: imported.assets };
    const ledger = o['access-ledger'] || path.resolve('dataset/validation/access-ledger');
    return withGovernanceLeases('metric_template', [artifactDatasetRoot(o.rubric), path.dirname(output), path.resolve(ledger, '../..')], async () => {
      await recordLedger(ledger, { action: 'SEMANTIC_TEMPLATE_REGISTERED', members: members(imported.index.samples),
        rubric_id: rubric.manifest.rubric_id, rubric_manifest_sha256: sourceRef(rubric).manifest_sha256,
        result_usage: 'PREPARATION_ONLY' });
      await writeFile(path.join(output, 'annotations.json'), canonicalJson(annotations), { flag: 'wx' });
      await writeFile(path.join(output, 'blind_evidence.json'), canonicalJson(blind), { flag: 'wx' });
      return { status: 'PREPARED', result_usage: 'PREPARATION_ONLY', directory: output, sample_count: imported.index.samples.length };
    });
  }
  if (o.command === 'validate') {
    const checked = await packet(o.path), sourceNames = { rubric: 'rubric_source.json', pilot: 'pilot_source.json', plan: 'review_plan_source.json' };
    for (const key of ['rubric', 'pilot', 'plan']) if (o[key]) {
      assert(checked.files[sourceNames[key]], 'METRIC_SOURCE_NOT_DECLARED');
      equal(sourceRef(await packet(o[key])), sourceRef(checked.files[sourceNames[key]]), 'METRIC_EXTERNAL_SOURCE_MISMATCH');
    }
    if (o.raw || o.gt) {
      assert(o.raw && o.gt && checked.files['team_confirmation.json'], 'TEAM_VALIDATION_SOURCES_REQUIRED');
      await inspectGroundTruth(o.gt, { source: o.raw, requireSource: true });
      for (const key of ['raw', 'gt']) equal(hash(await readSafe(path.join(o[key], 'manifest.json'))),
        checked.files['team_confirmation.json'].source_ids[key].manifest_sha256, 'TEAM_VALIDATION_SOURCE_MISMATCH');
    }
    return { status: 'PASS', validation_scope: o.raw ? 'SOURCE_LINKED' : ['rubric', 'pilot', 'plan'].some(key => o[key]) ? 'DECLARED_SOURCES_LINKED' : 'PACKAGE_INTERNAL',
      [checked.manifest.id_field]: checked.manifest[checked.manifest.id_field], result_usage: checked.files['summary.json'].result_usage, summary: checked.files['summary.json'] };
  }
  let kind, payloads, sourceDirectories;
  if (o.command === 'rubric') { kind = 'metric_rubric'; payloads = rubricPayloads(await json(o.specification)); sourceDirectories = []; }
  if (o.command === 'pilot') {
    kind = 'metric_pilot'; sourceDirectories = [o.rubric];
    payloads = pilotPayloads(await packet(o.rubric), await importIndex(o.index), await json(o.annotations));
  }
  if (o.command === 'review-plan') {
    kind = 'metric_review_plan'; sourceDirectories = [o.rubric, o.pilot];
    payloads = reviewPlanPayloads({ rubric: await packet(o.rubric), pilot: await packet(o.pilot), imported: await importIndex(o.index),
      firstAnnotations: await json(o.annotations), specification: await json(o.specification) });
  }
  if (o.command === 'review') {
    kind = 'semantic_evidence'; sourceDirectories = [o.plan];
    payloads = reviewPayloads(await packet(o.plan), await json(o.annotations), await json(o.conclusion));
  }
  const result = await publishMetric(kind, payloads, { output: o.output, sourceDirectories, accessLedger: o['access-ledger'] });
  return { ...result, result_usage: payloads['summary.json'].result_usage, summary: payloads['summary.json'] };
}
export async function metricCli(argv) {
  const o = parseMetricArgs(argv);
  return o['runtime-bundle'] ? executeBundleCli(o['runtime-bundle'], process.argv[1], bundleArgs(argv, o.command, 'metric-semantics')) : metricOperation(o);
}
if (isMain(import.meta.url)) {
  try { console.log(canonicalJson(await metricCli(process.argv.slice(2)))); }
  catch (e) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(e), reason_code: e.reason_code || null })); process.exitCode = 1; }
}
