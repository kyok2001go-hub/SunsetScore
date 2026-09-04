const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const workerPath = join(__dirname, '..', 'infra', 'scheduler-worker', 'src', 'index.js');
const workerPromise = import(pathToFileURL(workerPath).href);

test('formatSlotFromScheduledTime converts UTC scheduled times to strict Shanghai HHMM slots', async () => {
  const worker = await workerPromise;

  // 04:13 UTC -> 12:13 in Asia/Shanghai
  const utc0413 = Date.parse('2026-09-04T04:13:00.000Z');
  assert.equal(worker.formatSlotFromScheduledTime(utc0413, 'Asia/Shanghai'), '1213');

  // 08:13 UTC -> 16:13 in Asia/Shanghai
  const utc0813 = Date.parse('2026-09-04T08:13:00.000Z');
  assert.equal(worker.formatSlotFromScheduledTime(utc0813, 'Asia/Shanghai'), '1613');

  // Midnight UTC -> 08:00 Asia/Shanghai
  const utc0000 = Date.parse('2026-09-04T00:00:00.000Z');
  assert.equal(worker.formatSlotFromScheduledTime(utc0000, 'Asia/Shanghai'), '0800');

  // Across day boundary: 23:45 UTC -> 07:45 next day Asia/Shanghai
  const utc2345 = Date.parse('2026-09-04T23:45:00.000Z');
  assert.equal(worker.formatSlotFromScheduledTime(utc2345, 'Asia/Shanghai'), '0745');

  // Support Date object
  assert.equal(worker.formatSlotFromScheduledTime(new Date(utc0413), 'Asia/Shanghai'), '1213');

  // Support ISO string
  assert.equal(worker.formatSlotFromScheduledTime('2026-09-04T04:13:00.000Z', 'Asia/Shanghai'), '1213');

  // Rejections for invalid dates/timezones
  assert.throws(() => worker.formatSlotFromScheduledTime(NaN), /Invalid scheduledTime/);
  assert.throws(() => worker.formatSlotFromScheduledTime('not-a-date'), /Invalid scheduledTime/);
  assert.throws(() => worker.formatSlotFromScheduledTime(utc0413, 'Invalid/Timezone_Name'), /Unsupported timeZone/);
});

test('buildDispatchPayload constructs fixed parameters and validates slot', async () => {
  const worker = await workerPromise;

  const payload1213 = worker.buildDispatchPayload('1213');
  assert.deepEqual(payload1213, {
    ref: 'main',
    inputs: {
      submit: true,
      cities: '',
      run_type: 'scheduled',
      slot: '1213'
    }
  });

  const payload1613 = worker.buildDispatchPayload('1613');
  assert.equal(payload1613.inputs.slot, '1613');
  assert.equal(payload1613.inputs.run_type, 'scheduled');
  assert.equal(payload1613.inputs.submit, true);

  // Rejects invalid slot formats
  for (const badSlot of ['', '12', '121', '12134', '2400', '1260', 'abcd', null, undefined]) {
    assert.throws(() => worker.buildDispatchPayload(badSlot), /Invalid slot format/);
  }
});

