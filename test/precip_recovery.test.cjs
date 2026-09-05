const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, forecast, CORE_FILES } = require('./helpers.cjs');
const FILES = [...CORE_FILES, 'js/cache.js', 'js/nowcast.js'];
const SERVICE_FILES = [...FILES, 'js/vendor/suncalc.js', 'js/solar.js', 'js/sampling.js',
  'js/corridor.js', 'js/prediction_service.js', 'js/feedback_service.js'];
const base = Date.parse('2026-08-26T09:00:00Z'); // Shenzhen 17:00
const minute = 60000;
function raw(source, values, origin = base) {
  const step = source === 'openmeteo' ? 15 : 5;
  return { source, stepMs: step * minute, precip: values,
    times: values.map((_, i) => new Date(origin + i * step * minute).toISOString()) };
}
function qwResponse(origin = base, values = Array(24).fill(0.2)) {
  const s = raw('qweather', values, origin);
  return Response.json({ code: '200', summary: '降雨还将持续120分钟',
    minutely: s.times.map((fxTime, i) => ({ fxTime, precip: String(values[i]) })) });
}
function omResponse(values = Array(24).fill(0.2)) {
  const s = raw('openmeteo', values);
  return Response.json({ utc_offset_seconds: 0, minutely_15: { time: s.times, precipitation: s.precip } });
}
function runtime(fetcher, files = FILES) {
  const clock = { now: base };
  class Clock extends Date { static now() { return clock.now; } }
  const rt = createRuntime({ Date: Clock, location: { protocol: 'https:' }, fetch: fetcher });
  const SS = load(rt, files);
  SS.config.nowcast.radar.enabled = false;
  SS.config.nowcast.satellite.enabled = false;
  const ctx = () => ({ lat: 22.54, lon: 114.06, dateStr: '2026-08-26', nowUtc: new Date(clock.now), forecastTrend: 0 });
  return { SS, rt, clock, ctx };
}

test('Open-Meteo end-labelled rain reaches both timeline and rain-stop analysis without a 15m shift', () => {
  const { SS } = runtime(() => { throw new Error('no network'); });
  // 17:00 is the previous dry interval; 17:15 describes rain during 17:00–17:15.
  const s = raw('openmeteo', [0, 1, 0, 0, 0, 1, ...Array(12).fill(0)]);
  const at = base + 5 * minute;
  const result = SS.nowcast.analyzePrecip(s, at);
  assert.equal(result.rainingNow, true);
  assert.equal(result.series.start, 1);
  assert.equal(result.stopTimeMs, base + 15 * minute);
  assert.equal(result.stopMin, 10);
  assert.equal(result.nextRainMs, base + 60 * minute);
  assert.equal(result.coverageEndMs, at + 120 * minute);
  assert.equal(result.series.intervalAnchor, 'end');
  assert.equal(result.series.times[1], s.times[1], 'raw timestamp is not rewritten');
  assert.equal(SS.nowcast.buildTimeline(result, null, at)[0].icon, '🌧️');
  assert.equal(SS.nowcast.precipAtSeries(result.series, base + 15 * minute), 0);
  const later = SS.nowcast.analyzePrecip(result.series, base + 10 * minute);
  assert.equal(later.stopMin, 5, 'reanalysis does not shift timestamps twice');
});

test('QWeather keeps its forecast-start intervals and exact stop time', () => {
  const { SS } = runtime();
  const s = raw('qweather', [1, 1, 0, 0, 0, 0, 1, ...Array(17).fill(0)]);
  const result = SS.nowcast.analyzePrecip(s, base + minute);
  assert.equal(result.series.intervalAnchor, 'start');
  assert.equal(result.rainingNow, true);
  assert.equal(result.stopTimeMs, base + 10 * minute);
  assert.equal(result.stopMin, 9);
  assert.equal(result.nextRainMs, base + 30 * minute);
  assert.equal(SS.nowcast.precipAtSeries(result.series, base - 1), null);
  assert.equal(SS.nowcast.precipAtSeries(result.series, base + 10 * minute), 0);
});

