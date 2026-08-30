const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');
const FILES = ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/data.js', 'js/city_search.js'];
const xiamen = { id: 1790645, name: '厦门市', feature_code: 'PPLA2', admin1: '福建省', country: '中国',
  country_code: 'CN', latitude: 24.47979, longitude: 118.08187, timezone: 'Asia/Shanghai', population: 4617251 };
const domestic = { ...xiamen, id: 'qweather:101230201', source: 'qweather', feature_code: 'QW_CITY', coordinate_system: 'WGS84', rank: 20 };
const foreign = { ...xiamen, id: 99, name: 'London', country: '英国', country_code: 'GB' };

test('QWeather mainland candidates win, exclude mainland Open-Meteo and direct geocode reuses the candidate', async () => {
  const queries = [];
  const SS = load(createRuntime({ fetch: async (url) => {
    const query = new URL(url, 'https://example.test');
    if (query.pathname === '/api/geocoding') {
      assert.equal(query.searchParams.get('lang'), 'zh');
      queries.push(query.searchParams.get('q')); return Response.json({ results: [domestic, domestic] });
    }
    queries.push(query.searchParams.get('name'));
    assert.equal(query.searchParams.get('count'), '50');
    assert.equal(query.searchParams.get('language'), 'zh');
    return Response.json({ results: [xiamen, foreign] });
  } }), FILES);
  const candidates = await SS.citySearch.search('　厦门　');
  assert.deepEqual(queries.sort(), ['厦门', '厦门', '厦门市']);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].id, domestic.id);
  const resolved = await SS.data.geocode('厦门');
  assert.equal(resolved.id, candidates[0].id);
  assert.equal(queries.length, 3, 'reuse candidate cache, not a second name resolution');
  assert.equal(SS.citySearch.label(resolved), '厦门市 · 福建省 · 中国');
  assert.deepEqual(Array.from(SS.citySearch.variants('厦门市')), ['厦门市', '厦门']);
  assert.deepEqual(Array.from(SS.citySearch.variants('厦门，福建')), ['厦门,福建', '厦门市,福建']);
});

test('province-only input never resolves to the Guangxi Fujian namesake or guesses a provincial capital', async () => {
  let calls = 0;
  const SS = load(createRuntime({ fetch: async () => { calls++; return Response.json({ results: [xiamen] }); } }), FILES);
  for (const name of ['福建', '福建省', 'Fujian', 'Fujian Province', '广西壮族自治区', '廣西壯族自治區', '浙江', '台湾省']) {
    assert.equal(SS.citySearch.hint(name), '请输入具体城市名称，不支持仅按省份预测。');
    assert.equal((await SS.citySearch.search(name)).length, 0, name);
    await assert.rejects(SS.data.geocode(name), /具体城市/);
  }
  assert.equal(calls, 0);
  await SS.citySearch.search('北京');
  assert.ok(calls > 0, 'municipalities must remain searchable');
});

test('city policy excludes administrative regions, villages, historical places and malformed coordinates', () => {
  const SS = load(createRuntime(), FILES);
  const rows = ['ADM1', 'ADM2', 'PPLA4', 'PPLA5', 'PPLH', 'PPLX', 'PPLL', 'toString', '__proto__', undefined]
    .map((feature_code, i) => ({ ...xiamen, id: i + 1, feature_code }));
  rows.push({ ...xiamen, id: 99, feature_code: 'PPL', population: undefined });
  for (const latitude of [null, '24', NaN, Infinity, 91]) rows.push({ ...xiamen, latitude });
  assert.equal(SS.citySearch.select(rows, '厦门').length, 0);
  const accepted = ['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLG', 'PPL'].map((feature_code, id) => ({ ...xiamen, id: id + 1, feature_code }));
  assert.equal(SS.citySearch.select(accepted, '厦门').length, 6);
  assert.ok(SS.citySearch.toLocation({ ...xiamen, latitude: 0, longitude: 0 }));
});

test('candidate ranking preserves distinct homonyms and prioritizes exact names in either script', () => {
  const SS = load(createRuntime(), FILES);
  const largerPrefix = { ...xiamen, id: 100, name: '厦门新区', population: 9999999 };
  const tiny = { ...xiamen, id: 101, name: 'Xiamen', feature_code: 'PPL', population: 12000, admin1: '山西' };
  assert.equal(SS.citySearch.select([largerPrefix, xiamen], '厦门')[0].id, xiamen.id);
  assert.equal(SS.citySearch.select([tiny, xiamen], 'Xiamen')[0].id, tiny.id);
  const namesakes = [{ ...xiamen, id: 201, name: 'Springfield' }, { ...xiamen, id: 202, name: 'Springfield', longitude: 10 }];
  assert.equal(SS.citySearch.select(namesakes, 'Springfield').length, 2);
  assert.equal(SS.citySearch.select([...namesakes, namesakes[0]], 'Springfield').length, 2);
});

