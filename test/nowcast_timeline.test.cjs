const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, forecast } = require('./helpers.cjs');

const now = Date.parse('2026-08-26T18:00:00Z');
function setup() {
  const runtime = createRuntime();
  return load(runtime, ['js/config.js', 'js/model_config.js', 'js/domain.js', 'js/time.js',
    'js/cache.js', 'js/cloud_field.js', 'js/nowcast.js', 'js/evolution.js']);
}
function series(step = 5, count = 24) {
  return {
    times: Array.from({ length: count }, (_, i) => new Date(now + i * step * 60000).toISOString()),
    precip: Array(count).fill(0.14), stepMs: step * 60000, source: 'qweather', summary: '降雨还将持续120分钟'
  };
}

test('QWeather rainy series survives fusion and reaches evolution and all timeline icons', async () => {
  const SS = setup();
  const analysis = SS.nowcast.analyzePrecip(series(), now);
  const ctx = { lat: 22.54, lon: 114.06, dateStr: '2026-08-26', nowUtc: new Date(now), forecastTrend: 0, utcOffsetSeconds: 0 };
  for (const type of ['precip', 'radar', 'satellite']) {
    SS.cache.set(SS.cacheKeys.nowcast(type, ctx.dateStr, ctx.lat, ctx.lon), { analysis: type === 'precip' ? analysis : null }, 10);
  }
  const fusion = await SS.nowcast.run(ctx);
  assert.equal(fusion.detail.precip.available, true);
  assert.equal(fusion.detail.precip.series.times.length, 24);
  const evo = SS.evolution.evaluate({ precip: fusion.detail.precip, nowMs: now, sunsetMs: now + 3600000 });
  assert.ok(evo);
  assert.ok(evo.sources.includes('precip'));
  const timeline = SS.nowcast.buildTimeline(fusion.detail.precip, forecast({ precipitation: 1, cloud: 40 }), now);
  assert.ok(timeline.every((point) => point.icon === '🌧️'));
  assert.equal(timeline[0].source, '分钟降水');
  assert.equal(timeline[4].source, '小时预报');
});

test('rain stops according to minute series, even if the hourly forecast still says rain', () => {
  const SS = setup();
  const s = series();
  s.precip.fill(0, 6);
  const timeline = SS.nowcast.buildTimeline({ series: s }, forecast({ precipitation: 1, cloud: 40 }), now);
  assert.equal(timeline[0].icon, '🌧️');
  assert.equal(timeline[1].icon, '⛅');
  assert.equal(timeline[1].source, '分钟降水');
});

test('5m/15m coverage boundaries and missing data do not invent cloudy or rainy weather', () => {
  const SS = setup();
  for (const step of [5, 15]) {
    const s = series(step, 8);
    assert.equal(SS.nowcast.precipAtSeries(s, now - 1), null);
    assert.equal(SS.nowcast.precipAtSeries(s, now + step * 60000 - 1), 0.14);
    assert.equal(SS.nowcast.precipAtSeries(s, now + 8 * step * 60000), null);
    s.precip[0] = null;
    assert.equal(SS.nowcast.precipAtSeries(s, now), null);
  }
  assert.ok(SS.nowcast.buildTimeline(null, null, now).every((item) => item.icon === '❔'));
  assert.equal(SS.nowcast.buildTimeline({ series: series() }, null, now)[4].icon, '❔');
});