test('source intervals enforce end boundaries, gaps, nulls and invalid timestamps', () => {
  const { SS } = runtime();
  for (const source of ['qweather', 'openmeteo']) {
    const s = raw(source, Array(24).fill(1));
    const start = source === 'openmeteo' ? base - s.stepMs : base;
    const end = start + s.precip.length * s.stepMs;
    assert.equal(SS.nowcast.precipAtSeries(s, start - 1), null);
    assert.equal(SS.nowcast.precipAtSeries(s, start), 1);
    assert.equal(SS.nowcast.precipAtSeries(s, end - 1), 1);
    assert.equal(SS.nowcast.precipAtSeries(s, end), null);
    assert.equal(SS.nowcast.analyzePrecip(s, end), null);
    assert.equal(SS.nowcast.analyzePrecip(s, start - 1), null);
    s.precip[0] = null;
    assert.equal(SS.nowcast.precipAtSeries(s, start), null);
    assert.equal(SS.nowcast.analyzePrecip(s, start), null);
    s.precip[0] = 0;
    assert.equal(SS.nowcast.analyzePrecip(s, start).rainingNow, false);
    s.times.splice(1, 1); s.precip.splice(1, 1);
    assert.equal(SS.nowcast.precipAtSeries(s, start + s.stepMs), null);
    assert.equal(SS.nowcast.analyzePrecip(s, start).coverageEndMs, start + s.stepMs);
    s.times[0] = 'invalid';
    assert.equal(SS.nowcast.analyzePrecip(s, start), null);
  }
});

test('HTTP errors preserve status instead of parsing HTML; successful malformed JSON remains a parse failure', async () => {
  for (const status of [401, 429, 502, 504]) {
    let jsonReads = 0;
    const { SS } = runtime(async () => ({ ok: false, status,
      headers: new Headers({ 'cf-ray': 'a123-HKG' }), json: async () => { jsonReads++; throw new SyntaxError('HTML'); } }));
    await assert.rejects(SS.network.json('/api/qweather'), error => error.name === 'HttpError' && error.status === status && error.requestId === 'a123-HKG');
    assert.equal(jsonReads, 0);
  }
  const { SS } = runtime(async () => new Response('<html>private upstream body</html>'));
  await assert.rejects(SS.network.json('/api/qweather'), error => error.name === 'ParseError' && error.status === 200 && !error.message.includes('private'));
});

test('feedback allowHttpError retains JSON errors and accepts non-JSON error responses', async () => {
  for (const json of [true, false]) {
    const { SS } = runtime(async () => new Response(json ? '{"error":"限频"}' : '<html>502</html>', { status: 429 }));
    const result = await SS.network.request('/api/feedback', { allowHttpError: true });
    assert.equal(result.response.status, 429);
    assert.equal(result.data.error, json ? '限频' : undefined);
  }
});

test('QWeather diagnostics survive fallback, cache and fusion for HTTP, business, parse, timeout and data failures', async () => {
  const cases = [
    { response: () => new Response('edge unavailable', { status: 502, headers: { 'cf-ray': 'abc-HKG' } }), status: 'HTTP_ERROR', http: 502 },
    { response: () => Response.json({ code: '402' }), status: 'BUSINESS_ERROR', http: 200, code: '402' },
    { response: () => new Response('<html>not JSON</html>'), status: 'PARSE_ERROR', http: 200 },
    { response: () => { const e = new Error('transport timeout'); e.name = 'TimeoutError'; throw e; }, status: 'TIMEOUT', http: null },
    { response: () => { throw new TypeError('Failed to fetch'); }, status: 'FAILED', http: null },
    { response: () => Response.json({ code: '200', minutely: [] }), status: 'NO_DATA', http: null },
    { response: () => qwResponse(base - 3 * 3600000), status: 'NO_DATA', http: null },
    { response: () => qwResponse(base, [NaN, ...Array(23).fill(0.2)]), status: 'NO_DATA', http: null }
  ];
  for (const c of cases) {
    const calls = [];
    const { SS, ctx } = runtime(async url => { calls.push(url); return url.startsWith('/api/qweather') ? c.response() : omResponse(); });
    const first = await SS.nowcast.run(ctx());
    assert.equal(first.detail.precip.source, 'openmeteo');
    const state = first.sourcesStatus.qweather;
    assert.equal(state.status, c.status);
    assert.equal(state.available, false);
    assert.equal(state.httpStatus, c.http);
    assert.equal(state.businessCode, c.code || null);
    assert.ok(state.error);
    assert.equal(state.retryAtMs, base + minute);
    const second = await SS.nowcast.run(ctx());
    assert.deepEqual(JSON.parse(JSON.stringify(second.sourcesStatus.qweather)), JSON.parse(JSON.stringify(state)));
    assert.equal(calls.length, 2);
  }
});

