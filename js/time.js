/* ============================================================
 * SunsetScore V2.3 - UTC / IANA 统一时间服务
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function toUtcMs(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date && Number.isFinite(value.valueOf())) return value.valueOf();
    if (typeof value === 'string') {
      var parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback == null ? Date.now() : fallback;
  }

  function isValidTimezone(timezone) {
    if (typeof timezone !== 'string' || !timezone || /^(UTC|GMT)[+-]/i.test(timezone)) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
      return true;
    } catch (e) {
      return false;
    }
  }

  function normalizeTimezone(timezone, fallback) {
    if (isValidTimezone(timezone)) return timezone;
    if (isValidTimezone(fallback)) return fallback;
    return 'UTC';
  }

  function parts(timestamp, timezone) {
    var tz = normalizeTimezone(timezone, 'UTC');
    var formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    });
    var map = {};
    formatter.formatToParts(new Date(toUtcMs(timestamp))).forEach(function (part) {
      if (part.type !== 'literal') map[part.type] = part.value;
    });
    return map;
  }

  function formatLocal(timestamp, timezone, includeSeconds) {
    var p = parts(timestamp, timezone);
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + (includeSeconds === false ? '' : ':' + p.second);
  }

  function formatDate(timestamp, timezone) {
    return formatLocal(timestamp, timezone, false).slice(0, 10);
  }

  function formatHM(timestamp, timezone) {
    return formatLocal(timestamp, timezone, false).slice(11, 16);
  }

  /* 仅用于兼容 V2.2.2 的界面标签；内部计算仍使用 UTC epoch + IANA timezone。 */
  function formatUtcOffset(offsetSeconds) {
    var seconds = typeof offsetSeconds === 'number' && Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
    var totalMinutes = Math.round(Math.abs(seconds) / 60);
    if (totalMinutes === 0) return 'UTC';
    var hours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;
    return 'UTC' + (seconds < 0 ? '-' : '+') + hours + (minutes ? ':' + (minutes < 10 ? '0' : '') + minutes : '');
  }

  function minutesBetween(fromValue, toValue) {
    return (toUtcMs(toValue) - toUtcMs(fromValue)) / 60000;
  }

  function fromOpenMeteoLocal(localIso, utcOffsetSeconds) {
    if (typeof localIso !== 'string') return null;
    var parsedAsUtc = Date.parse(localIso.indexOf('Z') === -1 ? localIso + 'Z' : localIso);
    return Number.isFinite(parsedAsUtc) ? parsedAsUtc - (utcOffsetSeconds || 0) * 1000 : null;
  }

  function toLocalShifted(utcValue, utcOffsetSeconds) {
    return new Date(toUtcMs(utcValue) + (utcOffsetSeconds || 0) * 1000);
  }

  SS.time = {
    toUtcMs: toUtcMs,
    isValidTimezone: isValidTimezone,
    normalizeTimezone: normalizeTimezone,
    formatLocal: formatLocal,
    formatDate: formatDate,
    formatHM: formatHM,
    formatUtcOffset: formatUtcOffset,
    minutesBetween: minutesBetween,
    fromOpenMeteoLocal: fromOpenMeteoLocal,
    toLocalShifted: toLocalShifted
  };
})(typeof window !== 'undefined' ? window : globalThis);
