import path from 'node:path';
import {canonicalJson,fail,readSafe} from '../dataset/lib/common.mjs';
import {inspectGovernancePackage,publishGovernancePackage} from '../experiment-runtime/lib/package.mjs';
import {withGovernanceLeases} from '../experiment-runtime/lib/lease.mjs';
import {protectExternalReferences} from '../experiment-runtime/lib/references.mjs';
import {artifactDatasetRoot} from '../formal/contracts.mjs';
import {outside} from '../tuning/lib/input.mjs';
import {nodeProcess} from '../experiment-runtime/lib/bundle.mjs';
import {withPlanLock,recordLedger,appendLedger} from '../validation/lib/disclosure.mjs';
import {historySnapshots,withHistoryLocks} from '../campaign/campaign.mjs';
import {optimizationPolicy} from '../optimization/optimization-policy.mjs';
import {validationPolicy} from '../validation/validation-policy.mjs';
import {productPolicy,productSchema,digest} from './policy.mjs';
import {loadProductSources,checkProductSources,recordProductAccess,readProductSources,UPSTREAM,ARTIFACTS,RUNTIMES,candidateFromVector} from './sources.mjs';
import {makeProductPlan,computeReassessment} from './workflow.mjs';
import {computeProductSearch} from './search.mjs';
import {computeProductValidation} from './validation.mjs';
const PLAN_KINDS=['product_evaluation_plan','optimization_search_plan','product_validation_plan'];
const SPECS={product_evaluation_plan:{id:'product_plan_id',files:productSchema().plan_files},product_evaluation:{id:'product_evaluation_id',files:productSchema().result_files},
  optimization_search_plan:{id:'optimization_plan_id',files:['schema.json','policy.json','product_policy.json','plan.json','source_manifest.json']},
  optimization:{id:'optimization_id',files:optimizationPolicy(5).package.export_files},
  product_validation_plan:{id:'product_validation_plan_id',files:['schema.json','policy.json','product_policy.json','plan.json','source_manifest.json']},
  validation:{id:'validation_id',files:validationPolicy(5).result_files}};
