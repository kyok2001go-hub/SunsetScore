const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRuntime, load, forecast } = require('./helpers.cjs');
const FILES = ['js/config.js','js/model_config.js','js/network.js','js/domain.js','js/time.js','js/vendor/suncalc.js','js/solar.js',
  'js/baseline.js','js/cache.js','js/data.js','js/city_search.js','js/cloud_field.js','js/wind.js','js/cloud_motion.js','js/sky_state.js',
  'js/engine.js','js/sampling.js','js/corridor.js','js/nowcast.js','js/evolution.js','js/replay_service.js','js/prediction_service.js'];
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/sky-branch','practical-tuning/sky-branch-workflow', 'practical-tuning/mechanism-trace',
  'practical-tuning/engine-compatibility','practical-tuning/policy','practical-tuning/data','practical-tuning/workflow','practical-tuning/worker',
  'practical-tuning/high-cloud','practical-tuning/migrations','replay/replay-runner'].map(n=>import(`../tools/${n}.mjs`))).then(ms=>Object.assign({},...ms)); }
function state(now, future, variance=0, risk=null, cfg={}) {
  const SS=load(createRuntime(),['js/config.js','js/model_config.js','js/sky_state.js']);
  // These tests cover the state machine itself, so they pin the historical range; V2.5.5.1 production uses [1, 1].
  Object.assign(SS.modelConfig.skyState,{factorRange:[0.65,1.15]},cfg); let observation;
  const field={timestamp:1000,summary:{avgCloudCover:now,spatialVariance:variance}},motion={arrivalRisk:risk,predictions:{m60:{timestamp:3601000,summary:{avgCloudCover:future}}}};
  const off=SS.skyState.determineState(field,motion),on=SS.skyState.determineState(field,motion,undefined,t=>{observation=t;});
  assert.deepEqual(JSON.parse(JSON.stringify(off)),JSON.parse(JSON.stringify(on)));return {result:on,trace:observation,SS,field,motion};
}
test('V2.5.5.1 production default keeps the state description but fixes the sky factor at 1',()=>{
  const SS=load(createRuntime(),['js/config.js','js/model_config.js','js/sky_state.js']);
  assert.deepEqual(JSON.parse(JSON.stringify(SS.modelConfig.skyState.factorRange)),[1,1]);
  for(const [now,future,risk] of [[0,0,null],[70,20,null],[40,80,null],[50,50,{hasUpstreamDenseCloud:true,risk60m:.9,estimatedArrivalMin:20}]]){
    const r=SS.skyState.determineState({timestamp:1000,summary:{avgCloudCover:now,spatialVariance:0}},{arrivalRisk:risk,predictions:{m60:{timestamp:3601000,summary:{avgCloudCover:future}}}});
    assert.equal(r.factor,1);assert.ok(r.state&&r.label);
  }
});
test('Shared sky observer records priority, all stable subbranches and true short-circuit NOT_EVALUATED',()=>{
  const risk={hasUpstreamDenseCloud:true,risk60m:.5,estimatedArrivalMin:30};
  const arriving=state(0,0,50,risk);assert.equal(arriving.result.factor,.75);assert.equal(arriving.trace.decisions.CLEAR,'NOT_EVALUATED');
  assert.equal(arriving.trace.decisions['arrival.time_truthy'],'NOT_EVALUATED');
  for(const [now,future,variance,branch,factor] of [[0,0,0,'CLEAR',1.1],[70,20,50,'OPENING',1.15],[40,80,50,'CLOSING',.7],
    [30,30,40,'UNCERTAIN',.95],[80,80,0,'STABLE_OVERCAST',.85],[50,50,0,'STABLE_MODERATE',1.02],[65,65,0,'STABLE_OTHER',.98]]){
    const r=state(now,future,variance);assert.equal(r.trace.branch_id,branch);assert.equal(r.result.factor,factor);
  }
  const time0=state(50,50,0,{hasUpstreamDenseCloud:true,risk60m:0,estimatedArrivalMin:0});
  assert.equal(time0.trace.decisions['arrival.time_truthy'],'FALSE');assert.equal(time0.trace.decisions['arrival.time_lte90'],'NOT_EVALUATED');
  assert.equal(time0.trace.inputs.arrival_risk.risk60m,0);assert.equal(time0.trace.branch_id,'STABLE_MODERATE');
});
test('Missing summary/m60/nodes/azimuth, sector zero values and legacy OR thresholds remain distinguishable',()=>{
  const r=state(40,40),SS=r.SS;let missing;
  const value=SS.skyState.determineState(null,null,0,t=>{missing=t;});assert.equal(value.factor,1);assert.equal(missing.branch_id,'MISSING_SUMMARY');
  assert.equal(missing.rounding_status,'NOT_EXECUTED');
  let t;SS.skyState.determineState({summary:{avgCloudCover:50,spatialVariance:0}},null,0,v=>{t=v;});
  assert.ok(t.fallbacks.includes('MISSING_M60_SUMMARY_USES_CURRENT_WHOLE_MEAN'));assert.ok(t.fallbacks.includes('MISSING_CURRENT_NODES_WHOLE_SKY'));
  const field={timestamp:1,summary:{avgCloudCover:60,spatialVariance:0},nodes:[{key:'zero',azimuth:0,data:{cloud_cover:0,cloud_cover_high:0}},
    {key:'anti',azimuth:180,data:{cloud_cover:80}},{key:'side',azimuth:90,data:{cloud_cover:40}}]};
  SS.skyState.determineState(field,{predictions:{m60:{summary:{avgCloudCover:80},nodes:[]}}},0,v=>{t=v;});
  assert.equal(t.nodes[0].current_total,0);assert.equal(t.nodes[0].future60_total,0);assert.equal(t.nodes[0].future60_total_fallback,true);
  assert.equal(t.sector.unrounded_avg_now,26);assert.equal(t.inputs.avg_now,26);assert.equal(t.inputs.avg60,26);
  assert.equal(t.nodes[0].current_layers.high,0);assert.equal(t.nodes[0].future60_layers,null);
  const zero=state(10,10,0,null,{clearCloudMax:0});assert.equal(zero.trace.thresholds.configured.clearCloudMax,0);assert.equal(zero.trace.thresholds.clearCloudMax,25);
});
test('Boundary formulas, branch floor, 3-decimal rounding, internal range and coefficient zero preserve defaults',()=>{
  assert.equal(state(25,25).trace.branch_id,'CLEAR');assert.equal(state(26,26).trace.branch_id,'STABLE_OTHER');
  assert.equal(state(50,45).result.factor,1.063);assert.equal(state(50,55).result.factor,.919);
  assert.equal(state(75,75).result.factor,.98);assert.equal(state(76,76).result.factor,.85);
  const risk={hasUpstreamDenseCloud:true,risk60m:1,estimatedArrivalMin:20};
  const floor=state(60,60,0,risk);assert.equal(floor.trace.formula.raw_factor,.6000000000000001);assert.equal(floor.trace.formula.after_branch_floor,.65);
  const zero=state(60,60,0,risk,{factorCoefficients:{arrivalRiskSlope:0}});assert.equal(zero.result.factor,.9);assert.equal(zero.trace.formula.terms.coefficient,0);
  const clipped=state(60,60,0,risk,{factorRange:[.8,.9]});assert.equal(clipped.trace.rounded_factor,.65);assert.equal(clipped.result.factor,.8);
  const nonTarget=state(80,80,0,null,{factorCoefficients:{arrivalRiskSlope:0}});assert.equal(nonTarget.result.factor,.85);
});
test('Branch rank follows crossing weight, suppression, low control weight, then fixed branch order', async()=>{
  const m=await api(),b=(id,cross,supp,low)=>({branch_id:id,actionable_misses:{snapshot_count:1},crossing_down_60:{full_pool_weighted_amount:cross},weighted_suppression_total:supp,low});
  const summary={groups:[{group:'high_missed',branches:[b('CLOSING',1,20,2),b('CLOUD_ARRIVING',2,1,10)]},
    {group:'low_control',branches:[{branch_id:'CLOSING',full_pool_weighted_amount:2},{branch_id:'CLOUD_ARRIVING',full_pool_weighted_amount:10}]}]};
  assert.equal(m.rankSkyBranches(summary)[0].branch_id,'CLOUD_ARRIVING');summary.groups[0].branches[1].crossing_down_60.full_pool_weighted_amount=1;
  assert.equal(m.rankSkyBranches(summary)[0].branch_id,'CLOSING');
});
test('Sky search is 5 coarse configs including exact C and at most 8 interiors, deterministic resume and errors',async()=>{
  const m=await api(),current={skyState:{factorRange:[.65,1.15]},goldenWindow:{floor:.507692307692}},rows=[{snapshot_id:'h',event_id:'h',event_date_local:'d',location_key:'h',gt_ordinal:3,gt_confidence:.6}];
  const metrics=m.highCloudMetrics(rows,[60]),plan={selected:[{parameter_id:'sky_arrival_risk_slope',probe_values:[.18,.24,.3,.36,.42]}]};let calls=0;
  const opt={current,original:current,engine_sha256:'e',plan,originalMetrics:metrics,evaluate:async c=>{calls++;if(c.parameters.value===.42)throw Error('POINT_FAILURE');
    return {metrics:{...metrics,product_loss:c.parameters.value===null?1:.5+Math.abs(c.parameters.value-.24)},paired_migrations:{net_recovered_weight:0},predictions_sha256:String(c.parameters.value)};}};
  const s=await m.searchSky(opt);assert.equal(s.records.length,13);assert.equal(s.budget.errors,1);assert.equal(s.budget.duplicates,1);assert.equal(s.refinement.values.length,8);
  assert.equal(s.refinement.parameter_id,'sky_arrival_risk_slope');assert.ok(s.refinement.values.every(v=>v>.24&&v<.3));
  const n=calls;assert.deepEqual(await m.searchSky({...opt,restored:s.records,frozenRefinement:s.refinement}),s);assert.equal(calls,n);
  const baseline=m.installSky(current,{parameter_id:'sky_arrival_risk_slope',value:.3});assert.deepEqual(baseline,current);
  const changed=m.installSky(current,{parameter_id:'sky_arrival_risk_slope',value:0});assert.equal(changed.skyState.factorCoefficients.arrivalRiskSlope,0);
  assert.equal(changed.goldenWindow.floor,.507692307692);assert.throws(()=>m.installSky(current,{parameter_id:'sky_arrival_risk_slope',value:1.1}));
  assert.equal((await m.searchSky({...opt,maxCandidates:2})).budget.termination,'BUDGET_REACHED');
  await assert.rejects(m.searchSky({...opt,evaluate:async()=>{throw Error('FAIL');}}),/NO_VALID_BASELINE/);
});
test('Coupling rejects a non-target score/factor change or protected Q/Fgw drift',async()=>{
  const m=await api(),a={snapshot_id:'x',branch_id:'CLEAR',state:'CLEAR',applied_factor:1.1,returned_factor:1.1,final_score:55,protected_sha256:'q',formula_sha256:'f'};
  assert.equal(m.assertSkyCoupling([a],[{...a}],'CLOUD_ARRIVING').status,'PASS');
  assert.throws(()=>m.assertSkyCoupling([a],[{...a,final_score:56}],'CLOUD_ARRIVING'),/NON_TARGET_PREDICTION_CHANGED/);
  assert.throws(()=>m.assertSkyCoupling([a],[{...a,protected_sha256:'changed-Q-or-Fgw'}],'CLOUD_ARRIVING'),/OTHER_COMPONENT_OR_BRANCH_CHANGED/);
});
test('Pinned default-engine compatibility requires exact allowed old/new files and rejects any additional drift',async()=>{
  const m=await api(),current=await m.codeIdentity(),files={...current.files,
    'js/sky_state.js':'03410f3126c19a12d90ecf4701e60293ed3ff4153dbc51bdbff17a2dcd158bdb',
    'js/config.js':'76725e9e0a1408efff22f4e805a11e40ec5912f5adf7e6a642941ea71f75ad46',
    'js/engine.js':'8e7cb69d24688aa1fb4cbe6549d0ee2aebb41056a5875c32cbbc4e9505635a9d',
    'js/model_config.js':'ba84a59f1028cc33867479ddcb98925ea4663d07e70554d7ca67a0a2dac0f204'};
  const old={...current,files,engine_sha256:m.digest(Object.fromEntries(m.REPLAY_RUNTIME_FILES.map(f=>[f,files[f]])))};
  assert.throws(()=>m.assertCompatibleEngine(current,old),/PRACTICAL_CODE_MISMATCH/);
  const proof=m.assertCompatibleEngine(current,old,{allowDefaultCompatibility:true});
  assert.equal(proof.mode,'PINNED_EXPLICIT_FROZEN_CONFIG_COMPATIBLE_MODEL2550_RELEASE');
  assert.notEqual(proof.old_engine_sha256,proof.current_engine_sha256);
  assert.throws(()=>m.assertCompatibleEngine({...current,files:{...current.files,'js/engine.js':'unexpected'}},old,{allowDefaultCompatibility:true}),/PRACTICAL_CODE_MISMATCH/);
  assert.throws(()=>m.assertCompatibleEngine(current,{...old,engine_sha256:'unrecognized-engine'},{allowDefaultCompatibility:true}),/PRACTICAL_CODE_MISMATCH/);
});
test('Sky Phase7 preserves C when probes only worsen loss and never calls unchanged recall recognition gain',async()=>{
  const m=await api(),rows=[{snapshot_id:'h',event_id:'h',event_date_local:'d',location_key:'h',gt_ordinal:3,gt_confidence:.6}],metrics=m.highCloudMetrics(rows,[60]);
  const rec=(id,loss)=>({candidate_id:id,status:'EVALUATED',parameter_distance:0,metrics:{...metrics,product_loss:loss},predictions_sha256:'identical-scores'});
  const baseline=rec('C',1),worse=rec('worse',1.1),improved=rec('improved',.99);
  const keep=m.selectSky([baseline,worse],'C',metrics);assert.equal(keep.selection_status,'KEEP_CONTROL');assert.equal(keep.phase7_completed,true);
  const gain=m.selectSky([baseline,improved],'C',metrics);assert.equal(gain.high_grade_recognition_improved,false);assert.equal(gain.practical_tuning_schema_version,5);
  assert.equal(gain.same_prediction_groups[0].length,2);
});
test('Production capture and Replay apply the same shared sky factor with coefficient zero and fixed external clamp',async()=>{
  const m=await api(),SS=load(createRuntime(),FILES),fc=forecast({cloud:80,low:30,mid:40,high:20});fc.timezone='Asia/Shanghai';fc.utc_offset_seconds=28800;
  SS.modelConfig.skyState.factorCoefficients.arrivalRiskSlope=0;SS.modelConfig.skyState.factorRange=[0.65,1.15];
  SS.data.fetchForecastWithRetry=async()=>fc;SS.data.fetchAirQuality=async()=>null;
  SS.data.gather=async nodes=>({samples:nodes.map(point=>({point,forecast:fc})),successCount:nodes.length});
  const motion={arrivalRisk:{hasUpstreamDenseCloud:true,risk60m:.8,estimatedArrivalMin:20},predictions:{m60:{summary:{avgCloudCover:80,spatialVariance:0},nodes:[]}}};
  SS.cloudMotion.forecast=()=>motion;
  const result=await SS.prediction.predict('31.23,121.47',{nowUtcMs:Date.parse('2026-08-26T02:00:00Z'),captureReplay:true});
  await m.runReplay(result.replay_payload);const rt=globalThis.SunsetScore,old=rt.cloudMotion.forecast;rt.cloudMotion.forecast=()=>motion;
  try{const replay=await m.runReplay(result.replay_payload,{trace:true,skyBranchTrace:true});assert.equal(result.sky_evolution_factor,.9);
    assert.equal(replay.actual.sky_evolution_factor,result.sky_evolution_factor);assert.equal(replay.actual.score,result.score);
    assert.equal(replay.trace.sky_branch.fusion.applied_factor,.9);assert.deepEqual(replay.trace.sky_branch.fusion.external_range,[.65,1.15]);
  }finally{rt.cloudMotion.forecast=old;}
});
test('V5 disk run freezes branch plan and exports/recovers; V1–V4 stay verifiable', {timeout:300000},async t=>{
  const m=await api(),root=await fs.mkdtemp(path.join(os.tmpdir(),'sky-p13-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const fixture=await require('./evaluation-fixture.cjs').createSyntheticPipeline(root,{replayTransform:r=>{for(const n of r.nwp.nodes){n.variables.cloud_cover=n.variables.cloud_cover.map(()=>50);}return r;}});t.after(fixture.close);
  // Historical workflow prerequisites are frozen at the original 2.4.6 base.
  await require('./helpers.cjs').pinLegacyTuningBase(t);
  const sources={raw:fixture.rawDir,gt:fixture.gtDir,model:fixture.modelDir},output=path.join(root,'runs');
  const v1=await m.practicalRun({...sources,output,recognitionFirst:true,maxCandidates:1});
  const v2=await m.practicalRun({...sources,output,searchSpace:'high-cloud',baselineRun:v1.directory,maxCandidates:1});
  const v3=await m.practicalRun({...sources,output,searchSpace:'mid-cloud',baselineRun:v2.directory,maxCandidates:1});
  const v4=await m.practicalRun({...sources,output,searchSpace:'mechanism-targeted',baselineRun:v3.directory,maxCandidates:1});
  const opts={...sources,output,searchSpace:'sky-branch',baselineRun:v4.directory,maxCandidates:1};const run=await m.practicalRun(opts);
  const req=JSON.parse(await fs.readFile(path.join(run.directory,'verification_request.json')));
  assert.equal(run.phase7_completed,true);assert.equal((await m.inspectPractical(run.directory)).manifest.practical_tuning_schema_version,5);
  assert.equal(req.trace_rows.length,req.pool.included.length);assert.deepEqual(req.spec.baseline_config,JSON.parse(await fs.readFile(path.join(v4.directory,'selected_effective_config.json'))));
  assert.equal((await m.verifyPractical(run.directory)).selected_branch_trace_and_coupling_equal,true);
  for(const v of [v1,v2,v3,v4])assert.equal((await m.verifyPractical(v.directory)).status,'PASS');
  const bad=structuredClone(req);bad.selected_sky_traces[0].sky_branch.fusion.applied_factor+=.01;
  await assert.rejects(m.verifySkyRequest(bad),/SKY_SELECTED_TRACE_RECOMPUTE_MISMATCH/);
  const work=path.join(output,'.work',`practical_preparation_v5_${req.spec.identity.base_identity_sha256.slice(0,20)}`);await fs.rename(run.directory,work);await fs.rm(path.join(work,'manifest.json'));
  assert.equal((await m.practicalRun({...opts,resume:true})).run_id,run.run_id);assert.equal((await m.practicalRun(opts)).deduplicated,true);
});
