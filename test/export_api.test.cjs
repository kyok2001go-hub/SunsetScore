const test = require('node:test');
const assert = require('node:assert/strict');
const { database, request } = require('./d1-helper.cjs');

for (const legacy of [false, true]) {
  test(`direct CSV and JSON export work with ${legacy ? 'legacy' : 'current'} table`, async () => {
    const feedback = await import('../functions/api/feedback.js');
    const exporter = await import('../functions/api/export.js');
    const { DB, sqlite } = database(legacy);
    try {
      const context = (format) => ({ request: new Request('https://example.test/api/export?format=' + format), env: { DB } });
      const empty = await exporter.onRequestGet(context('csv'));
      assert.equal(empty.status, 200);
      assert.match(await empty.text(), /created_at_epoch/);
      await feedback.onRequestPost({ request: request({
        city: '上海', user_rating: 'good', user_comment: '西侧,有霞\n"好看"',
        model_version: '2.3.1', app_version: '2.3.1', schema_version: 3,
        raw_snapshot_json: JSON.stringify({ app_version: '2.3.1', schema_version: 3 })
      }), env: { DB } });
      const csv = await exporter.onRequestGet(context('csv'));
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-disposition'), /attachment/);
      assert.match(await csv.text(), /"西侧,有霞\n""好看"""/);
      const json = await exporter.onRequestGet(context('json&limit=invalid'));
      assert.equal(json.status, 200);
      const rows = await json.json();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].schema_version, 3);
      assert.equal(rows[0].app_version, '2.3.1');
      assert.ok(Math.abs(Date.now() - rows[0].created_at_epoch) < 10000);
      assert.match(rows[0].created_at_utc, /T.*Z$/);
    } finally { sqlite.close(); }
  });
}

test('optional ADMIN_SECRET is still enforced, never bypassed by CSV format', async () => {
  const api = await import('../functions/api/export.js');
  const response = await api.onRequestGet({
    request: new Request('https://example.test/api/export?format=csv'), env: { DB: {}, ADMIN_SECRET: 'test-only' }
  });
  assert.equal(response.status, 401);
});
