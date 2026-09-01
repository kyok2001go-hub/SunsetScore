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

test('V2.3.8 keeps the V2.3.7 data cache contract while isolating result versions', () => {
  const runtime = createRuntime();
  const SS = load(runtime, ['js/config.js', 'js/cache.js']);
  runtime.storage.set('sunsetscore_v231_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.1', model_version: '2.3.1', nowcast_active: false }
  }));
  assert.equal(SS.version.model, '2.3.8');
  runtime.storage.set('sunsetscore_v231_reliability1_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.1', model_version: '2.3.1', nowcast_active: true }
  }));
  runtime.storage.set('sunsetscore_v231_reliability2_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.1', model_version: '2.3.1', nowcast_active: true }
  }));
  runtime.storage.set('sunsetscore_v232_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.2', model_version: '2.3.2', nowcast_active: true }
  }));
  runtime.storage.set('sunsetscore_v232_precip1_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.2', model_version: '2.3.2', nowcast_active: true }
  }));
  runtime.storage.set('sunsetscore_v233_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.3', model_version: '2.3.3', nowcast_active: true }
  }));
  runtime.storage.set('sunsetscore_v234_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.4', model_version: '2.3.4', nowcast_active: true }
  }));
  runtime.storage.set('sunsetscore_v235_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.5', model_version: '2.3.5', nowcast_active: true }
  }));
  assert.equal(SS.config.cachePrefix, 'sunsetscore_v237_');
  assert.equal(SS.cache.get('sample'), null);
});