test('Open-Meteo requests result labels in the query language', async () => {
  const languages = [];
  const SS = load(createRuntime({ fetch: async url => {
    languages.push(new URL(url).searchParams.get('language'));
    return Response.json({ results: [] });
  } }), FILES);
  await SS.data.searchLocations('new york');
  await SS.data.searchLocations('纽约');
  assert.deepEqual(languages, ['en', 'zh']);
});

test('domestic geocoding requests result labels in the query language and separates cache URLs', async () => {
  const requests = [];
  const SS = load(createRuntime({ fetch: async url => {
    requests.push(new URL(url, 'https://example.test'));
    return Response.json({ results: [] });
  } }), FILES);
  await SS.data.searchDomesticLocations('new york');
  await SS.data.searchDomesticLocations('纽约');
  assert.deepEqual(requests.map(url => url.searchParams.get('lang')), ['en', 'zh']);
  assert.deepEqual(requests.map(url => url.searchParams.get('q')), ['new york', '纽约']);
});

test('empty and single-character keywords do not request; empty results remain retryable', async () => {
  let calls = 0;
  const SS = load(createRuntime({ fetch: async () => { calls++; return Response.json({ results: [] }); } }), FILES);
  for (const q of ['', ' ', '厦', 'x']) assert.equal((await SS.citySearch.search(q)).length, 0);
  assert.equal(calls, 0);
  await SS.citySearch.search('Xiamen');
  await SS.citySearch.search('Xiamen');
  assert.equal(calls, 4);
});

test('domestic failures are not no-match and partial foreign fallback must not poison the cache', async () => {
  let calls = 0, recovered = false;
  const SS = load(createRuntime({ fetch: async (url) => {
    calls++;
    if (new URL(url, 'https://example.test').pathname !== '/api/geocoding') return Response.json({ results: [] });
    if (!recovered) throw new TypeError('offline');
    return Response.json({ results: [domestic] });
  } }), FILES);
  await assert.rejects(SS.citySearch.search('厦门'), /offline/);
  recovered = true;
  assert.equal((await SS.citySearch.search('厦门')).length, 1);
  assert.equal(calls, 6);
  SS.data.searchDomesticLocations = async () => { throw new Error('temporary'); };
  SS.data.searchLocations = async () => [xiamen, foreign];
  const fallback = await SS.citySearch.search('深圳');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, foreign.id);
  assert.equal(fallback.requiresSelection, true);
  await assert.rejects(SS.citySearch.resolve('深圳'), /国内城市检索暂不可用/);
  let retried = 0;
  SS.data.searchDomesticLocations = async () => { retried++; return [domestic]; };
  assert.equal((await SS.citySearch.search('深圳'))[0].id, domestic.id);
  assert.equal(retried, 1);
});

test('cancelled search cannot write late candidates to cache even if transport ignores cancellation', async () => {
  const SS = load(createRuntime(), FILES);
  let complete;
  SS.data.searchDomesticLocations = () => new Promise(resolve => { complete = resolve; });
  SS.data.searchLocations = async () => [];
  const controller = new AbortController();
  const pending = SS.citySearch.search('Xiamen', { signal: controller.signal });
  controller.abort();
  complete([domestic]);
  await assert.rejects(pending, { name: 'AbortError' });
  let calls = 0;
  SS.data.searchDomesticLocations = async () => { calls++; return [domestic]; };
  await SS.citySearch.search('Xiamen');
  assert.equal(calls, 1);
});

test('candidate cache is bounded, expires, and cannot be mutated by a caller', async () => {
  let now = 1000, calls = 0;
  class Clock extends Date { static now() { return now; } }
  const SS = load(createRuntime({ Date: Clock }), FILES);
  SS.config.citySearch.maxCacheEntries = 2;
  SS.data.searchDomesticLocations = async () => { calls++; return [domestic]; };
  SS.data.searchLocations = async () => [];
  const first = await SS.citySearch.search('Xiamen');
  first[0].latitude = 1;
  assert.equal((await SS.citySearch.search('Xiamen'))[0].latitude, xiamen.latitude);
  assert.equal(calls, 1);
  now += 300001;
  await SS.citySearch.search('Xiamen');
  assert.equal(calls, 2);
  await SS.citySearch.search('London'); await SS.citySearch.search('Paris'); await SS.citySearch.search('Xiamen');
  assert.equal(calls, 5);
});

