const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

const solarFiles = ['js/vendor/suncalc.js', 'js/solar.js'];
const shenzhen = { latitude: 22.54, longitude: 114.06, timezone: 'Asia/Shanghai' };
function setup(extra) {
  const runtime = createRuntime(extra);
  return { runtime, SS: load(runtime, solarFiles) };
}
function events(runtime, date = '2026-08-28T04:00:00Z', place = shenzhen) {
  return runtime.sandbox.SunCalc.getTimes(new Date(date), place.latitude, place.longitude);
}

test('daylight switches at actual sunrise/sunset, not at a fixed evening hour', () => {
  const { runtime, SS } = setup();
  const day = events(runtime);
  for (const [name, before, after] of [['sunrise', false, true], ['sunset', true, false]]) {
    const time = +day[name];
    assert.equal(SS.solar.isDaytime(time - 1, 22.54, 114.06), before, name + ' before');
    assert.equal(SS.solar.isDaytime(time, 22.54, 114.06), after, name + ' at boundary');
    assert.equal(SS.solar.isDaytime(time + 1, 22.54, 114.06), after, name + ' after');
  }
  assert.equal(SS.solar.isDaytime(Date.parse('2026-08-28T10:39:00Z'), 22.54, 114.06), true);
  assert.equal(SS.solar.isDaytime(Date.parse('2026-08-28T11:09:00Z'), 22.54, 114.06), false);
});

test('each city uses its coordinates and UTC instant, including date line and DST dates', () => {
  const { SS } = setup();
  const cases = [
    ['2026-08-28T04:00:00Z', 22.54, 114.06, true],
    ['2026-08-28T04:00:00Z', 37.77493, -122.41942, false],
    ['2026-08-28T16:00:00Z', 22.54, 114.06, false],
    ['2026-08-28T16:00:00Z', 37.77493, -122.41942, true],
    ['2026-08-28T00:00:00Z', 0, 179, true],
    ['2026-08-28T00:00:00Z', 0, -179, true],
    ['2026-08-28T12:00:00Z', 0, 179, false],
    ['2026-08-28T12:00:00Z', 0, -179, false],
    ['2026-03-08T09:59:00Z', 37.77493, -122.41942, false],
    ['2026-03-08T10:01:00Z', 37.77493, -122.41942, false],
    ['2026-03-08T19:00:00Z', 37.77493, -122.41942, true]
  ];
  for (const [stamp, lat, lon, expected] of cases) assert.equal(SS.solar.isDaytime(Date.parse(stamp), lat, lon), expected, stamp + '/' + lon);
});

test('night survives midnight and polar no-sunset/no-sunrise cases remain explicit', () => {
  const { SS } = setup();
  for (const stamp of ['2026-08-28T15:50:00Z', '2026-08-28T16:20:00Z', '2026-08-28T17:50:00Z']) {
    assert.equal(SS.solar.isDaytime(Date.parse(stamp), 22.54, 114.06), false);
  }
  for (const hour of ['00', '12', '23']) {
    assert.equal(SS.solar.isDaytime(Date.parse('2026-06-21T' + hour + ':00:00Z'), 80, 15), true);
    assert.equal(SS.solar.isDaytime(Date.parse('2026-12-21T' + hour + ':00:00Z'), 80, 15), false);
  }
});

