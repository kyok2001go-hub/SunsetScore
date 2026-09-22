const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

function makeElement(classes = []) {
  const classNames = new Set(classes);
  const listeners = {};
  return {
    textContent: '',
    attributes: {},
    classList: {
      contains(name) { return classNames.has(name); },
      toggle(name, active) { active ? classNames.add(name) : classNames.delete(name); }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, listener) { listeners[name] = listener; },
    dispatch(name) { listeners[name](); }
  };
}

function boot() {
  let cardTop = 1;
  let scrollOptions = null;
  let focusOptions = null;
  const windowListeners = {};
  const elements = {
    'sticky-prediction-summary': makeElement(),
    'sticky-summary-score': makeElement(),
    'sticky-summary-city': makeElement(),
    'sticky-summary-date': makeElement(),
    'sticky-summary-search': makeElement(),
    'city-input': { focus(options) { focusOptions = options; } }
  };
  const card = { getBoundingClientRect() { return { top: cardTop }; } };
  elements.result = makeElement();
  elements.result.querySelector = () => card;
  const document = { getElementById(id) { return elements[id] || null; } };
  const runtime = createRuntime({
    document,
    addEventListener(name, listener) { windowListeners[name] = listener; },
    requestAnimationFrame(callback) { callback(); },
    matchMedia() { return { matches: false }; },
    scrollTo(options) { scrollOptions = options; }
  });
  const summary = load(runtime, ['js/sticky_summary.js']).stickySummary;
  summary.init();
  return {
    summary,
    elements,
    windowListeners,
    setCardTop(value) { cardTop = value; },
    getScrollOptions() { return scrollOptions; },
    getFocusOptions() { return focusOptions; }
  };
}

test('sticky summary appears exactly when the result card reaches the viewport top', () => {
  const page = boot();
  assert.equal(page.elements['sticky-prediction-summary'].attributes['aria-hidden'], 'true');

  page.setCardTop(0);
  page.windowListeners.scroll();
  assert.equal(page.elements['sticky-prediction-summary'].attributes['aria-hidden'], 'false');
  assert.equal(page.elements['sticky-prediction-summary'].classList.contains('is-visible'), true);

  page.setCardTop(0.5);
  page.windowListeners.scroll();
  assert.equal(page.elements['sticky-prediction-summary'].classList.contains('is-visible'), false);
});

test('sticky summary syncs prediction details and its search action returns and focuses', () => {
  const page = boot();
  page.summary.setData({ score: 41, city: '深圳', date: '2026-09-22' }, '深圳 · 广东省 · 中国');
  assert.equal(page.elements['sticky-summary-score'].textContent, '41');
  assert.equal(page.elements['sticky-summary-city'].textContent, '深圳 · 广东省 · 中国');
  assert.equal(page.elements['sticky-summary-date'].textContent, '2026-09-22');
  assert.equal(page.elements['sticky-summary-date'].attributes.datetime, '2026-09-22');

  page.elements['sticky-summary-search'].dispatch('click');
  assert.equal(page.getScrollOptions().top, 0);
  assert.equal(page.getScrollOptions().behavior, 'smooth');
  assert.equal(page.getFocusOptions().preventScroll, true);
});
