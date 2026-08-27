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

test('feedback hotfix isolates old V2.3.1 cached predictions without changing the model version', () => {
  const runtime = createRuntime();
  const SS = load(runtime, ['js/config.js', 'js/cache.js']);
  runtime.storage.set('sunsetscore_v231_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.1', model_version: '2.3.1', nowcast_active: false }
  }));
  assert.equal(SS.version.model, '2.3.1');
  assert.equal(SS.config.cachePrefix, 'sunsetscore_v231_feedback1_');
  assert.equal(SS.cache.get('sample'), null);
});
