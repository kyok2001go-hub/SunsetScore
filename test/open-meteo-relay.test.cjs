const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');
// V2.5.5.20 Open-Meteo: direct first, then the /api/open-meteo relay. PRD: ref_docs/PRD/V2.5.5.20--Open-Meteo请求超时修复方案.md

const relay = () => import('../server/open-meteo-proxy.js');
const FORECAST_QUERY = 'latitude=31.2300,31.6800&longitude=121.4700,121.0200&hourly=cloud_cover,cloud_cover_mid&forecast_days=2&timezone=auto';
const req = (query, init) => new Request('https://sunset.example/api/open-meteo?' + query, { headers: { 'cf-ray': '0123456789abcdef-HKG' }, ...init });
function memoryCache() {
  const store = new Map();
  return { store, async match(key) { const hit = store.get(key.url); return hit ? hit.clone() : undefined; }, async put(key, response) { store.set(key.url, response.clone()); } };
}
async function quietly(fn) {
  const log = console.log, error = console.error, records = [];
  console.log = r => records.push(['log', r]); console.error = r => records.push(['error', r]);
  try { return { value: await fn(), records }; } finally { console.log = log; console.error = error; }
}

test('relay target: only three fixed upstreams and the parameters the app sends; canonical, order-independent', async () => {
  const { openMeteoTarget, OPEN_METEO_SERVICES } = await relay();
  assert.deepEqual(Object.keys(OPEN_METEO_SERVICES), ['forecast', 'air-quality', 'geocoding']);
  const a = openMeteoTarget(new URL('https://x/api/open-meteo?service=forecast&' + FORECAST_QUERY));
  const b = openMeteoTarget(new URL('https://x/api/open-meteo?timezone=auto&forecast_days=2&hourly=cloud_cover,cloud_cover_mid&longitude=121.4700,121.0200&latitude=31.2300,31.6800&service=forecast'));
  assert.equal(a.upstream.toString(), b.upstream.toString());
  assert.equal(a.upstream.origin + a.upstream.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.deepEqual([...a.upstream.searchParams.keys()], ['forecast_days', 'hourly', 'latitude', 'longitude', 'timezone']);
  assert.equal(a.ttlSeconds, 600);
  assert.equal(openMeteoTarget(new URL('https://x/?service=air-quality&latitude=31.2&longitude=121.4&hourly=aerosol_optical_depth,pm2_5&forecast_days=2&timezone=auto')).upstream.hostname, 'air-quality-api.open-meteo.com');
  assert.equal(openMeteoTarget(new URL('https://x/?service=forecast&latitude=31.2&longitude=121.4&minutely_15=precipitation&forecast_minutely_15=120&timezone=auto')).service, 'forecast');
  const geo = openMeteoTarget(new URL('https://x/?service=geocoding&name=' + encodeURIComponent('Tokyo') + '&count=50&language=en&format=json'));
  assert.equal(geo.upstream.hostname, 'geocoding-api.open-meteo.com'); assert.equal(geo.ttlSeconds, 86400);
  const forty = Array.from({ length: 40 }, () => '31.2').join(','), fortyOne = forty + ',31.2';
  assert.ok(openMeteoTarget(new URL(`https://x/?service=forecast&latitude=${forty}&longitude=${forty}`)));
  for (const query of [
    'service=forecast', 'service=other&latitude=1&longitude=1', 'latitude=1&longitude=1',
    'service=forecast&service=forecast&latitude=1&longitude=1', 'service=forecast&latitude=1&longitude=1&url=https://evil.example',
    'service=forecast&latitude=1&latitude=2&longitude=1', 'service=forecast&latitude=1,2&longitude=1',
    `service=forecast&latitude=${fortyOne}&longitude=${fortyOne}`, 'service=forecast&latitude=91&longitude=1', 'service=forecast&latitude=1&longitude=181',
    'service=forecast&latitude=1&longitude=1&hourly=cloud_cover;drop', 'service=forecast&latitude=1&longitude=1&forecast_days=17',
    'service=forecast&latitude=1&longitude=1&timezone=../../etc', 'service=geocoding&count=5', 'service=geocoding&name=a&format=xml',
    'service=air-quality&latitude=1&longitude=1&minutely_15=precipitation'
  ]) assert.equal(openMeteoTarget(new URL('https://x/api/open-meteo?' + query)), null, query);
});

test('relay: 200 is forwarded and cached under an order-independent key; the second call is served from the edge cache', async () => {
  const { handleOpenMeteo } = await relay(), cache = memoryCache(), calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return Response.json([{ hourly: { time: [] } }, { hourly: { time: [] } }]); };
  const first = await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), { cache, fetchImpl }));
  assert.equal(first.value.status, 200);
  assert.equal((await first.value.json()).length, 2);
  assert.equal(first.value.headers.get('Cache-Control'), 'public, max-age=300, s-maxage=600');
  assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'manual');
  assert.match(calls[0].init.headers['User-Agent'], /^SunsetScore-Relay\/2\.5\.5\.20/);
  assert.equal(new URL(calls[0].url).hostname, 'api.open-meteo.com');
  const reordered = 'timezone=auto&service=forecast&forecast_days=2&hourly=cloud_cover,cloud_cover_mid&longitude=121.4700,121.0200&latitude=31.2300,31.6800';
  const second = await quietly(() => handleOpenMeteo(req(reordered), { cache, fetchImpl }));
  assert.equal(second.value.status, 200); assert.equal((await second.value.json()).length, 2);
  assert.equal(calls.length, 1, 'served from the edge cache');
  const usage = [...first.records, ...second.records].filter(([kind]) => kind === 'log').map(([, r]) => r);
  assert.deepEqual(usage.map(r => r.cacheStatus), ['MISS', 'HIT']);
  for (const r of usage) {
    assert.deepEqual(Object.keys(r).sort(), ['adapter', 'appVersion', 'cacheStatus', 'cfRay', 'elapsedMs', 'event', 'logSchema', 'responseStatus', 'service', 'upstreamStatus']);
    assert.equal(r.event, 'edge_proxy_use'); assert.equal(r.service, 'forecast'); assert.equal(r.cfRay, '0123456789abcdef-HKG');
    assert.ok(!/31\.23|121\.47|open-meteo\.com|latitude/.test(JSON.stringify(r)), 'no query values or URLs in logs');
  }
  // A cache that throws never breaks the relay.
  const broken = { async match() { throw new Error('cache down'); }, async put() { throw new Error('cache down'); } };
  assert.equal((await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), { cache: broken, fetchImpl }))).value.status, 200);
});

