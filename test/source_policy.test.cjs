const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
const FILES = [...CORE_FILES,'js/vendor/suncalc.js','js/solar.js','js/cache.js','js/sampling.js','js/corridor.js','js/nowcast.js','js/prediction_service.js','js/feedback_service.js'];
const ctx = {lat:22.54,lon:114.06,dateStr:'2026-08-26',nowUtc:new Date('2026-08-26T10:00:00Z'),sunsetAzimuthDeg:282,forecastTrend:10};

test('source flags bypass populated caches; master switch keeps explicit DISABLED diagnostics', async () => {
  const SS = load(createRuntime({fetch:async () => {throw new Error('unexpected request');}}),FILES);
  const nc = SS.modelConfig.nowcast;
  for (const type of ['precip','radar','satellite']) SS.cache.set(SS.cacheKeys.nowcast(type,ctx.dateStr,ctx.lat,ctx.lon),{
    analysis:{available:true,source:'qweather',score:0,rainClearScore:0},status:'OK'
  },10);
  nc.radar.enabled = false;
  let result = await SS.nowcast.run(ctx);
  assert.equal(result.sourcesStatus.radar.status,'DISABLED');
  assert.equal(result.sourcesStatus.satellite.status,'OK');
  nc.radar.enabled = true;
  nc.satellite.enabled = false;
  result = await SS.nowcast.run(ctx);
  assert.equal(result.sourcesStatus.radar.status,'OK');
  assert.equal(result.sourcesStatus.satellite.status,'DISABLED');
  nc.enabled = false;
  assert.equal(await SS.nowcast.analyzeRadar(ctx.lat,ctx.lon,ctx.sunsetAzimuthDeg),null);
  assert.equal(await SS.nowcast.analyzeSatellite(ctx.lat,ctx.lon,ctx.sunsetAzimuthDeg),null);
  result = await SS.nowcast.run(ctx);
  for (const type of ['precip','radar','satellite','qweather']) assert.equal(result.sourcesStatus[type].status,'DISABLED');
  assert.equal(result.detail.precip,null);
});

test('QWeather disabled makes no QWeather request and cannot reuse its minute cache', async () => {
  const calls=[];
  const SS = load(createRuntime({location:{protocol:'http:'}, fetch:async url => {
    calls.push(url);
    return {ok:true,json:async()=>({utc_offset_seconds:0,minutely_15:{
      time:Array.from({length:8},(_,i)=>new Date(ctx.nowUtc.valueOf()+i*900000).toISOString()),
      precipitation:Array(8).fill(0)
    }})};
  }}),FILES);
  const before = SS.cacheKeys.nowcast('precip',ctx.dateStr,ctx.lat,ctx.lon);
  SS.modelConfig.nowcast.qweather.enabled = false;
  assert.notEqual(SS.cacheKeys.nowcast('precip',ctx.dateStr,ctx.lat,ctx.lon),before);
  const result = await SS.nowcast.fetchMinutePrecip(ctx.lat,ctx.lon);
  assert.equal(result.source,'openmeteo');
  assert.equal(calls.length,1);
  assert.ok(calls[0].startsWith(SS.modelConfig.api.forecast));
});

function predictionRuntime(extra={}) {
  const runtime = createRuntime(extra), SS=load(runtime,FILES);
  const fc=forecast(); fc.timezone='Asia/Shanghai'; fc.utc_offset_seconds=28800;
  SS.data.fetchForecastWithRetry=async()=>fc;
  SS.data.fetchAirQuality=async()=>null;
  SS.data.gather=async nodes=>({samples:nodes.map(point=>({point,forecast:fc}))});
  SS.solar.getSunEvents=()=>({sunset:new Date('2026-08-26T10:45:00Z'),civilDusk:new Date('2026-08-26T11:10:00Z'),sunsetAzimuthDeg:282,twilightMinutes:25});
  SS.nowcast.fetchMinutePrecip=async()=>null;
  return {runtime,SS,fc};
}

test('disabling enhancements preserves all-day NWP and changing window policy invalidates result cache',async()=>{
  const {SS}=predictionRuntime();
  SS.modelConfig.nowcast.enabled=false;
  const options={nowUtcMs:ctx.nowUtc.valueOf()};
  const first=await SS.prediction.predict('22.54,114.06',options);
  assert.ok(first.cloud_motion.predictions.m60.summary);
  assert.ok(Number.isFinite(first.sky_evolution.gwFactor));
  assert.equal(first.nowcast.sourcesStatus.radar.status,'DISABLED');
  const payload = SS.feedbackService.buildPayload(first,{rating:'poor'});
  const snapshot = JSON.parse(payload.raw_snapshot_json);
  assert.equal(snapshot.distance_diagnostics.reliability,first.distance_reliability);
  assert.equal(snapshot.distance_diagnostics.illumination_data_factor,1);
  assert.equal(snapshot.sky_evolution.sources_status.qweather.status,'DISABLED');
  SS.modelConfig.goldenWindow.enabled=false;
  const second=await SS.prediction.predict('22.54,114.06',options);
  assert.equal(second.nowcast_active,false);
  assert.equal(second.sky_evolution,null);
  assert.equal(second.score,Math.round(SS.domain.clamp(second.base_score*second.sky_evolution_factor,0,100)));
  assert.notEqual(first.runtime_config_key,second.runtime_config_key);
  assert.ok(second.cloud_motion.predictions.m60.summary);
});

test('cancelled spatial request never falls back, writes its late result or renders stale progress',async()=>{
  const {SS,runtime,fc}=predictionRuntime();
  let ready,finish,calls=0;
  const started=new Promise(resolve=>{ready=resolve;});
  SS.data.gather=nodes=>{calls++;ready();return new Promise(resolve=>{finish=()=>resolve({samples:nodes.map(point=>({point,forecast:fc}))});});};
  const controller=new AbortController();
  const pending=SS.prediction.predict('22.54,114.06',{nowUtcMs:Date.parse('2026-08-26T02:00:00Z'),signal:controller.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await started;
  controller.abort();
  await rejected;
  const entries=Array.from(runtime.storage.entries());
  finish();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls,1);
  assert.deepEqual(Array.from(runtime.storage.entries()),entries);
});

test('cancelled metadata never triggers QWeather -> Open-Meteo fallback or negative caching',async()=>{
  let calls=0,ready;
  const started=new Promise(resolve=>{ready=resolve;});
  const runtime=createRuntime({location:{protocol:'http:'},fetch:async()=>{calls++;ready();return new Promise(()=>{});}});
  const SS=load(runtime,FILES), controller=new AbortController();
  SS.modelConfig.nowcast.radar.enabled=false;
  SS.modelConfig.nowcast.satellite.enabled=false;
  const pending=SS.nowcast.run(ctx,{signal:controller.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await started;
  controller.abort();
  await rejected;
  assert.equal(calls,1);
  assert.equal(runtime.storage.size,0);
});
