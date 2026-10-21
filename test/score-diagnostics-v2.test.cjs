const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
let modules;
async function api(){return modules||=Promise.all(['score-diagnostics/policy','score-diagnostics/v2/common','score-diagnostics/v2/boundaries',
  'score-diagnostics/v2/mapping','score-diagnostics/v2/lead-time','score-diagnostics/v2/temporal','score-diagnostics/v2/decision',
  'score-diagnostics/v2/workflow','score-diagnostics/v2/sources','score-diagnostics/v2/package','score-diagnostics/cli',
  'score-diagnostics/statistics','score-diagnostics/package','experiment-runtime/lib/package','maintenance/maintenance-policy',
  'optimization-diagnostics/engine'].map(n=>import(`../tools/${n}.mjs`))).then(ms=>Object.assign({},...ms));}
function basicRow(id,ordinal,score,date='2026-09-01',confidence=1){return {snapshot_id:id,event_id:`e_${id}`,event_date_local:date,
  location_key:`l_${id}`,gt_ordinal:ordinal,gt_confidence:confidence,score,control_ordinal:score<20?0:score<40?1:score<60?2:score<90?3:4,
  lead_time_minutes:15,lead_time_bucket:'T_0_30M',prediction_time_utc:`${date}T10:15:00.000Z`,prediction_time_epoch:Date.parse(`${date}T10:15:00.000Z`),
  sunset_time_utc:`${date}T10:30:00.000Z`,timezone:'Asia/Shanghai',latitude:31,longitude:121,gt_basis:'ADMIN_ADJUDICATED',gt_status:'STRONG',
  error_direction:'EXACT',regime_label:'CLEAR',in_oof:true};}
function replayFor(row){const sunset=Date.parse(row.sunset_time_utc);return {replay_schema_version:1,
  identity:{snapshot_id:row.snapshot_id,event_id:row.event_id,prediction_time_utc:row.prediction_time_utc},
  context:{sunset_time_utc:row.sunset_time_utc,latitude:row.latitude,longitude:row.longitude,timezone:row.timezone,utc_offset_seconds:28800},
  nwp:{nodes:[{key:'CENTER_0',time_utc:Array.from({length:6},(_,i)=>new Date(sunset+(i-3)*3600000).toISOString()),
    variables:{cloud_cover:[10,20,30,40,50,60],cloud_cover_low:[0,0,0,0,0,0]}}]},air_quality:{available:false},
  minute_precip:{available:false},radar:{available:false},satellite:{available:false},cloud_motion:{base_time_utc:row.prediction_time_utc},
  engine_inputs:{source_degradation_flags:{radar:'NOT_REQUESTED',satellite:'NOT_REQUESTED'}}};}
