/* ============================================================
 * SunsetScore V2.3 - 无 UI 依赖的预测业务编排层
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function progress(options, message) {
    if (options && typeof options.onProgress === 'function') options.onProgress(message);
  }

  function parseCoordinates(text) {
    var match = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    var lat = Number(match[1]), lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { name: lat.toFixed(2) + ', ' + lon.toFixed(2), country: '', admin1: '', latitude: lat, longitude: lon };
  }

  async function fetchWithCache(key, ttlMinutes, staleMaxHours, fetcher, options) {
    var hit = SS.cache.getWithStatus(key, staleMaxHours);
    if (hit.status === 'FRESH') return hit;
    try {
      var value = await fetcher();
      SS.network.throwIfAborted(options && options.signal);
      SS.cache.set(key, value, ttlMinutes);
      return { value: value, status: 'MISS', cacheStatus: 'MISS', ageMinutes: 0 };
    } catch (error) {
      SS.network.throwIfAborted(options && options.signal);
      if (hit.status === 'STALE') return hit;
      throw error;
    }
  }

  function forecastTtlMinutes(sunsetMs, nowMs) {
    var cfg = SS.modelConfig.scoring.cachePolicy;
    var hours = (sunsetMs - nowMs) / 3600000;
    if (hours >= 0 && hours < 3) return cfg.ttlForecastWithin3h;
    if (hours >= 0 && hours < 6) return cfg.ttlForecastWithin6h;
    return cfg.ttlForecastMinutes;
  }

  function computeSolar(location, nowUtcMs, offsetSeconds) {
    var localNow = SS.time.toLocalShifted(nowUtcMs, offsetSeconds);
    var noonUtcMs = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 12) - offsetSeconds * 1000;
    return SS.solar.getSunEvents(new Date(noonUtcMs), location.latitude, location.longitude);
  }

  function serializeSolar(solar) {
    return {
      sunset: solar.sunset.toISOString(),
      civilDusk: solar.civilDusk.toISOString(),
      goldenHourStart: solar.goldenHourStart ? solar.goldenHourStart.toISOString() : null,
      goldenHourEnd: solar.goldenHourEnd ? solar.goldenHourEnd.toISOString() : null,
      sunsetAzimuthDeg: solar.sunsetAzimuthDeg,
      twilightMinutes: solar.twilightMinutes
    };
  }

  function restoreSolar(value) {
    return {
      sunset: new Date(value.sunset),
      civilDusk: new Date(value.civilDusk),
      goldenHourStart: value.goldenHourStart ? new Date(value.goldenHourStart) : null,
      goldenHourEnd: value.goldenHourEnd ? new Date(value.goldenHourEnd) : null,
      sunsetAzimuthDeg: value.sunsetAzimuthDeg,
      twilightMinutes: value.twilightMinutes
    };
  }

  async function gatherSpatial(nodes, localForecast, cacheKey, ttlMinutes, options) {
    var hit = SS.cache.getWithStatus(cacheKey, SS.modelConfig.cache.staleMaxAgeHours);
    function assemble(forecasts) {
      return nodes.map(function (node, index) {
        return { point: node, forecast: node.distanceKm === 0 ? localForecast : ((forecasts && forecasts[index]) || null) };
      });
    }
    if (hit.status === 'FRESH') return { samples: assemble(hit.value.forecasts), cacheStatus: 'FRESH', ageMinutes: hit.ageMinutes };
    try {
      var gathered = await SS.data.gather(nodes, localForecast, options);
      SS.network.throwIfAborted(options && options.signal);
      SS.cache.set(cacheKey, { forecasts: gathered.samples.map(function (sample) { return sample.forecast; }) }, ttlMinutes);
      return { samples: gathered.samples, cacheStatus: 'MISS', ageMinutes: 0 };
    } catch (error) {
      SS.network.throwIfAborted(options && options.signal);
      if (hit.status === 'STALE') return { samples: assemble(hit.value.forecasts), cacheStatus: 'STALE', ageMinutes: hit.ageMinutes };
      throw error;
    }
  }

  async function gatherClassicWithFallback(mode, location, solar, localForecast, date, ttlMinutes, options) {
    var nodes = SS.sampling.selectNodes(mode, location.latitude, location.longitude, solar.sunsetAzimuthDeg);
    var key = SS.cacheKeys.spatial(date, location.latitude, location.longitude, solar.sunsetAzimuthDeg, mode.toLowerCase());
    try {
      var result = await gatherSpatial(nodes, localForecast, key, ttlMinutes, options);
      result.finalMode = mode;
      result.nodeCount = nodes.length;
      return result;
    } catch (error) {
      SS.network.throwIfAborted(options && options.signal);
      if (mode === 'FULL') return gatherClassicWithFallback('STANDARD', location, solar, localForecast, date, ttlMinutes, options);
      if (mode === 'STANDARD') return gatherClassicWithFallback('LOCAL_ONLY', location, solar, localForecast, date, ttlMinutes, options);
      throw new Error('天气 API 暂不可用，请稍后重试');
    }
  }

  async function gatherSky(mode, location, solar, localForecast, date, ttlMinutes, options) {
    if (mode === 'LOCAL_ONLY') {
      var localNode = {
        key: 'CENTER_0', direction: 'CENTER', azimuth: 0, distanceKm: 0, azimuthOffset: 0,
        latitude: location.latitude, longitude: location.longitude, weight: 1
      };
      var localSamples = [{ point: localNode, forecast: localForecast }];
      return { skySamples: localSamples, corridorSamples: localSamples, cacheStatus: 'LOCAL', ageMinutes: 0, finalMode: mode };
    }

    var skyNodes = SS.cloudField.generateGridNodes(location.latitude, location.longitude);
    var key = SS.cacheKeys.cloudField(date, location.latitude, location.longitude);
    try {
      var result = await gatherSpatial(skyNodes, localForecast, key, ttlMinutes, options);
      return {
        skySamples: result.samples,
        corridorSamples: SS.cloudField.interpolateCorridorSamples(
          result.samples, location.latitude, location.longitude, solar.sunsetAzimuthDeg,
          SS.modelConfig.scoring.distancesKm, SS.modelConfig.scoring.azimuthOffsets
        ),
        cacheStatus: result.cacheStatus,
        ageMinutes: result.ageMinutes,
        finalMode: 'FULL_SKY_33'
      };
    } catch (error) {
      SS.network.throwIfAborted(options && options.signal);
      var fallback = await gatherClassicWithFallback(mode, location, solar, localForecast, date, ttlMinutes, options);
      return {
        skySamples: fallback.samples,
        corridorSamples: fallback.samples,
        cacheStatus: fallback.cacheStatus,
        ageMinutes: fallback.ageMinutes,
        finalMode: fallback.finalMode
      };
    }
  }

  function trimSamples(samples, nowUtcMs, sunsetUtcMs) {
    return samples.map(function (sample) {
      return {
        point: sample.point,
        forecast: sample.forecast ? SS.data.trimForecastWindow(sample.forecast, nowUtcMs, sunsetUtcMs) : null
      };
    });
  }

  async function minutePrecip(location, date, nowUtcMs, options) {
    return SS.nowcast.getMinutePrecip({ lat: location.latitude, lon: location.longitude,
      dateStr: date, nowUtc: new Date(nowUtcMs) }, options);
  }

  function computeForecastTrend(localForecast, nowUtcMs, sunsetUtcMs) {
    var nowData = SS.cloudField.extractInterpolatedAt(localForecast, nowUtcMs);
    var sunsetData = SS.cloudField.extractInterpolatedAt(localForecast, sunsetUtcMs);
    if (!nowData || !sunsetData) return null;
    return SS.domain.clamp((nowData.cloud_cover - sunsetData.cloud_cover) * 2, -100, 100);
  }

  function levelOf(score) {
    for (var i = 0; i < SS.modelConfig.scoring.levels.length; i++) {
      if (score >= SS.modelConfig.scoring.levels[i].min) return SS.modelConfig.scoring.levels[i].label;
    }
    return SS.modelConfig.scoring.levels[SS.modelConfig.scoring.levels.length - 1].label;
  }

  function addDisplayFields(result, context) {
    var solar = context.solar;
    var timezone = context.time.timezone;
    var viewing = SS.engine.bestViewing(solar, SS.modelConfig.scoring);
    result.best_viewing = {
      start: SS.time.formatHM(viewing.startUtc, timezone),
      peak: SS.time.formatHM(viewing.peakUtc, timezone),
      end: SS.time.formatHM(viewing.endUtc, timezone)
    };
    result.sunset_local = SS.time.formatHM(solar.sunset, timezone);
    result.golden_hour = solar.goldenHourStart && solar.goldenHourEnd
      ? SS.time.formatHM(solar.goldenHourStart, timezone) + ' – ' + SS.time.formatHM(solar.goldenHourEnd, timezone) : '—';
    result.blue_hour = solar.goldenHourEnd && solar.civilDusk
      ? SS.time.formatHM(solar.goldenHourEnd, timezone) + ' – ' + SS.time.formatHM(solar.civilDusk, timezone) : '—';
    result.date = context.time.localDate;
    result.local_time_str = SS.time.formatHM(context.time.nowUtcMs, timezone);
    result.timezone = timezone;
    result.timezone_str = SS.time.formatUtcOffset(context.weather.utcOffsetSeconds);
    result.utc_offset_seconds = context.weather.utcOffsetSeconds;
    result.hours_to_sunset = context.time.minutesToSunset / 60;
    result.sunset_time_utc = solar.sunset.toISOString();
    result.sunset_time_local = SS.time.formatLocal(solar.sunset, timezone, false);
    result.best_viewing_window = result.best_viewing.start + ' – ' + result.best_viewing.end + ' (峰值 ' + result.best_viewing.peak + ')';
    result.twilight_minutes = Math.round(solar.twilightMinutes);
    result.query_id = SS.baseline.generateQueryId();
    result.prediction_time_utc = new Date(context.time.nowUtcMs).toISOString();
    result.app_version = SS.version.app;
    result.model_version = SS.version.model;
    result.schema_version = SS.version.schema;
    result.location_source = context.location.source || null;
    result.location_id = context.location.id == null ? null : String(context.location.id);
    return result;
  }

  async function applySunsetEvolution(result, context, options) {
    var factor = SS.domain.clamp(result.sky_evolution_factor, 0.65, 1.15, 1);
    result.base_score = result.score;
    if (!SS.evolution.isGoldenWindowActive(context)) {
      result.nowcast = null;
      result.nowcast_active = false;
      result.score = Math.round(SS.domain.clamp(result.score * factor, 0, 100));
      result.level = levelOf(result.score);
      return result;
    }

    result.nowcast_active = true;
    var nowcastContext = {
      lat: context.location.latitude,
      lon: context.location.longitude,
      dateStr: context.time.localDate,
      nowUtc: new Date(context.time.nowUtcMs),
      sunsetAzimuthDeg: context.solar.sunsetAzimuthDeg,
      utcOffsetSeconds: context.weather.utcOffsetSeconds,
      forecastTrend: computeForecastTrend(context.weather.localForecast, context.time.nowUtcMs, context.time.sunsetUtcMs),
      motionForecast: result.cloud_motion
    };
    // Reuse this query's prefetch, including failure diagnostics; do not request twice.
    nowcastContext.precipResult = context.nowcast.precipResult;
    var fusion = null;
    try { fusion = await SS.nowcast.run(nowcastContext, options); } catch (error) {
      SS.network.throwIfAborted(options && options.signal);
      fusion = null;
    }
    if (fusion) {
      fusion.goldenWindow = SS.evolution.constrainGoldenWindow(fusion.goldenWindow,
        context.time.nowUtcMs, context.time.sunsetUtcMs);
      fusion.timeline = SS.nowcast.buildTimeline(fusion.detail && fusion.detail.precip,
        context.weather.localForecast, context.time.nowUtcMs);
    }
    var evo = SS.evolution.evaluate({
      forecastTrend: nowcastContext.forecastTrend,
      precip: fusion && fusion.detail ? fusion.detail.precip : null,
      radar: fusion && fusion.detail ? fusion.detail.radar : null,
      satellite: fusion && fusion.detail ? fusion.detail.satellite : null,
      motionForecast: result.cloud_motion,
      nowMs: context.time.nowUtcMs,
      sunsetMs: context.time.sunsetUtcMs,
      sourcesStatus: fusion ? fusion.sourcesStatus : null
    });
    result.nowcast = fusion;
    result.sky_evolution = evo;
    var gwFactor = evo ? SS.domain.clamp(evo.gwFactor, SS.modelConfig.goldenWindow.floor, 1, 1) : 1;
    result.score = Math.round(SS.domain.clamp(result.score * factor * gwFactor, 0, 100));
    result.level = levelOf(result.score);
    if (evo && evo.degradedSources && evo.degradedSources.length) {
      evo.degradedSources.forEach(function (label) {
        var key = label === '雷达瓦片' ? 'radar' : 'satellite';
        var source = fusion && fusion.sourcesStatus && fusion.sourcesStatus[key];
        var reason = source && source.status === 'TIMEOUT' ? '请求超时'
          : source && source.status === 'FAILED' ? '请求或解析失败'
          : source && source.available ? '演化数据不足' : '暂无可用数据';
        result.warnings.push('实况' + label + reason + '（预测继续使用其余可用来源，缺失部分由 NWP 补充）');
      });
    }
    return result;
  }

  async function predict(query, options) {
    var normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) throw new Error('请输入城市或经纬度');
    options = options || {};
    SS.network.throwIfAborted(options.signal);
    var nowUtcMs = options && Number.isFinite(options.nowUtcMs) ? options.nowUtcMs : Date.now();
    progress(options, '正在解析地理位置…');

    // Candidate selection is already resolved: never geocode its name a second time.
    var location = options.location ? SS.citySearch.toLocation(options.location) : parseCoordinates(normalizedQuery);
    if (options.location && !location) throw new Error('城市候选无效，请重新选择');
    if (!location) {
      // Share the candidate cache; a separate seven-day first-hit cache could
      // disagree with the current dropdown or resurrect a bad historical match.
      location = await SS.data.geocode(normalizedQuery, options);
    }

    progress(options, '正在获取本地天气与时区…');
    var roughDate = SS.time.formatDate(nowUtcMs, location.timezone || 'UTC');
    var forecastResult = await fetchWithCache(
      SS.cacheKeys.forecast(roughDate, location.latitude, location.longitude),
      SS.modelConfig.cache.ttlForecastMinutes,
      SS.modelConfig.cache.staleMaxAgeHours,
      function () { return SS.data.fetchForecastWithRetry(location.latitude, location.longitude, 1500, options); }, options
    );
    var localForecast = forecastResult.value;
    var offsetSeconds = localForecast.utc_offset_seconds || 0;
    var timezone = SS.time.normalizeTimezone(localForecast.timezone || location.timezone, 'UTC');
    var localDate = SS.time.formatDate(nowUtcMs, timezone);

    var solarResult = await fetchWithCache(
      SS.cacheKeys.solar(localDate, location.latitude, location.longitude),
      SS.modelConfig.cache.ttlSolarHours * 60,
      SS.modelConfig.cache.ttlSolarHours,
      function () {
        var solar = computeSolar(location, nowUtcMs, offsetSeconds);
        if (!solar) throw new Error('该地区当前处于极昼或极夜，今天没有日落');
        return Promise.resolve(serializeSolar(solar));
      }, options
    );
    var solar = restoreSolar(solarResult.value);
    var ttlMinutes = forecastTtlMinutes(solar.sunset.valueOf(), nowUtcMs);
    SS.network.throwIfAborted(options.signal);
    SS.cache.set(SS.cacheKeys.forecast(localDate, location.latitude, location.longitude), localForecast, ttlMinutes);

    var time = {
      nowUtcMs: nowUtcMs,
      timezone: timezone,
      localDate: localDate,
      sunsetUtcMs: solar.sunset.valueOf(),
      sunsetLocalText: SS.time.formatLocal(solar.sunset, timezone, false),
      minutesToSunset: (solar.sunset.valueOf() - nowUtcMs) / 60000
    };
    // Homonymous cities must not share an entire prediction (even with the same query).
    var resultCacheKey = normalizedQuery.toLowerCase().replace(/\s+/g, '_') + '_' +
      (location.source || 'coordinates') + '_' + (location.id || 'coordinates') + '_' + SS.cacheKeys.coord(location.latitude, location.longitude) + '_' + localDate;
    var cachedResult = SS.cache.get(resultCacheKey);
    // A fresh TTL alone is insufficient when the query crosses the golden-window gate.
    if (cachedResult && cachedResult.app_version === SS.version.app &&
        cachedResult.model_version === SS.version.model &&
        cachedResult.runtime_config_key === SS.modelConfigKey() &&
        (!cachedResult.minute_refresh_at_ms || Date.now() < cachedResult.minute_refresh_at_ms) &&
        (!cachedResult.minute_coverage_end_ms || nowUtcMs < cachedResult.minute_coverage_end_ms) &&
        cachedResult.nowcast_active === SS.evolution.isGoldenWindowActive({ time: time })) {
      return Object.assign({}, cachedResult, { result_cache_status: 'HIT' });
    }

    progress(options, '正在获取空气质量…');
    var airQuality = null;
    try {
      var airResult = await fetchWithCache(
        SS.cacheKeys.air(localDate, location.latitude, location.longitude),
        SS.modelConfig.cache.ttlAirQualityMinutes,
        SS.modelConfig.cache.staleMaxAgeHours,
        function () { return SS.data.fetchAirQuality(location.latitude, location.longitude, options); }, options
      );
      airQuality = airResult.value;
    } catch (error) {
      SS.network.throwIfAborted(options && options.signal);
      airQuality = null;
    }

    var context = SS.domain.createPredictionContext({
      query: normalizedQuery,
      lat: location.latitude,
      lon: location.longitude,
      location: location,
      time: time,
      solar: solar,
      weather: { localForecast: localForecast, utcOffsetSeconds: offsetSeconds },
      airQuality: airQuality
    });

    var fetchNowcast = SS.modelConfig.nowcast.enabled && time.minutesToSunset >= -SS.modelConfig.goldenWindow.afterSunsetMinutes &&
      time.minutesToSunset <= SS.modelConfig.nowcast.fetchBeforeSunsetMinutes;
    context.nowcast.precipResult = fetchNowcast ? await minutePrecip(location, localDate, nowUtcMs, options) : null;
    context.nowcast.minutePrecip = context.nowcast.precipResult ? context.nowcast.precipResult.analysis : null;

    var localShiftedSunset = SS.time.toLocalShifted(solar.sunset, offsetSeconds);
    var regime = SS.sampling.estimateLocalRegime({
      localForecast: localForecast,
      utcOffsetSeconds: offsetSeconds,
      nowUtc: new Date(nowUtcMs),
      sunsetLocal: localShiftedSunset
    });
    var mode = SS.modelConfig.sampling.enabled ? SS.sampling.decideSamplingMode(regime) : 'FULL';
    progress(options, '正在获取全天空 360° 云场与风场动力学…');
    var spatial = await gatherSky(mode, location, solar, localForecast, localDate, ttlMinutes, options);

    context.sky.currentField = SS.cloudField.buildCloudField(spatial.skySamples, nowUtcMs);
    context.sky.sunsetField = SS.cloudField.buildCloudField(spatial.skySamples, solar.sunset);
    context.wind.motionForecast = SS.cloudMotion.forecast({
      currentField: context.sky.currentField,
      targetAzimuthDeg: solar.sunsetAzimuthDeg,
      samples: spatial.skySamples,
      nowUtcMs: nowUtcMs
    });
    context.sky.futureFields = context.wind.motionForecast.predictions;
    context.sky.state = SS.skyState.determineState(context.sky.currentField, context.wind.motionForecast, solar.sunsetAzimuthDeg);

    progress(options, '正在进行评分与演化推演…');
    var corridorSamples = trimSamples(spatial.corridorSamples, nowUtcMs, solar.sunset.valueOf());
    var engineInput = {
      location: location,
      utcOffsetSeconds: offsetSeconds,
      localNowUtc: new Date(nowUtcMs),
      solar: solar,
      sunsetLocal: localShiftedSunset,
      samples: corridorSamples,
      air: airQuality,
      cloudField: context.sky.sunsetField,
      expectedSampleCount: corridorSamples.length,
      totalSkyNodeCount: spatial.skySamples.length,
      spatialCompleteness: SS.sampling.weightedCompleteness(corridorSamples),
      samplingMode: spatial.finalMode,
      cacheStatus: spatial.cacheStatus,
      dataAgeMinutes: spatial.ageMinutes,
      minutePrecip: context.nowcast.minutePrecip
    };
    var result = SS.engine.compute(engineInput);
    var baseline = SS.baseline.compute({ solar: solar, sunsetLocal: localShiftedSunset }, corridorSamples);
    result.baseline_score = baseline.score;
    result.baseline_level = baseline.level;
    result.baseline_detail = baseline;
    result.cloud_field = context.sky.currentField;
    result.cloud_field_sunset = context.sky.sunsetField;
    result.cloud_motion = context.wind.motionForecast;
    result.all_day_sky_state = context.sky.state;
    result.sky_evolution_factor = context.sky.state.factor;
    result.data_age = spatial.ageMinutes;
    result.admin1 = location.admin1 || '';
    result.latitude = location.latitude;
    result.longitude = location.longitude;
    addDisplayFields(result, context);
    result = await applySunsetEvolution(result, context, options);
    SS.domain.assertPredictionResult(result);
    SS.network.throwIfAborted(options.signal);
    result.runtime_config_key = SS.modelConfigKey();
    result.minute_refresh_at_ms = context.nowcast.precipResult ? context.nowcast.precipResult.refreshAtMs : null;
    result.minute_coverage_end_ms = context.nowcast.minutePrecip ? context.nowcast.minutePrecip.coverageEndMs : null;
    result.result_cache_status = 'MISS';
    SS.cache.set(resultCacheKey, result);
    return result;
  }

  SS.prediction = {
    predict: function (query, options) {
      options = options || {};
      return SS.network.run(function (signal) {
        return predict(query, Object.assign({}, options, { signal: signal }));
      }, { signal: options.signal, timeoutMs: SS.modelConfig.network.queryTimeoutMs });
    },
    parseCoordinates: parseCoordinates,
    buildPredictionContext: SS.domain.createPredictionContext
  };
})(typeof window !== 'undefined' ? window : globalThis);
