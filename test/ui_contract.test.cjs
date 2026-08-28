const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRuntime, load } = require('./helpers.cjs');

test('footer keeps QWeather attribution as plain text without a hyperlink', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)[1];
  assert.match(footer, /QWeather（国内城市 \/ 分钟降水）/);
  assert.doesNotMatch(footer, /<a\b/i);
});

test('feedback UI only offers observation ratings and keeps input at least 16px', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const css = readFileSync(join(__dirname, '..', 'css/style.css'), 'utf8');
  assert.deepEqual([...html.matchAll(/data-rating="([^"]+)"/g)].map((match) => match[1]), ['great', 'good', 'fair', 'poor']);
  assert.match(css, /\.modal-fb-textarea\s*\{[^}]*font-size:\s*max\(16px,\s*1rem\)/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});

test('city combobox keeps 16px input at every breakpoint and loads its two modules in dependency order', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const css = readFileSync(join(__dirname, '..', 'css/style.css'), 'utf8');
  const rules = [...css.matchAll(/#city-input\s*\{([^}]+)\}/g)].map(x => x[1]);
  assert.ok(rules.length >= 2);
  assert.ok(rules.every(rule => /font-size:\s*max\(16px,\s*1rem\)/.test(rule)));
  assert.match(css, /#search-form\s*\{[^}]*align-items:\s*stretch/);
  assert.match(rules[0], /height:\s*100%/);
  assert.match(html, /role="combobox"[\s\S]*aria-controls="city-options"/);
  assert.match(html, /id="city-options" role="listbox"/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
  assert.ok(html.indexOf('src="js/data.js') < html.indexOf('src="js/city_search.js'));
  assert.ok(html.indexOf('src="js/city_search.js') < html.indexOf('src="js/prediction_service.js'));
  assert.ok(html.indexOf('src="js/city_search_ui.js') < html.indexOf('src="js/app.js'));
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
