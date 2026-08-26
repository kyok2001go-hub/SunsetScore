const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

test('cache writes and reads schema-versioned envelopes', () => {
  const runtime = createRuntime();
  const SS = load(runtime, ['js/config.js', 'js/cache.js']);
  SS.cache.set('sample', { ok: true }, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(SS.cache.get('sample'))), { ok: true });
  const key = SS.config.cachePrefix + 'sample';
  const envelope = JSON.parse(runtime.storage.get(key));
  assert.equal(envelope.schemaVersion, 3);
  envelope.schemaVersion = 2;
  runtime.storage.set(key, JSON.stringify(envelope));
  assert.equal(SS.cache.get('sample'), null);
});
