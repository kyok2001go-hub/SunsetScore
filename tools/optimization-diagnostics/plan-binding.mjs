import { canonicalJson, fail } from '../dataset/lib/common.mjs';
import { inspectGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { optimizationPolicy } from '../optimization/optimization-policy.mjs';
import { digest } from './engine.mjs';
import path from 'node:path';
import { fingerprintSourcePackage } from '../optimization/lib/input.mjs';
import { verifyBundle } from '../experiment-runtime/lib/bundle.mjs';
import { readSources } from './sources.mjs';

export async function optimizationPlanReference(directory, development) {
  if (!directory) fail('OPTIMIZATION_PLAN_REQUIRED');
  const packet = await inspectGovernancePackage(directory), doc = packet.files['optimization_plan.json'];
  const equal = (a, b) => {
    if (canonicalJson(a) !== canonicalJson(b)) fail('OPTIMIZATION_PLAN_SOURCE_CHANGED');
  };
  if (packet.manifest.descriptor.package_kind !== 'optimization_search_plan' ||
      doc?.optimization_schema_version !== 2 || doc.optimization_policy_version !== 4 ||
      packet.manifest.result_usage !== 'DEVELOPMENT_ONLY' || doc.result_usage !== 'DEVELOPMENT_ONLY') fail('OPTIMIZATION_PLAN_REQUIRED');
  equal(doc.diagnostic_source, development.evidence);
  equal(doc.search_policy, optimizationPolicy(4));
  equal(doc.final_candidates, development.candidates);
  equal(doc.source_ids, development.frozen.sourceManifest.source_ids);
  equal(packet.manifest.source_ids, doc.source_ids);
  for (const key of ['diagnostic_plan_id', 'diagnostic_plan_manifest_sha256', 'diagnostic_id', 'diagnostic_manifest_sha256']) {
    equal(packet.manifest[key], development.evidence[key]);
  }
  return { optimization_plan_id: packet.manifest.optimization_plan_id,
    optimization_plan_manifest_sha256: digest(packet.manifest) };
}

/** Extend the Phase 7 six-source final check to every new immutable governance parent. */
export async function developmentDependencyCheck(paths, manifest) {
  const bound = await readSources(paths.sources);
  if (!paths.diagnosticPlan) fail('DIAGNOSTIC_CONTEXT_REQUIRED');
  const references = [
    { directory: paths.optimizationPlan || path.resolve(paths.optimization, '../../plans/exports', manifest.optimization_plan_id),
      sha256: manifest.optimization_plan_manifest_sha256 },
    { directory: paths.diagnosticPlan, sha256: manifest.diagnostic_plan_manifest_sha256 },
    { directory: paths.diagnosticResult || path.resolve(paths.diagnosticPlan, '../../../exports', manifest.diagnostic_id),
      sha256: manifest.diagnostic_manifest_sha256 }
  ];
  const diagnosticPlan = await inspectGovernancePackage(paths.diagnosticPlan);
  references.push({ directory: bound.runtimeBundle, sha256: diagnosticPlan.manifest.runtime_bundle_manifest_sha256, runtime: true });
  const snapshots = [];
  for (const reference of references) {
    const before = await fingerprintSourcePackage(reference.directory);
    if (before['manifest.json'] !== reference.sha256) fail('VALIDATION_PLAN_SOURCE_CHANGED');
    if (reference.runtime) await verifyBundle(reference.directory, { requireEnvironment: true });
    else await inspectGovernancePackage(reference.directory);
    if (canonicalJson(before) !== canonicalJson(await fingerprintSourcePackage(reference.directory))) fail('VALIDATION_PLAN_SOURCE_CHANGED');
    snapshots.push({ ...reference, fingerprint: before });
  }
  return async () => {
    for (const source of snapshots) if (canonicalJson(source.fingerprint) !== canonicalJson(await fingerprintSourcePackage(source.directory))) {
      fail('VALIDATION_PLAN_SOURCE_CHANGED');
    }
  };
}
