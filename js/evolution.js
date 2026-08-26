/* ============================================================
 * SunsetScore V2.0 - 天空演化概率引擎（技术方案 6-10 章）
 * 从确定性"何时清空"升级为概率性"未来 30/60/90/120 分钟走廊开放概率"：
 *   1. 指数衰减模型：FutureCoverage(t) = C0·e^(−kt)（k 由覆盖率序列趋势拟合），
 *      趋势上行时按线性增长外推；不确定度 σ(t)=σ0+γ·t 随时间线性增大，
 *      P_open(t) = logistic((阈值 − FC(t)) / σ(t))，概率截断 [0.02, 0.98]——无伪精确
 *   2. QWeather 雨停置信度曲线：CorridorOpenProbability = P_radar × RainStopConfidence
 *   3. 卫星云覆盖演化（无降雨场景）：futureCoverage / cloudArrivalRisk
 *   4. 五态 Sky Evolution State 状态机 + 置信度
 *   5. Golden Window V3：Score × (floor + (1−floor) × P_open(日落时刻))
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function valid(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function avg(arr) {
    if (!arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }
  function logistic(x) { return 1 / (1 + Math.exp(-x)); }

  function safeProbability(value, fallback) {
    return SS.domain ? SS.domain.safeProbability(value, fallback) : clamp(valid(value) ? value : fallback, 0, 1);
  }

  function fallbackGoldenWindow() {
    return { sunsetOpenProbability: 0.5, gwFactor: 1.0, degraded: true };
  }

  var HORIZONS = [30, 60, 90, 120];

  /* ---------- 概率模型（方案 6.3 节） ---------- */

  /* 从覆盖率序列拟合趋势（%/min，负 = 正在减少/清空）。
     用相邻帧差值的均值，最后一对权重加倍以贴近当前变化 */
  function fitTrend(series) {
    if (!series || series.length < 2) return null;
    var deltas = [], wsum = 0, wTotal = 0;
    for (var i = 1; i < series.length; i++) {
      var dt = (series[i].t - series[i - 1].t) / 60000;
      if (!(dt > 0)) continue;
      var w = (i === series.length - 1) ? 2 : 1;
      deltas.push({ v: (series[i].pct - series[i - 1].pct) / dt, w: w });
      wTotal += w;
    }
    if (!deltas.length) return null;
    deltas.forEach(function (d) { wsum += d.v * d.w; });
    return wsum / wTotal;
  }

  /* 未来覆盖率（%）：
     趋势下行（清空）→ 指数衰减 C0·e^(−kt)，k 与初始斜率匹配（上限 [TUNE] 0.3）；
     趋势上行（恶化）→ 线性增长并封顶 100 */
  function futureCoverageAt(c0, trend, tMin) {
    if (trend >= 0) return clamp(c0 + trend * tMin, 0, 100);
    var k = Math.min(0.3, -trend / Math.max(c0, 5));
    return c0 * Math.exp(-k * tMin);
  }

  /* 开放概率：覆盖率低于 openThreshold 视为开放，σ(t) 随时间增大 */
  function openProbabilityAt(c0, trend, tMin, threshold) {
    var cfg = SS.modelConfig.evolution;
    var fc = futureCoverageAt(c0, trend, tMin);
    var sigma = cfg.sigma0 + cfg.sigmaPerMin * tMin;
    var p = logistic((threshold - fc) / sigma);
    return clamp(p, cfg.probClamp[0], cfg.probClamp[1]);
  }

  /* 由覆盖率序列生成四时距开放概率曲线（方案 6.3 节输出） */
  function radarOpenProbability(series, threshold) {
    var trend = fitTrend(series);
    var c0 = series[series.length - 1].pct;
    if (trend == null) return null;
    var out = {};
    HORIZONS.forEach(function (h) {
      out[h + 'm'] = Math.round(openProbabilityAt(c0, trend, h, threshold) * 100) / 100;
    });
    return { coverageNow: Math.round(c0), trend: Math.round(trend * 100) / 100, openProbability: out };
  }

  /* QWeather 雨停置信度曲线（方案 7 章）：有雨时随"距雨停时刻"变化，
     无雨时 = 1（不存在雨停问题）；无降水信息时中性 0.5 */
  function rainStopConfidence(precip, tMin) {
    var rc = SS.modelConfig.evolution.rainStopConfidence;
    if (!precip || !precip.available) return rc.noInfo;
    if (!precip.rainingNow) return 1;
    if (precip.stopMin == null) return precip.intensifying ? rc.intensifying : rc.persisting;
    var margin = precip.stopMin - tMin; /* 正 = 到 t 时刻雨仍未停 */
    return clamp(1 - logistic(margin / rc.marginWidthMin), 0.05, 0.98);
  }

  /* 走廊开放概率融合（方案 7 章）：
     CorridorOpenProbability(t) = P_radar(t) × RainStopConfidence(t)。
     雷达缺失时以卫星覆盖率演化替代（无降雨场景），再缺失则仅雨停置信度 */
  function corridorOpenProbability(radarEvo, satelliteEvo, precip, motionForecast) {
    var cfg = SS.modelConfig.evolution;
    var out = {};
    HORIZONS.forEach(function (h) {
      var p = null;
      if (radarEvo) {
        p = radarEvo.openProbability[h + 'm'];
      } else if (satelliteEvo && satelliteEvo.openProbability) {
        p = satelliteEvo.openProbability[h + 'm'];
      } else if (motionForecast && motionForecast.predictions && (motionForecast.predictions['m' + h] || motionForecast.predictions['m60'])) {
        var pred = motionForecast.predictions['m' + h] || motionForecast.predictions['m60'];
        var cPred = pred && pred.summary ? pred.summary.avgCloudCover : null;
        /* 注意：SkyEvolutionFactor 已经在天空状态机中处理了 CLOUD_ARRIVING 宏观风险。
           在无雷达/卫星覆盖的回退中，走廊开放概率直接由 NWP 未来云量决定，避免重复惩罚 */
        if (valid(cPred)) {
          p = logistic((cfg.openCoverageThreshold - cPred) / (cfg.sigma0 + cfg.sigmaPerMin * h));
        }
      }
      if (p == null) p = 0.5;
      p = safeProbability(p, 0.5) * safeProbability(rainStopConfidence(precip, h), 0.5);
      if (radarEvo == null && satelliteEvo == null && motionForecast == null) p = rainStopConfidence(precip, h);
      out[h + 'm'] = Math.round(clamp(safeProbability(p, 0.5), cfg.probClamp[0], cfg.probClamp[1]) * 100) / 100;
    });
    return out;
  }

  /* ---------- 卫星云覆盖演化（方案 8 章） ---------- */

  function satelliteEvolution(series) {
    var cfg = SS.modelConfig.evolution;
    var trend = fitTrend(series);
    if (trend == null) return null;
    var c0 = series[series.length - 1].pct;

    var future = {};
    [30, 60, 90].forEach(function (h) {
      future[h + 'm'] = Math.round(futureCoverageAt(c0, trend, h));
    });

    /* 云层到达风险：未来 t 时刻覆盖率超过遮挡阈值的概率（方案 8.3） */
    var risk = {};
    [30, 60].forEach(function (h) {
      var fc = futureCoverageAt(c0, trend, h);
      var sigma = cfg.sigma0 + cfg.sigmaPerMin * h;
      risk[h + 'm'] = Math.round(clamp(
        logistic((fc - cfg.cloudCoverRiskThreshold) / sigma),
        cfg.probClamp[0], cfg.probClamp[1]) * 100) / 100;
    });

    /* 卫星开放概率（覆盖率低于 satelliteOpenThreshold 视为开放） */
    var open = {};
    HORIZONS.forEach(function (h) {
      open[h + 'm'] = Math.round(openProbabilityAt(c0, trend, h, cfg.satelliteOpenThreshold) * 100) / 100;
    });

    return {
      coverageNow: Math.round(c0),
      trend: Math.round(trend * 100) / 100,
      futureCoverage: future,
      cloudArrivalRisk: risk,
      openProbability: open
    };
  }

  /* ---------- 状态机（方案 9 章） ---------- */

  function stateMachine(evo) {
    var sm = SS.modelConfig.evolution.stateMachine;
    var cov = evo.coverageNow;
    var p60 = evo.openProbability['60m'];
    var trend = evo.trend;
    if (cov == null || p60 == null || trend == null) {
      return { state: 'UNCERTAIN', confidence: Math.round(evo.confidence * 100) / 100 };
    }
    var state;
    if (cov <= sm.openCoverageMax && p60 >= sm.openProb60Min) state = 'OPEN';
    else if (cov >= sm.blockedCoverageMin && p60 <= sm.blockedProb60Max) state = 'BLOCKED';
    else if (trend < -sm.trendEpsilon) state = 'OPENING';
    else if (trend > sm.trendEpsilon) state = 'CLOSING';
    else state = 'UNCERTAIN';
    return { state: state, confidence: Math.round(evo.confidence * 100) / 100 };
  }

  /* ---------- 融合引擎（方案 9、10 章） ---------- */

  /**
   * @param sources {forecastTrend(-100~100), precip, radar, satellite, nowMs, sunsetMs}
   * @returns {skyEvolutionState} 或 null（无任何演化源时）
   */
  function fuseEvolution(sources) {
    var cfg = SS.modelConfig.evolution;
    var radar = sources.radar, satellite = sources.satellite, precip = sources.precip;

    var radarEvo = radar && radar.available && radar.coverageSeries
      ? radarOpenProbability(radar.coverageSeries, cfg.openCoverageThreshold) : null;
    var satEvo = satellite && satellite.available && satellite.coverageSeries
      ? satelliteEvolution(satellite.coverageSeries) : null;

    /* 卫星演化仅在无降雨场景参与（避免降水回波与云覆盖双重计） */
    if (satEvo && precip && precip.available && precip.rainingNow) satEvo = null;

    if (!radarEvo && !satEvo && !(precip && precip.available) && !sources.motionForecast) return null;

    var openProb = corridorOpenProbability(radarEvo, satEvo, precip, sources.motionForecast);

    /* 小时背景概率（方案 12 章 background 权重）：由小时云量趋势给出弱先验 */
    var bgP = valid(sources.forecastTrend)
      ? clamp(0.5 + sources.forecastTrend / 100 * 0.5, 0.05, 0.95)
      : 0.5;
    var wBg = cfg.fusionWeights.background;
    var fused = {};
    HORIZONS.forEach(function (h) {
      var p = safeProbability(openProb[h + 'm'], 0.5);
      fused[h + 'm'] = Math.round((wBg * bgP + (1 - wBg) * p) * 100) / 100;
    });

    /* 观测修正权重（方案 12 章 observation）：当前覆盖率与开放阈值的即时距离 */
    var fallbackField = sources.motionForecast && sources.motionForecast.predictions
      ? sources.motionForecast.predictions.m30 : null;
    var coverageNow = radarEvo ? radarEvo.coverageNow
      : (satEvo ? satEvo.coverageNow
        : (fallbackField && fallbackField.summary ? fallbackField.summary.avgCloudCover : null));
    var trend = radarEvo ? radarEvo.trend : (satEvo ? satEvo.trend : null);

    /* 置信度：源可用性加权 × (1 − 归一化 σ(60)) */
    var srcFactor = (radarEvo ? 0.5 : 0) + (precip && precip.available ? 0.3 : 0) +
      (satEvo ? 0.2 : 0) + (sources.motionForecast ? 0.25 : 0);
    var sigma60 = cfg.sigma0 + cfg.sigmaPerMin * 60;
    var sigmaNorm = clamp(sigma60 / cfg.stateMachine.maxSigma60, 0, 1);
    var confidence = clamp(srcFactor * (1 - sigmaNorm), 0.1, 0.98);

    var evo = {
      coverageNow: coverageNow,
      trend: trend,
      openProbability: fused,
      confidence: Math.round(confidence * 100) / 100,
      sources: []
    };
    if (radarEvo) evo.sources.push('radar');
    if (satEvo) evo.sources.push('satellite');
    if (precip && precip.available) evo.sources.push('precip');
    if (sources.motionForecast) evo.sources.push('cloud_motion');
    if (valid(sources.forecastTrend)) evo.sources.push('forecast');
    evo.sources.push('background');

    var st = stateMachine(evo);
    evo.state = st.state;
    evo.confidence = st.confidence;

    /* Golden Window V3/V4：日落时刻的走廊开放概率与乘法因子 */
    if (valid(sources.sunsetMs)) {
      var tSunset = clamp((sources.sunsetMs - (sources.nowMs || Date.now())) / 60000, 0, 120);
      /* 四时距概率在日落时距处的插值（就近取档） */
      var pSunset;
      if (tSunset <= 30) pSunset = fused['30m'];
      else if (tSunset <= 60) pSunset = fused['60m'];
      else if (tSunset <= 90) pSunset = fused['90m'];
      else pSunset = fused['120m'];
      pSunset = safeProbability(pSunset, 0.5);
      evo.sunsetOpenProbability = pSunset;
      evo.sunsetMinutesAway = Math.round(tSunset);
      var floor = cfg.gwFactor.floor;
      var gwFactor = floor + (1 - floor) * pSunset;
      evo.gwFactor = Math.round(clamp(valid(gwFactor) ? gwFactor : 1.0, floor, 1.0) * 1000) / 1000;
    }

    var degradedSources = [];
    if (!radarEvo) degradedSources.push('雷达瓦片');
    if (!satEvo) degradedSources.push('卫星云图');
    evo.degradedSources = degradedSources;
    evo.hasRealTiles = !!(radarEvo || satEvo);
    evo.sourcesStatus = sources.sourcesStatus || null;

    /* 详情透传：卫星未来覆盖率与到达风险、雷达演化原始输出、风场平流外推 */
    evo.detail = {
      radar: radarEvo,
      satellite: satEvo,
      motion: sources.motionForecast,
      sourcesStatus: sources.sourcesStatus || null,
      precip: precip ? {
        source: precip.source,
        rainingNow: precip.rainingNow,
        stopMin: precip.stopMin,
        summary: precip.summary
      } : null
    };
    return evo;
  }

  function isGoldenWindowActive(ctx) {
    var minutesToSunset = ctx && ctx.time ? ctx.time.minutesToSunset : null;
    if (!valid(minutesToSunset)) return false;
    var activation = (SS.modelConfig.goldenWindow.model && SS.modelConfig.goldenWindow.model.activationWindowMin) || 180;
    return minutesToSunset >= -30 && minutesToSunset <= activation;
  }

  function evaluate(context) {
    var sources = context && context.evolutionSources ? context.evolutionSources : context;
    var result = fuseEvolution(sources || {});
    if (!result) return null;
    if (!valid(result.gwFactor)) {
      var fallback = fallbackGoldenWindow();
      result.sunsetOpenProbability = fallback.sunsetOpenProbability;
      result.gwFactor = fallback.gwFactor;
      result.degraded = true;
    }
    return result;
  }

  SS.evolution = {
    HORIZONS: HORIZONS,
    fitTrend: fitTrend,
    futureCoverageAt: futureCoverageAt,
    openProbabilityAt: openProbabilityAt,
    radarOpenProbability: radarOpenProbability,
    rainStopConfidence: rainStopConfidence,
    satelliteEvolution: satelliteEvolution,
    calculateOpenProbability: corridorOpenProbability,
    calculateRainStopConfidence: rainStopConfidence,
    calculateEvolutionProbability: fuseEvolution,
    calculateGoldenWindowFactor: function (probability) {
      var floor = SS.modelConfig.evolution.gwFactor.floor;
      return clamp(floor + (1 - floor) * safeProbability(probability, 0.5), floor, 1.0);
    },
    fallbackGoldenWindow: fallbackGoldenWindow,
    isGoldenWindowActive: isGoldenWindowActive,
    evaluate: evaluate,
    fuseEvolution: fuseEvolution
  };
})(typeof window !== 'undefined' ? window : globalThis);
