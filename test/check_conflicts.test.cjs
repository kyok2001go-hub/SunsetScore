const test = require('node:test');
const assert = require('node:assert/strict');
const { hasConflictMarker } = require('../scripts/check-conflicts.cjs');

test('source preflight detects unresolved merge markers with LF and CRLF', () => {
  for (const newline of ['\n', '\r\n']) {
    assert.equal(hasConflictMarker(['before', '<<<<<<< HEAD', 'ours', '=======', 'theirs',
      '>>>>>>> branch', 'after'].join(newline)), true);
  }
  assert.equal(hasConflictMarker('const marker = "<<<<<<< HEAD";\nconst value = 1;'), false);
  assert.equal(hasConflictMarker('normal source\n======= extra text in a sentence'), true);
});
