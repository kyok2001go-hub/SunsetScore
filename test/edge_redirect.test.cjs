const test = require('node:test');
const assert = require('node:assert/strict');

const proxyTarget = 'https://tilecache.rainviewer.com/test.png';
const secret = 'test-secret-only';

async function adapter(kind, target = proxyTarget) {
  const { onRequestGet } = await import(`../functions/api/${kind}.js`);
  const url = kind === 'qweather'
    ? 'https://example.test/api/qweather?lat=22.54&lon=114.06'
    : 'https://example.test/api/proxy?url=' + encodeURIComponent(target);
  return onRequestGet({
    request: new Request(url),
    env: { QWEATHER_API_KEY: secret, QWEATHER_HOST: 'weather.qweatherapi.com' }
  });
}

// Model the restriction reported by the deployed Pages runtime, not Node fetch.
function edgeFetch(respond, calls) {
  return async (url, init) => {
    if (!['follow', 'manual'].includes(init.redirect)) {
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    }
    calls.push({ url: String(url), init });
    return respond();
  };
}

test('Pages adapters succeed when the edge rejects redirect:error', async t => {
  for (const kind of ['qweather', 'proxy']) {
    const calls = [];
    const upstream = Response.json({ code: '200' });
    const nativeBody = upstream.body;
    t.mock.method(global, 'fetch', edgeFetch(() => upstream, calls));
    const response = await adapter(kind);
    assert.equal(response.status, 200);
    assert.equal(response.body, nativeBody);
    assert.deepEqual(await response.json(), { code: '200' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get('X-QW-Api-Key'), kind === 'qweather' ? secret : null);
    assert.ok(!calls[0].url.includes(secret));
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(response.headers.get('Cache-Control'), /public/);
  }
});

test('both Pages adapters reject 3xx without following or exposing the destination', async t => {
  for (const kind of ['qweather', 'proxy']) {
    for (const status of [300, 301, 302, 303, 304, 307, 308]) {
      const calls = [];
      let cancelled = false;
      const upstream = new Response(status === 304 ? null : new ReadableStream({
        cancel() { cancelled = true; }
      }), { status, headers: { Location: 'https://outside.test/private-destination' } });
      t.mock.method(global, 'fetch', edgeFetch(() => upstream, calls));
      const response = await adapter(kind);
      assert.equal(response.status, 502, `${kind}: ${status}`);
      assert.equal(calls.length, 1, 'must not follow the redirect');
      assert.equal(calls[0].init.redirect, 'manual');
      assert.equal(cancelled, status !== 304, 'release any rejected upstream body');
      assert.equal(response.headers.get('Location'), null);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
      const payload = await response.json();
      assert.match(payload.error, /3xx/);
      assert.equal(payload.upstreamStatus, status);
      assert.ok(!JSON.stringify(payload).includes(secret));
      assert.ok(!JSON.stringify(payload).includes('private-destination'));
    }
  }
});

test('normal upstream HTTP failures keep their original status after redirect handling', async t => {
  for (const kind of ['qweather', 'proxy']) {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const calls = [];
      t.mock.method(global, 'fetch', edgeFetch(() => new Response('unavailable', { status }), calls));
      const response = await adapter(kind);
      assert.equal(response.status, status);
      assert.equal(calls.length, 1);
      assert.ok(!(await response.text()).includes(secret));
    }
  }
});

test('the generic proxy accepts supported weather hosts without adding a QWeather key', async t => {
  for (const target of [
    proxyTarget,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi',
    'https://api.open-meteo.com/v1/forecast',
    'https://weather.qweatherapi.com/v7/minutely/5m'
  ]) {
    const calls = [];
    t.mock.method(global, 'fetch', edgeFetch(() => Response.json({ ok: true }), calls));
    const response = await adapter('proxy', target);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, target);
    assert.equal(new Headers(calls[0].init.headers).get('X-QW-Api-Key'), null);
    await response.body.cancel();
  }
});
