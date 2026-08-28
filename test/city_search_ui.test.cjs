const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

// Minimal DOM/event harness; no browser, network or new production dependencies.
class Element {
  constructor(id = '') { Object.assign(this, { id, children: [], listeners: {}, attrs: {}, dataset: {}, hidden: false, value: '' }); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, props = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (const fn of this.listeners[name] || []) fn(event);
    return event;
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  closest() { return this.attrs.role === 'option' ? this : this.parent?.closest(); }
  find(id) { return this.id === id ? this : this.children.map(child => child.find(id)).find(Boolean); }
  blur() { this.blurred = true; }
  focus() { this.focused = true; this.emit('focus'); }
  scrollIntoView() { this.scrolled = true; }
}
const candidates = [
  { id: 1, name: '厦门市', admin1: '福建省', country: '中国', latitude: 24.48, longitude: 118.08, feature_code: 'PPLA2' },
  { id: 2, name: '同名城市', admin1: '另一地区', country: '中国', latitude: 30, longitude: 120, feature_code: 'PPLA2' }
];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(search = async () => candidates) {
  const doc = new Element('document');
  const form = new Element('search-form'), input = new Element('city-input'), field = new Element('city-search-field');
  const panel = new Element('city-suggestions'), list = new Element('city-options'), status = new Element('city-search-status');
  const clear = new Element('city-clear');
  doc.append(form); form.append(field); field.append(input, clear, panel); panel.append(list, status); panel.hidden = true;
  doc.getElementById = id => doc.find(id);
  doc.createElement = () => new Element();
  let nextTimer = 0;
  const timers = new Map(), requests = [], predictions = [];
  const SS = load(createRuntime({ document: doc,
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  }), ['js/config.js', 'js/city_search.js', 'js/city_search_ui.js']);
  SS.citySearch.search = (query, options) => { requests.push({ query, signal: options.signal }); return search(query, options); };
  SS.prediction = { parseCoordinates: q => q === '22.54,114.06' ? { latitude: 22.54, longitude: 114.06 } : null };
  const ui = SS.citySearchUi.init((query, location) => predictions.push({ query, location }));
  function tick(delay = 300) {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
  }
  function type(value) { input.value = value; input.emit('input'); }
  return { doc, form, input, clear, panel, list, status, ui, tick, type, requests, predictions };
}

test('typing debounces and direct submit uses the visible first candidate without another lookup', async () => {
  const h = setup();
  h.type('厦'); h.type('厦门');
  assert.equal(h.requests.length, 0);
  h.tick(); await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].query, '厦门');
  assert.equal(h.list.children[0].children[0].textContent, '厦门市');
  assert.equal(h.input.attrs['aria-expanded'], 'true');
  await h.ui.submit();
  assert.equal(h.requests.length, 1);
  assert.equal(h.predictions[0].location.id, 1);
  assert.equal(h.panel.hidden, true);
  assert.equal(h.input.blurred, true);
});

test('clicking a second candidate retains its exact location on repeat search; touch scroll does not select', async () => {
  const h = setup(); h.type('厦门'); h.tick(); await flush();
  const label = h.list.children[1].children[0];
  const touch = h.list.emit('pointerdown', { target: label, pointerType: 'touch' });
  assert.equal(touch.defaultPrevented, false);
  assert.equal(h.predictions.length, 0);
  assert.equal(h.list.emit('pointerdown', { target: label, pointerType: 'mouse' }).defaultPrevented, true);
  h.list.emit('click', { target: label });
  assert.equal(h.predictions[0].location.id, 2);
  await h.ui.submit();
  assert.equal(h.predictions[1].location.id, 2);
  assert.equal(h.requests.length, 1);
  assert.match(h.input.value, /另一地区/);
});

test('Chinese composition and composition-confirm Enter do not issue premature queries or predictions', async () => {
  const h = setup(); h.input.emit('compositionstart'); h.type('xia'); h.tick();
  const event = h.input.emit('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  await h.ui.submit();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.requests.length, 0);
  h.input.value = '厦门'; h.input.emit('compositionend');
  await h.ui.submit();
  assert.equal(h.predictions.length, 0);
  h.tick(0); h.tick(); await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].query, '厦门');
  await h.ui.submit();
  assert.equal(h.predictions.length, 1);
});

test('changing input aborts the pending lookup and its late reply cannot render or start a prediction', async () => {
  const replies = [];
  const h = setup(() => new Promise(resolve => replies.push(resolve)));
  h.type('旧城'); const oldSubmit = h.ui.submit();
  h.type('新城'); h.tick();
  assert.equal(h.requests[0].signal.aborted, true);
  replies[1]([candidates[1]]); await flush();
  replies[0]([candidates[0]]); await oldSubmit; await flush();
  assert.equal(h.list.children[0].children[0].textContent, '同名城市');
  assert.equal(h.predictions.length, 0);
  await h.ui.submit();
  assert.equal(h.predictions[0].location.id, 2);
});

