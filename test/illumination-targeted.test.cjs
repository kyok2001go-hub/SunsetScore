const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createRuntime,load,CORE_FILES,forecast}=require('./helpers.cjs');
let modules;
const api=()=>modules ||= Promise.all(['practical-tuning/illumination-targeted','practical-tuning/illumination-workflow','practical-tuning/illumination-trace',
  'practical-tuning/mechanism-trace','practical-tuning/data','practical-tuning/policy','practical-tuning/high-cloud','practical-tuning/workflow','practical-tuning/engine-compatibility','replay/replay-runner'].map(n=>import(`../tools/${n}.mjs`))).then(ms=>Object.assign({},...ms));
function fixture({nodes=[{d:0,o:0},{d:50,o:0},{d:100,o:30},{d:200,o:-30}],twilight=35,model={},mutate=()=>{}}={}){
  const SS=load(createRuntime(),CORE_FILES);Object.assign(SS.config,{highCloudCenter:0,midCloudCenter:0});Object.assign(SS.config.illuminationModel,model);
  const samples=nodes.map(n=>{const fc=forecast({high:n.high??0,mid:n.mid??0,low:0});if(n.missing){fc.hourly.cloud_cover_high.fill(null);fc.hourly.cloud_cover_mid.fill(null);fc.engineNullClouds=true;}return {point:{distanceKm:n.d,azimuthOffset:n.o},forecast:fc};});
  // Supply true null cloud inputs directly to the engine for fallback Golden tests.
  // The separate source test below covers the existing interpolation zero default.
  const extract=SS.cloudField.extractInterpolatedAt;SS.cloudField.extractInterpolatedAt=(fc,at)=>{const v=extract(fc,at);return fc.engineNullClouds?{...v,cloud_cover_high:null,cloud_cover_mid:null}:v;};
  mutate(SS,samples);const sunset=new Date('2026-08-26T18:30:00Z'),input={location:{name:'Fixture',country:'Test',latitude:31.23,longitude:121.47},utcOffsetSeconds:0,
    localNowUtc:new Date('2026-08-26T17:00:00Z'),solar:{sunset,civilDusk:new Date(sunset.valueOf()+twilight*60000),twilightMinutes:twilight,sunsetAzimuthDeg:270},
    sunsetLocal:sunset,samples,air:null,expectedSampleCount:samples.length,spatialCompleteness:1};
  let trace;const off=SS.engine.compute(input),on=SS.engine.compute({...input,illuminationTrace:true,offlineTrace:t=>{trace=t;}});
  assert.deepEqual(JSON.parse(JSON.stringify(off)),JSON.parse(JSON.stringify(on)));
  return {SS,input,trace,i:trace.illumination_internal,result:on};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('Independent illumination Golden uses actual normalized bank70/spatial100/solar100 =>85; reliability is diagnostic',()=>{
  const r=fixture();near(r.i.bank.center_score,100);near(r.i.bank.contrast_score_normalized,0);near(r.i.bank.distance_score,100);
  near(r.i.bank_mean.numerator,70);near(r.i.bank_mean.denominator,1);near(r.i.bank.value,70);near(r.i.spatial.value,100);near(r.i.formula.value,85);
  assert.ok(r.i.spatial.distance_reliability<1);assert.equal(r.i.spatial.data_factor,1);near(r.trace.contributions.illumination,r.trace.dynamic_weights.illumination*85);
  assert.equal(r.i.spatial.reliability_role,'DIAGNOSTIC_ONLY_NOT_MULTIPLIED');
});
test('Half-open distance bands have no duplicates at50/100/200 and keep available nodes with effective zero score',()=>{
  const nodes=[0,49.99,50,99.99,100,199.99,200,300].map((d,i)=>({d,o:i%2?30:0,high:100,mid:100}));
  const r=fixture({nodes,mutate:SS=>{SS.config.highCloudWidth=.01;SS.config.midCloudWidth=.01;SS.config.spatialField.forecastConfidence.far=0;}});
  assert.deepEqual(Array.from(r.i.bands,b=>b.node_indices.length),[2,2,2,2]);assert.equal(new Set(r.i.bands.flatMap(b=>b.node_indices)).size,8);
  assert.ok(r.i.bands.every(b=>b.available_count===2&&b.mean===0));assert.equal(r.i.bands.find(b=>b.band==='far').effective_confidence,1);
  assert.equal(r.i.formula.value,0);assert.equal(r.i.spatial.data_factor,1);assert.equal(r.i.spatial.fallback,null);
});
test('Missing bands and partial bank support use actual denominators; complete cloud absence falls back to canvas and legacy far OR',()=>{
  const partial=fixture({nodes:[{d:0,o:0,missing:true},{d:50,o:30}]});
  assert.equal(partial.i.bank.center_score,null);assert.equal(partial.i.bank.contrast_score_normalized,null);near(partial.i.bank_mean.denominator,.2);
  near(partial.i.bank.value,100);near(partial.i.spatial.denominator,.25*.9);near(partial.i.formula.value,100);
  const missing=fixture({nodes:[{d:0,o:0,missing:true},{d:50,o:30,missing:true}],mutate:SS=>{SS.config.spatialField.forecastConfidence.far=0;}});
  assert.equal(missing.i.spatial.denominator,0);assert.equal(missing.i.bank_mean.denominator,0);near(missing.i.spatial.canvas,10);
  near(missing.i.spatial.data_factor,.75);near(missing.i.formula.value,7.5);assert.ok(missing.i.spatial.fallback);assert.ok(missing.i.bank.fallback);
  assert.equal(missing.i.spatial.distance_reliability,null);assert.equal(missing.i.bank.contrast_raw,null);
});
test('Contrast negative, zero and capped are real observations; positive bonus scaling cancels after normalization',()=>{
  const negative=fixture({nodes:[{d:0,o:0,high:20,mid:20},{d:50,o:30,high:80,mid:80}]});assert.equal(negative.i.bank.contrast_raw,-120);assert.equal(negative.i.bank.contrast_score_normalized,0);
  assert.equal(fixture().i.bank.contrast_raw,0);
  const opts={nodes:[{d:0,o:0,high:80,mid:80},{d:50,o:30,high:20,mid:20}]};
  const cap=fixture(opts),scaled=fixture({...opts,mutate:SS=>{SS.config.spatialField.cloudBank.contrastBonusMax=40;}});
  assert.equal(cap.i.bank.contrast_raw,120);assert.equal(cap.i.bank.contrast_bonus,20);assert.equal(cap.i.bank.contrast_score_normalized,100);
  assert.equal(scaled.i.bank.contrast_bonus,40);near(cap.i.bank.value,scaled.i.bank.value);near(cap.i.formula.value,scaled.i.formula.value);
});
test('Missing source layers remain auditable beside the actual legacy interpolation zero result',()=>{
  const r=fixture({nodes:[{d:0,o:0,missing:true},{d:50,o:30,missing:true}],mutate:(SS,samples)=>{for(const s of samples)delete s.forecast.engineNullClouds;}});
  assert.ok(r.i.nodes[0].source_cloud_series.high.every(v=>v===null));assert.equal(r.i.nodes[0].sunset_values.high,0);
  assert.equal(r.i.spatial.fallback,null);assert.equal(r.i.spatial.data_factor,1);assert.ok(r.i.nodes[0].interpolation_contract.includes('DEFAULT_IS_ZERO'));
});
test('Solar saturation boundaries, bankShare endpoints and old missing fields preserve defaults and isolate other components',()=>{
  for(const [twilight,solar] of [[-1,30],[0,30],[17.5,65],[35,100],[70,100]])near(fixture({twilight}).i.solar.score,solar);
  const baseline=fixture(),spatial=fixture({model:{bankShare:0}}),bank=fixture({model:{bankShare:1}}),slow=fixture({twilight:30,model:{twilightSaturationMinutes:90}});
  near(spatial.i.formula.value,100);near(bank.i.formula.value,70);near(slow.i.solar.score,30+70/3);
  for(const r of [spatial,bank,slow])for(const k of ['skyCanvas','horizon','atmosphere','weather'])near(r.trace.components[k],baseline.trace.components[k]);
  const old=fixture({mutate:SS=>{delete SS.config.illuminationModel;}});assert.deepEqual(JSON.parse(JSON.stringify(old.result)),JSON.parse(JSON.stringify(baseline.result)));near(old.i.solar.saturation_minutes,35);near(old.i.formula.bank_share,.5);
});
test('Real trace reconstruction rejects internal tampering and exact coupling excludes illumination/P but protects other components',async()=>{
  const m=await api(),r=fixture(),core={...r.trace,predicted_score:r.result.score,sky_branch:{branch_id:'STABLE',state:'STABLE',fusion:{applied_factor:1,F_gw:1}},stages:[]};
  assert.equal(m.verifyIlluminationTrace(core).status,'PASS');const bad=structuredClone(core);bad.illumination_internal.spatial.denominator+=.1;
  assert.throws(()=>m.verifyIlluminationTrace(bad),/RECONSTRUCTION/);
  const light=m.illuminationLight(core);assert.equal(m.assertIlluminationCoupling([light],[{...light,illumination:90,P:99,final_score:99}]).status,'PASS');
  assert.throws(()=>m.assertIlluminationCoupling([light],[{...light,protected_sha256:'Q-or-bank-changed'}]),/NON_TARGET_COMPONENT_CHANGED/);
});
test('Illumination plan admits every supported entry, handles saturated/no-response and summary separates missing from valid zero contrast',async()=>{
  const m=await api(),r=fixture({twilight:30}),make=(id,gt,illum)=>({snapshot_id:id,event_id:id,event_date_local:'d',gt_ordinal:gt,gt_confidence:.6,predicted_ordinal:1,predicted_score:30,
    regime_label:'CLEAR',lead_time_bucket:'BEFORE',illumination_internal:illum}),ts=[make('h',3,r.i),make('l',0,r.i)],rows=ts.map(t=>({...t,event_normalized_weight:.6}));
  const summary=m.summarizeIllumination(rows,ts),plan=m.buildIlluminationPlan(rows,ts,summary,{skyState:{},goldenWindow:{floor:.507692307692}});
  assert.equal(plan.selected.length,2);assert.equal(summary.groups.find(g=>g.group==='high_missed').contrast_nonpositive_valid.snapshot_count,1);
  assert.equal(summary.groups.find(g=>g.group==='high_missed').contrast_missing.snapshot_count,0);near(summary.separation.bank_score.weighted_pair_concordance,.5);
  const same=structuredClone(ts);for(const t of same){t.illumination_internal.bank.value=100;t.illumination_internal.formula.cloud_bank_potential=100;t.illumination_internal.formula.value=100;t.illumination_internal.solar.twilight_minutes=100;t.illumination_internal.solar.score=100;}
  assert.equal(m.buildIlluminationPlan(rows,same,m.summarizeIllumination(rows,same),{}).diagnostic_status,'NO_ACTIONABLE_PARAMETER');
});
test('Finite illumination search has nine coarse configs and eight interiors for only one parameter, resumes, isolates errors and stops without gain',async()=>{
  const m=await api(),current={},original={},plan={selected:m.ILLUMINATION_PARAMETERS.map(p=>({...p,probe_values:p.probes}))},metrics={product_loss:1,critical_overprediction:{rate:0},target_ge2:{recall:.8},target_ge3:{recall:.2},mae:1};
  const evaluate=async c=>({metrics:{...metrics,product_loss:c.parameters.parameter_id==='illumination_bank_share'?.9:1},paired_migrations:{net_recovered_weight:0},predictions_sha256:c.candidate_id});
  const opt={current,original,engine_sha256:'e',plan,originalMetrics:metrics,evaluate};const result=await m.searchIllumination(opt);
  assert.equal(result.records.length,17);assert.equal(result.refinement.parameter_id,'illumination_bank_share');assert.equal(result.refinement.values.length,8);
  assert.equal(new Set(result.records.map(c=>c.candidate_id)).size,17);assert.deepEqual((await m.searchIllumination({...opt,restored:result.records,frozenRefinement:result.refinement,evaluate:()=>{throw Error('REPLAY_MUST_NOT_REPEAT');}})).records,result.records);
  assert.equal((await m.searchIllumination({...opt,evaluate:async()=>({metrics,paired_migrations:{net_recovered_weight:0},predictions_sha256:'same'})})).records.length,9);
  const failed=await m.searchIllumination({...opt,evaluate:async c=>{if(c.parameters.parameter_id==='illumination_bank_share')throw Error('POINT_FAILED');return {metrics,paired_migrations:{net_recovered_weight:0}};}});assert.equal(failed.budget.errors,4);assert.equal(failed.records.length,9);
  assert.throws(()=>m.installIllumination({}, {parameter_id:'illumination_bank_share',value:1.1}));assert.equal(m.installIllumination({}, {parameter_id:'illumination_bank_share',value:0}).illuminationModel.bankShare,0);
  const complete=m.highCloudMetrics([{snapshot_id:'h',event_id:'h',event_date_local:'d',gt_ordinal:3,gt_confidence:.6}],[60]);complete.product_loss=1;
  const b={candidate_id:'C',status:'EVALUATED',parameter_distance:0,metrics:complete,predictions_sha256:'same'},w={...b,candidate_id:'W',metrics:{...complete,product_loss:1.1}};
  assert.equal(m.selectIllumination([b,w],'C',complete).selection_status,'KEEP_CONTROL');assert.equal(m.selectIllumination([b,{...w,metrics:{...complete,product_loss:.9}}],'C',complete).high_grade_recognition_improved,false);
});
test('V6 actual disk workflow exports exact C/N traces and old versions remain readable; tampering and resume are checked',{timeout:300000},async t=>{
  const m=await api(),root=await fs.mkdtemp(path.join(os.tmpdir(),'illum-p14-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const fixture=await require('./evaluation-fixture.cjs').createSyntheticPipeline(root,{replayTransform:r=>{for(const n of r.nwp.nodes)n.variables.cloud_cover=n.variables.cloud_cover.map(()=>50);return r;}});t.after(fixture.close);
  // Historical workflow prerequisites are frozen at the original 2.4.6 base.
  await require('./helpers.cjs').pinLegacyTuningBase(t);
  const sources={raw:fixture.rawDir,gt:fixture.gtDir,model:fixture.modelDir},output=path.join(root,'runs');
  let parent=await m.practicalRun({...sources,output,recognitionFirst:true,maxCandidates:1});
  for(const searchSpace of ['high-cloud','mid-cloud','mechanism-targeted','sky-branch'])parent=await m.practicalRun({...sources,output,searchSpace,baselineRun:parent.directory,maxCandidates:1});
  const opts={...sources,output,searchSpace:'illumination-targeted',baselineRun:parent.directory,maxCandidates:2},run=await m.practicalRun(opts);
  const req=JSON.parse(await fs.readFile(path.join(run.directory,'verification_request.json')));assert.equal(run.phase7_completed,true);assert.equal(req.selected_illumination_traces.length,req.pool.included.length);
  assert.equal((await m.inspectPractical(run.directory)).manifest.practical_tuning_schema_version,6);assert.equal((await m.verifyPractical(run.directory)).selected_branch_trace_and_coupling_equal,true);
  assert.equal((await m.verifyPractical(parent.directory)).status,'PASS');
  const bad=structuredClone(req);bad.selected_illumination_traces[0].illumination_internal.formula.value+=.1;
  await assert.rejects(m.verifyIlluminationRequest(bad),/ILLUMINATION_SELECTED_TRACE_RECOMPUTE_MISMATCH/);
  const work=path.join(output,'.work',`practical_preparation_v6_${req.spec.identity.base_identity_sha256.slice(0,20)}`);await fs.rename(run.directory,work);await fs.rm(path.join(work,'manifest.json'));
  assert.equal((await m.practicalRun({...opts,resume:true})).run_id,run.run_id);assert.equal((await m.practicalRun(opts)).deduplicated,true);
});
test('Production capture and Replay share both illumination parameters, preserve zero, and invalidate the runtime cache key',async()=>{
  const m=await api(),files=['js/config.js','js/model_config.js','js/network.js','js/domain.js','js/time.js','js/vendor/suncalc.js','js/solar.js','js/baseline.js','js/cache.js','js/data.js','js/city_search.js',
    'js/cloud_field.js','js/wind.js','js/cloud_motion.js','js/sky_state.js','js/engine.js','js/sampling.js','js/corridor.js','js/nowcast.js','js/evolution.js','js/replay_service.js','js/prediction_service.js'];
  const SS=load(createRuntime(),files),key=SS.modelConfigKey();SS.config.illuminationModel.bankShare=0;SS.config.illuminationModel.twilightSaturationMinutes=25;
  assert.notEqual(SS.modelConfigKey(),key);const fc=forecast({cloud:60,low:10,mid:40,high:60});fc.timezone='Asia/Shanghai';fc.utc_offset_seconds=28800;
  SS.data.fetchForecastWithRetry=async()=>fc;SS.data.fetchAirQuality=async()=>null;SS.data.gather=async nodes=>({samples:nodes.map(point=>({point,forecast:fc})),successCount:nodes.length});
  const result=await SS.prediction.predict('31.23,121.47',{nowUtcMs:Date.parse('2026-08-26T02:00:00Z'),captureReplay:true});
  const replay=await m.runReplay(result.replay_payload,{trace:true,illuminationTrace:true,skyBranchTrace:true});
  assert.equal(replay.actual.components.illumination,result.components.illumination);assert.equal(replay.actual.score,result.score);
  assert.equal(replay.trace.illumination_internal.formula.bank_share,0);assert.equal(replay.trace.illumination_internal.solar.saturation_minutes,25);
});
