const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast, localSample } = require('./helpers.cjs');

test('NWP FutureField uses the same summary contract as CloudField', () => {
  const SS = load(createRuntime(), CORE_FILES);
  const sample = localSample(forecast({ cloud: [60, 55, 45, 35, 30] }));
  const now = Date.parse('2026-08-26T17:00:00Z');
  const current = SS.cloudField.buildCloudField([sample], now);
  const motion = SS.cloudMotion.forecast(current, 270, [sample], now);
  for (const key of ['m30', 'm60', 'm120']) {
    const future = motion.predictions[key];
    assert.equal(future.schemaVersion, 1);
    assert.equal(Number.isFinite(future.summary.avgCloudCover), true);
    assert.equal(future.prediction.method, 'nwp');
  }
});