test('keyboard selection exposes the active option; Escape and outside focus dismiss without late reopening', async () => {
  const h = setup(); h.type('厦门'); h.tick(); await flush();
  h.input.emit('keydown', { key: 'ArrowDown' });
  h.input.emit('keydown', { key: 'ArrowDown' });
  assert.equal(h.input.attrs['aria-activedescendant'], 'city-option-1');
  assert.equal(h.list.children[1].attrs['aria-selected'], 'true');
  assert.equal(h.list.children[1].scrolled, true);
  h.input.emit('keydown', { key: 'Enter' });
  assert.equal(h.predictions[0].location.id, 2);
  h.type('厦门'); h.tick(); await flush();
  h.input.emit('keydown', { key: 'Escape' }); assert.equal(h.panel.hidden, true);
  h.input.emit('focus'); await flush();
  h.doc.emit('focusin', { target: h.form }); assert.equal(h.panel.hidden, true);
  let finish;
  const late = setup(() => new Promise(resolve => { finish = resolve; }));
  late.type('厦门'); late.tick(); late.doc.emit('pointerdown');
  finish(candidates); await flush(); assert.equal(late.panel.hidden, true);
});

test('no matches and lookup errors do not forecast; a failed submit can be retried', async () => {
  let attempts = 0;
  const h = setup(async () => {
    if (++attempts === 1) throw new Error('offline');
    return candidates;
  });
  h.type('厦门'); await h.ui.submit();
  assert.match(h.status.textContent, /暂时失败/);
  assert.equal(h.predictions.length, 0);
  await h.ui.submit(); assert.equal(h.predictions.length, 1);
  const empty = setup(async () => []); empty.type('福建'); await empty.ui.submit();
  assert.match(empty.status.textContent, /具体城市/);
  assert.equal(empty.predictions.length, 0);
});

test('submit during lookup shares its request, ignores double submit, and coordinates bypass city matching', async () => {
  let finish;
  const h = setup(() => new Promise(resolve => { finish = resolve; }));
  h.type('厦门'); h.tick();
  const first = h.ui.submit(), second = h.ui.submit();
  assert.equal(h.requests.length, 1);
  finish(candidates); await Promise.all([first, second]);
  assert.equal(h.predictions.length, 1);
  await h.ui.setQuery('22.54,114.06');
  assert.equal(h.requests.length, 1);
  assert.equal(h.predictions[1].query, '22.54,114.06');
  assert.equal(h.predictions[1].location, undefined);
});

test('domestic outage warns and prevents automatic foreign selection but allows explicit click and retry', async () => {
  let recovered = false;
  const partial = Object.assign([candidates[1]], { partial: true, requiresSelection: true, warning: '国内城市检索暂不可用' });
  const h = setup(async () => recovered ? candidates : partial);
  h.type('厦门'); await h.ui.submit();
  assert.equal(h.predictions.length, 0);
  assert.match(h.status.textContent, /国内城市检索暂不可用/);
  h.list.emit('click', { target: h.list.children[0] });
  assert.equal(h.predictions[0].location.id, candidates[1].id);
  h.type('厦门'); await h.ui.submit();
  recovered = true;
  await h.ui.submit();
  assert.equal(h.predictions[1].location.id, candidates[0].id);
});

test('clear toggles with input, cancels debounce, closes suggestions and restores input focus', async () => {
  const h = setup();
  assert.equal(h.clear.hidden, true);
  h.type('厦门'); assert.equal(h.clear.hidden, false);
  h.clear.emit('click'); h.tick(); await flush();
  assert.equal(h.input.value, ''); assert.equal(h.clear.hidden, true);
  assert.equal(h.input.focused, true); assert.equal(h.panel.hidden, true);
  assert.equal(h.list.children.length, 0); assert.equal(h.status.textContent, '');
  assert.equal(h.input.attrs['aria-expanded'], 'false');
  assert.equal(h.requests.length, 0); assert.equal(h.predictions.length, 0);
  await h.ui.submit(); assert.equal(h.requests.length, 0);
  h.type(' '); assert.equal(h.clear.hidden, false);
  h.type(''); assert.equal(h.clear.hidden, true);
});

test('clear aborts an in-flight submit and late results cannot restore candidates or predict', async () => {
  let finish;
  const h = setup(() => new Promise(resolve => { finish = resolve; }));
  h.type('厦门'); const pending = h.ui.submit();
  h.clear.emit('click');
  assert.equal(h.requests[0].signal.aborted, true);
  finish(candidates); await pending; await flush();
  assert.equal(h.input.value, ''); assert.equal(h.panel.hidden, true);
  assert.equal(h.list.children.length, 0); assert.equal(h.predictions.length, 0);
  assert.equal(h.input.attrs['aria-busy'], 'false');
});

test('clear resets chosen/quick-search locations and works after IME composition', async () => {
  const h = setup();
  await h.ui.setQuery('厦门'); assert.equal(h.clear.hidden, false);
  h.clear.emit('click'); await h.ui.submit();
  assert.equal(h.predictions.length, 1, 'empty input must not repeat the previous choice');
  h.input.emit('compositionstart'); h.type('beijing');
  h.clear.emit('click'); h.tick(); h.tick(0); await flush();
  assert.equal(h.input.value, ''); assert.equal(h.panel.hidden, true);
  h.type('北京'); await h.ui.submit();
  assert.equal(h.predictions.length, 2, 'new input must not stay locked in IME mode');
  await h.ui.setQuery('22.54,114.06'); assert.equal(h.clear.hidden, false);
});
