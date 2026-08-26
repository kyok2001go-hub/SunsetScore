const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

test('CloudField normalization rejects non-finite values', () => {
  const runtime = createRuntime();
  const SS = load(runtime, ['js/config.js', 'js/domain.js']);
  const field = SS.domain.normalizeCloudField({
    timestamp: 1,
    center: { key: 'CENTER_0', data: { cloud_cover: NaN, cloud_cover_low: Infinity } },
    nodes: []
  });
  assert.equal(field.schemaVersion, 1);
  assert.equal(Number.isFinite(field.summary.avgCloudCover), true);
  assert.equal(SS.domain.validateCloudField(field).valid, true);
});

test('prediction result invariant catches NaN', () => {
  const runtime = createRuntime();
  const SS = load(runtime, ['js/config.js', 'js/domain.js']);
  assert.equal(SS.domain.validatePredictionResult({ score: 72 }).valid, true);
  assert.equal(SS.domain.validatePredictionResult({ score: NaN }).valid, false);
});