test('relay: rejects 3xx without Location, keeps 4xx/5xx, maps timeouts to 504 and invalid JSON to 502, refuses non-GET and bad queries', async () => {
  const { handleOpenMeteo } = await relay();
  for (const status of [301, 302, 307, 308]) {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('private')); }, cancel() { cancelled = true; } });
    const { value } = await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), {
      fetchImpl: async () => new Response(body, { status, headers: { Location: 'https://outside.example/private-destination' } }) }));
    assert.equal(value.status, 502); assert.equal(value.headers.has('Location'), false); assert.equal(value.headers.get('Cache-Control'), 'no-store');
    const data = await value.json();
    assert.equal(data.upstreamStatus, status); assert.ok(!JSON.stringify(data).includes('private-destination')); assert.equal(cancelled, true);
  }
  for (const status of [400, 429, 500, 503]) {
    const cache = memoryCache();
    const { value } = await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), { cache,
      fetchImpl: async () => Response.json({ error: true, reason: 'upstream says ' + status }, { status }) }));
    assert.equal(value.status, status); assert.equal(value.headers.get('Cache-Control'), 'no-store');
    assert.equal((await value.json()).reason, 'upstream says ' + status); assert.equal(cache.store.size, 0, 'errors are never cached');
  }
  const hang = await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), { deadlineMs: 20,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) }));
  assert.equal(hang.value.status, 504); assert.equal((await hang.value.json()).errorCode, 'UPSTREAM_TIMEOUT');
  assert.equal(hang.records.find(([k]) => k === 'error')[1].errorCode, 'UPSTREAM_TIMEOUT');
  const slowBody = await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), { deadlineMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }));
  assert.equal(slowBody.value.status, 504, 'the deadline also covers the body read');
  const offline = await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), { fetchImpl: async () => { throw new TypeError('network'); } }));
  assert.equal(offline.value.status, 502);
  const html = await quietly(() => handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY), { fetchImpl: async () => new Response('<html>portal</html>') }));
  assert.equal(html.value.status, 502); assert.equal(html.records.find(([k]) => k === 'error')[1].errorCode, 'INVALID_PAYLOAD');
  let fetched = false;
  const post = await handleOpenMeteo(req('service=forecast&' + FORECAST_QUERY, { method: 'POST' }), { fetchImpl: async () => { fetched = true; } });
  assert.equal(post.status, 405);
  const bad = await quietly(() => handleOpenMeteo(req('service=forecast&latitude=1&longitude=1&url=https://evil.example'), { fetchImpl: async () => { fetched = true; } }));
  assert.equal(bad.value.status, 400); assert.equal(fetched, false);
});

