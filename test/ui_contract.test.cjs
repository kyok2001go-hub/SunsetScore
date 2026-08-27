const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRuntime, load } = require('./helpers.cjs');

test('feedback UI only offers observation ratings and keeps input at least 16px', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const css = readFileSync(join(__dirname, '..', 'css/style.css'), 'utf8');
  assert.deepEqual([...html.matchAll(/data-rating="([^"]+)"/g)].map((match) => match[1]), ['great', 'good', 'fair', 'poor']);
  assert.match(css, /\.modal-fb-textarea\s*\{[^}]*font-size:\s*max\(16px,\s*1rem\)/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});

test('all static resource cache-busters match the app version and asset revision', () => {
  const SS = load(createRuntime(), ['js/config.js']);
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const versions = [...html.matchAll(/\?v=([^"']+)/g)].map((match) => match[1]);
  assert.ok(versions.length > 20);
  assert.ok(versions.every((version) => version === SS.version.app + '-' + SS.version.assetRevision));
});
