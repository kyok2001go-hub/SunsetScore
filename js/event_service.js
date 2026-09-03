/* SunsetScore V2.4.1 - stable sunset-event identity */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var COORDINATE_DECIMALS = 4;

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  async function sha256(value) {
    if (!root.crypto || !root.crypto.subtle) throw new Error('当前浏览器不支持事件标识计算');
    var data = new TextEncoder().encode(String(value));
    return hex(await root.crypto.subtle.digest('SHA-256', data));
  }

  function normalizeLocation(result) {
    var source = result.location_source == null ? '' : String(result.location_source).trim().toLowerCase();
    var id = result.location_id == null ? '' : String(result.location_id).trim();
    if (source && id.toLowerCase().indexOf(source + ':') === 0) id = id.slice(source.length + 1);
    if (!!source !== !!id) throw new Error('地点来源和地点 ID 必须同时存在');
    var lat = Number(result.latitude), lon = Number(result.longitude);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new Error('预测结果缺少有效坐标');
    }
    var timezone = SS.time.normalizeTimezone(result.timezone, 'UTC');
    return {
      source: source || null,
      id: id || null,
      key: source && id ? source + ':' + id
        : lat.toFixed(COORDINATE_DECIMALS) + ',' + lon.toFixed(COORDINATE_DECIMALS) + ':' + timezone,
      latitude: lat,
      longitude: lon,
      timezone: timezone
    };
  }

  async function context(result) {
    if (!result) throw new Error('缺少预测结果');
    var location = normalizeLocation(result);
    var date = String(result.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('预测结果缺少当地日期');
    var sunsetUtc = String(result.sunset_time_utc || '').trim();
    if (!Number.isFinite(Date.parse(sunsetUtc))) throw new Error('预测结果缺少标准 UTC 日落时间');
    var eventId = 'evt_v1_' + (await sha256(location.key)).slice(0, 20) + '_' + date;
    return {
      event_id: eventId,
      location_key: location.key,
      event_date_local: date,
      city: String(result.city || '').trim() || '未知城市',
      admin1: String(result.admin1 || '').trim(),
      country: String(result.country || '').trim(),
      latitude: location.latitude,
      longitude: location.longitude,
      location_source: location.source,
      location_id: location.id,
      timezone: location.timezone,
      sunset_time_utc: new Date(sunsetUtc).toISOString(),
      sunset_time_local: String(result.sunset_time_local || '').trim()
    };
  }

  function isSnapshotWindow(contextValue, nowMs) {
    var cutoff = Date.parse(contextValue.sunset_time_utc) + 45 * 60 * 1000;
    var value = Number.isFinite(nowMs) ? nowMs : Date.now();
    return Number.isFinite(cutoff) && value <= cutoff;
  }

  SS.eventService = {
    coordinateDecimals: COORDINATE_DECIMALS,
    sha256: sha256,
    context: context,
    isSnapshotWindow: isSnapshotWindow
  };
})(typeof window !== 'undefined' ? window : globalThis);
