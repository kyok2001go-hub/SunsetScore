const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createRuntime,load,CORE_FILES,forecast}=require('./helpers.cjs');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
const serviceFiles=[...CORE_FILES,'js/vendor/suncalc.js','js/solar.js','js/cache.js','js/city_search.js',
  'js/sampling.js','js/corridor.js','js/nowcast.js','js/replay_service.js','js/prediction_service.js',
  'js/event_service.js','js/snapshot_service.js','js/feedback_service.js'];

test('release loads real production aliases, admits only nine declared metadata/default/sky-off/V2.5.5.2 diffs, hashes real Replay config',async()=>{
  const m=await import('../tools/model-release/release.mjs'),p=await m.loadProduction();
  const source=JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/model-2550-selected-config.json'),'utf8'));
  assert.equal(p.version.app,'2.5.5.2');assert.equal(p.version.model,'2.5.5.2');assert.equal(p.version.assetRevision,'app2552');
  assert.equal(p.model.scoring,p.SS.config);assert.equal(p.model.goldenWindow,p.model.scoring.goldenWindow);
  assert.equal(m.compareSelected(source,p.scoring).length,9);
  assert.equal(p.scoring.evolution.openCoverageThreshold,35);assert.equal(p.scoring.evolution.satelliteOpenThreshold,40);assert.equal(p.scoring.goldenWindow.reference,.826654);
  assert.deepEqual(JSON.parse(JSON.stringify(p.scoring.levels)).map(l=>l.min),[90,66,47,22,0]);
  for(const [key,value] of [['evolution.openCoverageThreshold',20],['goldenWindow.reference',undefined],['levels',JSON.parse(JSON.stringify(m.LEGACY_LEVELS))]]){
    const back=structuredClone(p.scoring),parts=key.split('.');const parent=parts.length===2?back[parts[0]]:back;if(value===undefined)delete parent[parts.at(-1)];else parent[parts.at(-1)]=value;
    assert.throws(()=>m.compareSelected(source,back),/UNEXPECTED_RELEASE|RELEASE_PARAMETER/,key);
  }
  const previous=m.previousReleaseScoring(p.scoring);assert.equal(previous.evolution.openCoverageThreshold,20);assert.equal('reference' in previous.goldenWindow,false);assert.deepEqual(JSON.parse(JSON.stringify(previous.levels.map(l=>l.min))),[90,60,40,20,0]);
  assert.deepEqual(JSON.parse(JSON.stringify(p.scoring.skyState.factorRange)),[1,1]);
  const skyBack=structuredClone(p.scoring);skyBack.skyState.factorRange=[0.65,1.15];assert.throws(()=>m.compareSelected(source,skyBack),/UNEXPECTED_RELEASE|RELEASE_PARAMETER/);
  const bad=structuredClone(p.scoring);bad.highCloudCenter=61;assert.throws(()=>m.compareSelected(source,bad),/UNEXPECTED_RELEASE/);
  for(const key of ['weights.skyCanvas','weights.horizon','weights.illumination','weights.atmosphere','weights.weather','highCloudCenter','highCloudWidth','midCloudCenter','midCloudWidth']){
    const parts=key.split('.'),parent=parts.length===2?p.SS.config[parts[0]]:p.SS.config,k=parts.at(-1),before=p.SS.modelConfigKey();parent[k]+=.001;
    assert.notEqual(p.SS.modelConfigKey(),before,key);parent[k]-=.001;
  }
  const effective=await m.captureEffective(p.SS);
  assert.equal(effective.effective_config.scoring.version,'2.5.5.2');
  assert.equal(effective.effective_config.goldenWindow.reference,.826654);assert.deepEqual(JSON.parse(JSON.stringify(effective.effective_config.scoring.levels.map(l=>l.min))),[90,66,47,22,0]);
  assert.deepEqual(JSON.parse(JSON.stringify(effective.effective_config.scoring.skyState.factorRange)),[1,1]);
  assert.equal(effective.effective_config.scoring.goldenWindow.floor,.507692307692);
  assert.equal(effective.config_hash,await p.SS.replayService.sha256(p.SS.replayService.canonicalJson(effective.effective_config)));
  const html=await fs.readFile(path.join(__dirname,'../index.html'),'utf8');
  assert.ok(Array.from(html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g),x=>x[1]).every(x=>x.endsWith('?v=2.5.5.2-app2552')));
  assert.match(html,/sunset-score-v2\.5\.5\.2/);
});

