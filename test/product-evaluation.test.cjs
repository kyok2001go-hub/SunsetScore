const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
let modules;
async function api(){return modules||=Promise.all(['product-evaluation/policy','product-evaluation/metrics','product-evaluation/selection','product-evaluation/mapping',
  'product-evaluation/sources','product-evaluation/workflow','product-evaluation/search','product-evaluation/validation','product-evaluation/package','product-evaluation/cli',
  'optimization/optimization-policy','optimization/optimization-schema','validation/validation-policy','validation/validation-schema',
  'optimization/lib/search-space','optimization/lib/beam','optimization/lib/candidate','optimization/lib/generator','optimization-diagnostics/engine',
  'score-diagnostics/statistics','experiment-runtime/lib/package','maintenance/maintenance-policy','dataset/lib/common'].map(n=>import(`../tools/${n}.mjs`))).then(list=>Object.assign({},...list));}
function row(i,y,p,date='2026-09-01',confidence=1){return {snapshot_id:`s${i}`,event_id:`e${i}`,location_key:`l${i}`,event_date_local:date,
  gt_ordinal:y,gt_confidence:confidence,predicted_ordinal:p,control_ordinal:Math.min(4,y+1),lead_time_bucket:'T_0_30M',scheduled_slot:'1755',regime_label:'CLEAR'};}
