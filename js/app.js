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
      sunset: s.sunset.toISOString(), civilDusk: s.civilDusk.toISOString(),
      sunsetAzimuthDeg: s.sunsetAzimuthDeg, twilightMinutes: s.twilightMinutes
    };
  }
  function restoreSolar(v) {
    return {
      sunset: new Date(v.sunset), civilDusk: new Date(v.civilDusk),
      sunsetAzimuthDeg: v.sunsetAzimuthDeg, twilightMinutes: v.twilightMinutes
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
    result.date = fmtDate(ectx.localNow);
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

  /* ---------- V2.0 天空演化概率（技术方案 9-10 章） ---------- */
  var EVO_STATE_LABEL = { OPENING: '正在打开', OPEN: '开放', CLOSING: '正在闭合', BLOCKED: '持续遮挡', UNCERTAIN: '不确定' };
  var EVO_STATE_CLASS = {
    OPENING: 'evo-opening', OPEN: 'evo-open', CLOSING: 'evo-closing',
    BLOCKED: 'evo-blocked', UNCERTAIN: 'evo-uncertain'
  };

  /* V2.0 概率模型优先；A/B 开关关闭时回退 V1.9 modifier 路径 */
  function applySkyEvolution(result, ectx, dbg) {
    if (cfg.evolutionV20.enabled) return applyEvolution(result, ectx, dbg);
    return applyNowcast(result, ectx, dbg);
  }

  function applyEvolutionResult(result, evo) {
    result.sky_evolution = evo;
    /* Golden Window V3（方案 10 章）：Score × (floor + (1−floor) × P_open(日落时刻)) */
    if (evo.gwFactor != null) {
      result.score = Math.max(0, Math.min(100, Math.round(result.score * evo.gwFactor)));
      result.level = levelOf(result.score);
    }
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
    if (!ectx.ncActive || !result) return Promise.resolve(result);
    var ctx = {
      lat: ectx.location.latitude, lon: ectx.location.longitude,
      dateStr: ectx.dateStr, nowUtc: ectx.nowUtc,
      sunsetAzimuthDeg: ectx.solar.sunsetAzimuthDeg,
      utcOffsetSeconds: ectx.offset,
      forecastTrend: computeForecastTrend(ectx.localForecast, ectx.offset, ectx.nowUtc, ectx.solar)
    };
    /* 演化结果缓存（方案 13 章 Evolution Cache，10 分钟）；
       与 V1.9 融合结果一并缓存，保证黄金窗口块在缓存命中时同样可渲染 */
    var evoKey = SS.cacheKeys.evolution(ectx.dateStr, ectx.location.latitude, ectx.location.longitude);
    var cachedEvo = SS.cache.get(evoKey);
    if (cachedEvo) {
      result.nowcast = cachedEvo.nowcast || null;
      return Promise.resolve(applyEvolutionResult(result, cachedEvo.evo));
    }
    return SS.nowcast.run(ctx).then(function (fusion) {
      if (!fusion || !fusion.detail) return result; /* 无演化源：保持 V1.7 基础分 */
      var evo = SS.evolution.fuseEvolution({
        forecastTrend: ctx.forecastTrend,
        precip: fusion.detail.precip,
        radar: fusion.detail.radar,
        satellite: fusion.detail.satellite,
        nowMs: ectx.nowUtc.valueOf(),
        sunsetMs: ectx.solar.sunset.valueOf()
      });
      if (!evo) return result;
      SS.cache.set(evoKey, { evo: evo, nowcast: fusion }, cfg.evolutionV20.evolutionTtlMinutes);
      /* 黄金窗口块沿用 V1.9 融合结果展示（雨停时间/趋势等） */
      result.nowcast = fusion;
      return applyEvolutionResult(result, evo);
    }).catch(function () { return result; });
  }

  /* 天空演化区块渲染（方案 15 章） */
  function renderSkyEvolution(r) {
    var block = $('sky-evolution-block');
    if (!block) return;
    var evo = r.sky_evolution;
    if (!evo) { hide(block); return; }
    show(block);
    var badge = $('evo-state');
    badge.textContent = EVO_STATE_LABEL[evo.state] || evo.state;
    badge.className = 'evolution-state-badge ' + (EVO_STATE_CLASS[evo.state] || 'evo-uncertain');
    $('evo-confidence').textContent = '置信度 ' + Math.round(evo.confidence * 100) + '%';

    var bars = $('evo-probs');
    bars.innerHTML = '';
    SS.evolution.HORIZONS.forEach(function (h) {
      var p = evo.openProbability[h + 'm'];
      if (p == null) return;
      var row = document.createElement('div');
      row.className = 'evo-prob-row';
      row.innerHTML =
        '<span class="evo-prob-label">' + h + ' 分钟</span>' +
        '<div class="evo-prob-track"><div class="evo-prob-fill" style="width:' + Math.round(p * 100) + '%"></div></div>' +
        '<span class="evo-prob-value">' + Math.round(p * 100) + '%</span>';
      bars.appendChild(row);
    });

    /* 未来云覆盖率（卫星，无降雨场景才有） */
    var cov = $('evo-coverage');
    cov.innerHTML = '';
    var sat = evo.detail && evo.detail.satellite;
    if (sat && sat.futureCoverage) {
      var seg = ['30m', '60m', '90m'].map(function (k) {
        return k + ' ' + sat.futureCoverage[k] + '%';
      });
      var row2 = document.createElement('div');
      row2.className = 'evo-coverage-row';
      row2.textContent = '未来云覆盖（卫星）：' + seg.join(' → ');
      cov.appendChild(row2);
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
    if (!nc) { hide(block); return; }
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
        var dateStr = fmtDate(nowUtc); /* UTC 日期：跨日缓存自然隔离 */
        setLoading('正在获取本地天气…');

        return fetchWithCache(
          SS.cacheKeys.forecast(dateStr, location.latitude, location.longitude),
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
          var localNow = SS.data.toLocalShifted(nowUtc, offset);

          /* 结果级缓存：同城重复查询的快速路径 */
          var fullKey = resultCacheKey + '_' + fmtDate(localNow);
          var cached = SS.cache.get(fullKey);
          if (cached) {
            renderResult(cached, offset, true);
            dbg.samplingMode = cached.sampling_mode || 'CACHE';
            renderDebugPanel(dbg, cached);
            return null;
          }

          /* 太阳几何（24h 缓存，纯本地计算不消耗 API） */
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
              /* AQ 失败容忍（也不缓存 null）：视为无数据，不影响主流程 */
              return { value: null, cacheStatus: 'MISS', ageMinutes: 0 };
            }).then(function (airRes) {

              /* V1.9：分钟级降水预取（距日落 ≤4h 才拉取），
                 供引擎黄金窗口精确判定与后续 Nowcasting 融合 */
              var hoursToSunset = (solar.sunset.valueOf() - nowUtc.valueOf()) / 3600000;
              var ncCfg = cfg.nowcastV19;
              var ncActive = ncCfg.enabled && hoursToSunset >= -0.5 &&
                hoursToSunset <= ncCfg.proximityGate.fetchLimitHours;
              var precipPromise = ncActive
                ? fetchMinutePrecipCached(location, dateStr, nowUtc, dbg)
                : Promise.resolve(null);

              return precipPromise.then(function (minutePrecip) {
                /* Sampling Controller：本地 Regime 预判 → 采样模式（方案 8 章） */
                var reg = SS.sampling.estimateLocalRegime({
                  localForecast: localForecast, utcOffsetSeconds: offset,
                  nowUtc: nowUtc, sunsetLocal: sunsetLocal
                });
                var mode = cfg18.enabled ? SS.sampling.decideSamplingMode(reg) : 'FULL';
                var plannedCount = SS.sampling.selectNodes(
                  mode, location.latitude, location.longitude, solar.sunsetAzimuthDeg).length;
                setLoading(mode === 'LOCAL_ONLY'
                  ? '阴天浓厚，仅基于本地天气评估…'
                  : '正在采样日落方向的空间云场（' + plannedCount + ' 个观测点 · 批量请求）…');

                var ectx = {
                  location: location, offset: offset, nowUtc: nowUtc, localNow: localNow,
                  solar: solar, sunsetLocal: sunsetLocal, air: airRes.value, dateStr: dateStr,
                  localForecast: localForecast, minutePrecip: minutePrecip,
                  ncActive: ncActive, hoursToSunset: hoursToSunset
                };

                return gatherWithFallback(mode, location, solar, localForecast, dateStr, ttl, dbg)
                  .then(function (spatialRes) {
                    dbg.samplingMode = spatialRes.finalMode;
                    dbg.requestedNodes = spatialRes.nodeCount;
                    setLoading('正在计算晚霞指数…');

                    var samples = trimSamples(spatialRes.samples, nowUtc, solar.sunset);
                    var result = buildResult(ectx, samples, spatialRes.finalMode,
                      spatialRes.cacheStatus, spatialRes.ageMinutes, false, null);
                    result.data_age = spatialRes.ageMinutes;
                    /* 降级提示：因 API 失败退到更少采样点时明示用户 */
                    if (spatialRes.finalMode !== mode ||
                        (spatialRes.finalMode === 'LOCAL_ONLY' && mode !== 'LOCAL_ONLY')) {
                      result.warnings.push('空间采样数据不完整，已基于可用数据评估，置信度有所降低');
                    }

                    /* Confidence Check：必要时 7 → 13 重算（方案 9 章，最多升级 1 次） */
                    var esc = (cfg18.enabled && spatialRes.finalMode === 'STANDARD')
                      ? SS.sampling.shouldEscalate(result)
                      : { escalate: false, reason: null };
                    var basePromise = esc.escalate
                      ? escalateToFull(ectx, samples, result, esc, ttl, dbg)
                          .then(function (fullResult) { return fullResult || result; })
                      : Promise.resolve(result);

                    /* V1.9/V2.0：Nowcasting/天空演化概率 → 完成（A/B 开关自动选择） */
                    return basePromise
                      .then(function (finalResult) { return applySkyEvolution(finalResult, ectx, dbg); })
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
    renderNowcastBlock(r, offset);
    renderSkyEvolution(r);

    $('r-city').textContent = r.city + (r.admin1 && r.admin1 !== r.city ? ' · ' + r.admin1 : '');
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
    $('r-sunset').textContent = r.sunset_local;
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
        (weightText ? '<span class="bar-label-weight">' + weightText + '</span>' : '') +
        '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + val + '%"></div></div>' +
        '<span class="bar-value">' + val + '</span>';
      bars.appendChild(row);
    });

    /* 原因 / 提示 */
    var reasonsEl = $('r-reasons');
    reasonsEl.innerHTML = '';
    r.reasons.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = '✓ ' + t;
      reasonsEl.appendChild(li);
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
    $('details').innerHTML =
      '<div class="detail-grid">' +
      '<span>' + (rs ? '组件动态加权合成 P' : '基础物理评分 P') + '</span><span>' + detailP(r) + '</span>' +
      '<span>大气质量修正 Q</span><span>' + (0.70 + 0.30 * r.components.atmosphere / 100).toFixed(2) + '</span>' +
      '<span>地平线门控 G<sub>H</sub></span><span>' + r.horizon_gate.toFixed(2) + '</span>' +
      '<span>总加分（结构+过渡）</span><span>+' + r.bonus + '</span>' +
      '<span>天气型强度</span><span>' + (rs ? Math.round(rs.strength * 100) + '%' : '—') + '</span>' +
      '<span>Regime Transition</span><span>' + (rs
        ? (TRANSITION_LABEL[rs.transition] || '—') + ' · 评分 ' + rs.transitionScore +
          ' · 加分 ' + (r.transition_bonus >= 0 ? '+' : '') + r.transition_bonus
        : '—') + '</span>' +
      '<span>动态权重分布</span><span>' + fmtDynamicWeights(rs) + '</span>' +
      '<span>WeatherScore 组成</span><span>' + fmtWeatherScore(r.weather_score) + '</span>' +
      '<span>天气风险扣分</span><span>-' + r.penalty + '</span>' +
      '<span>云幕结构评分</span><span>' + (cs.bankScore != null ? cs.bankScore : '—') + '</span>' +
      '<span>中心云量 / 对比度</span><span>' + fmt4(cs.centerCloud, cs.contrast) + '</span>' +
      '<span>云幕连续性</span><span>' + (cs.continuity != null ? cs.continuity : '—') + '</span>' +
      '<span>空间梯度（' + (GRADIENT_TYPE_LABEL[sg.type] || '—') + '）</span><span>' + (sg.value != null ? sg.value : '—') + '</span>' +
      '<span>清空锋面（' + (CLEARING_DIR_LABEL[cf.direction] || '—') + '）</span><span>' +
        (cf.rate != null ? '率 ' + cf.rate + ' / 分 ' + cf.score + ' / 信 ' + cf.confidence : '—') + '</span>' +
      '<span>反日落评分</span><span>' + (cs.antiSunsetScore != null ? cs.antiSunsetScore : '—') + '</span>' +
      '<span>分区开阔度（走廊/云幕）</span><span>' + fmt4(so.corridor, so.bank) + '</span>' +
      '<span>距离预报可信度</span><span>' + (r.distance_confidence != null ? r.distance_confidence : '—') + '</span>' +
      '<span>总云量 / 低 / 中 / 高</span><span>' + fmt4(d.cloud_cover, d.cloud_low, d.cloud_mid, d.cloud_high) + ' %</span>' +
      '<span>能见度</span><span>' + (d.visibility_km != null ? d.visibility_km + ' km' : '—') + '</span>' +
      '<span>AOD / PM2.5</span><span>' + (d.aod != null ? d.aod : '—') + ' / ' + (d.pm25 != null ? d.pm25 : '—') + '</span>' +
      '<span>相对湿度</span><span>' + (d.humidity != null ? d.humidity + ' %' : '—') + '</span>' +
      '<span>民用昏影时长</span><span>' + d.twilight_minutes + ' 分钟</span>' +
      '<span>空间采样点</span><span>' + d.samples_fetched + ' / ' + d.samples_expected + '</span>' +
      '<span>采样模式（V1.8）</span><span>' + (r.sampling_mode || '—') +
        (r.escalated ? ' → FULL（' + (r.escalation_reason || '') + '）' : '') + '</span>' +
      '<span>空间完整度 / 方差</span><span>' +
        (r.spatial_completeness != null ? r.spatial_completeness : '—') + ' / ' +
        (r.spatial_variance != null ? r.spatial_variance : '—') + '</span>' +
      '<span>数据新鲜度 / 缓存</span><span>' +
        (r.data_freshness != null ? r.data_freshness : '—') + ' / ' + (r.cache_status || '—') + '</span>' +
      '<span>Nowcasting 修正（V1.9）</span><span>' + fmtNowcastDetail(r) + '</span>' +
      '<span>天空演化（V2.0）</span><span>' + fmtEvolutionDetail(r) + '</span>' +
      '</div>' +
      '<p class="detail-note">公式：' + (rs
        ? 'Score = (Σ 组件×动态权重) × Q × G<sub>H</sub> + 结构加分 + 过渡加分 − P<sub>weather</sub>'
        : 'Score = P × Q × G<sub>H</sub> + B<sub>regime</sub> − P<sub>weather</sub>') +
      '，所有参数为初始经验值，未来将基于真实观测校准。</p>';

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
