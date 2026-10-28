/* ============================================================
 * SunsetScore V2.5.5.8 - 卫星影子采集（Band13 红外，只记录、不计分）
 * 自动采集时，用 GIBS 时间域接口选最新 3 帧（间隔 ≤ 20 分钟、帧龄 ≤ 120 分钟），
 * 按官方色表把走廊像素还原为亮温，保存采样原值与 v1 判云摘要，写入旁路对象的 satellite_shadow。
 * 现有卫星路径（nowcast.js / corridor.js）与评分都不受影响。失败只记录状态，不当作 0。
 * 依据：ref_docs/PRD/V2.5.5.8--卫星影子采集方案.md
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';
  var CONFIG = Object.freeze({
    shadowSchemaVersion: 1,
    classifierVersion: 1,
    tileMatrixSet: 'GoogleMapsCompatible_Level6',
    zoom: 5,
    tileSize: 256,
    samplePx: 2,
    halfWidthDeg: 30,
    maxRadiusKm: 250,
    bandsKm: Object.freeze([[0, 50], [50, 100], [100, 250]]),
    domainWindowMinutes: 240,
    frames: 3,
    maxGapMinutes: 20,
    maxAgeMinutes: 120,
    minValidRatio: 0.8,
    maxPoints: 1000,
    coldHighC: -30,
    /* 瓦片经重投影与缩放后含插值出的过渡色：精确匹配不上时，投影到色表相邻两项连成的 RGB 线段上，
     * 垂直距离 ≤ 2 即按线性插值取亮温；离所有线段更远的混合色为缺测 */
    colorMatchMaxDistance: 2,
    cloudC: -10,
    timeoutMs: 15000,
    /* 经度分区（°E，0–360）：中国全部落在 Himawari；其余区域在 GIBS 上没有可用的静止卫星 */
    satellites: Object.freeze([
      Object.freeze({ id: 'himawari', layer: 'Himawari_AHI_Band13_Clean_Infrared', lonMin: 80, lonMax: 185 }),
      Object.freeze({ id: 'goes-west', layer: 'GOES-West_ABI_Band13_Clean_Infrared', lonMin: 185, lonMax: 255 }),
      Object.freeze({ id: 'goes-east', layer: 'GOES-East_ABI_Band13_Clean_Infrared', lonMin: 255, lonMax: 340 })
    ])
  });

  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function isoMinute(ms) { return new Date(Math.floor(ms / 60000) * 60000).toISOString().replace('.000Z', 'Z'); }
  function round(v, step) { return Math.round(v / step) * step; }

  function selectSatellite(lon) {
    var east = ((lon % 360) + 360) % 360;
    for (var i = 0; i < CONFIG.satellites.length; i++) {
      var s = CONFIG.satellites[i];
      if (east >= s.lonMin && east < s.lonMax) return s;
    }
    return null;
  }

  function domainUrl(layer, startMs, endMs) {
    return GIBS + '1.0.0/' + layer + '/default/' + CONFIG.tileMatrixSet + '/all/' + isoMinute(startMs) + '--' + isoMinute(endMs) + '.xml';
  }
  function tileUrl(layer, timeIso, tile) {
    return GIBS + layer + '/default/' + timeIso + '/' + CONFIG.tileMatrixSet + '/' + CONFIG.zoom + '/' + tile.y + '/' + tile.x + '.png';
  }

  /* <Domain>a/b/PT10M,c,...</Domain> → 升序去重的 epoch 毫秒 */
  function expandDomain(xml) {
    var m = /<Domain>([^<]*)<\/Domain>/.exec(String(xml || ''));
    if (!m) return null;
    var out = {};
    m[1].split(',').forEach(function (part) {
      var bits = part.trim().split('/');
      if (!bits[0]) return;
      var start = Date.parse(bits[0]);
      if (!finite(start)) return;
      if (bits.length === 1) { out[start] = true; return; }
      var end = Date.parse(bits[1]), period = /^PT(\d+)M$/.exec(bits[2] || '');
      if (!finite(end) || !period) return;
      var step = Number(period[1]) * 60000;
      if (!(step > 0) || (end - start) / step > 2000) return;
      for (var t = start; t <= end; t += step) out[t] = true;
    });
    return Object.keys(out).map(Number).sort(function (a, b) { return a - b; });
  }

  /* 最新 N 帧：相邻间隔 ≤ maxGap，最新帧龄 ≤ maxAge */
  function selectFrames(times, nowMs) {
    var usable = (times || []).filter(function (t) { return t <= nowMs; });
    if (usable.length < CONFIG.frames) return { status: 'GAP', reason_code: 'FEWER_THAN_' + CONFIG.frames + '_FRAMES', times: [] };
    var picked = usable.slice(-CONFIG.frames);
    var age = (nowMs - picked[picked.length - 1]) / 60000;
    if (age > CONFIG.maxAgeMinutes) return { status: 'STALE', reason_code: 'LATEST_FRAME_AGE_' + Math.round(age) + 'M', times: picked };
    for (var i = 1; i < picked.length; i++) {
      if ((picked[i] - picked[i - 1]) / 60000 > CONFIG.maxGapMinutes) return { status: 'GAP', reason_code: 'FRAME_GAP', times: picked };
    }
    return { status: 'OK', reason_code: null, times: picked };
  }

  /* 走廊采样几何：每个点记录所在瓦片与瓦片内像素，以及相对日落方位的偏角与距离 */
  function sampleGeometry(lat, lon, azimuth) {
    var C = SS.corridor, size = CONFIG.tileSize, zoom = CONFIG.zoom, n = Math.pow(2, zoom), rad = Math.PI / 180;
    var plan = C.tilePlan(lat, lon, CONFIG.maxRadiusKm, zoom, size);
    if (!plan) return null;
    var first = plan.tiles[0], x0 = first.x, y0 = first.y, cols = 0;
    plan.tiles.forEach(function (t) { cols = Math.max(cols, t.x - x0 + 1); });
    var points = [];
    for (var py = 0; py < plan.h; py += CONFIG.samplePx) {
      for (var px = 0; px < plan.w; px += CONFIG.samplePx) {
        var gx = (x0 * size + px) / size / n, gy = (y0 * size + py) / size / n;
        var pLon = gx * 360 - 180, pLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) / rad;
        var d = C.haversineKm(lat, lon, pLat, pLon);
        if (d > CONFIG.maxRadiusKm) continue;
        var offset = ((C.bearingDeg(lat, lon, pLat, pLon) - azimuth + 540) % 360) - 180;
        if (Math.abs(offset) > CONFIG.halfWidthDeg) continue;
        var tx = Math.floor(px / size), ty = Math.floor(py / size);
        points.push({ tile: ty * cols + tx, pixel: ((py % size) * size + (px % size)) * 4,
          offset: round(offset, 0.1), distance: round(d, 0.1) });
      }
    }
    var tiles = [];
    plan.tiles.forEach(function (t) { tiles[(t.y - y0) * cols + (t.x - x0)] = { x: t.x, y: t.y }; });
    return { tiles: tiles, points: points.slice(0, CONFIG.maxPoints), truncated: points.length > CONFIG.maxPoints };
  }

  function colorKey(r, g, b) { return r * 65536 + g * 256 + b; }
  var lookup = null;
  /* 精确表 + 歧义色：色表中极冷段（−70 至 −80 °C）的灰度恰好落在暖灰段相邻两项的中点，
   * 插值出的暖灰会被精确匹配成极冷（凭空造出冷云），因此比相邻两项中点冷 1 °C 以上的颜色记为缺测（null），
   * 也不作为最近色的候选；反方向（极冷相邻两项插值成暖灰）只会低估冷度且极少见，不处理 */
  function colormapLookup() {
    if (lookup) return lookup;
    var entries = SS.satelliteColormap ? SS.satelliteColormap.entries : [], exact = {}, ambiguous = {}, cache = {};
    entries.forEach(function (e) { exact[colorKey(e[0], e[1], e[2])] = e[3]; });
    for (var k = 0; k + 1 < entries.length; k++) {
      var a = entries[k], b = entries[k + 1];
      [Math.floor, Math.ceil].forEach(function (r) {
        var key = colorKey(r((a[0] + b[0]) / 2), r((a[1] + b[1]) / 2), r((a[2] + b[2]) / 2)), bt = exact[key];
        if (finite(bt) && bt < (a[3] + b[3]) / 2 - 1) ambiguous[key] = true;
      });
    }
    var segments = [];
    for (var j = 0; j + 1 < entries.length; j++) {
      var p = entries[j], q = entries[j + 1], dr = q[0] - p[0], dg = q[1] - p[1], db = q[2] - p[2];
      segments.push({ p: p, q: q, d: [dr, dg, db], len2: dr * dr + dg * dg + db * db });
    }
    lookup = { exact: exact, ambiguous: ambiguous, segments: segments, cache: cache };
    return lookup;
  }
  function matchColor(r, g, b) {
    var L = colormapLookup(), key = colorKey(r, g, b);
    if (L.ambiguous[key]) return null;
    if (finite(L.exact[key])) return L.exact[key];
    if (key in L.cache) return L.cache[key];
    /* 多条线段都够近时取 RGB 跨度最短的一条：暖灰段步长约 1.4，极冷灰段约 25–45，二者在灰轴上重叠 */
    var max2 = CONFIG.colorMatchMaxDistance * CONFIG.colorMatchMaxDistance, bestLen = Infinity, bt = null;
    L.segments.forEach(function (s) {
      if (!s.len2) return;
      var t = Math.max(0, Math.min(1, ((r - s.p[0]) * s.d[0] + (g - s.p[1]) * s.d[1] + (b - s.p[2]) * s.d[2]) / s.len2));
      var er = r - s.p[0] - t * s.d[0], eg = g - s.p[1] - t * s.d[1], eb = b - s.p[2] - t * s.d[2];
      if (er * er + eg * eg + eb * eb <= max2 && s.len2 < bestLen) { bestLen = s.len2; bt = s.p[3] + t * (s.q[3] - s.p[3]); }
    });
    L.cache[key] = bt;
    return bt;
  }
  /* RGBA → 亮温（°C，0.5 精度）；透明、歧义色、离色表过远的颜色为 null */
  function decodeBt(rgba, i) {
    if (!rgba || rgba[i + 3] < 255) return null;
    var bt = matchColor(rgba[i], rgba[i + 1], rgba[i + 2]);
    return finite(bt) ? round(bt, 0.5) : null;
  }

  function percentile(sorted, p) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
  }
  function fraction(values, test) {
    var valid = values.filter(finite);
    return valid.length ? Math.round(valid.filter(test).length / valid.length * 1000) / 1000 : null;
  }
  function summarize(bts, points) {
    var valid = bts.filter(finite).sort(function (a, b) { return a - b; });
    return {
      frac_cold_high: fraction(bts, function (v) { return v <= CONFIG.coldHighC; }),
      frac_mid: fraction(bts, function (v) { return v > CONFIG.coldHighC && v <= CONFIG.cloudC; }),
      frac_cloud_v1: fraction(bts, function (v) { return v <= CONFIG.cloudC; }),
      bt_p10: percentile(valid, 0.1), bt_p50: percentile(valid, 0.5), bt_p90: percentile(valid, 0.9),
      bands: CONFIG.bandsKm.map(function (band) {
        var inBand = bts.filter(function (v, k) { return points[k].distance >= band[0] && points[k].distance < band[1]; });
        return { band_km: band.slice(), valid: inBand.filter(finite).length, frac_cloud_v1: fraction(inBand, function (v) { return v <= CONFIG.cloudC; }) };
      })
    };
  }

  /* 单帧：tiles[k] = { ok, timeActual, rgba } 或 null */
  function frameFromTiles(timeMs, nowMs, geometry, loaded) {
    var bts = geometry.points.map(function (p) {
      var t = loaded[p.tile];
      return t && t.ok ? decodeBt(t.rgba, p.pixel) : null;
    });
    var ok = loaded.filter(function (t) { return t && t.ok; }).length;
    var actuals = loaded.filter(function (t) { return t && t.ok && t.timeActual; }).map(function (t) { return t.timeActual; });
    var actual = actuals.length ? actuals[0] : null;
    var mismatch = actuals.some(function (a) { return Date.parse(a) !== timeMs; });
    var validRatio = geometry.points.length ? bts.filter(finite).length / geometry.points.length : 0;
    var status = ok === 0 ? 'TILES_FAILED' : mismatch ? 'TIME_MISMATCH' : validRatio < CONFIG.minValidRatio ? 'INSUFFICIENT_SAMPLES' : 'OK';
    return {
      frame: { time_utc: new Date(timeMs).toISOString(), time_actual_utc: actual && finite(Date.parse(actual)) ? new Date(Date.parse(actual)).toISOString() : null,
        age_minutes: Math.round((nowMs - timeMs) / 60000), status: status, tiles_requested: loaded.length, tiles_ok: ok,
        valid_sample_ratio: Math.round(validRatio * 1000) / 1000, summary: status === 'OK' ? summarize(bts, geometry.points) : null },
      bts: bts
    };
  }

  /* 浏览器默认瓦片加载：保留响应头中的实际帧时刻，逐张返回成功或失败 */
  async function loadTileBrowser(url, signal) {
    try {
      var result = await SS.network.request(url, { responseType: 'blob', signal: signal, timeoutMs: CONFIG.timeoutMs });
      var bitmap = await root.createImageBitmap(result.data);
      var canvas = typeof root.OffscreenCanvas === 'function' ? new root.OffscreenCanvas(CONFIG.tileSize, CONFIG.tileSize)
        : Object.assign(root.document.createElement('canvas'), { width: CONFIG.tileSize, height: CONFIG.tileSize });
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      return { ok: true, timeActual: result.response.headers.get('layer-time-actual'),
        rgba: ctx.getImageData(0, 0, CONFIG.tileSize, CONFIG.tileSize).data };
    } catch (error) {
      SS.network.throwIfAborted(signal);
      return { ok: false, timeActual: null, rgba: null };
    }
  }

  function shell(status, reason, satellite, extra) {
    return Object.assign({
      shadow_schema_version: CONFIG.shadowSchemaVersion, record_only: true, classifier_version: CONFIG.classifierVersion,
      status: status, reason_code: reason || null, satellite: satellite ? satellite.id : null, layer: satellite ? satellite.layer : null,
      tile_matrix_set: CONFIG.tileMatrixSet, zoom: CONFIG.zoom, sample_step_px: CONFIG.samplePx,
      geometry: null, domain: null, frames: [], samples: null,
      colormap: SS.satelliteColormap ? { url: SS.satelliteColormap.url, sha256: SS.satelliteColormap.sha256,
        match_max_rgb_distance: CONFIG.colorMatchMaxDistance, ambiguous_colors: Object.keys(colormapLookup().ambiguous).length } : null
    }, extra || {});
  }

  /* context: { location, solar, nowUtcMs, signal, fetchText?, loadTile? }（后两者供测试注入） */
  async function capture(context) {
    var lat = context.location.latitude, lon = context.location.longitude, azimuth = context.solar.sunsetAzimuthDeg, nowMs = context.nowUtcMs;
    var satellite = selectSatellite(lon);
    if (!satellite) return shell('NO_COVERAGE', 'NO_GEOSTATIONARY_LAYER', null);
    var geometry = sampleGeometry(lat, lon, azimuth);
    var geom = { sunset_azimuth_deg: azimuth, half_width_deg: CONFIG.halfWidthDeg, max_radius_km: CONFIG.maxRadiusKm,
      bands_km: CONFIG.bandsKm.map(function (b) { return b.slice(); }) };
    if (!geometry || !geometry.points.length) return shell('INSUFFICIENT_SAMPLES', 'NO_CORRIDOR_POINTS', satellite, { geometry: geom });
    var startMs = nowMs - CONFIG.domainWindowMinutes * 60000, fetchedAt = new Date().toISOString(), xml = null;
    try {
      var fetchText = context.fetchText || function (url) { return SS.network.text(url, { signal: context.signal, timeoutMs: CONFIG.timeoutMs }); };
      xml = await fetchText(domainUrl(satellite.layer, startMs, nowMs));
    } catch (error) {
      SS.network.throwIfAborted(context.signal);
      return shell('DOMAIN_FAILED', error && error.status ? 'HTTP_' + error.status : 'DOMAIN_REQUEST_FAILED', satellite, { geometry: geom });
    }
    var times = expandDomain(xml);
    var domain = { requested_window_utc: [new Date(startMs).toISOString(), new Date(nowMs).toISOString()], fetched_at_utc: fetchedAt,
      available_times_count: times ? times.length : 0 };
    if (!times) return shell('DOMAIN_FAILED', 'DOMAIN_UNPARSEABLE', satellite, { geometry: geom, domain: domain });
    var pick = selectFrames(times, nowMs);
    if (pick.status !== 'OK') return shell(pick.status, pick.reason_code, satellite, { geometry: geom, domain: domain });
    var loadTile = context.loadTile || function (url) { return loadTileBrowser(url, context.signal); };
    var results = await Promise.all(pick.times.map(function (t) {
      var iso = new Date(t).toISOString().replace('.000Z', 'Z');
      return Promise.all(geometry.tiles.map(function (tile) { return tile ? loadTile(tileUrl(satellite.layer, iso, tile)) : null; }))
        .then(function (loaded) { return frameFromTiles(t, nowMs, geometry, loaded); });
    }));
    var frames = results.map(function (r) { return r.frame; });
    var okFrames = frames.filter(function (f) { return f.status === 'OK'; }).length;
    var status = okFrames ? 'OK' : frames.every(function (f) { return f.status === 'TILES_FAILED'; }) ? 'TILES_FAILED'
      : frames.some(function (f) { return f.status === 'TIME_MISMATCH'; }) ? 'TIME_MISMATCH' : 'INSUFFICIENT_SAMPLES';
    return shell(status, geometry.truncated ? 'POINTS_TRUNCATED' : null, satellite, {
      geometry: geom, domain: domain, frames: frames,
      samples: { points: geometry.points.map(function (p) { return [p.offset, p.distance]; }), bt_c_by_frame: results.map(function (r) { return r.bts; }) }
    });
  }

  /* 未预期的异常也只记录为一个状态，不影响旁路其他部分 */
  function failure(reason) { return shell('CAPTURE_ERROR', String(reason || 'UNEXPECTED').slice(0, 40), null); }

  SS.satelliteShadow = {
    CONFIG: CONFIG, capture: capture, failure: failure, selectSatellite: selectSatellite, expandDomain: expandDomain, selectFrames: selectFrames,
    sampleGeometry: sampleGeometry, decodeBt: decodeBt, ambiguousColorKeys: function () { return Object.keys(colormapLookup().ambiguous).map(Number); }, summarize: summarize, frameFromTiles: frameFromTiles, domainUrl: domainUrl, tileUrl: tileUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);
