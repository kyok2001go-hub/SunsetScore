/* ============================================================
 * SunsetScore V2.0 - 日落走廊模型（技术方案 5 章）
 * 从 nowcast.js 抽出的公共几何与瓦片工具，供雷达/卫星演化复用：
 *   - 地理计算：haversine / bearing / 角度差 / 墨卡托瓦片换算
 *   - 瓦片合成：tilePlan + loadTileCanvas
 *   - 走廊采样：sectorSample（±方位半宽、距离上限内逐像素采样，
 *     返回像素索引与各点距观测点距离）
 *   - 覆盖率统计：coverageAt / coverageByBands（支持距离分层）
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var EARTH_R = 6371;
  var rad = Math.PI / 180;

  function haversineKm(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_R * Math.asin(Math.sqrt(a));
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    var y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
    var x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
      Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  function angDiffDeg(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  function tileXY(lat, lon, zoom) {
    var n = Math.pow(2, zoom);
    var x = (lon + 180) / 360 * n;
    var latR = lat * rad;
    var y = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    return { x: x, y: y };
  }
  /* 墨卡托像素尺度（km/像素），供质心位移换算 */
  function metersPerPixelKm(lat, zoom) {
    return Math.cos(lat * rad) * 2 * Math.PI * EARTH_R / (Math.pow(2, zoom) * 256);
  }

  /* 加载一组瓦片并合成到离屏 canvas。
     单瓦片失败视为空白（边缘地区常见）；全部失败则拒绝（触发源降级）；
     canvas 被污染（CORS）同样拒绝 */
  function loadTileCanvas(tiles, w, h, urlFn) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      var pending = tiles.length;
      var failed = 0;
      if (!pending) { reject(new Error('无瓦片')); return; }
      function done() {
        if (--pending !== 0) return;
        if (failed === tiles.length) { reject(new Error('全部瓦片加载失败')); return; }
        try {
          var data = ctx.getImageData(0, 0, w, h); /* 触发污染检查 */
          resolve({ canvas: canvas, data: data });
        } catch (e) { reject(new Error('canvas 污染（CORS 不可用）')); }
      }
      tiles.forEach(function (t) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
          try { ctx.drawImage(img, t.dx, t.dy); } catch (e) { /* 忽略单瓦片绘制异常 */ }
          done();
        };
        img.onerror = function () { failed++; done(); };
        img.src = urlFn(t.x, t.y);
      });
    });
  }

  /* 计算覆盖半径内的瓦片集合与画布几何 */
  function tilePlan(lat, lon, radiusKm, zoom, size) {
    var dLat = radiusKm / 111;
    var dLon = radiusKm / (111 * Math.max(0.2, Math.cos(lat * rad)));
    var tl = tileXY(lat + dLat, lon - dLon, zoom);
    var br = tileXY(lat - dLat, lon + dLon, zoom);
    var x0 = Math.floor(tl.x), y0 = Math.floor(tl.y);
    var x1 = Math.floor(br.x), y1 = Math.floor(br.y);
    if (x1 - x0 > 10 || y1 - y0 > 10) return null; /* 防御：瓦片数异常 */
    var tiles = [];
    for (var tx = x0; tx <= x1; tx++) {
      for (var ty = y0; ty <= y1; ty++) {
        tiles.push({ x: tx, y: ty, dx: (tx - x0) * size, dy: (ty - y0) * size });
      }
    }
    var ox = tileXY(lat, lon, zoom);
    return {
      tiles: tiles,
      w: (x1 - x0 + 1) * size,
      h: (y1 - y0 + 1) * size,
      cx: (ox.x - x0) * size,
      cy: (ox.y - y0) * size
    };
  }

  /* 日落走廊采样（方案 5 章）：距观测点 ≤maxRadiusKm 且方位角在
     sunsetAzimuth±halfWidth 内。画布像素先换算为全球墨卡托瓦片坐标再反投影，
     按 step 像素采样控制计算量。返回像素索引数组与各点距离（km） */
  function sectorSample(plan, lat, lon, sunsetAzimuthDeg, maxRadiusKm, halfWidthDeg, zoom, size, step) {
    var n = Math.pow(2, zoom);
    var first = plan.tiles[0];
    var idx = [], distKm = [];
    for (var py = 0; py < plan.h; py += step) {
      for (var px = 0; px < plan.w; px += step) {
        var gx = (first.x * size + px) / size / n; /* 全球瓦片坐标 0~1 */
        var gy = (first.y * size + py) / size / n;
        var pLon = gx * 360 - 180;
        var pLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) / rad;
        var d = haversineKm(lat, lon, pLat, pLon);
        if (d > maxRadiusKm) continue;
        if (angDiffDeg(bearingDeg(lat, lon, pLat, pLon), sunsetAzimuthDeg) > halfWidthDeg) continue;
        idx.push((py * plan.w + px) * 4);
        distKm.push(d);
      }
    }
    return { idx: idx, distKm: distKm };
  }

  /* 走廊内满足像素判定的覆盖率（%） */
  function coverageAt(imgData, sample, pixelTest) {
    if (!sample.idx.length) return null;
    var hit = 0;
    for (var k = 0; k < sample.idx.length; k++) {
      if (pixelTest(imgData, sample.idx[k])) hit++;
    }
    return hit / sample.idx.length * 100;
  }

  /* 距离分层覆盖率（方案 8.3 节）：bands = [{name, minKm, maxKm}]，
     返回 {name: pct}，空分层为 null */
  function coverageByBands(imgData, sample, bands, pixelTest) {
    var out = {};
    bands.forEach(function (b) {
      var hit = 0, total = 0;
      for (var k = 0; k < sample.idx.length; k++) {
        var d = sample.distKm[k];
        if (d < b.minKm || d >= b.maxKm) continue;
        total++;
        if (pixelTest(imgData, sample.idx[k])) hit++;
      }
      out[b.name] = total > 0 ? Math.round(hit / total * 100) : null;
    });
    return out;
  }

  SS.corridor = {
    haversineKm: haversineKm,
    bearingDeg: bearingDeg,
    angDiffDeg: angDiffDeg,
    tileXY: tileXY,
    metersPerPixelKm: metersPerPixelKm,
    loadTileCanvas: loadTileCanvas,
    tilePlan: tilePlan,
    sectorSample: sectorSample,
    coverageAt: coverageAt,
    coverageByBands: coverageByBands
  };
})(typeof window !== 'undefined' ? window : globalThis);
