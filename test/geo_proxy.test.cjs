const test = require('node:test');
const assert = require('node:assert/strict');
const row = { id: '101180401', name: '许昌', type: 'city', lat: '34.03', lon: '113.85',
  country: '中国', adm1: '河南省', adm2: '许昌', tz: 'Asia/Shanghai', rank: '40' };
const env = { QWEATHER_API_KEY: 'test-secret-only', QWEATHER_HOST: 'weather.qweatherapi.com' };
const request = (q = '许昌', options) => new Request('https://example.test/api/geocoding?q=' + encodeURIComponent(q), options);
async function setup(t) {
  const { handleGeo, geoLocation, geoQuery } = await import('../server/qweather-geo.js');
  const logs = [];
  t.mock.method(console, 'error', value => logs.push(value));
  return { handleGeo, geoLocation, geoQuery, logs };
}

test('GeoAPI uses fixed mainland endpoint/key header and emits bounded canonical locations only', async t => {
  const { handleGeo, logs } = await setup(t);
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://weather.qweatherapi.com');
    assert.equal(url.pathname, '/geo/v2/city/lookup');
    assert.equal(url.searchParams.get('location'), '许昌');
    assert.equal(url.searchParams.get('adm'), '河南');
    assert.equal(url.searchParams.get('range'), 'cn');
    assert.equal(url.searchParams.get('number'), '20');
    assert.equal(url.searchParams.get('lang'), 'zh');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['X-QW-Api-Key'], env.QWEATHER_API_KEY);
    assert.ok(!url.href.includes(env.QWEATHER_API_KEY));
    return Response.json({ code: '200', location: [{ ...row, fxLink: 'https://private.test', unsafe: env.QWEATHER_API_KEY }] });
  });
  const response = await handleGeo(request('许昌，河南'), env);
  assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal(logs.length, 0);
  assert.match(response.headers.get('cache-control'), /s-maxage=3600/);
  const data = await response.json();
  assert.equal(data.results[0].id, 'qweather:101180401');
  assert.equal(data.results[0].coordinate_system, 'WGS84');
  assert.notEqual(data.results[0].longitude, Number(row.lon));
  assert.ok(!JSON.stringify(data).includes(env.QWEATHER_API_KEY));
  assert.ok(!JSON.stringify(data).includes('private.test'));
});

test('GeoAPI validates city query, configuration and destination before issuing fetch', async t => {
  const { handleGeo } = await setup(t);
  t.mock.method(global, 'fetch', () => { throw new Error('must not fetch'); });
  for (const q of ['', '许', 'a'.repeat(61), 'https://evil.test', '22.54,114.06', '许昌,河南,中国', 'xx\n?key=test']) {
    assert.equal((await handleGeo(request(q), env)).status, 400, q);
  }
  for (const host of ['evil.test', 'qweatherapi.com.evil.test', 'user:pass@weather.qweatherapi.com', 'weather.qweatherapi.com/x', 'https://weather.qweatherapi.com']) {
    assert.equal((await handleGeo(request(), { ...env, QWEATHER_HOST: host })).status, 503);
  }
  assert.equal((await handleGeo(request(), {})).status, 503);
  assert.equal((await handleGeo(request('许昌', { method: 'POST' }), env)).status, 405);
});

test('GeoAPI drops POIs, malformed coordinates, unsupported regions and invalid timezone', async t => {
  const { geoLocation } = await setup(t);
  for (const lat of ['', ' ', null, undefined, NaN, 'not-a-number', 91]) assert.equal(geoLocation({ ...row, lat }), null);
  for (const change of [{ type: 'scenic' }, { country: '美国' }, { adm1: '台湾省' }, { adm1: '香港特别行政区' },
    { tz: 'UTC+8' }, { id: '<script>' }, { name: '' }]) assert.equal(geoLocation({ ...row, ...change }), null);
  assert.ok(geoLocation({ ...row, lat: 0, lon: 0 }), 'legitimate zero coordinates are not missing');
});

test('coordinate conversion is bounded and numerically matches a fixed WGS84/GCJ02 reference pair', async () => {
  const { gcj02ToWgs84 } = await import('../server/geo-coordinates.js');
  const p = gcj02ToWgs84(39.91640428150164, 116.41024449916938);
  assert.ok(Math.abs(p.latitude - 39.915) < 0.000001);
  assert.ok(Math.abs(p.longitude - 116.404) < 0.000001);
  assert.deepEqual(gcj02ToWgs84(51.5, -0.1), { latitude: 51.5, longitude: -0.1 });
  assert.equal(gcj02ToWgs84(null, 113), null);
});

test('GeoAPI never follows redirects and logs no secrets, query, raw error or upstream body', async t => {
  const { handleGeo, logs } = await setup(t);
  for (const status of [300, 301, 302, 303, 304, 307, 308, 401, 403, 429, 503]) {
    let calls = 0;
    t.mock.method(global, 'fetch', async () => { calls++; return new Response(status === 304 ? null : env.QWEATHER_API_KEY,
      { status, headers: { Location: 'https://evil.test/' + env.QWEATHER_API_KEY } }); });
    const response = await handleGeo(request(), env);
    assert.equal(response.status, status < 400 ? 502 : status); assert.equal(calls, 1);
    assert.equal(response.headers.get('location'), null); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).upstreamStatus, status);
  }
  t.mock.method(global, 'fetch', async () => { throw new TypeError('secret ' + env.QWEATHER_API_KEY); });
  assert.equal((await handleGeo(request(), env)).status, 502);
  assert.equal(logs.length, 12);
  for (const log of logs) {
    assert.equal(log.adapter, 'geocoding');
    assert.ok(!JSON.stringify(log).includes(env.QWEATHER_API_KEY));
    assert.ok(!JSON.stringify(log).includes('许昌'));
  }
});

test('GeoAPI distinguishes legacy/modern no-match, business error, invalid JSON and oversized body', async t => {
  const { handleGeo } = await setup(t);
  for (const payload of [{ code: '404' }, { error: { title: 'NO SUCH LOCATION' } }, { error: { title: 'No Such Location' } }]) {
    t.mock.method(global, 'fetch', async () => Response.json(payload, { status: payload.error ? 400 : 200 }));
    const response = await handleGeo(request(), env);
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).results, []);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  t.mock.method(global, 'fetch', async () => Response.json({ code: '402' }));
  let response = await handleGeo(request(), env);
  assert.equal(response.status, 502); assert.equal((await response.json()).businessCode, '402');
  for (const responseFactory of [() => new Response('<html>bad gateway</html>'),
    () => Response.json({ code: '200', location: 'invalid' }), () => new Response('x'.repeat(131073))]) {
    t.mock.method(global, 'fetch', responseFactory);
    response = await handleGeo(request(), env);
    assert.equal(response.status, 502); assert.equal((await response.json()).errorCode, 'INVALID_PAYLOAD');
  }
});

test('GeoAPI deadline covers stalled response body and cancellation releases the fetch', async t => {
  const { handleGeo } = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(global, 'fetch', async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
  } })));
  const pending = handleGeo(request(), env);
  await Promise.resolve();
  t.mock.timers.tick(8001);
  const response = await pending;
  assert.equal(response.status, 504); assert.equal((await response.json()).errorCode, 'UPSTREAM_TIMEOUT');
  const controller = new AbortController();
  const cancelled = handleGeo(request('许昌', { signal: controller.signal }), env);
  await Promise.resolve(); controller.abort();
  assert.equal((await (await cancelled).json()).errorCode, 'UPSTREAM_ABORTED');
});
