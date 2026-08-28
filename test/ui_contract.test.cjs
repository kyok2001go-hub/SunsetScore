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

test('static resources, edge logs and server identifiers match the app version and asset revision', async () => {
  const SS = load(createRuntime(), ['js/config.js']);
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const versions = [...html.matchAll(/\?v=([^"']+)/g)].map((match) => match[1]);
  assert.ok(versions.length > 20);
  assert.ok(versions.every((version) => version === SS.version.app + '-' + SS.version.assetRevision));
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.version, SS.version.app);
  assert.equal(SS.version.model, SS.version.app);
  assert.ok(html.includes('sunset-score-v' + SS.version.model));
  const { EDGE_APP_VERSION } = await import('../server/edge-log.js');
  assert.equal(EDGE_APP_VERSION, SS.version.app);
  const feedback = readFileSync(join(__dirname, '..', 'functions/api/feedback.js'), 'utf8');
  for (const field of ['app_version', 'model_version']) {
    assert.ok(feedback.includes("['" + field + "', (p) => textOrNull(p." + field + ", 30) || '" + SS.version.app + "']"));
  }
  const devServer = readFileSync(join(__dirname, '..', 'scripts/dev-server.mjs'), 'utf8');
  assert.ok(devServer.includes('SunsetScore V' + SS.version.app + ' local server:'));
});