test('new production default has independent component, normalized weight and final score expectations',()=>{
  const SS=load(createRuntime(),CORE_FILES),samples=[];
  for(const d of [0,50,100,200,300])for(const o of d?[-30,0,30]:[0])samples.push({point:{distanceKm:d,azimuthOffset:o},forecast:forecast({high:60,mid:54,low:0})});
  const sunset=new Date('2026-08-26T18:30:00Z');let trace;
  const result=SS.engine.compute({location:{latitude:31.23,longitude:121.47},utcOffsetSeconds:0,localNowUtc:new Date('2026-08-26T17:00:00Z'),
    solar:{sunset,civilDusk:new Date(+sunset+35*60000),twilightMinutes:35,sunsetAzimuthDeg:270},sunsetLocal:sunset,samples,air:null,
    expectedSampleCount:samples.length,spatialCompleteness:1,offlineTrace:t=>{trace=t;}});
  // Hand-derived constant field: bank=0.5*100+0.3*0+0.2*100=70,
  // spatial=100, illumination=(bank+spatial)/2=85, no bonus/penalty/gate.
  const visibility=100*(1-Math.exp(-18/8)),atmosphere=(.35*visibility+.15*100)/.5;
  const expected={skyCanvas:75+.1*(.5*100+.3*100+.2*visibility),horizon:100,illumination:85,atmosphere,weather:71};
  const weights={skyCanvas:.26/1.265,horizon:.45/1.265,illumination:.48/1.265,atmosphere:.025/1.265,weather:.05/1.265};
  for(const k of Object.keys(expected)){near(trace.components[k],expected[k]);near(trace.dynamic_weights[k],weights[k]);}
  const P=Object.keys(expected).reduce((sum,k)=>sum+expected[k]*weights[k],0),Q=.7+.3*atmosphere/100;
  near(trace.P,P);near(trace.Q,Q);assert.equal(result.score,Math.round(P*Q));assert.equal(trace.structure_bonus,0);assert.equal(trace.weather_penalty,0);
});

