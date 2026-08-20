/* ============================================================
 * SunsetScore V1.5 - 太阳位置计算封装层
 * 底层使用 SunCalc v2（js/vendor/suncalc.js，Meeus 天文算法，
 * 含 ΔT 与大气折射修正），本文件只做接口适配，
 * 保持 SS.solar.getSunEvents / SS.solar.position 接口不变。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  /**
   * 计算某地"当天"的日落相关事件。
   * refDate 建议传入当地正午对应的 UTC 时刻（SunCalc 会锚定到该
   * UTC 日对应的当地太阳日，二者配合可避免跨日歧义）。
   * 返回 null 表示极昼/极夜，当日无日落。
   */
  function getSunEvents(refDate, lat, lon) {
    var t = root.SunCalc.getTimes(refDate, lat, lon);
    /* 极昼/极夜时 sunset 为 null；高纬度偶有日落但无民用昏影的情况一并兜底 */
    if (!t.sunset || !t.dusk) return null;

    var pos = root.SunCalc.getPosition(t.sunset, lat, lon);
    return {
      sunset: t.sunset,
      civilDusk: t.dusk,                          /* -6°，民用昏影终点 / 蓝色时刻终点 */
      goldenHourStart: t.goldenHour || null,      /* +6°，傍晚金色时刻起点 */
      goldenHourEnd: t.goldenHourDusk || null,    /* -4°，傍晚金色时刻终点 / 蓝色时刻起点 */
      sunsetAzimuthDeg: pos.azimuth,              /* 已是从北顺时针的罗盘方位角 */
      twilightMinutes: (t.dusk.valueOf() - t.sunset.valueOf()) / 60000
    };
  }

  /* 某一时刻的太阳位置 */
  function position(dateUTC, lat, lon) {
    var p = root.SunCalc.getPosition(dateUTC, lat, lon);
    return {
      altitudeDeg: p.altitude,   /* 含大气折射修正的视高度 */
      azimuthDeg: p.azimuth      /* 0°=北，90°=东，180°=南，270°=西 */
    };
  }

  SS.solar = {
    getSunEvents: getSunEvents,
    position: position
  };
})(typeof window !== 'undefined' ? window : globalThis);