test('both-source failure retains the original QWeather cause and retries after negative-cache cooldown', async () => {
  let recovered = false, calls = 0;
  const { SS, clock, ctx } = runtime(async url => {
    calls++;
    if (recovered) return qwResponse();
    return new Response('unavailable', { status: url.startsWith('/api/qweather') ? 502 : 503 });
  });
  let result = await SS.nowcast.run(ctx());
  assert.equal(result.detail.precip, null);
  assert.equal(result.sourcesStatus.qweather.httpStatus, 502);
  assert.equal(result.sourcesStatus.precip.status, 'HTTP_ERROR');
  clock.now += 30000;
  result = await SS.nowcast.run(ctx());
  assert.equal(result.sourcesStatus.qweather.httpStatus, 502);
  assert.equal(calls, 2);
  recovered = true; clock.now = base + minute;
  result = await SS.nowcast.run(ctx());
  assert.equal(result.detail.precip.source, 'qweather');
  assert.equal(result.sourcesStatus.qweather.error, null);
  assert.equal(calls, 3);
});

test('source deadline during fallback retains the already-observed QWeather HTTP error', async () => {
  const { SS, ctx } = runtime(async url => url.startsWith('/api/qweather')
    ? new Response('502', { status: 502 }) : new Promise(() => {}));
  SS.config.network.minutePrecipTimeoutMs = 25;
  const result = await SS.nowcast.run(ctx());
  assert.equal(result.sourcesStatus.precip.status, 'TIMEOUT');
  assert.equal(result.sourcesStatus.qweather.status, 'HTTP_ERROR');
  assert.equal(result.sourcesStatus.qweather.httpStatus, 502);
});

test('a genuine QWeather request deadline falls back with a TIMEOUT diagnostic', async () => {
  const { SS, ctx } = runtime(async url => url.startsWith('/api/qweather') ? new Promise(() => {}) : omResponse());
  SS.config.network.minutePrecipTimeoutMs = 25;
  const result = await SS.nowcast.run(ctx());
  assert.equal(result.detail.precip.source, 'openmeteo');
  assert.equal(result.sourcesStatus.qweather.status, 'TIMEOUT');
  assert.equal(result.sourcesStatus.qweather.errorName, 'TimeoutError');
});

test('fallback cooldown does not slide on hits; recovery reselects QWeather and clears its old error', async () => {
  let recovered = false;
  const calls = [];
  const { SS, clock, ctx } = runtime(async url => {
    calls.push(url);
    return url.startsWith('/api/qweather') ? (recovered ? qwResponse() : new Response('502', { status: 502 })) : omResponse();
  });
  const first = await SS.nowcast.getMinutePrecip(ctx());
  assert.equal(first.analysis.source, 'openmeteo');
  recovered = true;
  for (const seconds of [10, 30, 59]) {
    clock.now = base + seconds * 1000;
    const hit = await SS.nowcast.getMinutePrecip(ctx());
    assert.equal(hit.analysis.source, 'openmeteo');
    assert.equal(hit.refreshAtMs, base + minute);
  }
  assert.equal(calls.length, 2);
  clock.now = base + minute;
  const recovery = await SS.nowcast.getMinutePrecip(ctx());
  assert.equal(recovery.analysis.source, 'qweather');
  assert.equal(recovery.qweather.status, 'OK');
  assert.equal(recovery.qweather.retryAtMs, null);
  assert.equal(recovery.qweather.error, null);
  assert.equal(calls.length, 3);
  assert.equal(recovery.refreshAtMs, clock.now + 10 * minute);
});