test('actual prediction, cache, golden-window, Snapshot and Replay carry the released config and identity',async()=>{
  const SS=load(createRuntime(),serviceFiles),fc=forecast(),location={name:'Fixture',country:'Test',latitude:31.23,longitude:121.47,timezone:'UTC',feature_code:'PPLA',id:123};
  SS.solar.getSunEvents=()=>({sunset:new Date('2026-08-26T18:30:00Z'),civilDusk:new Date('2026-08-26T19:05:00Z'),sunsetAzimuthDeg:270,twilightMinutes:35});
  SS.nowcast.fetchMinutePrecip=async()=>null;SS.nowcast.run=async()=>null;
  SS.data.fetchForecastWithRetry=async()=>fc;SS.data.fetchAirQuality=async()=>null;
  SS.data.gather=async nodes=>({samples:nodes.map(point=>({point,forecast:fc})),successCount:nodes.length});
  const opts={location,nowUtcMs:Date.parse('2026-08-26T17:00:00Z')},query=()=>SS.prediction.predict('31.23,121.47',opts);
  const first=await query();assert.equal(first.app_version,'2.5.5.2');assert.equal(first.model_version,'2.5.5.2');assert.equal(first.sky_evolution_factor,1);assert.equal((await query()).result_cache_status,'HIT');
  const index=SS.cache.get(SS.cacheKeys.resultIndex(SS.citySearch.toLocation(location))),cached=SS.cache.get(index.resultKey);
  SS.cache.set(index.resultKey,{...cached,model_version:'2.4.6'},60);assert.equal((await query()).result_cache_status,'MISS');
  const currentIndex=SS.cache.get(SS.cacheKeys.resultIndex(SS.citySearch.toLocation(location))),currentCache=SS.cache.get(currentIndex.resultKey);
  SS.cache.set(currentIndex.resultKey,{...currentCache,app_version:'2.4.6'},60);assert.equal((await query()).result_cache_status,'MISS');
  SS.config.weights.skyCanvas+=.001;assert.equal((await query()).result_cache_status,'MISS');assert.equal((await query()).result_cache_status,'HIT');SS.config.weights.skyCanvas-=.001;
  SS.config.midCloudCenter+=1;assert.equal((await query()).result_cache_status,'MISS');SS.config.midCloudCenter-=1;
  const captured=await SS.prediction.predict('31.23,121.47',{...opts,captureReplay:true}),replay=captured.replay_payload;
  assert.equal(replay.context.app_version,'2.5.5.2');assert.equal(replay.identity.model_version,'2.5.5.2');assert.equal(replay.context.asset_revision,'app2552');
  assert.equal(replay.effective_config.goldenWindow.reference,.826654);assert.equal(replay.effective_config.evolution.openCoverageThreshold,35);
  assert.deepEqual(JSON.parse(JSON.stringify(replay.effective_config.skyState.factorRange)),[1,1]);
  assert.equal(replay.effective_config.scoring.midCloudCenter,54);assert.equal(replay.effective_config.scoring.weights.weather,0);
  assert.equal(replay.effective_config.scoring.goldenWindow.floor,.507692307692);
  assert.equal(replay.identity.config_hash,await SS.replayService.sha256(SS.replayService.canonicalJson(replay.effective_config)));
  const {loadProduction,captureEffective}=await import('../tools/model-release/release.mjs');
  assert.equal(replay.identity.config_hash,(await captureEffective((await loadProduction()).SS)).config_hash);
  const payload=await SS.snapshotService.buildPayload(captured,{source:'github_schedule',scheduledSlot:'1213',nowUtcMs:opts.nowUtcMs});
  const row=await (await import('../server/event-dataset.js')).buildSnapshotRow(payload);
  assert.equal(row.app_version,'2.5.5.2');assert.equal(row.model_version,'2.5.5.2');assert.equal(row.sky_evolution_factor,1);await (await import('../server/replay-schema.js')).validateReplayPayload(replay,row);
  assert.equal(captured.nowcast_active,true);assert.ok(captured.sky_evolution);
  assert.equal(captured.score,Math.round(SS.domain.clamp(captured.base_score*captured.sky_evolution_factor*captured.sky_evolution.gwFactor,0,100)));
  const range=SS.evolution.goldenWindowFactorRange();near(range[0],.507692307692/.826654);near(range[1],1/.826654);
  assert.ok(captured.sky_evolution.gwFactor>=range[0]&&captured.sky_evolution.gwFactor<=range[1]);
  assert.equal(captured.level,SS.config.levels.find(l=>captured.score>=l.min).label);
});

test('runtime artifact includes Functions dependencies and rejects overlap or unlisted files',async t=>{
  const m=await import('../tools/model-release/release.mjs'),out=await fs.mkdtemp(path.join(os.tmpdir(),'model2550-'));
  t.after(()=>fs.rm(out,{recursive:true,force:true}));
  const artifact=await m.stageRuntime(out),files=Object.keys(artifact.files);
  assert.ok(files.some(x=>x.startsWith('functions/')));assert.ok(files.some(x=>x.startsWith('server/')));assert.ok(files.includes('package-lock.json'));
  assert.ok(files.every(x=>!/(?:^|\/)(?:dataset|tools|test|\.tmp|\.git|infra|node_modules)(?:\/|$)/.test(x)));
  assert.equal(JSON.parse(await fs.readFile(path.join(out,'package.json'))).dependencies.jose!=null,true);
  await fs.writeFile(path.join(out,'private.txt'),'unexpected');await assert.rejects(m.stageRuntime(out),/UNEXPECTED_FILES/);
  await assert.rejects(m.safeOutput(path.join(__dirname,'../dataset')),/OVERLAPS_APP/);
  await assert.rejects(m.safeOutput(path.join(__dirname,'../..')),/OVERLAPS_APP/);
});

