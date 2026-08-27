const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

test('feedback payload carries canonical timezone and version fields', () => {
  const runtime = createRuntime();
  const SS = load(runtime, [
    'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
    'js/baseline.js', 'js/feedback_service.js'
  ]);
  const result = {
    query_id: 'qid_test', city: '上海', country: 'CN', latitude: 31.23, longitude: 121.47,
    timezone: 'Asia/Shanghai', date: '2026-08-26', sunset_local: '18:25', sunset_azimuth: 281,
    score: 73, level: '很好', components: {}, data: {}, cloud_structure: {},
    cloud_motion: {}, sky_evolution: {}, all_day_sky_state: {}, regime_state: {}
  };
  const payload = SS.feedbackService.buildPayload(result, {
    rating: 'good', ratingLabel: '普通有霞', comment: '西侧有霞', nowUtcMs: Date.parse('2026-08-26T10:30:00Z')
  });
  assert.equal(payload.timezone, 'Asia/Shanghai');
  assert.equal(payload.app_version, '2.3.1');
  assert.equal(payload.model_version, '2.3.1');
  assert.equal(payload.schema_version, 3);
  assert.equal(payload.user_comment, '西侧有霞');
  const snapshot = JSON.parse(payload.raw_snapshot_json);
  assert.equal(snapshot.timestamp_utc, '2026-08-26T10:30:00.000Z');
});

test('remote failure keeps retry available and preserves the actual server error', async () => {
  const runtime = createRuntime({ fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: '数据库不可用' }) }) });
  const SS = load(runtime, ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/time.js', 'js/baseline.js', 'js/feedback_service.js']);
  const result = { city: '上海', timezone: 'Asia/Shanghai' };
  const response = await SS.feedbackService.submit(result, { rating: 'good' });
  assert.equal(response.remote, false);
  assert.equal(response.local, true);
  assert.equal(response.error, '数据库不可用');
  assert.equal(SS.feedbackService.remainingCooldownMinutes('上海'), 0);
  runtime.sandbox.fetch = async () => ({ ok: true, json: async () => ({ success: true, id: 'remote-id' }) });
  const retry = await SS.feedbackService.submit(result, { rating: 'good' });
  assert.equal(retry.remote, true);
  assert.equal(SS.feedbackService.remainingCooldownMinutes('上海'), 30);
});

test('HTTP 200 with success:false is not treated as a saved feedback', async () => {
  const runtime = createRuntime({ fetch: async () => ({ ok: true, json: async () => ({ success: false, error: '未写入' }) }) });
  const SS = load(runtime, ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/time.js', 'js/baseline.js', 'js/feedback_service.js']);
  assert.equal((await SS.feedbackService.submit({ city: '上海' }, { rating: 'poor' })).remote, false);
  assert.equal(SS.feedbackService.remainingCooldownMinutes('上海'), 0);
  assert.throws(() => SS.feedbackService.buildPayload({ city: '上海' }, { rating: 'accurate' }), /实际晚霞/);
});

test('failed localStorage is not reported as a local backup', async () => {
  const runtime = createRuntime({
    fetch: async () => { throw new Error('offline'); },
    localStorage: { getItem: () => null, setItem: () => { throw new Error('quota'); } }
  });
  const SS = load(runtime, ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/baseline.js']);
  const result = await SS.baseline.submitFeedback({ city: '上海', user_rating: 'poor' });
  assert.equal(result.local, false);
  assert.equal(result.remote, false);
});

test('feedback cooldown is measured with UTC epoch milliseconds', () => {
  const runtime = createRuntime();
  const SS = load(runtime, [
    'js/config.js', 'js/model_config.js', 'js/network.js', 'js/domain.js', 'js/time.js',
    'js/baseline.js', 'js/feedback_service.js'
  ]);
  const now = Date.parse('2026-08-26T10:30:00Z');
  SS.feedbackService.markSubmitted('上海', now);
  assert.equal(SS.feedbackService.remainingCooldownMinutes('上海', now + 29 * 60000), 1);
  assert.equal(SS.feedbackService.remainingCooldownMinutes('上海', now + 30 * 60000), 0);
});
