import path from 'node:path';
import { canonicalJson, fail, hash, readSafe } from '../dataset/lib/common.mjs';
import { loadOptimizationInput, fingerprintSourcePackage } from '../optimization/lib/input.mjs';
import { verifyBundle, fingerprintExecutionRoot, nodeProcess } from '../experiment-runtime/lib/bundle.mjs';
import { inspectDiagnostic } from '../optimization-diagnostics/package.mjs';
import { SOURCE_KEYS, recordDiagnosticAccess } from '../optimization-diagnostics/sources.mjs';
import { historySnapshots } from '../campaign/campaign.mjs';
import { ledgerPrefixMatches } from '../validation/lib/disclosure.mjs';
import { APP_ROOT } from '../tuning/lib/engine-runtime.mjs';
import { digest } from '../optimization-diagnostics/engine.mjs';
export const sourceKeys=[...SOURCE_KEYS,'diagnosticPlan','diagnosticResult','sourceRuntime','runtimeBundle','historyLedgers','accessLedger'];
export async function readScoreSources(file) {
  const doc=JSON.parse(await readSafe(file));
  if(doc.sources_schema_version!==1||sourceKeys.some(k=>typeof doc[k]!=='string'||!doc[k])||Object.keys(doc).some(k=>!['sources_schema_version',...sourceKeys].includes(k)))fail('INVALID_SCORE_DIAGNOSTIC_SOURCES');
  return Object.fromEntries(sourceKeys.map(k=>[k,path.resolve(path.dirname(file),doc[k])]));
}
export async function loadScoreSources(options) {
  const paths=await readScoreSources(options.sources),root=options.root||APP_ROOT;
  const sourceRuntime=await verifyBundle(paths.sourceRuntime,{requireEnvironment:true}),runtime=await verifyBundle(paths.runtimeBundle,{requireEnvironment:true});
  if(canonicalJson(await fingerprintExecutionRoot(root))!==canonicalJson(JSON.parse(await readSafe(path.join(paths.runtimeBundle,'file_inventory.json')))))fail('SCORE_RUNTIME_SOURCE_MISMATCH');
  const parentPlan=await inspectDiagnostic(paths.diagnosticPlan),parentResult=await inspectDiagnostic(paths.diagnosticResult);
  if(parentPlan.manifest.descriptor.package_kind!=='optimization_diagnostic_plan'||parentResult.manifest.descriptor.package_kind!=='optimization_diagnostic'||
    parentResult.manifest.diagnostic_plan_id!==parentPlan.manifest.diagnostic_plan_id||parentResult.manifest.diagnostic_plan_manifest_sha256!==digest(parentPlan.manifest)||
    digest(parentPlan.files['plan.json'])!==digest(parentResult.files['plan.json']))fail('SCORE_PARENT_IDENTITY_MISMATCH');
  const historical=parentPlan.files['source_manifest.json'];
  if(historical.runtime.id!==sourceRuntime.runtime_bundle_id||historical.runtime.manifest_sha256!==sourceRuntime.manifest_sha256||
    sourceRuntime.descriptor.engine_runtime_sha256!==historical.runtime.engine_runtime_sha256)fail('SCORE_SOURCE_RUNTIME_MISMATCH');
  // Upstream verification uses its original engine identity; only TRAIN is subsequently exposed.
  const input=await loadOptimizationInput({...paths,root:sourceRuntime.source,optimizationPolicyVersion:4,progress:options.progress});
  const sourceIds={};
  for(const key of SOURCE_KEYS) {
    const frozen=historical.source_ids[key],bytes=await readSafe(path.join(paths[key],'manifest.json'));
    if(hash(bytes)!==frozen.manifest_sha256||digest(input.sourceFingerprints[key])!==frozen.package_fingerprint_sha256)fail('SCORE_SOURCE_IDENTITY_MISMATCH');
    sourceIds[key]=frozen;
  }
  if(digest(input.sensitivity.baseConfig.config)!==parentPlan.files['plan.json'].matrix.find(r=>r.label==='CONTROL')?.effective_config_sha256)fail('SCORE_CONTROL_CONFIG_MISMATCH');
  const history=await historySnapshots(paths);
  const identity=(manifest,id)=>({id:manifest[id],manifest_sha256:digest(manifest)});
  const sourceManifest={score_sources_schema_version:1,source_ids:sourceIds,
    diagnostic_plan:identity(parentPlan.manifest,'diagnostic_plan_id'),diagnostic_result:identity(parentResult.manifest,'diagnostic_id'),
    source_runtime:{id:sourceRuntime.runtime_bundle_id,manifest_sha256:sourceRuntime.manifest_sha256},
    runtime:{id:runtime.runtime_bundle_id,manifest_sha256:runtime.manifest_sha256},
    control_config_sha256:input.sensitivity.baseConfig.sha256,history_registry_sha256:hash(await readSafe(paths.historyLedgers)),
    history_prefixes:history.history.map(({key,sequence,sha256})=>({key,sequence,sha256}))};
  return {paths,root,runtime,sourceRuntime,input,cohort:input.cohort,parentPlan,parentResult,sourceManifest};
}
export async function checkScoreSources(loaded,frozen) {
  for(const key of SOURCE_KEYS)if(digest(await fingerprintSourcePackage(loaded.paths[key]))!==frozen.source_ids[key].package_fingerprint_sha256)fail('SCORE_SOURCE_CHANGED');
  for(const [key,id] of [['diagnosticPlan',frozen.diagnostic_plan],['diagnosticResult',frozen.diagnostic_result]]) {
    const checked=await inspectDiagnostic(loaded.paths[key]);if(digest(checked.manifest)!==id.manifest_sha256)fail('SCORE_PARENT_CHANGED');
  }
  for(const [key,id] of [['sourceRuntime',frozen.source_runtime],['runtimeBundle',frozen.runtime]]) {
    const runtime=await verifyBundle(loaded.paths[key],{requireEnvironment:true});if(runtime.manifest_sha256!==id.manifest_sha256)fail('SCORE_RUNTIME_CHANGED');
  }
  if(canonicalJson(await fingerprintExecutionRoot(loaded.root))!==canonicalJson(JSON.parse(await readSafe(path.join(loaded.paths.runtimeBundle,'file_inventory.json')))))fail('SCORE_RUNTIME_SOURCE_MISMATCH');
  if(hash(await readSafe(loaded.paths.historyLedgers))!==frozen.history_registry_sha256)fail('SCORE_HISTORY_CHANGED');
  const histories=await historySnapshots(loaded.paths);
  if(canonicalJson(histories.history.map(h=>h.key))!==canonicalJson(frozen.history_prefixes.map(h=>h.key)))fail('SCORE_HISTORY_CHANGED');
  for(const prefix of frozen.history_prefixes)if(!ledgerPrefixMatches(histories.history.find(h=>h.key===prefix.key),prefix))fail('SCORE_HISTORY_CHANGED');
}
export const recordScoreAccess=(loaded,id,stage)=>recordDiagnosticAccess(loaded,id,`SCORE_DIAGNOSTIC_${stage}`,'SCORE_DIAGNOSTICS_TRAIN_ONLY');
export async function sourceControl(loaded,options) {
  return JSON.parse((await nodeProcess(path.join(loaded.runtime.source,'tools/score-diagnostics/compatibility-worker.mjs'),
    ['--sources',options.sources],{cwd:loaded.runtime.source})).trim());
}
