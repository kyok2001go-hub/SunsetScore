const test = require('node:test');
const assert = require('node:assert/strict');
const golden = require('./fixtures/score-golden.json');
const { scoreCases } = require('./score-cases.cjs');

test('40 frozen 2.4.6 configuration vectors remain identical (including missing remote data)', () => {
  assert.deepEqual(scoreCases(), golden);
});
