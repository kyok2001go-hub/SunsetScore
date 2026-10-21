const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
let modules;
async function api(){return modules||=Promise.all(['score-diagnostics/policy','score-diagnostics/statistics','score-diagnostics/analysis',
  'score-diagnostics/workflow','score-diagnostics/cli','score-diagnostics/package','score-diagnostics/sources',
  'optimization-diagnostics/engine','experiment-runtime/lib/package','maintenance/maintenance-policy'].map(n=>import(`../tools/${n}.mjs`)))
  .then(ms=>Object.assign({},...ms));}
function rows(){return Array.from({length:80},(_,i)=>({snapshot_id:`s${String(i).padStart(3,'0')}`,event_id:`e${i}`,location_key:`l${i%4}`,
  event_date_local:`2026-09-${String(1+Math.floor(i/4)).padStart(2,'0')}`,gt_confidence:1,gt_ordinal:i%4,
  score:[10,40,30,70][i%4],control_ordinal:[0,2,1,3][i%4],calibrated_ordinal:i%4,no_skill_ordinal:1,
  lead_time_minutes:30,lead_time_bucket:'T_30_60M',regime_label:'CLEAR',error_direction:'EXACT'}));}
test('score diagnostics freezes exact development-only versions, no search and no full TRAIN calibration',async()=>{
  const m=await api(),p=m.scorePolicy();assert.equal(p.budget.parameter_search,0);assert.equal(p.calibration.full_train_fit_allowed,false);
  assert.equal(p.formal_promotion_allowed,false);assert.equal(p.bootstrap.replicates,2000);
  assert.throws(()=>m.scorePolicy(3));assert.throws(()=>m.scoreSchema(0));
  assert.throws(()=>m.parseScoreArgs(['run','--sources','x','--plan','y','--algorithm','other']));
  assert.throws(()=>m.parseScoreArgs(['stats','--input','x','--sources','x']));
  assert.equal(m.parseScoreArgs(['validate','--input','x']).command,'validate');
});
test('weighted AUC ties use product weights; ordered pairs exclude same Event',async()=>{
  const m=await api(),rs=[{snapshot_id:'a',event_id:'p',gt_ordinal:3,score:60,weight:.4},
    {snapshot_id:'b',event_id:'p',gt_ordinal:3,score:20,weight:.4},{snapshot_id:'c',event_id:'n',gt_ordinal:0,score:40,weight:.5},
    {snapshot_id:'d',event_id:'m',gt_ordinal:1,score:20,weight:.25}];
  assert.equal(m.pairStatistic(rs).value,m.q(.35/.6));
  assert.equal(m.pairStatistic([{event_id:'same',gt_ordinal:0,score:10,weight:1},{event_id:'same',gt_ordinal:1,score:20,weight:1}], 'score',true).value,null);
  assert.equal(m.pairStatistic([{event_id:'a',gt_ordinal:0,score:20,weight:1},{event_id:'b',gt_ordinal:1,score:20,weight:2}], 'score',true).value,.5);
  assert.equal(m.pairStatistic(rs.filter(r=>r.gt_ordinal>=2)).reason_code,'NO_POSITIVE_OR_NEGATIVE_WEIGHT');
});
test('Event confidence normalization and weighted cumulative quantiles preserve legitimate zero',async()=>{
  const m=await api(),rs=m.weights([{snapshot_id:'a',event_id:'e',gt_confidence:.8,score:0},
    {snapshot_id:'b',event_id:'e',gt_confidence:.8,score:10},{snapshot_id:'c',event_id:'f',gt_confidence:.2,score:100}]);
  assert.deepEqual(rs.map(r=>r.weight),[.4,.4,.2]);assert.equal(m.weightedQuantile(rs,'score',.1),0);
  assert.equal(m.weightedQuantile(rs,'score',.5),10);assert.equal(m.weightedQuantile(rs,'score',.9),100);
  assert.equal(m.weightedQuantile([],'score',.5),null);
});
test('fixed ten-point bins include score 100, missing grades and unsupported precision are explicit',async()=>{
  const m=await api(),r=rows()[0],d=m.distribution([{...r,score:0},{...r,snapshot_id:'other',event_id:'other',score:100}]);
  assert.equal(d.bins[0].sample_count,1);assert.equal(d.bins[9].sample_count,1);assert.equal(d.bins[1].reason_code,'NO_BIN_SUPPORT');
  assert.equal(d.grades[4].quantiles.p50,null);assert.equal(m.metrics([r]).grades[4].reason_code,'NO_GRADE_SUPPORT');
  assert.equal(m.metrics([r]).high_grade_precision,null);assert.equal(m.metrics([r]).high_grade_precision_reason_code,'NO_PREDICTED_HIGH_GRADE');
});
test('PAVA independent Golden merges adjacent inversions; tied scores aggregate before fitting',async()=>{
  const m=await api(),rs=rows().map((r,i)=>({...r,score:[10,20,30,40][i%4],gt_ordinal:[0,3,1,4][i%4]}));
  const fit=m.fitPava(rs);assert.equal(fit.status,'FITTED');assert.deepEqual(fit.nodes.map(n=>[n.score,n.fitted]),[[10,0],[20,2],[30,2],[40,4]]);
  assert.deepEqual(m.predictPava(fit,15),{ordinal_estimate:1,ordinal:1});assert.equal(m.predictPava(fit,32.5).ordinal,3);
  assert.equal(m.predictPava(fit,-100).ordinal_estimate,0);assert.equal(m.predictPava(fit,200).ordinal_estimate,4);
  assert.deepEqual(m.fitPava([...rs].reverse()),fit);
  const tied=m.fitPava(rs.map(r=>({...r,score:20})));assert.equal(tied.nodes.length,1);assert.equal(tied.nodes[0].fitted,2);
});
test('PAVA insufficient Event/date/level support never borrows held labels',async()=>{
  const m=await api();assert.equal(m.fitPava(rows().slice(0,20)).status,'CALIBRATION_INSUFFICIENT');
  assert.equal(m.fitPava(rows().map(r=>({...r,gt_ordinal:1}))).status,'CALIBRATION_INSUFFICIENT');
});
test('held-fold GT and future dates cannot change prior mapping Hash or no-skill',async()=>{
  const m=await api(),rs=rows(),assign=m.dateFolds(rs),a=m.fitFolds(rs,assign);
  assert.equal(a.folds.length,3);assert.ok(a.folds.every(f=>f.frozen_before_holdout));
  const held=new Set(assign.folds[0].held_members.map(r=>r.snapshot_id));
  const b=m.fitFolds(rs.map(r=>held.has(r.snapshot_id)?{...r,gt_ordinal:4,gt_confidence:.1}:r),assign);
  assert.equal(a.folds[0].mapping_sha256,b.folds[0].mapping_sha256);assert.equal(a.folds[0].no_skill_ordinal,b.folds[0].no_skill_ordinal);
  const dates=new Set(assign.folds[2].held_dates),c=m.fitFolds(rs.map(r=>dates.has(r.event_date_local)?{...r,score:100,gt_ordinal:4}:r),assign);
  assert.deepEqual(a.folds,c.folds);assert.notDeepEqual(a.oof,c.oof);
});
test('date-block Bootstrap preserves duplicate draw multiplicity and counts undefined replicates without topping up',async()=>{
  const m=await api(),rs=[{...rows()[0],event_date_local:'2026-01-01',gt_ordinal:0,score:10,control_ordinal:1,calibrated_ordinal:0},
    {...rows()[1],event_date_local:'2026-01-02',gt_ordinal:2,score:50,control_ordinal:2,calibrated_ordinal:3},
    {...rows()[2],event_date_local:'2026-01-03',gt_ordinal:2,score:50,control_ordinal:2,calibrated_ordinal:2}];
  const draws=Array.from({length:2000},()=>[0,0,1]);const boot=m.bootstrap(rs,1,draws);
  assert.equal(boot.intervals.delta_mae.ci_lower,m.q(-1/3));assert.equal(boot.intervals.auc.ci_lower,1);
  const invalid=m.bootstrap(rs,1,Array.from({length:2000},()=>[0,0,0]));assert.equal(invalid.intervals.auc.valid_replicates,0);
  assert.equal(invalid.intervals.auc.undefined_replicates,2000);assert.equal(invalid.intervals.auc.status,'NOT_ESTIMABLE');
  assert.equal(m.bootstrap([],1).intervals.auc.reason_code,'INSUFFICIENT_DATES');
});
test('route uses OOF support and strict CI boundaries; nulls never pass',async()=>{
  const m=await api(),metric={mae:1,bias:.5,qwk:.3,severe_error_rate:.2,within_1_accuracy:.8,high_grade_recall:.6};
  const options={blocked:false,signal:{main_support:true,binary_support_sufficient:true,auc:{value:.6},ordered_consistency:{value:.6}},
    boot:{intervals:{auc:{status:'COMPUTED',ci_lower:.51},ordered_consistency:{status:'COMPUTED'},delta_mae:{status:'COMPUTED',ci_upper:-.01}}},
    folds:[1,2,3].map(fold=>({fold,status:'FITTED'})),control:metric,calibration:{...metric,mae:.4},noSkill:{mae:.5},stages:{module_hypotheses:[]}};
  assert.equal(m.route(options).recommendation,'CALIBRATION_RESEARCH');
  assert.equal(m.route({...options,boot:{intervals:{...options.boot.intervals,auc:{status:'COMPUTED',ci_lower:.5}}}}).recommendation,'INCONCLUSIVE');
  assert.equal(m.route({...options,calibration:{...metric,mae:.4,qwk:null}}).calibration_supported,false);
  assert.equal(m.route({...options,signal:{...options.signal,binary_support_sufficient:false}}).recommendation,'COLLECT_MORE_EVIDENCE');
  assert.equal(m.route({...options,blocked:true}).recommendation,'BLOCKED');
  assert.equal(m.route({...options,calibration:{...metric,mae:.4,high_grade_recall:.59}}).calibration_supported,false);
});
test('case selection is deterministic, weighted and Event deduplicated within grade/direction',async()=>{
  const m=await api(),rs=rows().map(r=>({...r,gt_ordinal:0,control_ordinal:4}));rs[1].event_id=rs[0].event_id;
  const c=m.cases(rs),over=c.members.filter(r=>r.direction==='OVER');assert.equal(over.length,3);assert.equal(new Set(over.map(r=>r.event_id)).size,3);
  assert.deepEqual(m.cases([...rs].reverse()),c);assert.equal(c.members.filter(r=>r.direction==='MIN_ERROR_CONTROL').length,1);
});
test('partial trace or a large component AUC alone cannot produce module hypotheses',async()=>{
  const m=await api(),rs=rows(),traces=rs.map(r=>({snapshot_id:r.snapshot_id,trace:{status:'PARTIAL_TRACE',P:r.score,
    stages:[{stage:'hard_gate',input_score:r.score,output_score:10}]}}));
  assert.deepEqual(m.stageAnalysis(rs,traces,m.cases(rs)).module_hypotheses,[]);
});
test('closest pre-sunset selects one Snapshot per Event without future samples or label selection',async()=>{
  const m=await api(),r=rows()[0];assert.equal(m.closest([{...r,snapshot_id:'z',lead_time_minutes:-1},{...r,snapshot_id:'b',lead_time_minutes:5},
    {...r,snapshot_id:'a',lead_time_minutes:5},{...r,snapshot_id:'c',lead_time_minutes:10}])[0].snapshot_id,'a');
});
test('score package publication binds exact Plan/Runtime lineage and validates Markdown bytes',async()=>{
  const m=await api(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'score-diagnostic-'));
  try {
    const links={score_diagnostic_plan_id:'plan',score_diagnostic_plan_manifest_sha256:'a'.repeat(64),source_runtime_bundle_id:'old',
      source_runtime_bundle_manifest_sha256:'b'.repeat(64),runtime_bundle_id:'new',runtime_bundle_manifest_sha256:'c'.repeat(64)};
    const output=await m.publishGovernancePackage({output:dir,kind:'score_diagnostic',idField:'score_diagnostic_id',links,payloads:{'reports/summary.md':'# 诊断\n','a.json':{a:1}}});
    const checked=await m.inspectGovernancePackage(output.directory);assert.equal(checked.files['reports/summary.md'],'# 诊断\n');
    const deps=m.dependenciesOf(m.phaseByKey('score_diagnostic'),checked.manifest);assert.deepEqual(deps.map(d=>d.id).sort(),['new','old','plan']);
    assert.equal((await m.publishGovernancePackage({output:dir,kind:'score_diagnostic',idField:'score_diagnostic_id',links,payloads:checked.files})).status,'DEDUPLICATED');
    await fs.appendFile(path.join(output.directory,'reports/summary.md'),'tamper');await assert.rejects(()=>m.inspectGovernancePackage(output.directory));
    await assert.rejects(()=>m.publishGovernancePackage({output:dir,kind:'score_diagnostic',idField:'score_diagnostic_id',payloads:{'../x.json':{}}}));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('source JSON rejects unknown versions, missing Runtime and split/effect path substitutions',async()=>{
  const m=await api(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'score-sources-')),file=path.join(dir,'sources.json');
  try{const doc={sources_schema_version:1,...Object.fromEntries(m.sourceKeys.map(k=>[k,k]))};
    await fs.writeFile(file,JSON.stringify({...doc,sources_schema_version:2}));await assert.rejects(()=>m.readScoreSources(file));
    await fs.writeFile(file,JSON.stringify({...doc,split:'TEST'}));await assert.rejects(()=>m.readScoreSources(file));
    delete doc.sourceRuntime;await fs.writeFile(file,JSON.stringify(doc));await assert.rejects(()=>m.readScoreSources(file));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('complete workflow is deterministic, source-bound, and blocks effects for any mismatched sample',async()=>{
  const m=await api(),rs=rows().map((r,i)=>({...r,score:[30,50,70,95][i%4],replay:{score:[30,50,70,95][i%4],identity:{prediction_time_utc:'2026-01-01T10:00:00Z'},
    context:{sunset_time_utc:'2026-01-01T11:00:00Z'},engine_inputs:{sampling_mode:'LOCAL_ONLY',data_age_minutes:0},nwp:{nodes:[]}}}));
  const config={atmosphereQuality:{base:.7,scale:.3}},input={sensitivity:{baseConfig:{config,sha256:m.digest(config)}}},
    parentPlan={files:{'plan.json':{fold_assignments:m.dateFolds(rs)}}},sourceManifest={source_ids:{},
      diagnostic_plan:{id:'parent-plan',manifest_sha256:'1'.repeat(64)},diagnostic_result:{id:'parent-result',manifest_sha256:'2'.repeat(64)},
      source_runtime:{id:'old',manifest_sha256:'3'.repeat(64)},runtime:{id:'new',manifest_sha256:'4'.repeat(64)}},
    parentResult={files:{'sample_diagnostics.json':rs.map(r=>({snapshot_id:r.snapshot_id,matrix_label:'CONTROL',control_score:r.score}))}};
  const runner=async(replay,options)=>({pass:options.reference?true:null,actual:{score:replay.score},...(options.trace?{trace:{status:'COMPLETE_REPLAY_PATH',
    final_score:replay.score,components:{},stages:m.scorePolicy().required_trace_stages.map((stage,i)=>({stage,input_score:i?replay.score:null,output_score:replay.score}))}}:{})});
  const options={cohort:rs,input,sourceManifest,parentPlan,parentResult,runReplay:runner,oldControl:rs.map(r=>({snapshot_id:r.snapshot_id,reference_pass:true,actual:{score:r.score}}))};
  const plan=m.makeScorePlan(options),payloads=await m.computeScoreDiagnostics({...options,plan});
  assert.equal(payloads['decision.json'].recommendation,'CALIBRATION_RESEARCH');assert.equal(payloads['trace_compatibility.json'].status,'PASS');
  assert.equal(payloads['fold_calibrators.json'].length,3);assert.equal(payloads['oof_predictions.json'].length,40);
  assert.deepEqual(payloads,await m.computeScoreDiagnostics({...options,plan}));
  const bad=await m.computeScoreDiagnostics({...options,plan,oldControl:options.oldControl.map((r,i)=>i? r:{...r,actual:{score:100}})});
  assert.equal(bad['decision.json'].execution_status,'BLOCKED');assert.equal(bad['oof_predictions.json'].length,0);assert.equal(bad['fold_calibrators.json'].length,0);
  assert.deepEqual(payloads['stage_trace.json'],bad['stage_trace.json']);
  const changedOptions={...options,cohort:rs.map(r=>({...r,gt_ordinal:4,gt_confidence:.5}))};
  const changedGt=await m.computeScoreDiagnostics({...changedOptions,plan:m.makeScorePlan(changedOptions)});
  assert.deepEqual(payloads['stage_trace.json'],changedGt['stage_trace.json']);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'score-workflow-'));
  try {
    const links={score_diagnostic_schema_version:1,score_diagnostic_policy_version:1,result_usage:'DEVELOPMENT_ONLY',source_ids:{},
      diagnostic_plan_id:'parent-plan',diagnostic_plan_manifest_sha256:'1'.repeat(64),diagnostic_id:'parent-result',diagnostic_manifest_sha256:'2'.repeat(64),
      source_runtime_bundle_id:'old',source_runtime_bundle_manifest_sha256:'3'.repeat(64),runtime_bundle_id:'new',runtime_bundle_manifest_sha256:'4'.repeat(64)};
    const result=await m.publishGovernancePackage({output:dir,kind:'score_diagnostic',idField:'score_diagnostic_id',links,payloads,validateStaging:m.inspectScoreDiagnostic});
    assert.equal((await m.inspectScoreDiagnostic(result.directory)).status,'PASS');
    const changed={...payloads,'oof_metrics.json':{...payloads['oof_metrics.json'],control:{...payloads['oof_metrics.json'].control,mae:123}}};
    await assert.rejects(()=>m.publishGovernancePackage({output:dir,kind:'score_diagnostic',idField:'score_diagnostic_id',links,payloads:changed,validateStaging:m.inspectScoreDiagnostic}));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
