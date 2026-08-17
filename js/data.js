/* ============================================================
 * SunsetScore V1.8 - 数据获取层
 * 前端直接调用 Open-Meteo 三接口（支持 CORS，file:// 可用）
 * V1.8：Multi-Coordinate Batch（N 节点 → 1 次 Forecast 请求）
 *       + 预报时间窗口裁剪；采样点选择交由 Sampling Controller
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

  /* 带一次重试的预报请求：保留供本地单点预报使用 */
  function fetchForecastWithRetry(lat, lon, retryDelayMs) {
    return SS.data.fetchForecast(lat, lon).catch(function () {
      return delay(retryDelayMs).then(function () { return SS.data.fetchForecast(lat, lon); });
    });
  }

  /* V1.8 指数退避重试（方案 14.1 节）：针对 429 / 网络错误 */
  function fetchBatchForecastWithRetry(nodes) {
    var rc = SS.config.samplingV18.batchRetry;
    function attempt(n, delayMs) {
      return SS.data.fetchBatchForecast(nodes).catch(function (err) {
        if (n >= rc.maxAttempts) throw err;
        return delay(delayMs).then(function () { return attempt(n + 1, delayMs * rc.backoffFactor); });
      });
    }
    return attempt(0, rc.baseDelayMs);
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
   * V1.8 起仅供回退/兼容使用，正常链路由 SS.sampling.selectNodes 选点
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
    fetchForecastWithRetry: fetchForecastWithRetry,
    fetchBatchForecastWithRetry: fetchBatchForecastWithRetry,

    /* V1.8 Multi-Coordinate Batch（方案 5 章）：N 个空间节点 → 1 次 Forecast 请求。
       Open-Meteo 多坐标时返回与坐标对齐的数组，单坐标时返回单对象 */
    fetchBatchForecast: function (nodes) {
      if (!nodes.length) return Promise.resolve([]);
      if (nodes.length === 1) {
        return SS.data.fetchForecast(nodes[0].latitude, nodes[0].longitude)
          .then(function (fc) { return [fc]; });
      }
      var lats = nodes.map(function (n) { return n.latitude.toFixed(4); }).join(',');
      var lons = nodes.map(function (n) { return n.longitude.toFixed(4); }).join(',');
      var url = SS.config.endpoints.forecast +
        '?latitude=' + lats + '&longitude=' + lons +
        '&hourly=' + SS.config.hourlyVariables +
        '&forecast_days=2&timezone=auto';
      return fetchJson(url).then(function (json) {
        var arr = Array.isArray(json) ? json : [json];
        if (arr.length !== nodes.length) {
          throw new Error('批量预报返回 ' + arr.length + ' 个结果，与 ' + nodes.length + ' 个坐标不匹配');
        }
        return arr;
      });
    },

    /* V1.8 时间窗口裁剪（方案 12 章）：只保留
       [min(日落-lookback, 当前-nowLookback), max(日落+lookahead, 当前+nowLookahead)] 的小时。
       hourly.time 为当地 ISO 字符串，需用各节点自身 utc_offset_seconds 换算成 UTC 比较 */
    trimForecastWindow: function (forecast, nowUtcMs, sunsetUtcMs) {
      var w = SS.config.forecastWindowV18;
      if (!forecast || !forecast.hourly || !forecast.hourly.time) return forecast;
      var offsetMs = (forecast.utc_offset_seconds || 0) * 1000;
      var startUtc = Math.min(sunsetUtcMs - w.lookbackHours * 3600000, nowUtcMs - w.nowLookbackHours * 3600000);
      var endUtc = Math.max(sunsetUtcMs + w.lookaheadHours * 3600000, nowUtcMs + w.nowLookaheadHours * 3600000);
      var times = forecast.hourly.time;
      var keep = [];
      for (var i = 0; i < times.length; i++) {
        var tUtc = Date.parse(times[i]) - offsetMs;
        if (tUtc >= startUtc && tUtc <= endUtc) keep.push(i);
      }
      if (!keep.length || keep.length === times.length) return forecast;
      var out = {}, k;
      for (k in forecast) {
        if (Object.prototype.hasOwnProperty.call(forecast, k) && k !== 'hourly') out[k] = forecast[k];
      }
      var hourly = {};
      for (k in forecast.hourly) {
        if (!Object.prototype.hasOwnProperty.call(forecast.hourly, k)) continue;
        hourly[k] = Array.isArray(forecast.hourly[k])
          ? keep.map(function (idx) { return forecast.hourly[k][idx]; })
          : forecast.hourly[k];
      }
      out.hourly = hourly;
      return out;
    },

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
     * V1.8 空间采样数据获取：nodes 由 Sampling Controller 选定（1/7/13 点）。
     * Local 节点复用已取的 localForecast，其余节点一次 Batch 请求（带指数退避）。
     * 空气质量由 app.js 单独获取（独立缓存 TTL）。
     * @returns {Promise<{samples: Array, expectedSampleCount: number}>}
     */
    gather: function (nodes, localForecast) {
      var samples = nodes.map(function (n) { return { point: n, forecast: null }; });
      var remoteIdx = [];
      nodes.forEach(function (n, i) {
        if (n.distanceKm === 0) samples[i].forecast = localForecast;
        else remoteIdx.push(i);
      });
      if (!remoteIdx.length) {
        return Promise.resolve({ samples: samples, expectedSampleCount: nodes.length });
      }
      var remoteNodes = remoteIdx.map(function (i) { return nodes[i]; });
      return fetchBatchForecastWithRetry(remoteNodes).then(function (arr) {
        remoteIdx.forEach(function (sampleIdx, j) { samples[sampleIdx].forecast = arr[j]; });
        return { samples: samples, expectedSampleCount: nodes.length };
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
