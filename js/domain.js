/* ============================================================
 * SunsetScore V2.3 - 领域数据契约与数值安全层
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  var CLOUD_FIELD_SCHEMA_VERSION = 1;

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function clamp(value, min, max, fallback) {
    var n = safeNumber(value, fallback == null ? min : fallback);
    return Math.max(min, Math.min(max, n));
  }

  function safeNumber(value, fallback, min, max) {
    var n = isFiniteNumber(value) ? value : fallback;
    if (!isFiniteNumber(n)) n = 0;
    if (isFiniteNumber(min)) n = Math.max(min, n);
    if (isFiniteNumber(max)) n = Math.min(max, n);
    return n;
  }

  function safeProbability(value, fallback) {
    return clamp(value, 0, 1, isFiniteNumber(fallback) ? fallback : 0.5);
  }

  function normalizeCloudData(data) {
    var d = data || {};
    return {
      cloud_cover: clamp(d.cloud_cover, 0, 100),
      cloud_cover_low: clamp(d.cloud_cover_low, 0, 100),
      cloud_cover_mid: clamp(d.cloud_cover_mid, 0, 100),
      cloud_cover_high: clamp(d.cloud_cover_high, 0, 100),
      wind_speed_10m: safeNumber(d.wind_speed_10m, 0, 0),
      wind_direction_10m: ((safeNumber(d.wind_direction_10m, 0) % 360) + 360) % 360,
      wind_gusts_10m: d.wind_gusts_10m == null ? null : safeNumber(d.wind_gusts_10m, 0, 0),
      visibility: safeNumber(d.visibility, 10000, 0),
      relative_humidity_2m: clamp(d.relative_humidity_2m, 0, 100),
      precipitation: safeNumber(d.precipitation, 0, 0),
      precipitation_probability: clamp(d.precipitation_probability, 0, 100),
      surface_pressure: d.surface_pressure == null ? null : safeNumber(d.surface_pressure, 1013, 0),
      wind_speed_850hPa: d.wind_speed_850hPa == null ? null : safeNumber(d.wind_speed_850hPa, 0, 0),
      wind_direction_850hPa: d.wind_direction_850hPa == null ? null : ((safeNumber(d.wind_direction_850hPa, 0) % 360) + 360) % 360,
      wind_speed_700hPa: d.wind_speed_700hPa == null ? null : safeNumber(d.wind_speed_700hPa, 0, 0),
      wind_direction_700hPa: d.wind_direction_700hPa == null ? null : ((safeNumber(d.wind_direction_700hPa, 0) % 360) + 360) % 360,
      wind_speed_500hPa: d.wind_speed_500hPa == null ? null : safeNumber(d.wind_speed_500hPa, 0, 0),
      wind_direction_500hPa: d.wind_direction_500hPa == null ? null : ((safeNumber(d.wind_direction_500hPa, 0) % 360) + 360) % 360
    };
  }

  function normalizeNode(node) {
    var n = node || {};
    return {
      key: String(n.key || ''),
      direction: n.direction || 'CENTER',
      azimuth: ((safeNumber(n.azimuth, 0) % 360) + 360) % 360,
      distanceKm: safeNumber(n.distanceKm, 0, 0),
      latitude: n.latitude == null ? null : safeNumber(n.latitude, 0, -90, 90),
      longitude: n.longitude == null ? null : safeNumber(n.longitude, 0, -180, 180),
      data: normalizeCloudData(n.data),
      hasData: n.hasData !== false
    };
  }

  function summarizeCloudField(center, nodes) {
    var all = [];
    if (center) all.push(center);
    (nodes || []).forEach(function (node) { if (node && node.hasData !== false) all.push(node); });
    if (!all.length) all.push(normalizeNode({ key: 'CENTER_0', hasData: false }));

    function mean(key) {
      var sum = 0;
      all.forEach(function (node) { sum += safeNumber(node.data && node.data[key], 0, 0, 100); });
      return Math.round(sum / all.length);
    }

    var avgCloudCover = mean('cloud_cover');
    var varianceSum = 0;
    (nodes || []).forEach(function (node) {
      var diff = safeNumber(node.data && node.data.cloud_cover, avgCloudCover, 0, 100) - avgCloudCover;
      varianceSum += diff * diff;
    });

    return {
      avgCloudCover: avgCloudCover,
      avgCloudLow: mean('cloud_cover_low'),
      avgCloudMid: mean('cloud_cover_mid'),
      avgCloudHigh: mean('cloud_cover_high'),
      spatialVariance: Math.round(Math.sqrt(varianceSum / Math.max(1, (nodes || []).length))),
      nodeCount: all.length,
      validCount: all.filter(function (node) { return node.hasData !== false; }).length
    };
  }

  function normalizeCloudField(field, prediction) {
    var raw = field || {};
    var center = normalizeNode(raw.center || { key: 'CENTER_0', direction: 'CENTER', distanceKm: 0 });
    var nodes = (raw.nodes || []).map(normalizeNode);
    var nodeMap = {};
    nodes.forEach(function (node) { if (node.key) nodeMap[node.key] = node; });
    var computed = summarizeCloudField(center, nodes);
    var s = raw.summary || {};
    var summary = {
      avgCloudCover: clamp(s.avgCloudCover, 0, 100, computed.avgCloudCover),
      avgCloudLow: clamp(s.avgCloudLow, 0, 100, computed.avgCloudLow),
      avgCloudMid: clamp(s.avgCloudMid, 0, 100, computed.avgCloudMid),
      avgCloudHigh: clamp(s.avgCloudHigh, 0, 100, computed.avgCloudHigh),
      spatialVariance: safeNumber(s.spatialVariance, computed.spatialVariance, 0),
      nodeCount: Math.max(1, Math.round(safeNumber(s.nodeCount, computed.nodeCount, 1))),
      validCount: Math.max(0, Math.round(safeNumber(s.validCount, computed.validCount, 0)))
    };
    var out = {
      schemaVersion: CLOUD_FIELD_SCHEMA_VERSION,
      timestamp: Math.round(safeNumber(raw.timestamp, Date.now(), 0)),
      center: center,
      nodes: nodes,
      nodeMap: nodeMap,
      summary: summary
    };
    if (prediction || raw.prediction) {
      var p = prediction || raw.prediction || {};
      out.prediction = {
        horizonMinutes: Math.max(0, Math.round(safeNumber(p.horizonMinutes, 0, 0))),
        method: String(p.method || 'nwp'),
        source: String(p.source || p.method || 'nwp'),
        confidence: safeProbability(p.confidence, 0.5),
        windAdjusted: !!p.windAdjusted
      };
    }
    return out;
  }

  function validateCloudField(field) {
    var errors = [];
    if (!field || field.schemaVersion !== CLOUD_FIELD_SCHEMA_VERSION) errors.push('INVALID_SCHEMA_VERSION');
    if (!field || !field.summary) errors.push('MISSING_SUMMARY');
    ['avgCloudCover', 'avgCloudLow', 'avgCloudMid', 'avgCloudHigh', 'spatialVariance'].forEach(function (key) {
      if (!field || !field.summary || !isFiniteNumber(field.summary[key])) errors.push('INVALID_' + key.toUpperCase());
    });
    return { valid: errors.length === 0, errors: errors };
  }

  function validatePredictionResult(result) {
    var errors = [];
    if (!result || !isFiniteNumber(result.score)) errors.push('INVALID_FINAL_SCORE');
    if (result && isFiniteNumber(result.score) && (result.score < 0 || result.score > 100)) errors.push('FINAL_SCORE_OUT_OF_RANGE');
    if (result && result.sky_evolution_factor != null && !isFiniteNumber(result.sky_evolution_factor)) errors.push('INVALID_SKY_EVOLUTION_FACTOR');
    if (result && result.sky_evolution && result.sky_evolution.gwFactor != null && !isFiniteNumber(result.sky_evolution.gwFactor)) errors.push('INVALID_GOLDEN_WINDOW_FACTOR');
    return { valid: errors.length === 0, errors: errors };
  }

  function assertPredictionResult(result) {
    var validation = validatePredictionResult(result);
    if (!validation.valid) throw new Error(validation.errors[0]);
    return result;
  }

  function createPredictionContext(request) {
    var r = request || {};
    return {
      request: {
        query: String(r.query || ''),
        lat: r.lat == null ? null : safeNumber(r.lat, 0, -90, 90),
        lon: r.lon == null ? null : safeNumber(r.lon, 0, -180, 180)
      },
      location: r.location || null,
      time: r.time || {
        nowUtcMs: Date.now(), timezone: 'UTC', localDate: null,
        sunsetUtcMs: null, sunsetLocalText: null, minutesToSunset: null
      },
      solar: r.solar || {},
      weather: r.weather || {},
      airQuality: r.airQuality || null,
      sky: { currentField: null, sunsetField: null, futureFields: {} },
      wind: {},
      nowcast: {},
      evolution: {},
      score: {}
    };
  }

  SS.domain = {
    CLOUD_FIELD_SCHEMA_VERSION: CLOUD_FIELD_SCHEMA_VERSION,
    isFiniteNumber: isFiniteNumber,
    clamp: clamp,
    safeNumber: safeNumber,
    safeProbability: safeProbability,
    normalizeCloudData: normalizeCloudData,
    normalizeCloudField: normalizeCloudField,
    validateCloudField: validateCloudField,
    validatePredictionResult: validatePredictionResult,
    assertPredictionResult: assertPredictionResult,
    createPredictionContext: createPredictionContext
  };
})(typeof window !== 'undefined' ? window : globalThis);
