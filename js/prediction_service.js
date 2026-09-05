/* ============================================================
 * SunsetScore V2.4.3 - 无 UI 依赖的预测业务编排层
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function progress(options, message) {
    if (options && typeof options.onProgress === 'function') options.onProgress(message);
  }

  function clockMs() {
    return root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now();
  }

  function elapsedMs(start) {
    return Math.max(0, Math.round(clockMs() - start));
  }

  function createTiming() {
    return {
      geocode_ms: null,
      local_forecast_ms: null,
      cache_check_ms: null,
      air_quality_ms: null,
      minute_precip_ms: null,
      spatial_batch_ms: null,
      compute_ms: null,
      nowcast_ms: null,
      total_ms: null
    };
  }

  async function timed(timing, key, operation) {
    var startedAt = clockMs();
    try {
      return await operation();
    } finally {
      timing[key] = elapsedMs(startedAt);
    }
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

  function resultCacheKey(query, location, localDate) {
    return query.toLowerCase().replace(/\s+/g, '_') + '_' +
      SS.cacheKeys.resultLocation(location) + '_' + localDate;
  }

  function cachedLocationMatches(cached, location) {
    var cachedSource = cached.location_source || 'coordinates';
    var cachedId = cached.location_id == null ? 'coordinates' : String(cached.location_id);
    var source = location.source || 'coordinates';
    var id = location.id == null ? 'coordinates' : String(location.id);
    return cachedSource === source && cachedId === id &&
      Number.isFinite(cached.latitude) && Number.isFinite(cached.longitude) &&
      SS.cacheKeys.coord(cached.latitude, cached.longitude) === SS.cacheKeys.coord(location.latitude, location.longitude);
  }

  function readEarlyResultCache(location, nowUtcMs) {
    var locationKey = SS.cacheKeys.resultLocation(location);
    var indexKey = SS.cacheKeys.resultIndex(location);
    var index = SS.cache.get(indexKey);
    if (!index || index.locationKey !== locationKey || typeof index.resultKey !== 'string') return null;
    var cached = SS.cache.get(index.resultKey);
    if (!cached) {
      SS.cache.remove(indexKey);
      return null;
    }
    if (cached.app_version !== SS.version.app || cached.model_version !== SS.version.model ||
        cached.runtime_config_key !== SS.modelConfigKey() || !cachedLocationMatches(cached, location) ||
        typeof cached.timezone !== 'string' || !cached.timezone || cached.timezone === 'auto') return null;
    var localDate;
    try { localDate = SS.time.formatDate(nowUtcMs, cached.timezone); } catch (error) { return null; }
    if (cached.date !== localDate) return null;
    var sunsetUtcMs = Date.parse(cached.sunset_time_utc);
    if (!Number.isFinite(sunsetUtcMs) ||
        (cached.minute_refresh_at_ms && Date.now() >= cached.minute_refresh_at_ms) ||
        (cached.minute_coverage_end_ms && nowUtcMs >= cached.minute_coverage_end_ms)) return null;
    var time = { minutesToSunset: (sunsetUtcMs - nowUtcMs) / 60000 };
    if (cached.nowcast_active !== SS.evolution.isGoldenWindowActive({ time: time })) return null;
    return cached;
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

  async function applySunsetEvolution(result, context, options, timing) {
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
    var nowcastStartedAt = clockMs();
    try {
      try { fusion = await SS.nowcast.run(nowcastContext, options); } catch (error) {
        SS.network.throwIfAborted(options && options.signal);
        fusion = null;
      }
    } finally {
      timing.nowcast_ms = elapsedMs(nowcastStartedAt);
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
    var totalStartedAt = clockMs();
    var timing = createTiming();
    var normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) throw new Error('请输入城市或经纬度');
    options = options || {};
    SS.network.throwIfAborted(options.signal);
    var nowUtcMs = options && Number.isFinite(options.nowUtcMs) ? options.nowUtcMs : Date.now();
    progress(options, '正在解析地理位置…');

    // Candidate selection is already resolved: never geocode its name a second time.
    var location = await timed(timing, 'geocode_ms', async function () {
      var resolved = options.location ? SS.citySearch.toLocation(options.location) : parseCoordinates(normalizedQuery);
      if (options.location && !resolved) throw new Error('城市候选无效，请重新选择');
      if (!resolved) {
        // Share the candidate cache; a separate seven-day first-hit cache could
        // disagree with the current dropdown or resurrect a bad historical match.
        resolved = await SS.data.geocode(normalizedQuery, options);
      }
      return resolved;
    });

    var cacheStartedAt = clockMs();
    var earlyCachedResult;
    try { earlyCachedResult = readEarlyResultCache(location, nowUtcMs); }
    finally { timing.cache_check_ms = elapsedMs(cacheStartedAt); }
    if (earlyCachedResult) {
      timing.total_ms = elapsedMs(totalStartedAt);
      return Object.assign({}, earlyCachedResult, {
        result_cache_status: 'HIT',
        performance_timing: timing
      });
    }

    progress(options, '正在获取本地天气与时区…');
    var roughDate = SS.time.formatDate(nowUtcMs, location.timezone || 'UTC');
    var localOptions = Object.assign({}, options, { timeoutMs: SS.modelConfig.network.localForecastTimeoutMs });
    var forecastResult = await timed(timing, 'local_forecast_ms', function () {
      return fetchWithCache(
        SS.cacheKeys.forecast(roughDate, location.latitude, location.longitude),
        SS.modelConfig.cache.ttlForecastMinutes,
        SS.modelConfig.cache.staleMaxAgeHours,
        function () { return SS.data.fetchForecastWithRetry(location.latitude, location.longitude, 1500, localOptions); }, localOptions
      );
    });
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
    // Homonymous cities and geocoding sources keep independent full-result keys and indices.
    var cacheKey = resultCacheKey(normalizedQuery, location, localDate);

    var localShiftedSunset = SS.time.toLocalShifted(solar.sunset, offsetSeconds);
    var regime = SS.sampling.estimateLocalRegime({
      localForecast: localForecast,
      utcOffsetSeconds: offsetSeconds,
      nowUtc: new Date(nowUtcMs),
      sunsetLocal: localShiftedSunset
    });
    var mode = SS.modelConfig.sampling.enabled ? SS.sampling.decideSamplingMode(regime) : 'FULL';
    var fetchNowcast = SS.modelConfig.nowcast.enabled && time.minutesToSunset >= -SS.modelConfig.goldenWindow.afterSunsetMinutes &&
      time.minutesToSunset <= SS.modelConfig.nowcast.fetchBeforeSunsetMinutes;
    var batchAttempts = 0;
    var airOptions = Object.assign({}, options, { timeoutMs: SS.modelConfig.network.airQualityTimeoutMs });
    var spatialOptions = Object.assign({}, options, {
      timeoutMs: SS.modelConfig.network.spatialBatchTimeoutMs,
      onBatchAttempt: function () { batchAttempts++; }
    });

    progress(options, '正在并行获取空气质量、分钟降水与全天空云场…');
    var airPromise = timed(timing, 'air_quality_ms', function () {
      return fetchWithCache(
        SS.cacheKeys.air(localDate, location.latitude, location.longitude),
        SS.modelConfig.cache.ttlAirQualityMinutes,
        SS.modelConfig.cache.staleMaxAgeHours,
        function () { return SS.data.fetchAirQuality(location.latitude, location.longitude, airOptions); }, airOptions
      );
    });
    var precipPromise = fetchNowcast
      ? timed(timing, 'minute_precip_ms', function () { return minutePrecip(location, localDate, nowUtcMs, options); })
      : Promise.resolve(null);
    var spatialPromise = timed(timing, 'spatial_batch_ms', function () {
      return gatherSky(mode, location, solar, localForecast, localDate, ttlMinutes, spatialOptions);
    });
    var settled = await Promise.allSettled([airPromise, precipPromise, spatialPromise]);
    SS.network.throwIfAborted(options.signal);
    var airQuality = settled[0].status === 'fulfilled' ? settled[0].value.value : null;
    var precipResult = settled[1].status === 'fulfilled' ? settled[1].value : null;
    if (settled[2].status === 'rejected') throw settled[2].reason;
    var spatial = settled[2].value;

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
    context.nowcast.precipResult = precipResult;
    context.nowcast.minutePrecip = context.nowcast.precipResult ? context.nowcast.precipResult.analysis : null;

    var computeStartedAt = clockMs();
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
    result = await applySunsetEvolution(result, context, options, timing);
    timing.compute_ms = Math.max(0, elapsedMs(computeStartedAt) - (timing.nowcast_ms || 0));
    SS.domain.assertPredictionResult(result);
    SS.network.throwIfAborted(options.signal);
    result.runtime_config_key = SS.modelConfigKey();
    result.minute_refresh_at_ms = context.nowcast.precipResult ? context.nowcast.precipResult.refreshAtMs : null;
    result.minute_coverage_end_ms = context.nowcast.minutePrecip ? context.nowcast.minutePrecip.coverageEndMs : null;
    result.result_cache_status = 'MISS';
    result.spatial_cache_status = spatial.cacheStatus;
    result.spatial_final_mode = spatial.finalMode;
    result.batch_attempts = batchAttempts;
    var sourceStatus = result.nowcast && result.nowcast.sourcesStatus;
    var qweather = sourceStatus && sourceStatus.qweather
      ? sourceStatus.qweather
      : (precipResult && precipResult.qweather ? precipResult.qweather : null);
    result.qweather_status = qweather ? qweather.status : (fetchNowcast ? 'UNKNOWN' : 'NOT_REQUESTED');
    result.radar_status = sourceStatus && sourceStatus.radar ? sourceStatus.radar.status : 'NOT_REQUESTED';
    result.satellite_status = sourceStatus && sourceStatus.satellite ? sourceStatus.satellite.status : 'NOT_REQUESTED';
    timing.total_ms = elapsedMs(totalStartedAt);
    result.performance_timing = timing;
    SS.cache.set(cacheKey, result);
    SS.cache.set(SS.cacheKeys.resultIndex(location), {
      locationKey: SS.cacheKeys.resultLocation(location),
      resultKey: cacheKey
    });
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