const same=(a,b,code)=>{if(digest(a)!==digest(b))fail(code);};
function coreHash(plan){const {plan_core_sha256,...core}=plan;return digest(core);}
export async function inspectProductPackage(directory){
  const checked=await inspectGovernancePackage(directory),{manifest,files}=checked,kind=manifest.descriptor.package_kind,spec=SPECS[kind];
  if(!spec||manifest.id_field!==spec.id||manifest.result_usage!=='DEVELOPMENT_ONLY'||manifest.formal_capable!==false||manifest.formal_promotion_allowed!==false)fail('PRODUCT_PACKAGE_CONTRACT_INVALID');
  for(const [key,value]of Object.entries(productManifestLinks({sourceManifest:files['source_manifest.json']})))same(manifest[key],value,'PRODUCT_MANIFEST_SOURCE_BINDING_INVALID');
  same(Object.keys(files).sort(),[...spec.files].sort(),'PRODUCT_PACKAGE_INVENTORY_INVALID');same(files['product_policy.json'],productPolicy(),'PRODUCT_POLICY_CHANGED');
  if(files['plan.json'].plan_core_sha256!==coreHash(files['plan.json'])||files['plan.json'].product_policy_sha256!==digest(productPolicy())||
    files['plan.json'].source_manifest_sha256!==digest(files['source_manifest.json'])||files['plan.json'].result_usage!=='DEVELOPMENT_ONLY'||files['plan.json'].formal_capable!==false)fail('PRODUCT_PLAN_INVALID');
  if(kind.startsWith('product_evaluation')){
    same(files['schema.json'],productSchema(),'PRODUCT_SCHEMA_CHANGED');if(manifest.product_evaluation_schema_version!==1||manifest.product_evaluation_policy_version!==1)fail('UNSUPPORTED_PRODUCT_VERSION');
    const plan=files['plan.json'];if(plan.roster_sha256!==digest(plan.roster)||plan.mapping_audit_sha256!==digest(files['mapping_audit.json'])||plan.raw_lineage_sha256!==digest(files['raw_lineage_audit.json'])||plan.test_access_audit_sha256!==digest(files['test_access_audit.json']))fail('PRODUCT_PLAN_BINDING_INVALID');
  }else if(kind==='optimization'||kind==='optimization_search_plan'){
    if(manifest.optimization_schema_version!==2||manifest.optimization_policy_version!==5)fail('UNSUPPORTED_PRODUCT_OPTIMIZATION_VERSION');same(files['policy.json'],optimizationPolicy(5),'PRODUCT_OPTIMIZATION_POLICY_CHANGED');
    same(files['schema.json'],{optimization_schema_version:2,optimization_policy_version:5,...(kind==='optimization'?{files:optimizationPolicy(5).package.export_files}:{})},'PRODUCT_OPTIMIZATION_SCHEMA_CHANGED');
  }else {
    if(manifest.validation_schema_version!==2||manifest.validation_policy_version!==5)fail('UNSUPPORTED_PRODUCT_VALIDATION_VERSION');same(files['policy.json'],validationPolicy(5),'PRODUCT_VALIDATION_POLICY_CHANGED');
    same(files['schema.json'],{validation_schema_version:2,validation_policy_version:5,...(kind==='validation'?{files:validationPolicy(5).result_files}:{})},'PRODUCT_VALIDATION_SCHEMA_CHANGED');
  }
  if(!kind.startsWith('product_evaluation'))for(const key of ['product_plan_id','product_plan_manifest_sha256','product_evaluation_id','product_evaluation_manifest_sha256'])if(manifest[key]!==files['plan.json'][key])fail('PRODUCT_CONTEXT_LINK_CHANGED');
  if(!PLAN_KINDS.includes(kind)){
    const d=files['decision.json'];if(d.selected!==null||d.formal_promotion_allowed!==false||d.phase8_ready!==false||d.result_usage!=='DEVELOPMENT_ONLY')fail('PRODUCT_PROMOTION_FORBIDDEN');
    if(kind==='optimization'&&(d.total_proposals>400||files['final_candidates.json'].length>5||files['final_candidates.json'].some(c=>!c.eligibility.development_qualified)))fail('PRODUCT_SEARCH_CONTRACT_INVALID');
    if(kind==='validation'&&(files['plan.json'].candidates.length>5||files['plan.json'].candidates_sha256!==digest(files['plan.json'].candidates)))fail('PRODUCT_VALIDATION_LIST_INVALID');
  }
  return {...checked,[manifest.id_field]:manifest[manifest.id_field],summary:files['decision.json']||{},validation_scope:'PACKAGE_INTERNAL'};
}
export async function withProductLeases(options,operation){
  const paths=await readProductSources(options.sources),output=path.resolve(options.output||'dataset/product_evaluation');
  const sourcePaths=[...UPSTREAM,...ARTIFACTS,...RUNTIMES].map(k=>paths[k]).concat(paths.fixedOptimizations,paths.fixedValidations,paths.rawParent||[],
    [options.plan,options.input,options.productPlan,options.productResult,options.optimization].filter(Boolean));
  await outside(output,sourcePaths);
  const histories=await historySnapshots(paths),roots=[path.dirname(output),...sourcePaths.map(p=>p===paths.raw||p===paths.rawParent?path.resolve(p,'../..'):artifactDatasetRoot(p)),...Object.values(histories.roots).map(p=>path.resolve(p,'../..'))];
  return withGovernanceLeases('product_evaluation',roots,async()=>{await protectExternalReferences(roots.slice(1),output);return operation(output);});
}
export function productManifestLinks(loaded){const s=loaded.sourceManifest;return {product_evaluation_schema_version:1,product_evaluation_policy_version:1,result_usage:'DEVELOPMENT_ONLY',formal_capable:false,formal_promotion_allowed:false,
  source_ids:s.source_ids,legacy_source_ids:s.legacy_sources,runtime_bundle_id:s.runtimes.runtimeBundle.id,runtime_bundle_manifest_sha256:s.runtimes.runtimeBundle.manifest_sha256,
  source_runtime_bundle_id:s.runtimes.sourceRuntime.id,source_runtime_bundle_manifest_sha256:s.runtimes.sourceRuntime.manifest_sha256,
  parent_runtime_bundle_id:s.runtimes.scoreRuntime.id,parent_runtime_bundle_manifest_sha256:s.runtimes.scoreRuntime.manifest_sha256,
  diagnostic_plan_id:s.artifacts.diagnosticPlan.id,diagnostic_plan_manifest_sha256:s.artifacts.diagnosticPlan.manifest_sha256,
  diagnostic_id:s.artifacts.diagnosticResult.id,diagnostic_manifest_sha256:s.artifacts.diagnosticResult.manifest_sha256,
  parent_score_diagnostic_plan_id:s.artifacts.scorePlan.id,parent_score_diagnostic_plan_manifest_sha256:s.artifacts.scorePlan.manifest_sha256,
  parent_score_diagnostic_id:s.artifacts.scoreResult.id,parent_score_diagnostic_manifest_sha256:s.artifacts.scoreResult.manifest_sha256,
  product_policy_sha256:digest(productPolicy())};}