async function fixture(){
  const m=await api(),rows=[];
  for(let date=1;date<=20;date++)for(let grade=0;grade<5;grade++)for(let event=0;event<2;event++)for(const [lead,bucket]of[[120,'T_1_3H'],[15,'T_0_30M']]){
    const day=`2026-09-${String(date).padStart(2,'0')}`,r=basicRow(`s_${date}_${grade}_${event}_${lead}`,grade,30+grade*14-(lead===15?2:0),day);
    r.event_id=`event_${date}_${grade}_${event}`;r.location_key=`location_${grade}_${event}`;
    r.lead_time_minutes=lead;r.lead_time_bucket=bucket;r.prediction_time_epoch=Date.parse(r.sunset_time_utc)-lead*60000;r.prediction_time_utc=new Date(r.prediction_time_epoch).toISOString();rows.push(r);
  }
  rows.sort((a,b)=>a.snapshot_id<b.snapshot_id?-1:1);
  const assignments=m.dateFolds(rows),heldIds=new Set(assignments.folds.flatMap(f=>f.held_members.map(r=>r.snapshot_id)));
  rows.forEach(r=>{r.in_oof=heldIds.has(r.snapshot_id);});
  const calibrators=assignments.folds.map(f=>{
    const mapping={status:'FITTED',nodes:[{score:0,fitted:0,weight:1},{score:100,fitted:f.fold===1?1.4:2,weight:1}],
      sample_count:f.train_members.length,event_count:f.train_members.length/2,date_count:f.train_dates.length};
    return {fold:f.fold,...mapping,train_members:f.train_members,no_skill_ordinal:1,mapping_sha256:m.digest(mapping),frozen_before_holdout:true};});
  const oof=rows.filter(r=>r.in_oof).map(r=>{const fold=assignments.folds.find(f=>f.held_members.some(v=>v.snapshot_id===r.snapshot_id)).fold;
    const mapping=calibrators.find(f=>f.fold===fold),value=m.predictPava(mapping,r.score);
    return {...r,fold,mapping_sha256:mapping.mapping_sha256,calibrated_estimate:value.ordinal_estimate,calibrated_ordinal:value.ordinal,no_skill_ordinal:1};});
  const config={goldenWindow:{enabled:true,beforeSunsetMinutes:90,afterSunsetMinutes:15},nowcast:{analysisHorizonMinutes:120}};
  const contract=m.temporalContract({'tools/replay/replay-runner.mjs':'a'.repeat(64)},['event_id','submitted_at_utc'],config);
  const temporal=[],alignment=[],reads=[];
  for(const r of rows){const trace={final_score:r.score,golden_window_active:r.lead_time_minutes<=90};
    const evidence=m.auditTemporalSnapshot(r,replayFor(r),trace,contract);temporal.push(...evidence.judgments);alignment.push(...evidence.alignment);
    reads.push({snapshot_id:r.snapshot_id,event_id:r.event_id,replay_path:`replay/${r.snapshot_id}.json`,replay_sha256:evidence.replay_sha256,
      projected_fields_sha256:m.digest(evidence),split:'TRAIN'});}
  const parent={manifest:{score_diagnostic_id:'fixture_v46_result'},files:{'fold_calibrators.json':calibrators,'fold_assignments.json':assignments,
    'oof_predictions.json':oof,'stage_summary.json':{OOF:{module_hypotheses:[]}},
    'discrimination.json':{OOF:{ordered_consistency:m.pairStatistic(m.weights(oof),'score',true)}}}};
  const parentPlan={manifest:{score_diagnostic_plan_id:'fixture_v46_plan'},files:{'plan.json':{control_config_sha256:m.digest(config),control_config:config}}};
  const artifact=(id,sha)=>({id,manifest_sha256:sha.repeat(64)});
  const parentBinding={status:'PASS',parent_internal:'PASS',prior_recompute_receipt:{status:'VERIFIED',scope:'PARENT_V1_PREPUBLICATION_FULL_PAYLOAD_RECOMPUTE'},this_version_engine_replayed:false,this_version_pava_refitted:false};
  const sourceManifest={score_sources_schema_version:2,source_ids:{raw:artifact('raw','0')},
    artifacts:{diagnosticPlan:artifact('v45_plan','1'),diagnosticResult:artifact('v45_result','2'),
      parentPlan:{id:parentPlan.manifest.score_diagnostic_plan_id,manifest_sha256:m.digest(parentPlan.manifest)},
      parentResult:{id:parent.manifest.score_diagnostic_id,manifest_sha256:m.digest(parent.manifest)}},
    runtimes:{sourceRuntime:artifact('old_runtime','3'),parentRuntime:artifact('parent_runtime','4'),runtimeBundle:artifact('new_runtime','5')},
    parent_control_config_sha256:m.digest(config),parent_mappings_sha256:m.digest(calibrators),parent_binding_sha256:m.digest(parentBinding),
    history_registry_sha256:'6'.repeat(64),history_prefixes:[]};
  const accessScope={computation_split:'TRAIN',integrity_phase:'COMPLETE_SOURCE_BYTES_HASHED_NOT_EFFECT_EVALUATED',model_statistics_allowlist:m.MODEL_STATISTICAL_ALLOWLIST,
    replay_field_allowlist:contract.projection_allowlist,train_replay_reads:reads,mixed_sample_effect_files_read:[],parent_effect_scope:'V1_TRAIN_ONLY_PAYLOADS',engine_replay_count:0,pava_fit_count:0,parameter_search_count:0};
  return {m,rows,parent,parentPlan,sourceManifest,parentBinding,contract,temporal,alignment,accessScope};
}
test('V2 is explicit, V1 remains default and unknown/mixed versions are rejected',async()=>{
  const m=await api();assert.equal(m.scorePolicy().score_diagnostic_policy_version,1);assert.equal(m.scoreSchema().score_diagnostic_schema_version,1);
  assert.equal(m.scorePolicy(2).calibration_fits,0);assert.equal(m.scorePolicy(2).engine_replay_allowed,false);assert.equal(m.scorePolicy(2).parameter_search,0);
  assert.throws(()=>m.scorePolicy(3));assert.throws(()=>m.scoreSchema(3));
  assert.equal(m.isSupportedVersion(m.phaseByKey('score_diagnostic'),2,2),true);
  assert.equal(m.isSupportedVersion(m.phaseByKey('score_diagnostic'),2,1),false);
  assert.equal(m.isSupportedVersion(m.phaseByKey('score_diagnostic'),3,3),false);
  const parsed=m.parseScoreArgs(['plan','--diagnostic-version','2','--parent','parent','--sources','sources']);assert.equal(parsed.options.diagnosticVersion,2);
  assert.throws(()=>m.parseScoreArgs(['plan','--diagnostic-version','2','--sources','x']));
  assert.throws(()=>m.parseScoreArgs(['plan','--diagnostic-version','3','--sources','x']));
  assert.throws(()=>m.parseScoreArgs(['run','--plan','x','--sources','x','--diagnostic-version','2']));
});
test('independent weighted AUC Golden keeps ties, higher GT direction and cross-Event exclusion',async()=>{
  const m=await api(),rs=[basicRow('a',0,40,'2026-09-01',.5),basicRow('b',1,40),basicRow('c',1,60)];
  rs[2].event_id=rs[1].event_id;
  const sums=m.pairSums(rs,r=>r.gt_ordinal===1,r=>r.gt_ordinal===0);
  assert.equal(sums.denominator_weight,.5);assert.equal(sums.correct_weight,.25);assert.equal(sums.tied_weight,.25);assert.equal(sums.auc,.75);
  const inverse=m.pairSums([basicRow('x',0,100),basicRow('y',1,0)],r=>r.gt_ordinal===1,r=>r.gt_ordinal===0);assert.equal(inverse.auc,0);
  const same=[basicRow('x',0,0),basicRow('y',1,100)];same[1].event_id=same[0].event_id;
  assert.equal(m.pairSums(same,r=>r.gt_ordinal===1,r=>r.gt_ordinal===0).auc,null);
});
test('boundary support/CI thresholds do not convert null or uncertain intervals into no-signal claims',async()=>{
  const m=await api(),s={event_count:10,date_count:3};
  assert.equal(m.classifyBoundary({low:s,high:s,auc:.6,interval:{status:'COMPUTED',ci_lower:.51,ci_upper:.8}}),'SIGNAL_SUPPORTED');
  assert.equal(m.classifyBoundary({low:s,high:s,auc:.9,interval:{status:'COMPUTED',ci_lower:.5,ci_upper:1}}),'UNRESOLVED');
  assert.equal(m.classifyBoundary({low:s,high:s,auc:.3,interval:{status:'COMPUTED',ci_lower:.2,ci_upper:.49}}),'INVERSE_SIGNAL');
  assert.equal(m.classifyBoundary({low:{event_count:9,date_count:3},high:s,auc:1,interval:{status:'COMPUTED',ci_lower:1}}),'INSUFFICIENT_SUPPORT');
  const boundary=m.boundaryMetric([basicRow('a',0,50)],{id:'missing',cohort:'OOF',planCore:'a'.repeat(64),isHigh:r=>r.gt_ordinal===4,isLow:r=>r.gt_ordinal===0});
  assert.equal(boundary.auc,null);assert.equal(boundary.reason_code,'NO_POSITIVE_OR_NEGATIVE_PAIRS');
});
test('Bootstrap duplicate dates retain squared pair multiplicities, invalid draws are counted, seeds are identity-bound',async()=>{
  const m=await api(),rs=[basicRow('h',2,100,'2026-09-01'),basicRow('l1',0,0,'2026-09-01'),basicRow('l2',0,100,'2026-09-02')];
  const sums=m.pairSums(rs,r=>r.gt_ordinal>=2,r=>r.gt_ordinal<2);
  const value=m.pairInterval(sums,1,Array.from({length:2000},()=>[0,0]));assert.equal(value.ci_lower,1);
  const bad=m.pairInterval(sums,1,Array.from({length:2000},()=>[1,1]));assert.equal(bad.status,'NOT_ESTIMABLE');assert.equal(bad.undefined_replicates,2000);
  assert.notEqual(m.statisticSeed('a'.repeat(64),'m','slice1'),m.statisticSeed('a'.repeat(64),'m','slice2'));
  assert.notEqual(m.statisticSeed('a'.repeat(64),'m','slice1'),m.statisticSeed('a'.repeat(64),'n','slice1'));
});
test('ten grade-pair contributions independently reconstruct the original ordered consistency',async()=>{
  const m=await api(),rs=[basicRow('a',0,10,'2026-09-01',.8),basicRow('b',1,20,'2026-09-02',.6),basicRow('c',2,20,'2026-09-03',1),basicRow('d',3,5,'2026-09-04',.8)];
  const result=m.analyzeBoundaries(rs,'OOF','a'.repeat(64));assert.equal(result.boundaries.adjacent.length,4);assert.equal(result.boundaries.cumulative.length,4);
  assert.equal(result.contributions.pairs.length,10);assert.equal(result.contributions.reconstruction_pass,true);
  const independently=m.pairStatistic(m.weights(rs),'score',true).value;
  assert.ok(Math.abs(result.contributions.reconstructed_ordered_consistency-independently)<1e-10);
  assert.equal(result.contributions.pairs.filter(r=>r.high_ordinal===4).every(r=>r.auc===null),true);
});
test('frozen mapping audit distinguishes zero high-grade recall from no high-grade predictions',async()=>{
  const m=await api(),mapping={fold:1,status:'FITTED',nodes:[{score:0,fitted:0},{score:100,fitted:2}],mapping_sha256:'frozen'};
  const train=[basicRow('train1',0,0),basicRow('train2',2,100)],held=[basicRow('hi',2,10),basicRow('low',0,100)];
  const assignments={folds:[{fold:1,train_members:m.memberRows(train),held_members:m.memberRows(held),train_dates:['2026-09-01'],held_dates:['2026-09-01']}]};
  const oof=held.map(r=>{const p=m.predictPava(mapping,r.score);return {...r,fold:1,mapping_sha256:'frozen',calibrated_estimate:p.ordinal_estimate,calibrated_ordinal:p.ordinal};});
  const a=m.auditFrozenMappings([...train,...held],[mapping],assignments,oof);
  assert.equal(a.reapplication.status,'PASS');assert.equal(a.audits[0].high_grade_counts.recall,0);
  assert.equal(a.audits[0].high_grade_counts.predicted_high_snapshot_count,1);assert.equal(a.audits[0].high_grade_counts.snapshot_counts.fp,1);
  assert.ok(a.audits[0].labels.includes('HOLDOUT_SCORE_PLACEMENT'));assert.equal(m.crossing(mapping,1.5).score,75);
  assert.equal(m.crossing({...mapping,nodes:[{score:0,fitted:0},{score:100,fitted:1.4}]},1.5).status,'NOT_REACHABLE');
  const corrupted=oof.map((r,i)=>i?r:{...r,calibrated_ordinal:4});assert.equal(m.auditFrozenMappings([...train,...held],[mapping],assignments,corrupted).reapplication.status,'BLOCKED');
});
test('plateau, endpoint fallback and held GT changes preserve mapping identity and application',async()=>{
  const m=await api(),mapping={fold:1,status:'FITTED',nodes:[{score:20,fitted:1},{score:40,fitted:1},{score:60,fitted:2}],mapping_sha256:'same'};
  const training=[basicRow('train',0,20)],held=[basicRow('h1',2,10),basicRow('h2',0,100)];
  const f={fold:1,train_members:m.memberRows(training),held_members:m.memberRows(held),train_dates:['2026-09-01'],held_dates:['2026-09-01']};
  const originals=held.map(r=>{const p=m.predictPava(mapping,r.score);return {...r,fold:1,mapping_sha256:'same',calibrated_estimate:p.ordinal_estimate,calibrated_ordinal:p.ordinal};});
  const a=m.auditFrozenMappings([...training,...held],[mapping],{folds:[f]},originals),before=m.digest(mapping);
  assert.ok(a.audits[0].labels.includes('ENDPOINT_DEPENDENCE'));assert.ok(a.audits[0].labels.includes('PLATEAU_COMPRESSION'));assert.equal(a.audits[0].endpoint.sample_count,2);
  const b=m.auditFrozenMappings([...training,...held.map(r=>({...r,gt_ordinal:4}))],[mapping],{folds:[f]},originals);
  assert.equal(m.digest(mapping),before);assert.equal(b.reapplication.status,'PASS');assert.deepEqual(a.reapplication,b.reapplication);
});
test('paired Event selection is per bucket nearest legal time, deterministic ties, each Event confidence once',async()=>{
  const m=await api(),near=basicRow('near',1,30),early={...near,snapshot_id:'early',lead_time_minutes:120,lead_time_bucket:'T_1_3H',prediction_time_utc:'2026-09-01T08:30:00.000Z',prediction_time_epoch:Date.parse('2026-09-01T08:30:00.000Z')};
  const tie={...early,snapshot_id:'a_early'},invalid={...near,snapshot_id:'zero',lead_time_minutes:0,prediction_time_utc:near.sunset_time_utc,prediction_time_epoch:Date.parse(near.sunset_time_utc)};
  const other={...near,snapshot_id:'other',event_id:'unmatched'};
  const a=m.pairedEvents([near,early,tie,invalid,other],'T_1_3H');assert.equal(a.pairs.length,1);assert.equal(a.pairs[0].early.snapshot_id,'a_early');assert.equal(a.unmatched.length,1);
  assert.equal(m.leadValidity(invalid).reason_code,'NONPOSITIVE_MINUTES_TO_SUNSET');
  assert.equal(m.leadValidity({...near,prediction_time_epoch:0}).reason_code,'FROZEN_LEAD_TIME_OR_EPOCH_CONTRACT_CONFLICT');
});
test('future forecast validity is normal; absent acquisition time is UNKNOWN; explicit later availability can prove mismatch',async()=>{
  const m=await api(),row=basicRow('a',1,30),replay=replayFor(row),contract=m.temporalContract({},['submitted_at_utc']);
  const a=m.auditTemporalSnapshot(row,replay,{final_score:30,golden_window_active:true},contract);
  assert.ok(a.judgments.filter(r=>r.rule==='NWP_EFFECTIVE_TIME').every(r=>r.status==='PASS'));
  assert.equal(a.judgments.find(r=>r.field_path==='nwp.<explicit_source_timestamps>').status,'UNKNOWN');
  assert.equal(a.alignment.find(r=>r.field_path.includes('sunset_observations')).status,'UNKNOWN');
  replay.nwp.available_at_utc='2026-09-01T10:20:00.000Z';
  assert.equal(m.auditTemporalSnapshot(row,replay,{final_score:30},contract).judgments.find(r=>r.field_path==='nwp.<explicit_source_timestamps>').status,'PROVEN_MISMATCH');
  delete replay.nwp.available_at_utc;replay.nwp.collected_at_utc='2026-09-01T10:20:00.000Z';
  assert.equal(m.auditTemporalSnapshot(row,replay,{final_score:30},contract).judgments.find(r=>r.field_path==='nwp.<explicit_source_timestamps>').status,'UNKNOWN');
});
test('IANA target dates ignore process timezone; conflicting target/time axes and degraded sources stay distinct',async()=>{
  const m=await api();assert.equal(m.localDate(Date.parse('2026-09-01T01:00:00Z'),'America/Los_Angeles'),'2026-08-31');
  assert.equal(m.ianaOffsetSeconds(Date.parse('2026-09-01T01:00:00Z'),'America/Los_Angeles'),-25200);
  const row=basicRow('a',1,30),replay=replayFor(row),contract=m.temporalContract({},[]);
  const good=m.auditTemporalSnapshot(row,replay,{final_score:30},contract);assert.equal(good.alignment[0].status,'PASS');
  assert.equal(good.judgments.find(r=>r.rule==='PRECIP_INTERVAL_COVERAGE').status,'NOT_APPLICABLE');
  replay.nwp.nodes[0].time_utc.reverse();const bad=m.auditTemporalSnapshot({...row,event_date_local:'2026-08-31'},replay,{final_score:30},contract);
  assert.equal(bad.alignment[0].status,'PROVEN_MISMATCH');assert.equal(bad.judgments.find(r=>r.rule==='NWP_EFFECTIVE_TIME').status,'PROVEN_MISMATCH');
  assert.ok(good.judgments.find(r=>r.rule==='NWP_EFFECTIVE_TIME').nodes[0].fields.find(r=>r.field==='cloud_cover_low').selected_zero_count>0);
});
test('end-anchored minute intervals retain real coverage and never imply source availability or extension',async()=>{
  const m=await api(),row=basicRow('a',1,30),replay=replayFor(row),start=row.prediction_time_epoch,step=300000;
  replay.minute_precip={available:true,coverage_start:start,coverage_end:start+8*step,step_ms:step,interval_anchor:'interval_end',
    minute_series:{time_utc_ms:Array.from({length:8},(_,i)=>start+(i+1)*step),precipitation_mm:Array(8).fill(0)}};
  const report=m.auditTemporalSnapshot(row,replay,{final_score:30},m.temporalContract({},[])),coverage=report.judgments.find(r=>r.rule==='PRECIP_INTERVAL_COVERAGE');
  assert.equal(coverage.status,'PASS');assert.equal(coverage.prediction_covered,true);
  assert.equal(report.judgments.find(r=>r.field_path==='minute_precip.<explicit_source_timestamps>').status,'UNKNOWN');
  replay.minute_precip.coverage_end+=step;
  assert.equal(m.auditTemporalSnapshot(row,replay,{final_score:30},m.temporalContract({},[])).judgments.find(r=>r.rule==='PRECIP_INTERVAL_COVERAGE').status,'PROVEN_MISMATCH');
});
test('V2 statistical access readers reject validation, TEST and mixed sample files before reading',async()=>{
  const m=await api(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'boundary-access-')),seen=[];
  try{for(const file of ['splits/test.csv','splits/validation.csv','model_samples.csv','event_splits.csv'])await assert.rejects(()=>m.readBoundaryModelFile(dir,file,{readMonitor:r=>seen.push(r)}));
    assert.equal(seen.length,0);
    const doc={sources_schema_version:2,...Object.fromEntries(m.V2_SOURCE_KEYS.map(k=>[k,k]))};
    await fs.writeFile(path.join(dir,'sources.json'),JSON.stringify({...doc,sources_schema_version:3}));await assert.rejects(()=>m.readBoundarySources(path.join(dir,'sources.json')));
    await fs.writeFile(path.join(dir,'sources.json'),JSON.stringify({...doc,split:'TEST'}));await assert.rejects(()=>m.readBoundarySources(path.join(dir,'sources.json')));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('research routing keeps weak evidence bounded, concrete gaps and at most two future actions',async()=>{
  const m=await api(),r=basicRow('a',1,30),temporal=[{...r,rule:'SOURCE_AVAILABILITY',status:'UNKNOWN',field_path:'nwp.available_at_utc'}];
  const gaps=m.evidenceGaps({adjacent:[],cumulative:[]},temporal,[],[]),base={blocked:false,boundaries:{adjacent:[],cumulative:[]},
    mapping:{audits:[],reapplication:{status:'PASS'}},temporal,alignment:[],gaps,parentStages:{module_hypotheses:[]}};
  const a=m.researchDecision(base);assert.equal(a.decision.recommendation,'EVIDENCE_COLLECTION');assert.ok(a.decision.primary_actions.length<=2);assert.equal(a.experiments.length,0);
  assert.ok(gaps[0].collection.minimum_fields.length);assert.ok(gaps[0].collection.privacy_scope);
  assert.equal(m.researchDecision({...base,temporal:[],gaps:[]}).decision.recommendation,'UNRESOLVED');
  assert.equal(m.researchDecision({...base,temporal:[{...temporal[0],status:'PROVEN_MISMATCH'}]}).decision.recommendation,'INPUT_CONTRACT_REPAIR');
  assert.equal(m.researchDecision({...base,blocked:true}).decision.recommendation,'BLOCKED');
});
test('full V2 analysis publishes deterministically with exact parent/mapping binding; no Replay, refit or search',async()=>{
  const loaded=await fixture(),m=loaded.m,plan=m.makeBoundaryPlan(loaded),before=m.digest(loaded.parent.files['fold_calibrators.json']);
  const payloads=m.computeBoundaryDiagnostics(loaded,plan),second=m.computeBoundaryDiagnostics(loaded,plan);
  assert.deepEqual(second,payloads);assert.equal(m.digest(loaded.parent.files['fold_calibrators.json']),before);
  assert.equal(payloads['decision.json'].recommendation,'CALIBRATION_HYPOTHESIS');assert.equal(payloads['next_experiments.json'].length,1);
  assert.ok(payloads['ordinal_pair_contributions.json'].OOF.reconstruction_pass);assert.equal(payloads['fold_mapping_audit.json'].reapplication.status,'PASS');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'boundary-workflow-'));
  try{
    const planPackage=await m.publishGovernancePackage({output:path.join(dir,'plans'),kind:'score_diagnostic_plan',idField:'score_diagnostic_plan_id',links:m.boundaryLinks(loaded.sourceManifest),
      payloads:{'schema.json':m.scoreSchema(2),'policy.json':m.scorePolicy(2),'plan.json':plan,'source_manifest.json':loaded.sourceManifest},validateStaging:m.inspectScoreDiagnostic});
    const planManifest=(await m.inspectScoreDiagnostic(planPackage.directory)).manifest;
    const links={...m.boundaryLinks(loaded.sourceManifest),score_diagnostic_plan_id:planPackage.score_diagnostic_plan_id,score_diagnostic_plan_manifest_sha256:m.digest(planManifest)};
    const result=await m.publishGovernancePackage({output:dir,kind:'score_diagnostic',idField:'score_diagnostic_id',links,payloads,validateStaging:m.inspectScoreDiagnostic});
    assert.equal((await m.inspectScoreDiagnostic(result.directory)).status,'PASS');
    assert.equal((await m.publishGovernancePackage({output:dir,kind:'score_diagnostic',idField:'score_diagnostic_id',links,payloads,validateStaging:m.inspectScoreDiagnostic})).status,'DEDUPLICATED');
    const dependencies=m.dependenciesOf(m.phaseByKey('score_diagnostic'),(await m.inspectScoreDiagnostic(result.directory)).manifest);
    assert.ok(dependencies.some(d=>d.id==='fixture_v46_result'));assert.ok(dependencies.some(d=>d.id==='parent_runtime'));assert.ok(dependencies.some(d=>d.id==='new_runtime'));
    assert.throws(()=>m.checkRecomputedPayload(payloads,{payload_sha256:'bad',scope:'V2_BOUNDARY_MAPPING_TEMPORAL_STATISTICS_ONLY'}));
    assert.throws(()=>m.checkRecomputedPayload(payloads,{payload_sha256:m.digest(payloads),scope:'V1_FULL_ENGINE_REPLAY'}));
    m.checkRecomputedPayload(payloads,{payload_sha256:m.digest(payloads),scope:'V2_BOUNDARY_MAPPING_TEMPORAL_STATISTICS_ONLY'});
    await fs.appendFile(path.join(result.directory,'fold_mapping_audit.json'),' ');await assert.rejects(()=>m.inspectScoreDiagnostic(result.directory));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
  const changed={...loaded,sourceManifest:{...loaded.sourceManifest,parent_mappings_sha256:'changed'}};
  assert.throws(()=>m.computeBoundaryDiagnostics(changed,plan));
  for(const file of await fs.readdir(path.resolve(__dirname,'../tools/score-diagnostics/v2')))if(file.endsWith('.mjs')){
    const code=await fs.readFile(path.resolve(__dirname,'../tools/score-diagnostics/v2',file),'utf8');
    assert.equal(/\b(?:fitPava|runReplay|runBeamSearch|searchCohort)\s*\(/.test(code),false,file+' must not invoke fitting, Replay or search');
  }
});
test('source mutation is refused by final source checks before publication',async()=>{
  const m=await api(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'boundary-source-'));
  try {await fs.writeFile(path.join(dir,'manifest.json'),'{}');const {fingerprintSourcePackage}=await import('../tools/optimization/lib/input.mjs');
    const frozen={source_ids:{raw:{package_fingerprint_sha256:m.digest(await fingerprintSourcePackage(dir))}}};
    await fs.writeFile(path.join(dir,'manifest.json'),'{"changed":true}');
    await assert.rejects(()=>m.checkBoundarySources({paths:{raw:dir}},frozen),e=>e.code==='BOUNDARY_SOURCE_CHANGED');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
