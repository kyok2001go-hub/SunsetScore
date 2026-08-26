const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

test('IANA timezone validation rejects fixed-offset labels', () => {
  const SS = load(createRuntime(), ['js/config.js', 'js/time.js']);
  assert.equal(SS.time.isValidTimezone('Asia/Shanghai'), true);
  assert.equal(SS.time.isValidTimezone('UTC+8'), false);
});

test('UTC offset formatter preserves the V2.2.2 display convention', () => {
  const SS = load(createRuntime(), ['js/config.js', 'js/time.js']);
  assert.equal(SS.time.formatUtcOffset(8 * 3600), 'UTC+8');
  assert.equal(SS.time.formatUtcOffset(-7 * 3600), 'UTC-7');
  assert.equal(SS.time.formatUtcOffset(5.5 * 3600), 'UTC+5:30');
  assert.equal(SS.time.formatUtcOffset(0), 'UTC');
});

test('Los Angeles DST transition skips 02:xx local time', () => {
  const SS = load(createRuntime(), ['js/config.js', 'js/time.js']);
  assert.equal(SS.time.formatLocal(Date.parse('2026-03-08T09:30:00Z'), 'America/Los_Angeles'), '2026-03-08 01:30:00');
  assert.equal(SS.time.formatLocal(Date.parse('2026-03-08T10:30:00Z'), 'America/Los_Angeles'), '2026-03-08 03:30:00');
});

for (const timezone of ['Asia/Taipei', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Australia/Sydney']) {
  test(`UTC to local formatting is stable for ${timezone}`, () => {
    const SS = load(createRuntime(), ['js/config.js', 'js/time.js']);
    assert.match(SS.time.formatLocal(Date.parse('2026-08-26T10:00:00Z'), timezone), /^2026-08-26 \d{2}:\d{2}:\d{2}$/);
  });
}
