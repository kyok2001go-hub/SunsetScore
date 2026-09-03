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

test('V2.4.0 keeps the V2.3.7 data cache contract while isolating result versions', () => {
  const runtime = createRuntime();
  const SS = load(runtime, ['js/config.js', 'js/cache.js']);
  runtime.storage.set('sunsetscore_v231_sample', JSON.stringify({
    schemaVersion: 3, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    data: { app_version: '2.3.1', model_version: '2.3.1', nowcast_active: false }
  }));
  assert.equal(SS.version.model, '2.4.0');
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

test('cache startup removes obsolete, expired and malformed cache envelopes only', () => {
  const runtime = createRuntime();
  const SS = load(runtime, ['js/config.js']);
  const now = Date.now();
  runtime.storage.set(SS.config.cachePrefix + 'fresh', JSON.stringify({
    schemaVersion: SS.version.schema, createdAt: now, expiresAt: now + 60000, data: { fresh: true }
  }));
  runtime.storage.set(SS.config.cachePrefix + 'expired', JSON.stringify({
    schemaVersion: SS.version.schema, createdAt: now - 120000, expiresAt: now - 60000, data: { expired: true }
  }));
  runtime.storage.set(SS.config.cachePrefix + 'malformed', '{');
  runtime.storage.set('sunsetscore_v235_old', JSON.stringify({
    schemaVersion: SS.version.schema, createdAt: now, expiresAt: now + 60000, data: { old: true }
  }));
  runtime.storage.set('sunsetscore_feedback_v23', '[{"kept":true}]');
  runtime.storage.set('ss_observation_backup_submission-1', 'fb_local');
  runtime.storage.set('ss_fb_remote_last_ts_深圳', String(now));

  load(runtime, ['js/cache.js']);

  assert.ok(runtime.storage.has(SS.config.cachePrefix + 'fresh'));
  assert.equal(runtime.storage.has(SS.config.cachePrefix + 'expired'), false);
  assert.equal(runtime.storage.has(SS.config.cachePrefix + 'malformed'), false);
  assert.equal(runtime.storage.has('sunsetscore_v235_old'), false);
  assert.ok(runtime.storage.has('sunsetscore_feedback_v23'));
  assert.ok(runtime.storage.has('ss_observation_backup_submission-1'));
  assert.ok(runtime.storage.has('ss_fb_remote_last_ts_深圳'));
});

function limitedStorage(limit, initial = []) {
  const values = new Map(initial);
  function used(nextKey, nextValue) {
    const copy = new Map(values);
    copy.set(nextKey, String(nextValue));
    return [...copy].reduce((total, [key, value]) => total + key.length + value.length, 0);
  }
  return {
    values,
    api: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem(key, value) {
        if (used(key, value) > limit) {
          const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error;
        }
        values.set(key, String(value));
      },
      removeItem: key => values.delete(key),
      key: index => [...values.keys()][index] ?? null,
      get length() { return values.size; }
    }
  };
}

test('quota pressure evicts the oldest SunsetScore cache and preserves unrelated origin data', () => {
  const storage = limitedStorage(1050, [['unrelated-setting', 'keep']]);
  const runtime = createRuntime({ localStorage: storage.api });
  const SS = load(runtime, ['js/config.js', 'js/cache.js']);
  assert.equal(SS.cache.set('old', { payload: 'x'.repeat(350) }, 10), true);
  assert.equal(SS.cache.set('new', { payload: 'y'.repeat(600) }, 10), true);
  assert.equal(SS.cache.get('old'), null);
  assert.equal(SS.cache.get('new').payload.length, 600);
  assert.equal(storage.values.get('unrelated-setting'), 'keep');
});

test('an unrecoverable persistent quota still falls back to the page memory cache', () => {
  const storage = limitedStorage(220, [['unrelated-large-value', 'z'.repeat(190)]]);
  const runtime = createRuntime({ localStorage: storage.api });
  const SS = load(runtime, ['js/config.js', 'js/cache.js']);
  assert.equal(SS.cache.set('session-only', { ok: true }, 10), false);
  assert.deepEqual(JSON.parse(JSON.stringify(SS.cache.get('session-only'))), { ok: true });
  assert.equal(storage.values.get('unrelated-large-value'), 'z'.repeat(190));
});