// ---------- browser transport ----------
const FILES = ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/data.js'];
function browser(handler, clock = { now: Date.parse('2026-11-17T08:00:00Z') }) {
  const urls = [];
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const SS = load(createRuntime({ Date: FakeDate, fetch: async (url, init) => { urls.push({ url: String(url), init }); return handler(String(url), init, urls.length); } }), FILES);
  return { SS, urls, clock };
}
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
const isRelay = u => u.startsWith('/api/open-meteo?');

test('transport: direct success never touches the relay; timeout, network error, non-JSON and 5xx fall back once with the relay timeout', async () => {
  const direct = browser(() => ok({ v: 1 })), seen = [];
  assert.deepEqual(await direct.SS.data.fetchForecast(31.23, 121.47, { onTransport: k => seen.push(k) }), { v: 1 });
  assert.deepEqual(seen, ['DIRECT']); assert.equal(direct.urls.length, 1); assert.equal(isRelay(direct.urls[0].url), false);
  const failures = {
    timeout: (url, init) => isRelay(url) ? ok({ via: 'relay' }) : hang(url, init),
    network: url => { if (isRelay(url)) return ok({ via: 'relay' }); throw new TypeError('Failed to fetch'); },
    portal: url => isRelay(url) ? ok({ via: 'relay' }) : new Response('<html>', { status: 200 }),
    http503: url => isRelay(url) ? ok({ via: 'relay' }) : new Response('busy', { status: 503 })
  };
  for (const [name, handler] of Object.entries(failures)) {
    const b = browser(handler), kinds = [];
    const value = await b.SS.data.fetchForecast(31.23, 121.47, { timeoutMs: 20, onTransport: k => kinds.push(k) });
    assert.deepEqual(value, { via: 'relay' }, name); assert.deepEqual(kinds, ['PROXY'], name);
    assert.equal(b.urls.length, 2, name);
    assert.equal(b.urls[1].url, '/api/open-meteo?service=forecast&' + new URL(b.urls[0].url).search.slice(1), name);
  }
  // The relay gets its own 12 s budget, not the 20 ms direct budget.
  const slowRelay = browser((url, init) => isRelay(url) ? new Promise(r => setTimeout(() => r(ok({ late: true })), 60)) : hang(url, init));
  assert.deepEqual(await slowRelay.SS.data.fetchForecast(1, 2, { timeoutMs: 20 }), { late: true });
  assert.equal(slowRelay.SS.transport.openMeteo.proxyTimeoutMs, 12000);
});

test('transport: 4xx and caller cancellation do not fall back; a failed relay surfaces its own error', async () => {
  const bad = browser(() => new Response('{"error":true}', { status: 400 }));
  await assert.rejects(bad.SS.data.fetchForecast(1, 2), { name: 'HttpError', status: 400 }); assert.equal(bad.urls.length, 1);
  const limited = browser(() => new Response('{}', { status: 429 }));
  await assert.rejects(limited.SS.data.fetchForecast(1, 2), { status: 429 }); assert.equal(limited.urls.length, 1);
  const controller = new AbortController(), cancelled = browser((url, init) => hang(url, init));
  const pending = cancelled.SS.data.fetchForecast(1, 2, { signal: controller.signal });
  await Promise.resolve(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled.urls.length, 1);
  const both = browser(url => isRelay(url) ? new Response('{}', { status: 502 }) : new Response('{}', { status: 503 }));
  await assert.rejects(both.SS.data.fetchForecast(1, 2), { name: 'HttpError', status: 502 }); assert.equal(both.urls.length, 2);
  // Only Open-Meteo hosts use the relay; this site's own APIs are requested as before.
  const own = browser(() => new Response('{}', { status: 503 }));
  await assert.rejects(own.SS.data.searchDomesticLocations('上海'), { status: 503 }); assert.equal(own.urls.length, 1);
  assert.equal(own.SS.network.openMeteoRoute('https://evil.example/v1/forecast?x=1'), null);
  assert.equal(own.SS.network.openMeteoRoute('http://api.open-meteo.com/v1/forecast'), null, 'plain HTTP is not routed');
});