async function fixture(){
  const m=await api(),config={w:{x:.5,y:.5},base:.7,scale:.3,center:60,width:25,horizonGate:[{min:10,gate:30},{min:5,gate:20}]};
  const oat=(id,key,values,range)=>({parameter_id:id,canonical_path:key,probe_absolute:values,range,unit_category:'OAT',optimizable:true,wired_status:'WIRED',replay_class:'REPLAY_SAFE'});
  const registry={units:[{parameter_id:'component_weights',canonical_path:'w',members:['x','y'],probe_factors:[.8,1.2],unit_category:'SIMPLEX',optimizable:true,wired_status:'WIRED',replay_class:'REPLAY_SAFE'},
    oat('atmosphere_quality_base','base',[.49,.595,.7,.805,.91],[0,1]),oat('atmosphere_quality_scale','scale',[.21,.255,.3,.345,.39],[0,1]),
    oat('high_cloud_center','center',[42,51,60,69,78],[0,100]),oat('high_cloud_width','width',[18,21,25,29,33],[1,60])]};
  const baseConfig={config,sha256:m.digest(config)},space={...m.buildSearchSpace({mode:'EXPLORATORY_SEARCH',registry,baseConfig,linkage:{parameter_registry_sha256:m.digest(registry)},readiness:{},policyVersion:5}),base_config:baseConfig};
  const cohort=Array.from({length:80},(_,i)=>({...row(String(i).padStart(3,'0'),i%4,i%4,`2026-09-${String(1+Math.floor(i/4)).padStart(2,'0')}`),
    gt_label:['poor','fair','good','very_good'][i%4],event_normalized_weight:1,replay:{target:[10,30,50,70][i%4]}}));
  const runner=async(replay,{modelConfig,reference}={})=>({pass:reference?true:null,actual:{score:replay.target+(modelConfig?.scoring.base===.7?20:0),gw_factor:1,sky_evolution_factor:1}});
  const assignments=m.dateFolds(cohort),reference=cohort.map(r=>({snapshot_id:r.snapshot_id,control_score:r.replay.target+20,pass:true}));
  const scorePlan={files:{'plan.json':{fold_assignments:assignments}}};
  const calibrators=assignments.folds.map(f=>({fold:f.fold,status:'FITTED',nodes:[{score:0,fitted:0},{score:100,fitted:4}]}));
  const oof=assignments.folds.flatMap(f=>f.held_members.map(member=>{const r=cohort.find(v=>v.snapshot_id===member.snapshot_id),score=r.replay.target+20,estimate=m.predictPava(calibrators.find(c=>c.fold===f.fold),score);return {...r,score,fold:f.fold,control_ordinal:Math.floor(score<90?score/20:4),calibrated_ordinal:estimate.ordinal,calibrated_estimate:estimate.ordinal_estimate};}));
  const ref=id=>({id,manifest_sha256:'a'.repeat(64)});
  const sourceManifest={source_ids:{},legacy_sources:{},runtimes:{sourceRuntime:ref('source_runtime'),scoreRuntime:ref('score_runtime'),runtimeBundle:ref('current_runtime')},
    artifacts:Object.fromEntries(['diagnosticPlan','diagnosticResult','scorePlan','scoreResult'].map(k=>[k,ref(k)])),history_prefixes:[]};
  const base=cohort.map(({replay,...r})=>r),loaded={train:base,structural:{VALIDATION:[],TEST:[]},mapping:{status:'PASS'},rawLineage:{status:'SOURCE_EVIDENCE_GAP'},testAudit:{exposure_status:'UNKNOWN'},sourceManifest,
    legacy:{},scorePlan,score:{manifest:{score_diagnostic_id:'score_fixture'},files:{'reference_parity.json':{rows:reference},'oof_predictions.json':oof,'fold_calibrators.json':calibrators}},
    diagnostic:{manifest:{diagnostic_id:'diagnostic_fixture'},files:{'matrix_metrics.json':[],'sample_diagnostics.json':[],
      'oof_summary.json':{samples:oof.map(r=>({...r,experiment_score:r.score,experiment_ordinal:r.control_ordinal}))}}},searchSpace:space,runtime:{manifest_sha256:'fixture'}};
  return {m,config,registry,space,cohort,runner,loaded,assignments};
}
test('Product Policy freezes all 25 prediction-row/actual-column prices and separates confirmation from defaults',async()=>{
  const m=await api(),p=m.productPolicy();assert.equal(p.technical_defaults_not_user_confirmed_prices,true);
  for(let predicted=0;predicted<5;predicted++)for(let actual=0;actual<5;actual++){
    const expected=predicted===4&&actual===0?24:predicted===4&&actual===1?16:(predicted-actual)**2;
    const metrics=m.productMetrics([row(`${predicted}${actual}`,actual,predicted)]);assert.equal(metrics.product_loss,expected);
    assert.equal(metrics.confusion_matrix.count[predicted][actual],1);assert.equal(metrics.critical_overprediction.snapshot_count,Number(predicted===4&&actual<=1));
  }
  assert.equal(m.productMetrics([row(1,1,4)]).product_loss,16);assert.equal(m.productMetrics([row(2,2,4)]).product_loss,4);
  assert.throws(()=>m.productPolicy(2));assert.throws(()=>m.productSchema(2));
});
test('Event confidence is normalized in each cohort, count/weighted confusion and slice denominators remain auditable',async()=>{
  const m=await api(),a=row('a',0,4,'2026-09-01',.5),b={...a,snapshot_id:'sa2'},c=row('c',3,3,'2026-09-02',1);
  const r=m.productMetrics([a,b,c]);assert.equal(r.product_loss,8);assert.equal(r.confusion_matrix.count[4][0],2);assert.equal(r.confusion_matrix.weighted[4][0],.5);
  assert.equal(r.critical_overprediction.rate,m.q(1/3));assert.equal(r.critical_overprediction.event_count,1);
  assert.equal(m.productMetrics([a,c]).product_loss,r.product_loss);assert.throws(()=>m.productMetrics([a,{...a,snapshot_id:'another',gt_ordinal:1}]));
  assert.ok(m.productSlices([a,b,c]).every(s=>s.metrics.confusion_matrix.count.length===5));
});
test('No prediction 4 yields null conditional precision, ordinal 3/4 misses are separate from target >=2',async()=>{
  const m=await api(),r=m.productMetrics([row(1,3,2),row(2,4,1)]);assert.equal(r.grade4_status,'NOT_ASSESSED');assert.equal(r.predicted4_actual_ge3_precision,null);assert.equal(r.critical_overprediction.conditional_on_predicted4,null);
  assert.equal(r.target_ge3.recall,0);assert.equal(r.target_ge2.recall,.5);assert.equal(r.target_ge3.miss_rate,1);assert.equal(r.underprediction_ge2,.5);
});
test('TRAIN optimal constant minimizes product loss with lower ordinal tie; fixed 1/2 and legacy median are distinct',async()=>{
  const m=await api();assert.equal(m.estimateConstant([row(1,0,0),row(2,1,1)]).ordinal,0);
  const rows=[row(1,0,0),row(2,3,3)];assert.equal(m.estimateConstant(rows).ordinal,1);
  const evaluated=m.evaluateProductRows(rows,{constantOrdinal:1,oldNoSkillOrdinal:0,identity:'constant-test'});
  assert.deepEqual(evaluated.baselines.map(b=>b.id),['TRAIN_OPTIMAL_PRODUCT_CONSTANT','FIXED_ORDINAL_1','FIXED_ORDINAL_2','LEGACY_TRAIN_WEIGHTED_MEDIAN_ORDINAL']);
});
test('Always 0/1 cannot qualify just by avoiding critical errors; recall tolerance and ordinal 3/4 support are enforced',async()=>{
  const m=await api(),rows=Array.from({length:30},(_,i)=>row(i,i%2?3:0,i%2?3:0,`2026-09-${String(1+i%3).padStart(2,'0')}`)),control=m.productMetrics(rows,'control_ordinal'),constant=m.estimateConstant(rows);
  assert.equal(m.qualification(m.productMetrics(rows),control,constant.product_loss).development_qualified,true);
  for(const low of [0,1])assert.equal(m.qualification(m.productMetrics(rows.map(r=>({...r,predicted_ordinal:low}))),control,constant.product_loss).development_qualified,false);
  const good=m.productMetrics(rows);good.target_ge2.recall=control.target_ge2.recall-.05;assert.equal(m.qualification(good,control,constant.product_loss).development_qualified,true);
  good.target_ge2.recall-=.0001;assert.equal(m.qualification(good,control,constant.product_loss).development_qualified,false);
  good.target_ge2.recall=1;good.target_ge3.support.event_count=9;assert.ok(m.qualification(good,control,constant.product_loss).reason_codes.includes('INSUFFICIENT_PRODUCT_SUPPORT'));
  assert.equal(m.productSupportSufficient({event_count:10,date_count:2}),false);assert.equal(m.productSupportSufficient({event_count:9,date_count:7}),false);assert.equal(m.productSupportSufficient({event_count:10,date_count:3}),true);
});
test('Product ranking ties use >=2 recall; Pareto null >=3 recall is never optimal and parents retain 4/2/2 seats',async()=>{
  const m=await api(),record=(i,qualified,basic)=>({status:'FEASIBLE',candidate:{candidate_id:`c${i}`,canonical_vector:{['x'+i]:i},changed_unit_count:1,normalized_parameter_distance:.1},
    metrics:{product_loss:1,mae:1,critical_overprediction:{rate:.1},target_ge2:{recall:.8},target_ge3:{recall:.8}},quality:'PRODUCT',gates:[],reason_codes:[],train_all_guards_pass:qualified,basic_guards_pass:basic});
  const records=Array.from({length:8},(_,i)=>record(i,i<4,i<6)),seats=m.selectProductParents(records);
  assert.deepEqual(seats.map(s=>s.source),['PRODUCT_TRAIN_QUALIFIED','PRODUCT_TRAIN_QUALIFIED','PRODUCT_TRAIN_QUALIFIED','PRODUCT_TRAIN_QUALIFIED','PRODUCT_BASIC_PARETO','PRODUCT_BASIC_PARETO','PRODUCT_EXPLORATORY_PARETO','PRODUCT_EXPLORATORY_PARETO']);
  const a=record(10,false,false),b=record(11,false,false);a.metrics.target_ge3.recall=null;assert.equal(m.productDominates(b,a),true);
  a.metrics.target_ge2.recall=.9;assert.equal(m.rankProduct([b,a])[0].candidate.candidate_id,'c10');
});
test('Schema/Policy 5 is explicit and nonformal; legacy defaults and exact maintenance matrix remain intact',async()=>{
  const m=await api();assert.equal(m.optimizationPolicy().optimization_policy_version,1);assert.equal(m.validationPolicy().validation_policy_version,1);
  assert.equal(m.optimizationPolicy(5).formal_capable,false);assert.equal(m.validationPolicy(5).formal_capable,false);
  assert.equal(m.optimizationSchema(2,5).optimization_policy_version,5);assert.throws(()=>m.optimizationSchema(1,5));assert.throws(()=>m.validationSchema({policyVersion:5,includeSelected:true}));
  assert.equal(m.isSupportedVersion(m.phaseByKey('optimization'),2,5),true);assert.equal(m.isSupportedVersion(m.phaseByKey('optimization'),1,5),false);
  assert.throws(()=>m.optimizationPolicy(6));assert.throws(()=>m.validationPolicy(6));
  assert.equal(m.parseProductArgs(['plan','--sources','s.json','--policy-version','1']).options.policyVersion,1);assert.throws(()=>m.parseProductArgs(['plan','--sources','s.json','--policy-version','2']));
});
test('Mapping audit checks all paths, 101 score positions, stable 0–4 names and legacy UI aliases without relabeling',async()=>{
  const m=await api(),audit=await m.mappingAudit(path.resolve(__dirname,'..'));assert.equal(audit.status,'PASS');assert.ok(audit.paths.length>=10);assert.ok(audit.paths.every(p=>p.source_sha256.length===64));
  assert.deepEqual(m.productPolicy().ordinal_names,['无霞','微霞','普通','很好','极佳']);
});
test('Statistical reader refuses TEST; structural TEST projection ignores outcome and score columns',async t=>{
  const m=await api(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'sunset-product-structure-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));await fs.mkdir(path.join(temp,'splits'));
  await assert.rejects(m.readProductModel(temp,'TEST'),/PRODUCT_TEST_EFFECT_ACCESS_FORBIDDEN/);
  const file=path.join(temp,'splits/test.csv'),prefix='\uFEFFsnapshot_id,event_id,location_key,event_date_local,split,gt_ordinal,predicted_score\r\n';
  await fs.writeFile(file,prefix+'s,e,l,2026-09-01,TEST,0,100\r\n');const before=await m.structuralMembers(temp,'TEST');
  await fs.writeFile(file,prefix+'s,e,l,2026-09-01,TEST,4,0\r\n');assert.deepEqual(await m.structuralMembers(temp,'TEST'),before);assert.deepEqual(Object.keys(before[0]).sort(),['event_date_local','event_id','location_key','snapshot_id']);
});
test('Date Bootstrap is deterministic, identity-seeded and preserves repeated date weights without refill',async()=>{
  const m=await api(),rows=[row(1,0,0,'2026-09-01'),row(2,3,3,'2026-09-02'),row(3,4,3,'2026-09-03')],a=m.deltaLossInterval(rows,'a');
  assert.deepEqual(a,m.deltaLossInterval(rows,'a'));assert.notEqual(a.seed,m.deltaLossInterval(rows,'b').seed);assert.equal(a.valid_replicates,2000);assert.equal(a.refill,false);
  assert.equal(m.deltaLossInterval([rows[0]],'one').status,'NOT_ESTIMABLE');
});
test('Beam and refinement use the product selector and retain joint coordinates, training baseline ignores future labels',async()=>{
  const {m,space,cohort,runner}=await fixture(),first=cohort.filter(r=>r.event_date_local<='2026-09-10');
  const search=await m.searchProductCohort({cohort:first,searchSpace:space,runReplay:runner});assert.equal(search.budget.unique_candidates,100);
  assert.ok(search.selection_trace.some(r=>r.stage==='BEAM'&&r.source.startsWith('PRODUCT_')));assert.ok(search.selection_trace.some(r=>r.stage==='REFINEMENT'&&r.source.startsWith('PRODUCT_')));
  assert.equal(search.constant.training_support.date_count,10);
  const futureMutated=cohort.map(r=>r.event_date_local>'2026-09-10'?{...r,gt_ordinal:0,gt_label:'poor'}:r);
  const again=await m.searchProductCohort({cohort:futureMutated.filter(r=>r.event_date_local<='2026-09-10'),searchSpace:space,runReplay:runner});assert.deepEqual(search,again);
  const parent={canonical_vector:{atmosphere_quality_base:.595}};for(const p of m.coordinateExpansions({searchSpace:space,parent}).filter(r=>r.parameter_id==='component_weights'))assert.equal(p.vector.atmosphere_quality_base,.595);
});
test('Reassessment keeps panels separate, original OOF maps unchanged and unavailable predictions visible; no Replay needed',async()=>{
  const {m,loaded,cohort}=await fixture(),c=m.candidateFromVector(loaded,{},'old');
  loaded.diagnostic.files['matrix_metrics.json']=[{candidate:c,label:'CONTROL',quality:'LEGACY',gates:[]}];
  loaded.diagnostic.files['sample_diagnostics.json']=cohort.map(r=>({...r,candidate_id:c.candidate_id,control_score:r.replay.target+20,control_ordinal:Math.floor((r.replay.target+20)<90?(r.replay.target+20)/20:4),experiment_score:r.replay.target+20,experiment_ordinal:Math.floor((r.replay.target+20)<90?(r.replay.target+20)/20:4)}));
  const plan=await m.makeProductPlan(loaded),before=m.digest(loaded.score.files['fold_calibrators.json']),payload=await m.computeReassessment(loaded,plan);
  assert.equal(payload['decision.json'].recommendation,'RUN_ONE_CONSTRAINED_TRAIN_SEARCH');assert.equal(m.digest(loaded.score.files['fold_calibrators.json']),before);
  assert.equal(payload['candidate_product_metrics.json'].no_global_cross_cohort_ranking,true);assert.equal(payload['constant_baselines.json'].fold_train[1].training_support.date_count,10);
  const bad=structuredClone(loaded);bad.diagnostic.files['sample_diagnostics.json'][0].gt_ordinal=4;await assert.rejects(m.computeReassessment(bad,plan),/PRODUCT_PREDICTION_MEMBER_OR_GT_MISMATCH/);
  const changed=m.candidateFromVector(loaded,{atmosphere_quality_base:.595},'changed');
  assert.notEqual(changed.changes[0].delta,m.q(changed.changes[0].delta));
  loaded.diagnostic.files['matrix_metrics.json'].push({candidate:changed,label:'CHANGED',quality:'LEGACY',gates:[]});
  loaded.diagnostic.files['sample_diagnostics.json'].push(...loaded.diagnostic.files['sample_diagnostics.json'].filter(r=>r.candidate_id===c.candidate_id).map(r=>({...r,candidate_id:changed.candidate_id})));
  const changedPlan=await m.makeProductPlan(loaded),withChanged=await m.computeReassessment(loaded,changedPlan),{plan_core_sha256,...core}=withChanged['plan.json'];
  assert.equal(m.digest(core),plan_core_sha256);assert.equal(m.digest(withChanged['plan.json']),m.digest(changedPlan));
  assert.equal(withChanged['candidate_product_metrics.json'].panels.find(r=>r.candidate_id===changed.candidate_id).candidate.changes[0].delta,changed.changes[0].delta);
});
test('Full three-fold product search has a supported positive branch, freezes qualified configs only and stays within 400',async()=>{
  const {m,loaded,cohort,runner,assignments}=await fixture(),plan={fold_assignments:assignments,plan_core_sha256:'a'.repeat(64)};
  const payload=await m.computeProductSearch(loaded,plan,{cohort,runReplay:runner});
  assert.equal(payload['oof_metrics.json'].status,'PROCEDURE_SUPPORTED');assert.equal(payload['decision.json'].total_proposals,400);
  assert.ok(payload['final_candidates.json'].length>0&&payload['final_candidates.json'].length<=5);assert.ok(payload['final_candidates.json'].every(r=>r.eligibility.development_qualified));
  assert.ok(payload['fold_candidates.json'].every(f=>f.candidate.frozen_before_holdout));assert.equal(payload['decision.json'].formal_capable,false);assert.equal(payload['decision.json'].selected,null);
  const weak=structuredClone(payload['fold_metrics.json']);for(const f of weak)f.held.delta_product_loss=0;const failure=m.productProcedure(weak,payload['oof_predictions.json'],'weak');assert.equal(failure.status,'PROCEDURE_NOT_SUPPORTED');
  const lastCandidate=payload['final_candidates.json'][0].candidate,valRows=cohort.slice(0,40),constant=m.estimateConstant(cohort);
  const validation=await m.computeProductValidation(loaded,{validation_members:m.memberRows(valRows),candidates:[lastCandidate],train_constant:constant,old_no_skill_ordinal:1,plan_core_sha256:'b'.repeat(64)},{cohort:valRows,runReplay:runner});
  assert.equal(validation['decision.json'].recommendation,'PRODUCT_DEVELOPMENT_SUPPORTED');assert.equal(validation['decision.json'].selected,null);assert.equal(validation['legacy_gate_comparison.json'][0].old_classification_rewritten,false);
});
test('Product packages are immutable and deduplicate; recomputation scope and tampering are refused',async t=>{
  const {m,loaded}=await fixture(),plan=await m.makeProductPlan(loaded),payload=await m.computeReassessment(loaded,plan);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sunset-product-package-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const params={output:temp,kind:'product_evaluation',idField:'product_evaluation_id',payloads:payload,
    links:m.productManifestLinks(loaded),validateStaging:m.inspectProductPackage};
  const result=await m.publishGovernancePackage(params),again=await m.publishGovernancePackage(params);assert.equal(again.status,'DEDUPLICATED');assert.equal(again.product_evaluation_id,result.product_evaluation_id);
  assert.equal((await m.inspectProductPackage(result.directory)).status,'PASS');
  m.compareProductRecompute(payload,{payload_sha256:m.digest(payload),scope:'FROZEN_PREDICTION_RESUMMARIZATION_NO_REPLAY'},'product_evaluation');
  assert.throws(()=>m.compareProductRecompute(payload,{payload_sha256:m.digest(payload),scope:'FULL_PRODUCT_REPLAY_AND_STATISTICS'},'product_evaluation'));
  await fs.writeFile(path.join(result.directory,'product_policy.json'),'{}');await assert.rejects(m.inspectProductPackage(result.directory));
  await assert.rejects(m.checkProductSources({contextReferences:[{directory:result.directory,manifest_sha256:'0'.repeat(64)}]},{}));
});
test('Unsupported sparse ordinal 3/4 process stops at 300 proposals without final search or validation list',async()=>{
  const {m,loaded,cohort,runner,assignments}=await fixture();
  const sparse=cohort.map(r=>r.gt_ordinal===3&&r.event_date_local!=='2026-09-20'?{...r,gt_ordinal:0,gt_label:'poor'}:r);
  const result=await m.computeProductSearch(loaded,{fold_assignments:assignments,plan_core_sha256:'c'.repeat(64)},{cohort:sparse,runReplay:runner});
  assert.equal(result['decision.json'].total_proposals,300);assert.equal(result['decision.json'].validation_allowed,false);assert.deepEqual(result['final_candidates.json'],[]);
  assert.equal(result['decision.json'].business_conclusion,'INSUFFICIENT_PRODUCT_SUPPORT');assert.equal(result['decision.json'].followup_hypotheses.length,1);
});
test('Single frozen search/validation reservation survives retries, rejects a different list across output roots',async t=>{
  const m=await api(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'sunset-product-reservation-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const registry=path.join(temp,'history.json');await fs.writeFile(registry,JSON.stringify({history_ledgers_schema_version:1,ledgers:[]}));
  const loaded={paths:{model:path.join(temp,'model/exports/fake'),historyLedgers:registry,accessLedger:path.join(temp,'primary')}};
  const plan={plan_core_sha256:'a'.repeat(64)};await m.reserveProductAttempt(loaded,'parent','PRODUCT_VALIDATION_LIST_FROZEN',plan);
  await m.reserveProductAttempt(loaded,'parent','PRODUCT_VALIDATION_LIST_FROZEN',plan);
  await assert.rejects(m.reserveProductAttempt(loaded,'parent','PRODUCT_VALIDATION_LIST_FROZEN',{plan_core_sha256:'b'.repeat(64)}),/PRODUCT_SINGLE_FROZEN_ATTEMPT_ALREADY_RESERVED/);
  await m.reserveProductAttempt(loaded,'parent','PRODUCT_SEARCH_PLAN_FROZEN',plan);
  await assert.rejects(m.reserveProductAttempt(loaded,'parent','UNDECLARED_ACTION',plan));
});
test('Reference/Control incompleteness blocks the entire product evaluator before candidate comparisons',async()=>{
  const {m,space,cohort,runner}=await fixture();await assert.rejects(m.productEvaluator({cohort:cohort.slice(0,4),searchSpace:space,
    runReplay:async(replay,options)=>({...await runner(replay,options),pass:options?.reference?false:null})}),/PRODUCT_REFERENCE_CONTROL_INCOMPLETE/);
});
test('A relocated Runtime includes the exact public HTML mapping evidence needed by its independent Product worker',async t=>{
  const m=await api(),{freezeRuntime,verifyBundle,allowedSource}=await import('../tools/experiment-runtime/lib/bundle.mjs');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sunset-product-runtime-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  assert.equal(allowedSource('admin/backfill.html'),true);assert.equal(allowedSource('index.html'),true);assert.equal(allowedSource('admin/private.html'),false);
  const frozen=await freezeRuntime({output:path.join(temp,'runtime')}),verified=await verifyBundle(frozen.directory),audit=await m.mappingAudit(verified.source);
  assert.equal(audit.status,'PASS');assert.equal(m.digest(audit),m.digest(await m.mappingAudit(path.resolve(__dirname,'..'))));
  const inventory=JSON.parse(await fs.readFile(path.join(frozen.directory,'file_inventory.json'),'utf8'));assert.ok(inventory['admin/backfill.html']);assert.ok(inventory['index.html']);
});
