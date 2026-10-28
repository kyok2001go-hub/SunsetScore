/* ============================================================
 * SunsetScore V2.5.5.7 - 旁路采集 V1
 * 自动采集（?replay=1）时额外记录：33 个网格节点的气压层云量 / 相对湿度 / 位势高度（925–250 hPa）、
 * 露点与边界层高度，以及日落方位 0° 射线上 400 / 550 km 两个远点。
 * 只记录、不计分：不进入评分配置、engineInput 或 Replay；失败只记录状态，不影响预测。
 * HTTP 429 时该请求记为 RATE_LIMITED 并跳过，不重试。satellite_shadow 预留给 V2.5.5.8，本期恒为 null。
 * 依据：ref_docs/PRD/V2.5.5.7--旁路采集V1方案.md
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var LEVELS = [925, 850, 700, 500, 300, 250];
  var LEVEL_VARIABLES = ['cloud_cover', 'relative_humidity', 'geopotential_height'];
  var GRID_VARIABLES = ['dew_point_2m', 'boundary_layer_height'];
  LEVELS.forEach(function (level) {
    LEVEL_VARIABLES.forEach(function (name) { GRID_VARIABLES.push(name + '_' + level + 'hPa'); });
  });
  var FAR_VARIABLES = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'].concat(GRID_VARIABLES);
  /* Open-Meteo 返回的单位符号与记录用的规范名 */
  var UNIT_NAMES = { '%': 'percent', 'm': 'meter', '°C': 'celsius' };
  function expectedSymbol(name) {
    if (name === 'dew_point_2m') return '°C';
    if (name === 'boundary_layer_height' || name.indexOf('geopotential_height_') === 0) return 'm';
    return '%';
  }

  var CONFIG = Object.freeze({
    bypassSchemaVersion: 1,
    api: 'open-meteo/forecast',
    model: 'best_match',
    levels: Object.freeze(LEVELS.slice()),
    gridVariables: Object.freeze(GRID_VARIABLES.slice()),
    farVariables: Object.freeze(FAR_VARIABLES.slice()),
    farDistancesKm: Object.freeze([400, 550]),
    timeoutMs: 15000
  });

  function finiteOrNull(value) { return typeof value === 'number' && isFinite(value) ? value : null; }

  function buildUrl(nodes, variables) {
    return SS.modelConfig.api.forecast +
      '?latitude=' + nodes.map(function (n) { return n.latitude.toFixed(4); }).join(',') +
      '&longitude=' + nodes.map(function (n) { return n.longitude.toFixed(4); }).join(',') +
      '&hourly=' + variables.join(',') + '&forecast_days=2&timezone=auto';
  }

  /* 只请求一次：429 记为 RATE_LIMITED，其他失败记为 FAILED，均不重试。上层取消照常抛出。 */
  async function fetchOnce(nodes, variables, options) {
    if (!nodes.length) return { status: 'NOT_REQUESTED', reason_code: 'NO_NODES', forecasts: [] };
    try {
      var json = await SS.network.json(buildUrl(nodes, variables),
        { signal: options && options.signal, timeoutMs: CONFIG.timeoutMs });
      var forecasts = Array.isArray(json) ? json : [json];
      if (forecasts.length !== nodes.length) return { status: 'FAILED', reason_code: 'NODE_COUNT_MISMATCH', forecasts: [] };
      return { status: 'OK', reason_code: null, forecasts: forecasts };
    } catch (error) {
      SS.network.throwIfAborted(options && options.signal);
      var status = error && error.status;
      return { status: status === 429 ? 'RATE_LIMITED' : 'FAILED',
        reason_code: status === 429 ? 'HTTP_429' : (status ? 'HTTP_' + status : String(error && error.name || 'ERROR')), forecasts: [] };
    }
  }

  function nodeRecord(meta, forecast, variables, nowUtcMs, sunsetUtcMs, unitMismatch) {
    var record = Object.assign({}, meta, { elevation_m: null, time_utc: [], variables: {} });
    if (!forecast || !forecast.hourly || !Array.isArray(forecast.hourly.time)) {
      variables.forEach(function (name) { record.variables[name] = []; });
      return record;
    }
    var trimmed = SS.data.trimForecastWindow(forecast, nowUtcMs, sunsetUtcMs);
    var offset = trimmed.utc_offset_seconds || 0;
    record.elevation_m = finiteOrNull(forecast.elevation);
    record.time_utc = trimmed.hourly.time.map(function (value) {
      var epoch = SS.time.fromOpenMeteoLocal(value, offset);
      return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
    });
    var units = forecast.hourly_units || {};
    variables.forEach(function (name) {
      var values = trimmed.hourly[name];
      if (units[name] != null && units[name] !== expectedSymbol(name)) unitMismatch[name] = true;
      record.variables[name] = Array.isArray(values) && values.length === record.time_utc.length && !unitMismatch[name]
        ? values.map(finiteOrNull) : record.time_utc.map(function () { return null; });
    });
    return record;
  }

  function quality(records, variables, request, unitMismatch, out) {
    variables.forEach(function (name) {
      var nulls = 0, total = 0;
      records.forEach(function (r) { (r.variables[name] || []).forEach(function (v) { total++; if (v == null) nulls++; }); });
      out.null_counts[name] = (out.null_counts[name] || 0) + nulls;
      var reason = request.status === 'RATE_LIMITED' ? 'RATE_LIMITED'
        : request.status !== 'OK' ? 'REQUEST_FAILED'
          : unitMismatch[name] ? 'UNIT_MISMATCH' : (nulls > 0 || total === 0 ? 'NOT_RETURNED' : null);
      if (reason && !out.missing_reason[name]) out.missing_reason[name] = reason;
    });
  }

  /* context: { location, solar, nowUtcMs, signal }；返回 bypass_schema_version 1 对象（snapshot_id 由服务端写入）。 */
  async function capture(context) {
    var location = context.location, solar = context.solar;
    var lat = location.latitude, lon = location.longitude, azimuth = solar.sunsetAzimuthDeg;
    var nowUtcMs = context.nowUtcMs, sunsetUtcMs = solar.sunset.valueOf();
    var grid = SS.cloudField.generateGridNodes(lat, lon).map(function (n) {
      return { key: String(n.key), direction: String(n.direction || ''), azimuth: finiteOrNull(n.azimuth),
        distance_km: finiteOrNull(n.distanceKm), latitude: Number(n.latitude), longitude: Number(n.longitude) };
    });
    var far = CONFIG.farDistancesKm.map(function (distance) {
      var p = SS.data.destinationPoint(lat, lon, azimuth, distance);
      return { key: 'SUNSET_' + distance, bearing_deg: azimuth, distance_km: distance, latitude: p.latitude, longitude: p.longitude };
    });
    var fetchedAt = new Date().toISOString();
    var results = await Promise.all([fetchOnce(grid, GRID_VARIABLES, context), fetchOnce(far, FAR_VARIABLES, context)]);
    var mismatchA = {}, mismatchB = {};
    var gridNodes = grid.map(function (n, i) { return nodeRecord(n, results[0].forecasts[i], GRID_VARIABLES, nowUtcMs, sunsetUtcMs, mismatchA); });
    var farNodes = far.map(function (n, i) { return nodeRecord(n, results[1].forecasts[i], FAR_VARIABLES, nowUtcMs, sunsetUtcMs, mismatchB); });
    var units = {};
    FAR_VARIABLES.forEach(function (name) { units[name] = UNIT_NAMES[expectedSymbol(name)]; });
    var q = { null_counts: {}, missing_reason: {} };
    quality(gridNodes, GRID_VARIABLES, results[0], mismatchA, q);
    quality(farNodes, FAR_VARIABLES, results[1], mismatchB, q);
    return {
      bypass_schema_version: CONFIG.bypassSchemaVersion, record_only: true,
      snapshot_id: null, prediction_time_utc: new Date(nowUtcMs).toISOString(), sunset_time_utc: new Date(sunsetUtcMs).toISOString(),
      sunset_azimuth_deg: finiteOrNull(azimuth), latitude: lat, longitude: lon,
      source: { api: CONFIG.api, model: CONFIG.model, fetched_at_utc: fetchedAt, issue_time_utc: null, issue_time_status: 'NOT_PROVIDED_BY_API' },
      requests: {
        A: { status: results[0].status, reason_code: results[0].reason_code, variables: GRID_VARIABLES.slice() },
        B: { status: results[1].status, reason_code: results[1].reason_code, variables: FAR_VARIABLES.slice() }
      },
      time_axis: 'utc_iso8601', units: units, grid_nodes: gridNodes, far_nodes: farNodes, quality: q,
      satellite_shadow: null
    };
  }

  SS.bypassCapture = { CONFIG: CONFIG, capture: capture, buildUrl: buildUrl };
})(typeof window !== 'undefined' ? window : globalThis);
