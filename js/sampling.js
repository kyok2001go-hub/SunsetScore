/* ============================================================
 * SunsetScore V1.8 - Spatial Sampling Controller（方案 7-9、17、20 章）
 * 职责：
 *   1. 仅凭本地预报预判 Weather Regime（estimateLocalRegime）
 *   2. 决定采样模式 LOCAL_ONLY / STANDARD(7点) / FULL(13点)
 *   3. 生成带角色与重要性权重的空间节点（selectNodes）
 *   5. 按节点权重的加权空间完整度（weightedCompleteness）
 * 本模块只做数据获取层决策，不参与评分。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function valid(v) { return typeof v === 'number' && isFinite(v); }

  /* 伪当地 Date → 'YYYY-MM-DDTHH:00'（与 engine.localKey 同构） */
  function localKey(shifted) {
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    return shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) +
      '-' + pad2(shifted.getUTCDate()) + 'T' + pad2(shifted.getUTCHours()) + ':00';
  }

  /**
   * 仅用本地节点的简化 Regime 预判（方案 8.1 节）。
   * 阈值与 engine.js V1.7 判定保持一致，空间信号（扇区低云减少）
   * 用本地节点近似。结果只用于选择采样模式，不参与评分。
   * @param {{localForecast, utcOffsetSeconds, nowUtc: Date, sunsetLocal: Date}} ctx
   * @returns {{regime, cloud, visKm, precip}}
   */
  function estimateLocalRegime(ctx) {
    var cfg = SS.modelConfig.scoring;
    var h = ctx.localForecast.hourly;
    var nowLocal = SS.data.toLocalShifted(ctx.nowUtc, ctx.utcOffsetSeconds);
    var idx = SS.engine.hourIndex(h.time, nowLocal);
    var sunsetIdx = SS.engine.hourIndex(h.time, ctx.sunsetLocal);
    function at(key, i) { return h[key] ? h[key][i] : null; }

    var cloud = at('cloud_cover', idx);
    var mid = at('cloud_cover_mid', idx);
    var high = at('cloud_cover_high', idx);
    var visM = at('visibility', idx);
    var rh = at('relative_humidity_2m', idx);
    var curRain = at('precipitation', idx);
    var rainProb = at('precipitation_probability', idx);
    var wind = at('wind_speed_10m', idx);
    curRain = valid(curRain) ? curRain : 0;
    rainProb = valid(rainProb) ? rainProb : 0;
    wind = valid(wind) ? wind : 0;
    var visKm = valid(visM) ? visM / 1000 : null;

    /* 过去 lookback 小时降雨量与 6 小时气压降幅（对齐 engine 判定） */
    var lookback = cfg.rainToClearLookbackHours;
    var pastRain = 0, k;
    for (k = Math.max(0, idx - lookback); k < idx; k++) {
      var p = at('precipitation', k);
      if (valid(p)) pastRain += p;
    }
    var pressureDrop = 0;
    var press = at('surface_pressure', idx);
    if (valid(press)) {
      var pPrev = at('surface_pressure', Math.max(0, idx - 6));
      if (valid(pPrev)) pressureDrop = pPrev - press;
    }
    var midHigh = (valid(mid) ? mid : 0) + (valid(high) ? high : 0);

    /* RAIN_TO_CLEAR 的两个时间信号（本地近似版）：
       日落方向低云减少 → 用本地低云代替扇区均值；黄金窗口用本地降雨序列 */
    var lowLead = cfg.rainToClearLowCloudLeadHours;
    var lowEarlier = at('cloud_cover_low', sunsetIdx - lowLead);
    var lowLater = at('cloud_cover_low', sunsetIdx);
    var lowCloudDecreasing = valid(lowEarlier) && valid(lowLater) &&
      (lowEarlier - lowLater) >= cfg.rainToClearLowCloudDrop;

    var lastRainIdx = -1;
    for (k = idx - 1; k >= Math.max(0, idx - lookback); k--) {
      var pr = at('precipitation', k);
      if (valid(pr) && pr >= cfg.rainToClearMinRainMm) { lastRainIdx = k; break; }
    }
    var goldenWindowOk = false;
    if (lastRainIdx >= 0 && h.time[lastRainIdx + 1]) {
      var rainEndMs = Date.parse(h.time[lastRainIdx + 1]);
      var gapMin = (Date.parse(localKey(ctx.sunsetLocal)) - rainEndMs) / 60000;
      var gw = cfg.rainToClearGoldenWindow;
      goldenWindowOk = gapMin >= gw.min && (gapMin - 60) <= gw.max;
    }

    var regime;
    if (wind >= 60 || (rainProb >= 80 && curRain >= 8)) {
      regime = 'STORM_APPROACHING';
    } else if (pastRain >= 1 && curRain < 0.3 && rainProb <= 50 && midHigh >= 30 &&
               lowCloudDecreasing && goldenWindowOk) {
      regime = 'RAIN_TO_CLEAR';
    } else if (visKm != null && visKm < 5 && valid(rh) && rh > 85) {
      regime = 'HAZY';
    } else if (valid(cloud) && cloud >= 85) {
      regime = 'OVERCAST';
    } else if (valid(cloud) && cloud < 20) {
      regime = 'CLEAR';
    } else if (pressureDrop >= 3 && wind >= 30) {
      regime = 'FRONT_PASSING';
    } else {
      regime = 'PARTLY_CLOUDY';
    }

    return { regime: regime, cloud: cloud, visKm: visKm, precip: curRain };
  }

  /**
   * 采样模式决策（方案 8.2-8.3 节）
   * @returns {'LOCAL_ONLY'|'STANDARD'|'FULL'}
   */
  function decideSamplingMode(reg) {
    var lo = SS.modelConfig.sampling.localOnly;
    /* 浓厚阴天：空间差异基本不存在，空间采样价值低 */
    if (reg.regime === 'OVERCAST' && valid(reg.cloud) && reg.cloud >= lo.cloudCoverMin &&
        ((reg.visKm != null && reg.visKm <= lo.visibilityMaxKm) ||
         (valid(reg.precip) && reg.precip >= lo.precipitationMinMm))) {
      return 'LOCAL_ONLY';
    }
    /* 复杂/过渡天气型：需要完整 13 点空间模型 */
    if (reg.regime === 'RAIN_TO_CLEAR' || reg.regime === 'FRONT_PASSING' ||
        reg.regime === 'STORM_APPROACHING') {
      return 'FULL';
    }
    return 'STANDARD';
  }

  function nodeWeight(role) {
    var w = SS.modelConfig.sampling.nodeWeights;
    return w[role] != null ? w[role] : 0.5;
  }

  /**
   * 生成空间节点（方案 6-7 章）
   * LOCAL_ONLY：仅 Local；
   * STANDARD：Local + 走廊(0°)全距离 + ±30° 云幕各 1 点 = 7 点；
   * FULL：Local + 3 方位 × 4 距离 = 13 点。
   * 节点携带 role/weight，供加权完整度使用。
   */
  function selectNodes(mode, lat, lon, sunsetAzimuthDeg) {
    var cfg = SS.modelConfig.scoring;
    var samplingConfig = cfg.sampling;
    var nodes = [{
      latitude: lat, longitude: lon, distanceKm: 0, azimuthOffset: 0,
      role: 'local', weight: nodeWeight('local')
    }];
    if (mode === 'LOCAL_ONLY') return nodes;

    function addRay(offset, distances, role) {
      var bearing = (sunsetAzimuthDeg + offset + 360) % 360;
      distances.forEach(function (dist) {
        var p = SS.data.destinationPoint(lat, lon, bearing, dist);
        nodes.push({
          latitude: p.latitude, longitude: p.longitude,
          distanceKm: dist, azimuthOffset: offset,
          role: role, weight: nodeWeight(role)
        });
      });
    }

    if (mode === 'FULL') {
      cfg.azimuthOffsets.forEach(function (offset) {
        addRay(offset, cfg.distancesKm, offset === 0 ? 'corridor' : 'bank');
      });
    } else { /* STANDARD */
      addRay(0, samplingConfig.standardCorridorDistancesKm, 'corridor');
      addRay(-30, samplingConfig.standardBankDistancesKm, 'bank');
      addRay(30, samplingConfig.standardBankDistancesKm, 'bank');
    }
    return nodes;
  }

  /**
   * 加权空间完整度（方案 17 章）：核心节点权重高、远场节点权重低，
   * 使 7 点模式也能获得较高的 spatialConfidence。
   * @returns {number} 0~1
   */
  function weightedCompleteness(samples) {
    var total = 0, got = 0;
    samples.forEach(function (s) {
      var w = (s.point && valid(s.point.weight)) ? s.point.weight : 1;
      total += w;
      if (s.forecast) got += w;
    });
    return total > 0 ? got / total : 0;
  }

  SS.sampling = {
    estimateLocalRegime: estimateLocalRegime,
    decideSamplingMode: decideSamplingMode,
    selectNodes: selectNodes,
    weightedCompleteness: weightedCompleteness
  };
})(typeof window !== 'undefined' ? window : globalThis);
