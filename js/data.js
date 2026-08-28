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

  function fetchJson(url, options) { return SS.network.json(url, options); }

  /* 带一次重试的预报请求：保留供本地单点预报使用 */
  function fetchForecastWithRetry(lat, lon, retryDelayMs, options) {
    return SS.data.fetchForecast(lat, lon, options).catch(function () {
      SS.network.throwIfAborted(options && options.signal);
      return SS.network.sleep(retryDelayMs, options).then(function () { return SS.data.fetchForecast(lat, lon, options); });
    });
  }

  /* V1.8 指数退避重试（方案 14.1 节）：针对 429 / 网络错误 */
  function fetchBatchForecastWithRetry(nodes, options) {
    var rc = SS.modelConfig.sampling.batchRetry;
    function attempt(n, delayMs) {
      return SS.data.fetchBatchForecast(nodes, options).catch(function (err) {
        SS.network.throwIfAborted(options && options.signal);
        if (n >= rc.maxAttempts) throw err;
        return SS.network.sleep(delayMs, options).then(function () { return attempt(n + 1, delayMs * rc.backoffFactor); });
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

  SS.data = {
    destinationPoint: destinationPoint,
    fetchForecastWithRetry: fetchForecastWithRetry,
    fetchBatchForecastWithRetry: fetchBatchForecastWithRetry,

    /* V1.8 Multi-Coordinate Batch（方案 5 章）：N 个空间节点 → 1 次 Forecast 请求。
       Open-Meteo 多坐标时返回与坐标对齐的数组，单坐标时返回单对象 */
    fetchBatchForecast: function (nodes, options) {
      if (!nodes.length) return Promise.resolve([]);
      if (nodes.length === 1) {
        return SS.data.fetchForecast(nodes[0].latitude, nodes[0].longitude, options)
          .then(function (fc) { return [fc]; });
      }
      var lats = nodes.map(function (n) { return n.latitude.toFixed(4); }).join(',');
      var lons = nodes.map(function (n) { return n.longitude.toFixed(4); }).join(',');
      var url = SS.modelConfig.api.forecast +
        '?latitude=' + lats + '&longitude=' + lons +
        '&hourly=' + SS.modelConfig.scoring.hourlyVariables +
        '&forecast_days=2&timezone=auto';
      return fetchJson(url, options).then(function (json) {
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
      var w = SS.modelConfig.scoring.forecastWindow;
      if (!forecast || !forecast.hourly || !forecast.hourly.time) return forecast;
      var startUtc = Math.min(sunsetUtcMs - w.lookbackHours * 3600000, nowUtcMs - w.nowLookbackHours * 3600000);
      var endUtc = Math.max(sunsetUtcMs + w.lookaheadHours * 3600000, nowUtcMs + w.nowLookaheadHours * 3600000);
      var times = forecast.hourly.time;
      var keep = [];
      for (var i = 0; i < times.length; i++) {
        var tUtc = SS.time.fromOpenMeteoLocal(times[i], forecast.utc_offset_seconds || 0);
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

    /* 原始地理编码列表；类型筛选、排序和中文后缀归一由 city_search.js 负责。 */
    searchLocations: function (name, options) {
      var url = SS.modelConfig.api.geocoding +
        '?name=' + encodeURIComponent(name) + '&count=' + SS.config.citySearch.requestCount + '&language=zh&format=json';
      return fetchJson(url, options).then(function (json) {
        if (!json || json.error || (json.results != null && !Array.isArray(json.results))) throw new Error('城市检索服务返回异常，请稍后重试');
        return json.results || [];
      });
    },

    searchDomesticLocations: function (name, options) {
      return fetchJson(SS.modelConfig.api.domesticGeocoding + '?q=' + encodeURIComponent(name), options).then(function (json) {
        if (!json || json.error || !Array.isArray(json.results)) throw new Error('国内城市检索服务返回异常，请稍后重试');
        return json.results;
      });
    },

    /* 与下拉候选共用同一套规则；直接搜索采用第一候选。 */
    geocode: function (name, options) { return SS.citySearch.resolve(name, options); },

    /* 单点天气预报（含时区偏移），forecast_days=2 保证覆盖日落时刻 */
    fetchForecast: function (lat, lon, options) {
      var url = SS.modelConfig.api.forecast +
        '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
        '&hourly=' + SS.modelConfig.scoring.hourlyVariables +
        '&forecast_days=2&timezone=auto';
      return fetchJson(url, options);
    },

    /* 空气质量（AOD + PM2.5，用于 Atmosphere Score） */
    fetchAirQuality: function (lat, lon, options) {
      var url = SS.modelConfig.api.airQuality +
        '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
        '&hourly=aerosol_optical_depth,pm2_5&forecast_days=2&timezone=auto';
      return fetchJson(url, options);
    },

    /**
     * V1.8 空间采样数据获取：nodes 由 Sampling Controller 选定（1/7/13 点）。
     * Local 节点复用已取的 localForecast，其余节点一次 Batch 请求（带指数退避）。
     * 空气质量由 app.js 单独获取（独立缓存 TTL）。
     * @returns {Promise<{samples: Array, expectedSampleCount: number}>}
     */
    gather: function (nodes, localForecast, options) {
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
      return fetchBatchForecastWithRetry(remoteNodes, options).then(function (arr) {
        remoteIdx.forEach(function (sampleIdx, j) { samples[sampleIdx].forecast = arr[j]; });
        return { samples: samples, expectedSampleCount: nodes.length };
      });
    },

    /**
     * 把 UTC 时刻转换为"当地时刻的伪 Date"：
     * 其 getUTC* 方法返回的正是当地时间的年月日时分。
     */
    toLocalShifted: function (utcDate, utcOffsetSeconds) {
      return SS.time.toLocalShifted(utcDate, utcOffsetSeconds);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
