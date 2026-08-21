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
   */
  function determineState(cloudField, motionForecast) {
    if (!cloudField || !cloudField.summary) {
      return { state: 'UNCERTAIN', factor: 1.0, confidence: 0.5 };
    }

    var cfg = (SS.config && SS.config.skyStateV21) || {};
    var avgNow = cloudField.summary.avgCloudCover;
    var variance = cloudField.summary.spatialVariance;
    var risk = motionForecast ? motionForecast.arrivalRisk : null;
    var pred60 = (motionForecast && motionForecast.predictions && motionForecast.predictions.m60) || null;

    var avg60 = pred60 ? pred60.avgCloudCover : avgNow;
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
        spatialVariance: variance,
        arrivalRisk60: risk ? risk.risk60m : 0
      }
    };
  }

  SS.skyState = {
    STATE_META: STATE_META,
    determineState: determineState
  };
})(typeof window !== 'undefined' ? window : globalThis);
