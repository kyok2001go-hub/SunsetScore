const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

function element() {
  return {
    textContent: '', attrs: {}, style: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; }
  };
}

test('feedback modal confirms the result city only and its local prediction date', () => {
  const nodes = {
    'feedback-modal': element(),
    'feedback-modal-city': element(),
    'feedback-modal-date': element()
  };
  const result = { city: 'New York', admin1: 'New York', country: 'United States', date: '2026-08-30' };
  const document = { body: { style: {} }, getElementById: id => nodes[id] || null };
  const runtime = createRuntime({ document });
  runtime.sandbox.SunsetScore = { ui: {
    getCurrentResult: () => result,
    show: node => { node.shown = true; },
    hide: node => { node.hidden = true; }
  } };
  const SS = load(runtime, ['js/feedback_ui.js']);

  SS.feedbackUi.open();

  assert.equal(nodes['feedback-modal-city'].textContent, 'New York');
  assert.doesNotMatch(nodes['feedback-modal-city'].textContent, /United States|·/);
  assert.equal(nodes['feedback-modal-date'].textContent, '2026年8月30日');
  assert.equal(nodes['feedback-modal-date'].attrs.datetime, '2026-08-30');
  assert.equal(nodes['feedback-modal'].shown, true);
});
