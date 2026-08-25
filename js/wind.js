/* ============================================================
 * SunsetScore V2.1 - 风场动力学与向量工具 (Wind Engine)
 * 处理地面及多层风向、风速、u/v 向量分解与位移计算。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var rad = Math.PI / 180;

  var DIR_NAMES = [
    { max: 22.5, label: '北风 (N)', dir: 'N' },
    { max: 67.5, label: '东北风 (NE)', dir: 'NE' },
    { max: 112.5, label: '东风 (E)', dir: 'E' },
    { max: 157.5, label: '东南风 (SE)', dir: 'SE' },
    { max: 202.5, label: '南风 (S)', dir: 'S' },
    { max: 247.5, label: '西南风 (SW)', dir: 'SW' },
    { max: 292.5, label: '西风 (W)', dir: 'W' },
    { max: 337.5, label: '西北风 (NW)', dir: 'NW' },
    { max: 360, label: '北风 (N)', dir: 'N' }
  ];

  /**
   * 气象风向角（从哪吹来）转为中文描述与 8 方位缩写
   */
  function formatDirection(deg) {
    var d = ((deg % 360) + 360) % 360;
    for (var i = 0; i < DIR_NAMES.length; i++) {
      if (d <= DIR_NAMES[i].max) {
        return DIR_NAMES[i];
      }
    }
    return DIR_NAMES[0];
  }

  /**
   * 气象风向（度，来自该方向）和风速（km/h）转为流向与 u/v 分量
   * u: 东向分量 (+东 -西), v: 北向分量 (+北 -南)
   */
  function decompose(speedKmH, fromDeg) {
    var spd = Math.max(0, speedKmH || 0);
    var from = ((fromDeg % 360) + 360) % 360;
    /* 流动前进方向 (Heading) = (fromDeg + 180) % 360 */
    var flowHeading = (from + 180) % 360;
    var theta = flowHeading * rad;

    return {
      speedKmH: spd,
      fromDeg: from,
      flowHeadingDeg: flowHeading,
      u: spd * Math.sin(theta),
      v: spd * Math.cos(theta)
    };
  }

  /**
   * 计算指定高度层（LOW/MID/HIGH）的分层物理风向与风速
   * 优先采用 Open-Meteo 真实等压面探空风 (850hPa / 700hPa / 500hPa)，
   * 若数据缺失则平滑回退到大气边界层 (ABL) 动力学切变与 Ekman 地转偏转经验模型。
   *
   * @param {number} surfaceSpeedKmH 10m 地面风速 (km/h)
   * @param {number} fromDeg 地面风向 (度)
   * @param {string} layer 'LOW' | 'MID' | 'HIGH'
   * @param {number} [lat] 纬度（用于判定南北半球地转偏向方向）
   * @param {object} [upperWindData] 包含等压面风场的数据对象 (node.data)
   */
  function getLayerWind(surfaceSpeedKmH, fromDeg, layer, lat, upperWindData) {
    var lKey = (layer || 'mid').toLowerCase();
    var pressureMap = { low: '850hPa', mid: '700hPa', high: '500hPa' };
    var plevel = pressureMap[lKey] || '700hPa';

    var realSpeedKey = 'wind_speed_' + plevel;
    var realDirKey = 'wind_direction_' + plevel;

    var hasRealWind = upperWindData &&
      typeof upperWindData[realSpeedKey] === 'number' && isFinite(upperWindData[realSpeedKey]) &&
      typeof upperWindData[realDirKey] === 'number' && isFinite(upperWindData[realDirKey]);

    var layerSpeed = 0;
    var layerFromDeg = 0;
    var isRealSounding = false;

    if (hasRealWind) {
      layerSpeed = Math.max(0, upperWindData[realSpeedKey]);
      layerFromDeg = ((upperWindData[realDirKey] % 360) + 360) % 360;
      isRealSounding = true;
    } else {
      /* 回退：大气边界层 (ABL) 经验切变与 Ekman Veering */
      var cfg = (SS.config && SS.config.windMotionV21 && SS.config.windMotionV21.stratifiedLayers) || {
        low:  { multiplier: 1.8, minSpeedKmH: 8.0,  veeringDeg: 15 },
        mid:  { multiplier: 2.5, minSpeedKmH: 18.0, veeringDeg: 30 },
        high: { multiplier: 4.0, minSpeedKmH: 35.0, veeringDeg: 45 }
      };
      var lCfg = cfg[lKey] || cfg.mid;
      var spd = Math.max(0, surfaceSpeedKmH || 0);
      layerSpeed = Math.max(lCfg.minSpeedKmH, spd * lCfg.multiplier);

      /* 地转偏向：北半球顺时针(+), 南半球逆时针(-) */
      var sign = (lat != null && lat < 0) ? -1 : 1;
      layerFromDeg = (((fromDeg || 0) + sign * (lCfg.veeringDeg || 0)) % 360 + 360) % 360;
    }

    var decomp = decompose(layerSpeed, layerFromDeg);
    decomp.layer = lKey.toUpperCase();
    decomp.pressureLevel = plevel;
    decomp.isRealSounding = isRealSounding;
    decomp.label = formatDirection(layerFromDeg).label;
    return decomp;
  }

  /**
   * 计算指定高度层在 Δt (分钟) 内的沿风向下游位移量与逆风上游回溯偏移量
   */
  function calculateLayerAdvectionOffset(surfaceSpeedKmH, fromDeg, layer, deltaMinutes, lat, upperWindData) {
    var lw = getLayerWind(surfaceSpeedKmH, fromDeg, layer, lat, upperWindData);
    var hours = deltaMinutes / 60;
    var distKm = lw.speedKmH * hours;
    var flowHeading = lw.flowHeadingDeg;
    var upstreamHeading = lw.fromDeg; /* 上游来源方向即该高度层风吹来的方向 */

    return {
      layer: lw.layer,
      pressureLevel: lw.pressureLevel,
      isRealSounding: lw.isRealSounding,
      speedKmH: lw.speedKmH,
      fromDeg: lw.fromDeg,
      distanceKm: distKm,
      flowHeadingDeg: flowHeading,
      upstreamHeadingDeg: upstreamHeading,
      /* 下游位移向量 (km) */
      dx: distKm * Math.sin(flowHeading * rad),
      dy: distKm * Math.cos(flowHeading * rad),
      /* 上游回溯向量 (km) */
      upstreamDx: distKm * Math.sin(upstreamHeading * rad),
      upstreamDy: distKm * Math.cos(upstreamHeading * rad)
    };
  }

  /**
   * 基础位移计算（兼容保留）
   */
  function calculateAdvectionOffset(speedKmH, fromDeg, deltaMinutes) {
    var hours = deltaMinutes / 60;
    var distKm = (speedKmH || 0) * hours;
    var flowHeading = ((fromDeg || 0) + 180) % 360;
    var upstreamHeading = ((fromDeg || 0) % 360 + 360) % 360;

    return {
      distanceKm: distKm,
      flowHeadingDeg: flowHeading,
      upstreamHeadingDeg: upstreamHeading,
      dx: distKm * Math.sin(flowHeading * rad),
      dy: distKm * Math.cos(flowHeading * rad),
      upstreamDx: distKm * Math.sin(upstreamHeading * rad),
      upstreamDy: distKm * Math.cos(upstreamHeading * rad)
    };
  }

  var BEAUFORT_SCALE = [
    { maxKmH: 1, level: 0, name: '0级 · 无风' },
    { maxKmH: 5.5, level: 1, name: '1级 · 软风' },
    { maxKmH: 11.5, level: 2, name: '2级 · 轻风' },
    { maxKmH: 19.5, level: 3, name: '3级 · 微风' },
    { maxKmH: 28.5, level: 4, name: '4级 · 和风' },
    { maxKmH: 38.5, level: 5, name: '5级 · 清风' },
    { maxKmH: 49.5, level: 6, name: '6级 · 强风' },
    { maxKmH: 61.5, level: 7, name: '7级 · 疾风' },
    { maxKmH: 74.5, level: 8, name: '8级 · 大风' },
    { maxKmH: Infinity, level: 9, name: '9级及以上' }
  ];

  /**
   * 风速（km/h）转换为蒲福风级与中文描述
   */
  function formatBeaufort(speedKmH) {
    var spd = Math.max(0, speedKmH || 0);
    for (var i = 0; i < BEAUFORT_SCALE.length; i++) {
      if (spd <= BEAUFORT_SCALE[i].maxKmH) {
        return BEAUFORT_SCALE[i];
      }
    }
    return BEAUFORT_SCALE[BEAUFORT_SCALE.length - 1];
  }

  SS.wind = {
    formatDirection: formatDirection,
    formatBeaufort: formatBeaufort,
    decompose: decompose,
    getLayerWind: getLayerWind,
    calculateAdvectionOffset: calculateAdvectionOffset,
    calculateLayerAdvectionOffset: calculateLayerAdvectionOffset
  };
})(typeof window !== 'undefined' ? window : globalThis);