test('invalid geocoding payloads surface service errors instead of pretending there are no candidates', async () => {
  const SS = load(createRuntime({ fetch: async () => Response.json({ results: 'wrong type' }) }), FILES);
  await assert.rejects(SS.citySearch.search('Xiamen'), /服务返回异常/);
});

test('Xuchang Chinese and pinyin resolve to QWeather Xuchang, never Jiangguanchi', async () => {
  const SS = load(createRuntime(), FILES);
  const xuchang = { ...domestic, id: 'qweather:101180401', name: '许昌', admin1: '河南省', admin2: '许昌' };
  SS.data.searchDomesticLocations = async query => [{ ...xuchang,
    name: /[\u3400-\u9fff]/.test(query) ? xuchang.name : 'Xuchang' }];
  SS.data.searchLocations = async () => [{ ...xiamen, id: 1788046, name: '将官池', admin2: '许昌市' }];
  for (const q of ['许昌', '许昌市', 'xuchang']) {
    const found = await SS.citySearch.resolve(q);
    assert.equal(found.name, /[\u3400-\u9fff]/.test(q) ? '许昌' : 'Xuchang'); assert.equal(found.id, xuchang.id);
    assert.equal(SS.citySearch.toLocation(found).id, found.id, 'selection survives validation');
  }
});

test('domestic rank direction and homonym IDs remain separate; overseas-only results work', async () => {
  const SS = load(createRuntime(), FILES);
  const same = { ...domestic, id: 'qweather:other', rank: 50, longitude: 110 };
  assert.equal(SS.citySearch.select([same, domestic], 'xiamen')[0].id, domestic.id);
  assert.equal(SS.citySearch.select([same, domestic], '厦门').length, 2);
  SS.data.searchDomesticLocations = async () => [];
  SS.data.searchLocations = async () => [foreign];
  assert.equal((await SS.citySearch.resolve('London')).id, foreign.id);
});

test('foreign failure leaves domestic direct search usable, not cached as complete', async () => {
  const SS = load(createRuntime(), FILES);
  SS.data.searchDomesticLocations = async () => [{ ...domestic, name: 'Xiamen' }];
  let calls = 0;
  SS.data.searchLocations = async () => { calls++; throw new Error('foreign offline'); };
  assert.equal((await SS.citySearch.resolve('xiamen')).id, domestic.id);
  const found = await SS.citySearch.search('xiamen');
  assert.equal(found.partial, true); assert.equal(found.requiresSelection, false); assert.equal(calls, 2);
});

test('English exact city names outrank unrelated domestic fuzzy results, including New York', async () => {
  const SS = load(createRuntime(), FILES);
  const liangjiang = { ...domestic, id: 'qweather:101040800', name: 'Liangjiang New Area',
    admin1: 'Chongqing', admin2: 'Chongqing', latitude: 29.63, longitude: 106.56 };
  const newYork = { ...foreign, id: 5128581, name: 'New York', country: 'United States', country_code: 'US',
    admin1: 'New York', latitude: 40.71427, longitude: -74.00597, population: 8804190 };
  SS.data.searchDomesticLocations = async () => [liangjiang];
  SS.data.searchLocations = async () => [newYork];
  const found = await SS.citySearch.resolve('new york');
  assert.equal(found.id, newYork.id);
  assert.equal(found.country_code, 'US');

  SS.data.searchLocations = async () => { throw new Error('foreign offline'); };
  const partial = await SS.citySearch.search('new york city');
  assert.equal(partial[0].id, liangjiang.id);
  assert.equal(partial.requiresSelection, true);
  await assert.rejects(SS.citySearch.resolve('new york city'), /近似候选/);
});

test('broad fuzzy or translated Chinese matches require explicit confirmation, including from cache', async () => {
  const SS = load(createRuntime(), FILES);
  SS.data.searchDomesticLocations = async () => [domestic];
  SS.data.searchLocations = async () => [];
  const found = await SS.citySearch.search('不存在的城市测试');
  assert.equal(found.requiresSelection, true);
  found.requiresSelection = false;
  await assert.rejects(SS.citySearch.resolve('不存在的城市测试'), /近似候选/);
});