test('minute cache reanalyses raw intervals at query time and never extends expired coverage', async () => {
  let calls = 0;
  const { SS, clock, ctx } = runtime(async () => { calls++; return qwResponse(base, [1, 0, 0, ...Array(21).fill(0)]); });
  const first = await SS.nowcast.getMinutePrecip(ctx());
  assert.equal(first.analysis.stopMin, 5);
  clock.now += 2 * minute;
  assert.equal((await SS.nowcast.getMinutePrecip(ctx())).analysis.stopMin, 3);
  clock.now += 3 * minute;
  const stopped = await SS.nowcast.getMinutePrecip(ctx());
  assert.equal(stopped.analysis.rainingNow, false);
  assert.equal(stopped.analysis.stopMin, 0);
  assert.equal(calls, 1);
  const key = SS.cacheKeys.nowcast('precip', ctx().dateStr, ctx().lat, ctx().lon);
  const entry = SS.cache.get(key);
  entry.series = raw('qweather', Array(8).fill(1), clock.now - 39 * minute);
  SS.cache.set(key, entry, 10);
  clock.now += minute;
  await SS.nowcast.getMinutePrecip(ctx());
  assert.equal(calls, 2, 'coverage expiry forces a fetch even before the normal TTL');
});

test('disabled QWeather retains normal Open-Meteo TTL and never probes the disabled source', async () => {
  const calls = [];
  const { SS, clock, ctx } = runtime(async url => { calls.push(url); return omResponse(); });
  SS.config.nowcast.qweather.enabled = false;
  const first = await SS.nowcast.getMinutePrecip(ctx());
  assert.equal(first.qweather.status, 'DISABLED');
  assert.equal(first.refreshAtMs, base + 10 * minute);
  clock.now += 2 * minute;
  await SS.nowcast.getMinutePrecip(ctx());
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].startsWith('/api/qweather'));
});

test('cancelling fallback blocks late writes and does not replace the QWeather failure with an offline result', async () => {
  let started, finish;
  const ready = new Promise(resolve => { started = resolve; });
  const { SS, rt, ctx } = runtime(async url => {
    if (url.startsWith('/api/qweather')) return new Response('502', { status: 502 });
    started();
    return new Promise(resolve => { finish = () => resolve(omResponse()); });
  });
  const controller = new AbortController();
  const pending = SS.nowcast.getMinutePrecip(ctx(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready;
  controller.abort();
  await rejected;
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(rt.storage.size, 0);
});

test('prediction result cache respects fallback retry deadline; prefetch and fusion share one attempt and feedback keeps the cause', async () => {
  let recovered = false;
  const calls = [];
  const { SS, clock } = runtime(async url => {
    calls.push(url);
    return url.startsWith('/api/qweather') ? (recovered ? qwResponse() : new Response('edge 502', { status: 502 })) : omResponse();
  }, SERVICE_FILES);
  const fc = forecast({ cloud: 40, precipitation: 0 });
  fc.timezone = 'Asia/Shanghai'; fc.utc_offset_seconds = 28800;
  SS.data.fetchForecastWithRetry = async () => fc;
  SS.data.fetchAirQuality = async () => null;
  SS.data.gather = async nodes => ({ samples: nodes.map(point => ({ point, forecast: fc })) });
  SS.solar.getSunEvents = () => ({ sunset: new Date(base + 105 * minute), civilDusk: new Date(base + 130 * minute), sunsetAzimuthDeg: 282, twilightMinutes: 25 });
  const predict = () => SS.prediction.predict('22.54,114.06', { nowUtcMs: clock.now });
  const first = await predict();
  assert.equal(first.nowcast.detail.precip.source, 'openmeteo');
  assert.equal(first.minute_refresh_at_ms, base + minute);
  assert.equal(calls.length, 2, 'one QWeather + one fallback request, not a duplicate event request');
  const snapshot = JSON.parse(SS.feedbackService.buildPayload(first, { rating: 'poor' }).raw_snapshot_json);
  assert.equal(snapshot.sky_evolution.sources_status.qweather.httpStatus, 502);
  recovered = true; clock.now = base + 59000;
  const cached = await predict();
  assert.equal(cached.query_id, first.query_id);
  assert.equal(calls.length, 2);
  clock.now = base + minute;
  const fresh = await predict();
  assert.notEqual(fresh.query_id, first.query_id);
  assert.equal(fresh.nowcast.detail.precip.source, 'qweather');
  assert.equal(fresh.nowcast.sourcesStatus.qweather.status, 'OK');
  assert.equal(fresh.nowcast.sourcesStatus.qweather.error, null);
  assert.equal(calls.length, 3);
});
