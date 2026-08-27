const test = require('node:test');
const assert = require('node:assert/strict');
const { database, request } = require('./d1-helper.cjs');

for (const legacy of [false, true]) {
  test(`feedback submits and enforces cooldown on ${legacy ? 'V2.2.2' : 'V2.3'} schema without DDL`, async () => {
    const api = await import('../functions/api/feedback.js');
    const { DB, sqlite, statements } = database(legacy);
    try {
      const payload = { city: 'Shanghai', user_rating: 'good', user_comment: '西边有霞', timezone: 'Asia/Shanghai' };
      const first = await api.onRequestPost({ request: request(payload), env: { DB } });
      assert.equal(first.status, 200, await first.text());
      const row = sqlite.prepare('SELECT * FROM sunset_feedback').get();
      assert.equal(row.user_comment, payload.user_comment);
      assert.equal(row.timezone, 'Asia/Shanghai');
      assert.ok(statements.every((sql) => !/\b(?:CREATE|ALTER)\b/i.test(sql)));
      if (!legacy) {
        assert.ok(Number.isInteger(row.created_at_epoch));
        assert.match(row.created_at_utc, /^\d{4}-\d{2}-\d{2}T/);
      }
      const second = await api.onRequestPost({ request: request(payload), env: { DB } });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).cooldown, true);
    } finally { sqlite.close(); }
  });
}

test('legacy cooldown expires after 30 minutes, not 8 hours', async () => {
  const api = await import('../functions/api/feedback.js');
  const { DB, sqlite } = database(true);
  try {
    const payload = { city: '上海', user_rating: 'poor' };
    assert.equal((await api.onRequestPost({ request: request(payload), env: { DB } })).status, 200);
    sqlite.exec("UPDATE sunset_feedback SET created_at = datetime('now', '+8 hours', '-31 minutes')");
    assert.equal((await api.onRequestPost({ request: request(payload), env: { DB } })).status, 200);
  } finally { sqlite.close(); }
});

test('accurate and unknown ratings are rejected before database access', async () => {
  const api = await import('../functions/api/feedback.js');
  for (const user_rating of ['accurate', 'unknown']) {
    const response = await api.onRequestPost({ request: request({ city: '上海', user_rating }), env: { DB: {} } });
    assert.equal(response.status, 400);
  }
});
