const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load } = require('./helpers.cjs');

const FILES = ['js/config.js', 'js/model_config.js', 'js/network.js', 'js/corridor.js', 'js/satellite_colormap.js', 'js/satellite_shadow.js'];
const runtime = () => load(createRuntime(), FILES);
const plain = value => JSON.parse(JSON.stringify(value));
const T = iso => Date.parse(iso);
// Domain answer seen live on 2026-10-28 (Himawari Band13, 6-hour window): the 02:40 outage splits the intervals.
const DOMAIN = "<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-10-28T01:00:00Z/2026-10-28T02:30:00Z/PT10M,2026-10-28T02:50:00Z/2026-10-28T06:30:00Z/PT10M</Domain><Size>2</Size></DimensionDomain></Domains>";
const SHANGHAI = { location: { latitude: 31.23, longitude: 121.47 }, solar: { sunsetAzimuthDeg: 255 } };

function colourFor(SS, test) { const e = SS.satelliteColormap.entries.find(x => test(x[3])); return [e[0], e[1], e[2], e[3]]; }
function tile(rgb) { const a = new Uint8ClampedArray(256 * 256 * 4); for (let i = 0; i < a.length; i += 4) { a[i] = rgb[0]; a[i + 1] = rgb[1]; a[i + 2] = rgb[2]; a[i + 3] = 255; } return a; }
function loader(SS, rgbForUrl, actualForUrl = url => url.match(/default\/([^/]+)\//)[1]) {
  const urls = [];
  return { urls, loadTile: async url => { urls.push(url); const rgb = rgbForUrl(url); return rgb ? { ok: true, timeActual: actualForUrl(url), rgba: tile(rgb) } : { ok: false, timeActual: null, rgba: null }; } };
}

test('Satellite is chosen by longitude; areas without a GIBS geostationary layer are NO_COVERAGE without any request', async () => {
  const SS = runtime(), pick = lon => (SS.satelliteShadow.selectSatellite(lon) || {}).id || null;
  assert.deepEqual([121.47, 80, 79.9, 184.9, -175, -105.1, -105, -20.1, -20, 0, 30].map(pick),
    ['himawari', 'himawari', null, 'himawari', 'goes-west', 'goes-west', 'goes-east', 'goes-east', null, null, null]);
  let requested = 0;
  const london = plain(await SS.satelliteShadow.capture({ location: { latitude: 51.5, longitude: -0.1 }, solar: { sunsetAzimuthDeg: 250 },
    nowUtcMs: T('2026-10-28T16:00:00Z'), fetchText: async () => { requested++; return DOMAIN; } }));
  assert.equal(london.status, 'NO_COVERAGE'); assert.equal(requested, 0); assert.equal(london.satellite, null);
});

test('Time domain intervals expand at 10 minutes; the newest 3 frames are checked for gap and age', () => {
  const SS = runtime(), S = SS.satelliteShadow, times = S.expandDomain(DOMAIN);
  assert.equal(times.length, 10 + 23); assert.equal(new Date(times.at(-1)).toISOString(), '2026-10-28T06:30:00.000Z');
  assert.equal(S.expandDomain('<x/>'), null);
  const iso = r => r.times.map(t => new Date(t).toISOString().slice(11, 16));
  let r = S.selectFrames(times, T('2026-10-28T06:59:00Z')); assert.equal(r.status, 'OK'); assert.deepEqual(iso(r), ['06:10', '06:20', '06:30']);
  r = S.selectFrames(times, T('2026-10-28T02:55:00Z')); assert.equal(r.status, 'OK'); assert.deepEqual(iso(r), ['02:20', '02:30', '02:50'], 'the 02:40 outage is a 20-minute gap and allowed');
  r = S.selectFrames(times, T('2026-10-28T08:31:00Z')); assert.equal(r.status, 'STALE'); assert.equal(r.reason_code, 'LATEST_FRAME_AGE_121M');
  r = S.selectFrames(times.filter(t => t !== T('2026-10-28T06:10:00Z') && t !== T('2026-10-28T06:20:00Z')), T('2026-10-28T06:40:00Z')); assert.equal(r.status, 'GAP'); assert.equal(r.reason_code, 'FRAME_GAP');
  r = S.selectFrames(times.slice(0, 2), T('2026-10-28T01:30:00Z')); assert.equal(r.status, 'GAP'); assert.equal(r.reason_code, 'FEWER_THAN_3_FRAMES');
  assert.equal(S.domainUrl('Himawari_AHI_Band13_Clean_Infrared', T('2026-10-28T02:59:30Z'), T('2026-10-28T06:59:59Z')),
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/Himawari_AHI_Band13_Clean_Infrared/default/GoogleMapsCompatible_Level6/all/2026-10-28T02:59:00Z--2026-10-28T06:59:00Z.xml');
});

test('Every colormap colour decodes to its brightness temperature; transparent and unknown colours are missing', () => {
  const SS = runtime(), S = SS.satelliteShadow, entries = SS.satelliteColormap.entries;
  assert.equal(entries.length, 238); assert.equal(new Set(entries.map(e => e.slice(0, 3).join())).size, 238);
  assert.match(SS.satelliteColormap.sha256, /^4d071784e05c9e0c/);
  const key = e => e[0] * 65536 + e[1] * 256 + e[2], ambiguous = new Set(S.ambiguousColorKeys());
  // the 8 cold greys (−70 to −80 °C) sit exactly between adjacent warm greys, so resampling makes them ambiguous
  assert.equal(entries.filter(e => ambiguous.has(key(e))).map(e => e[0]).sort((a, b) => a - b).join(), '5,27,54,76,102,129,155,177');
  for (const e of entries) assert.equal(S.decodeBt([e[0], e[1], e[2], 255], 0), ambiguous.has(key(e)) ? null : Math.round(e[3] * 2) / 2);
  assert.equal(S.decodeBt([255, 255, 255, 0], 0), null);
  // resampled in-between grey 111 (between 112 → 14.15 °C and 110 → 14.65 °C) decodes to a neighbour; far mixtures are missing
  assert.ok([14, 14.5].includes(S.decodeBt([111, 111, 111, 255], 0)));
  assert.equal(S.decodeBt([112, 209, 211, 255], 0), null);
  assert.equal(S.decodeBt([3, 7, 250, 255], 0), null);
});

test('Corridor geometry: hundreds of points within ±30° and 250 km on 1–4 zoom-5 tiles', () => {
  const SS = runtime(), g = SS.satelliteShadow.sampleGeometry(31.23, 121.47, 255);
  assert.ok(g.points.length >= 100 && g.points.length <= 1000, String(g.points.length)); assert.equal(g.truncated, false);
  assert.ok(g.points.every(p => Math.abs(p.offset) <= 30 && p.distance <= 250));
  assert.ok(g.tiles.filter(Boolean).length >= 1 && g.tiles.filter(Boolean).length <= 4);
});

test('Capture decodes cold cloud, records per-frame status, and the result passes the v2 server schema', async () => {
  const SS = runtime(), schema = await import('../server/bypass-schema.js'), now = T('2026-10-28T06:59:00Z');
  const cold = colourFor(SS, v => v <= -40), warm = colourFor(SS, v => v >= 20);
  const run = async (l, extra = {}) => plain(await SS.satelliteShadow.capture({ ...SHANGHAI, nowUtcMs: now, fetchText: async () => DOMAIN, loadTile: l.loadTile, ...extra }));
  const all = loader(SS, () => cold), okShadow = await run(all);
  assert.equal(okShadow.status, 'OK'); assert.equal(okShadow.satellite, 'himawari'); assert.equal(okShadow.frames.length, 3);
  assert.ok(all.urls.every(u => u.startsWith('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/2026-10-28T06:')));
  const f = okShadow.frames[2];
  assert.deepEqual([f.status, f.age_minutes, f.valid_sample_ratio, f.summary.frac_cold_high, f.summary.frac_cloud_v1, f.summary.frac_mid], ['OK', 29, 1, 1, 1, 0]);
  assert.equal(f.summary.bt_p50, Math.round(cold[3] * 2) / 2); assert.equal(okShadow.samples.bt_c_by_frame.length, 3);
  assert.equal(okShadow.samples.points.length, okShadow.samples.bt_c_by_frame[0].length);
  assert.equal(okShadow.colormap.sha256, SS.satelliteColormap.sha256);
  const clear = await run(loader(SS, () => warm)); assert.equal(clear.frames[0].summary.frac_cloud_v1, 0, 'clear sky is a measured 0, not missing');
  const failed = await run(loader(SS, () => null)); assert.equal(failed.status, 'TILES_FAILED'); assert.ok(failed.samples.bt_c_by_frame[0].every(v => v === null));
  const geom = SS.satelliteShadow.sampleGeometry(31.23, 121.47, 255), firstTile = geom.tiles.findIndex(Boolean);
  const share = geom.points.filter(p => p.tile === firstTile).length / geom.points.length;
  const partial = await run(loader(SS, url => url.endsWith(`/${geom.tiles[firstTile].y}/${geom.tiles[firstTile].x}.png`) ? null : cold));
  assert.equal(partial.frames[0].status, share > 0.2 ? 'INSUFFICIENT_SAMPLES' : 'OK', 'failed tiles are missing, never clear');
  const shifted = await run(loader(SS, () => cold, () => '2026-10-28T05:00:00Z')); assert.equal(shifted.status, 'TIME_MISMATCH');
  const stale = await run(all, { nowUtcMs: T('2026-10-28T09:00:00Z') }); assert.equal(stale.status, 'STALE'); assert.equal(stale.frames.length, 0);
  const down = await run(all, { fetchText: async () => { const e = new Error('x'); e.status = 503; throw e; } });
  assert.deepEqual([down.status, down.reason_code], ['DOMAIN_FAILED', 'HTTP_503']);
  for (const shadow of [okShadow, clear, failed, partial, shifted, stale, down, plain(SS.satelliteShadow.failure('TypeError'))])
    assert.doesNotThrow(() => schema.validateSatelliteShadow(structuredClone(shadow)), shadow.status);
});

test('v2 schema rejects unknown fields, out-of-range temperatures, inconsistent frames and oversized samples', async () => {
  const SS = runtime(), schema = await import('../server/bypass-schema.js'), cold = colourFor(SS, v => v <= -40);
  const base = plain(await SS.satelliteShadow.capture({ ...SHANGHAI, nowUtcMs: T('2026-10-28T06:59:00Z'), fetchText: async () => DOMAIN, loadTile: loader(SS, () => cold).loadTile }));
  const bad = fn => { const c = structuredClone(base); fn(c); return () => schema.validateSatelliteShadow(c); };
  assert.throws(bad(s => { s.extra = 1; }), /未知字段/);
  assert.throws(bad(s => { s.samples.bt_c_by_frame[0][0] = 75; }), /非法/);
  assert.throws(bad(s => { s.samples.bt_c_by_frame.pop(); }), /与帧数不符/);
  assert.throws(bad(s => { s.frames[0].summary = null; }), /summary 与状态不符/);
  assert.throws(bad(s => { s.layer = 'GOES-East_ABI_Band13_Clean_Infrared'; }), /卫星与图层不符/);
  assert.throws(bad(s => { s.frames.forEach(f => { f.status = 'TILES_FAILED'; f.summary = null; }); }), /没有有效帧/);
  assert.throws(bad(s => { s.samples.points = Array.from({ length: 1001 }, () => [0, 10]); }), /数量非法/);
  assert.throws(bad(s => { s.colormap.sha256 = 'x'; }), /sha256/);
});

test('Bypass capture v2 carries the shadow; a browser-less tile failure is recorded, and the whole object passes the server schema', async () => {
  const schema = await import('../server/bypass-schema.js'), now = T('2026-10-28T06:59:00Z');
  const fetch = async url => url.includes('gibs.earthdata.nasa.gov') && url.endsWith('.xml')
    ? new Response(DOMAIN, { status: 200 }) : new Response('{}', { status: url.includes('gibs') ? 200 : 429 });
  const SS = load(createRuntime({ fetch }), [...FILES, 'js/time.js', 'js/data.js', 'js/cloud_field.js', 'js/bypass_capture.js']);
  const solar = { sunset: new Date('2026-10-28T09:10:00Z'), sunsetAzimuthDeg: 255 };
  const bypass = plain(await SS.bypassCapture.capture({ location: SHANGHAI.location, solar, nowUtcMs: now }));
  assert.equal(bypass.bypass_schema_version, 2); assert.equal(bypass.requests.A.status, 'RATE_LIMITED');
  assert.equal(bypass.satellite_shadow.status, 'TILES_FAILED', 'no createImageBitmap in Node: every tile fails and is recorded, not read as clear');
  assert.doesNotThrow(() => schema.validateBypassPayload(bypass, { prediction_time_utc: new Date(now).toISOString(),
    sunset_time_utc: solar.sunset.toISOString(), ...SHANGHAI.location }));
});