test('V2.5.5.2 grade boundaries have one source per model version; legacy grading is unchanged',async()=>{
  const m=await import('../tools/evaluation/metrics.mjs'),SS=load(createRuntime(),['js/config.js','js/model_config.js']);
  for(let s=0;s<=100;s++)assert.equal(m.scoreToOrdinal(s),s>=90?4:s>=60?3:s>=40?2:s>=20?1:0);
  assert.deepEqual([...m.gradeThresholdsFromLevels(JSON.parse(JSON.stringify(SS.config.levels)))],[...m.gradeThresholdsForModelVersion(SS.version.model)]);
  for(const v of ['2.4.6','2.5.5.0','2.5.5.1',null,'','legacy'])assert.deepEqual([...m.gradeThresholdsForModelVersion(v)],[20,40,60,90],String(v));
  assert.deepEqual([...m.gradeThresholdsForModelVersion('2.5.5.2')],[22,47,66,90]);
  assert.throws(()=>m.gradeThresholdsForModelVersion('2.5.5.3'),/UNKNOWN_MODEL_VERSION_GRADE_THRESHOLDS/);
  assert.throws(()=>m.gradeThresholdsForModelVersion('2.6'),/UNKNOWN_MODEL_VERSION_GRADE_THRESHOLDS/);
  const lines=m.gradeThresholdsForModelVersion('2.5.5.2');
  assert.deepEqual([0,21,22,46,47,65,66,89,90,100].map(s=>m.gradeScore(s,lines)),[0,0,1,1,2,2,3,3,4,4]);
  assert.throws(()=>m.gradeScore(50,[20,40,40,90]),/INVALID_GRADE_THRESHOLDS/);
  m.assertLegacyGradeRows([{model_version:'2.5.5.1'},{}],'X');
  assert.throws(()=>m.assertLegacyGradeRows([{model_version:'2.5.5.1'},{model_version:'2.5.5.2'}],'EVAL_X'),/EVAL_X/);
  const html=await fs.readFile(path.join(__dirname,'../index.html'),'utf8'),mins=SS.config.levels.map(l=>l.min);
  const ranges=Array.from(html.matchAll(/class="level-badge lv-[a-z]+">([^<]+)<\/span><span>(\d+)–(\d+) 分<\/span>/g),x=>[x[1],+x[2],+x[3]]);
  assert.deepEqual(ranges,JSON.parse(JSON.stringify(SS.config.levels.map((l,i)=>[l.label,l.min,i?mins[i-1]-1:100]))));
});

test('V2.5.5.2 golden-window factor is centred by reference and identical to the old factor without it',()=>{
  const SS=load(createRuntime(),CORE_FILES),gw=SS.modelConfig.goldenWindow,floor=gw.floor;
  for(const p of [0,.02,.3,.5,.84,.98,1])near(SS.evolution.calculateGoldenWindowFactor(p),Math.min(1/.826654,Math.max(floor/.826654,(floor+(1-floor)*p)/.826654)));
  const reference=gw.reference;delete gw.reference;
  try{
    assert.deepEqual([...SS.evolution.goldenWindowFactorRange()],[floor,1]);
    for(const p of [0,.3,.5,.98,1])assert.equal(SS.evolution.calculateGoldenWindowFactor(p),Math.min(1,Math.max(floor,floor+(1-floor)*p)));
    const sources={nowMs:0,sunsetMs:90*60000,sunsetCloudCover:45,forecastTrend:10};
    const legacy=SS.evolution.evaluate(sources);gw.reference=reference;const centred=SS.evolution.evaluate(sources);
    assert.equal(legacy.sunsetOpenProbability,centred.sunsetOpenProbability);
    near(centred.gwFactor,Math.round((floor+(1-floor)*centred.sunsetOpenProbability)/reference*1000)/1000);
    near(legacy.gwFactor,Math.round((floor+(1-floor)*legacy.sunsetOpenProbability)*1000)/1000);
  }finally{gw.reference=reference;}
});

