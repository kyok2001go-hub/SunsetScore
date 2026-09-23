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
  for (const id of ['bulk-add', 'bulk-dialog', 'bulk-text', 'bulk-feedback', 'bulk-confirm', 'bulk-cancel']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /\/css\/admin\.css\?v=2\.5\.3\.3-admin4/);
  assert.match(html, /\/js\/admin_backfill\.js\?v=2\.5\.3\.3-admin1/);
  assert.match(html, /<option value="" selected>请选择等级<\/option>/);
  assert.doesNotMatch(html, /<script(?!\s+src=)/i, 'admin page must not require inline scripts under CSP');
});

function harness() {
  const vm = require('node:vm');
  const node = () => ({
    value: '', disabled: false, hidden: false, open: false, listeners: {}, className: '', dataset: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    focus() { this.focused = true; },
    replaceChildren() {},
    appendChild() {},
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    showModal() { this.open = true; },
    close() { this.open = false; }
  });
  const rows = [];
  let pendingRow = null;
  function makeRow() {
    const fields = Object.fromEntries(['city', 'event_date_local', 'rating', 'confidence', 'evidence_count', 'comment'].map(k => {
      const field = node();
      field.matches = selector => selector === '[data-field]' || selector === '[data-field="' + k + '"]';
      return [k, field];
    }));
    const match = node(), slot = node(), remove = node(), row = node(), picker = node();
    row.querySelector = selector => selector === '.date-picker' ? picker
      : selector === '.match-status' ? match
        : selector === '.candidate-slot' ? slot
          : selector === '.remove-row' ? remove
            : fields[/data-field="([^"]+)"/.exec(selector)[1]];
    row.fields = fields;
    row.picker = picker;
    row.remove = () => {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
    };
    return row;
  }
  const nodes = Object.fromEntries([
    'backfill-rows', 'row-template', 'bulk-add', 'bulk-dialog', 'bulk-text', 'bulk-feedback',
    'bulk-confirm', 'bulk-close', 'bulk-cancel', 'add-row', 'preview', 'commit', 'status'
  ].map(k => [k, node()]));
  nodes['backfill-rows'].rows = rows;
  nodes['backfill-rows'].appendChild = () => {
    if (!pendingRow) throw new Error('missing pending row');
    rows.push(pendingRow);
    pendingRow = null;
  };
  nodes['backfill-rows'].replaceChildren = () => { rows.length = 0; };
  nodes['row-template'].content = {
    cloneNode: () => {
      pendingRow = makeRow();
      return { querySelector: () => pendingRow };
    }
  };
  const requests = [];
  let resolvePreview;
  vm.runInNewContext(source('js/admin_backfill.js'), {
    document: { getElementById: id => nodes[id], createElement: node }, crypto: { randomUUID: () => 'test-id' }, window: { confirm: () => true },
    fetch: async (url, options) => { const payload = JSON.parse(options.body); requests.push(payload);
      return new Promise(resolve => { resolvePreview = () => resolve({ ok: true, json: async () => ({ success: true, items: payload.items.map(item => ({ ...item, status: 'matched', candidates: [{ event_id: 'evt', city: '深圳', timezone: 'Asia/Shanghai', latitude: 22, longitude: 114, snapshot_count: 1 }] })) }) }); }); }
  });
  rows[0].fields.city.value = '深圳';
  return {
    nodes,
    requests,
    rows,
    get fields() { return rows[0].fields; },
    get picker() { return rows[0].picker; },
    rowAt(index) { return rows[index]; },
    edit(key, value) {
      const target = rows[0].fields[key];
      target.value = value;
      rows[0].listeners.input({ target });
    },
    resolve: () => resolvePreview()
  };
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

test('admin restores confidence and evidence values above their maximums', () => {
  const h = harness();
  h.edit('confidence', '1.25');
  h.edit('evidence_count', '10001');
  assert.equal(h.fields.confidence.value, '1');
  assert.equal(h.fields.evidence_count.value, '10000');
  h.edit('confidence', '0.75');
  h.edit('evidence_count', '9999');
  assert.equal(h.fields.confidence.value, '0.75');
  assert.equal(h.fields.evidence_count.value, '9999');
  h.edit('confidence', '');
  h.edit('evidence_count', '');
  assert.equal(h.fields.confidence.value, '');
  assert.equal(h.fields.evidence_count.value, '');
});

