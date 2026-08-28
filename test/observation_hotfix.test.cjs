const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { createRuntime, load } = require('./helpers.cjs');
const files = ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js',
  'js/time.js', 'js/cache.js', 'js/cloud_field.js', 'js/nowcast.js', 'js/evolution.js'];
const now = Date.parse('2026-08-27T09:00:00Z');
function series(step = 15, count = 120, source = 'openmeteo') {
  // Provider timestamps: Open-Meteo labels the END of the accumulated interval.
  return { times: Array.from({length: count}, (_, i) => new Date(now + (i + (source === 'openmeteo' ? 1 : 0)) * step * 60000).toISOString()),
    precip: Array(count).fill(0.2), stepMs: step * 60000, source };
}

test('Pages proxies forward the original native body, preserving V2.3.1 streaming identity', async () => {
  const qw = await import('../functions/api/qweather.js');
  const proxy = await import('../functions/api/proxy.js');
  const original = global.fetch;
  try {
    for (const kind of ['qweather', 'proxy']) {
      const bytes = kind === 'qweather' ? new TextEncoder().encode('{"code":"200"}') : new Uint8Array([137,80,78,71,0,255]);
      const upstream = new Response(bytes, {headers:{'Content-Type':kind === 'qweather' ? 'application/json' : 'image/png'}});
      const nativeBody = upstream.body;
      let forwarded;
      global.fetch = async (url, init) => { forwarded = {url:String(url), init}; return upstream; };
      const request = new Request(kind === 'qweather' ? 'https://example.test/api/qweather?lat=22.54&lon=114.06'
        : 'https://example.test/api/proxy?url=' + encodeURIComponent('https://tilecache.rainviewer.com/test.png'));
      const response = await (kind === 'qweather' ? qw : proxy).onRequestGet({request, env:{QWEATHER_API_KEY:'test-only'}});
      assert.equal(response.status, 200);
      assert.equal(response.body, nativeBody, 'must not reconstruct the edge stream with getReader/pull');
      assert.equal(forwarded.init.signal, undefined, 'no new edge cancellation wrapper');
      assert.equal(forwarded.init.redirect, 'error');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
      if (kind === 'qweather') {
        assert.equal(new URL(forwarded.url).searchParams.get('location'), '114.06,22.54');
        assert.equal(forwarded.init.headers['X-QW-Api-Key'], 'test-only');
      }
    }
  } finally { global.fetch = original; }
});

test('proxy rollback retains HTTPS and host checks, with no upstream request for rejected targets', async () => {
  const {onRequestGet} = await import('../functions/api/proxy.js');
  const original = global.fetch;
  try {
    global.fetch = async () => { throw new Error('must not fetch'); };
    for (const target of ['http://tilecache.rainviewer.com/test', 'https://example.com/test']) {
      const response = await onRequestGet({request:new Request('https://example.test/api/proxy?url=' + encodeURIComponent(target))});
      assert.equal(response.status, 403);
    }
  } finally { global.fetch = original; }
});

test('Open-Meteo minute UTC conversion is independent of the browser/host timezone', () => {
  const script = `const {createRuntime,load}=require('./test/helpers.cjs');
    const time=Array.from({length:8},(_,i)=>new Date(Date.UTC(2026,7,27,17,i*15)).toISOString().slice(0,16));
    const ss=load(createRuntime({location:{protocol:'https:'},fetch:async()=>new Response(JSON.stringify({utc_offset_seconds:28800,minutely_15:{time,precipitation:Array(8).fill(0.2)}}))}),${JSON.stringify(files)});
    ss.config.nowcast.qweather.enabled=false;
    ss.nowcast.fetchMinutePrecip(22.54,114.06).then(s=>console.log(s.times[0]));`;
  for (const timezone of ['Asia/Shanghai', 'UTC', 'America/Los_Angeles']) {
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: join(__dirname, '..'), env: {...process.env, TZ:timezone}, encoding:'utf8'
    });
    assert.equal(output.trim(), '2026-08-27T09:00:00.000Z', timezone);
  }
});

test('QWeather failure falls back to a labelled summary and rainy timeline, not empty content', async () => {
  const calls = [];
  const s = series();
  const SS = load(createRuntime({location:{protocol:'https:'}, fetch:async url => {
    calls.push(url);
    if (url.startsWith('/api/qweather')) return new Response('error code: 502', {status:502});
    return Response.json({utc_offset_seconds:0,minutely_15:{time:s.times,precipitation:s.precip}});
  }}), files);
  const fetched = await SS.nowcast.fetchMinutePrecip(22.54,114.06);
  const analysis = SS.nowcast.analyzePrecip(fetched, now);
  assert.equal(calls.length, 2);
  assert.match(analysis.summary, /120.*Open-Meteo/);
  assert.equal(analysis.stopTimeMs, null);
  assert.ok(SS.nowcast.buildTimeline(analysis, null, now).every(item => item.icon === '🌧️'));
});

