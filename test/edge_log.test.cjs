const test = require('node:test');
const assert = require('node:assert/strict');

const FAKE_SECRET = 'fixture-secret-not-a-real-key';
const RAY = '0123456789abcdef-HKG';

function context(kind, target = 'https://tilecache.rainviewer.com/private-path?token=' + FAKE_SECRET, ray = RAY) {
  return {
    request: new Request(kind === 'qweather'
      ? 'https://site.test/api/qweather?lat=22.54&lon=114.06&private=' + FAKE_SECRET
      : 'https://site.test/api/proxy?url=' + encodeURIComponent(target), {
      headers: { 'cf-ray': ray, authorization: 'Bearer ' + FAKE_SECRET, cookie: FAKE_SECRET }
    }),
    env: { QWEATHER_API_KEY: FAKE_SECRET, QWEATHER_HOST: 'fixture.qweatherapi.com' }
  };
}

async function adapters() {
  return {
    qweather: (await import('../functions/api/qweather.js')).onRequestGet,
    proxy: (await import('../functions/api/proxy.js')).onRequestGet
  };
}

function capture(t) {
  const records = [];
  t.mock.method(console, 'error', (...args) => {
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], 'object', 'emit a structured object, not free-form text');
    records.push(args[0]);
  });
  return records;
}

function checkRecord(record, expected) {
  assert.deepEqual(Object.keys(record).sort(), ['event', 'logSchema', 'appVersion', 'adapter', 'source',
    'stage', 'errorCode', 'errorName', 'upstreamStatus', 'responseStatus', 'elapsedMs', 'cfRay'].sort());
  assert.equal(record.event, 'edge_proxy_error');
  assert.equal(record.logSchema, 1);
  assert.equal(record.appVersion, '2.3.3');
  assert.ok(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0);
  for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, key);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(FAKE_SECRET + '|private-path|site\\.test|22\\.54|114\\.06|Bearer|authorization|cookie|stack|cause'));
}

test('edge logs classify fetch errors without serializing messages, stacks, causes or custom error names', async (t) => {
  const handlers = await adapters();
  const records = capture(t);
  for (const [kind, handler] of Object.entries(handlers)) {
    for (const [name, errorCode, status] of [['TypeError', 'UPSTREAM_FETCH_ERROR', 502],
      ['TimeoutError', 'UPSTREAM_TIMEOUT', 504], ['AbortError', 'UPSTREAM_ABORTED', 502],
      [FAKE_SECRET, 'UPSTREAM_FETCH_ERROR', 502]]) {
      const error = new Error('upstream https://private.test?key=' + FAKE_SECRET, { cause: { key: FAKE_SECRET } });
      error.name = name;
      error.toJSON = () => { throw new Error('must not serialize raw error'); };
      t.mock.method(global, 'fetch', async () => { throw error; });
      const before = records.length;
      const response = await handler(context(kind));
      assert.equal(response.status, status);
      assert.equal(records.length, before + 1);
      checkRecord(records.at(-1), { adapter: kind, source: kind === 'proxy' ? 'rainviewer' : 'qweather',
        stage: 'fetch', errorCode, errorName: name === FAKE_SECRET ? 'unknown' : name,
        upstreamStatus: null, responseStatus: status, cfRay: RAY });
    }
  }
});

test('edge logs distinguish rejected redirects from upstream HTTP errors without reading bodies', async (t) => {
  const handlers = await adapters();
  const records = capture(t);
  for (const [kind, handler] of Object.entries(handlers)) {
    for (const status of [301, 304, 307, 401, 403, 429, 503]) {
      const upstream = new Response(status === 304 ? null : FAKE_SECRET, {
        status, headers: { Location: 'https://private.test?key=' + FAKE_SECRET }
      });
      t.mock.method(global, 'fetch', async () => upstream);
      const response = await handler(context(kind));
      const redirect = status < 400;
      assert.equal(response.status, redirect ? 502 : status);
      assert.equal(response.headers.get('Location'), null);
      if (kind === 'proxy' && !redirect) {
        assert.equal(response.body, upstream.body, 'preserve native non-OK body forwarding');
        assert.equal(upstream.bodyUsed, false);
      }
      checkRecord(records.at(-1), { adapter: kind, upstreamStatus: status,
        responseStatus: redirect ? 502 : status, stage: 'upstream_response', errorName: null,
        errorCode: redirect ? 'UPSTREAM_REDIRECT' : 'UPSTREAM_HTTP_ERROR' });
    }
  }
  assert.equal(records.length, 14);
});

test('edge logs cover existing configuration and validation rejections without logging submitted values', async (t) => {
  const handlers = await adapters();
  const records = capture(t);
  t.mock.method(global, 'fetch', () => assert.fail('invalid request must not fetch'));
  const missingKey = context('qweather');
  missingKey.env = {};
  const invalidCoordinates = context('qweather');
  invalidCoordinates.request = new Request('https://site.test/api/qweather?lat=' + FAKE_SECRET + '&lon=999');
  const missingTarget = context('proxy');
  missingTarget.request = new Request('https://site.test/api/proxy');
  const cases = [
    ['qweather', missingKey, 503, 'NOT_CONFIGURED', 'configuration'],
    ['qweather', invalidCoordinates, 400, 'INVALID_COORDINATES', 'validation'],
    ['proxy', missingTarget, 400, 'MISSING_TARGET', 'validation'],
    ['proxy', context('proxy', FAKE_SECRET), 400, 'INVALID_TARGET', 'validation'],
    ['proxy', context('proxy', 'https://' + FAKE_SECRET + '.test/path'), 403, 'FORBIDDEN_TARGET', 'validation']
  ];
  for (const [kind, input, status, errorCode, stage] of cases) {
    assert.equal((await handlers[kind](input)).status, status);
    checkRecord(records.at(-1), { adapter: kind, errorCode, stage, responseStatus: status, upstreamStatus: null });
  }
  assert.equal(records.length, cases.length);
});

