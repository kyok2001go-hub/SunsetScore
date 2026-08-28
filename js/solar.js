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

  // Display-only daylight state: sunrise is inclusive, sunset is exclusive.
  // Look at neighbouring UTC dates so midnight/date-line queries use the last
  // actual rise/set event, not the device's date or a fixed local hour.
  function isDaytime(timeMs, lat, lon) {
    if (!Number.isFinite(timeMs) || !Number.isFinite(new Date(timeMs).valueOf()) ||
        !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
        !root.SunCalc || typeof root.SunCalc.getTimes !== 'function') return null;
    var latest = -Infinity, daylight = null, current = null;
    try {
      for (var offset = -1; offset <= 1; offset++) {
        var events = root.SunCalc.getTimes(new Date(timeMs + offset * 86400000), lat, lon);
        if (!events) continue;
        if (offset === 0) current = events;
        ['sunrise', 'sunset'].forEach(function (name) {
          var eventMs = events[name] && events[name].valueOf();
          if (Number.isFinite(eventMs) && eventMs <= timeMs && eventMs > latest) {
            latest = eventMs;
            daylight = name === 'sunrise';
          }
        });
      }
      if (daylight !== null) return daylight;
      // No recent rise/set in polar day/night; do not turn missing events into 0.
      if (current && current.alwaysUp === true) return true;
      if (current && current.alwaysDown === true) return false;
    } catch (error) { /* Unknown solar state must not break weather rendering. */ }
    return null;
  }

  SS.solar = {
    getSunEvents: getSunEvents,
    position: position,
    isDaytime: isDaytime
  };
})(typeof window !== 'undefined' ? window : globalThis);
