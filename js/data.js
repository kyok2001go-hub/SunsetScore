/* ============================================================
 * SunsetScore V1.5 - 数据获取层（第 21/27 章）
 * 前端直接调用 Open-Meteo 三接口（支持 CORS，file:// 可用）
 * + 日落方向空间云场采样（第 8 章：13 个采样点）
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var EARTH_RADIUS_KM = 6371;
  var rad = Math.PI / 180;

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('请求失败（HTTP ' + r.status + '）：' + url);
      return r.json();
    });
  }

  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* 带一次重试的预报请求：13 点并发可能触发 429 限流，错峰重试一次 */
  function fetchForecastWithRetry(lat, lon, retryDelayMs) {
    return SS.data.fetchForecast(lat, lon).catch(function () {
      return delay(retryDelayMs).then(function () { return SS.data.fetchForecast(lat, lon); });
    });
  }

  /* 已知起点、方位角、距离，求目标点经纬度 */
  function destinationPoint(lat, lon, bearingDeg, distKm) {
    var phi1 = lat * rad;
    var lambda1 = lon * rad;
    var theta = bearingDeg * rad;
    var delta = distKm / EARTH_RADIUS_KM;

    var phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
    );
    var lambda2 = lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );
    return {
      latitude: phi2 / rad,
      longitude: ((lambda2 / rad) + 540) % 360 - 180
    };
  }

  /**
   * 构建空间采样点：Local + 4 距离 × 3 方位 = 13 点（第 8 章）
   */
  function buildSamplePoints(lat, lon, sunsetAzimuthDeg) {
    var cfg = SS.config;
    var points = [{ distanceKm: 0, azimuthOffset: 0, latitude: lat, longitude: lon }];
    cfg.azimuthOffsets.forEach(function (offset) {
      var bearing = (sunsetAzimuthDeg + offset + 360) % 360;
      cfg.distancesKm.forEach(function (dist) {
        var p = destinationPoint(lat, lon, bearing, dist);
        p.distanceKm = dist;
        p.azimuthOffset = offset;
        points.push(p);
      });
    });
    return points;
  }

  SS.data = {
    destinationPoint: destinationPoint,
    buildSamplePoints: buildSamplePoints,

    /* 城市名 → 经纬度 + 时区（Open-Meteo Geocoding） */
    geocode: function (name) {
      var url = SS.config.endpoints.geocoding +
        '?name=' + encodeURIComponent(name) + '&count=1&language=zh&format=json';
      return fetchJson(url).then(function (json) {
        if (!json.results || !json.results.length) {
          throw new Error('找不到城市「' + name + '」，请尝试英文名或「纬度,经度」格式');
        }
        var r = json.results[0];
        return {
          name: r.name,
          country: r.country || '',
          admin1: r.admin1 || '',
          latitude: r.latitude,
          longitude: r.longitude,
          timezone: r.timezone || 'auto'
        };
      });
    },

    /* 单点天气预报（含时区偏移），forecast_days=2 保证覆盖日落时刻 */
    fetchForecast: function (lat, lon) {
      var url = SS.config.endpoints.forecast +
        '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
        '&hourly=' + SS.config.hourlyVariables +
        '&forecast_days=2&timezone=auto';
      return fetchJson(url);
    },

    /* 空气质量（AOD + PM2.5，用于 Atmosphere Score） */
    fetchAirQuality: function (lat, lon) {
      var url = SS.config.endpoints.airQuality +
        '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
        '&hourly=aerosol_optical_depth,pm2_5&forecast_days=2&timezone=auto';
      return fetchJson(url);
    },

    /**
     * 并发获取全部数据：13 个采样点天气 + 本地空气质量。
     * 单个采样点失败不影响整体（进入 confidence 的空间完整度扣分）。
     * @returns {Promise<{samples: Array, air: Object|null}>}
     */
    gather: function (lat, lon, sunsetAzimuthDeg, localForecast) {
      var points = buildSamplePoints(lat, lon, sunsetAzimuthDeg);
      var tasks = points.map(function (p, i) {
        if (p.distanceKm === 0) {
          /* 本地预报已取过，直接复用 */
          return Promise.resolve({ point: p, forecast: localForecast });
        }
        /* 每个采样点错峰 120ms 发起，并为重试预留递增延迟 */
        return delay(i * 120)
          .then(function () { return fetchForecastWithRetry(p.latitude, p.longitude, 1500 + i * 120); })
          .then(function (fc) { return { point: p, forecast: fc }; })
          .catch(function () { return { point: p, forecast: null }; });
      });

      return Promise.all([
        Promise.all(tasks),
        SS.data.fetchAirQuality(lat, lon).catch(function () { return null; })
      ]).then(function (results) {
        return {
          samples: results[0],
          air: results[1],
          expectedSampleCount: points.length
        };
      });
    },

    /**
     * 把 UTC 时刻转换为"当地时刻的伪 Date"：
     * 其 getUTC* 方法返回的正是当地时间的年月日时分。
     */
    toLocalShifted: function (utcDate, utcOffsetSeconds) {
      return new Date(utcDate.getTime() + utcOffsetSeconds * 1000);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