test('proxy logs use fixed provider categories instead of URLs or dedicated hostnames', async (t) => {
  const { proxy } = await adapters();
  const records = capture(t);
  for (const [host, source] of [['tilecache.rainviewer.com', 'rainviewer'], ['gibs.earthdata.nasa.gov', 'gibs'],
    ['customer.qweatherapi.com', 'qweather'], ['api.open-meteo.com', 'openmeteo']]) {
    t.mock.method(global, 'fetch', async () => new Response(FAKE_SECRET, { status: 429 }));
    await proxy(context('proxy', 'https://' + host + '/private-path?key=' + FAKE_SECRET));
    checkRecord(records.at(-1), { source, errorCode: 'UPSTREAM_HTTP_ERROR' });
    assert.ok(!JSON.stringify(records.at(-1)).includes(host));
  }
});

test('successful native streams and HTTP-200 business error bodies are not inspected or logged', async (t) => {
  const handlers = await adapters();
  const records = capture(t);
  for (const [kind, handler] of Object.entries(handlers)) {
    for (const body of ['{"code":"200","minutely":[]}', '{"code":"403"}', new Uint8Array([137, 0, 255])]) {
      const upstream = new Response(body);
      t.mock.method(global, 'fetch', async () => upstream);
      const response = await handler(context(kind));
      assert.equal(response.status, 200);
      assert.equal(response.body, upstream.body);
      assert.equal(upstream.bodyUsed, false);
    }
  }
  assert.deepEqual(records, []);
});

test('body cancellation exceptions keep the known upstream status and have their own stage', async (t) => {
  const handlers = await adapters();
  const records = capture(t);
  for (const [kind, handler] of Object.entries(handlers)) {
    t.mock.method(global, 'fetch', async () => new Response(new ReadableStream({
      cancel() { throw new Error(FAKE_SECRET); }
    }), { status: 302 }));
    assert.equal((await handler(context(kind))).status, 502);
    checkRecord(records.at(-1), { stage: 'body_cancel', errorCode: 'RESPONSE_ERROR',
      errorName: 'Error', upstreamStatus: 302, responseStatus: 502 });
  }
  assert.equal(records.length, 2);
});

test('structured logger allowlists fields and Ray IDs, reports bounded elapsed time, and emits once per request', async (t) => {
  const { createEdgeErrorLogger } = await import('../server/edge-log.js');
  const records = capture(t);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  for (const [ray, expectedRay] of [[RAY, RAY], ['0123456789abcdef', '0123456789abcdef'], [FAKE_SECRET, null], ['', null]]) {
    now = 1000;
    const logger = createEdgeErrorLogger(context('proxy', undefined, ray).request, 'proxy');
    now = 1025;
    const details = { source: FAKE_SECRET, stage: FAKE_SECRET, errorCode: FAKE_SECRET,
      responseStatus: '502', upstreamStatus: Infinity, error: { name: FAKE_SECRET }, message: FAKE_SECRET, key: FAKE_SECRET };
    logger(details);
    logger(details);
    checkRecord(records.at(-1), { source: 'unknown', stage: 'unknown', errorCode: 'unknown', errorName: 'unknown',
      responseStatus: null, upstreamStatus: null, cfRay: expectedRay, elapsedMs: 25 });
  }
  assert.equal(records.length, 4);
});

test('logging failures cannot change adapter responses or trigger extra fetches', async (t) => {
  const handlers = await adapters();
  t.mock.method(console, 'error', () => { throw new Error('logging failed'); });
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw new TypeError(FAKE_SECRET); });
  for (const [kind, handler] of Object.entries(handlers)) {
    assert.equal((await handler(context(kind))).status, 502);
  }
  assert.equal(calls, 2);
});

test('overlapping requests retain their own source, Ray ID and elapsed time', async (t) => {
  const { qweather, proxy } = await adapters();
  const records = capture(t);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const pending = [];
  t.mock.method(global, 'fetch', () => new Promise((resolve) => pending.push(resolve)));
  const first = qweather(context('qweather'));
  now = 1010;
  const secondRay = 'fedcba9876543210-LAX';
  const second = proxy(context('proxy', undefined, secondRay));
  now = 1040;
  pending[1](new Response(null, { status: 429 }));
  await second;
  now = 1060;
  pending[0](new Response(null, { status: 503 }));
  await first;
  checkRecord(records[0], { source: 'rainviewer', cfRay: secondRay, elapsedMs: 30, upstreamStatus: 429 });
  checkRecord(records[1], { source: 'qweather', cfRay: RAY, elapsedMs: 60, upstreamStatus: 503 });
});
