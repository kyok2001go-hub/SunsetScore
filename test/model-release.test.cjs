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

test('release loads real production aliases, admits only five declared metadata/default/sky-off diffs, hashes real Replay config',async()=>{
  const m=await import('../tools/model-release/release.mjs'),p=await m.loadProduction();
  const source=JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/model-2550-selected-config.json'),'utf8'));
  assert.equal(p.version.app,'2.5.5.1');assert.equal(p.version.model,'2.5.5.1');assert.equal(p.version.assetRevision,'app2551');
  assert.equal(p.model.scoring,p.SS.config);assert.equal(p.model.goldenWindow,p.model.scoring.goldenWindow);
  assert.equal(m.compareSelected(source,p.scoring).length,5);
  assert.deepEqual(JSON.parse(JSON.stringify(p.scoring.skyState.factorRange)),[1,1]);
  const skyBack=structuredClone(p.scoring);skyBack.skyState.factorRange=[0.65,1.15];assert.throws(()=>m.compareSelected(source,skyBack),/UNEXPECTED_RELEASE|RELEASE_PARAMETER/);
  const bad=structuredClone(p.scoring);bad.highCloudCenter=61;assert.throws(()=>m.compareSelected(source,bad),/UNEXPECTED_RELEASE/);
  for(const key of ['weights.skyCanvas','weights.horizon','weights.illumination','weights.atmosphere','weights.weather','highCloudCenter','highCloudWidth','midCloudCenter','midCloudWidth']){
    const parts=key.split('.'),parent=parts.length===2?p.SS.config[parts[0]]:p.SS.config,k=parts.at(-1),before=p.SS.modelConfigKey();parent[k]+=.001;
    assert.notEqual(p.SS.modelConfigKey(),before,key);parent[k]-=.001;
  }
  const effective=await m.captureEffective(p.SS);
  assert.equal(effective.effective_config.scoring.version,'2.5.5.1');
  assert.deepEqual(JSON.parse(JSON.stringify(effective.effective_config.scoring.skyState.factorRange)),[1,1]);
  assert.equal(effective.effective_config.scoring.goldenWindow.floor,.507692307692);
  assert.equal(effective.config_hash,await p.SS.replayService.sha256(p.SS.replayService.canonicalJson(effective.effective_config)));
  const html=await fs.readFile(path.join(__dirname,'../index.html'),'utf8');
  assert.ok(Array.from(html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g),x=>x[1]).every(x=>x.endsWith('?v=2.5.5.1-app2551')));
  assert.match(html,/sunset-score-v2\.5\.5\.1/);
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
  const first=await query();assert.equal(first.app_version,'2.5.5.1');assert.equal(first.model_version,'2.5.5.1');assert.equal(first.sky_evolution_factor,1);assert.equal((await query()).result_cache_status,'HIT');
  const index=SS.cache.get(SS.cacheKeys.resultIndex(SS.citySearch.toLocation(location))),cached=SS.cache.get(index.resultKey);
  SS.cache.set(index.resultKey,{...cached,model_version:'2.4.6'},60);assert.equal((await query()).result_cache_status,'MISS');
  const currentIndex=SS.cache.get(SS.cacheKeys.resultIndex(SS.citySearch.toLocation(location))),currentCache=SS.cache.get(currentIndex.resultKey);
  SS.cache.set(currentIndex.resultKey,{...currentCache,app_version:'2.4.6'},60);assert.equal((await query()).result_cache_status,'MISS');
  SS.config.weights.skyCanvas+=.001;assert.equal((await query()).result_cache_status,'MISS');assert.equal((await query()).result_cache_status,'HIT');SS.config.weights.skyCanvas-=.001;
  SS.config.midCloudCenter+=1;assert.equal((await query()).result_cache_status,'MISS');SS.config.midCloudCenter-=1;
  const captured=await SS.prediction.predict('31.23,121.47',{...opts,captureReplay:true}),replay=captured.replay_payload;
  assert.equal(replay.context.app_version,'2.5.5.1');assert.equal(replay.identity.model_version,'2.5.5.1');assert.equal(replay.context.asset_revision,'app2551');
  assert.deepEqual(JSON.parse(JSON.stringify(replay.effective_config.skyState.factorRange)),[1,1]);
  assert.equal(replay.effective_config.scoring.midCloudCenter,54);assert.equal(replay.effective_config.scoring.weights.weather,0);
  assert.equal(replay.effective_config.scoring.goldenWindow.floor,.507692307692);
  assert.equal(replay.identity.config_hash,await SS.replayService.sha256(SS.replayService.canonicalJson(replay.effective_config)));
  const {loadProduction,captureEffective}=await import('../tools/model-release/release.mjs');
  assert.equal(replay.identity.config_hash,(await captureEffective((await loadProduction()).SS)).config_hash);
  const payload=await SS.snapshotService.buildPayload(captured,{source:'github_schedule',scheduledSlot:'1213',nowUtcMs:opts.nowUtcMs});
  const row=await (await import('../server/event-dataset.js')).buildSnapshotRow(payload);
  assert.equal(row.app_version,'2.5.5.1');assert.equal(row.model_version,'2.5.5.1');assert.equal(row.sky_evolution_factor,1);await (await import('../server/replay-schema.js')).validateReplayPayload(replay,row);
  assert.equal(captured.nowcast_active,true);assert.ok(captured.sky_evolution);
  assert.equal(captured.score,Math.round(SS.domain.clamp(captured.base_score*captured.sky_evolution_factor*captured.sky_evolution.gwFactor,0,100)));
  assert.ok(captured.sky_evolution.gwFactor>=.507692307692);
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