const sanFrancisco = { ...foreign, id: 5391959, name: '旧金山', country: '美国', country_code: 'US',
  admin1: '加州', admin2: 'City and County of San Francisco', latitude: 37.77493, longitude: -122.41942, population: 827526 };
const zhoushan = { ...domestic, id: 'qweather:101211101', name: '舟山', admin1: '浙江省', admin2: '舟山',
  latitude: 29.98798, longitude: 122.20323, rank: 23 };
const taipei = { ...foreign, id: 1668341, name: '台北市', admin1: '臺灣省 or 台灣省', admin2: '臺北市',
  country: '台湾', country_code: 'TW', latitude: 25.05306, longitude: 121.52639, timezone: 'Asia/Taipei' };

test('San Francisco aliases outrank domestic fuzzy Zhoushan; selection keeps upstream US identity and coordinates', async () => {
  const SS = load(createRuntime(), FILES);
  SS.data.searchDomesticLocations = async () => [zhoushan];
  SS.data.searchLocations = async () => [sanFrancisco];
  for (const query of ['旧金山', '旧金山市', '舊金山', 'San Francisco', 'san francisco']) {
    const found = await SS.citySearch.resolve(query);
    assert.equal(found.id, 5391959, query); assert.equal(found.source, 'openmeteo');
    assert.equal(found.country_code, 'US'); assert.equal(found.latitude, sanFrancisco.latitude);
    assert.equal(found.longitude, sanFrancisco.longitude);
  }
});

test('known overseas aliases cannot silently fall back to an unrelated domestic city when foreign source fails', async () => {
  const SS = load(createRuntime(), FILES);
  SS.data.searchDomesticLocations = async () => [zhoushan];
  SS.data.searchLocations = async () => { throw new Error('offline'); };
  const items = await SS.citySearch.search('San Francisco');
  assert.equal(items.partial, true); assert.equal(items.requiresSelection, true);
  await assert.rejects(SS.citySearch.resolve('San Francisco'), /近似候选/);
  SS.data.searchLocations = async () => [sanFrancisco];
  assert.equal((await SS.citySearch.resolve('San Francisco')).id, 5391959, 'partial failure stays retryable');
});

test('name match quality precedes source priority while equal matches still prefer QWeather', () => {
  const SS = load(createRuntime(), FILES);
  const cn = { ...domestic, name: '同名', admin2: '' };
  const exact = { ...foreign, name: '同名' }, prefix = { ...cn, name: '同名新区' };
  assert.equal(SS.citySearch.select([prefix, exact], '同名')[0].source, 'openmeteo');
  assert.equal(SS.citySearch.select([cn, exact], '同名')[0].source, 'qweather');
});

test('Taipei Chinese/traditional names query an English alias and keep provider coordinates', async () => {
  const SS = load(createRuntime(), FILES);
  const queried = [];
  SS.data.searchDomesticLocations = async () => [];
  SS.data.searchLocations = async query => { queried.push(query); return query === 'Taipei' ? [taipei] : []; };
  for (const query of ['台北', '臺北', '台北市', '臺北市', 'Taipei']) {
    const found = await SS.citySearch.resolve(query);
    assert.equal(found.id, taipei.id, query);
    assert.equal(found.latitude, taipei.latitude); assert.equal(found.longitude, taipei.longitude);
    assert.equal(found.timezone, 'Asia/Taipei');
  }
  assert.equal(queried.filter(q => q === 'Taipei').length, 5);
  assert.deepEqual(Array.from(SS.citySearch.variants('Taipei')), ['Taipei']);
});

test('display removes equivalent script/administrative repetitions without mutating source records', () => {
  const SS = load(createRuntime(), FILES);
  const original = JSON.stringify(taipei);
  assert.equal(SS.citySearch.detail(taipei), '台湾');
  assert.equal(SS.citySearch.label(taipei), '台北市 · 台湾');
  assert.equal(SS.citySearch.title(taipei), '台北市');
  assert.equal(JSON.stringify(taipei), original);
  assert.equal(SS.citySearch.label({ ...taipei, name: '臺北市' }), '台北市 · 台湾');
  assert.equal(SS.citySearch.title(zhoushan), '舟山 · 浙江省');
  assert.equal(SS.citySearch.label({ ...domestic, name: '朝阳', admin2: '北京', admin1: '北京市' }), '朝阳 · 北京 · 中国');
  assert.equal(SS.citySearch.displayName('Area A or Area B'), 'Area A or Area B');
});
