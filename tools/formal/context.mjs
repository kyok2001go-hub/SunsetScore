import path from 'node:path';
import { canonicalJson, hash, readSafe } from '../dataset/lib/common.mjs';
import { inspectModelDataset } from '../model-dataset/validate-model-dataset.mjs';
import { fingerprintExecutionRoot, verifyBundle } from '../experiment-runtime/lib/bundle.mjs';
import { inspectCampaign, inspectCampaignSnapshot, runtimeSnapshot, historySnapshots } from '../campaign/campaign.mjs';
import { inspectMetricPackage, inspectMetricSnapshot } from '../metric-semantics/semantics.mjs';
import { APP_ROOT, runtimeDocument } from '../tuning/lib/engine-runtime.mjs';
import { recordLedger } from '../validation/lib/disclosure.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../experiment-runtime/lib/references.mjs';
import { artifactDatasetRoot, assert, assertExecutableUsage, equal, FORMAL_CONTRACT_REVISION, keys, members, snapshot, sourceRef } from './contracts.mjs';

export const FORMAL_CONTEXT_FILE = 'formal_context.json';
export function formalContextIdentity(context) {
  const campaign = sourceRef(context.campaign), semantic = sourceRef(context.semantic_evidence), runtime = runtimeSnapshot(context.runtime);
  return { formal_contract_revision: FORMAL_CONTRACT_REVISION, result_usage: context.result_usage,
    campaign_id: campaign.id, campaign_manifest_sha256: campaign.manifest_sha256,
    semantic_evidence_id: semantic.id, semantic_evidence_manifest_sha256: semantic.manifest_sha256,
    mapping_contract_sha256: hash(canonicalJson(context.semantic_evidence.files['mapping_contract.json'])),
    runtime_bundle_id: runtime.runtime_bundle_id, runtime_bundle_manifest_sha256: runtime.manifest_sha256,
    runtime_bundle_sha256: runtime.runtime_bundle_sha256 };
}
/** Read-only package verification; persisted fixture identity cannot authorize execution. */
export function inspectFormalContext(context) {
  keys(context, ['formal_contract_revision', 'result_usage', 'campaign', 'semantic_evidence', 'runtime']);
  assert(context.formal_contract_revision === 1 && ['FORMAL', 'TEST_FIXTURE_ONLY'].includes(context.result_usage), 'FORMAL_CONTEXT_VERSION_INVALID');
  inspectCampaignSnapshot(context.campaign); inspectMetricSnapshot(context.semantic_evidence);
  equal(sourceRef(context.semantic_evidence), sourceRef(context.campaign.files['semantic_source.json']), 'FORMAL_SEMANTIC_CAMPAIGN_MISMATCH');
  equal(context.runtime, context.campaign.files['runtime_sources.json'].execution, 'FORMAL_RUNTIME_CAMPAIGN_MISMATCH');
  assert(context.semantic_evidence.files['summary.json'].status === 'REVIEWED_PASS' &&
    context.campaign.files['summary.json'].status === 'READY_CAMPAIGN', 'FORMAL_EVIDENCE_NOT_READY');
  equal(context.result_usage, context.campaign.files['summary.json'].result_usage, 'FORMAL_USAGE_MISMATCH');
  if (context.result_usage === 'FORMAL') equal(context.semantic_evidence.files['summary.json'].result_usage, 'FORMAL', 'FORMAL_SEMANTIC_FIXTURE_FORBIDDEN');
  return context;
}
export function assertFormalModelRows(context, rows, split = 'TRAIN') {
  inspectFormalContext(context);
  equal(members(rows), context.campaign.files['summary.json'].split_members[split], 'FORMAL_CAMPAIGN_SPLIT_MISMATCH');
  const allowed = new Set(context.campaign.files['runtime_sources.json'].builds.map(x => x.engine_build_sha));
  assert(rows.every(x => allowed.has(x.engine_build_sha)), 'FORMAL_BUILD_NOT_ATTESTED');
}
export async function validateFormalSourceContext(context, options, { validateModel = true } = {}) {
  inspectFormalContext(context);
  equal(options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null,
    context.campaign.files['source_manifests.json'].history_registry_sha256, 'FORMAL_HISTORY_REGISTRY_CHANGED');
  for (const key of ['model', 'raw', 'gt']) {
    assert(options[key], 'FORMAL_SOURCE_PATH_MISSING');
    const bytes = await readSafe(path.join(options[key], 'manifest.json'));
    equal(hash(bytes), context.campaign.files['source_manifests.json'][key].manifest_sha256, 'FORMAL_CAMPAIGN_SOURCE_MISMATCH');
  }
  if (validateModel) {
    const linked = await inspectModelDataset(options.model, { raw: options.raw, gt: options.gt });
    assert(linked.status === 'PASS' && linked.validation_scope === 'SOURCE_LINKED', 'FORMAL_MODEL_SOURCE_NOT_LINKED');
  }
  if (options.campaign) equal(sourceRef(await inspectCampaign(options.campaign)), sourceRef(context.campaign), 'FORMAL_CAMPAIGN_CHANGED');
  if (options.metricEvidence) equal(sourceRef(await inspectMetricPackage(options.metricEvidence)), sourceRef(context.semantic_evidence), 'FORMAL_SEMANTIC_CHANGED');
  const root = options.root || APP_ROOT;
  const bundle = options.runtimeBundle || path.resolve(root, '..');
  assert(bundle, 'FORMAL_RUNTIME_REQUIRED'); const checked = await verifyBundle(bundle, { requireEnvironment: true });
  equal(checked.runtime_bundle_sha256, formalContextIdentity(context).runtime_bundle_sha256, 'FORMAL_RUNTIME_CHANGED');
  equal((await runtimeDocument(root)).engine_runtime_sha256, checked.descriptor.engine_runtime_sha256, 'FORMAL_ENGINE_ROOT_MISMATCH');
  const archivedInventory = JSON.parse(await readSafe(path.join(bundle, 'file_inventory.json')));
  equal(await fingerprintExecutionRoot(root), archivedInventory, 'FORMAL_EVALUATOR_IMPLEMENTATION_MISMATCH');
  if (context.result_usage === 'FORMAL') equal(await fingerprintExecutionRoot(APP_ROOT), archivedInventory,
    'ACTIVE_FORMAL_EVALUATOR_IMPLEMENTATION_MISMATCH');
  return context;
}
export async function loadFormalContext(options, { executable = true } = {}) {
  if (options.formalContext) {
    inspectFormalContext(options.formalContext);
    if (executable) assertExecutableUsage(options.formalContext.result_usage, options);
    await validateFormalSourceContext(options.formalContext, options); return options.formalContext;
  }
  assert(options.campaign && options.metricEvidence, 'FORMAL_EVIDENCE_REQUIRED');
  const campaign = await inspectCampaign(options.campaign), semantic = await inspectMetricPackage(options.metricEvidence);
  const bundle = options.runtimeBundle || (process.env.SUNSETSCORE_RUNTIME_BUNDLE_SHA256 ? path.resolve(options.root || APP_ROOT, '..') : null);
  assert(bundle, 'FORMAL_RUNTIME_REQUIRED'); await verifyBundle(bundle, { requireEnvironment: true });
  const context = { formal_contract_revision: 1, result_usage: campaign.files['summary.json'].result_usage,
    campaign: snapshot(campaign), semantic_evidence: snapshot(semantic), runtime: JSON.parse(await readSafe(path.join(bundle, 'manifest.json'))) };
  inspectFormalContext(context); if (executable) assertExecutableUsage(context.result_usage, options);
  await validateFormalSourceContext(context, { ...options, runtimeBundle: bundle }); return context;
}
export async function registerTrainAccess(context, options, stage) {
  const { roots } = await historySnapshots(options);
  await recordLedger(roots.primary, { action: 'TRAIN_EFFECT_ACCESS', stage,
    campaign_id: context.campaign.manifest.campaign_id, result_usage: context.result_usage,
    members: context.campaign.files['summary.json'].split_members.TRAIN });
}
export function formalMissingReasons(options) {
  return [['campaign', 'CAMPAIGN_MISSING'], ['metricEvidence', 'SEMANTIC_QUALIFICATION_MISSING']]
    .filter(([key]) => !options[key]).map(([, reason]) => reason)
    .concat(options.runtimeBundle || process.env.SUNSETSCORE_RUNTIME_BUNDLE_SHA256 ? [] : ['FORMAL_RUNTIME_MISSING']);
}
export async function withFormalLeases(phase, options, output, operation) {
  const directories = ['model', 'raw', 'gt', 'baseline', 'sensitivity', 'optimization', 'campaign', 'metricEvidence', 'runtimeBundle', 'plan', 'disclosureEvidence',
    'diagnosticPlan', 'diagnosticResult', 'optimizationPlan']
    .filter(key => options[key]).map(key => ({ key, directory: options[key] }));
  const roots = [path.dirname(output), ...directories.map(({ key, directory }) => key === 'raw' ? path.resolve(directory, '../..') : artifactDatasetRoot(directory))];
  const registrySha256 = options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null;
  if (options.model) {
    const histories = await historySnapshots(options);
    roots.push(...Object.values(histories.roots).map(root => path.resolve(root, '../..')));
  } else if (options.accessLedger) roots.push(path.resolve(options.accessLedger, '../..'));
  return withGovernanceLeases(phase, roots, async () => {
    equal(options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null, registrySha256, 'FORMAL_HISTORY_REGISTRY_CHANGED');
    await protectExternalReferences(roots.slice(1), output);
    return operation();
  });
}
