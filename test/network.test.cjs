const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');
const FILES = ['js/config.js','js/model_config.js','js/network.js'];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };

test('timeout aborts transport before headers and while reading JSON body', async () => {
  for (const bodyPending of [false, true]) {
    let signal;
    const SS = load(createRuntime({ fetch: async (_, init) => {
      signal = init.signal;
      if (!bodyPending) return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    }}), FILES);
    await assert.rejects(SS.network.json('/fake', {timeoutMs: 15}), {name:'TimeoutError'});
    assert.equal(signal.aborted, true);
  }
});

test('successful requests remove deadline timers and caller listeners', async () => {
  const pending = new Set();
  const SS = load(createRuntime({
    setTimeout: (fn,ms) => { const t = setTimeout(fn,ms); pending.add(t); return t; },
    clearTimeout: t => { pending.delete(t); clearTimeout(t); },
    fetch: async () => ({ok:true,json:async () => ({success:true})})
  }), FILES);
  const controller = new AbortController();
  assert.deepEqual(await SS.network.json('/fake',{signal:controller.signal}),{success:true});
  assert.equal(pending.size,0);
  controller.abort();
});

test('V2.5.5.20 local forecast: direct once, then the relay once; cancelling during the relay stops without a third request', async () => {
  const urls = [];
  const relay = deferred();
  const SS = load(createRuntime({fetch: async (url, init) => {
    urls.push(url);
    if (urls.length === 1) throw new TypeError('Failed to fetch');
    relay.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  }}), [...FILES,'js/data.js']);
  const controller = new AbortController();
  const result = SS.data.fetchForecastWithRetry(22,114,10000,{signal:controller.signal});
  const rejected = assert.rejects(result, {name:'AbortError'});
  await relay.promise;
  controller.abort();
  await rejected;
  assert.equal(urls.length,2);
  assert.match(urls[0],/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=22\.0000&longitude=114\.0000&/);
  assert.match(urls[1],/^\/api\/open-meteo\?service=forecast&latitude=22\.0000&longitude=114\.0000&/);
});

test('cancelled image releases handlers and source, without waiting for onload', async () => {
  let img;
  class FakeImage { constructor() { img = this; } }
  const SS = load(createRuntime({Image:FakeImage}),FILES);
  const controller = new AbortController();
  const pending = SS.network.loadImage('/tile',{signal:controller.signal});
  const rejected = assert.rejects(pending,{name:'AbortError'});
  await Promise.resolve();
  controller.abort();
  await rejected;
  assert.equal(img.onload,null);
  assert.equal(img.onerror,null);
  assert.equal(img.src,'');
});

test('a never-loading tile reaches its deadline', async () => {
  let img;
  class FakeImage { constructor() { img=this; } }
  const SS = load(createRuntime({Image:FakeImage}),FILES);
  SS.modelConfig.network.tileTimeoutMs = 10;
  await assert.rejects(SS.network.loadImage('/tile'),{name:'TimeoutError'});
  assert.equal(img.onload,null);
  assert.equal(img.src,'');
});

test('superseded queries cannot render, report errors or end the new loading state', async () => {
  const document = {readyState:'loading',addEventListener(){}};
  const runtime = createRuntime({document});
  const SS = load(runtime,FILES);
  const calls = [], rendered = [], errors = [];
  let ended = 0;
  SS.ui = {beginPrediction(){},setLoading(){},renderResult:r=>rendered.push(r),
    showError:e=>errors.push(e),endPrediction(){ended++;}};
  SS.prediction = {predict(query, options){ const d=deferred(); calls.push({...d,query,options}); return d.promise; }};
  load(runtime,['js/app.js']);
  const old = SS.app.predict('old');
  const fresh = SS.app.predict('new');
  assert.equal(calls[0].options.signal.aborted,true);
  calls[0].resolve('old');
  await old;
  assert.equal(ended,0);
  calls[1].resolve('new');
  await fresh;
  assert.deepEqual(rendered,['new']);
  assert.deepEqual(errors,[]);
  assert.equal(ended,1);
});

test('feedback deadline does not auto-retry POST or claim remote success', async () => {
  let calls=0;
  const SS = load(createRuntime({fetch: async () => {calls++;return {ok:true,json:()=>new Promise(()=>{})};}}),
    [...FILES,'js/time.js','js/baseline.js','js/feedback_service.js']);
  SS.modelConfig.network.feedbackTimeoutMs = 10;
  const reply = await SS.baseline.submitFeedback({city:'test',user_rating:'poor'});
  assert.equal(reply.remote,false);
  assert.equal(reply.local,true);
  assert.match(reply.error,/尚未确认/);
  assert.equal(calls,1);
  assert.equal(SS.feedbackService.remainingCooldownMinutes('test'),0);
});
