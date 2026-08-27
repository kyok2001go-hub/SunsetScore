const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Real SQLite SQL, behind the D1 binding methods used by our APIs.
function database(legacy = false) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(join(__dirname, '..', legacy ? 'migrations/001_initial.sql' : 'schema.sql'), 'utf8'));
  const statements = [];
  const DB = {
    prepare(sql) {
      statements.push(sql);
      function bound(args) {
        return {
          bind: (...next) => bound(next),
          all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true }),
          first: async () => sqlite.prepare(sql).get(...args) || null,
          run: async () => ({ ...sqlite.prepare(sql).run(...args), success: true })
        };
      }
      return bound([]);
    }
  };
  return { DB, sqlite, statements };
}

function request(payload) {
  return new Request('https://example.test/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'test' },
    body: JSON.stringify(payload)
  });
}

module.exports = { database, request };
