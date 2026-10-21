import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { canonicalJson, fail, readSafe } from '../dataset/lib/common.mjs';
import { inspectGovernancePackage, publishGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../experiment-runtime/lib/references.mjs';
import { nodeProcess } from '../experiment-runtime/lib/bundle.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { withPlanLock, recordLedger } from '../validation/lib/disclosure.mjs';
import { artifactDatasetRoot } from '../formal/contracts.mjs';
import { diagnosticSchema, diagnosticPolicy } from './policy.mjs';
import { digest } from './engine.mjs';
import { loadDiagnosticSources, checkDiagnosticSources, recordDiagnosticAccess, readSources, SOURCE_KEYS } from './sources.mjs';
import { computeDiagnostics, makeDiagnosticPlan } from './workflow.mjs';
import { runReplay } from '../replay/replay-runner.mjs';
import { sourceIdentity } from '../optimization/lib/input.mjs';
import { publicSearchSpace } from '../optimization/lib/search-space.mjs';
import { optimizationInputIdentity } from '../optimization/lib/build.mjs';
import { optimizationPolicy } from '../optimization/optimization-policy.mjs';

export function diagnosticSource(frozen) {
  return { diagnostic_plan_id: frozen.manifest.diagnostic_plan_id,
    diagnostic_plan_manifest_sha256: digest(frozen.manifest) };
}
export function finalInputId(loaded, frozen) {
  return `optimization_input_${digest(optimizationInputIdentity({
    source: { ...sourceIdentity(loaded.input), ...diagnosticSource(frozen) },
    searchSpaceSha256: digest(publicSearchSpace(loaded.searchSpace)), policy: optimizationPolicy(4) })).slice(0, 16)}`;
}

export async function inspectDiagnostic(directory) {
  const checked = await inspectGovernancePackage(directory), { files, manifest } = checked;
  const kind = manifest.descriptor.package_kind, planOnly = kind === 'optimization_diagnostic_plan';
  if (!['optimization_diagnostic_plan', 'optimization_diagnostic'].includes(kind)) fail('INVALID_DIAGNOSTIC_PACKAGE');
  const schema = diagnosticSchema(files['schema.json']?.diagnostic_schema_version);
  const policy = diagnosticPolicy(files['policy.json']?.diagnostic_policy_version);
  if (canonicalJson(files['schema.json']) !== canonicalJson(schema) || canonicalJson(files['policy.json']) !== canonicalJson(policy) ||
    canonicalJson(files['plan.json'].policy) !== canonicalJson(policy) || files['plan.json'].diagnostic_schema_version !== 1 ||
    files['plan.json'].diagnostic_policy_version !== 1 || files['plan.json'].computation_access_policy !== 'TRAIN_ONLY' ||
    files['plan.json'].matrix.length > policy.matrix_budget ||
    canonicalJson(Object.keys(files).sort()) !== canonicalJson((planOnly ? schema.plan_files : schema.result_files).sort()) ||
    manifest.result_usage !== 'DEVELOPMENT_ONLY' || manifest.diagnostic_schema_version !== 1 || manifest.diagnostic_policy_version !== 1 ||
    files['plan.json'].result_usage !== 'DEVELOPMENT_ONLY' || digest(files['source_manifest.json']) !== files['plan.json'].source_manifest_sha256 ||
    files['plan.json'].test_evaluated !== false || files['plan.json'].validation_evaluated !== false) fail('INVALID_DIAGNOSTIC_PACKAGE');
  if (!planOnly && (files['decision.json'].formal_promotion_allowed !== false || files['decision.json'].result_usage !== 'DEVELOPMENT_ONLY')) fail('DIAGNOSTIC_PROMOTION_FORBIDDEN');
  return checked;
}
export async function loadFrozenDiagnosticPlan(directory, loaded) {
  const checked = await inspectDiagnostic(directory);
  if (checked.manifest.descriptor.package_kind !== 'optimization_diagnostic_plan') fail('DIAGNOSTIC_PLAN_REQUIRED');
  const frozen = checked.files['source_manifest.json'];
  await checkDiagnosticSources(loaded, frozen);
  const plan = makeDiagnosticPlan({ ...loaded, sourceManifest: frozen });
  if (digest(plan) !== digest(checked.files['plan.json'])) fail('DIAGNOSTIC_PLAN_SOURCE_CHANGED');
  return { ...checked, plan, sourceManifest: frozen };
}
const links = frozen => ({ diagnostic_schema_version: 1, diagnostic_policy_version: 1, result_usage: 'DEVELOPMENT_ONLY',
  source_ids: frozen.source_ids, runtime_bundle_id: frozen.runtime.id, runtime_bundle_manifest_sha256: frozen.runtime.manifest_sha256 });

export async function withDiagnosticLeases(options, operation) {
  const paths = await readSources(options.sources);
  const output = options.output || path.resolve('dataset/optimization_diagnostics');
  const roots = SOURCE_KEYS.map(key => paths[key]).concat(paths.runtimeBundle, options.plan || [], options.input || []);
  await outside(output, roots);
  const histories = await (await import('../campaign/campaign.mjs')).historySnapshots(paths);
  const sourceRoots = [...SOURCE_KEYS.map(key => key === 'raw' ? path.resolve(paths[key], '../..') : artifactDatasetRoot(paths[key])),
    artifactDatasetRoot(paths.runtimeBundle), ...Object.values(histories.roots).map(root => path.resolve(root, '../..')),
    ...[options.plan, options.input, options.diagnosticPlan, options.diagnosticResult, options.optimizationPlan].filter(Boolean).map(artifactDatasetRoot)];
  return withGovernanceLeases('optimization_diagnostics', [path.dirname(output), ...SOURCE_KEYS.map(key => key === 'raw' ?
    path.resolve(paths[key], '../..') : artifactDatasetRoot(paths[key])), artifactDatasetRoot(paths.runtimeBundle),
    path.resolve(paths.accessLedger, '../..'), ...sourceRoots], async () => {
    await protectExternalReferences(sourceRoots, output);
    return operation(output);
  });
}
export async function planDiagnostics(options) {
  return withDiagnosticLeases(options, async output => {
    const loaded = await loadDiagnosticSources(options), sourceManifest = loaded.sourceManifest;
    const plan = makeDiagnosticPlan(loaded);
    return publishGovernancePackage({ output: path.join(output, 'plans'), kind: 'optimization_diagnostic_plan',
      idField: 'diagnostic_plan_id', links: links(sourceManifest), payloads: { 'schema.json': diagnosticSchema(),
        'policy.json': diagnosticPolicy(), 'plan.json': plan, 'source_manifest.json': sourceManifest },
      sourceCheck: () => checkDiagnosticSources(loaded, sourceManifest), validateStaging: inspectDiagnostic });
  });
}
export async function calculateFrozenDiagnostics(options) {
  const loaded = await loadDiagnosticSources(options), frozen = await loadFrozenDiagnosticPlan(options.plan, loaded);
  const computed = await computeDiagnostics({ ...loaded, plan: frozen.plan, sourceManifest: frozen.sourceManifest,
    finalOptimizationInputId: finalInputId(loaded, frozen),
    progress: options.progress, runReplay: (replay, config) => runReplay(replay, { ...config, engineRoot: loaded.root }) });
  await checkDiagnosticSources(loaded, frozen.sourceManifest);
  return { loaded, frozen, ...computed };
}
export async function runDiagnostics(options) {
  return withDiagnosticLeases(options, output => withPlanLock(output, path.basename(options.plan), async () => {
    const loaded = await loadDiagnosticSources(options), frozen = await loadFrozenDiagnosticPlan(options.plan, loaded);
    const planId = frozen.manifest.diagnostic_plan_id;
    await recordDiagnosticAccess(loaded, planId, 'FIXED_MATRIX_AND_INNER_CV');
    const computed = await computeDiagnostics({ ...loaded, plan: frozen.plan, sourceManifest: frozen.sourceManifest,
      finalOptimizationInputId: finalInputId(loaded, frozen),
      progress: options.progress, runReplay: (replay, config) => runReplay(replay, { ...config, engineRoot: loaded.root }) });
    options.progress?.stage('发布前新进程独立重算诊断结果');
    await recordLedger(loaded.paths.accessLedger, { action: 'PREPUBLISH_RECOMPUTE_STARTED', plan_id: planId, purpose: 'OPTIMIZATION_DIAGNOSTIC' });
    const stdout = await nodeProcess(path.join(loaded.runtime.source, 'tools/optimization-diagnostics/worker.mjs'),
      ['--plan', options.plan, '--sources', options.sources], { cwd: loaded.runtime.source });
    const rebuilt = JSON.parse(stdout.trim());
    if (rebuilt.payload_sha256 !== digest(computed.payloads)) fail('DIAGNOSTIC_RECOMPUTE_MISMATCH');
    const published = await publishGovernancePackage({ output, kind: 'optimization_diagnostic', idField: 'diagnostic_id',
      payloads: computed.payloads, links: { ...links(frozen.sourceManifest), diagnostic_plan_id: planId,
        diagnostic_plan_manifest_sha256: digest(frozen.manifest) },
      sourceCheck: () => checkDiagnosticSources(loaded, frozen.sourceManifest), validateStaging: inspectDiagnostic });
    // A retry deterministically deduplicates publication and repairs a missing completion receipt.
    await recordLedger(loaded.paths.accessLedger, { action: 'DIAGNOSTIC_RUN_COMPLETED', plan_id: planId,
      result_id: published.diagnostic_id, payload_sha256: rebuilt.payload_sha256, result_usage: 'DEVELOPMENT_ONLY' });
    return { ...published, ...computed.payloads['reports/summary.json'] };
  }));
}
async function validateDiagnosticCore(options) {
  const checked = await inspectDiagnostic(options.input);
  const frozen = checked.files['source_manifest.json'];
  const loaded = await loadDiagnosticSources(options);
  await checkDiagnosticSources(loaded, frozen);
  const planDirectory = options.plan || path.join(path.dirname(path.dirname(options.input)), 'plans/exports', checked.manifest.diagnostic_plan_id);
  const frozenPlan = await loadFrozenDiagnosticPlan(planDirectory, loaded);
  if (digest(frozenPlan.manifest) !== checked.manifest.diagnostic_plan_manifest_sha256) fail('DIAGNOSTIC_PLAN_SOURCE_CHANGED');
  await recordDiagnosticAccess(loaded, frozenPlan.manifest.diagnostic_plan_id, 'SOURCE_LINKED_DIAGNOSTIC_VERIFY');
  const recomputed = await computeDiagnostics({ ...loaded, plan: checked.files['plan.json'], sourceManifest: frozen,
    finalOptimizationInputId: finalInputId(loaded, frozenPlan),
    runReplay: (replay, config) => runReplay(replay, { ...config, engineRoot: loaded.root }), progress: options.progress });
  if (digest(recomputed.payloads) !== digest(checked.files)) fail('DIAGNOSTIC_RECOMPUTE_MISMATCH');
  await checkDiagnosticSources(loaded, frozen);
  return { status: 'PASS', validation_scope: 'SOURCE_LINKED_RECOMPUTED', diagnostic_id: checked.manifest.diagnostic_id,
    result_usage: 'DEVELOPMENT_ONLY' };
}
export async function validateDiagnostics(options) {
  return withDiagnosticLeases({ ...options, output: path.resolve(options.input, '../..') }, () => validateDiagnosticCore(options));
}

export async function loadDevelopmentSearch(options) {
  if (!options.diagnosticPlan || !options.sources) fail('DIAGNOSTIC_CONTEXT_REQUIRED');
  if (!options.diagnosticResult) {
    const exportsRoot = path.resolve(options.diagnosticPlan, '../../../exports');
    const matches = [];
    for (const name of (await readdir(exportsRoot, { withFileTypes: true })).filter(e => e.isDirectory())) {
      const manifest = JSON.parse(await readSafe(path.join(exportsRoot, name.name, 'manifest.json')));
      if (manifest.diagnostic_plan_id === path.basename(options.diagnosticPlan)) matches.push(path.join(exportsRoot, name.name));
    }
    if (matches.length !== 1) fail('DIAGNOSTIC_RESULT_REQUIRED');
    options = { ...options, diagnosticResult: matches[0] };
  }
  const result = await inspectDiagnostic(options.diagnosticResult);
  const computed = await calculateFrozenDiagnostics({ ...options, plan: options.diagnosticPlan });
  for (const key of SOURCE_KEYS) if (options[key] && path.resolve(options[key]) !== path.resolve(computed.loaded.paths[key])) fail('DIAGNOSTIC_SOURCE_PATH_MISMATCH');
  if (result.manifest.diagnostic_plan_id !== computed.frozen.manifest.diagnostic_plan_id ||
      digest(result.files) !== digest(computed.payloads)) fail('DIAGNOSTIC_RECOMPUTE_MISMATCH');
  if (computed.payloads['decision.json'].auto_validation_allowed !== true || !computed.finalSearch) fail('DIAGNOSTIC_PROCEDURE_NOT_SUPPORTED');
  return { ...computed, source: diagnosticSource(computed.frozen),
    artifactSources: [{ directory: options.diagnosticPlan, manifest_sha256: digest(computed.frozen.manifest) },
      { directory: options.diagnosticResult, manifest_sha256: digest(result.manifest) }],
    evidence: { ...diagnosticSource(computed.frozen), diagnostic_id: result.manifest.diagnostic_id,
      diagnostic_manifest_sha256: digest(result.manifest), procedure_status: 'PROCEDURE_SUPPORTED',
      decision_sha256: digest(result.files['decision.json']), result_usage: 'DEVELOPMENT_ONLY' } };
}

export async function checkDevelopmentSources(development) {
  await checkDiagnosticSources(development.loaded, development.frozen.sourceManifest);
  for (const source of development.artifactSources) {
    const checked = await inspectDiagnostic(source.directory);
    if (digest(checked.manifest) !== source.manifest_sha256) fail('DIAGNOSTIC_SOURCE_CHANGED');
  }
}
