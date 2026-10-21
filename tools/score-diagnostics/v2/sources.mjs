import path from 'node:path';
import { canonicalJson, fail, hash, readSafe, safePath, within } from '../../dataset/lib/common.mjs';
import { loadModelHeader, readSplitRows } from '../../tuning/lib/input.mjs';
import { fingerprintSourcePackage } from '../../optimization/lib/input.mjs';
import { verifyBundle, fingerprintExecutionRoot } from '../../experiment-runtime/lib/bundle.mjs';
import { inspectGovernancePackage } from '../../experiment-runtime/lib/package.mjs';
import { inspectScoreDiagnostic } from '../package.mjs';
import { historySnapshots, withHistoryLocks } from '../../campaign/campaign.mjs';
import { appendLedger, ledgerPrefixMatches } from '../../validation/lib/disclosure.mjs';
import { APP_ROOT } from '../../tuning/lib/engine-runtime.mjs';
import { scoreToOrdinal } from '../../evaluation/metrics.mjs';
import { auditTemporalSnapshot, temporalContract } from './temporal.mjs';
import { digest, assertSame, memberRows } from './common.mjs';

export const UPSTREAM_KEYS=['raw','gt','model','baseline','sensitivity'];
export const ARTIFACT_KEYS=['diagnosticPlan','diagnosticResult','parentPlan','parentResult'];
export const RUNTIME_KEYS=['sourceRuntime','parentRuntime','runtimeBundle'];
export const V2_SOURCE_KEYS=[...UPSTREAM_KEYS,...ARTIFACT_KEYS,...RUNTIME_KEYS,'historyLedgers','accessLedger'];
export const MODEL_STATISTICAL_ALLOWLIST=['manifest.json','schema.json','policy.json','splits/train.csv'];
const CODE_CONTRACT_FILES=['js/cloud_field.js','js/data.js','js/engine.js','js/nowcast.js','js/evolution.js','js/replay_service.js','js/time.js','js/prediction_service.js','tools/replay/replay-runner.mjs'];
export async function readBoundarySources(file) {
  const doc=JSON.parse(await readSafe(file));
  if(doc.sources_schema_version!==2||V2_SOURCE_KEYS.some(k=>typeof doc[k]!=='string'||!doc[k])||
    Object.keys(doc).some(k=>!['sources_schema_version',...V2_SOURCE_KEYS].includes(k)))fail('INVALID_BOUNDARY_DIAGNOSTIC_SOURCES');
  return Object.fromEntries(V2_SOURCE_KEYS.map(k=>[k,path.resolve(path.dirname(file),doc[k])]));
}
export async function readBoundaryModelFile(directory,file,{readMonitor}={}) {
  if(!MODEL_STATISTICAL_ALLOWLIST.includes(file))fail('BOUNDARY_TRAIN_ACCESS_FORBIDDEN');
  readMonitor?.({phase:'STATISTICS',source:'model',file});
  return readSafe(path.join(directory,file));
}
async function runtimeState(paths,root) {
  const runtimes={};
  for(const key of RUNTIME_KEYS)runtimes[key]=await verifyBundle(paths[key],{requireEnvironment:true});
  assertSame(await fingerprintExecutionRoot(root),JSON.parse(await readSafe(path.join(paths.runtimeBundle,'file_inventory.json'))),'BOUNDARY_RUNTIME_SOURCE_MISMATCH');
  return runtimes;
}
const identity=(checked,idField)=>({id:checked.manifest[idField],manifest_sha256:digest(checked.manifest)});
export async function loadBoundarySources(options) {
  const paths=await readBoundarySources(options.sources),root=options.root||APP_ROOT;
  const pathIdentity=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  if(options.parent&&pathIdentity(options.parent)!==pathIdentity(paths.parentResult))fail('BOUNDARY_PARENT_PATH_SUBSTITUTION');
  const runtimes=await runtimeState(paths,root);
  const parent=await inspectScoreDiagnostic(paths.parentResult),parentPlan=await inspectScoreDiagnostic(paths.parentPlan);
  if(parent.manifest.score_diagnostic_schema_version!==1||parent.manifest.score_diagnostic_policy_version!==1||
    parent.manifest.descriptor.package_kind!=='score_diagnostic'||parentPlan.manifest.descriptor.package_kind!=='score_diagnostic_plan'||
    parent.files['decision.json'].execution_status!=='COMPLETED'||parent.files['reference_parity.json'].status!=='PASS'||
    parent.files['trace_compatibility.json'].status!=='PASS'||parent.manifest.score_diagnostic_plan_id!==parentPlan.manifest.score_diagnostic_plan_id||
    parent.manifest.score_diagnostic_plan_manifest_sha256!==digest(parentPlan.manifest))fail('BOUNDARY_PARENT_CONTRACT_INVALID');
  assertSame(parent.files['plan.json'],parentPlan.files['plan.json'],'BOUNDARY_PARENT_PLAN_MISMATCH');
  const inherited=parent.files['source_manifest.json'];
  for(const [key,frozen] of [['sourceRuntime',inherited.source_runtime],['parentRuntime',inherited.runtime]])
    if(runtimes[key].runtime_bundle_id!==frozen.id||runtimes[key].manifest_sha256!==frozen.manifest_sha256)fail('BOUNDARY_PARENT_RUNTIME_SUBSTITUTION');
  const artifacts={parentPlan:identity(parentPlan,'score_diagnostic_plan_id'),parentResult:identity(parent,'score_diagnostic_id')};
  for(const [key,frozen,idField] of [['diagnosticPlan',inherited.diagnostic_plan,'diagnostic_plan_id'],['diagnosticResult',inherited.diagnostic_result,'diagnostic_id']]) {
    const checked=await inspectGovernancePackage(paths[key]);
    if(checked.manifest[idField]!==frozen.id||digest(checked.manifest)!==frozen.manifest_sha256)fail('BOUNDARY_ANCESTOR_SUBSTITUTION');
    artifacts[key]=identity(checked,idField);
  }
  const fingerprints={},sourceIds={};
  for(const key of UPSTREAM_KEYS) {
    options.readMonitor?.({phase:'INTEGRITY_HASH_ONLY',source:key,file:'<ALL_IMMUTABLE_PACKAGE_BYTES>'});
    fingerprints[key]=await fingerprintSourcePackage(paths[key]);
    const frozen=inherited.source_ids[key];
    if(!frozen||digest(fingerprints[key])!==frozen.package_fingerprint_sha256||fingerprints[key]['manifest.json']!==frozen.manifest_sha256)fail('BOUNDARY_SOURCE_IDENTITY_MISMATCH');
    sourceIds[key]=frozen;
  }
  const histories=await historySnapshots(paths);
  if(hash(await readSafe(paths.historyLedgers))!==inherited.history_registry_sha256)fail('BOUNDARY_HISTORY_REGISTRY_SUBSTITUTION');
  for(const prefix of inherited.history_prefixes)if(!ledgerPrefixMatches(histories.history.find(h=>h.key===prefix.key),prefix))fail('BOUNDARY_PARENT_HISTORY_PREFIX_MISMATCH');
  const receipt=histories.history.flatMap(h=>h.rows).find(r=>r.action==='SCORE_DIAGNOSTIC_COMPLETED'&&r.result_id===parent.manifest.score_diagnostic_id&&
    r.plan_id===parent.manifest.score_diagnostic_plan_id&&r.payload_sha256===digest(parent.files));
  if(!receipt)fail('BOUNDARY_PARENT_PREPUBLICATION_RECEIPT_MISSING');
  const parentBinding={status:'PASS',parent_internal:'PASS',source_binding:'EXACT_FIVE_PACKAGE_FINGERPRINTS_AND_ANCESTOR_IDENTITIES',
    prior_recompute_receipt:{status:'VERIFIED',scope:'PARENT_V1_PREPUBLICATION_FULL_PAYLOAD_RECOMPUTE',result_id:receipt.result_id,payload_sha256:receipt.payload_sha256},
    prior_separate_source_verify_receipt:'NOT_AVAILABLE_AS_IMMUTABLE_COMPLETION_RECEIPT',
    this_version_engine_replayed:false,this_version_pava_refitted:false,parent_score_diagnostic_id:parent.manifest.score_diagnostic_id};
  const codeInventory=JSON.parse(await readSafe(path.join(paths.parentRuntime,'file_inventory.json')));
  const codeIdentity=Object.fromEntries(CODE_CONTRACT_FILES.map(file=>[file,codeInventory[file]?.sha256]));
  if(Object.values(codeIdentity).some(v=>!v))fail('BOUNDARY_TEMPORAL_CODE_CONTRACT_UNAVAILABLE');
  // New analysis freezes the real scoring implementation, never silently substitutes a new engine.
  const currentInventory=await fingerprintExecutionRoot(root);
  for(const file of CODE_CONTRACT_FILES)if(currentInventory[file]?.sha256!==codeIdentity[file])fail('BOUNDARY_TEMPORAL_CODE_CONTRACT_CHANGED');
  const rawSchema=JSON.parse(await readSafe(path.join(paths.raw,'schema.json')));
  const gtPolicy=JSON.parse(await readSafe(path.join(paths.gt,'policy.json')));
  if(gtPolicy.gt_policy_version!==2)fail('BOUNDARY_GT_TARGET_CONTRACT_UNSUPPORTED');
  const contract=temporalContract(codeIdentity,rawSchema.tables.sunset_observations.map(f=>f.name),parentPlan.files['plan.json'].control_config);
  const header=await loadModelHeader(paths.model,{allowFiles:MODEL_STATISTICAL_ALLOWLIST});
  // Explicitly monitor the only Model tables exposed to the statistical phase.
  for(const file of MODEL_STATISTICAL_ALLOWLIST)await readBoundaryModelFile(paths.model,file,options);
  const train=await readSplitRows(paths.model,{...header,split:'TRAIN',allowFiles:MODEL_STATISTICAL_ALLOWLIST,progress:options.progress});
  assertSame(memberRows(train),parentPlan.files['plan.json'].train_members,'BOUNDARY_TRAIN_MEMBERS_CHANGED');
  const control=new Map(parent.files['reference_parity.json'].rows.map(r=>[r.snapshot_id,r]));
  const traces=new Map(parent.files['stage_trace.json'].map(r=>[r.snapshot_id,r.trace]));
  const oof=new Map(parent.files['oof_predictions.json'].map(r=>[r.snapshot_id,r]));
  if(control.size!==train.length||traces.size!==train.length)fail('BOUNDARY_PARENT_CONTROL_COVERAGE');
  const rows=[],temporal=[],alignment=[],reads=[];
  for(const original of train) {
    const reference=control.get(original.snapshot_id),trace=traces.get(original.snapshot_id),held=oof.get(original.snapshot_id);
    if(!reference?.pass||!Number.isInteger(reference.control_score)||trace?.final_score!==reference.control_score)fail('BOUNDARY_PARENT_CONTROL_INVALID');
    if(held&&(held.gt_ordinal!==original.gt_ordinal||held.gt_confidence!==original.gt_confidence||held.score!==reference.control_score||
      held.event_id!==original.event_id||held.control_ordinal!==scoreToOrdinal(reference.control_score)))fail('BOUNDARY_PARENT_OOF_SUBSTITUTION');
    const row={...Object.fromEntries(['snapshot_id','event_id','location_key','event_date_local','latitude','longitude','timezone','sunset_time_utc',
      'prediction_time_utc','prediction_time_epoch','lead_time_minutes','lead_time_bucket','regime_label','gt_ordinal','gt_confidence','gt_basis','gt_status']
      .map(k=>[k,original[k]])),score:reference.control_score,control_ordinal:scoreToOrdinal(reference.control_score),in_oof:!!held};
    row.error_direction=row.control_ordinal>row.gt_ordinal?'OVER':row.control_ordinal<row.gt_ordinal?'UNDER':'EXACT';
    const replayPath=await safePath(path.resolve(paths.raw,original.replay_path));
    if(!within(paths.raw,replayPath))fail('BOUNDARY_REPLAY_PATH_ESCAPE');
    options.readMonitor?.({phase:'STATISTICS',source:'TRAIN_REPLAY',file:original.replay_path,snapshot_id:original.snapshot_id});
    const replay=JSON.parse(await readSafe(replayPath));
    if(replay.replay_schema_version!==1||['snapshot_id','event_id','config_hash','engine_build_sha','prediction_time_utc'].some(k=>replay.identity?.[k]!==original[k]))fail('BOUNDARY_REPLAY_IDENTITY_MISMATCH');
    const evidence=auditTemporalSnapshot(row,replay,trace,contract);
    rows.push(row);temporal.push(...evidence.judgments);alignment.push(...evidence.alignment);
    reads.push({snapshot_id:row.snapshot_id,event_id:row.event_id,replay_path:path.relative(paths.raw,replayPath).split(path.sep).join('/'),replay_sha256:evidence.replay_sha256,
      projected_fields_sha256:digest({judgments:evidence.judgments,alignment:evidence.alignment}),split:'TRAIN'});
    options.progress?.update(`读取既有分数与 TRAIN 时间证据 ${rows.length}/${train.length}`);
  }
  const sourceManifest={score_sources_schema_version:2,source_ids:sourceIds,artifacts,
    runtimes:Object.fromEntries(RUNTIME_KEYS.map(k=>[k,{id:runtimes[k].runtime_bundle_id,manifest_sha256:runtimes[k].manifest_sha256}])),
    parent_control_config_sha256:parentPlan.files['plan.json'].control_config_sha256,parent_mappings_sha256:digest(parent.files['fold_calibrators.json']),
    parent_binding_sha256:digest(parentBinding),history_registry_sha256:hash(await readSafe(paths.historyLedgers)),
    history_prefixes:histories.history.map(({key,sequence,sha256})=>({key,sequence,sha256}))};
  return {paths,root,runtimes,runtime:runtimes.runtimeBundle,parent,parentPlan,sourceManifest,parentBinding,rows,temporal,alignment,contract,
    accessScope:{computation_split:'TRAIN',integrity_phase:'COMPLETE_SOURCE_BYTES_HASHED_NOT_EFFECT_EVALUATED',model_statistics_allowlist:MODEL_STATISTICAL_ALLOWLIST,
      replay_field_allowlist:contract.projection_allowlist,train_replay_reads:reads,mixed_sample_effect_files_read:[],
      parent_effect_scope:'V1_TRAIN_ONLY_PAYLOADS',engine_replay_count:0,pava_fit_count:0,parameter_search_count:0}};
}
export async function checkBoundarySources(loaded,frozen) {
  for(const key of UPSTREAM_KEYS)if(digest(await fingerprintSourcePackage(loaded.paths[key]))!==frozen.source_ids[key].package_fingerprint_sha256)fail('BOUNDARY_SOURCE_CHANGED');
  for(const key of ARTIFACT_KEYS){const checked=await inspectGovernancePackage(loaded.paths[key]);if(digest(checked.manifest)!==frozen.artifacts[key].manifest_sha256)fail('BOUNDARY_PARENT_CHANGED');}
  const runtimes=await runtimeState(loaded.paths,loaded.root);
  for(const key of RUNTIME_KEYS)if(runtimes[key].manifest_sha256!==frozen.runtimes[key].manifest_sha256)fail('BOUNDARY_RUNTIME_CHANGED');
  if(hash(await readSafe(loaded.paths.historyLedgers))!==frozen.history_registry_sha256)fail('BOUNDARY_HISTORY_CHANGED');
  const histories=await historySnapshots(loaded.paths);
  assertSame(histories.history.map(h=>h.key),frozen.history_prefixes.map(h=>h.key),'BOUNDARY_HISTORY_CHANGED');
  for(const prefix of frozen.history_prefixes)if(!ledgerPrefixMatches(histories.history.find(h=>h.key===prefix.key),prefix))fail('BOUNDARY_HISTORY_CHANGED');
}
export async function recordBoundaryAccess(loaded,planId,stage) {
  const history=await historySnapshots(loaded.paths);
  return withHistoryLocks(history.roots,async()=>{
    const distinct=new Map(Object.values(history.roots).map(root=>[process.platform==='win32'?path.resolve(root).toLowerCase():path.resolve(root),root]));
    for(const root of distinct.values())await appendLedger(root,{action:'TRAIN_EFFECT_ACCESS',stage,plan_id:planId,
      parent_score_diagnostic_id:loaded.parent.manifest.score_diagnostic_id,result_usage:'DEVELOPMENT_ONLY',
      purpose:'BOUNDARY_MAPPING_LEAD_TEMPORAL_DIAGNOSTICS_NO_REFIT_NO_REPLAY',members:memberRows(loaded.rows)});
  });
}