test('admin bulk import maps fields, preserves comment commas and warns without requests', async () => {
  const h = harness();
  h.nodes['bulk-add'].listeners.click();
  assert.equal(h.nodes['bulk-dialog'].open, true);
  h.nodes['bulk-text'].value = [
    '深圳，2026.9.5，2，0.9，3，今天晚霞还行',
    '广州,2026-09-06,4,,,晚霞不错，云层,也很漂亮',
    '北京,invalid,9,0.999,1.5,备注',
    '上海,20260907,0,1.00,10000,边界',
    '',
    ',,,,,'
  ].join('\n');

  await h.nodes['bulk-confirm'].listeners.click();

  assert.equal(h.requests.length, 0);
  assert.equal(h.rows.length, 4);
  assert.deepEqual(h.rowAt(0).fields.city.value, '深圳');
  assert.equal(h.rowAt(0).fields.event_date_local.value, '2026-09-05');
  assert.equal(h.rowAt(0).fields.rating.value, 'good');
  assert.equal(h.rowAt(0).fields.confidence.value, '0.9');
  assert.equal(h.rowAt(0).fields.evidence_count.value, '3');
  assert.equal(h.rowAt(0).fields.comment.value, '今天晚霞还行');
  assert.equal(h.rowAt(1).fields.rating.value, 'excellent');
  assert.equal(h.rowAt(1).fields.comment.value, '晚霞不错，云层,也很漂亮');
  assert.equal(h.rowAt(2).fields.event_date_local.value, '');
  assert.equal(h.rowAt(2).fields.rating.value, '');
  assert.equal(h.rowAt(2).fields.confidence.value, '');
  assert.equal(h.rowAt(2).fields.evidence_count.value, '');
  assert.equal(h.rowAt(3).fields.rating.value, 'poor');
  assert.equal(h.rowAt(3).fields.confidence.value, '1');
  assert.equal(h.rowAt(3).fields.evidence_count.value, '10000');
  assert.match(h.nodes['bulk-feedback'].textContent, /第 3 行/);
  assert.match(h.nodes['bulk-feedback'].textContent, /日期格式无效/);
  assert.match(h.nodes['bulk-feedback'].textContent, /等级必须是 0-4/);
  assert.match(h.nodes['bulk-feedback'].textContent, /置信度必须是 0-1/);
  assert.match(h.nodes['bulk-feedback'].textContent, /证据数必须是 0-10000/);
  assert.equal(h.nodes.commit.disabled, true);
  assert.equal(h.nodes['bulk-dialog'].open, true);
});

test('admin bulk import truncates after empty filtering and reports ignored rows', async () => {
  const h = harness();
  h.nodes['bulk-add'].listeners.click();
  h.nodes['bulk-text'].value = Array.from({ length: 22 }, (_, index) =>
    '城市' + index + ',2026.9.' + String(index + 1).padStart(2, '0') + ',2,0.9,1,备注' + index
  ).join('\n');

  await h.nodes['bulk-confirm'].listeners.click();

  assert.equal(h.requests.length, 0);
  assert.equal(h.rows.length, 20);
  assert.equal(h.rowAt(0).fields.city.value, '城市0');
  assert.equal(h.rowAt(19).fields.city.value, '城市19');
  assert.match(h.nodes['bulk-feedback'].textContent, /识别到 22 条/);
  assert.match(h.nodes['bulk-feedback'].textContent, /忽略后 2 条/);
  assert.equal(h.nodes['bulk-dialog'].open, true);
});

test('admin bulk import is local, supports zero rows and cancel leaves current rows unchanged', async () => {
  const h = harness();
  h.nodes['bulk-add'].listeners.click();
  h.nodes['bulk-text'].value = '临时内容';
  h.nodes['bulk-cancel'].listeners.click();
  assert.equal(h.nodes['bulk-dialog'].open, false);
  assert.equal(h.rows.length, 1);
  assert.equal(h.fields.city.value, '深圳');
  assert.equal(h.requests.length, 0);

  h.nodes['bulk-add'].listeners.click();
  h.nodes['bulk-text'].value = '\n,,，\n';
  await h.nodes['bulk-confirm'].listeners.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.fields.city.value, '');
  assert.equal(h.fields.rating.value, '');
  assert.match(h.nodes.status.textContent, /未识别到可导入数据/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.nodes['bulk-dialog'].open, true);
});

test('admin bulk import sends the existing preview request only after a valid import', async () => {
  const h = harness();
  h.nodes['bulk-text'].value = '深圳,2026.9.10,2,0.9,3,批量导入';
  await h.nodes['bulk-confirm'].listeners.click();

  assert.equal(h.requests.length, 0);
  assert.equal(h.nodes['bulk-dialog'].open, false);
  assert.equal(h.nodes['bulk-text'].value, '');
  const pending = h.nodes.preview.listeners.click();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].items[0].city, '深圳');
  assert.equal(h.requests[0].items[0].rating, 'good');
  h.resolve();
  await pending;
});

test('administrator UI keeps untrusted content on text-only DOM paths', () => {
  const script = source('js/admin_backfill.js');
  const css = source('css/admin.css');
  assert.match(script, /const MAX_ROWS = 20/);
  assert.match(script, /mode: 'preview'/);
  assert.match(script, /mode: 'commit'/);
  assert.match(script, /crypto\.randomUUID/);
  assert.match(script, /renderCommitFailure/);
  assert.match(script, /not_committed/);
  assert.match(script, /textContent/);
  assert.match(script, /replaceChildren/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(css, /\.remove-row\s*\{[^}]*white-space:\s*nowrap/);
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
