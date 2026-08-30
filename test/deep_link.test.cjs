const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

function boot(href) {
  const queries = [];
  const replacements = [];
  const location = { href };
  let submit;
  const document = {
    readyState: 'complete',
    getElementById() { return null; },
    addEventListener() {}
  };
  const history = {
    state: { preserved: true },
    replaceState(state, title, nextHref) {
      replacements.push({ state, title, href: String(nextHref) });
      location.href = String(nextHref);
    }
  };
  const runtime = createRuntime({ document, location, history });
  runtime.sandbox.SunsetScore = {
    citySearch: {
      normalize(value) {
        return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/，/g, ',');
      }
    },
    citySearchUi: {
      init(onSearch) {
        submit = onSearch;
        return { setQuery(query) { queries.push(query); } };
      }
    },
    prediction: { predict: async () => ({ city: 'fixture' }) },
    ui: {
      toggleDetails() {}, beginPrediction() {}, setLoading() {}, renderResult() {},
      showError() {}, endPrediction() {}
    }
  };
  load(runtime, ['js/app.js']);
  return { queries, replacements, location, submit };
}

test('city deep link is decoded, normalized and submitted through citySearchUi.setQuery', () => {
  assert.deepEqual(boot('https://sunsetscore.ky-ok.com/?city=%E6%B7%B1%E5%9C%B3').queries, ['深圳']);
  assert.deepEqual(boot('https://sunsetscore.ky-ok.com/?city=%20Shenzhen%20').queries, ['Shenzhen']);
  assert.deepEqual(boot('https://sunsetscore.ky-ok.com/?city=22.54%EF%BC%8C114.06').queries, ['22.54,114.06']);
});

test('missing, empty, oversized or invalid deep-link values do not start a query', () => {
  assert.deepEqual(boot('https://sunsetscore.ky-ok.com/').queries, []);
  assert.deepEqual(boot('https://sunsetscore.ky-ok.com/?source=深圳').queries, []);
  assert.deepEqual(boot('https://sunsetscore.ky-ok.com/?city=%20%20').queries, []);
  assert.deepEqual(boot('https://sunsetscore.ky-ok.com/?city=' + 'a'.repeat(61)).queries, []);
  assert.deepEqual(boot('not a valid URL').queries, []);
});

test('each submitted city keeps the user-entered URL term without reloading or dropping other URL state', async () => {
  const harness = boot('https://sunsetscore.ky-ok.com/?debug=1&city=深圳#details');

  await harness.submit('北京市', { name: '北京市', latitude: 39.9, longitude: 116.4 }, '北京');
  let current = new URL(harness.location.href);
  assert.equal(current.searchParams.get('city'), '北京');
  assert.equal(current.searchParams.get('debug'), '1');
  assert.equal(current.hash, '#details');
  assert.deepEqual(harness.replacements[0].state, { preserved: true });

  await harness.submit('New York', { name: 'New York', latitude: 40.71, longitude: -74.01 }, 'new york');
  current = new URL(harness.location.href);
  assert.equal(current.searchParams.get('city'), 'new york');
  assert.equal(harness.replacements.length, 2);
});