test('H1 holdout rules: independence by date and DEV members, PRIMARY_LAST cohort, weighted AUC and rollback rules',async()=>{
  const h=await import('../tools/model-release/holdout.mjs');
  const dev={snapshots:new Set(['s_dev']),events:new Set(['e_dev'])};
  assert.equal(h.independence([{snapshot_id:'a',event_id:'e1',event_date_local:'2026-10-13'}],dev).independent,true);
  assert.equal(h.independence([{snapshot_id:'a',event_id:'e1',event_date_local:'2026-10-12'}],dev).before_first_date,1);
  assert.equal(h.independence([{snapshot_id:'a',event_id:'e_dev',event_date_local:'2026-10-20'}],dev).overlapping_dev,1);
  const last=h.primaryLast([{event_id:'e',snapshot_id:'b',lead_time_minutes:30},{event_id:'e',snapshot_id:'a',lead_time_minutes:30},{event_id:'e',snapshot_id:'c',lead_time_minutes:300}]);
  assert.deepEqual(last.map(r=>r.snapshot_id),['a']);
  const rows=[{gt_ordinal:3,gt_confidence:1,s:80},{gt_ordinal:2,gt_confidence:1,s:50},{gt_ordinal:0,gt_confidence:1,s:50},{gt_ordinal:1,gt_confidence:.5,s:10}];
  // pairs (weight, outcome): 80>50 (1,1), 80>10 (.5,1), 50=50 (1,.5), 50>10 (.5,1)
  near(h.weightedAuc(rows,'s',2),(1+.5+.5+.5)/(1+.5+1+.5));near(h.weightedAuc(rows,'s',3),1);
  const m=(loss,r2,a3)=>({product_loss:loss,ge2_recall:r2,auc_ge3_primary_last:a3});
  assert.equal(h.rollbackSuggested('AUC_GE3_NOT_HIGHER_OR_PRODUCT_LOSS_HIGHER',m(1,.7,.75),m(1.1,.8,.65)),false);
  assert.equal(h.rollbackSuggested('AUC_GE3_NOT_HIGHER_OR_PRODUCT_LOSS_HIGHER',m(1,.7,.65),m(1.1,.8,.65)),true);
  assert.equal(h.rollbackSuggested('AUC_GE3_NOT_HIGHER_OR_PRODUCT_LOSS_HIGHER',m(1.2,.7,.8),m(1.1,.8,.65)),true);
  assert.equal(h.rollbackSuggested('PRODUCT_LOSS_HIGHER_OR_GE2_RECALL_DROP_OVER_0_05',m(1,.66,0),m(1,.7,0)),false);
  assert.equal(h.rollbackSuggested('PRODUCT_LOSS_HIGHER_OR_GE2_RECALL_DROP_OVER_0_05',m(1,.64,0),m(1,.7,0)),true);
  assert.equal(h.rollbackSuggested('PRODUCT_LOSS_HIGHER_OR_GE2_RECALL_DROP_OVER_0_05',m(1.01,.9,0),m(1,.7,0)),true);
  const source=JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/model-2550-selected-config.json'),'utf8')),configs=await h.releaseConfigs();
  h.assertV2550(source,configs['2.5.5.0']);
  assert.deepEqual(JSON.parse(JSON.stringify(configs['2.5.5.0'].skyState.factorRange)),[0.65,1.15]);assert.deepEqual(JSON.parse(JSON.stringify(configs['2.5.5.1'].skyState.factorRange)),[1,1]);
  assert.equal(configs['2.5.5.1'].evolution.openCoverageThreshold,20);assert.equal(configs['2.5.5.2'].evolution.openCoverageThreshold,35);
  const bad=structuredClone(configs['2.5.5.0']);bad.midCloudCenter+=1;assert.throws(()=>h.assertV2550(source,bad),/HOLDOUT_V2550_CONFIG_MISMATCH/);
});

