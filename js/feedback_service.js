/* ============================================================
 * SunsetScore V2.3 - 反馈领域服务（无 UI 依赖）
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var COOLDOWN_MS = 30 * 60 * 1000;

  function cooldownKey(city) {
    // Ignore old cooldowns that were incorrectly set after failed remote submissions.
    return 'ss_fb_remote_last_ts_' + String(city || 'default').trim().toLowerCase();
  }

  function remainingCooldownMinutes(city, nowMs) {
    try {
      var last = parseInt(root.localStorage.getItem(cooldownKey(city)) || '0', 10);
      var elapsed = (Number.isFinite(nowMs) ? nowMs : Date.now()) - last;
      return last && elapsed < COOLDOWN_MS ? Math.ceil((COOLDOWN_MS - elapsed) / 60000) : 0;
    } catch (error) { return 0; }
  }

  function markSubmitted(city, nowMs) {
    try { root.localStorage.setItem(cooldownKey(city), String(Number.isFinite(nowMs) ? nowMs : Date.now())); }
    catch (error) { /* localStorage may be unavailable */ }
  }

  function probabilityOrNull(value) {
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  }

  // Availability describes the fetched analysis, not whether the evolution model used it.
  // For example, usable satellite data is deliberately excluded during rain.
  function tileStatus(result, name) {
    var evolution = result.sky_evolution || {};
    var detail = evolution.detail || {};
    var nowcast = result.nowcast || {};
    var observed = nowcast.detail || {};
    var statuses = [nowcast.sourcesStatus, observed.sourcesStatus, evolution.sourcesStatus, detail.sourcesStatus];
    var source = null;
    for (var i = 0; i < statuses.length; i++) {
      if (statuses[i] && statuses[i][name]) { source = statuses[i][name]; break; }
    }
    var used = !!detail[name] && detail[name].available !== false;
    var available = source && typeof source.available === 'boolean' ? source.available
      : (observed[name] && typeof observed[name].available === 'boolean' ? observed[name].available
        : (detail[name] && typeof detail[name].available === 'boolean' ? detail[name].available
          : (used ? true : null)));
    return {
      available: available,
      status: source && source.status ? source.status
        : (available === true ? 'OK' : (available === false ? 'UNAVAILABLE'
          : (result.nowcast_active === false ? 'NOT_REQUESTED' : 'UNKNOWN'))),
      used_in_evolution: used,
      error: source && source.error ? source.error : null
    };
  }

  function buildPayload(result, feedback) {
    if (!result) throw new Error('MISSING_PREDICTION_RESULT');
    var f = feedback || {};
    if (!f.rating) throw new Error('MISSING_FEEDBACK_RATING');
    if (['great', 'good', 'fair', 'poor'].indexOf(f.rating) < 0) throw new Error('请选择实际晚霞等级');
    var d = result.data || {};
    var cs = result.cloud_structure || {};
    var state = result.all_day_sky_state || {};
    var motion = result.cloud_motion || {};
    var winds = motion.layerWinds || {};
    var arrival = motion.arrivalRisk || {};
    var evolution = result.sky_evolution || {};
    var regime = result.regime_state || {};
    var weights = regime.dynamicWeight || {};
    var components = result.components || {};
    var openProbability = {};
    ['30m', '60m', '90m', '120m'].forEach(function (horizon) {
      openProbability[horizon] = probabilityOrNull((evolution.openProbability || {})[horizon]);
    });
    var hasProbabilities = ['30m', '60m', '120m'].every(function (horizon) {
      return openProbability[horizon] != null;
    });
    var radarStatus = tileStatus(result, 'radar');
    var satelliteStatus = tileStatus(result, 'satellite');
    var corridorMid = cs.corridorMid != null ? cs.corridorMid : (d.cloud_mid != null ? d.cloud_mid : 0);
    var corridorHigh = cs.corridorHigh != null ? cs.corridorHigh : (d.cloud_high != null ? d.cloud_high : 0);
    var timestamp = Number.isFinite(f.nowUtcMs) ? f.nowUtcMs : Date.now();

    var snapshot = {
      query_id: result.query_id,
      timestamp_utc: new Date(timestamp).toISOString(),
      prediction_time_utc: result.prediction_time_utc || null,
      asset_revision: SS.version.assetRevision,
      app_version: SS.version.app,
      model_version: SS.version.model,
      schema_version: SS.version.schema,
      city: result.city,
      country: result.country,
      admin1: result.admin1,
      coordinates: { lat: result.latitude, lon: result.longitude },
      timezone: result.timezone,
      sunset: { local: result.sunset_local, azimuth: result.sunset_azimuth, twilight_minutes: result.twilight_minutes },
      score: { final: result.score, level: result.level, baseline: result.baseline_score, baseline_level: result.baseline_level },
      components: components,
      dynamic_weights: weights,
      regime: { label: result.regime_label, strength: regime.strength, transition: regime.transition },
      weather_data: d,
      cloud_structure: cs,
      layer_winds: winds,
      sky_evolution: {
        nowcast_active: typeof result.nowcast_active === 'boolean' ? result.nowcast_active : null,
        minutes_to_sunset: Number.isFinite(result.hours_to_sunset) ? result.hours_to_sunset * 60 : null,
        probability_status: hasProbabilities ? 'READY'
          : (result.nowcast_active === false ? 'NOT_ACTIVE' : 'NO_VALID_PROBABILITY'),
        sources_status: { radar: radarStatus, satellite: satelliteStatus },
        macro_state: state.state,
        macro_factor: result.sky_evolution_factor,
        gw_factor: evolution.gwFactor,
        open_probability: openProbability,
        arrival_risk: arrival,
        has_real_tiles: evolution.hasRealTiles,
        degraded_sources: evolution.degradedSources
      },
      best_viewing: result.best_viewing
    };

    return {
      query_id: result.query_id || SS.baseline.generateQueryId(),
      city: result.city || '未知城市', country: result.country || '', admin1: result.admin1 || '',
      latitude: result.latitude != null ? result.latitude : 0,
      longitude: result.longitude != null ? result.longitude : 0,
      timezone: SS.time.normalizeTimezone(result.timezone, 'UTC'),
      sunset_time_local: result.sunset_time_local || (result.date + ' ' + (result.sunset_local || '18:00')),
      sunset_azimuth: result.sunset_azimuth != null ? result.sunset_azimuth : 270,
      twilight_minutes: result.twilight_minutes != null ? result.twilight_minutes : 28,
      best_viewing_window: result.best_viewing_window || null,
      app_version: SS.version.app, model_version: SS.version.model, schema_version: SS.version.schema,
      predicted_score: result.score != null ? result.score : 50,
      predicted_level: result.level || '一般',
      baseline_score: result.baseline_score != null ? result.baseline_score : null,
      baseline_level: result.baseline_level || null,
      regime_label: result.regime_label || null,
      regime_strength: regime.strength != null ? regime.strength : null,
      sky_evolution_state: state.state || 'STABLE',
      sky_evolution_factor: result.sky_evolution_factor != null ? result.sky_evolution_factor : 1,
      gw_factor: evolution.gwFactor != null ? evolution.gwFactor : 1,
      comp_sky_canvas: components.sky_canvas != null ? components.sky_canvas : 0,
      comp_horizon: components.horizon != null ? components.horizon : 0,
      comp_illumination: components.illumination != null ? components.illumination : 0,
      comp_atmosphere: components.atmosphere != null ? components.atmosphere : 0,
      comp_weather: components.weather != null ? components.weather : 0,
      cloud_cover_total: d.cloud_cover != null ? d.cloud_cover : 0,
      cloud_cover_low: d.cloud_low != null ? d.cloud_low : 0,
      cloud_cover_mid: d.cloud_mid != null ? d.cloud_mid : 0,
      cloud_cover_high: d.cloud_high != null ? d.cloud_high : 0,
      corridor_cloud_mid: corridorMid, corridor_cloud_high: corridorHigh,
      anti_sunset_score: cs.antiSunsetScore != null ? cs.antiSunsetScore : 0,
      spatial_variance: result.spatial_variance != null ? result.spatial_variance : null,
      cloud_continuity: cs.continuity != null ? cs.continuity : null,
      aod: d.aod != null ? d.aod : null, pm25: d.pm25 != null ? d.pm25 : null,
      humidity: d.humidity != null ? d.humidity : null,
      surface_pressure: d.surface_pressure != null ? d.surface_pressure : null,
      visibility_km: d.visibility_km != null ? d.visibility_km : null,
      precipitation: d.precip != null ? d.precip : 0,
      layer_wind_850_speed: winds.low && winds.low.speedKmH != null ? winds.low.speedKmH : null,
      layer_wind_850_dir: winds.low && winds.low.fromDeg != null ? winds.low.fromDeg : null,
      layer_wind_700_speed: winds.mid && winds.mid.speedKmH != null ? winds.mid.speedKmH : null,
      layer_wind_700_dir: winds.mid && winds.mid.fromDeg != null ? winds.mid.fromDeg : null,
      layer_wind_500_speed: winds.high && winds.high.speedKmH != null ? winds.high.speedKmH : null,
      layer_wind_500_dir: winds.high && winds.high.fromDeg != null ? winds.high.fromDeg : null,
      is_real_sounding: winds.low ? (winds.low.isRealSounding ? 1 : 0) : 0,
      open_prob_30m: openProbability['30m'] != null ? openProbability['30m'] : null,
      open_prob_60m: openProbability['60m'] != null ? openProbability['60m'] : null,
      open_prob_120m: openProbability['120m'] != null ? openProbability['120m'] : null,
      arrival_risk_30m: arrival.risk30m != null ? arrival.risk30m : null,
      arrival_risk_60m: arrival.risk60m != null ? arrival.risk60m : null,
      tile_radar_available: radarStatus.available === true ? 1 : 0,
      tile_sat_available: satelliteStatus.available === true ? 1 : 0,
      dyn_weight_canvas: weights.skyCanvas != null ? weights.skyCanvas : null,
      dyn_weight_horizon: weights.horizon != null ? weights.horizon : null,
      dyn_weight_illum: weights.illumination != null ? weights.illumination : null,
      dyn_weight_atmo: weights.atmosphere != null ? weights.atmosphere : null,
      dyn_weight_weather: weights.weather != null ? weights.weather : null,
      user_rating: String(f.rating),
      user_rating_label: String(f.ratingLabel || f.rating),
      user_comment: f.comment ? String(f.comment).trim().slice(0, 200) : null,
      raw_snapshot_json: JSON.stringify(snapshot)
    };
  }

  async function submit(result, feedback) {
    var remaining = remainingCooldownMinutes(result && result.city);
    if (remaining > 0) return { local: false, remote: false, cooldown: true, remainingMinutes: remaining, error: '30 分钟内限提交一次反馈' };
    var payload = buildPayload(result, feedback);
    var response = await SS.baseline.submitFeedback(payload);
    if (response.remote) markSubmitted(result.city);
    return response;
  }

  SS.feedbackService = {
    cooldownMs: COOLDOWN_MS,
    remainingCooldownMinutes: remainingCooldownMinutes,
    markSubmitted: markSubmitted,
    buildPayload: buildPayload,
    submit: submit
  };
})(typeof window !== 'undefined' ? window : globalThis);