async function publish(loaded,output,kind,payloads,extra={}){return publishGovernancePackage({output,kind,idField:SPECS[kind].id,payloads,
  links:{...productManifestLinks(loaded),...extra},sourceCheck:()=>checkProductSources(loaded,loaded.sourceManifest),validateStaging:inspectProductPackage});}
export async function planProductEvaluation(options){return withProductLeases(options,async output=>{
  const loaded=await loadProductSources(options);await recordProductAccess(loaded,'PRODUCT_PLAN_PREPARATION','PRODUCT_PLAN_TRAIN_CONSTANT_FREEZE');
  const plan=await makeProductPlan(loaded);
  return publish(loaded,path.join(output,'plans'),'product_evaluation_plan',{'schema.json':productSchema(),'product_policy.json':productPolicy(),'plan.json':plan,
    'source_manifest.json':loaded.sourceManifest,'mapping_audit.json':loaded.mapping,'raw_lineage_audit.json':loaded.rawLineage,'test_access_audit.json':loaded.testAudit});
});}
function stageFor(kind){return kind==='product_evaluation'?'reassess':kind==='optimization'?'search':'validation';}
export async function calculateProduct(options){
  const frozen=await inspectProductPackage(options.plan),kind=frozen.manifest.descriptor.package_kind;
  if(!PLAN_KINDS.includes(kind))fail('PRODUCT_PLAN_REQUIRED');
  const loaded=await loadProductSources(options),source=frozen.files['source_manifest.json'];await checkProductSources(loaded,source);loaded.sourceManifest=source;
  const plan=frozen.files['plan.json'];
  if(kind==='product_evaluation_plan')same(await makeProductPlan(loaded,source),plan,'PRODUCT_PLAN_SOURCE_CHANGED');
  else {
    const context=await readContext(options,loaded,plan);
    if(kind==='optimization_search_plan')same(await searchPlanCore(loaded,context),plan,'PRODUCT_SEARCH_PLAN_CHANGED');
    else same(await validationPlanCore(loaded,context,options,plan),plan,'PRODUCT_VALIDATION_PLAN_CHANGED');
    const action=kind==='optimization_search_plan'?'PRODUCT_SEARCH_PLAN_FROZEN':'PRODUCT_VALIDATION_LIST_FROZEN',history=await historySnapshots(loaded.paths);
    if(!history.history.flatMap(h=>h.rows).some(r=>r.action===action&&r.product_plan_id===plan.product_plan_id&&r.plan_core_sha256===plan.plan_core_sha256))fail('PRODUCT_FROZEN_ATTEMPT_RESERVATION_MISSING');
  }
  const resultKind=kind==='product_evaluation_plan'?'product_evaluation':kind==='optimization_search_plan'?'optimization':'validation';
  await recordProductAccess(loaded,frozen.manifest[frozen.manifest.id_field],options.stage||`PRODUCT_${stageFor(resultKind).toUpperCase()}`,
    resultKind==='product_evaluation'?(loaded.mapping.status==='PASS'&&plan.roster.some(r=>r.panel==='OLD_VALIDATION_FIXED')?['TRAIN','VALIDATION']:['TRAIN']):resultKind==='validation'?['VALIDATION']:['TRAIN']);
  const payloads=resultKind==='product_evaluation'?await computeReassessment(loaded,plan,options.progress):resultKind==='optimization'?await computeProductSearch(loaded,plan,{progress:options.progress}):await computeProductValidation(loaded,plan,{progress:options.progress});
  await checkProductSources(loaded,source);return {loaded,frozen,payloads,kind:resultKind};
}
export function compareProductRecompute(payloads,receipt,kind){if(receipt.payload_sha256!==digest(payloads)||receipt.scope!==(kind==='product_evaluation'?'FROZEN_PREDICTION_RESUMMARIZATION_NO_REPLAY':'FULL_PRODUCT_REPLAY_AND_STATISTICS'))fail('PRODUCT_RECOMPUTE_MISMATCH');}
export async function runProductArtifact(options){
  if(!options.plan||!options.sources)fail('PRODUCT_PLAN_AND_SOURCES_REQUIRED');
  if(!options.output){const m=JSON.parse(await readSafe(path.join(options.plan,'manifest.json'))),kind=m.descriptor?.package_kind;options={...options,output:path.resolve(kind==='optimization_search_plan'?'dataset/optimization':kind==='product_validation_plan'?'dataset/validation':'dataset/product_evaluation')};}
  return withProductLeases(options,output=>withPlanLock(output,path.basename(options.plan),async()=>{
  const calculated=await calculateProduct(options),{loaded,frozen,payloads,kind}=calculated;
  options.progress?.stage(kind==='product_evaluation'?'发布前新进程从冻结逐样本预测重新汇总':'发布前新进程完整 Replay 与产品统计重算');
  const rebuilt=JSON.parse((await nodeProcess(path.join(loaded.runtime.source,'tools/product-evaluation/worker.mjs'),['--plan',options.plan,'--sources',options.sources],{cwd:loaded.runtime.source})).trim());
  compareProductRecompute(payloads,rebuilt,kind);
  const planKey=kind==='product_evaluation'?'product_plan_id':kind==='optimization'?'optimization_plan_id':'product_validation_plan_id',extra={
    [planKey]:frozen.manifest[planKey],[planKey.replace(/_id$/,'_manifest_sha256')]:digest(frozen.manifest),
    ...(kind!=='product_evaluation'?{product_plan_id:payloads['plan.json'].product_plan_id,product_plan_manifest_sha256:payloads['plan.json'].product_plan_manifest_sha256,
      product_evaluation_id:payloads['plan.json'].product_evaluation_id,product_evaluation_manifest_sha256:payloads['plan.json'].product_evaluation_manifest_sha256}:{}),
    ...(kind==='optimization'?{optimization_schema_version:2,optimization_policy_version:5}:kind==='validation'?{validation_schema_version:2,validation_policy_version:5}:{}),
    ...(kind==='validation'&&payloads['plan.json'].optimization_id?{optimization_id:payloads['plan.json'].optimization_id,optimization_manifest_sha256:payloads['plan.json'].optimization_manifest_sha256}:{})};
  const published=await publish(loaded,output,kind,payloads,extra);
  await recordLedger(loaded.paths.accessLedger,{action:'PRODUCT_ARTIFACT_COMPLETED',plan_id:frozen.manifest[frozen.manifest.id_field],result_id:published[SPECS[kind].id],
    payload_sha256:rebuilt.payload_sha256,recompute_scope:rebuilt.scope,result_usage:'DEVELOPMENT_ONLY'});
  return {...published,...payloads['decision.json']};
}));}
export async function validateProductArtifact(options){
  const input=options.input||options.path,checked=await inspectProductPackage(input);
  if(!options.sources)return {status:'PASS',validation_scope:'PACKAGE_INTERNAL',...Object.fromEntries([checked.manifest.id_field].map(k=>[k,checked.manifest[k]]))};
  if(PLAN_KINDS.includes(checked.manifest.descriptor.package_kind))fail('PRODUCT_RESULT_REQUIRED');
  const kind=checked.manifest.descriptor.package_kind,planKey=kind==='product_evaluation'?'product_plan_id':kind==='optimization'?'optimization_plan_id':'product_validation_plan_id';
  const plan=options.plan||path.resolve(input,kind==='validation'?'../../product_plans/exports':'../../plans/exports',checked.manifest[planKey]);
  return withProductLeases({...options,input,plan,output:path.resolve(input,'../..')},output=>withPlanLock(output,checked.manifest[planKey],async()=>{
    const calculated=await calculateProduct({...options,plan,stage:'PRODUCT_SOURCE_LINKED_RECOMPUTE'});
    if(digest(calculated.frozen.manifest)!==checked.manifest[planKey.replace(/_id$/,'_manifest_sha256')])fail('PRODUCT_RESULT_PLAN_SUBSTITUTION');
    same(calculated.payloads,checked.files,'PRODUCT_RECOMPUTE_MISMATCH');
    await recordLedger(calculated.loaded.paths.accessLedger,{action:'PRODUCT_SOURCE_VERIFY_COMPLETED',plan_id:checked.manifest[planKey],result_id:checked.manifest[checked.manifest.id_field],payload_sha256:digest(checked.files)});
    return {status:'PASS',validation_scope:'SOURCE_LINKED_RECOMPUTED',recompute_scope:kind==='product_evaluation'?'FROZEN_PREDICTION_RESUMMARIZATION_NO_REPLAY':'FULL_PRODUCT_REPLAY_AND_STATISTICS',
      [checked.manifest.id_field]:checked.manifest[checked.manifest.id_field],engine_replayed:kind!=='product_evaluation',formal_capable:false};
  }));
}
export async function statsProductArtifact(options){const c=await inspectProductPackage(options.input||options.path);return {status:'PASS',validation_scope:'PACKAGE_INTERNAL',
  [c.manifest.id_field]:c.manifest[c.manifest.id_field],decision:c.files['decision.json']||null,metrics:c.files['candidate_product_metrics.json']||c.files['oof_metrics.json']||null};}
