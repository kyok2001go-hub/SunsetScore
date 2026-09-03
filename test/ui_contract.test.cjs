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
  assert.match(html, /id="feedback-modal-title"[\s\S]*id="feedback-modal-city"[\s\S]*id="feedback-modal-date"[\s\S]*feedback-modal-desc/);
  assert.match(css, /\.feedback-modal-context\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.modal-fb-textarea\s*\{[^}]*font-size:\s*max\(16px,\s*1rem\)/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});

test('prediction uses five levels and exposes accessible observation guidance from the score', () => {
  const SS = load(createRuntime(), ['js/config.js', 'js/model_config.js']);
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  assert.deepEqual(JSON.parse(JSON.stringify(SS.config.levels)), [
    { min: 90, label: '极佳' },
    { min: 60, label: '很好' },
    { min: 40, label: '一般' },
    { min: 20, label: '较差' },
    { min: 0, label: '很差' }
  ]);
  assert.match(SS.modelConfigKey(), /"levels":/);
  assert.doesNotMatch(readFileSync(join(__dirname, '..', 'js', 'ui.js'), 'utf8'), /不错/);
  assert.match(html, /id="score-ring" role="button" tabindex="0"[\s\S]*aria-controls="score-help-modal"/);
  assert.match(html, /id="r-level" class="level-badge score-level-badge"[\s\S]*id="r-level-text"[\s\S]*score-help-icon/);
  assert.match(html, /id="score-help-modal"[\s\S]*强烈建议前往[\s\S]*建议前往[\s\S]*可酌情前往[\s\S]*不建议专程前往[\s\S]*不建议前往/);
  const css = readFileSync(join(__dirname, '..', 'css/style.css'), 'utf8');
  assert.match(css, /\.score-level-badge\s*\{[^}]*min-width:\s*72px/);
  assert.match(css, /\.score-help-icon\s*\{[^}]*border:\s*1px solid currentColor[^}]*color:\s*inherit/);
  assert.match(css, /\.score-level-heading > span:last-child\s*\{\s*color:\s*var\(--score-level-color\)/);
});

test('feedback description aligns with its options and long mobile toasts can wrap', () => {
  const css = readFileSync(join(__dirname, '..', 'css/style.css'), 'utf8');
  assert.doesNotMatch(css, /\.feedback-modal-header\s*\{[^}]*padding-right/);
  assert.match(css, /\.feedback-modal-title\s*\{[^}]*padding-right:\s*28px/);
  assert.match(css, /\.toast-container\s*\{[^}]*width:\s*min\(680px,\s*calc\(100% - 32px\)\)/);
  assert.match(css, /\.ss-toast\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
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
  assert.ok(html.indexOf('src="js/feedback_service.js') < html.indexOf('src="js/event_service.js'));
  assert.ok(html.indexOf('src="js/event_service.js') < html.indexOf('src="js/snapshot_service.js'));
  assert.ok(html.indexOf('src="js/snapshot_service.js') < html.indexOf('src="js/observation_service.js'));
  assert.ok(html.indexOf('src="js/observation_service.js') < html.indexOf('src="js/feedback_ui.js'));
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

test('search clear control is accessible, does not submit, and keeps space at both input breakpoints', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const css = readFileSync(join(__dirname, '..', 'css/style.css'), 'utf8');
  assert.match(html, /id="city-clear" type="button" aria-label="清空城市输入"[^>]*hidden/);
  assert.match(css, /#city-clear\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /#city-clear:focus-visible/);
  const rules = [...css.matchAll(/#city-input\s*\{([^}]+)\}/g)].map(x => x[1]);
  assert.ok(rules.every(rule => /padding:\s*\d+px 48px/.test(rule)));
  assert.deepEqual([...html.matchAll(/data-city="([^"]+)"/g)].map(x => x[1]), ['深圳', '广州', '上海', '北京']);
});

test('cache diagnostics distinguish prediction-result hits from spatial-data reuse', () => {
  const ui = readFileSync(join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  const app = readFileSync(join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.match(ui, /数据新鲜度 \/ 结果缓存/);
  assert.match(ui, /空间数据缓存/);
  assert.match(app, /fromCache:\s*result\.result_cache_status === 'HIT'/);
});

test('score details use one two-stage formula vocabulary without changing score composition labels', () => {
  const ui = readFileSync(join(__dirname, '..', 'js', 'ui.js'), 'utf8');
  const css = readFileSync(join(__dirname, '..', 'css/style.css'), 'utf8');
  for (const term of [
    '基础分 Score_engine', '最终 Score_final', '动态权重 W_i',
    '大气质量修正 Q', '地平线门控 G_H', '结构加分 B_structure',
    '过渡加分 B_transition', '天气惩罚 P_weather',
    '天空演化因子 F_sky', '黄金窗口因子 F_gw'
  ]) assert.match(ui, new RegExp(term.replace(/[()]/g, '\\$&')));
  assert.match(ui, /addFormulaLine\(note,[\s\S]*?基础分 Score_engine[\s\S]*?最终 Score_final/);
  assert.match(ui, /\['=', 'operator'\][\s\S]*?\['\(', 'bracket'\][\s\S]*?\['Σ', 'operator'\][\s\S]*?\['×', 'operator'\][\s\S]*?\['\)', 'bracket'\]/);
  assert.match(ui, /\['动态权重分布 W_i', dynamicWeightText\(regimeState\)\],\s*\['Σ 组件得分 × 动态权重 W_i'/);
  assert.match(ui, /\['Σ 组件得分 × 动态权重 W_i', detailPhysicalScore\(result\)\]/);
  assert.doesNotMatch(ui, /\['基础分 Score_engine'|\['最终 Score_final'/);
  assert.doesNotMatch(ui, /\['天气型过渡诊断'|\['天气评分组成'|\['天气型强度'/);
  assert.doesNotMatch(ui, /最终Score Score_final|组件动态加权得分 Σ/);
  assert.match(ui, /goldenWindowFactorText[\s\S]*1\.000[\s\S]*未激活/);
  assert.doesNotMatch(ui, /全天演化|天空状态演化|全天演化倍率|黄金窗口倍率|天气风险扣分|总加分（结构\+过渡）/);
  assert.match(css, /\.formula-operator\s*\{[^}]*color:\s*var\(--accent-soft\)[^}]*font-size:\s*1\.18em/);
  assert.match(css, /\.formula-bracket\s*\{[^}]*color:\s*#76d7ff[^}]*font-size:\s*1\.22em/);
  assert.deepEqual([...ui.matchAll(/sky_canvas:\s*'([^']+)'|horizon:\s*'([^']+)'|illumination:\s*'([^']+)'|atmosphere:\s*'([^']+)'|weather:\s*'([^']+)'/g)]
    .slice(0, 5).map(match => match.slice(1).find(Boolean)), ['云幕潜力', '地平线通透', '受光条件', '大气质量', '天气稳定']);
});