test('triggerWorkflowDispatch sends correct request and headers, rejecting missing token', async () => {
  const worker = await workerPromise;
  const requests = [];

  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 204 });
  };

  const result = await worker.triggerWorkflowDispatch('1213', 'mock-ghp-token-123', fakeFetch);
  assert.equal(result.success, true);
  assert.equal(result.slot, '1213');
  assert.equal(result.status, 204);

  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.url, worker.GITHUB_DISPATCH_URL);
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers['Accept'], 'application/vnd.github+json');
  assert.equal(req.init.headers['Authorization'], 'Bearer mock-ghp-token-123');
  assert.equal(req.init.headers['User-Agent'], 'sunsetscore-scheduler');
  assert.equal(req.init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(req.init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(req.init.body);
  assert.deepEqual(body, {
    ref: 'main',
    inputs: {
      submit: true,
      cities: '',
      run_type: 'scheduled',
      slot: '1213'
    }
  });

  const modernResult = await worker.triggerWorkflowDispatch(
    '1613',
    'mock-github-pat-token',
    async () => new Response('{"workflow_run_id":1}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  );
  assert.equal(modernResult.status, 200);

  // Rejects missing or empty token
  await assert.rejects(() => worker.triggerWorkflowDispatch('1213', '', fakeFetch), /GITHUB_TOKEN is missing or empty/);
  await assert.rejects(() => worker.triggerWorkflowDispatch('1213', null, fakeFetch), /GITHUB_TOKEN is missing or empty/);
  await assert.rejects(() => worker.triggerWorkflowDispatch('1213', '   ', fakeFetch), /GITHUB_TOKEN is missing or empty/);
});

test('triggerWorkflowDispatch handles HTTP errors safely with token redaction', async () => {
  const worker = await workerPromise;
  const fineGrainedToken = ['github', 'pat', 'test', 'a'.repeat(32)].join('_');
  const classicToken = ['ghp', 'b'.repeat(32)].join('_');

  assert.equal(
    worker.sanitizeLog(`Bearer ${fineGrainedToken}`),
    'Bearer [REDACTED_TOKEN]'
  );

  // Error response bodies are deliberately not included in errors or logs.
  const unauthorizedFetch = async () => {
    return new Response(`Bad credentials for ${fineGrainedToken}`, {
      status: 401,
      statusText: 'Unauthorized'
    });
  };

  await assert.rejects(
    () => worker.triggerWorkflowDispatch('1213', classicToken, unauthorizedFetch),
    (err) => {
      assert.match(err.message, /HTTP 401/);
      assert.doesNotMatch(err.message, new RegExp(fineGrainedToken));
      assert.match(err.message, /Unauthorized/);
      return true;
    }
  );

  // Mock GitHub 500 Server Error
  const serverErrorFetch = async () => new Response('Internal Server Error', {
    status: 500,
    statusText: 'Internal Server Error'
  });
  await assert.rejects(
    () => worker.triggerWorkflowDispatch('1213', 'valid-token', serverErrorFetch),
    /HTTP 500: Internal Server Error/
  );

  // Mock Network error
  const netErrorFetch = async () => { throw new Error('DNS failure to api.github.com'); };
  await assert.rejects(
    () => worker.triggerWorkflowDispatch('1213', 'valid-token', netErrorFetch),
    /GitHub dispatch network failure: DNS failure/
  );
});

test('scheduler worker handler executes only valid scheduled events', async () => {
  const worker = await workerPromise;
  const dispatched = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    dispatched.push({ url, init });
    return new Response(null, { status: 204 });
  };

  try {
    // 1. Scheduled event for 04:13 UTC -> slot 1213
    const scheduledTime = Date.parse('2026-09-04T04:13:00Z');
    await worker.default.scheduled({ scheduledTime, cron: '13 4 * * *' }, { GITHUB_TOKEN: 'test-token' }, {});
    assert.equal(dispatched.length, 1);
    const body = JSON.parse(dispatched[0].init.body);
    assert.equal(body.inputs.slot, '1213');
    assert.equal(body.inputs.run_type, 'scheduled');
    assert.equal(body.inputs.submit, true);

    await assert.rejects(
      () => worker.default.scheduled({}, { GITHUB_TOKEN: 'test-token' }, {}),
      /valid scheduledTime/
    );

    assert.equal(typeof worker.default.fetch, 'undefined');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wrangler.jsonc defines the single source of truth for production crons', () => {
  const wranglerPath = join(__dirname, '..', 'infra', 'scheduler-worker', 'wrangler.jsonc');
  const content = readFileSync(wranglerPath, 'utf8');

  // Strip JSON comments to parse JSON
  const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const config = JSON.parse(stripped);

  assert.equal(config.name, 'sunsetscore-scheduler');
  assert.equal(config.compatibility_date, '2026-09-04');
  assert.deepEqual(config.triggers.crons, ['13 4 * * *', '13 8 * * *']);
  assert.deepEqual(config.observability, { enabled: true, head_sampling_rate: 1 });

  // Ensure no secret or token in wrangler configuration
  assert.doesNotMatch(content, /token|secret|password|ghp_/i);
});