async function readContext(options,loaded,frozenPlan){
  const productPlan=options.productPlan||path.resolve(loaded.paths.model,'../../../product_evaluation/plans/exports',frozenPlan?.product_plan_id||''),
    productResult=options.productResult||path.resolve(loaded.paths.model,'../../../product_evaluation/exports',frozenPlan?.product_evaluation_id||'');
  const parentPlan=await inspectProductPackage(productPlan),parentResult=await inspectProductPackage(productResult);
  if(parentPlan.manifest.descriptor.package_kind!=='product_evaluation_plan'||parentResult.manifest.descriptor.package_kind!=='product_evaluation'||
    parentResult.manifest.product_plan_id!==parentPlan.manifest.product_plan_id||parentResult.manifest.product_plan_manifest_sha256!==digest(parentPlan.manifest)||
    parentResult.files['decision.json'].execution_status!=='COMPLETED')fail('PRODUCT_REASSESSMENT_CONTEXT_REQUIRED');
  same(parentPlan.files['plan.json'],parentResult.files['plan.json'],'PRODUCT_PARENT_PLAN_MISMATCH');
  await checkProductSources(loaded,parentResult.files['source_manifest.json']);
  loaded.contextReferences=[{directory:productPlan,manifest_sha256:digest(parentPlan.manifest)},{directory:productResult,manifest_sha256:digest(parentResult.manifest)}];
  const histories=await historySnapshots(loaded.paths);if(!histories.history.flatMap(h=>h.rows).some(r=>r.action==='PRODUCT_ARTIFACT_COMPLETED'&&r.result_id===parentResult.manifest.product_evaluation_id&&r.payload_sha256===digest(parentResult.files)))fail('PRODUCT_REASSESSMENT_RECEIPT_REQUIRED');
  return {parentPlan,parentResult,productPlan,productResult};
}
const contextFields=c=>({product_plan_id:c.parentPlan.manifest.product_plan_id,product_plan_manifest_sha256:digest(c.parentPlan.manifest),
  product_evaluation_id:c.parentResult.manifest.product_evaluation_id,product_evaluation_manifest_sha256:digest(c.parentResult.manifest)});
