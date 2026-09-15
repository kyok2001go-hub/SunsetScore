const test = require('node:test');
const assert = require('node:assert/strict');
test('progress heartbeat, throttling, quiet and redirected logs terminate cleanly', async () => {
  const { createProgress } = await import('../tools/progress.mjs');
  let log = ''; const stream = { isTTY: true, write: s => { log += s; } };
  const p = createProgress({ stream, heartbeat: 10 });
  p.stage('下载'); p.update('1/3'); p.update('2/3');
  assert.equal(log.split('\n').filter(Boolean).length, 1);
  await new Promise(r => setTimeout(r, 40)); assert.match(log, /2\/3/);
  p.fail('NETWORK_TRANSIENT'); const done = log;
  await new Promise(r => setTimeout(r, 30)); assert.equal(log, done); assert.match(log, /失败（下载）/);
  const q = createProgress({ stream, quiet: true }); q.stage('隐藏'); q.update('隐藏', true); q.finish('隐藏'); assert.equal(log, done);
  const redirected = createProgress({ stream: { write: s => { log += s; } } });
  redirected.stage('开始'); redirected.update('不刷屏', true); redirected.finish('结束');
  assert.doesNotMatch(log, /不刷屏/);
});
test('quiet is a boolean build/export option, with strict duplicates', async () => {
  const { parseExportArgs } = await import('../tools/dataset/lib/selection.mjs');
  const { parseArgs } = await import('../tools/ground-truth/lib/cli.mjs');
  assert.equal(parseExportArgs(['--quiet', '--from', '2026-09-03', '--to', '2026-09-14']).quiet, true);
  assert.equal(parseArgs(['raw', '--quiet', '--output', 'out'], 'build').quiet, true);
  assert.throws(() => parseArgs(['raw', '--quiet', '--quiet'], 'build'));
  assert.throws(() => parseArgs(['raw', '--quiet'], 'validate'));
});
test('async Wrangler permits heartbeat and keeps errors sanitized and bounded', async () => {
  const { wranglerAsync } = await import('../tools/dataset/lib/wrangler.mjs');
  const { createProgress } = await import('../tools/progress.mjs');
  let log = ''; const p = createProgress({ heartbeat: 10, stream: { write: s => { log += s; } } }); p.stage('等待');
  const result = await wranglerAsync([], null, { execFile: (cmd, args, options, cb) => {
    assert.equal(options.timeout, 120000); assert.equal(options.maxBuffer, 10 * 1024 * 1024);
    assert.equal(options.windowsHide, true); setTimeout(() => cb(null, '[]', ''), 40);
  } });
  p.finish('完成'); assert.equal(result, '[]'); assert.ok(log.split('\n').filter(Boolean).length >= 3);
  await assert.rejects(wranglerAsync([], null, { execFile: (c,a,o,cb) => cb({ code: 'ETIMEDOUT' }, 'secret', '') }), /^Error: NETWORK_TRANSIENT$/);
  await assert.rejects(wranglerAsync([], null, { execFile: (c,a,o,cb) => cb({ code: 1 }, 'secret', '') }), /^Error: WRANGLER_FAILED$/);
  await assert.rejects(wranglerAsync([], null, { execFile: (c,a,o,cb) => cb({ killed: true, code: null }, '', '') }), /^Error: NETWORK_TRANSIENT$/);
  await assert.rejects(wranglerAsync([], null, { execFile: (c,a,o,cb) => cb({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', '') }), /^Error: WRANGLER_FAILED$/);
});
