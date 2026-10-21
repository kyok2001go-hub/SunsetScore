/* ============================================================
 * SunsetScore V2.1 - 全天天空状态机与宏观演化因子 (Sky State Engine)
 * 全天 24 小时运行，评估全天空综合开阔度、演化态势与风场驱动影响。
 * 6 大状态：CLEAR, OPENING, STABLE, CLOSING, CLOUD_ARRIVING, UNCERTAIN
 * 输出 SkyEvolutionFactor (0.65 ~ 1.15) 供综合评分乘法融合。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var STATE_META = {
    CLEAR: { label: '晴朗开阔', icon: '☀️', color: '#52c41a', desc: '全天空云量稀少，视界通透，无浓云侵入风险。' },
    OPENING: { label: '云层消散中', icon: '🌤️', color: '#13c2c2', desc: '全天空云量呈快速下降趋势，开阔区域持续扩大。' },
    STABLE: { label: '云层稳定', icon: '⛅', color: '#1890ff', desc: '空间云场分布均匀，短时间内无剧烈变化。' },
    CLOSING: { label: '云层加厚中', icon: '🌥️', color: '#fa8c16', desc: '全天空云量呈上升趋势，晴空范围逐渐收窄。' },
    CLOUD_ARRIVING: { label: '上游云团逼近', icon: '⚠️', color: '#f5222d', desc: '风场正将上游浓厚云团推向本区，存在遮挡风险。' },
    UNCERTAIN: { label: '态势多变', icon: '❓', color: '#8c8c8c', desc: '空间云场不均一度极高或数据波动较大。' }
  };

  /**
   * 综合分析当前云场与未来平流预测，推断全天空状态
   * 支持日落方位角加权（日落走廊 60%、反日落 25%、侧向 15%），杜绝无关方位天气干扰
   * @param {object} cloudField 360° 当前全天空云场
   * @param {object} motionForecast 云场动力学预报对象
   * @param {number} [sunsetAzimuthDeg] 日落方位角（度）
   */
  function determineState(cloudField, motionForecast, sunsetAzimuthDeg, observer) {
    var observed = typeof observer === 'function' ? { observer_version: 1, decisions: {}, sector: null,
      inputs: { current_timestamp: cloudField && cloudField.timestamp != null ? cloudField.timestamp : null,
        future60_timestamp: motionForecast && motionForecast.predictions && motionForecast.predictions.m60 ? motionForecast.predictions.m60.timestamp : null,
        sunset_azimuth: sunsetAzimuthDeg == null ? null : sunsetAzimuthDeg },
      fallbacks: [], nodes: [], formula: null } : null;
    var decisionIds = ['CLOUD_ARRIVING', 'arrival.risk_exists', 'arrival.dense', 'arrival.risk_threshold', 'arrival.time_truthy', 'arrival.time_lte90',
      'CLEAR', 'clear.now', 'clear.future', 'OPENING', 'opening.drop', 'opening.current', 'opening.future',
      'CLOSING', 'closing.growth', 'closing.current', 'closing.future', 'UNCERTAIN', 'STABLE_OVERCAST', 'STABLE_MODERATE', 'stable.min', 'stable.max'];
    if (observed) decisionIds.forEach(function (id) { observed.decisions[id] = 'NOT_EVALUATED'; });
    function check(id, value) { if (observed) observed.decisions[id] = value ? 'TRUE' : 'FALSE'; return value; }
    function formula(branch, expression, raw, floor, terms) {
      if (observed) { observed.branch_id = branch; observed.formula = { expression: expression, raw_factor: raw,
        branch_floor: floor, after_branch_floor: floor == null ? raw : Math.max(floor, raw), terms: terms || {} }; }
    }
    if (!cloudField || !cloudField.summary) {
      if (observed) { observed.branch_id = 'MISSING_SUMMARY'; observed.state = 'UNCERTAIN'; observed.fallbacks.push('MISSING_CURRENT_SUMMARY_RETURN_1');
        observed.formula = { raw_factor: 1, branch_floor: null, after_branch_floor: 1 }; observed.rounding_status = 'NOT_EXECUTED';
        observed.internal_clamp_status = 'NOT_EXECUTED'; observed.returned_factor = 1; observer(observed); }
      return { state: 'UNCERTAIN', factor: 1.0, confidence: 0.5 };
    }

    var cfg = (SS.modelConfig && SS.modelConfig.skyState) || {};
    var wholeAvgNow = cloudField.summary.avgCloudCover;
    var variance = cloudField.summary.spatialVariance;
    var risk = motionForecast ? motionForecast.arrivalRisk : null;
    var pred60 = (motionForecast && motionForecast.predictions && motionForecast.predictions.m60) || null;
    var wholeAvg60 = pred60 && pred60.summary
      ? pred60.summary.avgCloudCover
      : wholeAvgNow;

    var avgNow = wholeAvgNow;
    var avg60 = wholeAvg60;
    if (observed) {
      observed.inputs.whole_avg_now = wholeAvgNow; observed.inputs.whole_avg60 = wholeAvg60; observed.inputs.spatial_variance = variance;
      observed.inputs.arrival_risk = risk ? { hasUpstreamDenseCloud: risk.hasUpstreamDenseCloud, risk60m: risk.risk60m,
        estimatedArrivalMin: risk.estimatedArrivalMin == null ? null : risk.estimatedArrivalMin } : null;
      observed.thresholds = { cloudArrivingRiskThreshold: cfg.cloudArrivingRiskThreshold || 0.35, clearCloudMax: cfg.clearCloudMax || 25,
        openingDropRateMin: cfg.openingDropRateMin || 5, closingGrowthRateMin: cfg.closingGrowthRateMin || 5,
        configured: { cloudArrivingRiskThreshold: cfg.cloudArrivingRiskThreshold, clearCloudMax: cfg.clearCloudMax,
          openingDropRateMin: cfg.openingDropRateMin, closingGrowthRateMin: cfg.closingGrowthRateMin }, legacy_or_defaults_preserved: true };
      if (!pred60 || !pred60.summary) observed.fallbacks.push('MISSING_M60_SUMMARY_USES_CURRENT_WHOLE_MEAN');
    }

    /* 日落方位扇区加权计算（解决问题 4） */
    var sectorInfo = null;
    if (typeof sunsetAzimuthDeg === 'number' && isFinite(sunsetAzimuthDeg) && cloudField.nodes && cloudField.nodes.length) {
      var wCfg = cfg.sectorWeights || { corridor: 0.60, antiSunset: 0.25, side: 0.15 };
      var hwCorridor = cfg.corridorHalfWidthDeg || 45;
      var hwAnti = cfg.antiSunsetHalfWidthDeg || 35;
      var antiAzimuth = (sunsetAzimuthDeg + 180) % 360;

      function angDiff(a1, a2) {
        var d = Math.abs(a1 - a2);
        return Math.min(d, 360 - d);
      }

      var cNodesNow = [], aNodesNow = [], sNodesNow = [];
      var cNodes60 = [], aNodes60 = [], sNodes60 = [];

      var predNodeMap = (pred60 && pred60.nodeMap) || {};
      if (pred60 && pred60.nodes && !pred60.nodeMap) {
        predNodeMap = {};
        pred60.nodes.forEach(function (pn) { predNodeMap[pn.key] = pn; });
      }

      cloudField.nodes.forEach(function (n) {
        var az = n.azimuth != null ? n.azimuth : 0;
        var valNow = (n.data && n.data.cloud_cover != null) ? n.data.cloud_cover : wholeAvgNow;
        var pNode = predNodeMap[n.key];
        var val60 = (pNode && pNode.data && pNode.data.cloud_cover != null) ? pNode.data.cloud_cover : valNow;
        if (observed) observed.nodes.push({ key: n.key, azimuth: az, azimuth_fallback: n.azimuth == null,
          current_total: valNow, future60_total: val60, current_total_fallback: !(n.data && n.data.cloud_cover != null),
          future60_total_fallback: !(pNode && pNode.data && pNode.data.cloud_cover != null),
          current_layers: n.data ? { high: n.data.cloud_cover_high == null ? null : n.data.cloud_cover_high,
            mid: n.data.cloud_cover_mid == null ? null : n.data.cloud_cover_mid, low: n.data.cloud_cover_low == null ? null : n.data.cloud_cover_low } : null,
          future60_layers: pNode && pNode.data ? { high: pNode.data.cloud_cover_high == null ? null : pNode.data.cloud_cover_high,
            mid: pNode.data.cloud_cover_mid == null ? null : pNode.data.cloud_cover_mid, low: pNode.data.cloud_cover_low == null ? null : pNode.data.cloud_cover_low } : null });

        if (angDiff(az, sunsetAzimuthDeg) <= hwCorridor) {
          cNodesNow.push(valNow);
          cNodes60.push(val60);
        } else if (angDiff(az, antiAzimuth) <= hwAnti) {
          aNodesNow.push(valNow);
          aNodes60.push(val60);
        } else {
          sNodesNow.push(valNow);
          sNodes60.push(val60);
        }
      });

      function mean(arr, dflt) {
        if (!arr || !arr.length) return dflt;
        var s = 0;
        for (var i = 0; i < arr.length; i++) s += arr[i];
        return s / arr.length;
      }

      var cAvgNow = mean(cNodesNow, wholeAvgNow);
      var aAvgNow = mean(aNodesNow, wholeAvgNow);
      var sAvgNow = mean(sNodesNow, wholeAvgNow);

      var cAvg60 = mean(cNodes60, cAvgNow);
      var aAvg60 = mean(aNodes60, aAvgNow);
      var sAvg60 = mean(sNodes60, sAvgNow);

      avgNow = Math.round(wCfg.corridor * cAvgNow + wCfg.antiSunset * aAvgNow + wCfg.side * sAvgNow);
      avg60 = Math.round(wCfg.corridor * cAvg60 + wCfg.antiSunset * aAvg60 + wCfg.side * sAvg60);
      if (observed) observed.sector = { weights: wCfg, corridor_half_width: hwCorridor, anti_half_width: hwAnti,
        configured_corridor_half_width: cfg.corridorHalfWidthDeg == null ? null : cfg.corridorHalfWidthDeg,
        configured_anti_half_width: cfg.antiSunsetHalfWidthDeg == null ? null : cfg.antiSunsetHalfWidthDeg,
        counts: { corridor: cNodesNow.length, antiSunset: aNodesNow.length, side: sNodesNow.length },
        current_means: { corridor: cAvgNow, antiSunset: aAvgNow, side: sAvgNow }, future60_means: { corridor: cAvg60, antiSunset: aAvg60, side: sAvg60 },
        unrounded_avg_now: wCfg.corridor * cAvgNow + wCfg.antiSunset * aAvgNow + wCfg.side * sAvgNow,
        unrounded_avg60: wCfg.corridor * cAvg60 + wCfg.antiSunset * aAvg60 + wCfg.side * sAvg60,
        rounded_avg_now: avgNow, rounded_avg60: avg60 };

      sectorInfo = {
        corridorAvgNow: Math.round(cAvgNow),
        antiSunsetAvgNow: Math.round(aAvgNow),
        sideAvgNow: Math.round(sAvgNow),
        corridorAvg60: Math.round(cAvg60)
      };
    }

    var cloudDelta60 = avg60 - avgNow;
    if (observed) {
      if (!observed.sector) observed.fallbacks.push(typeof sunsetAzimuthDeg !== 'number' || !isFinite(sunsetAzimuthDeg) ? 'INVALID_OR_MISSING_AZIMUTH_WHOLE_SKY' : 'MISSING_CURRENT_NODES_WHOLE_SKY');
      observed.inputs.avg_now = avgNow; observed.inputs.avg60 = avg60; observed.inputs.cloud_delta60 = cloudDelta60;
    }
    var state = 'STABLE';
    var factor = 1.0;

    /* 1. 判定上游浓云逼近 (CLOUD_ARRIVING) */
    if (check('CLOUD_ARRIVING', check('arrival.risk_exists', risk) && check('arrival.dense', risk.hasUpstreamDenseCloud) && (check('arrival.risk_threshold', risk.risk60m >= (cfg.cloudArrivingRiskThreshold || 0.35)) || (check('arrival.time_truthy', risk.estimatedArrivalMin) && check('arrival.time_lte90', risk.estimatedArrivalMin <= 90))))) {
      state = 'CLOUD_ARRIVING';
      var configuredArrivalSlope = cfg.factorCoefficients && cfg.factorCoefficients.arrivalRiskSlope;
      var arrivalRiskSlope = typeof configuredArrivalSlope === 'number' && isFinite(configuredArrivalSlope) ? configuredArrivalSlope : 0.30;
      factor = Math.max(0.65, 0.90 - risk.risk60m * arrivalRiskSlope);
      formula('CLOUD_ARRIVING', 'max(0.65,0.90-risk60m*arrivalRiskSlope)', 0.90 - risk.risk60m * arrivalRiskSlope, 0.65, { risk60m: risk.risk60m, coefficient: arrivalRiskSlope });
    }
    /* 2. 判定极佳晴朗 (CLEAR) */
    else if (check('CLEAR', check('clear.now', avgNow <= (cfg.clearCloudMax || 25)) && check('clear.future', avg60 <= (cfg.clearCloudMax || 25)))) {
      state = 'CLEAR';
      factor = 1.10;
      formula('CLEAR', '1.10', factor, null);
    }
    /* 3. 判定消散打开 (OPENING) */
    else if (check('OPENING', check('opening.drop', cloudDelta60 <= -(cfg.openingDropRateMin || 5)) || (check('opening.current', avgNow > 50) && check('opening.future', avg60 < 40)))) {
      state = 'OPENING';
      var dropRatio = Math.min(1.0, Math.abs(cloudDelta60) / 40);
      factor = 1.05 + dropRatio * 0.10;
      formula('OPENING', '1.05+dropRatio*0.10', factor, null, { dropRatio: dropRatio, coefficient: 0.10 });
    }
    /* 4. 判定加厚合拢 (CLOSING) */
    else if (check('CLOSING', check('closing.growth', cloudDelta60 >= (cfg.closingGrowthRateMin || 5)) || (check('closing.current', avgNow < 50) && check('closing.future', avg60 > 65)))) {
      state = 'CLOSING';
      var growthRatio = Math.min(1.0, cloudDelta60 / 40);
      factor = Math.max(0.70, 0.95 - growthRatio * 0.25);
      formula('CLOSING', 'max(0.70,0.95-growthRatio*0.25)', 0.95 - growthRatio * 0.25, 0.70, { growthRatio: growthRatio, coefficient: 0.25 });
    }
    /* 5. 判定多变不确定 (UNCERTAIN) */
    else if (check('UNCERTAIN', variance >= 35)) {
      state = 'UNCERTAIN';
      factor = 0.95;
      formula('UNCERTAIN', '0.95', factor, null);
    }
    /* 6. 稳定态 (STABLE) */
    else {
      state = 'STABLE';
      if (check('STABLE_OVERCAST', avgNow > 75)) { factor = 0.85; formula('STABLE_OVERCAST', '0.85', factor, null); }
      else if (check('STABLE_MODERATE', check('stable.min', avgNow >= 30) && check('stable.max', avgNow <= 60))) { factor = 1.02; formula('STABLE_MODERATE', '1.02', factor, null); } /* 适度云层最利于晚霞/景致 */
      else { factor = 0.98; formula('STABLE_OTHER', '0.98', factor, null); }
    }

    var range = cfg.factorRange || [0.65, 1.15];
    if (observed) { observed.rounding_status = 'EXECUTED'; observed.before_rounding = factor; observed.rounded_factor = Number(factor.toFixed(3));
      observed.internal_range = range; observed.internal_clamp_status = 'EXECUTED'; }
    factor = Math.max(range[0], Math.min(range[1], Number(factor.toFixed(3))));
    if (observed) { observed.state = state; observed.returned_factor = factor; observer(observed); }

    var meta = STATE_META[state] || STATE_META.UNCERTAIN;

    return {
      state: state,
      label: meta.label,
      icon: meta.icon,
      color: meta.color,
      description: meta.desc,
      factor: factor,
      metrics: {
        currentCloudCover: avgNow,
        predictedCloudCover60: avg60,
        cloudDelta60: cloudDelta60,
        wholeSkyCurrentCloudCover: wholeAvgNow,
        wholeSkyPredictedCloudCover60: wholeAvg60,
        spatialVariance: variance,
        arrivalRisk60: risk ? risk.risk60m : 0,
        sectorDetails: sectorInfo
      }
    };
  }

  SS.skyState = {
    STATE_META: STATE_META,
    determineState: determineState
  };
})(typeof window !== 'undefined' ? window : globalThis);
