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
        const statement = {
          bind: (...next) => bound(next),
          all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true }),
          first: async () => sqlite.prepare(sql).get(...args) || null,
          run: async () => statement._run(),
          _run: () => ({ ...sqlite.prepare(sql).run(...args), success: true })
        };
        return statement;
      }
      return bound([]);
    },
    async batch(prepared) {
      sqlite.exec('BEGIN');
      try {
        const results = prepared.map((statement) => statement._run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { DB, sqlite, statements };
}

function request(payload, path = '/api/feedback', headers = {}) {
  return new Request('https://example.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'test', ...headers },
    body: JSON.stringify(payload)
  });
}

module.exports = { database, request };