test('minute analysis uses the current interval and only contiguous known data within two hours', () => {
  const SS = load(createRuntime(), files);
  const s = series();
  s.precip.fill(0, 24); // Rain ends six hours away, not a near-term golden window.
  const analysis = SS.nowcast.analyzePrecip(s, now + 60000);
  assert.equal(analysis.series.start, 0);
  assert.equal(analysis.stopTimeMs, null);
  assert.equal(SS.nowcast.fuse({precip:analysis}).goldenWindow, null);
  s.precip[1] = null;
  s.precip.fill(0, 2);
  const gapped = SS.nowcast.analyzePrecip(s, now);
  assert.equal(gapped.stopTimeMs, null);
  assert.match(gapped.summary, /15 分钟/);
  s.precip[0] = null;
  assert.equal(SS.nowcast.analyzePrecip(s, now), null);
  assert.equal(SS.nowcast.analyzePrecip(series(5, 24), now + 3 * 3600000), null);
});

test('QWeather summary is preserved and rain-stop candidates are clipped to the sunset event', () => {
  const SS = load(createRuntime(), files);
  const s = series(5, 24, 'qweather');
  s.source = 'qweather'; s.summary = '降雨还将持续120分钟';
  assert.equal(SS.nowcast.analyzePrecip(s, now).summary, s.summary);
  const sunset = now + 60 * 60000;
  const clip = candidate => SS.evolution.constrainGoldenWindow(candidate, now, sunset);
  assert.equal(clip({stopTimeMs:now + 360 * 60000, durationMin:120}), null);
  assert.equal(clip({stopTimeMs:sunset + 30 * 60000, durationMin:120}), null);
  assert.equal(clip({stopTimeMs:sunset + 10 * 60000, durationMin:60}).durationMin, 20);
  assert.equal(clip({stopTimeMs:now - 120 * 60000, durationMin:30}), null);
  SS.config.goldenWindow.enabled = false;
  assert.equal(clip({stopTimeMs:now, durationMin:20}), null);
});

test('rain-excluded available satellite is not reported as offline, but failed radar remains degraded', () => {
  const SS = load(createRuntime(), files);
  const result = SS.evolution.evaluate({
    satellite:{available:true,coverageSeries:[{t:now-600000,pct:50},{t:now,pct:40}]},
    precip:{available:true,rainingNow:true,stopMin:null}, nowMs:now,sunsetMs:now+3600000,
    sourcesStatus:{radar:{available:false,status:'TIMEOUT'},satellite:{available:true,status:'OK'}}
  });
  assert.equal(result.detail.satellite, null);
  assert.ok(!result.degradedSources.includes('卫星云图'));
  assert.ok(result.degradedSources.includes('雷达瓦片'));
  assert.ok(Number.isFinite(result.gwFactor));
});

test('UI keeps hourly weather when minutes are missing and separates availability from fusion use', () => {
  function element() {
    return {textContent:'',children:[],classList:{add(){},remove(){}},style:{},
      appendChild(child){this.children.push(child);},setAttribute(){}};
  }
  const nodes = Object.fromEntries(['nowcast-block','n-summary','n-timeline','details'].map(id => [id,element()]));
  const runtime = createRuntime({document:{getElementById:id=>nodes[id] || null,createElement:element}});
  const SS = load(runtime, [...files,'js/ui.js']);
  // Rendering-focused contract; numeric prediction validity is tested by service tests.
  SS.domain.assertPredictionResult = () => {};
  const result = {score:20,timezone:'Asia/Shanghai',nowcast_active:true,
    nowcast:{detail:{precip:null},sourcesStatus:{radar:{status:'TIMEOUT',available:false},satellite:{status:'OK',available:true}},
      timeline:Array.from({length:5},(_,i)=>({timeMs:now+i*1800000,icon:'🌧️',label:'降水',source:'小时预报'}))},
    sky_evolution:{detail:{radar:null,satellite:null}}};
  SS.ui.renderResult(result);
  assert.match(nodes['n-summary'].textContent,/分钟降水暂不可用.*小时预报/);
  assert.equal(nodes['n-timeline'].children.length,5);
  assert.ok(nodes['n-timeline'].children.every(item=>item.children[1].textContent==='🌧️'));
  const text = node => node.textContent + node.children.map(text).join(' ');
  assert.match(text(nodes.details), /雷达: ⚪ 请求超时.*卫星: 🟢 可用，本次未参与演化/);
  assert.doesNotMatch(text(nodes.details), /未覆盖\/NWP/);
});
