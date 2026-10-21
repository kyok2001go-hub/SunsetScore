import path from 'node:path';
import { fail, readSafe } from '../dataset/lib/common.mjs';
import { inspectGovernancePackage, publishGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { loadDevelopmentSearch, withDiagnosticLeases, checkDevelopmentSources } from './package.mjs';
import { digest } from './engine.mjs';
import { buildOptimizationPackage } from '../optimization/lib/build.mjs';
import { publishOptimizationPackage } from '../optimization/lib/publish.mjs';
import { inspectOptimization } from '../optimization/validate-optimization.mjs';
import { nodeProcess } from '../experiment-runtime/lib/bundle.mjs';

export async function planDevelopmentOptimization(options) {
  return withDiagnosticLeases({ ...options, output: options.output || path.resolve('dataset/optimization') }, async output => {
    const development = await loadDevelopmentSearch(options);
    const payloads = { 'optimization_plan.json': { optimization_schema_version: 2, optimization_policy_version: 4,
      result_usage: 'DEVELOPMENT_ONLY', diagnostic_source: development.evidence,
      source_ids: development.frozen.sourceManifest.source_ids,
      final_candidates: development.candidates, search_policy: development.frozen.plan.policy.search_policy } };
    return publishGovernancePackage({ output: path.join(output, 'plans'), kind: 'optimization_search_plan', idField: 'optimization_plan_id',
      payloads, links: { ...development.source, result_usage: 'DEVELOPMENT_ONLY',
        source_ids: development.frozen.sourceManifest.source_ids,
        diagnostic_id: development.evidence.diagnostic_id, diagnostic_manifest_sha256: development.evidence.diagnostic_manifest_sha256 },
      sourceCheck: () => checkDevelopmentSources(development) });
  });
}
export async function runDevelopmentOptimization(options) {
  if (!options.plan) fail('OPTIMIZATION_PLAN_REQUIRED');
  const planned = await inspectGovernancePackage(options.plan);
  if (planned.manifest.descriptor.package_kind !== 'optimization_search_plan' || planned.manifest.result_usage !== 'DEVELOPMENT_ONLY') fail('OPTIMIZATION_PLAN_REQUIRED');
  const normalized = { ...options, optimizationPolicyVersion: 4, optimizationPlan: options.plan };
  return withDiagnosticLeases({ ...normalized, output: options.output || path.resolve('dataset/optimization') }, async output => {
    const built = await buildOptimizationPackage(normalized);
    const evidence = JSON.parse(built.files['diagnostic_source.json']);
    if (digest(evidence) !== digest(planned.files['optimization_plan.json'].diagnostic_source)) fail('OPTIMIZATION_PLAN_SOURCE_CHANGED');
    // The independent process rebuilds the complete diagnostic evidence and optimization bytes.
    const runtime = JSON.parse(await readSafe(path.join(options.sources))).runtimeBundle;
    const bundle = path.resolve(path.dirname(options.sources), runtime);
    const script = path.join(bundle, 'source/tools/optimization-diagnostics/optimization-worker.mjs');
    const args = ['--options', JSON.stringify(Object.fromEntries(Object.entries(normalized).filter(([key]) =>
      !['progress', 'runReplay', 'input'].includes(key))))];
    const rebuilt = JSON.parse((await nodeProcess(script, args, { cwd: path.join(bundle, 'source') })).trim());
    if (rebuilt.digest !== digest(built.files)) fail('OPTIMIZATION_RECOMPUTE_MISMATCH');
    const published = await publishOptimizationPackage({ output, roots: [options.raw, options.gt, options.model, options.baseline, options.sensitivity,
      options.plan, options.diagnosticPlan, options.diagnosticResult, bundle], files: built.files, manifest: built.manifest,
      progress: options.progress, validateStaging: dir => inspectOptimization(dir, { staging: true }),
      sourceCheck: async () => {
        await checkDevelopmentSources(built.development);
        const reference = await (await import('./plan-binding.mjs')).optimizationPlanReference(options.plan, built.development);
        if (reference.optimization_plan_manifest_sha256 !== built.manifest.optimization_plan_manifest_sha256) fail('OPTIMIZATION_PLAN_SOURCE_CHANGED');
      } });
    return { ...published, ...built.counts, result_usage: 'DEVELOPMENT_ONLY', descriptor_sha256: built.manifest.descriptor_sha256 };
  });
}
