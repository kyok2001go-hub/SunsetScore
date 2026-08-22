/* ============================================================
 * SunsetScore V1.8 - UI 逻辑与主流程编排
 * 链路：geocode → 本地预报（取时区）→ 太阳几何 → Regime 预判
 *       → Sampling Controller（LOCAL_ONLY/7点/13点）→ Batch 空间采样
 *       → 评分 → Confidence Check（必要时 7→13 升级）→ 渲染
 * V1.8：数据层优化（批量请求 / 分级缓存 / 降级链 / Debug 面板），
 *       V1.7 评分引擎不变
 * V1.9：Nowcasting 分钟级天空演化层（分钟降水 / 雷达 / 卫星三源融合），
 *       goldenWindowModifier 按临近门控叠加到基础分
 * ============================================================ */
(function () {
  'use strict';
  var SS = window.SunsetScore;
  var cfg = SS.config;

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var form = $('search-form');
  var input = $('city-input');
  var btn = $('search-btn');
  var statusEl = $('status');
  var loadingEl = $('loading');
  var loadingText = $('loading-text');
  var errorEl = $('error');
  var resultEl = $('result');

  var COMPONENT_LABELS = {
    sky_canvas: '云幕',
    horizon: '地平线',
    illumination: '云层受光',
    atmosphere: '大气',
    weather: '天气过程'
  };
  var LEVEL_CLASS = { '极佳': 'lv-best', '很好': 'lv-great', '不错': 'lv-good', '一般': 'lv-fair', '较差': 'lv-poor', '很差': 'lv-bad' };
  /* V1.61 空间演化字段的中文映射 */
  var GRADIENT_TYPE_LABEL = { far_cloud_bank: '远方云幕', approaching_cloud: '云层逼近', neutral: '无明显趋势' };
  var CLEARING_DIR_LABEL = { far_to_near: '自远方推进', near_to_far: '自近处退去', uniform: '均匀打开', none: '无打开' };
  /* V1.7 天气型动态权重字段映射 */
  var TRANSITION_LABEL = { IMPROVING: '有利过渡', DETERIORATING: '转差', STABLE: '稳定' };
  var DYNAMIC_WEIGHT_KEY = {
    sky_canvas: 'skyCanvas', horizon: 'horizon', illumination: 'illumination',
    atmosphere: 'atmosphere', weather: 'weather'
  };

  /* ---------- 工具 ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtHM(shifted) { return pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes()); }
  function fmtDate(shifted) {
    return shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate());
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function setLoading(text) {
    show(statusEl);
    show(loadingEl);
    hide(errorEl);
    if (text) loadingText.textContent = text;
  }
  function showError(msg) {
    show(statusEl);
    hide(loadingEl);
    show(errorEl);
    errorEl.textContent = msg;
    hide(resultEl);
  }
  function clearStatus() {
    hide(statusEl);
    hide(loadingEl);
    hide(errorEl);
  }

  /* 支持「纬度,经度」直接输入 */
  function parseCoordinates(text) {
    var m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name: lat.toFixed(2) + ', ' + lon.toFixed(2), country: '', admin1: '', latitude: lat, longitude: lon };
  }

  /* ---------- V1.8 数据层编排（方案 8、13-15、21 章） ---------- */
  var DEBUG_MODE = /[?&]debug=1/.test(location.search);
  var cfg18 = cfg.samplingV18;
  var cache18 = cfg.cacheV18;

  function newDebugInfo() {
    return { samplingMode: '—', requestedNodes: 0, apiRequests: 0, caches: [] };
  }

  /* 预报缓存 TTL：临近日落时缩短（方案 11 章） */
  function forecastTtlMinutes(sunsetMs, nowMs) {
    var h = (sunsetMs - nowMs) / 3600000;
    if (h >= 0 && h < 3) return cache18.ttlForecastWithin3h;
    if (h >= 0 && h < 6) return cache18.ttlForecastWithin6h;
    return cache18.ttlForecastMinutes;
  }

  /* 通用取数包装：FRESH 缓存 → API → STALE 回退（方案 13、15 章）。
     STALE 仅在网络请求失败时使用，并同步降低 confidence */
  function fetchWithCache(key, ttlMinutes, staleMaxHours, fetcher, dbg, tag) {
    var hit = SS.cache.getWithStatus(key, staleMaxHours);
    if (hit.status === 'FRESH') {
      if (dbg) dbg.caches.push(tag + ':FRESH');
      return Promise.resolve({ value: hit.value, cacheStatus: 'FRESH', ageMinutes: hit.ageMinutes });
    }
    return fetcher().then(function (value) {
      SS.cache.set(key, value, ttlMinutes);
      if (dbg) dbg.caches.push(tag + ':MISS');
      return { value: value, cacheStatus: 'MISS', ageMinutes: 0 };
    }).catch(function (err) {
      if (hit.status === 'STALE') {
        if (dbg) dbg.caches.push(tag + ':STALE(' + hit.ageMinutes + 'min)');
        return { value: hit.value, cacheStatus: 'STALE', ageMinutes: hit.ageMinutes };
      }
      throw err;
    });
  }

  /* 太阳几何：计算与缓存序列化（Date ↔ ISO 字符串） */
  function computeSolar(loc, nowUtc, offset) {
    var localNow = SS.data.toLocalShifted(nowUtc, offset);
    var noonUtcMs = Date.UTC(
      localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 12
    ) - offset * 1000;
    return SS.solar.getSunEvents(new Date(noonUtcMs), loc.latitude, loc.longitude);
  }
  function serializeSolar(s) {
    return {
      sunset: s.sunset.toISOString(),
      civilDusk: s.civilDusk.toISOString(),
      goldenHourStart: s.goldenHourStart ? s.goldenHourStart.toISOString() : null,
      goldenHourEnd: s.goldenHourEnd ? s.goldenHourEnd.toISOString() : null,
      sunsetAzimuthDeg: s.sunsetAzimuthDeg,
      twilightMinutes: s.twilightMinutes
    };
  }
  function restoreSolar(v) {
    return {
      sunset: new Date(v.sunset),
      civilDusk: new Date(v.civilDusk),
      goldenHourStart: v.goldenHourStart ? new Date(v.goldenHourStart) : (v.goldenHour ? new Date(v.goldenHour) : null),
      goldenHourEnd: v.goldenHourEnd ? new Date(v.goldenHourEnd) : null,
      sunsetAzimuthDeg: v.sunsetAzimuthDeg,
      twilightMinutes: v.twilightMinutes
    };
  }

  /* 空间场取数：空间缓存 FRESH → Batch API → STALE 回退 */
  function gatherSpatial(nodes, localForecast, spatialKey, ttlMinutes, dbg) {
    var hit = SS.cache.getWithStatus(spatialKey, cache18.staleMaxAgeHours);
    function assemble(forecasts) {
      return nodes.map(function (n, i) {
        /* Local 节点始终用最新本地预报，不复用空间缓存中的旧副本 */
        return { point: n, forecast: n.distanceKm === 0 ? localForecast : ((forecasts && forecasts[i]) || null) };
      });
    }
    if (hit.status === 'FRESH') {
      dbg.caches.push('spatial:FRESH(' + hit.ageMinutes + 'min)');
      return Promise.resolve({ samples: assemble(hit.value.forecasts), cacheStatus: 'FRESH', ageMinutes: hit.ageMinutes });
    }
    return SS.data.gather(nodes, localForecast).then(function (gathered) {
      if (nodes.length > 1) dbg.apiRequests++; /* 一次 Batch（LOCAL_ONLY 无远程请求） */
      SS.cache.set(spatialKey, {
        forecasts: gathered.samples.map(function (s) { return s.forecast; })
      }, ttlMinutes);
      dbg.caches.push('spatial:MISS');
      return { samples: gathered.samples, cacheStatus: 'MISS', ageMinutes: 0 };
    }).catch(function (err) {
      if (hit.status === 'STALE') {
        dbg.caches.push('spatial:STALE(' + hit.ageMinutes + 'min)');
        return { samples: assemble(hit.value.forecasts), cacheStatus: 'STALE', ageMinutes: hit.ageMinutes };
      }
      throw err;
    });
  }

  /* 降级链（方案 14 章）：FULL 失败 → STANDARD → LOCAL_ONLY，绝不直接失败 */
  function gatherWithFallback(mode, loc, solar, localForecast, dateStr, ttlMinutes, dbg) {
    var nodes = SS.sampling.selectNodes(mode, loc.latitude, loc.longitude, solar.sunsetAzimuthDeg);
    var key = SS.cacheKeys.spatial(dateStr, loc.latitude, loc.longitude, solar.sunsetAzimuthDeg, mode.toLowerCase());
    return gatherSpatial(nodes, localForecast, key, ttlMinutes, dbg)
      .then(function (res) {
        res.finalMode = mode;
        res.nodeCount = nodes.length;
        return res;
      })
      .catch(function () {
        if (mode === 'FULL') return gatherWithFallback('STANDARD', loc, solar, localForecast, dateStr, ttlMinutes, dbg);
        if (mode === 'STANDARD') return gatherWithFallback('LOCAL_ONLY', loc, solar, localForecast, dateStr, ttlMinutes, dbg);
        throw new Error('天气 API 暂不可用，请稍后重试');
      });
  }

  /* 传入引擎前裁剪预报时间窗口（方案 12 章） */
  function trimSamples(samples, nowUtc, sunset) {
    return samples.map(function (s) {
      return {
        point: s.point,
        forecast: s.forecast ? SS.data.trimForecastWindow(s.forecast, nowUtc.valueOf(), sunset.valueOf()) : null
      };
    });
  }

  /* 时区格式化：精简为 UTC+8、UTC-7 等标准紧凑时区字符串 */
  function formatTimezone(offsetSeconds) {
    var sign = offsetSeconds >= 0 ? '+' : '-';
    var absSec = Math.abs(offsetSeconds);
    var hours = Math.floor(absSec / 3600);
    var mins = Math.floor((absSec % 3600) / 60);
    return 'UTC' + sign + hours + (mins > 0 ? ':' + (mins < 10 ? '0' : '') + mins : '');
  }

  /* 组装引擎输入并补全展示字段 */
  function buildResult(ectx, samples, mode, cacheStatus, ageMinutes, escalated, escalationReason) {
    var result = SS.engine.compute({
      location: ectx.location,
      utcOffsetSeconds: ectx.offset,
      localNowUtc: ectx.nowUtc,
      solar: ectx.solar,
      sunsetLocal: ectx.sunsetLocal,
      samples: samples,
      air: ectx.air,
      cloudField: ectx.cloudField || null,
      totalSkyNodeCount: ectx.totalSkyNodeCount || samples.length,
      expectedSampleCount: samples.length,
      spatialCompleteness: SS.sampling.weightedCompleteness(samples),
      samplingMode: mode,
      cacheStatus: cacheStatus,
      dataAgeMinutes: ageMinutes,
      escalated: escalated,
      escalationReason: escalationReason,
      minutePrecip: ectx.minutePrecip || null
    });
    var viewing = SS.engine.bestViewing(ectx.solar, cfg);
    result.best_viewing = {
      start: fmtHM(SS.data.toLocalShifted(viewing.startUtc, ectx.offset)),
      peak: fmtHM(SS.data.toLocalShifted(viewing.peakUtc, ectx.offset)),
      end: fmtHM(SS.data.toLocalShifted(viewing.endUtc, ectx.offset))
    };
    result.sunset_local = fmtHM(ectx.sunsetLocal);
    var ghStart = ectx.solar.goldenHourStart
      ? SS.data.toLocalShifted(ectx.solar.goldenHourStart, ectx.offset)
      : null;
    var ghEnd = ectx.solar.goldenHourEnd
      ? SS.data.toLocalShifted(ectx.solar.goldenHourEnd, ectx.offset)
      : null;
    var bhEnd = ectx.solar.civilDusk
      ? SS.data.toLocalShifted(ectx.solar.civilDusk, ectx.offset)
      : null;
    result.golden_hour = (ghStart && ghEnd)
      ? fmtHM(ghStart) + ' – ' + fmtHM(ghEnd)
      : (ghStart ? fmtHM(ghStart) + ' – ' + result.sunset_local : '—');
    result.blue_hour = (ghEnd && bhEnd)
      ? fmtHM(ghEnd) + ' – ' + fmtHM(bhEnd)
      : (bhEnd ? result.sunset_local + ' – ' + fmtHM(bhEnd) : '—');
    result.date = fmtDate(ectx.localNow);
    result.local_time_str = fmtHM(ectx.localNow);
    result.timezone_str = formatTimezone(ectx.offset, ectx.timezone);
    result.hours_to_sunset = ectx.hoursToSunset;
    result.nowcast_active = !!ectx.ncActive;
    return result;
  }

  /* Smart Escalation：7 → 13，只补取缺失节点（方案 9、20 章）。
     升级失败时返回 null，保留 7 点结果 */
  function escalateToFull(ectx, prelimSamples, prelim, esc, ttlMinutes, dbg) {
    var fullNodes = SS.sampling.selectNodes('FULL', ectx.location.latitude, ectx.location.longitude, ectx.solar.sunsetAzimuthDeg);
    function keyOf(p) { return p.distanceKm + ':' + p.azimuthOffset; }
    var have = {};
    prelimSamples.forEach(function (s) { have[keyOf(s.point)] = s; });
    var missing = fullNodes.filter(function (n) { return !have[keyOf(n)]; });
    if (!missing.length) return Promise.resolve(null);

    setLoading('检测到复杂天空，升级为完整 13 点采样…');
    return SS.data.fetchBatchForecastWithRetry(missing)
      .then(function (forecasts) {
        dbg.apiRequests++;
        var byKey = {};
        missing.forEach(function (n, j) { byKey[keyOf(n)] = forecasts[j]; });
        var fullSamples = fullNodes.map(function (n) {
          return have[keyOf(n)] || { point: n, forecast: byKey[keyOf(n)] || null };
        });
        /* 合并结果写入 full 模式缓存，后续同模式查询直接命中 */
        var fullKey = SS.cacheKeys.spatial(ectx.dateStr, ectx.location.latitude, ectx.location.longitude,
          ectx.solar.sunsetAzimuthDeg, 'full');
        SS.cache.set(fullKey, {
          forecasts: fullSamples.map(function (s) { return s.forecast; })
        }, ttlMinutes);
        var trimmed = trimSamples(fullSamples, ectx.nowUtc, ectx.solar.sunset);
        return buildResult(ectx, trimmed, 'FULL', prelim.cache_status, prelim.data_age || 0, true, esc.reason);
      })
      .catch(function () { return null; });
  }

  /* ---------- V1.8 Debug 信息（方案 26 章） ---------- */
  function renderDebugPanel(dbg, result) {
    var summary = {
      'Sampling Mode': dbg.samplingMode + (result.escalated ? ' → FULL' : ''),
      'Requested Nodes': dbg.requestedNodes + (result.escalated ? ' → ' + result.data.samples_expected : ''),
      'API Requests': dbg.apiRequests,
      'Cache': dbg.caches.join(' · ') || '—',
      'Spatial Completeness': result.spatial_completeness != null ? result.spatial_completeness : '—',
      'Spatial Variance': result.spatial_variance != null ? result.spatial_variance : '—',
      'Score Confidence': result.confidence,
      'Escalated': result.escalated ? 'YES' : 'NO',
      'Escalation Reason': result.escalation_reason || '—',
      'Nowcast Modifier': result.nowcast && result.nowcast.appliedModifier != null
        ? result.nowcast.appliedModifier + '（门控 ' + result.nowcast.proximityGate + '）'
        : '—',
      'Nowcast Sources': result.nowcast ? result.nowcast.sources.join(' / ') : '—',
      'Evolution State': result.sky_evolution
        ? result.sky_evolution.state + '（' + Math.round(result.sky_evolution.confidence * 100) + '%）' : '—',
      'Open Prob (60m)': result.sky_evolution
        ? Math.round(result.sky_evolution.openProbability['60m'] * 100) + '%' : '—'
    };
    if (typeof console !== 'undefined' && console.info) console.info('[SunsetScore V2.0]', summary);
    if (!DEBUG_MODE) return;
    var panel = $('debug-panel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'debug-panel';
      panel.style.cssText = 'margin-top:16px;padding:14px 18px;border:1px dashed rgba(255,255,255,0.25);' +
        'border-radius:12px;font:12px/1.9 ui-monospace,Consolas,monospace;color:#9fb3c8;';
      resultEl.parentNode.insertBefore(panel, resultEl.nextSibling);
    }
    var html = '<strong style="color:#e8eef5">Debug 信息（?debug=1）</strong><br>';
    Object.keys(summary).forEach(function (k) {
      html += k + ': <span style="color:#e8eef5">' + summary[k] + '</span><br>';
    });
    panel.innerHTML = html;
    show(panel);
  }

  /* ---------- V1.9 Nowcasting 编排（技术方案 7-9 章） ---------- */
  var NC_TREND_LABEL = { OPENING: '↑ 云层正在打开', APPROACHING: '↓ 云层正在逼近', STABLE: '→ 天空状态稳定' };
  var NC_RISK_LABEL = { HIGH: '高', MEDIUM: '中', LOW: '低', NONE: '无' };

  /* 分钟级降水预取（带 10 分钟缓存）：既供引擎黄金窗口精确判定，
     也供后续融合复用（与 SS.nowcast.run 同 key 同格式） */
  function fetchMinutePrecipCached(loc, dateStr, nowUtc, dbg) {
    var key = SS.cacheKeys.nowcast('precip', dateStr, loc.latitude, loc.longitude);
    var fresh = SS.cache.get(key);
    if (fresh && fresh.analysis) {
      dbg.caches.push('nowcast-precip:FRESH');
      return Promise.resolve(fresh.analysis);
    }
    return SS.nowcast.fetchMinutePrecip(loc.latitude, loc.longitude).then(function (series) {
      dbg.apiRequests++;
      var a = SS.nowcast.analyzePrecip(series, nowUtc.valueOf());
      if (a) SS.cache.set(key, { analysis: a }, cfg.nowcastV19.ttlMinutes.precip);
      dbg.caches.push('nowcast-precip:MISS');
      return a;
    }).catch(function () { return null; });
  }

  /* 小时预报云量趋势（融合的 forecast 源）：日落前云量减少 → 正值 */
  function computeForecastTrend(localForecast, offset, nowUtc, solar) {
    var h = localForecast.hourly;
    if (!h || !h.cloud_cover) return null;
    var nowIdx = SS.engine.hourIndex(h.time, SS.data.toLocalShifted(nowUtc, offset));
    var sunsetIdx = SS.engine.hourIndex(h.time, SS.data.toLocalShifted(solar.sunset, offset));
    var cNow = h.cloud_cover[nowIdx], cSun = h.cloud_cover[sunsetIdx];
    if (typeof cNow !== 'number' || typeof cSun !== 'number') return null;
    return Math.max(-100, Math.min(100, (cNow - cSun) * 2));
  }

  /* 临近门控：≤fullGateHours 全量生效，fadeEndHours 处衰减为 0 */
  function nowcastGate(hoursToSunset) {
    var g = cfg.nowcastV19.proximityGate;
    if (hoursToSunset <= g.fullGateHours) return 1;
    if (hoursToSunset >= g.fadeEndHours) return 0;
    return (g.fadeEndHours - hoursToSunset) / (g.fadeEndHours - g.fullGateHours);
  }

  function levelOf(score) {
    for (var i = 0; i < cfg.levels.length; i++) {
      if (score >= cfg.levels[i].min) return cfg.levels[i].label;
    }
    return cfg.levels[cfg.levels.length - 1].label;
  }

  /* 融合与叠加：Score = Clamp[ V1.8 基础分 + modifier × gate, 0, 100 ]。
     全源缺失/失败时静默回退，结果保持 V1.8 原样 */
  function applyNowcast(result, ectx, dbg) {
    if (!ectx.ncActive || !result) return Promise.resolve(result);
    var ctx = {
      lat: ectx.location.latitude, lon: ectx.location.longitude,
      dateStr: ectx.dateStr, nowUtc: ectx.nowUtc,
      sunsetAzimuthDeg: ectx.solar.sunsetAzimuthDeg,
      utcOffsetSeconds: ectx.offset,
      forecastTrend: computeForecastTrend(ectx.localForecast, ectx.offset, ectx.nowUtc, ectx.solar)
    };
    return SS.nowcast.run(ctx).then(function (fusion) {
      if (!fusion) return result;
      var gate = nowcastGate(ectx.hoursToSunset);
      var applied = Math.round(fusion.goldenWindowModifier * gate);
      fusion.appliedModifier = applied;
      fusion.proximityGate = Math.round(gate * 100) / 100;
      /* 供时间轴渲染：把分钟降水序列附到融合结果（随结果缓存序列化） */
      if (ectx.minutePrecip && fusion.detail && fusion.detail.precip) {
        fusion.detail.precip.series = ectx.minutePrecip.series;
      }
      if (applied !== 0) {
        result.score = Math.max(0, Math.min(100, result.score + applied));
        result.level = levelOf(result.score);
      }
      result.nowcast = fusion;
      /* 可解释输出（方案 10 章） */
      if (fusion.trend === 'OPENING') result.reasons.push('分钟级临近预报：云层正在打开');
      if (fusion.trend === 'APPROACHING') result.warnings.push('分钟级临近预报：云层正在向日落方向逼近');
      var radar = fusion.detail && fusion.detail.radar;
      if (radar && radar.risk === 'HIGH') {
        result.warnings.push('雷达显示降雨回波预计 ' + radar.arrivalMin + ' 分钟内进入日落走廊');
      }
      return result;
    }).catch(function () { return result; });
  }

  /* V2.1 全天空 360° 云场与走廊合并采样（1 次 Batch 请求获取全部采样点） */
  function gatherFullSkyAndCorridor(mode, loc, solar, localForecast, dateStr, ttlMinutes, dbg) {
    if (mode === 'LOCAL_ONLY') {
      var localNode = { distanceKm: 0, azimuthOffset: 0, latitude: loc.latitude, longitude: loc.longitude, direction: 'CENTER', key: 'CENTER_0' };
      return Promise.resolve({
        allSamples: [{ point: localNode, forecast: localForecast }],
        skySamples: [{ point: localNode, forecast: localForecast }],
        corridorSamples: [{ point: localNode, forecast: localForecast }],
        cacheStatus: 'LOCAL',
        ageMinutes: 0,
        nodeCount: 1,
        finalMode: 'LOCAL_ONLY'
      });
    }

    var skyNodes = SS.cloudField.generateGridNodes(loc.latitude, loc.longitude);
    var corridorNodes = SS.sampling.selectNodes('FULL', loc.latitude, loc.longitude, solar.sunsetAzimuthDeg);

    var map = {};
    var combinedNodes = [];
    function add(n) {
      var k = n.latitude.toFixed(4) + '_' + n.longitude.toFixed(4);
      if (!map[k]) {
        map[k] = n;
        combinedNodes.push(n);
      }
    }
    skyNodes.forEach(add);
    corridorNodes.forEach(add);

    var spatialKey = SS.cacheKeys.cloudField(dateStr, loc.latitude, loc.longitude);
    return gatherSpatial(combinedNodes, localForecast, spatialKey, ttlMinutes, dbg).then(function (res) {
      var sampleMap = {};
      res.samples.forEach(function (s) {
        var k = s.point.latitude.toFixed(4) + '_' + s.point.longitude.toFixed(4);
        sampleMap[k] = s;
      });

      var skySamples = skyNodes.map(function (n) {
        var k = n.latitude.toFixed(4) + '_' + n.longitude.toFixed(4);
        return { point: n, forecast: sampleMap[k] ? sampleMap[k].forecast : null };
      });
      var corridorSamples = corridorNodes.map(function (n) {
        var k = n.latitude.toFixed(4) + '_' + n.longitude.toFixed(4);
        return { point: n, forecast: sampleMap[k] ? sampleMap[k].forecast : null };
      });

      return {
        allSamples: res.samples,
        skySamples: skySamples,
        corridorSamples: corridorSamples,
        cacheStatus: res.cacheStatus,
        ageMinutes: res.ageMinutes,
        nodeCount: combinedNodes.length,
        finalMode: 'FULL_SKY'
      };
    }).catch(function () {
      /* 失败时回退到经典走廊采样 */
      return gatherWithFallback(mode, loc, solar, localForecast, dateStr, ttlMinutes, dbg)
        .then(function (fallbackRes) {
          return {
            allSamples: fallbackRes.samples,
            skySamples: fallbackRes.samples,
            corridorSamples: fallbackRes.samples,
            cacheStatus: fallbackRes.cacheStatus,
            ageMinutes: fallbackRes.ageMinutes,
            nodeCount: fallbackRes.nodeCount,
            finalMode: fallbackRes.finalMode
          };
        });
    });
  }

  /* ---------- V2.0/V2.1 天空演化与日落事件层 ---------- */
  var EVO_STATE_LABEL = { OPENING: '正在打开', OPEN: '开放', CLOSING: '正在闭合', BLOCKED: '持续遮挡', UNCERTAIN: '不确定' };
  var EVO_STATE_CLASS = {
    OPENING: 'evo-opening', OPEN: 'evo-open', CLOSING: 'evo-closing',
    BLOCKED: 'evo-blocked', UNCERTAIN: 'evo-uncertain'
  };

  /* V2.1 双因子乘法融合评分：FinalScore = BaseScore × SkyEvolutionFactor × GoldenWindowFactor */
  function applySkyEvolution(result, ectx, dbg) {
    /* 仅在临近日落时段（ncActive 为 true）激活 Nowcasting 与日落走廊微观演化 */
    if (!ectx.ncActive) {
      result.nowcast = null;
      result.nowcast_active = false;
      if (result.sky_evolution_factor != null) {
        result.score = Math.max(0, Math.min(100, Math.round(result.score * result.sky_evolution_factor)));
        result.level = levelOf(result.score);
      }
      return Promise.resolve(result);
    }
    result.nowcast_active = true;
    if (cfg.evolutionV20.enabled) return applyEvolution(result, ectx, dbg);
    return applyNowcast(result, ectx, dbg);
  }

  function applyEvolutionResult(result, evo) {
    result.sky_evolution = evo;
    result.base_score = result.score;
    var gw = (evo && evo.gwFactor != null) ? evo.gwFactor : 1.0;
    var ef = result.sky_evolution_factor != null ? result.sky_evolution_factor : 1.0;
    result.score = Math.max(0, Math.min(100, Math.round(result.score * ef * gw)));
    result.level = levelOf(result.score);

    /* 可解释输出 */
    var p60 = Math.round(evo.openProbability['60m'] * 100);
    if (evo.state === 'OPENING') result.reasons.push('天空演化：云层正在打开（60 分钟开放概率 ' + p60 + '%）');
    if (evo.state === 'OPEN') result.reasons.push('天空演化：日落走廊已开放');
    if (evo.state === 'CLOSING') result.warnings.push('天空演化：云层正在闭合，日落时段可能被遮挡');
    if (evo.state === 'BLOCKED') result.warnings.push('天空演化：走廊持续遮挡，开放概率低');
    if (evo.state === 'UNCERTAIN') result.warnings.push('天空演化：变化不确定，请关注临近时段更新');
    return result;
  }

  function applyEvolution(result, ectx, dbg) {
    var ctx = {
      lat: ectx.location.latitude, lon: ectx.location.longitude,
      dateStr: ectx.dateStr, nowUtc: ectx.nowUtc,
      sunsetAzimuthDeg: ectx.solar.sunsetAzimuthDeg,
      utcOffsetSeconds: ectx.offset,
      forecastTrend: computeForecastTrend(ectx.localForecast, ectx.offset, ectx.nowUtc, ectx.solar),
      motionForecast: result.cloud_motion || null
    };
    /* 演化结果缓存（10 分钟） */
    var evoKey = SS.cacheKeys.evolution(ectx.dateStr, ectx.location.latitude, ectx.location.longitude);
    var cachedEvo = SS.cache.get(evoKey);
    if (cachedEvo) {
      result.nowcast = cachedEvo.nowcast || null;
      result.nowcast_active = true;
      return Promise.resolve(applyEvolutionResult(result, cachedEvo.evo));
    }
    return SS.nowcast.run(ctx).then(function (fusion) {
      var evo = SS.evolution.fuseEvolution({
        forecastTrend: ctx.forecastTrend,
        precip: fusion && fusion.detail ? fusion.detail.precip : null,
        radar: fusion && fusion.detail ? fusion.detail.radar : null,
        satellite: fusion && fusion.detail ? fusion.detail.satellite : null,
        motionForecast: ctx.motionForecast,
        nowMs: ectx.nowUtc.valueOf(),
        sunsetMs: ectx.solar.sunset.valueOf()
      });
      if (!evo) {
        if (result.sky_evolution_factor != null) {
          result.score = Math.max(0, Math.min(100, Math.round(result.score * result.sky_evolution_factor)));
          result.level = levelOf(result.score);
        }
        result.nowcast = fusion;
        result.nowcast_active = true;
        return result;
      }
      SS.cache.set(evoKey, { evo: evo, nowcast: fusion }, cfg.evolutionV20.evolutionTtlMinutes);
      result.nowcast = fusion;
      result.nowcast_active = true;
      return applyEvolutionResult(result, evo);
    }).catch(function () {
      if (result.sky_evolution_factor != null) {
        result.score = Math.max(0, Math.min(100, Math.round(result.score * result.sky_evolution_factor)));
        result.level = levelOf(result.score);
      }
      return result;
    });
  }

  /* 格式化为最贴近主流天气预报平台的标准风力参数（如：南风 · 10 km/h（2级）） */
  function fmtStandardWind(w) {
    if (!w) return '—';
    var dir = w.label || '—';
    /* 选取代表性风速（阵风或持续风速）并换算对应风级 */
    var displaySpeed = w.gustsKmH != null ? Math.round(w.gustsKmH) : Math.round((w.speedKmH || 0) * 1.8);
    if (displaySpeed < 1) displaySpeed = Math.round(w.speedKmH || 0);
    var beaufort = SS.wind && SS.wind.formatBeaufort ? SS.wind.formatBeaufort(displaySpeed) : (w.beaufort || { level: 2 });
    var levelText = (beaufort.level != null && beaufort.level > 0) ? beaufort.level + '级' : '微风';
    return dir + ' · ' + displaySpeed + ' km/h（' + levelText + '）';
  }

  /* 融合统一的【天空演化】模块渲染（全天候天空动力学 + 风场驱动云场演化） */
  function renderSkyEvolution(r) {
    var block = $('sky-evolution-block');
    if (!block) return;
    var st = r.all_day_sky_state;
    var cm = r.cloud_motion;
    var cf = r.cloud_field;
    var evo = r.sky_evolution;
    if (!st && !evo) {
      hide(block);
      return;
    }
    show(block);

    /* 状态徽章：展示全天 6 态宏观演化状态 */
    var badge = $('sky-state-badge');
    if (badge && st) {
      badge.textContent = st.icon + ' ' + st.label;
      badge.style.background = st.color ? st.color + '22' : 'rgba(255,255,255,0.1)';
      badge.style.color = st.color || '#fff';
      badge.style.border = '1px solid ' + (st.color ? st.color + '66' : 'rgba(255,255,255,0.2)');
    } else if (badge && evo) {
      badge.textContent = EVO_STATE_LABEL[evo.state] || evo.state;
      badge.style.background = 'rgba(255,255,255,0.1)';
      badge.style.color = '#fff';
      badge.style.border = '1px solid rgba(255,255,255,0.2)';
    }

    /* 风向风速（最贴近主流天气预报的简洁参数展示） */
    var windEl = $('sky-wind-val');
    if (windEl) {
      windEl.textContent = fmtStandardWind(cm && cm.wind);
    }

    /* 云场态势 */
    var trendEl = $('sky-trend-val');
    if (trendEl) {
      var avgC = (cf && cf.summary) ? cf.summary.avgCloudCover : (st && st.metrics ? st.metrics.currentCloudCover : '—');
      trendEl.textContent = (st ? st.description + '（全天云量 ' + avgC + '%）' : '全天云量 ' + avgC + '%');
    }

    /* 演化因子 */
    var factorEl = $('sky-factor-val');
    if (factorEl) {
      var fac = r.sky_evolution_factor != null ? r.sky_evolution_factor : 1.0;
      factorEl.textContent = '×' + fac.toFixed(2) + (st && st.label ? ' · ' + st.label : '');
    }

    /* 日落走廊演化态势 */
    var corridorEl = $('sky-corridor-val');
    if (corridorEl) {
      if (evo && evo.sunsetOpenProbability != null) {
        corridorEl.textContent = '开放概率 ' + Math.round(evo.sunsetOpenProbability * 100) + '% · ' + (EVO_STATE_LABEL[evo.state] || '稳定');
      } else if (evo && evo.openProbability && evo.openProbability['60m'] != null) {
        corridorEl.textContent = '60m 开放概率 ' + Math.round(evo.openProbability['60m'] * 100) + '% · ' + (EVO_STATE_LABEL[evo.state] || '稳定');
      } else {
        corridorEl.textContent = '日落走廊通畅 · 背景支持良好';
      }
    }

    /* 上游云团预警 */
    var arrivalEl = $('sky-arrival-val');
    if (arrivalEl) {
      arrivalEl.textContent = (cm && cm.arrivalRisk ? cm.arrivalRisk.summaryText : '上游无密集浓云');
    }
  }

  /* ---------- V2.1.2 当前全天空云场分布（33 点全天空立体雷达方位图与动态风场矢量） ---------- */
  var RADAR_DIRS = [
    { dir: 'N', az: 0, label: '北 (N)' },
    { dir: 'NE', az: 45, label: '东北 (NE)' },
    { dir: 'E', az: 90, label: '东 (E)' },
    { dir: 'SE', az: 135, label: '东南 (SE)' },
    { dir: 'S', az: 180, label: '南 (S)' },
    { dir: 'SW', az: 225, label: '西南 (SW)' },
    { dir: 'W', az: 270, label: '西 (W)' },
    { dir: 'NW', az: 315, label: '西北 (NW)' }
  ];
  /* 扩大每一环间距（扩大50km内环至74px）：50km(74px) -> 100km(132px) -> 200km(190px) -> 300km(248px)，步长 58px */
  var RADAR_DISTS = [50, 100, 200, 300];
  var RADAR_RADII = { 50: 74, 100: 132, 200: 190, 300: 248 };

  /* 分层显示状态控制（低云 / 中云 / 高云） */
  var radarVisibleLayers = { low: true, mid: true, high: true };
  var cachedRadarResult = null;
  var radarTogglesBound = false;

  function initRadarLayerToggles() {
    if (radarTogglesBound) return;
    var container = $('radar-layer-toggles');
    if (!container) return;

    var btns = container.querySelectorAll('.legend-item[data-layer]');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var layer = btn.getAttribute('data-layer');
        if (!layer) return;

        /* 切换图层显隐 */
        radarVisibleLayers[layer] = !radarVisibleLayers[layer];
        btn.classList.toggle('inactive', !radarVisibleLayers[layer]);
        btn.classList.toggle('active', radarVisibleLayers[layer]);
        btn.setAttribute('aria-pressed', radarVisibleLayers[layer] ? 'true' : 'false');

        /* 立即平滑刷新雷达图 */
        if (cachedRadarResult) {
          renderCloudFieldRadar(cachedRadarResult);
        }
      });
    });
    radarTogglesBound = true;
  }

  function renderCloudFieldRadar(r) {
    var block = $('cloud-field-radar-block');
    var svg = $('cloud-field-radar-svg');
    var tooltip = $('radar-tooltip');
    if (!block || !svg) return;

    var cf = r.cloud_field;
    if (!cf || (!cf.nodes && !cf.nodeMap)) {
      hide(block);
      return;
    }
    show(block);
    cachedRadarResult = r;
    initRadarLayerToggles();

    /* 画布几何参数（中心 310, 310，外环 248px，文字 280px，viewBox 0 0 620 620） */
    var cx = 310, cy = 310;
    /* 严格几何约束：50km 内环弦长 56.64px，径向步长 58px。
       圆形最大半径提升至原先 150% (23.5px，直径 47px)。
       在 100% 满云量时，相邻两点边缘净间隙保持在 ~9.6px（间隙收紧约 20%），绝对不交涉且视觉饱满 */
    var maxCloudRadius = 23.5;

    /* 收集 33 个节点及其云量 */
    var centerNode = cf.center || {};
    var cData = centerNode.data || {};
    var allPoints = [];

    /* 1. 中心本地节点 (0km) */
    allPoints.push({
      key: 'CENTER_0',
      label: '本地中心 (0km)',
      azimuth: 0,
      distanceKm: 0,
      x: cx,
      y: cy,
      low: cData.cloud_cover_low || 0,
      mid: cData.cloud_cover_mid || 0,
      high: cData.cloud_cover_high || 0,
      total: cData.cloud_cover || 0
    });

    /* 2. 8 方位 × 4 距离 = 32 个远端节点 */
    RADAR_DIRS.forEach(function (dInfo) {
      var radAngle = (dInfo.az * Math.PI) / 180;
      RADAR_DISTS.forEach(function (dist) {
        var ringR = RADAR_RADII[dist] || 248;
        var nx = cx + ringR * Math.sin(radAngle);
        var ny = cy - ringR * Math.cos(radAngle);

        var nodeKey = dInfo.dir + '_' + dist;
        var nodeRecord = (cf.nodeMap && cf.nodeMap[nodeKey]) || null;
        if (!nodeRecord && cf.nodes) {
          for (var i = 0; i < cf.nodes.length; i++) {
            if (cf.nodes[i].direction === dInfo.dir && cf.nodes[i].distanceKm === dist) {
              nodeRecord = cf.nodes[i];
              break;
            }
          }
        }
        var nd = (nodeRecord && nodeRecord.data) ? nodeRecord.data : {};
        allPoints.push({
          key: nodeKey,
          label: dInfo.label + ' · ' + dist + 'km',
          azimuth: dInfo.az,
          distanceKm: dist,
          x: Math.round(nx * 10) / 10,
          y: Math.round(ny * 10) / 10,
          low: nd.cloud_cover_low || 0,
          mid: nd.cloud_cover_mid || 0,
          high: nd.cloud_cover_high || 0,
          total: nd.cloud_cover || 0
        });
      });
    });

    /* 统一尺度：云量百分比映射为圆形半径 (0% -> 0, >0% -> 3.2 ~ 23.5px) */
    function calcRadius(pct) {
      if (!pct || pct <= 0) return 0;
      return Math.max(3.2, (pct / 100) * maxCloudRadius);
    }

    /* 提取风场动力学参数（风向与风速） */
    var cm = r.cloud_motion || {};
    var windObj = cm.wind || (cData.wind_speed_10m != null ? cData : {});
    var windSpeed = (windObj.speedKmH != null) ? windObj.speedKmH : (windObj.wind_speed_10m || 15);
    var windDirFrom = (windObj.directionDeg != null) ? windObj.directionDeg : (windObj.wind_direction_10m || 0);
    var flowHeading = (windDirFrom + 180) % 360; /* 风向前进流动朝向 */
    var windDurationNum = Math.max(1.0, Math.min(6.0, 36 / Math.max(3, windSpeed)));
    var windDuration = windDurationNum.toFixed(2) + 's';

    var svgContent = '';

    /* ===== A0. 剪裁区域与底层动态风向渐变矢量流场（Dynamic Gradient Wind Particles） ===== */
    svgContent += '<defs>';
    svgContent += '<clipPath id="radar-disc-clip"><circle cx="' + cx + '" cy="' + cy + '" r="248" /></clipPath>';
    /* 渐变定义：尾部(y=0%)全透明 0 -> 头部(y=100%)透明度 20%~26% */
    svgContent += '<linearGradient id="wind-trail-grad" x1="0%" y1="0%" x2="0%" y2="100%">';
    svgContent += '<stop offset="0%" stop-color="#ffffff" stop-opacity="0" />';
    svgContent += '<stop offset="45%" stop-color="#ffffff" stop-opacity="0.04" />';
    svgContent += '<stop offset="80%" stop-color="#ffffff" stop-opacity="0.12" />';
    svgContent += '<stop offset="100%" stop-color="#ffffff" stop-opacity="0.22" />';
    svgContent += '</linearGradient>';

    svgContent += '<linearGradient id="wind-trail-grad-fine" x1="0%" y1="0%" x2="0%" y2="100%">';
    svgContent += '<stop offset="0%" stop-color="#ffffff" stop-opacity="0" />';
    svgContent += '<stop offset="50%" stop-color="#ffffff" stop-opacity="0.03" />';
    svgContent += '<stop offset="85%" stop-color="#ffffff" stop-opacity="0.08" />';
    svgContent += '<stop offset="100%" stop-color="#ffffff" stop-opacity="0.15" />';
    svgContent += '</linearGradient>';

    svgContent += '<linearGradient id="wind-trail-grad-accent" x1="0%" y1="0%" x2="0%" y2="100%">';
    svgContent += '<stop offset="0%" stop-color="#e2f0ff" stop-opacity="0" />';
    svgContent += '<stop offset="40%" stop-color="#e2f0ff" stop-opacity="0.06" />';
    svgContent += '<stop offset="80%" stop-color="#e2f0ff" stop-opacity="0.16" />';
    svgContent += '<stop offset="100%" stop-color="#e2f0ff" stop-opacity="0.28" />';
    svgContent += '</linearGradient>';
    svgContent += '</defs>';

    /* 动态矢量流场组：旋转对准实际风流前进方向，全场限制在 300km 距离盘内流动（密度降低 50%） */
    var rotDeg = (flowHeading - 180);
    svgContent += '<g class="radar-wind-flow" clip-path="url(#radar-disc-clip)" transform="rotate(' + rotDeg.toFixed(1) + ' ' + cx + ' ' + cy + ')">';
    var windTracks = [-180, -108, -36, 36, 108, 180];
    windTracks.forEach(function (gx, tIdx) {
      var lineX = cx + gx;
      var isAccent = (tIdx === 2 || tIdx === 3);
      var isFine = (tIdx === 0 || tIdx === 5);
      var trailLen = isAccent ? 52 : (isFine ? 38 : 46);
      var gradId = isAccent ? 'url(#wind-trail-grad-accent)' : (isFine ? 'url(#wind-trail-grad-fine)' : 'url(#wind-trail-grad)');
      var trailCls = isAccent ? 'radar-wind-trail trail-accent' : 'radar-wind-trail';
      var baseDelay = -0.5 * tIdx - 0.2 * (tIdx % 2);

      /* 渐变流线粒子 1 */
      var delay1 = baseDelay.toFixed(2) + 's';
      svgContent += '<g class="radar-wind-particle">';
      svgContent += '<animateTransform attributeName="transform" type="translate" from="0 -290" to="0 290" dur="' + windDuration + '" repeatCount="indefinite" begin="' + delay1 + '" />';
      svgContent += '<path d="M ' + lineX.toFixed(1) + ' ' + (cy - trailLen) + ' L ' + (lineX + 1.2).toFixed(1) + ' ' + (cy - 2) + ' A 1.2 1.2 0 0 1 ' + (lineX - 1.2).toFixed(1) + ' ' + (cy - 2) + ' Z" fill="' + gradId + '" class="' + trailCls + '" />';
      svgContent += '</g>';

      /* 渐变流线粒子 2（交错半个周期） */
      var delay2 = (baseDelay - windDurationNum * 0.5).toFixed(2) + 's';
      svgContent += '<g class="radar-wind-particle">';
      svgContent += '<animateTransform attributeName="transform" type="translate" from="0 -290" to="0 290" dur="' + windDuration + '" repeatCount="indefinite" begin="' + delay2 + '" />';
      svgContent += '<path d="M ' + lineX.toFixed(1) + ' ' + (cy - trailLen) + ' L ' + (lineX + 1.2).toFixed(1) + ' ' + (cy - 2) + ' A 1.2 1.2 0 0 1 ' + (lineX - 1.2).toFixed(1) + ' ' + (cy - 2) + ' Z" fill="' + gradId + '" class="' + trailCls + '" />';
      svgContent += '</g>';
    });
    svgContent += '</g>';

    /* ===== A. 网格底图层 ===== */
    /* 1. 4 圈同心虚线距离环（间距加大） */
    RADAR_DISTS.forEach(function (dist) {
      var rPx = RADAR_RADII[dist];
      svgContent += '<circle cx="' + cx + '" cy="' + cy + '" r="' + rPx + '" class="radar-grid-ring" />';
    });

    /* 2. 8 根方位轴线（虚线） */
    RADAR_DIRS.forEach(function (dInfo) {
      var radAngle = (dInfo.az * Math.PI) / 180;
      var xEnd = cx + 248 * Math.sin(radAngle);
      var yEnd = cy - 248 * Math.cos(radAngle);
      svgContent += '<line x1="' + cx + '" y1="' + cy + '" x2="' + xEnd.toFixed(1) + '" y2="' + yEnd.toFixed(1) + '" class="radar-grid-axis" />';
    });

    /* 3. 中心十字基准点 */
    svgContent += '<line x1="' + (cx - 6) + '" y1="' + cy + '" x2="' + (cx + 6) + '" y2="' + cy + '" stroke="rgba(255,255,255,0.28)" stroke-width="1.2" />';
    svgContent += '<line x1="' + cx + '" y1="' + (cy - 6) + '" x2="' + cx + '" y2="' + (cy + 6) + '" stroke="rgba(255,255,255,0.28)" stroke-width="1.2" />';

    /* 4. 8 方位文字标签（外环 R=280） */
    RADAR_DIRS.forEach(function (dInfo) {
      var radAngle = (dInfo.az * Math.PI) / 180;
      var lx = cx + 280 * Math.sin(radAngle);
      var ly = cy - 280 * Math.cos(radAngle);
      svgContent += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" class="radar-dir-label">' + dInfo.dir + '</text>';
    });

    /* 5. 距离刻度文字标签（沿北偏东 22.5° 轴线排列） */
    var distLabelAngle = (22.5 * Math.PI) / 180;
    RADAR_DISTS.forEach(function (dist) {
      var rPx = RADAR_RADII[dist];
      var tx = cx + rPx * Math.sin(distLabelAngle);
      var ty = cy - rPx * Math.cos(distLabelAngle);
      svgContent += '<text x="' + tx.toFixed(1) + '" y="' + (ty - 4).toFixed(1) + '" class="radar-dist-label">' + dist + 'km</text>';
    });

    /* 6. 日落方位指示虚线与徽标 */
    if (r.sunset_azimuth != null) {
      var sunAz = r.sunset_azimuth;
      var sunRad = (sunAz * Math.PI) / 180;
      var sx = cx + 258 * Math.sin(sunRad);
      var sy = cy - 258 * Math.cos(sunRad);
      svgContent += '<line x1="' + cx + '" y1="' + cy + '" x2="' + sx.toFixed(1) + '" y2="' + sy.toFixed(1) + '" class="radar-sunset-ray" />';

      /* 徽标沿日落射线中段排布（R=195px），配备暗色外廓光晕，杜绝溢出外框边缘 */
      var badgeR = 195;
      var badgeX = cx + badgeR * Math.sin(sunRad);
      var badgeY = cy - badgeR * Math.cos(sunRad);
      var badgeText = '🌅 日落 ' + Math.round(sunAz) + '°';

      svgContent += '<g class="radar-sunset-badge-group">';
      svgContent += '<text x="' + badgeX.toFixed(1) + '" y="' + (badgeY + 5).toFixed(1) + '" class="radar-sunset-badge-shadow">' + badgeText + '</text>';
      svgContent += '<text x="' + badgeX.toFixed(1) + '" y="' + (badgeY + 5).toFixed(1) + '" class="radar-sunset-badge">' + badgeText + '</text>';
      svgContent += '</g>';
    }

    /* ===== B. 云层绘制（严格按 低云 -> 中云 -> 高云 自底向上堆叠分层，并支持开关） ===== */
    /* 1. 底层：低云 (LOW) 半透明蓝 */
    if (radarVisibleLayers.low) {
      allPoints.forEach(function (p) {
        var rLow = calcRadius(p.low);
        if (rLow > 0) {
          svgContent += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + rLow.toFixed(1) + '" class="radar-cloud-circle radar-cloud-low" />';
        }
      });
    }

    /* 2. 中层：中云 (MID) 半透明绿 */
    if (radarVisibleLayers.mid) {
      allPoints.forEach(function (p) {
        var rMid = calcRadius(p.mid);
        if (rMid > 0) {
          svgContent += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + rMid.toFixed(1) + '" class="radar-cloud-circle radar-cloud-mid" />';
        }
      });
    }

    /* 3. 顶层：高云 (HIGH) 半透明橘 */
    if (radarVisibleLayers.high) {
      allPoints.forEach(function (p) {
        var rHigh = calcRadius(p.high);
        if (rHigh > 0) {
          svgContent += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + rHigh.toFixed(1) + '" class="radar-cloud-circle radar-cloud-high" />';
        }
      });
    }

    /* ===== C. 交互层（33 个采样点透明触发 Hitbox 与中心微光标点） ===== */
    allPoints.forEach(function (p, pIdx) {
      svgContent += '<g class="radar-node-target" data-idx="' + pIdx + '">';
      svgContent += '<circle cx="' + p.x + '" cy="' + p.y + '" r="24" fill="transparent" />';
      svgContent += '<circle cx="' + p.x + '" cy="' + p.y + '" r="2.8" fill="rgba(255,255,255,0.45)" class="radar-hover-indicator" stroke="transparent" />';
      svgContent += '</g>';
    });

    svg.innerHTML = svgContent;

    /* 交互事件绑定与 Tooltip */
    var targets = svg.querySelectorAll('.radar-node-target');
    var container = svg.closest('.radar-chart-container');

    function showTooltip(e, p) {
      if (!tooltip || !container) return;
      var rect = container.getBoundingClientRect();
      var clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      var clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      var posX = clientX - rect.left;
      var posY = clientY - rect.top;

      var lowStyle = radarVisibleLayers.low ? 'color:#85a5ff' : 'color:rgba(133,165,255,0.4);text-decoration:line-through';
      var midStyle = radarVisibleLayers.mid ? 'color:#95de64' : 'color:rgba(149,222,100,0.4);text-decoration:line-through';
      var highStyle = radarVisibleLayers.high ? 'color:#ffc069' : 'color:rgba(255,192,105,0.4);text-decoration:line-through';

      tooltip.innerHTML =
        '<div class="radar-tooltip-title">' + p.label + '</div>' +
        '<div class="radar-tooltip-row"><span>总云量:</span><strong>' + p.total + '%</strong></div>' +
        '<div class="radar-tooltip-row" style="' + lowStyle + '"><span>低云 (LOW):</span><span>' + p.low + '%' + (!radarVisibleLayers.low ? ' (隐藏)' : '') + '</span></div>' +
        '<div class="radar-tooltip-row" style="' + midStyle + '"><span>中云 (MID):</span><span>' + p.mid + '%' + (!radarVisibleLayers.mid ? ' (隐藏)' : '') + '</span></div>' +
        '<div class="radar-tooltip-row" style="' + highStyle + '"><span>高云 (HIGH):</span><span>' + p.high + '%' + (!radarVisibleLayers.high ? ' (隐藏)' : '') + '</span></div>';

      tooltip.style.left = Math.max(60, Math.min(rect.width - 60, posX)) + 'px';
      tooltip.style.top = Math.max(40, posY - 10) + 'px';
      tooltip.classList.remove('hidden');
    }

    function hideTooltip() {
      if (tooltip) tooltip.classList.add('hidden');
    }

    targets.forEach(function (el) {
      var idx = parseInt(el.getAttribute('data-idx'), 10);
      var p = allPoints[idx];
      if (!p) return;

      el.addEventListener('mouseenter', function (e) { showTooltip(e, p); });
      el.addEventListener('mousemove', function (e) { showTooltip(e, p); });
      el.addEventListener('mouseleave', hideTooltip);

      /* 移动端与点击：点击点位打开/更新气泡，并阻止冒泡以避免触发全局关闭 */
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        showTooltip(e, p);
      });
      el.addEventListener('touchstart', function (e) {
        e.stopPropagation();
        showTooltip(e, p);
      }, { passive: false });
    });

    if (container) {
      container.addEventListener('mouseleave', hideTooltip);
    }

    /* 移动端点击页面任意其他区域关闭气泡（全局监听仅绑定一次） */
    if (!window._radarGlobalDismissBound) {
      function handleGlobalTouchOrClick(e) {
        var t = $('radar-tooltip');
        if (t && !t.classList.contains('hidden')) {
          if (!e.target.closest || (!e.target.closest('.radar-node-target') && !e.target.closest('#radar-tooltip'))) {
            t.classList.add('hidden');
          }
        }
      }
      document.addEventListener('touchstart', handleGlobalTouchOrClick, { passive: true });
      document.addEventListener('click', handleGlobalTouchOrClick);
      window._radarGlobalDismissBound = true;
    }
  }

  /* 天空变化时间轴：以分钟降水为主，每 30 分钟一个点，共 5 点 */
  function precipAtSeries(s, tMs) {
    if (!s || !s.times) return null;
    var best = null, bestDiff = Infinity;
    for (var i = s.start; i < s.times.length; i++) {
      var diff = Math.abs(Date.parse(s.times[i]) - tMs);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best != null && bestDiff <= 15 * 60000 ? s.precip[best] : null;
  }
  function renderNowcastBlock(r, offset) {
    var block = $('nowcast-block');
    if (!block) return;
    var nc = r.nowcast;
    if (!r.nowcast_active || !nc) {
      hide(block);
      return;
    }
    show(block);
    var gw = nc.goldenWindow;
    var openTxt = gw
      ? SS.nowcast.fmtHM(gw.stopTimeMs, offset)
      : (nc.trend === 'OPENING' ? '正在打开' : '暂无');
    /* V2.0：附日落时刻走廊开放概率 */
    if (r.sky_evolution && r.sky_evolution.sunsetOpenProbability != null) {
      openTxt += '（开放概率 ' + Math.round(r.sky_evolution.sunsetOpenProbability * 100) + '%）';
    }
    $('n-open').textContent = openTxt;
    $('n-duration').textContent = gw ? gw.durationMin + ' 分钟' : '—';
    $('n-trend').textContent = (NC_TREND_LABEL[nc.trend] || '—') +
      (nc.appliedModifier ? '（修正 ' + (nc.appliedModifier > 0 ? '+' : '') + nc.appliedModifier + '）' : '');
    $('n-risk').textContent = NC_RISK_LABEL[nc.cloudRisk] || '—';
    /* QWeather 分钟降水文字摘要（如"95分钟后雨就停了"），回退源时为 — */
    var sumEl = $('n-summary');
    if (sumEl) {
      var sum = nc.detail && nc.detail.precip ? nc.detail.precip.summary : null;
      sumEl.textContent = sum || '—';
    }

    var tl = $('n-timeline');
    tl.innerHTML = '';
    var series = nc.detail && nc.detail.precip && nc.detail.precip.series;
    var radarCov = nc.detail && nc.detail.radar ? nc.detail.radar.coveragePct : null;
    var nowMs = Date.now();
    for (var p = 0; p < 5; p++) {
      var tMs = nowMs + p * 30 * 60000;
      var rain = precipAtSeries(series, tMs);
      var icon;
      if (rain != null && rain >= 0.3) icon = '🌧️';
      else if (rain != null && rain > 0) icon = '🌦️';
      else if (p === 0 && radarCov != null && radarCov > 50) icon = '☁️';
      else icon = p === 0 && nc.trend === 'OPENING' ? '🌤️' : (p >= 3 && nc.trend === 'OPENING' ? '🌤️' : '⛅');
      var item = document.createElement('div');
      item.className = 'timeline-item';
      item.innerHTML = '<span class="timeline-time">' + SS.nowcast.fmtHM(tMs, offset) + '</span>' +
        '<span class="timeline-icon">' + icon + '</span>';
      tl.appendChild(item);
    }
  }

  /* ---------- 主流程 ---------- */
  function finish(result, fullKey, offset, dbg) {
    SS.cache.set(fullKey, result);
    renderResult(result, offset, false);
    renderDebugPanel(dbg, result);
    return null;
  }

  function predict(query) {
    clearStatus();
    hide(resultEl);
    btn.disabled = true;

    var coords = parseCoordinates(query);
    var resultCacheKey = query.trim().toLowerCase().replace(/\s+/g, '_');
    var dbg = newDebugInfo();
    var oldPanel = $('debug-panel');
    if (oldPanel) hide(oldPanel);

    Promise.resolve()
      .then(function () {
        setLoading('正在解析地理位置…');
        if (coords) return Promise.resolve({ value: coords });
        return fetchWithCache(
          SS.cacheKeys.geocode(query.trim()),
          cache18.ttlGeocodingDays * 24 * 60,
          cache18.ttlGeocodingDays * 24,
          function () { dbg.apiRequests++; return SS.data.geocode(query.trim()); },
          dbg, 'geocode'
        );
      })
      .then(function (locRes) {
        var location = locRes.value;
        var nowUtc = new Date();
        setLoading('正在获取本地天气与时区…');

        /* 1. 先通过 forecast 接口获取当地真实时区偏移与天气预报 */
        var roughOffsetSec = Math.round((location.longitude || 0) * 240);
        var roughLocalDate = fmtDate(SS.data.toLocalShifted(nowUtc, roughOffsetSec));

        return fetchWithCache(
          SS.cacheKeys.forecast(roughLocalDate, location.latitude, location.longitude),
          cache18.ttlForecastMinutes,
          cache18.staleMaxAgeHours,
          function () {
            dbg.apiRequests++;
            return SS.data.fetchForecastWithRetry(location.latitude, location.longitude, 1500);
          },
          dbg, 'forecast'
        ).then(function (fcRes) {
          var localForecast = fcRes.value;
          var offset = localForecast.utc_offset_seconds || 0;
          var timezone = localForecast.timezone || location.timezone || 'auto';

          /* 2. 精确计算该城市所在地的当前当地时间与当地日期 */
          var localNow = SS.data.toLocalShifted(nowUtc, offset);
          var dateStr = fmtDate(localNow);

          /* 结果级缓存：同城重复查询的快速路径 */
          var fullKey = resultCacheKey + '_' + dateStr;
          var cached = SS.cache.get(fullKey);
          if (cached) {
            renderResult(cached, offset, true);
            dbg.samplingMode = cached.sampling_mode || 'CACHE';
            renderDebugPanel(dbg, cached);
            return null;
          }

          /* 3. 太阳几何：基于该城市当地日期的正午时刻计算当天日落 */
          var solarKey = SS.cacheKeys.solar(dateStr, location.latitude, location.longitude);
          return fetchWithCache(solarKey, cache18.ttlSolarHours * 60, cache18.ttlSolarHours, function () {
            var s = computeSolar(location, nowUtc, offset);
            if (!s) throw new Error('该地区当前处于极昼或极夜，今天没有日落');
            return Promise.resolve(serializeSolar(s));
          }, dbg, 'solar').then(function (solarRes) {
            var solar = restoreSolar(solarRes.value);
            var sunsetLocal = SS.data.toLocalShifted(solar.sunset, offset);

            /* 临近日落缩短预报 TTL：用精细化 TTL 重写缓存 */
            var ttl = forecastTtlMinutes(solar.sunset.valueOf(), nowUtc.valueOf());
            SS.cache.set(SS.cacheKeys.forecast(dateStr, location.latitude, location.longitude), localForecast, ttl);

            setLoading('正在获取空气质量…');
            var airKey = SS.cacheKeys.air(dateStr, location.latitude, location.longitude);
            return fetchWithCache(airKey, cache18.ttlAirQualityMinutes, cache18.staleMaxAgeHours, function () {
              dbg.apiRequests++;
              return SS.data.fetchAirQuality(location.latitude, location.longitude);
            }, dbg, 'air').catch(function () {
              return { value: null, cacheStatus: 'MISS', ageMinutes: 0 };
            }).then(function (airRes) {

              /* 4. 黄金窗口激活判定：仅在距日落 -0.5h ~ +3.0h (T-180m) 内激活 */
              var hoursToSunset = (solar.sunset.valueOf() - nowUtc.valueOf()) / 3600000;
              var ncCfg = cfg.nowcastV19;
              var ncActive = ncCfg.enabled && hoursToSunset >= -0.5 &&
                hoursToSunset <= ncCfg.proximityGate.fetchLimitHours;
              var precipPromise = ncActive
                ? fetchMinutePrecipCached(location, dateStr, nowUtc, dbg)
                : Promise.resolve(null);

              return precipPromise.then(function (minutePrecip) {
                var reg = SS.sampling.estimateLocalRegime({
                  localForecast: localForecast, utcOffsetSeconds: offset,
                  nowUtc: nowUtc, sunsetLocal: sunsetLocal
                });
                var mode = cfg18.enabled ? SS.sampling.decideSamplingMode(reg) : 'FULL';
                setLoading('正在获取全天空 360° 云场与风场动力学（33 个观测点 · 单次批量请求）…');

                var ectx = {
                  location: location, offset: offset, timezone: timezone,
                  nowUtc: nowUtc, localNow: localNow,
                  solar: solar, sunsetLocal: sunsetLocal, air: airRes.value, dateStr: dateStr,
                  localForecast: localForecast, minutePrecip: minutePrecip,
                  ncActive: ncActive, hoursToSunset: hoursToSunset
                };

                return gatherFullSkyAndCorridor(mode, location, solar, localForecast, dateStr, ttl, dbg)
                  .then(function (spatialRes) {
                    dbg.samplingMode = spatialRes.finalMode;
                    dbg.requestedNodes = spatialRes.nodeCount;
                    setLoading('正在进行风场动力学推演与评分…');

                    /* 1. 构建全天空当前与日落云场对象 (CloudField) */
                    var cloudFieldNow = SS.cloudField.buildCloudField(spatialRes.skySamples, nowUtc);
                    var cloudFieldSunset = SS.cloudField.buildCloudField(spatialRes.skySamples, solar.sunset);

                    /* 2. 运行风场平流未来云场预测 (30/60/120m) 与上游到达风险 */
                    var motionForecast = SS.cloudMotion.forecast(cloudFieldNow, solar.sunsetAzimuthDeg);

                    /* 3. 运行全天天空状态机 (6态) */
                    var allDaySkyState = SS.skyState.determineState(cloudFieldNow, motionForecast);

                    /* 4. 走廊样本与全天空场送入核心评分引擎 */
                    ectx.cloudField = cloudFieldNow;
                    ectx.totalSkyNodeCount = spatialRes.skySamples ? spatialRes.skySamples.length : 33;
                    var corridorSamples = trimSamples(spatialRes.corridorSamples, nowUtc, solar.sunset);
                    var result = buildResult(ectx, corridorSamples, spatialRes.finalMode,
                      spatialRes.cacheStatus, spatialRes.ageMinutes, false, null);
                    result.data_age = spatialRes.ageMinutes;

                    /* 挂载 V2.1 动力学对象与因子 */
                    result.cloud_field = cloudFieldNow;
                    result.cloud_field_sunset = cloudFieldSunset;
                    result.cloud_motion = motionForecast;
                    result.all_day_sky_state = allDaySkyState;
                    result.sky_evolution_factor = allDaySkyState.factor;

                    /* 降级提示 */
                    if (spatialRes.finalMode === 'LOCAL_ONLY') {
                      result.warnings.push('阴天浓厚，已基于本地天气快速评估');
                    }

                    /* 5. 日落事件层与演化融合 */
                    return applySkyEvolution(result, ectx, dbg)
                      .then(function (finalResult) { return finish(finalResult, fullKey, offset, dbg); });
                  });
              });
            });
          });
        });
      })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.error) console.error('[SunsetScore]', err);
        showError(err && err.message ? err.message : '预测失败，请检查网络后重试');
      })
      .then(function () {
        btn.disabled = false;
      });
  }

  /* ---------- 渲染 ---------- */
  function ringColor(score) {
    if (score >= 75) return '#ff7a45';
    if (score >= 60) return '#ffa940';
    if (score >= 40) return '#d3adf7';
    return '#6b7280';
  }

  function renderResult(r, offset, fromCache) {
    clearStatus();
    show(resultEl);
    renderSkyEvolution(r);
    renderCloudFieldRadar(r);
    renderNowcastBlock(r, offset);

    $('r-city').textContent = r.city + (r.admin1 && r.admin1 !== r.city ? ' · ' + r.admin1 : '');
    var localTimeEl = $('r-local-time');
    if (localTimeEl) {
      localTimeEl.textContent = '当地 ' + (r.local_time_str || '—') + ' (' + (r.timezone_str || 'UTC') + ')';
    }
    $('r-score').textContent = r.score;
    var badge = $('r-level');
    badge.textContent = r.level;
    badge.className = 'level-badge ' + (LEVEL_CLASS[r.level] || 'lv-fair');

    /* V1.8：meta 行展示采样模式与 STALE 回退状态 */
    var metaExtra = '';
    if (r.sampling_mode) metaExtra += ' · ' + r.sampling_mode + ' 采样';
    if (r.cache_status === 'STALE') metaExtra += ' · 过期缓存回退';
    $('r-meta').textContent =
      (r.country ? r.country + ' · ' : '') + r.date + metaExtra + (fromCache ? ' · 缓存结果' : '');

    var ring = $('score-ring');
    var color = ringColor(r.score);
    ring.style.background = 'conic-gradient(' + color + ' ' + (r.score * 3.6) + 'deg, rgba(255,255,255,0.08) 0deg)';
    ring.style.setProperty('--ring-color', color);

    $('r-confidence').textContent = r.confidence + ' / 100';
    if ($('r-golden-hour')) $('r-golden-hour').textContent = r.golden_hour || '—';
    var sunsetText = r.sunset_local;
    if (r.hours_to_sunset != null && r.hours_to_sunset < -0.5) {
      sunsetText += '（今日已过）';
    }
    $('r-sunset').textContent = sunsetText;
    if ($('r-blue-hour')) $('r-blue-hour').textContent = r.blue_hour || '—';
    $('r-azimuth').textContent = r.sunset_azimuth + '°';
    $('r-viewing').textContent = r.best_viewing.start + ' – ' + r.best_viewing.end +
      '（峰值 ' + r.best_viewing.peak + '）';
    var regimeText = r.regime_label;
    if (r.regime_state && r.regime_state.strength != null) {
      regimeText += ' · 强度 ' + Math.round(r.regime_state.strength * 100) + '%';
    }
    $('r-regime').textContent = regimeText;

    /* 评分构成条形图（V1.7：标签下方小字显示动态权重占比） */
    var bars = $('r-bars');
    bars.innerHTML = '';
    var dynW = r.regime_state && r.regime_state.dynamicWeight;
    Object.keys(COMPONENT_LABELS).forEach(function (key) {
      var val = r.components[key];
      var weightText = null;
      if (dynW && dynW[DYNAMIC_WEIGHT_KEY[key]] != null) {
        weightText = Math.round(dynW[DYNAMIC_WEIGHT_KEY[key]] * 100) + '% 权重';
      }
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML =
        '<span class="bar-label"><span class="bar-label-name">' + COMPONENT_LABELS[key] + '</span>' +
        (weightText ? '<span class="bar-label-weight">' + weightText + '</span>' : '') + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + val + '%"></div></div>' +
        '<span class="bar-value">' + val + '</span>';
      bars.appendChild(row);
    });

    var rsnEl = $('r-reasons');
    rsnEl.innerHTML = '';
    r.reasons.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t;
      rsnEl.appendChild(li);
    });
    var warnEl = $('r-warnings');
    warnEl.innerHTML = '';
    r.warnings.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = '⚠ ' + t;
      warnEl.appendChild(li);
    });
    if (!r.warnings.length) hide(warnEl);

    /* 详情 */
    var d = r.data;
    var cs = r.cloud_structure || {};
    var so = r.sector_openings || {};
    var sg = r.spatial_gradient || {};
    var cf = r.clearing_front || {};
    var rs = r.regime_state;   /* V1.7 天气型状态（回退路径为 null） */
    var cm = r.cloud_motion || {};
    var cfSummary = (r.cloud_field && r.cloud_field.summary) || {};
    var st = r.all_day_sky_state || {};
    var ar = cm.arrivalRisk || {};

    var noteHtml =
      '<p class="detail-note">公式：' + (rs
        ? 'Score = (Σ 组件×动态权重) × Q × G<sub>H</sub> + 结构加分 + 过渡加分 − P<sub>weather</sub>'
        : 'Score = P × Q × G<sub>H</sub> + B<sub>regime</sub> − P<sub>weather</sub>') +
      (r.sky_evolution_factor ? ' · 全天演化 ×' + r.sky_evolution_factor : '') +
      (r.sky_evolution && r.sky_evolution.gwFactor ? ' · 黄金窗口 ×' + r.sky_evolution.gwFactor : '') +
      '，所有参数为初始经验值，未来将基于真实观测校准。</p>';

    var groupScore =
      '<div class="detail-group">' +
      '<div class="detail-group-title">📐 评分与模型拆解</div>' +
      '<div class="detail-grid">' +
      '<span>' + (rs ? '组件动态加权合成 P' : '基础物理评分 P') + '</span><span>' + detailP(r) + '</span>' +
      '<span>大气质量修正 Q</span><span>' + (0.70 + 0.30 * r.components.atmosphere / 100).toFixed(2) + '</span>' +
      '<span>地平线门控 G<sub>H</sub></span><span>' + r.horizon_gate.toFixed(2) + '</span>' +
      '<span>总加分（结构+过渡）</span><span>+' + r.bonus + '</span>' +
      '<span>天气风险扣分</span><span>-' + r.penalty + '</span>' +
      '<span>天气型强度</span><span>' + (rs ? Math.round(rs.strength * 100) + '%' : '—') + '</span>' +
      '<span>动态权重分布</span><span>' + fmtDynamicWeights(rs) + '</span>' +
      '<span>Regime Transition</span><span>' + (rs
        ? (TRANSITION_LABEL[rs.transition] || '—') + ' · 评分 ' + rs.transitionScore +
          ' · 加分 ' + (r.transition_bonus >= 0 ? '+' : '') + r.transition_bonus
        : '—') + '</span>' +
      '<span>WeatherScore 组成</span><span>' + fmtWeatherScore(r.weather_score) + '</span>' +
      '</div></div>';

    var groupEvolution =
      '<div class="detail-group">' +
      '<div class="detail-group-title">🌅 天空演化与风场动力学</div>' +
      '<div class="detail-grid">' +
      '<span>全天宏观状态</span><span>' + (st.label ? st.icon + ' ' + st.label + '（演化因子 ×' + (r.sky_evolution_factor || 1.0) + '）' : '—') + '</span>' +
      '<span>全天空平均云量</span><span>' + (cfSummary.avgCloudCover != null ? cfSummary.avgCloudCover + '%（低/中/高: ' + cfSummary.avgCloudLow + '/' + cfSummary.avgCloudMid + '/' + cfSummary.avgCloudHigh + '%）' : '—') + '</span>' +
      '<span>空间云场不均度</span><span>' + (cfSummary.spatialVariance != null ? cfSummary.spatialVariance + '（标准差）' : '—') + '</span>' +
      '<span>风向风速</span><span>' + fmtStandardWind(cm.wind) + '</span>' +
      '<span>分层云移动流速</span><span>' + (cm.layerWinds ? '低云 ' + cm.layerWinds.low.speedKmH + ' km/h · 中云 ' + cm.layerWinds.mid.speedKmH + ' km/h · 高云 ' + cm.layerWinds.high.speedKmH + ' km/h' : '—') + '</span>' +
      '<span>上游浓云侵入预警</span><span>' + (ar.summaryText || '—') + '</span>' +
      '<span>30/60/120m 侵入概率</span><span>' + (ar.risk30m != null ? '30m: ' + Math.round(ar.risk30m * 100) + '% / 60m: ' + Math.round(ar.risk60m * 100) + '% / 120m: ' + Math.round(ar.risk120m * 100) + '%' : '—') + '</span>' +
      '<span>日落走廊演化</span><span>' + fmtEvolutionDetail(r) + '</span>' +
      '<span>Nowcasting 修正</span><span>' + fmtNowcastDetail(r) + '</span>' +
      '</div></div>';

    var groupSpatial =
      '<div class="detail-group">' +
      '<div class="detail-group-title">☁️ 日落走廊云场结构</div>' +
      '<div class="detail-grid">' +
      '<span>云幕结构评分</span><span>' + (cs.bankScore != null ? cs.bankScore : '—') + '</span>' +
      '<span>中心云量 / 对比度</span><span>' + fmt4(cs.centerCloud, cs.contrast) + '</span>' +
      '<span>云幕连续性</span><span>' + (cs.continuity != null ? cs.continuity : '—') + '</span>' +
      '<span>空间梯度（' + (GRADIENT_TYPE_LABEL[sg.type] || '—') + '）</span><span>' + (sg.value != null ? sg.value : '—') + '</span>' +
      '<span>清空锋面（' + (CLEARING_DIR_LABEL[cf.direction] || '—') + '）</span><span>' +
        (cf.rate != null ? '率 ' + cf.rate + ' / 分 ' + cf.score + ' / 信 ' + cf.confidence : '—') + '</span>' +
      '<span>反日落评分（360°反向）</span><span>' + (cs.antiSunsetScore != null ? cs.antiSunsetScore + (cs.antiSunsetCloud != null ? '（反向高云 ' + cs.antiSunsetCloud + '%）' : '') : '—') + '</span>' +
      '<span>分区开阔度（走廊/云幕）</span><span>' + fmt4(so.corridor, so.bank) + '</span>' +
      '</div></div>';

    var groupWeather =
      '<div class="detail-group">' +
      '<div class="detail-group-title">🌡️ 气象观测数据</div>' +
      '<div class="detail-grid">' +
      '<span>总云量 / 低 / 中 / 高</span><span>' + fmt4(d.cloud_cover, d.cloud_low, d.cloud_mid, d.cloud_high) + ' %</span>' +
      '<span>能见度</span><span>' + (d.visibility_km != null ? d.visibility_km + ' km' : '—') + '</span>' +
      '<span>AOD / PM2.5</span><span>' + (d.aod != null ? d.aod : '—') + ' / ' + (d.pm25 != null ? d.pm25 : '—') + '</span>' +
      '<span>相对湿度</span><span>' + (d.humidity != null ? d.humidity + ' %' : '—') + '</span>' +
      '<span>民用昏影时长</span><span>' + d.twilight_minutes + ' 分钟</span>' +
      '</div></div>';

    var groupReliability =
      '<div class="detail-group">' +
      '<div class="detail-group-title">📡 采样与数据可信度</div>' +
      '<div class="detail-grid">' +
      '<span>采样模式（V2.1）</span><span>' + (r.sampling_mode === 'FULL' || r.sampling_mode === 'FULL_SKY' ? 'FULL_SKY（360° 全天空采样）' : (r.sampling_mode || '—')) +
        (r.escalated ? ' → FULL（' + (r.escalation_reason || '') + '）' : '') + '</span>' +
      '<span>全天空动力学网格</span><span>8方位 × 4距离 × 3高度层（96 状态网格）</span>' +
      '<span>空间采样点</span><span>' + d.samples_fetched + ' / ' + d.samples_expected + ' 个节点</span>' +
      '<span>空间完整度 / 全天空方差</span><span>' +
        (r.spatial_completeness != null ? r.spatial_completeness : '—') + ' / ' +
        (r.spatial_variance != null ? r.spatial_variance : '—') + '（360° 标准差）</span>' +
      '<span>距离预报可信度</span><span>' + (r.distance_confidence != null ? r.distance_confidence : '—') + '</span>' +
      '<span>数据新鲜度 / 缓存</span><span>' +
        (r.data_freshness != null ? r.data_freshness + ' min' : '0 min') + ' / ' + (r.cache_status || '—') + '</span>' +
      '</div></div>';

    $('details').innerHTML =
      noteHtml + groupScore + groupEvolution + groupSpatial + groupWeather + groupReliability;

    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function detailP(r) {
    var c = r.components;
    var dw = r.regime_state && r.regime_state.dynamicWeight;
    var p;
    if (dw) {
      /* V1.7 动态权重加权合成 */
      p = dw.skyCanvas * c.sky_canvas + dw.horizon * c.horizon +
        dw.illumination * c.illumination + dw.atmosphere * c.atmosphere +
        dw.weather * c.weather;
    } else {
      /* V1.61 固定权重 */
      p = 0.30 * c.sky_canvas + 0.20 * c.horizon + 0.20 * c.illumination +
        0.20 * c.atmosphere + 0.10 * c.weather;
    }
    return Math.round(p) + ' / 100';
  }
  function fmtDynamicWeights(rs) {
    if (!rs || !rs.dynamicWeight) return '—';
    var w = rs.dynamicWeight;
    return '云 ' + Math.round(w.skyCanvas * 100) + ' / 地平线 ' + Math.round(w.horizon * 100) +
      ' / 受光 ' + Math.round(w.illumination * 100) + ' / 大气 ' + Math.round(w.atmosphere * 100) +
      ' / 天气 ' + Math.round(w.weather * 100) + ' %';
  }
  function fmtWeatherScore(ws) {
    if (!ws) return '—';
    return '当前 ' + ws.current + ' / 趋势 ' + ws.trend + ' / 稳定 ' + ws.stability;
  }
  function fmt4() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(arguments[i] != null ? arguments[i] : '—');
    return parts.join(' / ');
  }

  function fmtEvolutionDetail(r) {
    var evo = r.sky_evolution;
    if (!evo) return '—（未启用或不在临近时段）';
    var parts = ['状态 ' + (EVO_STATE_LABEL[evo.state] || evo.state)];
    if (evo.gwFactor != null) parts.push('概率因子 ×' + evo.gwFactor);
    if (evo.sunsetOpenProbability != null) {
      parts.push('日落开放概率 ' + Math.round(evo.sunsetOpenProbability * 100) + '%');
    }
    if (evo.sources && evo.sources.length) parts.push('源 ' + evo.sources.join('/'));
    return parts.join(' · ');
  }

  function fmtNowcastDetail(r) {
    var nc = r.nowcast;
    if (!nc) return '—（未启用或不在临近时段）';
    var parts = [];
    if (nc.appliedModifier != null) {
      parts.push('修正 ' + (nc.appliedModifier > 0 ? '+' : '') + nc.appliedModifier);
    }
    if (nc.sources && nc.sources.length) parts.push('源 ' + nc.sources.join('/'));
    var d = nc.detail || {};
    if (d.precip && d.precip.source) parts.push('降水源 ' + d.precip.source);
    if (d.precip && d.precip.stopMin != null) parts.push('雨停约 ' + d.precip.stopMin + ' 分钟后');
    if (d.radar && d.radar.risk !== 'NONE') parts.push('雷达风险 ' + (NC_RISK_LABEL[d.radar.risk] || d.radar.risk));
    return parts.join(' · ') || '—';
  }

  /* ---------- 事件绑定 ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    predict(q);
  });

  $('quick-chips').addEventListener('click', function (e) {
    var target = e.target;
    if (target.tagName === 'BUTTON' && target.dataset.city) {
      input.value = target.dataset.city;
      predict(target.dataset.city);
    }
  });

  $('details-toggle').addEventListener('click', function () {
    var d = $('details');
    var open = d.classList.toggle('hidden') === false;
    $('details-toggle').textContent = '为什么是这个分数？ ' + (open ? '▴' : '▾');
  });
})();
