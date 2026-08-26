const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(join(__dirname, '..', 'functions', 'api', 'feedback.js')).href;

function request(payload) {
  return new Request('https://example.test/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'test' },
    body: JSON.stringify(payload)
  });
}

test('feedback API performs no runtime DDL and inserts UTC/epoch fields', async () => {
  const api = await import(moduleUrl);
  const statements = [];
  let insertArgs = null;
  const DB = {
    prepare(sql) {
      statements.push(sql);
      return {
        bind(...args) {
          if (/INSERT INTO/i.test(sql)) insertArgs = args;
          return { first: async () => null, run: async () => ({ success: true }) };
        }
      };
    }
  };
  const response = await api.onRequestPost({
    request: request({ city: 'Shanghai', user_rating: 'good', timezone: 'Asia/Shanghai' }),
    env: { DB }
  });
  assert.equal(response.status, 200);
  assert.ok(statements.every((sql) => !/\b(?:CREATE|ALTER)\b/i.test(sql)));
  const insertSql = statements.find((sql) => /INSERT INTO/i.test(sql));
  const columns = insertSql.match(/\(([^)]+)\)\s*VALUES/i)[1].split(',').map((item) => item.trim());
  const row = Object.fromEntries(columns.map((column, index) => [column, insertArgs[index]]));
  assert.ok(Number.isInteger(row.created_at_epoch));
  assert.match(row.created_at_utc, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.timezone, 'Asia/Shanghai');
  assert.equal(row.app_version, '2.3.0');
  assert.equal(row.schema_version, 3);
});

test('feedback API rate limit uses created_at_epoch and returns 429', async () => {
  const api = await import(moduleUrl);
  const statements = [];
  const DB = {
    prepare(sql) {
      statements.push(sql);
      return {
        bind() { return { first: async () => ({ created_at_epoch: Date.now() }), run: async () => ({}) }; }
      };
    }
  };
  const response = await api.onRequestPost({
    request: request({ city: 'Shanghai', user_rating: 'good', timezone: 'UTC+8' }),
    env: { DB }
  });
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.cooldown, true);
  assert.match(statements[0], /created_at_epoch\s*>\s*\?/);
  assert.equal(statements.some((sql) => /INSERT INTO/i.test(sql)), false);
});
