#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, errorCode, isMain, readSafe } from '../dataset/lib/common.mjs';
import { bundleArgs, executeBundleCli } from '../experiment-runtime/lib/execute.mjs';
import { APP_ROOT } from '../tuning/lib/engine-runtime.mjs';
import { assert, keys, rejectCliFixture } from '../formal/contracts.mjs';
import { campaignPreflight, freezeCampaign, inspectCampaign } from './campaign.mjs';
import { createFormalDisclosure } from '../validation/lib/formal-evidence.mjs';

export function parseCampaignArgs(argv) {
  const args = argv.slice(), command = args.shift(); assert(['plan', 'freeze', 'validate', 'disclosure'].includes(command), 'CAMPAIGN_COMMAND_INVALID');
  const o = { command };
  if (command === 'validate') { assert(args[0] && !args[0].startsWith('--'), 'CAMPAIGN_PATH_MISSING'); o.path = path.resolve(args.shift()); }
  const fields = { specification: 'specificationFile', raw: 'raw', gt: 'gt', model: 'model',
    'metric-evidence': 'metricEvidence', 'runtime-bundle': 'runtimeBundle', 'build-runtimes': 'buildRuntimesFile',
    'history-ledgers': 'historyLedgers', 'access-ledger': 'accessLedger', output: 'output', campaign: 'campaign', declaration: 'declarationFile' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quiet') { assert(!o.quiet, 'INVALID_ARGUMENTS'); o.quiet = true; continue; }
    const key = args[i].replace(/^--/, ''), value = args[++i], field = fields[key];
    assert(args[i - 1]?.startsWith('--') && field && value && !value.startsWith('--') && !Object.hasOwn(o, field), 'INVALID_ARGUMENTS'); o[field] = path.resolve(value);
  }
  if (command === 'disclosure') assert(['campaign', 'model', 'declarationFile'].every(key => o[key]), 'INVALID_ARGUMENTS');
  else if (command !== 'validate') assert(['specificationFile', 'raw', 'gt', 'model', 'metricEvidence'].every(key => o[key]), 'INVALID_ARGUMENTS');
  return o;
}
export async function campaignOperation(o) {
  if (o.command === 'disclosure') {
    o.declaration = JSON.parse(await readSafe(o.declarationFile)); rejectCliFixture(o.declaration);
    return createFormalDisclosure(o);
  }
  if (o.command === 'validate') {
    const checked = await inspectCampaign(o.path); rejectCliFixture(checked);
    return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL', campaign_id: checked.manifest.campaign_id,
      result_usage: checked.files['summary.json'].result_usage, summary: checked.files['summary.json'] };
  }
  o.specification = JSON.parse(await readSafe(o.specificationFile)); rejectCliFixture(o.specification);
  if (!o.runtimeBundle && process.env.SUNSETSCORE_RUNTIME_BUNDLE_SHA256) o.runtimeBundle = path.resolve(APP_ROOT, '..');
  assert(o.runtimeBundle, 'FORMAL_RUNTIME_MISSING');
  if (o.buildRuntimesFile) {
    const doc = JSON.parse(await readSafe(o.buildRuntimesFile));
    keys(doc, ['build_runtimes_schema_version', 'bundles']);
    assert(doc.build_runtimes_schema_version === 1 && Array.isArray(doc.bundles), 'BUILD_RUNTIME_REGISTRY_INVALID');
    o.buildRuntimes = doc.bundles.map(x => ({ engine_build_sha: x.engine_build_sha,
      directory: path.resolve(path.dirname(o.buildRuntimesFile), x.directory) }));
  }
  if (o.command === 'freeze') return freezeCampaign(o);
  const planned = await campaignPreflight(o); rejectCliFixture(planned.payloads);
  return { status: planned.status, blocking_reasons: planned.blocking_reasons, summary: planned.payloads['summary.json'] };
}
export async function campaignCli(argv) {
  const o = parseCampaignArgs(argv);
  return o.runtimeBundle ? executeBundleCli(o.runtimeBundle, process.argv[1], bundleArgs(argv, o.command, 'campaign')) : campaignOperation(o);
}
if (isMain(import.meta.url)) {
  try { console.log(canonicalJson(await campaignCli(process.argv.slice(2)))); }
  catch (e) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(e), reason_code: e.reason_code || null })); process.exitCode = 1; }
}
