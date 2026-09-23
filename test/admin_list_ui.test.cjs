const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const source = name => readFileSync(join(ROOT, name), 'utf8');

test('all admin pages share navigation and list pages expose their filters', () => {
  for (const [name, current] of [
    ['backfill', '反馈补录'], ['snapshot', '数据快照'], ['observation', '反馈记录']
  ]) {
    const html = source('admin/' + name + '.html');
    for (const href of ['/admin/backfill', '/admin/snapshot', '/admin/observation']) {
      assert.ok(html.includes('href="' + href + '"'), name + ': ' + href);
    }
    assert.match(html, new RegExp('aria-current="page"[^>]*>' + current));
    assert.ok(html.includes('/css/admin.css?v=2.5.3.3-admin2'));
    assert.doesNotMatch(html, /<script(?!\s+src=)/i);
  }
  const snapshot = source('admin/snapshot.html');
  for (const filter of ['event_date_local', 'city', 'predicted_level', 'baseline_level',
    'regime_label', 'sky_evolution_state', 'snapshot_source']) {
    assert.ok(snapshot.includes('name="' + filter + '"'), filter);
    assert.ok(snapshot.includes('data-clear-for="' + filter + '"'), filter + ' clear');
  }
  const observation = source('admin/observation.html');
  for (const filter of ['event_date_local', 'city', 'rating', 'source']) {
    assert.ok(observation.includes('name="' + filter + '"'), filter);
    assert.ok(observation.includes('data-clear-for="' + filter + '"'), filter + ' clear');
  }
  assert.ok(snapshot.includes('/js/admin_common.js?v=2.5.3.3-admin2'));
  assert.ok(observation.includes('/js/admin_common.js?v=2.5.3.3-admin2'));
  assert.match(source('css/admin.css'), /\.admin-result-wrap\s*\{[^}]*max-height:\s*max\(900px, 100vh\)/);
});

test('list UI renders only text, paginates and ignores a superseded response', async () => {
  class Node {
    constructor() { this.children = []; this.listeners = {}; this.value = ''; this.disabled = false; this.attributes = {}; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    getAttribute(name) { return this.attributes[name]; }
    focus() { this.focused = true; }
    appendChild(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
    get classList() { return { toggle() {} }; }
    set innerHTML(_) { throw new Error('HTML injection'); }
  }
  const nodes = Object.fromEntries([
    'admin-filter-form', 'admin-list-status', 'admin-result-head', 'admin-result-body',
    'admin-total', 'admin-page-info', 'admin-page-size', 'admin-prev', 'admin-next', 'admin-reset'
  ].map(id => [id, new Node()]));
  const submit = new Node();
  const city = new Node(); city.name = 'city';
  const rating = new Node(); rating.name = 'rating'; rating.attributes['data-options'] = 'rating';
  const cityClear = new Node(); cityClear.attributes['data-clear-for'] = 'city';
  const ratingClear = new Node(); ratingClear.attributes['data-clear-for'] = 'rating';
  const clears = [cityClear, ratingClear];
  nodes['admin-page-size'].value = '50';
  nodes['admin-filter-form'].querySelector = () => submit;
  nodes['admin-filter-form'].querySelectorAll = selector => selector === '[name]' ? [city, rating]
    : selector === '[data-clear-for]' ? clears : [rating];
  nodes['admin-filter-form'].elements = { namedItem: name => ({ city, rating })[name] || null };
  nodes['admin-filter-form'].reset = () => { city.value = ''; rating.value = ''; };
  const requests = [];
  const fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
  vm.runInNewContext(source('js/admin_common.js'), {
    document: { body: { getAttribute: () => '/api/admin/observations' },
      getElementById: id => nodes[id], createElement: () => new Node() },
    URLSearchParams, AbortController, fetch
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  function reply(index, items, total) {
    requests[index].resolve({ ok: true, json: async () => ({
      success: true, columns: ['id', 'comment'], items,
      pagination: { page: Number(new URLSearchParams(requests[index].url.split('?')[1]).get('page')),
        page_size: 50, total, total_pages: Math.ceil(total / 50) },
      filter_options: { rating: ['good'] }, filter_labels: { rating: { good: '普通有霞' } }
    }) });
  }
  assert.ok(requests[0].url.includes('include_filter_options=1'));
  assert.equal(cityClear.hidden, true);
  reply(0, [{ id: 'first', comment: '<script>alert(1)</script>' }], 51);
  await flush();
  assert.equal(nodes['admin-result-body'].children[0].children[1].textContent, '<script>alert(1)</script>');
  assert.equal(nodes['admin-next'].disabled, false);
  nodes['admin-next'].listeners.click();
  assert.ok(requests[1].url.includes('page=2'));
  city.value = '深圳';
  nodes['admin-filter-form'].listeners.input();
  assert.equal(cityClear.hidden, false);
  nodes['admin-filter-form'].listeners.submit({ preventDefault() {} });
  assert.equal(requests[1].options.signal.aborted, true);
  assert.ok(requests[2].url.includes('city=%E6%B7%B1%E5%9C%B3'));
  reply(2, [{ id: 'new', comment: '最新结果' }], 1);
  await flush();
  reply(1, [{ id: 'stale', comment: '旧结果' }], 51);
  await flush();
  assert.equal(nodes['admin-result-body'].children[0].children[0].textContent, 'new');
  assert.equal(nodes['admin-page-info'].textContent, '1 / 1');
  cityClear.listeners.click();
  assert.equal(city.value, '');
  assert.equal(cityClear.hidden, true);
  assert.equal(city.focused, true);
  assert.equal(requests.length, 3, 'clearing a field does not query until submitted');
  rating.value = 'good';
  nodes['admin-filter-form'].listeners.change();
  assert.equal(ratingClear.hidden, false);
  ratingClear.listeners.click();
  assert.equal(rating.value, '');
  assert.equal(ratingClear.hidden, true);
  nodes['admin-reset'].listeners.click();
  assert.ok(requests[3].url.includes('include_filter_options=1'));
  assert.ok(!requests[3].url.includes('city='));
});
