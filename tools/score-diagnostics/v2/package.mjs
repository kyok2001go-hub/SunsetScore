import path from 'node:path';
import { canonicalJson, fail } from '../../dataset/lib/common.mjs';
import { publishGovernancePackage, inspectGovernancePackage } from '../../experiment-runtime/lib/package.mjs';
import { withGovernanceLeases } from '../../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../../experiment-runtime/lib/references.mjs';
import { nodeProcess } from '../../experiment-runtime/lib/bundle.mjs';
import { artifactDatasetRoot } from '../../formal/contracts.mjs';
import { outside } from '../../tuning/lib/input.mjs';
import { withPlanLock, recordLedger } from '../../validation/lib/disclosure.mjs';
import { historySnapshots } from '../../campaign/campaign.mjs';
import { scorePolicy, scoreSchema } from '../policy.mjs';
import { inspectScoreDiagnostic } from '../package.mjs';
import { readBoundarySources, loadBoundarySources, checkBoundarySources, recordBoundaryAccess, UPSTREAM_KEYS, ARTIFACT_KEYS, RUNTIME_KEYS } from './sources.mjs';
import { makeBoundaryPlan, computeBoundaryDiagnostics } from './workflow.mjs';
import { digest, assertSame, memberRows } from './common.mjs';

export function boundaryLinks(s) {
  return {score_diagnostic_schema_version:2,score_diagnostic_policy_version:2,result_usage:'DEVELOPMENT_ONLY',source_ids:s.source_ids,
    diagnostic_plan_id:s.artifacts.diagnosticPlan.id,diagnostic_plan_manifest_sha256:s.artifacts.diagnosticPlan.manifest_sha256,
    diagnostic_id:s.artifacts.diagnosticResult.id,diagnostic_manifest_sha256:s.artifacts.diagnosticResult.manifest_sha256,
    parent_score_diagnostic_id:s.artifacts.parentResult.id,parent_score_diagnostic_manifest_sha256:s.artifacts.parentResult.manifest_sha256,
    parent_score_diagnostic_plan_id:s.artifacts.parentPlan.id,parent_score_diagnostic_plan_manifest_sha256:s.artifacts.parentPlan.manifest_sha256,
    source_runtime_bundle_id:s.runtimes.sourceRuntime.id,source_runtime_bundle_manifest_sha256:s.runtimes.sourceRuntime.manifest_sha256,
    parent_runtime_bundle_id:s.runtimes.parentRuntime.id,parent_runtime_bundle_manifest_sha256:s.runtimes.parentRuntime.manifest_sha256,
    runtime_bundle_id:s.runtimes.runtimeBundle.id,runtime_bundle_manifest_sha256:s.runtimes.runtimeBundle.manifest_sha256};
}
export function inspectBoundarySnapshot(checked) {
  const {manifest,files}=checked,plan=files['plan.json'],source=files['source_manifest.json'];
  const isPlan=manifest.descriptor.package_kind==='score_diagnostic_plan';
  if(!['score_diagnostic_plan','score_diagnostic'].includes(manifest.descriptor.package_kind))fail('INVALID_BOUNDARY_PACKAGE');
  const {plan_core_sha256,...core}=plan;
  if(manifest.score_diagnostic_schema_version!==2||manifest.score_diagnostic_policy_version!==2||plan.score_diagnostic_schema_version!==2||
    plan.score_diagnostic_policy_version!==2||digest(core)!==plan_core_sha256||plan.result_usage!=='DEVELOPMENT_ONLY'||
    plan.computation_access_policy!=='TRAIN_ONLY'||plan.test_evaluated!==false||plan.validation_evaluated!==false||
    digest(source)!==plan.source_manifest_sha256||digest(plan.policy)!==digest(scorePolicy(2))||
    digest(files['policy.json'])!==digest(scorePolicy(2))||digest(files['schema.json'])!==digest(scoreSchema(2))||
    digest(Object.keys(files).sort())!==digest((isPlan?scoreSchema(2).plan_files:scoreSchema(2).result_files).sort()))fail('INVALID_BOUNDARY_PACKAGE');
  for(const [key,value] of Object.entries(boundaryLinks(source)))if(canonicalJson(manifest[key])!==canonicalJson(value))fail('BOUNDARY_MANIFEST_SOURCE_LINK_MISMATCH');
  if(plan.inherited_control_config_sha256!==source.parent_control_config_sha256||plan.inherited_mappings_sha256!==source.parent_mappings_sha256||
    plan.parent_score_diagnostic_id!==source.artifacts.parentResult.id||plan.parent_score_diagnostic_plan_id!==source.artifacts.parentPlan.id||
    plan.parent_score_diagnostic_manifest_sha256!==source.artifacts.parentResult.manifest_sha256||
    plan.parent_score_diagnostic_plan_manifest_sha256!==source.artifacts.parentPlan.manifest_sha256)fail('BOUNDARY_INHERITED_IDENTITY_MISMATCH');
  const allIds=new Set(plan.train_members.map(r=>r.snapshot_id)),oofIds=new Set(plan.oof_members.map(r=>r.snapshot_id));
  if(allIds.size!==plan.train_members.length||oofIds.size!==plan.oof_members.length||[...oofIds].some(id=>!allIds.has(id)))fail('BOUNDARY_PLAN_MEMBER_CONFLICT');
  const held=plan.fold_assignments.folds.flatMap(f=>f.held_members.map(r=>r.snapshot_id));
  assertSame(held.slice().sort(),[...oofIds].sort(),'BOUNDARY_FROZEN_FOLD_COVERAGE');
  for(const fold of plan.fold_assignments.folds) {
    const trainIds=new Set(fold.train_members.map(r=>r.snapshot_id));
    if(fold.held_members.some(r=>trainIds.has(r.snapshot_id)||!allIds.has(r.snapshot_id))||
      fold.train_members.some(r=>!allIds.has(r.snapshot_id))||fold.train_dates.some(date=>date>=fold.held_dates[0]))fail('BOUNDARY_FROZEN_FORWARD_FOLD_CONFLICT');
  }
  if(!isPlan) {
    const decision=files['decision.json'],scope=files['access_scope.json'];
    if(typeof manifest.score_diagnostic_plan_id!=='string'||!/^score_diagnostic_plan_v1_[0-9a-f]{16}$/.test(manifest.score_diagnostic_plan_id)||
      !/^[0-9a-f]{64}$/.test(manifest.score_diagnostic_plan_manifest_sha256)||
      decision.result_usage!=='DEVELOPMENT_ONLY'||decision.formal_promotion_allowed!==false||decision.selected!==null||
      decision.test_evaluated!==false||decision.validation_evaluated!==false||decision.primary_actions.length>2||files['next_experiments.json'].length>2||
      scope.computation_split!=='TRAIN'||scope.engine_replay_count!==0||scope.pava_fit_count!==0||scope.parameter_search_count!==0||
      scope.mixed_sample_effect_files_read.length!==0)fail('BOUNDARY_PROMOTION_OR_ACCESS_FORBIDDEN');
    assertSame(scope.model_statistics_allowlist,['manifest.json','schema.json','policy.json','splits/train.csv'],'BOUNDARY_TRAIN_ACCESS_FORBIDDEN');
    if(digest(scope)!==plan.access_scope_sha256||digest(files['temporal_contract.json'])!==plan.temporal_contract_sha256||
      digest(files['parent_binding.json'])!==source.parent_binding_sha256)fail('BOUNDARY_EVIDENCE_HASH_MISMATCH');
    const train=new Map(plan.train_members.map(r=>[r.snapshot_id,r])),reads=scope.train_replay_reads;
    if(reads.length!==train.size||new Set(reads.map(r=>r.snapshot_id)).size!==train.size||reads.some(r=>!train.has(r.snapshot_id)||r.event_id!==train.get(r.snapshot_id).event_id||r.split!=='TRAIN'))
      fail('BOUNDARY_ACCESS_MEMBER_MISMATCH');
    for(const file of ['temporal_audit.json','target_alignment.json']) {
      if(files[file].rows.some(r=>!train.has(r.snapshot_id)||r.event_id!==train.get(r.snapshot_id).event_id||r.rule_version!==2||
        !scorePolicy(2).temporal_statuses.includes(r.status)))fail('BOUNDARY_TEMPORAL_MEMBER_OR_RULE_MISMATCH');
      assertSame([...new Set(files[file].rows.map(r=>r.snapshot_id))].sort(),[...train.keys()].sort(),'BOUNDARY_TEMPORAL_MEMBER_COVERAGE');
    }
    const mappings=files['fold_mapping_audit.json'];
    if(mappings.reapplication.parent_mappings_sha256!==plan.inherited_mappings_sha256)fail('BOUNDARY_PARENT_MAPPING_CHANGED');
    assertSame(mappings.reapplication.rows.map(r=>r.snapshot_id).sort(),plan.oof_members.map(r=>r.snapshot_id).sort(),'BOUNDARY_MAPPING_OOF_COVERAGE');
    if(decision.execution_status==='COMPLETED'&&(mappings.reapplication.status!=='PASS'||mappings.reapplication.rows.some(r=>!r.pass)))fail('BOUNDARY_INVALID_COMPLETED_STATUS');
    for(const [cohort,result] of Object.entries(files['ordinal_pair_contributions.json'])) {
      if(result.pairs.length!==10||result.reconstruction_pass!==true||result.reconstruction_abs_error>scorePolicy(2).reconstruction_tolerance)fail('BOUNDARY_CONTRIBUTION_MISMATCH');
      const total=result.pairs.reduce((s,p)=>s+p.denominator_pair_weight,0),credit=result.pairs.reduce((s,p)=>s+p.credited_weight,0);
      if(Math.abs(total-result.total_pair_weight)>1e-10||total>0&&Math.abs(credit/total-result.reconstructed_ordered_consistency)>1e-10)fail('BOUNDARY_CONTRIBUTION_MISMATCH');
      const members=new Set((cohort==='OOF'?plan.oof_members:plan.train_members).map(r=>r.snapshot_id));
      for(const metric of [...files['boundary_metrics.json'][cohort].adjacent,...files['boundary_metrics.json'][cohort].cumulative,...result.pairs])
        if(metric.member_snapshot_ids.some(id=>!members.has(id)))fail('BOUNDARY_EFFECT_MEMBER_MISMATCH');
    }
    if(decision.recommendation==='INPUT_CONTRACT_REPAIR'&&![...files['temporal_audit.json'].rows,...files['target_alignment.json'].rows].some(r=>r.status==='PROVEN_MISMATCH'))
      fail('BOUNDARY_UNSUPPORTED_REPAIR_CONCLUSION');
  }
  return checked;
}
async function withBoundaryLeases(options,operation) {
  const paths=await readBoundarySources(options.sources),output=options.output||path.resolve('dataset/score_diagnostics');
  const inputs=[...UPSTREAM_KEYS,...ARTIFACT_KEYS,...RUNTIME_KEYS].map(k=>paths[k]).concat(options.plan||[],options.input||[]);
  await outside(output,inputs);
  const histories=await historySnapshots(paths),roots=[path.dirname(output),path.resolve(paths.raw,'../..'),
    ...inputs.filter(p=>p!==paths.raw).map(artifactDatasetRoot),...Object.values(histories.roots).map(r=>path.resolve(r,'../..'))];
  return withGovernanceLeases('score_diagnostics',roots,async()=>{await protectExternalReferences(roots,output);return operation(output);});
}
export async function planBoundaries(options) {
  if(!options.parent)fail('BOUNDARY_EXPLICIT_PARENT_REQUIRED');
  return withBoundaryLeases(options,async output=>{
    const loaded=await loadBoundarySources(options),plan=makeBoundaryPlan(loaded);
    return publishGovernancePackage({output:path.join(output,'plans'),kind:'score_diagnostic_plan',idField:'score_diagnostic_plan_id',links:boundaryLinks(loaded.sourceManifest),
      payloads:{'schema.json':scoreSchema(2),'policy.json':scorePolicy(2),'plan.json':plan,'source_manifest.json':loaded.sourceManifest},
      sourceCheck:()=>checkBoundarySources(loaded,loaded.sourceManifest),validateStaging:inspectScoreDiagnostic});
  });
}
export async function calculateBoundaries(options) {
  const frozen=await inspectScoreDiagnostic(options.plan);
  if(frozen.manifest.descriptor.package_kind!=='score_diagnostic_plan'||frozen.manifest.score_diagnostic_schema_version!==2)fail('BOUNDARY_PLAN_REQUIRED');
  const loaded=await loadBoundarySources(options);
  const sourceManifest=frozen.files['source_manifest.json'];await checkBoundarySources(loaded,sourceManifest);
  const bound={...loaded,sourceManifest};
  assertSame(makeBoundaryPlan(bound),frozen.files['plan.json'],'BOUNDARY_PLAN_SOURCE_CHANGED');
  await recordBoundaryAccess(bound,frozen.manifest.score_diagnostic_plan_id,options.stage||'BOUNDARY_MAPPING_TIME_ANALYSIS');
  const payloads=computeBoundaryDiagnostics(bound,frozen.files['plan.json'],options.progress);
  await checkBoundarySources(loaded,sourceManifest);
  return {loaded:bound,frozen,payloads};
}
export function checkRecomputedPayload(payloads,rebuilt) {
  if(rebuilt.payload_sha256!==digest(payloads)||rebuilt.scope!=='V2_BOUNDARY_MAPPING_TEMPORAL_STATISTICS_ONLY')fail('BOUNDARY_RECOMPUTE_MISMATCH');
}
export async function runBoundaries(options) {
  return withBoundaryLeases(options,output=>withPlanLock(output,path.basename(options.plan),async()=>{
    const {loaded,frozen,payloads}=await calculateBoundaries(options);
    options.progress?.stage('新进程重算本期分析：原映射应用、边界、配对和时间报表');
    const rebuilt=JSON.parse((await nodeProcess(path.join(loaded.runtime.source,'tools/score-diagnostics/v2/worker.mjs'),
      ['--plan',options.plan,'--sources',options.sources],{cwd:loaded.runtime.source})).trim());
    checkRecomputedPayload(payloads,rebuilt);
    const published=await publishGovernancePackage({output,kind:'score_diagnostic',idField:'score_diagnostic_id',payloads,
      links:{...boundaryLinks(frozen.files['source_manifest.json']),score_diagnostic_plan_id:frozen.manifest.score_diagnostic_plan_id,
        score_diagnostic_plan_manifest_sha256:digest(frozen.manifest)},
      sourceCheck:()=>checkBoundarySources(loaded,frozen.files['source_manifest.json']),validateStaging:inspectScoreDiagnostic});
    await recordLedger(loaded.paths.accessLedger,{action:'SCORE_DIAGNOSTIC_V2_COMPLETED',plan_id:frozen.manifest.score_diagnostic_plan_id,
      parent_score_diagnostic_id:loaded.parent.manifest.score_diagnostic_id,result_id:published.score_diagnostic_id,payload_sha256:rebuilt.payload_sha256,
      recompute_scope:rebuilt.scope,engine_replayed:false,pava_refitted:false,result_usage:'DEVELOPMENT_ONLY'});
    return {...published,...payloads['decision.json']};
  }));
}
export async function validateBoundaries(options) {
  const checked=await inspectScoreDiagnostic(options.input);
  if(!options.sources)return {status:'PASS',validation_scope:'PACKAGE_INTERNAL',score_diagnostic_id:checked.manifest[checked.manifest.id_field],score_diagnostic_schema_version:2};
  if(checked.manifest.descriptor.package_kind!=='score_diagnostic')fail('BOUNDARY_RESULT_REQUIRED');
  return withBoundaryLeases({...options,output:path.resolve(options.input,'../..')},async()=>{
    const plan=options.plan||path.join(path.dirname(path.dirname(options.input)),'plans/exports',checked.manifest.score_diagnostic_plan_id);
    const {frozen,payloads,loaded}=await calculateBoundaries({...options,plan,stage:'V2_SOURCE_LINKED_RECOMPUTE'});
    assertSame(digest(frozen.manifest),checked.manifest.score_diagnostic_plan_manifest_sha256,'BOUNDARY_PLAN_CHANGED');
    assertSame(payloads,checked.files,'BOUNDARY_RECOMPUTE_MISMATCH');
    await recordLedger(loaded.paths.accessLedger,{action:'SCORE_DIAGNOSTIC_V2_VERIFY_COMPLETED',plan_id:frozen.manifest.score_diagnostic_plan_id,
      result_id:checked.manifest.score_diagnostic_id,payload_sha256:digest(payloads),recompute_scope:'V2_BOUNDARY_MAPPING_TEMPORAL_STATISTICS_ONLY',engine_replayed:false,pava_refitted:false});
    return {status:'PASS',validation_scope:'SOURCE_LINKED_RECOMPUTED',recompute_scope:'V2_BOUNDARY_MAPPING_TEMPORAL_STATISTICS_ONLY',
      score_diagnostic_id:checked.manifest.score_diagnostic_id,engine_replayed:false,pava_refitted:false};
  });
}
