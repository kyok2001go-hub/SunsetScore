import path from 'node:path';
import {canonicalJson,compare,fail,hash,readSafe,safePath,within} from '../dataset/lib/common.mjs';
import {parseCsv,readCsv} from '../dataset/lib/csv.mjs';
import {fingerprintSourcePackage} from '../optimization/lib/input.mjs';
import {buildSearchSpace} from '../optimization/lib/search-space.mjs';
import {canonicalizeCandidate} from '../optimization/lib/candidate.mjs';
import {loadModelHeader,readSplitRows,candidateAllowFiles} from '../tuning/lib/input.mjs';
import {APP_ROOT} from '../tuning/lib/engine-runtime.mjs';
import {verifyBundle,fingerprintExecutionRoot} from '../experiment-runtime/lib/bundle.mjs';
import {inspectGovernancePackage} from '../experiment-runtime/lib/package.mjs';
import {inspectScoreDiagnostic} from '../score-diagnostics/package.mjs';
import {historySnapshots,withHistoryLocks} from '../campaign/campaign.mjs';
import {appendLedger,ledgerPrefixMatches} from '../validation/lib/disclosure.mjs';
import {CSV_TABLES as VALIDATION_TABLES} from '../validation/validation-schema.mjs';
import {scoreToOrdinal} from '../evaluation/metrics.mjs';
import {digest,productPolicy} from './policy.mjs';
import {mappingAudit} from './mapping.mjs';
export const UPSTREAM=['raw','gt','model','baseline','sensitivity'];
export const ARTIFACTS=['diagnosticPlan','diagnosticResult','scorePlan','scoreResult'];
export const RUNTIMES=['sourceRuntime','scoreRuntime','runtimeBundle'];
const REQUIRED=[...UPSTREAM,...ARTIFACTS,...RUNTIMES,'historyLedgers','accessLedger'];
export const memberRows=rows=>[...rows].sort((a,b)=>compare(a.snapshot_id,b.snapshot_id)).map(({snapshot_id,event_id,location_key,event_date_local})=>({snapshot_id,event_id,location_key,event_date_local}));
const same=(a,b,code)=>{if(digest(a)!==digest(b))fail(code);};
export async function readProductSources(file){
  const doc=JSON.parse(await readSafe(file));if(doc.sources_schema_version!==1||REQUIRED.some(k=>typeof doc[k]!=='string'||!doc[k])||
    ['fixedOptimizations','fixedValidations'].some(k=>!Array.isArray(doc[k])||doc[k].some(v=>typeof v!=='string'||!v))||
    (doc.rawParent!=null&&typeof doc.rawParent!=='string')||Object.keys(doc).some(k=>!['sources_schema_version',...REQUIRED,'fixedOptimizations','fixedValidations','rawParent'].includes(k)))fail('INVALID_PRODUCT_SOURCES');
  const resolve=v=>path.resolve(path.dirname(file),v);return {...Object.fromEntries(REQUIRED.map(k=>[k,resolve(doc[k])])),
    fixedOptimizations:doc.fixedOptimizations.map(resolve),fixedValidations:doc.fixedValidations.map(resolve),rawParent:doc.rawParent?resolve(doc.rawParent):null};
}
export async function readProductModel(directory,split,options={}){
  if(!['TRAIN','VALIDATION'].includes(split))fail('PRODUCT_TEST_EFFECT_ACCESS_FORBIDDEN');
  const allowFiles=candidateAllowFiles(split);for(const file of allowFiles)options.readMonitor?.({phase:'EFFECT_MODEL',split,file});
  const header=await loadModelHeader(directory,{allowFiles,progress:options.progress});return readSplitRows(directory,{...header,allowFiles,split,progress:options.progress});
}
/** Project structural TEST membership immediately; outcome/score/label columns never leave this reader. */
export async function structuralMembers(directory,split,monitor){
  if(!['TRAIN','VALIDATION','TEST'].includes(split))fail('PRODUCT_INVALID_SPLIT');
  const file=`splits/${split.toLowerCase()}.csv`;monitor?.({phase:'STRUCTURE_ONLY',split,file,fields:['snapshot_id','event_id','location_key','event_date_local','split']});
  const records=parseCsv((await readSafe(path.join(directory,file))).toString('utf8')),header=records.shift().map(c=>c.value),fields=['snapshot_id','event_id','location_key','event_date_local','split'];
  if(fields.some(k=>!header.includes(k)))fail('PRODUCT_STRUCTURAL_FIELDS_MISSING');
  const out=records.map(row=>Object.fromEntries(fields.map(k=>[k,row[header.indexOf(k)]?.value])));
  if(out.some(r=>r.split!==split)||new Set(out.map(r=>r.snapshot_id)).size!==out.length)fail('PRODUCT_STRUCTURAL_SPLIT_INVALID');return memberRows(out);
}
async function rawLineage(paths){
  const manifest=JSON.parse(await readSafe(path.join(paths.raw,'manifest.json'))),ex=manifest.selection?.replay_exclusion;
  if(!ex)return {status:'SOURCE_EVIDENCE_GAP',reason_code:'EXCLUSION_DECLARATION_NOT_FOUND',derived_raw_id:manifest.dataset_id};
  let parent=null;if(paths.rawParent){try{const bytes=await readSafe(path.join(paths.rawParent,'manifest.json'));parent={manifest_sha256:hash(bytes),manifest:JSON.parse(bytes)};}catch(e){if(e.code!=='ENOENT')throw e;}}
  if(parent&&(parent.manifest.dataset_id!==ex.parent_dataset_id||parent.manifest_sha256!==ex.parent_manifest_sha256))fail('PRODUCT_RAW_PARENT_MISMATCH');
  const records=ex.records||[];
  let membership=null;
  if(parent){
    const ids=async(directory,m)=>{const file='raw/prediction_snapshots.csv',bytes=await readSafe(path.join(directory,file));
      if(hash(bytes)!==m.files[file]?.sha256)fail('PRODUCT_RAW_SNAPSHOT_BYTES_CHANGED');const csv=parseCsv(bytes.toString('utf8')),header=csv.shift().map(c=>c.value),column=header.indexOf('id');
      if(column<0)fail('PRODUCT_RAW_SNAPSHOT_ID_MISSING');const values=csv.map(r=>r[column].value);if(new Set(values).size!==values.length)fail('PRODUCT_RAW_DUPLICATE_SNAPSHOT');return new Set(values);};
    const before=await ids(paths.rawParent,parent.manifest),after=await ids(paths.raw,manifest),removed=[...before].filter(id=>!after.has(id)).sort(compare),declared=records.map(r=>r.snapshot_id).sort(compare);
    if([...after].some(id=>!before.has(id))||digest(removed)!==digest(declared))fail('PRODUCT_RAW_EXCLUSION_MEMBERSHIP_MISMATCH');
    membership={status:'PASS',parent_snapshot_count:before.size,derived_snapshot_count:after.size,actual_removed_snapshot_ids:removed,actual_removed_count:removed.length};
  }
  return {status:parent?'PASS':'SOURCE_EVIDENCE_GAP',derived_raw_id:manifest.dataset_id,parent_dataset_id:ex.parent_dataset_id,parent_manifest_sha256:ex.parent_manifest_sha256,
    parent_manifest_available:!!parent,exclusion_manifest_records_sha256:digest(records),excluded_snapshot_count:records.length,
    excluded_snapshot_ids:records.map(r=>r.snapshot_id).sort(compare),declared_decision:ex.decision,declared_reason_code:ex.reason_code,
    membership_check:membership,reason_code:parent?null:'PARENT_MANIFEST_NOT_AVAILABLE_NO_REASON_INFERRED',no_new_raw_derivation:true};
}
export async function loadProductSources(options){
  const paths=await readProductSources(options.sources),root=options.root||APP_ROOT;
  const pathKey=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
  for(const key of REQUIRED)if(options[key]&&pathKey(options[key])!==pathKey(paths[key]))fail('PRODUCT_SOURCE_PATH_SUBSTITUTION');
  const runtimes={};for(const key of RUNTIMES)runtimes[key]=await verifyBundle(paths[key],{requireEnvironment:true});
  if(runtimes.runtimeBundle.descriptor.engine_runtime_sha256!==runtimes.scoreRuntime.descriptor.engine_runtime_sha256)fail('PRODUCT_SCORING_ENGINE_CHANGED');
  same(await fingerprintExecutionRoot(root),JSON.parse(await readSafe(path.join(paths.runtimeBundle,'file_inventory.json'))),'PRODUCT_RUNTIME_SOURCE_MISMATCH');
  const score=await inspectScoreDiagnostic(paths.scoreResult),scorePlan=await inspectScoreDiagnostic(paths.scorePlan),diagnostic=await inspectGovernancePackage(paths.diagnosticResult),diagnosticPlan=await inspectGovernancePackage(paths.diagnosticPlan);
  if(score.manifest.score_diagnostic_schema_version!==1||score.files['reference_parity.json'].status!=='PASS'||score.files['trace_compatibility.json'].status!=='PASS'||score.manifest.score_diagnostic_plan_id!==scorePlan.manifest.score_diagnostic_plan_id||score.manifest.score_diagnostic_plan_manifest_sha256!==digest(scorePlan.manifest))fail('PRODUCT_SCORE_PARENT_INVALID');
  const inherited=score.files['source_manifest.json'];same(score.files['plan.json'],scorePlan.files['plan.json'],'PRODUCT_SCORE_PLAN_MISMATCH');
  for(const [key,checked,idField,frozen] of [['diagnosticResult',diagnostic,'diagnostic_id',inherited.diagnostic_result],['diagnosticPlan',diagnosticPlan,'diagnostic_plan_id',inherited.diagnostic_plan]])
    if(checked.manifest[idField]!==frozen.id||digest(checked.manifest)!==frozen.manifest_sha256)fail('PRODUCT_ANCESTOR_MISMATCH');
  for(const [key,frozen] of [['sourceRuntime',inherited.source_runtime],['scoreRuntime',inherited.runtime]])if(runtimes[key].runtime_bundle_id!==frozen.id||runtimes[key].manifest_sha256!==frozen.manifest_sha256)fail('PRODUCT_PARENT_RUNTIME_MISMATCH');
  const sourceIds={};for(const key of UPSTREAM){options.readMonitor?.({phase:'INTEGRITY_HASH_ONLY',source:key});const fp=await fingerprintSourcePackage(paths[key]);if(digest(fp)!==inherited.source_ids[key].package_fingerprint_sha256)fail('PRODUCT_UPSTREAM_CHANGED');sourceIds[key]=inherited.source_ids[key];}
  const artifacts={};for(const [key,checked] of Object.entries({diagnosticPlan,diagnosticResult:diagnostic,scorePlan,scoreResult:score}))artifacts[key]={id:checked.manifest[checked.manifest.id_field],manifest_sha256:digest(checked.manifest)};
  const legacy={};for(const kind of ['fixedOptimizations','fixedValidations'])for(const directory of paths[kind]){
    options.readMonitor?.({phase:'INTEGRITY_HASH_ONLY',source:kind});const fp=await fingerprintSourcePackage(directory),manifest=JSON.parse(await readSafe(path.join(directory,'manifest.json')));
    if((manifest.model_dataset_id||manifest.source_ids?.model?.id)!==sourceIds.model.id||manifest.test_evaluated===true)fail('PRODUCT_FOREIGN_OR_TEST_LEGACY_SOURCE');
    const id=manifest.optimization_id||manifest.validation_id;if(!id||legacy[id])fail('PRODUCT_LEGACY_ID_INVALID');
    if(kind==='fixedOptimizations')await (await import('../optimization/validate-optimization.mjs')).inspectOptimization(directory);
    legacy[id]={directory,kind,manifest,fingerprint_sha256:digest(fp)};
  }
  const train=await readProductModel(paths.model,'TRAIN',options);same(memberRows(train),scorePlan.files['plan.json'].train_members,'PRODUCT_TRAIN_MEMBERS_CHANGED');
  const modelHeader=JSON.parse(await readSafe(path.join(paths.model,'manifest.json'))),structural={};for(const split of ['TRAIN','VALIDATION','TEST'])structural[split]=await structuralMembers(paths.model,split,options.readMonitor);
  const seen=new Set(),locations=new Map(),eventSplits=new Map();for(const [split,rows] of Object.entries(structural))for(const r of rows){const key=`${r.location_key}/${r.event_date_local}`;if(seen.has(r.snapshot_id)||locations.has(key)&&locations.get(key)!==split||eventSplits.has(r.event_id)&&eventSplits.get(r.event_id)!==split)fail('PRODUCT_SPLIT_OVERLAP');seen.add(r.snapshot_id);locations.set(key,split);eventSplits.set(r.event_id,split);}
  const histories=await historySnapshots(paths);if(hash(await readSafe(paths.historyLedgers))!==inherited.history_registry_sha256)fail('PRODUCT_HISTORY_REGISTRY_CHANGED');
  for(const prefix of inherited.history_prefixes)if(!ledgerPrefixMatches(histories.history.find(h=>h.key===prefix.key),prefix))fail('PRODUCT_HISTORY_PREFIX_CHANGED');
  const testIds=new Set(structural.TEST.map(r=>r.event_id)),testKeys=new Set(structural.TEST.map(r=>`${r.location_key}/${r.event_date_local}`));
  const exposure=[];for(const h of histories.history)for(const row of h.rows){const members=['members','event_members','validation_members','test_members','train_members'].flatMap(k=>Array.isArray(row[k])?row[k]:[]),overlap=members.filter(m=>testIds.has(m.event_id)||testKeys.has(`${m.location_key}/${m.event_date_local}`));
    if(overlap.length)exposure.push({ledger:h.key,sequence:row.sequence,action:row.action,declared_split:row.evaluated_split||row.split||null,overlap_event_count:new Set(overlap.map(m=>m.event_id)).size});}
  const testAudit={scope:'MEMBERS_SPLIT_AND_ACCESS_RECORDS_ONLY_NO_TEST_EFFECT',members:structural.TEST,members_sha256:digest(structural.TEST),overlap_with_train_validation:false,
    recorded_overlaps:exposure,exposure_status:exposure.length?'RECORDED_OVERLAP_REQUIRES_REVIEW':'UNKNOWN',independence_established:false,
    historical_tool_ranges:['LEGACY_UPSTREAM_PACKAGE_INTERNAL_READS_CAN_INCLUDE_TEST_BYTES_WITHOUT_EFFECT_EVALUATION','NO_OS_LEVEL_HISTORY_PROOF'],test_effect_evaluated:false,phase8_allowed:false};
  const registry=JSON.parse(await readSafe(path.join(paths.sensitivity,'parameter_registry.json'))),baseConfig=JSON.parse(await readSafe(path.join(paths.sensitivity,'tuning_base_config.json'))),linkage=JSON.parse(await readSafe(path.join(paths.sensitivity,'manifest.json')));
  if(digest(registry)!==linkage.parameter_registry_sha256||digest(baseConfig.config)!==baseConfig.sha256||baseConfig.sha256!==scorePlan.files['plan.json'].control_config_sha256)fail('PRODUCT_CONTROL_REGISTRY_MISMATCH');
  const searchSpace={...buildSearchSpace({mode:'EXPLORATORY_SEARCH',registry,readiness:{},baseConfig,linkage,policyVersion:5}),base_config:baseConfig};
  const sourceManifest={product_sources_schema_version:1,source_ids:sourceIds,artifacts,
    legacy_sources:Object.fromEntries(Object.entries(legacy).map(([id,v])=>[id,{id,manifest_sha256:digest(v.manifest),package_fingerprint_sha256:v.fingerprint_sha256,kind:v.kind}])),
    runtimes:Object.fromEntries(RUNTIMES.map(k=>[k,{id:runtimes[k].runtime_bundle_id,manifest_sha256:runtimes[k].manifest_sha256}])),
    history_registry_sha256:hash(await readSafe(paths.historyLedgers)),history_prefixes:histories.history.map(({key,sequence,sha256})=>({key,sequence,sha256})),
    raw_lineage_sha256:digest(await rawLineage(paths)),control_config_sha256:baseConfig.sha256};
  return {paths,root,runtime:runtimes.runtimeBundle,runtimes,sourceManifest,train,structural,score,scorePlan,diagnostic,diagnosticPlan,legacy,modelHeader,searchSpace,
    mapping:await mappingAudit(root),rawLineage:await rawLineage(paths),testAudit};
}
export async function checkProductSources(loaded,frozen){
  for(const ref of loaded.contextReferences||[])if(digest((await inspectGovernancePackage(ref.directory)).manifest)!==ref.manifest_sha256)fail('PRODUCT_CONTEXT_PACKAGE_CHANGED');
  for(const key of UPSTREAM)if(digest(await fingerprintSourcePackage(loaded.paths[key]))!==frozen.source_ids[key].package_fingerprint_sha256)fail('PRODUCT_SOURCE_CHANGED');
  for(const key of ARTIFACTS)if(digest((await inspectGovernancePackage(loaded.paths[key])).manifest)!==frozen.artifacts[key].manifest_sha256)fail('PRODUCT_ANCESTOR_CHANGED');
  for(const [id,v] of Object.entries(loaded.legacy))if(digest(await fingerprintSourcePackage(v.directory))!==frozen.legacy_sources[id].package_fingerprint_sha256)fail('PRODUCT_LEGACY_CHANGED');
  for(const key of RUNTIMES)if((await verifyBundle(loaded.paths[key],{requireEnvironment:true})).manifest_sha256!==frozen.runtimes[key].manifest_sha256)fail('PRODUCT_RUNTIME_CHANGED');
  same(await fingerprintExecutionRoot(loaded.root),JSON.parse(await readSafe(path.join(loaded.paths.runtimeBundle,'file_inventory.json'))),'PRODUCT_RUNTIME_SOURCE_MISMATCH');
  if(hash(await readSafe(loaded.paths.historyLedgers))!==frozen.history_registry_sha256||digest(await rawLineage(loaded.paths))!==frozen.raw_lineage_sha256)fail('PRODUCT_HISTORY_OR_RAW_LINEAGE_CHANGED');
  const histories=await historySnapshots(loaded.paths);same(histories.history.map(h=>h.key),frozen.history_prefixes.map(h=>h.key),'PRODUCT_HISTORY_CHANGED');for(const prefix of frozen.history_prefixes)if(!ledgerPrefixMatches(histories.history.find(h=>h.key===prefix.key),prefix))fail('PRODUCT_HISTORY_CHANGED');
}
export async function recordProductAccess(loaded,planId,stage,splits=['TRAIN']){
  const histories=await historySnapshots(loaded.paths);return withHistoryLocks(histories.roots,async()=>{const roots=new Map(Object.values(histories.roots).map(r=>[process.platform==='win32'?path.resolve(r).toLowerCase():path.resolve(r),r]));for(const root of roots.values())for(const split of splits)await appendLedger(root,{action:split==='TRAIN'?'TRAIN_EFFECT_ACCESS':'VALIDATION_EFFECT_ACCESS',
    evaluated_split:split,stage,plan_id:planId,parent_score_diagnostic_id:loaded.score.manifest.score_diagnostic_id,model_dataset_id:loaded.sourceManifest.source_ids.model.id,
    result_usage:'DEVELOPMENT_ONLY',purpose:'PRODUCT_EVALUATION_POLICY_1_NO_TEST',members:loaded.structural[split]});});
}
export async function loadProductReplays(loaded,rows,monitor){
  const out=[];for(const row of rows){const file=await safePath(path.resolve(loaded.paths.raw,row.replay_path));if(!within(loaded.paths.raw,file))fail('PRODUCT_REPLAY_ESCAPE');
    monitor?.({phase:'REPLAY',split:row.split,snapshot_id:row.snapshot_id});const bytes=await readSafe(file),replay=JSON.parse(bytes);
    if(replay.replay_schema_version!==1||['snapshot_id','event_id','config_hash','engine_build_sha','prediction_time_utc'].some(k=>replay.identity?.[k]!==row[k]))fail('PRODUCT_REPLAY_IDENTITY_MISMATCH');out.push({...row,replay});}
  return out;
}
export function candidateFromVector(loaded,vector,scope){const c=canonicalizeCandidate({vector,searchSpace:loaded.searchSpace,baseConfig:loaded.searchSpace.base_config,optimizationInputId:scope});if(!c.ok)fail('PRODUCT_FROZEN_CANDIDATE_INVALID');return c;}
export async function frozenRoster(loaded){
  const matrix=loaded.diagnostic.files['matrix_metrics.json'],roster=matrix.map(r=>({panel:'TRAIN_FIXED',source_id:loaded.diagnostic.manifest.diagnostic_id,candidate_id:r.candidate.candidate_id,label:r.label,
    candidate:candidateFromVector(loaded,r.candidate.canonical_vector,'PRODUCT_REASSESSMENT'),legacy_classification:r.quality,availability:'AVAILABLE_MATRIX_ROWS'}));
  for(const [id,legacy] of Object.entries(loaded.legacy)){
    if(legacy.kind==='fixedOptimizations'){
      const points=JSON.parse(await readSafe(path.join(legacy.directory,'search_points.json'))).points||[];
      for(const point of points){const c=point.candidate||point;if(!c.canonical_vector)fail('PRODUCT_LEGACY_CANDIDATE_INVALID');roster.push({panel:'TRAIN_FIXED',source_id:id,candidate_id:c.candidate_id,label:'LEGACY_FROZEN_SEARCH_POINT',
        candidate:candidateFromVector(loaded,c.canonical_vector,'PRODUCT_REASSESSMENT'),legacy_classification:'UNCHANGED_LEGACY_EXPLORATORY',availability:'PREDICTIONS_UNAVAILABLE'});}
    }else for(const c of legacy.manifest.coverage_by_candidate||[])roster.push({panel:'OLD_VALIDATION_FIXED',source_id:id,candidate_id:c.candidate_id,label:'LEGACY_FROZEN_VALIDATION_CANDIDATE',availability:'AVAILABLE_VALIDATION_ROWS',legacy_classification:'UNCHANGED_LEGACY_VALIDATION'});
  }
  roster.push({panel:'PROCESS_OOF',source_id:loaded.score.manifest.score_diagnostic_id,candidate_id:'V2546_PAVA_PROCESS',label:'THREE_FOLD_PAVA_NOT_ONE_CONFIGURATION',availability:'AVAILABLE_OOF'},
    {panel:'PROCESS_OOF',source_id:loaded.diagnostic.manifest.diagnostic_id,candidate_id:'V2545_SEARCH_PROCESS',label:'THREE_FOLD_SEARCH_NOT_ONE_CONFIGURATION',availability:'AVAILABLE_OOF'});
  return roster;
}
export async function legacyValidationRows(loaded,sourceId){const source=loaded.legacy[sourceId];if(!source||source.kind!=='fixedValidations')fail('PRODUCT_VALIDATION_SOURCE_UNDECLARED');
  const {inspectValidation}=await import('../validation/lib/package.mjs');await inspectValidation(source.directory);
  return {rows:readCsv(VALIDATION_TABLES['candidate_sample_predictions.csv'],await readSafe(path.join(source.directory,'candidate_sample_predictions.csv'))),
    gates:readCsv(VALIDATION_TABLES['candidate_guardrails.csv'],await readSafe(path.join(source.directory,'candidate_guardrails.csv'))),
    reference:readCsv(VALIDATION_TABLES['replay_reference_parity.csv'],await readSafe(path.join(source.directory,'replay_reference_parity.csv'))),policy_version:source.manifest.validation_policy_version};
}