test('H1 holdout check (Policy 2) recomputes four release versions with their own grade lines and is single-use',{timeout:600000},async t=>{
  const h=await import('../tools/model-release/holdout.mjs'),{gradeScore}=await import('../tools/evaluation/metrics.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'h1-holdout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const date=i=>'2026-10-'+String(13+i).padStart(2,'0');
  const fixture=await require('./evaluation-fixture.cjs').createSyntheticPipeline(root,{date,cutoff:'2026-10-16T00:00:00.000Z'});t.after(fixture.close);
  const sources={raw:fixture.rawDir,gt:fixture.gtDir,model:fixture.modelDir};
  const selected=JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/model-2550-selected-config.json'),'utf8'));
  const dev={snapshots:new Set(),events:new Set(),selected};
  const policy={...h.HOLDOUT_POLICY,thresholds:{dates:3,events:10,ge2_events:2,ge3_events:1},bootstrap:{...h.HOLDOUT_POLICY.bootstrap,replicates:40}};
  const status=await h.holdoutStatus(sources,{dev,policy});
  assert.equal(status.scope,'LABEL_COUNTS_ONLY_NO_PREDICTION_COMPUTED');assert.equal(status.independence.independent,true);assert.equal(status.readiness.ready,true);
  assert.equal((await h.holdoutStatus(sources,{dev})).readiness.ready,false);
  const ledger=path.join(root,'ledger.jsonl'),out=path.join(root,'h1');
  await assert.rejects(h.holdoutCheck(sources,out,{dev,ledger}),/HOLDOUT_BELOW_THRESHOLD/);
  const done=await h.holdoutCheck(sources,out,{dev,policy,ledger});
  assert.equal(done.status,'COMPLETE');assert.deepEqual(Object.keys(done.rollback_suggested),['V2551_VS_V2550','V2552_VS_V2551','V2554_VS_V2552']);
  const result=JSON.parse(await fs.readFile(path.join(out,'holdout_result.json'),'utf8'));
  assert.deepEqual(result.grade_thresholds,{'2.5.5.0':[20,40,60,90],'2.5.5.1':[20,40,60,90],'2.5.5.2':[22,47,66,90],'2.5.5.4':[22,47,66,90]});assert.equal(result.policy.version,2);
  const csv=(await fs.readFile(path.join(out,'holdout_predictions.csv'),'utf8')).trim().split(/\r?\n/),head=csv[0].split(','),rows=csv.slice(1).map(l=>Object.fromEntries(l.split(',').map((v,i)=>[head[i],v])));
  assert.equal(rows.length,result.snapshot_count);
  const graded=rows.map(r=>({...r,gt_ordinal:+r.gt_ordinal,gt_confidence:+r.gt_confidence,event_normalized_weight:+r.event_normalized_weight,lead_time_minutes:+r.lead_time_minutes,
    'score_2.5.5.2':+r['score_2.5.5.2'],predicted_ordinal:gradeScore(+r['score_2.5.5.2'],[22,47,66,90])}));
  near(h.versionMetrics(graded,'2.5.5.2',[22,47,66,90]).product_loss,result.metrics['2.5.5.2'].product_loss);
  assert.match(await fs.readFile(path.join(out,'report.md'),'utf8'),/H1 前向留出核验/);
  await assert.rejects(h.holdoutCheck(sources,path.join(root,'h1b'),{dev,policy,ledger}),/HOLDOUT_ALREADY_USED/);
  await assert.rejects(h.holdoutCheck(sources,path.join(root,'h1c'),{dev:{...dev,events:new Set([rows[0].event_id])},policy,ledger:path.join(root,'other.jsonl')}),/HOLDOUT_OVERLAPS_DEV/);
});
