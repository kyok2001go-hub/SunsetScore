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
  assert.match(html, /\/css\/admin\.css\?v=2\.4\.6-backfill3/);
  assert.match(html, /\/js\/admin_backfill\.js\?v=2\.4\.6-backfill3/);
  assert.match(html, /<option value="" selected>请选择等级<\/option>/);
  assert.doesNotMatch(html, /<script(?!\s+src=)/i, 'admin page must not require inline scripts under CSP');
});

function harness() {
  const vm = require('node:vm');
  const node = () => ({ value: '', disabled: false, listeners: {}, className: '', dataset: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, focus() { this.focused = true; },
    replaceChildren() {}, appendChild() {} });
  const fields = Object.fromEntries(['city', 'event_date_local', 'rating', 'confidence', 'evidence_count', 'comment'].map(k => {
    const field = node(); field.matches = selector => selector === '[data-field]' || selector === '[data-field="' + k + '"]'; return [k, field];
  }));
  const match = node(), slot = node(), remove = node(), row = node(), picker = node();
  row.querySelector = selector => selector === '.date-picker' ? picker : selector === '.match-status' ? match : selector === '.candidate-slot' ? slot : selector === '.remove-row' ? remove : fields[/data-field="([^"]+)"/.exec(selector)[1]];
  const nodes = Object.fromEntries(['backfill-rows', 'row-template', 'add-row', 'preview', 'commit', 'status'].map(k => [k, node()]));
  nodes['backfill-rows'].rows = [];
  nodes['backfill-rows'].appendChild = () => nodes['backfill-rows'].rows.push(row);
  nodes['row-template'].content = { cloneNode: () => ({ querySelector: () => row }) };
  const requests = [];
  let resolvePreview;
  vm.runInNewContext(source('js/admin_backfill.js'), {
    document: { getElementById: id => nodes[id], createElement: node }, crypto: { randomUUID: () => 'test-id' }, window: { confirm: () => true },
    fetch: async (url, options) => { const payload = JSON.parse(options.body); requests.push(payload);
      return new Promise(resolve => { resolvePreview = () => resolve({ ok: true, json: async () => ({ success: true, items: payload.items.map(item => ({ ...item, status: 'matched', candidates: [{ event_id: 'evt', city: '深圳', timezone: 'Asia/Shanghai', latitude: 22, longitude: 114, snapshot_count: 1 }] })) }) }); }); }
  });
  fields.city.value = '深圳';
  return { fields, nodes, requests, row, picker, edit(key, value) { fields[key].value = value; row.listeners.input({ target: fields[key] }); }, resolve: () => resolvePreview() };
}

test('admin date input normalizes compact dates and rejects invalid calendar dates before requests', async () => {
  const h = harness(); h.fields.rating.value = 'good';
  for (const bad of ['20260229', '20260931', '20261301', '202609', '', '00000101']) {
    h.edit('event_date_local', bad); await h.nodes.preview.listeners.click();
    assert.equal(h.requests.length, 0); assert.match(h.nodes.status.textContent, /有效日期/);
  }
  h.edit('event_date_local', '20260910'); assert.equal(h.fields.event_date_local.value, '2026-09-10');
  const pending = h.nodes.preview.listeners.click();
  assert.equal(h.requests[0].items[0].event_date_local, '2026-09-10'); h.resolve(); await pending;
  assert.equal(h.nodes.commit.disabled, false);
  h.edit('event_date_local', '20240229'); assert.equal(h.fields.event_date_local.value, '2024-02-29');
  h.edit('event_date_local', '2026-09-15'); assert.equal(h.nodes.commit.disabled, true);
});

test('admin requires an explicit rating and ignores preview responses after an edit clears it', async () => {
  const h = harness(); h.edit('event_date_local', '20260910');
  await h.nodes.preview.listeners.click(); assert.equal(h.requests.length, 0); assert.match(h.nodes.status.textContent, /请选择晚霞等级/);
  h.edit('rating', 'good'); const pending = h.nodes.preview.listeners.click();
  h.edit('rating', ''); h.resolve(); await pending;
  assert.equal(h.nodes.commit.disabled, true);
  await h.nodes.commit.listeners.click(); assert.equal(h.requests.length, 1);
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

test('admin accepts separated dates and synchronizes calendar selections with the submitted date', async () => {
  const h = harness();
  for (const [value, expected] of [['2026.09.05','2026-09-05'],['2026.9.5','2026-09-05'],['2026-09-08','2026-09-08'],['2026-9-8','2026-09-08'],['2026/09/08','2026-09-08'],['2026/9/8','2026-09-08']]) {
    h.edit('event_date_local', value); h.fields.event_date_local.listeners.blur();
    assert.equal(h.fields.event_date_local.value, expected); assert.equal(h.picker.value, expected);
  }
  h.fields.rating.value = 'good';
  for (const invalid of ['2026.2.29','2026/4/31','2026-9/8']) {
    h.edit('event_date_local', invalid); await h.nodes.preview.listeners.click(); assert.equal(h.requests.length, 0);
  }
  h.picker.value = '2026-09-12'; h.picker.listeners.change(); assert.equal(h.fields.event_date_local.value, '2026-09-12');
  const pending = h.nodes.preview.listeners.click(); h.resolve(); await pending;
  assert.equal(h.requests[0].items[0].event_date_local, '2026-09-12');
  h.picker.value = '2026-09-13'; h.picker.listeners.change(); assert.equal(h.nodes.commit.disabled, true);
});
