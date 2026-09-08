const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function source(path) {
  return readFileSync(join(__dirname, '..', path), 'utf8');
}

test('administrator backfill page exposes the five-level preview/commit contract', () => {
  const html = source('admin/backfill.html');
  for (const field of ['city', 'event_date_local', 'rating', 'confidence', 'evidence_count', 'comment']) {
    assert.match(html, new RegExp('data-field="' + field + '"'));
  }
  for (const rating of ['excellent', 'very_good', 'good', 'fair', 'poor']) {
    assert.match(html, new RegExp('value="' + rating + '"'));
  }
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /\/css\/admin\.css\?v=2\.4\.5-backfill1/);
  assert.match(html, /\/js\/admin_backfill\.js\?v=2\.4\.5-backfill1/);
  assert.doesNotMatch(html, /<script(?!\s+src=)/i, 'admin page must not require inline scripts under CSP');
});

test('administrator UI keeps untrusted content on text-only DOM paths', () => {
  const script = source('js/admin_backfill.js');
  assert.match(script, /const MAX_ROWS = 20/);
  assert.match(script, /mode: 'preview'/);
  assert.match(script, /mode: 'commit'/);
  assert.match(script, /crypto\.randomUUID/);
  assert.match(script, /renderCommitFailure/);
  assert.match(script, /not_committed/);
  assert.match(script, /textContent/);
  assert.match(script, /replaceChildren/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
});