test('transport: after a direct failure the host goes straight to the relay for 10 minutes, per host, then direct again', async () => {
  let directDown = true;
  const b = browser((url, init) => isRelay(url) ? ok({ via: 'relay' }) : directDown ? hang(url, init) : ok({ via: 'direct' }));
  await b.SS.data.fetchForecast(1, 2, { timeoutMs: 20 });
  assert.equal(b.urls.length, 2);
  directDown = false;
  b.clock.now += 9 * 60000;
  assert.deepEqual(await b.SS.data.fetchForecast(1, 2), { via: 'relay' }); assert.equal(b.urls.length, 3); assert.equal(isRelay(b.urls[2].url), true);
  assert.deepEqual(await b.SS.data.fetchAirQuality(1, 2), { via: 'direct' }, 'another host is not affected');
  b.clock.now += 61000;
  assert.deepEqual(await b.SS.data.fetchForecast(1, 2), { via: 'direct' }, 'memory expires after 10 minutes');
  b.SS.network.resetOpenMeteoRoutes();
});

test('transport: batch retry is direct first and relay second; with the memory active both attempts use the relay', async () => {
  const nodes = [{ latitude: 31.2, longitude: 121.4 }, { latitude: 31.7, longitude: 121.0 }];
  const b = browser(url => isRelay(url) ? ok([{ n: 1 }, { n: 2 }]) : new Response('busy', { status: 503 }));
  b.SS.network.sleep = async () => {};
  const attempts = [], kinds = [];
  const result = await b.SS.data.fetchBatchForecastWithRetry(nodes, { onBatchAttempt: a => attempts.push(a), onTransport: k => kinds.push(k) });
  assert.deepEqual(result.map(r => r.n), [1, 2]); assert.deepEqual(attempts, [1, 2]); assert.deepEqual(kinds, ['PROXY']);
  assert.deepEqual(b.urls.map(u => isRelay(u.url)), [false, true]);
  const again = await b.SS.data.fetchBatchForecastWithRetry(nodes, {});
  assert.equal(again.length, 2); assert.equal(isRelay(b.urls[2].url), true, 'memory active: the first attempt already uses the relay');
});

test('prediction records which path each Open-Meteo source used, outside Snapshot and Replay', async () => {
  const { CORE_FILES, forecast } = require('./helpers.cjs');
  const files = [...CORE_FILES, 'js/vendor/suncalc.js', 'js/solar.js', 'js/cache.js', 'js/city_search.js', 'js/sampling.js', 'js/corridor.js', 'js/nowcast.js',
    'js/replay_service.js', 'js/prediction_service.js'];
  const fc = forecast(), SS = load(createRuntime({ fetch: async (url) => {
    if (String(url).startsWith('/api/open-meteo?service=forecast')) {
      const lat = new URL(url, 'https://x').searchParams.get('latitude');
      return ok(lat.includes(',') ? lat.split(',').map(() => fc) : fc);
    }
    if (String(url).startsWith('/api/open-meteo?service=air-quality')) return ok({ hourly: { time: [], aerosol_optical_depth: [], pm2_5: [] } });
    throw new TypeError('Failed to fetch');
  } }), files);
  SS.solar.getSunEvents = () => ({ sunset: new Date('2026-08-26T18:30:00Z'), civilDusk: new Date('2026-08-26T19:05:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 35 });
  SS.nowcast.run = async () => null;
  const location = { name: 'Fixture', country: 'Test', latitude: 31.23, longitude: 121.47, timezone: 'UTC', feature_code: 'PPLA', id: 1 };
  const result = await SS.prediction.predict('31.23,121.47', { location, nowUtcMs: Date.parse('2026-08-26T17:00:00Z') });
  assert.deepEqual(JSON.parse(JSON.stringify(result.performance_timing.open_meteo_transport)), { local: 'PROXY', spatial: 'PROXY', air_quality: 'PROXY' });
  assert.equal(JSON.stringify(result.replay_payload ?? {}).includes('open_meteo_transport'), false);
});