test('missing or invalid solar inputs remain unknown and valid zero is not discarded', () => {
  const { runtime, SS } = setup();
  for (const bad of [null, undefined, NaN, Infinity, '22.54']) {
    assert.equal(SS.solar.isDaytime(Date.now(), bad, 0), null);
    assert.equal(SS.solar.isDaytime(Date.now(), 0, bad), null);
    assert.equal(SS.solar.isDaytime(bad, 0, 0), null);
  }
  assert.equal(SS.solar.isDaytime(Date.now(), 91, 0), null);
  assert.equal(SS.solar.isDaytime(Date.now(), 0, 181), null);
  assert.equal(SS.solar.isDaytime(0, 0, 0), false);
  assert.equal(SS.solar.isDaytime(1e20, 0, 0), null);
  runtime.sandbox.SunCalc.getTimes = () => { throw new Error('unavailable'); };
  assert.equal(SS.solar.isDaytime(0, 0, 0), null);
  runtime.sandbox.SunCalc = null;
  assert.equal(SS.solar.isDaytime(0, 0, 0), null);
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this._text = ''; this.classList = { add() {}, remove() {} }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  appendChild(child) { this.children.push(child); }
}
function uiSetup() {
  const timeline = new Element('div');
  const nodes = { 'n-timeline': timeline };
  const { runtime, SS } = setup({ document: {
    getElementById: id => nodes[id] || null,
    createElement: tag => new Element(tag),
    createElementNS: (ns, tag) => { const el = new Element(tag); el.ns = ns; return el; }
  } });
  load(runtime, ['js/config.js', 'js/domain.js', 'js/time.js', 'js/city_search.js', 'js/ui.js']);
  const start = +events(runtime).sunset - 20 * 60000;
  function result(icons, time = start) {
    const labels = { '☀️': '晴朗，无降水', '⛅': '多云，无降水', '☁️': '阴天，无降水', '🌧️': '降水', '🌂': '无降水（云况未知）', '❔': '暂无此时段降水数据' };
    return { ...shenzhen, score: 50, city: '深圳', nowcast_active: true, nowcast: {
      timeline: icons.map((icon, index) => ({ timeMs: time + index * 1800000, icon, label: labels[icon], source: '分钟降水' }))
    } };
  }
  return { SS, timeline, result };
}

test('UI transforms each cached point independently, with moon/cloud SVG and accessible night labels', () => {
  const { SS, timeline, result } = uiSetup();
  const cached = result(['☀️', '☀️', '⛅', '☁️', '🌧️']);
  const before = JSON.stringify(cached);
  SS.ui.renderResult(cached, { fromCache: true });
  const icons = timeline.children.map(point => point.children[1]);
  assert.equal(icons[0].textContent, '☀️', 'before sunset is still daytime');
  for (const [index, paths] of [[1, 1], [2, 2]]) {
    const icon = icons[index], svg = icon.children[0];
    assert.match(icon.className, /timeline-icon--night/);
    assert.match(icon.attrs['aria-label'], /^夜间，.*分钟降水$/);
    assert.equal(icon.attrs.role, 'img');
    assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
    assert.equal(svg.attrs['aria-hidden'], 'true');
    assert.equal(svg.children.length, paths);
    assert.equal(icon.textContent, '', 'no leftover sun emoji or double-glyph moon/cloud');
  }
  assert.equal(icons[3].textContent, '☁️'); assert.equal(icons[4].textContent, '🌧️');
  assert.equal(JSON.stringify(cached), before, 'do not rewrite cached conditions, source, timestamps or scores');
  SS.ui.renderResult(cached);
  assert.equal(timeline.children.length, 5, 'repeat render must not append duplicate points');
  assert.equal(JSON.stringify(cached), before);
});

test('night display never changes rain, overcast, missing rain or unknown cloud conditions', () => {
  const { SS, timeline, result } = uiSetup();
  const input = ['🌧️', '☁️', '❔', '🌂'];
  SS.ui.renderResult(result(input, Date.parse('2026-08-28T15:30:00Z')));
  assert.deepEqual(timeline.children.map(point => point.children[1].textContent), input);
  assert.ok(timeline.children.every(point => !point.title.startsWith('夜间')));
});

test('unavailable daylight state leaves original icons intact, while sunrise restores daytime icons', () => {
  const { SS, timeline, result } = uiSetup();
  const missing = result(['☀️', '⛅']); delete missing.latitude;
  SS.ui.renderResult(missing);
  assert.deepEqual(timeline.children.map(point => point.children[1].textContent), ['☀️', '⛅']);
  SS.ui.renderResult(result(['☀️', '⛅', '☀️'], Date.parse('2026-08-27T21:50:00Z')));
  assert.match(timeline.children[0].children[1].className, /--night/);
  assert.equal(timeline.children[1].children[1].textContent, '⛅');
  assert.equal(timeline.children[2].children[1].textContent, '☀️');
});