async function searchPlanCore(loaded,context){
  if(context.parentResult.files['decision.json'].recommendation!=='RUN_ONE_CONSTRAINED_TRAIN_SEARCH')fail('PRODUCT_SEARCH_NOT_AUTHORIZED_BY_FROZEN_DECISION');
  const {plan_core_sha256,...base}=context.parentPlan.files['plan.json'];
  const core={...base,...contextFields(context),optimization_schema_version:2,optimization_policy_version:5,stage:'CONSTRAINED_TRAIN_SEARCH',search_policy:optimizationPolicy(5),source_manifest_sha256:digest(loaded.sourceManifest)};
  return {...core,plan_core_sha256:digest(core)};
}
export async function reserveProductAttempt(loaded,contextId,action,plan){
  if(!['PRODUCT_SEARCH_PLAN_FROZEN','PRODUCT_VALIDATION_LIST_FROZEN'].includes(action)||!/^[a-f0-9]{64}$/.test(plan.plan_core_sha256))fail('PRODUCT_INVALID_ATTEMPT_RESERVATION');
  const history=await historySnapshots(loaded.paths);return withHistoryLocks(history.roots,async()=>{
  const current=await historySnapshots(loaded.paths),all=current.history.flatMap(h=>h.rows),prior=all.filter(r=>r.action===action&&r.product_plan_id===contextId);
  if(prior.some(r=>r.plan_core_sha256!==plan.plan_core_sha256))fail('PRODUCT_SINGLE_FROZEN_ATTEMPT_ALREADY_RESERVED');
  const roots=new Map(Object.values(history.roots).map(root=>[process.platform==='win32'?path.resolve(root).toLowerCase():path.resolve(root),root]));
  for(const root of roots.values())await appendLedger(root,{action,product_plan_id:contextId,plan_core_sha256:plan.plan_core_sha256,result_usage:'DEVELOPMENT_ONLY'});
});}
export async function planProductSearch(options){return withProductLeases({...options,output:options.output||path.resolve('dataset/optimization')},async output=>{
  const loaded=await loadProductSources(options),context=await readContext(options,loaded);loaded.sourceManifest=context.parentResult.files['source_manifest.json'];
  const plan=await searchPlanCore(loaded,context);await reserveProductAttempt(loaded,plan.product_plan_id,'PRODUCT_SEARCH_PLAN_FROZEN',plan);
  return publish(loaded,path.join(output,'plans'),'optimization_search_plan',{'schema.json':{optimization_schema_version:2,optimization_policy_version:5},'policy.json':optimizationPolicy(5),
    'product_policy.json':productPolicy(),'plan.json':plan,'source_manifest.json':loaded.sourceManifest},{...contextFields(context),optimization_schema_version:2,optimization_policy_version:5});
});}
async function validationPlanCore(loaded,context,options,frozen){
  const base=context.parentPlan.files['plan.json'],decision=context.parentResult.files['decision.json'];let candidates,optimization=null;
  if(decision.recommendation==='VALIDATE_FIXED_CONFIGURATION')candidates=[decision.fixed_configuration];
  else {
    const directory=options.optimization||path.resolve(loaded.paths.model,'../../../optimization/exports',frozen?.optimization_id||'');optimization=await inspectProductPackage(directory);
    if(optimization.manifest.optimization_policy_version!==5||optimization.manifest.product_plan_id!==context.parentPlan.manifest.product_plan_id||optimization.files['decision.json'].validation_allowed!==true)fail('PRODUCT_VALIDATION_NOT_SUPPORTED');
    if(optimization.manifest.product_evaluation_id!==context.parentResult.manifest.product_evaluation_id)fail('PRODUCT_VALIDATION_PARENT_SUBSTITUTION');
    candidates=optimization.files['final_candidates.json'].map(c=>c.candidate);
    loaded.contextReferences.push({directory,manifest_sha256:digest(optimization.manifest)});
  }
  if(!candidates.length||candidates.length>5)fail('PRODUCT_FINAL_LIST_EMPTY_OR_TOO_LARGE');
  for(const c of candidates)if(digest(candidateFromVector(loaded,c.canonical_vector,'VALIDATION_IDENTITY').effective_config)!==c.effective_config_sha256||digest(c.effective_config)!==c.effective_config_sha256)fail('PRODUCT_CANDIDATE_CONFIG_CHANGED');
  const core={product_evaluation_schema_version:1,product_evaluation_policy_version:1,validation_schema_version:2,validation_policy_version:5,product_policy_sha256:digest(productPolicy()),
    ...contextFields(context),...(optimization?{optimization_id:optimization.manifest.optimization_id,optimization_manifest_sha256:digest(optimization.manifest)}:{}),
    result_usage:'DEVELOPMENT_ONLY',formal_capable:false,stage:'ONE_FROZEN_DEVELOPMENT_VALIDATION',validation_exposure:'PREVIOUSLY_EXPOSED',
    source_manifest_sha256:digest(loaded.sourceManifest),candidates,candidates_sha256:digest(candidates),validation_members:base.validation_members,
    train_constant:base.train_constant,old_no_skill_ordinal:base.old_no_skill_ordinal};return {...core,plan_core_sha256:digest(core)};
}
export async function planProductValidation(options){return withProductLeases({...options,output:options.output||path.resolve('dataset/validation')},async output=>{
  if(options.mode&& !['development','DEVELOPMENT_VALIDATION'].includes(options.mode))fail('PRODUCT_FORMAL_VALIDATION_FORBIDDEN');
  const loaded=await loadProductSources(options),context=await readContext(options,loaded);loaded.sourceManifest=context.parentResult.files['source_manifest.json'];
  const plan=await validationPlanCore(loaded,context,options);await reserveProductAttempt(loaded,plan.product_plan_id,'PRODUCT_VALIDATION_LIST_FROZEN',plan);
  return publish(loaded,path.join(output,'product_plans'),'product_validation_plan',{'schema.json':{validation_schema_version:2,validation_policy_version:5},'policy.json':validationPolicy(5),
    'product_policy.json':productPolicy(),'plan.json':plan,'source_manifest.json':loaded.sourceManifest},{...contextFields(context),validation_schema_version:2,validation_policy_version:5,
      ...(plan.optimization_id?{optimization_id:plan.optimization_id,optimization_manifest_sha256:plan.optimization_manifest_sha256}:{})});
});}
