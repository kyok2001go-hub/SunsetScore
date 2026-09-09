/* SunsetScore V2.4.6 - deterministic L2 Replay capture (schema v1). */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var VARIABLES = String(SS.config.hourlyVariables || '').split(',').filter(Boolean);
  var UNITS = Object.freeze({
    cloud_cover: 'percent', cloud_cover_low: 'percent', cloud_cover_mid: 'percent', cloud_cover_high: 'percent',
    visibility: 'meter', relative_humidity_2m: 'percent', precipitation: 'millimeter',
    precipitation_probability: 'percent', wind_speed_10m: 'km/h',
    wind_direction_10m: 'degree_from_north', wind_gusts_10m: 'km/h', surface_pressure: 'hPa',
    wind_speed_850hPa: 'km/h', wind_direction_850hPa: 'degree_from_north',
    wind_speed_700hPa: 'km/h', wind_direction_700hPa: 'degree_from_north',
    wind_speed_500hPa: 'km/h', wind_direction_500hPa: 'degree_from_north'
  });

  function finiteOrNull(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
  function jsonClone(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      var output = {};
      Object.keys(value).sort().forEach(function (key) { output[key] = canonicalize(value[key]); });
      return output;
    }
    return value;
  }
  function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
  function hex(buffer) {
    return Array.from(new Uint8Array(buffer), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }
  async function sha256(value) {
    return hex(await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
  }

  function sanitizeConfig(value, key) {
    if (value == null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return value;
    if (Array.isArray(value)) return value.map(function (item) { return sanitizeConfig(item, ''); });
    if (typeof value !== 'object') return undefined;
    var output = {};
    Object.keys(value).sort().forEach(function (name) {
      if (/secret|token|authorization|cookie|api.?key/i.test(name)) return;
      if (['endpoint', 'endpoints', 'capabilities', 'tileBase'].indexOf(name) >= 0) return;
      if (key === 'root' && ['api', 'cache', 'network'].indexOf(name) >= 0) return;
      if (['cachePolicy', 'network', 'citySearch'].indexOf(name) >= 0) return;
      var sanitized = sanitizeConfig(value[name], name);
      if (sanitized !== undefined) output[name] = sanitized;
    });
    return output;
  }

  function normalizeForecast(sample, nowUtcMs, sunsetUtcMs) {
    var point = sample && sample.point || {};
    var forecast = sample && sample.forecast;
    if (!forecast || !forecast.hourly || !Array.isArray(forecast.hourly.time)) return null;
    forecast = SS.data.trimForecastWindow(forecast, nowUtcMs, sunsetUtcMs);
    var offset = forecast.utc_offset_seconds || 0;
    var times = forecast.hourly.time.map(function (value) {
      var epoch = SS.time.fromOpenMeteoLocal(value, offset);
      return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
    });
    if (times.some(function (value) { return value == null; })) throw new Error('FAILED_REPLAY_CAPTURE_NWP_TIME');
    var variables = {};
    VARIABLES.forEach(function (name) {
      var values = forecast.hourly[name];
      if (!Array.isArray(values)) values = times.map(function () { return null; });
      if (values.length !== times.length) throw new Error('FAILED_REPLAY_CAPTURE_NWP_LENGTH');
      variables[name] = values.map(finiteOrNull);
    });
    return {
      key: String(point.key || 'node'), direction: String(point.direction || ''),
      azimuth: finiteOrNull(point.azimuth), distance_km: finiteOrNull(point.distanceKm),
      azimuth_offset: finiteOrNull(point.azimuthOffset), latitude: Number(point.latitude),
      longitude: Number(point.longitude), weight: finiteOrNull(point.weight),
      timezone: String(forecast.timezone || 'UTC'), utc_offset_seconds: offset,
      time_utc: times, variables: variables
    };
  }

  function normalizeAir(air, nowUtcMs, sunsetUtcMs) {
    if (!air || !air.hourly || !Array.isArray(air.hourly.time)) return { available: false };
    var trimmed = SS.data.trimForecastWindow(air, nowUtcMs, sunsetUtcMs);
    var offset = trimmed.utc_offset_seconds || 0;
    var time = trimmed.hourly.time.map(function (value) {
      return new Date(SS.time.fromOpenMeteoLocal(value, offset)).toISOString();
    });
    var variables = {};
    Object.keys(trimmed.hourly).sort().forEach(function (name) {
      if (name === 'time' || !Array.isArray(trimmed.hourly[name])) return;
      if (trimmed.hourly[name].length !== time.length) throw new Error('FAILED_REPLAY_CAPTURE_AIR_LENGTH');
      variables[name] = trimmed.hourly[name].map(finiteOrNull);
    });
    return { available: true, time_axis: 'utc_iso8601', time_utc: time,
      units: { aerosol_optical_depth: 'dimensionless', pm2_5: 'µg/m³' }, variables: variables };
  }

  function statusOnly(value) {
    if (!value) return null;
    return { available: !!value.available, status: String(value.status || 'UNKNOWN') };
  }

  function normalizePrecip(precipResult) {
    var analysis = precipResult && precipResult.analysis;
    var series = analysis && analysis.series;
    if (!series || !Array.isArray(series.times) || !Array.isArray(series.precipitation)) {
      return { available: false, source: precipResult && precipResult.source || null };
    }
    if (series.times.length !== series.precipitation.length) throw new Error('FAILED_REPLAY_CAPTURE_PRECIP_LENGTH');
    return {
      available: true, source: String(series.source || precipResult.source || 'unknown'), time_axis: 'utc_epoch_ms',
      coverage_start: series.times.length ? Number(series.times[0]) : null,
      coverage_end: series.times.length ? Number(series.times[series.times.length - 1]) + Number(series.stepMs || 0) : null,
      step_ms: finiteOrNull(series.stepMs), interval_anchor: series.intervalAnchor || 'interval_start',
      minute_series: {
        time_utc_ms: series.times.map(function (time) { return Number(time); }),
        precipitation_mm: series.precipitation.map(finiteOrNull)
      }
    };
  }

  function normalizeVisual(source, status) {
    if (!source) return { available: false, source: null, source_status: status && status.status || 'UNKNOWN', coverage_series: [] };
    return {
      available: !!source.available, source_status: status && status.status || 'UNKNOWN', source: source.source || null,
      layer: source.layer || null, coverage_series: Array.isArray(source.coverageSeries)
        ? source.coverageSeries.map(function (entry) {
          return { t: Number(entry.t), pct: finiteOrNull(entry.pct) };
        }) : []
    };
  }

  function normalizeMotion(motion, nowUtcMs) {
    motion = motion || {};
    return {
      input_mode: motion.predictions && motion.predictions.m30 && motion.predictions.m30.source === 'nwp'
        ? 'nwp_samples' : 'advection_fallback',
      base_time_utc: new Date(nowUtcMs).toISOString(), forecast_horizons_minutes: [30, 60, 120],
      wind_source_flags: Object.keys(motion.layerWinds || {}).reduce(function (map, key) {
        map[key] = String(motion.layerWinds[key] && motion.layerWinds[key].source || 'unknown'); return map;
      }, {}),
      source_quality_flags: { confidence_available: finiteOrNull(motion.confidence) != null }
    };
  }

  function sourceKeysForCorridor(point, spatial, sunsetAzimuthDeg) {
    if (!point || point.distanceKm === 0) return ['CENTER_0'];
    if (spatial.finalMode !== 'FULL_SKY_33') return [String(point.key || 'node')];
    var directions = SS.cloudField.DIRECTIONS, azimuths = SS.cloudField.AZIMUTHS;
    var bearing = ((sunsetAzimuthDeg + Number(point.azimuthOffset || 0) + 360) % 360);
    for (var index = 0; index < azimuths.length; index++) {
      var low = azimuths[index], high = index === azimuths.length - 1 ? 360 : azimuths[index + 1];
      if (bearing >= low && bearing <= high) {
        return [directions[index] + '_' + point.distanceKm,
          directions[index === directions.length - 1 ? 0 : index + 1] + '_' + point.distanceKm];
      }
    }
    return [];
  }

  function corridorDefinitions(spatial, sunsetAzimuthDeg) {
    return spatial.corridorSamples.map(function (sample) {
      var point = sample.point || {};
      return {
        latitude: finiteOrNull(point.latitude), longitude: finiteOrNull(point.longitude),
        distance_km: finiteOrNull(point.distanceKm), azimuth_offset: finiteOrNull(point.azimuthOffset) == null ? 0 : finiteOrNull(point.azimuthOffset),
        role: String(point.role || (point.distanceKm === 0 ? 'local' : 'corridor')),
        weight: finiteOrNull(point.weight), source_node_keys: sourceKeysForCorridor(point, spatial, sunsetAzimuthDeg),
        interpolation_policy_version: spatial.finalMode === 'FULL_SKY_33' ? 1 : 0
      };
    });
  }

  async function capture(input) {
    input = input || {};
    var result = input.result, context = input.context, spatial = input.spatial;
    if (!result || !context || !spatial || !Array.isArray(spatial.skySamples) || !spatial.skySamples.length) {
      throw new Error('FAILED_REPLAY_CAPTURE_CONTEXT');
    }
    var nowUtcMs = context.time.nowUtcMs, sunsetUtcMs = context.time.sunsetUtcMs;
    var nodes = spatial.skySamples.map(function (sample) { return normalizeForecast(sample, nowUtcMs, sunsetUtcMs); });
    if (nodes.some(function (node) { return !node; })) throw new Error('FAILED_REPLAY_CAPTURE_NWP_NODE');
    var effectiveConfig = sanitizeConfig(SS.modelConfig, 'root');
    var configHash = await sha256(canonicalJson(effectiveConfig));
    var sourceStatus = result.nowcast && result.nowcast.sourcesStatus || {};
    var detail = result.nowcast && result.nowcast.detail || {};
    return canonicalize({
      replay_schema_version: 1,
      identity: {
        prediction_time_utc: result.prediction_time_utc, model_version: result.model_version,
        engine_code_version: SS.version.app, engine_build_sha: SS.version.assetRevision,
        config_hash: configHash
      },
      context: {
        city: result.city, admin1: result.admin1 || null, country: result.country || null,
        latitude: result.latitude, longitude: result.longitude, timezone: result.timezone,
        utc_offset_seconds: result.utc_offset_seconds, sunset_time_utc: context.solar.sunset.toISOString(),
        civil_dusk_utc: context.solar.civilDusk.toISOString(),
        golden_hour_start_utc: context.solar.goldenHourStart ? context.solar.goldenHourStart.toISOString() : null,
        golden_hour_end_utc: context.solar.goldenHourEnd ? context.solar.goldenHourEnd.toISOString() : null,
        sunset_azimuth_deg: context.solar.sunsetAzimuthDeg, twilight_minutes: context.solar.twilightMinutes,
        app_version: SS.version.app, model_version: SS.version.model, asset_revision: SS.version.assetRevision,
        dataset_schema_version: SS.version.datasetSchema
      },
      effective_config: effectiveConfig,
      nwp: { time_axis: 'utc_iso8601', units: UNITS, nodes: nodes },
      air_quality: normalizeAir(context.airQuality, nowUtcMs, sunsetUtcMs),
      minute_precip: normalizePrecip(context.nowcast.precipResult),
      radar: normalizeVisual(detail.radar, sourceStatus.radar),
      satellite: normalizeVisual(detail.satellite, sourceStatus.satellite),
      cloud_motion: normalizeMotion(result.cloud_motion, nowUtcMs),
      engine_inputs: {
        sampling_mode: spatial.finalMode, cache_status: spatial.cacheStatus,
        data_age_minutes: finiteOrNull(spatial.ageMinutes), expected_sample_count: input.engineInput.expectedSampleCount,
        total_sky_node_count: spatial.skySamples.length,
        spatial_completeness: input.engineInput.spatialCompleteness,
        spatial_fallback_reason: spatial.finalMode === 'FULL_SKY_33' ? null : 'FULL_SKY_UNAVAILABLE',
        actual_sky_node_keys: spatial.skySamples.map(function (sample) { return String(sample.point && sample.point.key || 'node'); }),
        actual_corridor_nodes: corridorDefinitions(spatial, context.solar.sunsetAzimuthDeg),
        source_degradation_flags: {
          qweather: result.qweather_status || 'UNKNOWN', radar: result.radar_status || 'NOT_REQUESTED',
          satellite: result.satellite_status || 'NOT_REQUESTED'
        }
      }
    });
  }

  SS.replayService = { schemaVersion: 1, capture: capture, canonicalJson: canonicalJson, sha256: sha256 };
})(typeof window !== 'undefined' ? window : globalThis);
