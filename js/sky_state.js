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
  function determineState(cloudField, motionForecast, sunsetAzimuthDeg) {
    if (!cloudField || !cloudField.summary) {
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

      sectorInfo = {
        corridorAvgNow: Math.round(cAvgNow),
        antiSunsetAvgNow: Math.round(aAvgNow),
        sideAvgNow: Math.round(sAvgNow),
        corridorAvg60: Math.round(cAvg60)
      };
    }

    var cloudDelta60 = avg60 - avgNow;
    var state = 'STABLE';
    var factor = 1.0;

    /* 1. 判定上游浓云逼近 (CLOUD_ARRIVING) */
    if (risk && risk.hasUpstreamDenseCloud && (risk.risk60m >= (cfg.cloudArrivingRiskThreshold || 0.35) || (risk.estimatedArrivalMin && risk.estimatedArrivalMin <= 90))) {
      state = 'CLOUD_ARRIVING';
      factor = Math.max(0.65, 0.90 - risk.risk60m * 0.30);
    }
    /* 2. 判定极佳晴朗 (CLEAR) */
    else if (avgNow <= (cfg.clearCloudMax || 25) && avg60 <= (cfg.clearCloudMax || 25)) {
      state = 'CLEAR';
      factor = 1.10;
    }
    /* 3. 判定消散打开 (OPENING) */
    else if (cloudDelta60 <= -(cfg.openingDropRateMin || 5) || (avgNow > 50 && avg60 < 40)) {
      state = 'OPENING';
      var dropRatio = Math.min(1.0, Math.abs(cloudDelta60) / 40);
      factor = 1.05 + dropRatio * 0.10;
    }
    /* 4. 判定加厚合拢 (CLOSING) */
    else if (cloudDelta60 >= (cfg.closingGrowthRateMin || 5) || (avgNow < 50 && avg60 > 65)) {
      state = 'CLOSING';
      var growthRatio = Math.min(1.0, cloudDelta60 / 40);
      factor = Math.max(0.70, 0.95 - growthRatio * 0.25);
    }
    /* 5. 判定多变不确定 (UNCERTAIN) */
    else if (variance >= 35) {
      state = 'UNCERTAIN';
      factor = 0.95;
    }
    /* 6. 稳定态 (STABLE) */
    else {
      state = 'STABLE';
      if (avgNow > 75) factor = 0.85;
      else if (avgNow >= 30 && avgNow <= 60) factor = 1.02; /* 适度云层最利于晚霞/景致 */
      else factor = 0.98;
    }

    var range = cfg.factorRange || [0.65, 1.15];
    factor = Math.max(range[0], Math.min(range[1], Number(factor.toFixed(3))));

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
