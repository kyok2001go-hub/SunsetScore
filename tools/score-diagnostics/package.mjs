import path from 'node:path';
import { canonicalJson, fail, readSafe } from '../dataset/lib/common.mjs';
import { inspectGovernancePackage, publishGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../experiment-runtime/lib/references.mjs';
import { nodeProcess } from '../experiment-runtime/lib/bundle.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { withPlanLock, recordLedger } from '../validation/lib/disclosure.mjs';
import { artifactDatasetRoot } from '../formal/contracts.mjs';
import { historySnapshots } from '../campaign/campaign.mjs';
import { runReplay } from '../replay/replay-runner.mjs';
import { digest } from '../optimization-diagnostics/engine.mjs';
import { scorePolicy, scoreSchema } from './policy.mjs';
import { readScoreSources, sourceKeys, loadScoreSources, checkScoreSources, sourceControl, recordScoreAccess } from './sources.mjs';
import { makeScorePlan, computeScoreDiagnostics } from './workflow.mjs';
import { bootstrapSeed } from '../validation/lib/stability.mjs';
import { predictPava, metrics } from './statistics.mjs';

export async function inspectScoreDiagnostic(directory) {
  const checked=await inspectGovernancePackage(directory),{files,manifest}=checked;
  const kind=manifest.descriptor.package_kind,isPlan=kind==='score_diagnostic_plan';
  if(!['score_diagnostic_plan','score_diagnostic'].includes(kind))fail('INVALID_SCORE_DIAGNOSTIC_PACKAGE');
  if (files['schema.json']?.score_diagnostic_schema_version === 2)
    return (await import('./v2/package.mjs')).inspectBoundarySnapshot(checked);
  const schema=scoreSchema(files['schema.json']?.score_diagnostic_schema_version),policy=scorePolicy(files['policy.json']?.score_diagnostic_policy_version);
  const plan=files['plan.json'],{plan_core_sha256,bootstrap_seed,...core}=plan;
  if(canonicalJson(schema)!==canonicalJson(files['schema.json'])||canonicalJson(policy)!==canonicalJson(files['policy.json'])||
    canonicalJson(plan.policy)!==canonicalJson(policy)||digest(core)!==plan_core_sha256||bootstrap_seed!==bootstrapSeed(plan_core_sha256)||
    plan.score_diagnostic_schema_version!==1||plan.score_diagnostic_policy_version!==1||
    manifest.score_diagnostic_schema_version!==1||manifest.score_diagnostic_policy_version!==1||manifest.result_usage!=='DEVELOPMENT_ONLY'||
    plan.result_usage!=='DEVELOPMENT_ONLY'||plan.computation_access_policy!=='TRAIN_ONLY'||plan.validation_evaluated!==false||plan.test_evaluated!==false||
    digest(plan.control_config)!==plan.control_config_sha256||digest(files['source_manifest.json'])!==plan.source_manifest_sha256||
    canonicalJson(Object.keys(files).sort())!==canonicalJson((isPlan?schema.plan_files:schema.result_files).sort()))fail('INVALID_SCORE_DIAGNOSTIC_PACKAGE');
  if(!isPlan&&(files['decision.json'].result_usage!=='DEVELOPMENT_ONLY'||files['decision.json'].formal_promotion_allowed!==false||
    files['decision.json'].selected!==null||files['decision.json'].validation_evaluated!==false||files['decision.json'].test_evaluated!==false))fail('SCORE_PROMOTION_FORBIDDEN');
  for(const [key,value] of Object.entries(links(files['source_manifest.json'])))if(canonicalJson(value)!==canonicalJson(manifest[key]))fail('SCORE_MANIFEST_LINK_MISMATCH');
  if(!isPlan) {
    const train=new Set(plan.train_members.map(r=>r.snapshot_id)),folds=files['fold_calibrators.json'],oof=files['oof_predictions.json'];
    for(const file of ['reference_parity.json','trace_compatibility.json']) {
      const ids=files[file].rows.map(r=>r.snapshot_id);
      if(ids.length!==train.size||new Set(ids).size!==train.size||ids.some(id=>!train.has(id)))fail('SCORE_MEMBER_MISMATCH');
    }
    const seen=new Set();
    for(const f of folds) {
      const {fold,train_members,no_skill_ordinal,mapping_sha256,frozen_before_holdout,...mapping}=f;
      const frozen=plan.fold_assignments.folds.find(r=>r.fold===fold);
      if(!frozen||frozen_before_holdout!==true||digest(train_members)!==digest(frozen.train_members)||digest(mapping)!==mapping_sha256)fail('SCORE_FOLD_MAPPING_MISMATCH');
      if(mapping.status==='FITTED'&&(!mapping.nodes.length||mapping.nodes.some((n,i)=>n.fitted<0||n.fitted>4||i>0&&
        (n.score<=mapping.nodes[i-1].score||n.fitted<mapping.nodes[i-1].fitted))))fail('SCORE_FOLD_MAPPING_MISMATCH');
    }
    for(const r of oof) {
      const f=folds.find(f=>f.fold===r.fold),frozen=plan.fold_assignments.folds.find(f=>f.fold===r.fold);
      if(!f||seen.has(r.snapshot_id)||!train.has(r.snapshot_id)||!frozen.held_members.some(m=>m.snapshot_id===r.snapshot_id)||
        r.mapping_sha256!==f.mapping_sha256||r.no_skill_ordinal!==f.no_skill_ordinal)fail('SCORE_OOF_MEMBER_MISMATCH');
      seen.add(r.snapshot_id);const prediction=predictPava(f,r.score);
      if(prediction.ordinal!==r.calibrated_ordinal||prediction.ordinal_estimate!==r.calibrated_estimate)fail('SCORE_OOF_MAPPING_MISMATCH');
    }
    const expected=plan.fold_assignments.folds.filter(f=>folds.find(c=>c.fold===f.fold)?.status==='FITTED').flatMap(f=>f.held_members.map(m=>m.snapshot_id)).sort();
    if(canonicalJson([...seen].sort())!==canonicalJson(expected))fail('SCORE_OOF_COVERAGE_MISMATCH');
    for(const [key,prediction] of [['control','control_ordinal'],['calibration','calibrated_ordinal'],['no_skill','no_skill_ordinal']])
      if(digest(metrics(oof,prediction))!==digest(files['oof_metrics.json'][key]))fail('SCORE_INTERNAL_METRICS_MISMATCH');
    if(files['decision.json'].execution_status==='COMPLETED'&&files['reference_parity.json'].rows.some(r=>r.pass!==true))fail('SCORE_INVALID_COMPLETED_STATUS');
  }
  return checked;
}
function links(s) {return {score_diagnostic_schema_version:1,score_diagnostic_policy_version:1,result_usage:'DEVELOPMENT_ONLY',source_ids:s.source_ids,
  diagnostic_plan_id:s.diagnostic_plan.id,diagnostic_plan_manifest_sha256:s.diagnostic_plan.manifest_sha256,
  diagnostic_id:s.diagnostic_result.id,diagnostic_manifest_sha256:s.diagnostic_result.manifest_sha256,
  source_runtime_bundle_id:s.source_runtime.id,source_runtime_bundle_manifest_sha256:s.source_runtime.manifest_sha256,
  runtime_bundle_id:s.runtime.id,runtime_bundle_manifest_sha256:s.runtime.manifest_sha256};}
async function withScoreLeases(options,operation) {
  const paths=await readScoreSources(options.sources),output=options.output||path.resolve('dataset/score_diagnostics');
  const inputs=sourceKeys.filter(k=>!['historyLedgers','accessLedger'].includes(k)).map(k=>paths[k]).concat(options.plan||[],options.input||[]);
  await outside(output,inputs);
  const histories=await historySnapshots(paths);
  const roots=[...inputs.filter(p=>p!==paths.raw).map(artifactDatasetRoot),path.resolve(paths.raw,'../..'),
    path.dirname(output),...Object.values(histories.roots).map(r=>path.resolve(r,'../..')),path.resolve(paths.accessLedger,'../..')];
  return withGovernanceLeases('score_diagnostics',roots,async()=>{await protectExternalReferences(roots,output);return operation(output);});
}
export async function planScoreDiagnostics(options) {
  if (options.diagnosticVersion === 2) return (await import('./v2/package.mjs')).planBoundaries(options);
  if (options.diagnosticVersion !== undefined && options.diagnosticVersion !== 1) fail('UNSUPPORTED_SCORE_DIAGNOSTIC_POLICY');
  return withScoreLeases(options,async output=>{
    const loaded=await loadScoreSources(options),plan=makeScorePlan(loaded);
    return publishGovernancePackage({output:path.join(output,'plans'),kind:'score_diagnostic_plan',idField:'score_diagnostic_plan_id',
      links:links(loaded.sourceManifest),payloads:{'schema.json':scoreSchema(),'policy.json':scorePolicy(),'plan.json':plan,'source_manifest.json':loaded.sourceManifest},
      sourceCheck:()=>checkScoreSources(loaded,loaded.sourceManifest),validateStaging:inspectScoreDiagnostic});
  });
}
export async function calculateScoreDiagnostics(options) {
  const loaded=await loadScoreSources(options),frozen=await inspectScoreDiagnostic(options.plan);
  if(frozen.manifest.descriptor.package_kind!=='score_diagnostic_plan')fail('SCORE_PLAN_REQUIRED');
  const sourceManifest=frozen.files['source_manifest.json'];await checkScoreSources(loaded,sourceManifest);
  if(digest(makeScorePlan({...loaded,sourceManifest}))!==digest(frozen.files['plan.json']))fail('SCORE_PLAN_SOURCE_CHANGED');
  await recordScoreAccess(loaded,frozen.manifest.score_diagnostic_plan_id,options.stage||'CONTROL_TRACE_CALIBRATION');
  const oldControl=await sourceControl(loaded,options);
  const payloads=await computeScoreDiagnostics({...loaded,sourceManifest,plan:frozen.files['plan.json'],oldControl,
    progress:options.progress,runReplay:(replay,config)=>runReplay(replay,{...config,engineRoot:loaded.root})});
  await checkScoreSources(loaded,sourceManifest);
  return {loaded,frozen,payloads};
}
export async function runScoreDiagnostics(options) {
  const header=JSON.parse((await readSafe(path.join(options.plan,'manifest.json'))).toString('utf8'));
  if (header.score_diagnostic_schema_version === 2) return (await import('./v2/package.mjs')).runBoundaries(options);
  return withScoreLeases(options,output=>withPlanLock(output,path.basename(options.plan),async()=>{
    const calculated=await calculateScoreDiagnostics(options),{loaded,frozen,payloads}=calculated;
    options.progress?.stage('新进程独立重算 Control、trace、三折校准及固定统计');
    const stdout=await nodeProcess(path.join(loaded.runtime.source,'tools/score-diagnostics/worker.mjs'),['--plan',options.plan,'--sources',options.sources],{cwd:loaded.runtime.source});
    const rebuilt=JSON.parse(stdout.trim());if(rebuilt.payload_sha256!==digest(payloads))fail('SCORE_RECOMPUTE_MISMATCH');
    const published=await publishGovernancePackage({output,kind:'score_diagnostic',idField:'score_diagnostic_id',payloads,
      links:{...links(frozen.files['source_manifest.json']),score_diagnostic_plan_id:frozen.manifest.score_diagnostic_plan_id,
        score_diagnostic_plan_manifest_sha256:digest(frozen.manifest)},sourceCheck:()=>checkScoreSources(loaded,frozen.files['source_manifest.json']),validateStaging:inspectScoreDiagnostic});
    await recordLedger(loaded.paths.accessLedger,{action:'SCORE_DIAGNOSTIC_COMPLETED',plan_id:frozen.manifest.score_diagnostic_plan_id,
      result_id:published.score_diagnostic_id,payload_sha256:rebuilt.payload_sha256,result_usage:'DEVELOPMENT_ONLY'});
    return {...published,...payloads['decision.json']};
  }));
}
export async function validateScoreDiagnostics(options) {
  const header=JSON.parse((await readSafe(path.join(options.input,'manifest.json'))).toString('utf8'));
  if (header.score_diagnostic_schema_version === 2) return (await import('./v2/package.mjs')).validateBoundaries(options);
  if(!options.sources){const c=await inspectScoreDiagnostic(options.input);return {status:'PASS',validation_scope:'PACKAGE_INTERNAL',[c.manifest.id_field]:c.manifest[c.manifest.id_field]};}
  return withScoreLeases({...options,output:path.resolve(options.input,'../..')},async()=>{
    const checked=await inspectScoreDiagnostic(options.input);
    if(checked.manifest.descriptor.package_kind!=='score_diagnostic')fail('SCORE_RESULT_REQUIRED');
    const plan=options.plan||path.join(path.dirname(path.dirname(options.input)),'plans/exports',checked.manifest.score_diagnostic_plan_id);
    const {payloads,frozen}=await calculateScoreDiagnostics({...options,plan,stage:'SOURCE_LINKED_RECOMPUTE'});
    if(digest(frozen.manifest)!==checked.manifest.score_diagnostic_plan_manifest_sha256||digest(payloads)!==digest(checked.files))fail('SCORE_RECOMPUTE_MISMATCH');
    return {status:'PASS',validation_scope:'SOURCE_LINKED_RECOMPUTED',score_diagnostic_id:checked.manifest.score_diagnostic_id,result_usage:'DEVELOPMENT_ONLY'};
  });
}
export async function statsScoreDiagnostics(options) {
  const checked=await inspectScoreDiagnostic(options.input);
  if(checked.manifest.descriptor.package_kind!=='score_diagnostic')fail('SCORE_RESULT_REQUIRED');
  if (checked.manifest.score_diagnostic_schema_version === 2) return {status:'PASS',score_diagnostic_id:checked.manifest.score_diagnostic_id,
    validation_scope:'PACKAGE_INTERNAL_READ_ONLY',decision:checked.files['decision.json'],boundaries:checked.files['boundary_metrics.json'],
    mapping_audit:checked.files['fold_mapping_audit.json'],evidence_gaps:checked.files['evidence_gaps.json']};
  return {status:'PASS',score_diagnostic_id:checked.manifest.score_diagnostic_id,validation_scope:'PACKAGE_INTERNAL_READ_ONLY',
    decision:checked.files['decision.json'],oof_metrics:checked.files['oof_metrics.json'],bootstrap:checked.files['bootstrap.json']};
}
