/* SunsetScore V2.4.2 - prediction snapshot service */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  async function buildPayload(result, options) {
    options = options || {};
    if (!SS.feedbackService || typeof SS.feedbackService.buildPayload !== 'function') {
      throw new Error('预测快照构建器不可用');
    }
    var source = String(options.source || '').trim();
    if (['github_schedule', 'github_manual', 'user_feedback'].indexOf(source) < 0) {
      throw new Error('非法快照来源');
    }
    var slot = source === 'user_feedback' ? null : String(options.scheduledSlot || '').trim();
    if (source !== 'user_feedback' && !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(slot)) {
      throw new Error('自动快照缺少有效业务时段');
    }
    var legacy = SS.feedbackService.buildPayload(result, {
      rating: 'poor',
      nowUtcMs: Number.isFinite(options.nowUtcMs) ? options.nowUtcMs : Date.now()
    });
    var eventContext = await SS.eventService.context(result);
    var keyMaterial = source === 'user_feedback'
      ? [eventContext.event_id, source, String(options.submissionId || ''), legacy.model_version].join('|')
      : [eventContext.event_id, source, slot, legacy.model_version].join('|');
    if (source === 'user_feedback' && !options.submissionId) throw new Error('用户快照缺少反馈提交标识');
    return {
      event_context: eventContext,
      idempotency_key: 'snap_v1_' + await SS.eventService.sha256(keyMaterial),
      snapshot_source: source,
      scheduled_slot: slot,
      query_id: legacy.query_id,
      prediction_time_utc: result.prediction_time_utc,
      sunset_azimuth: legacy.sunset_azimuth,
      twilight_minutes: legacy.twilight_minutes,
      best_viewing_window: legacy.best_viewing_window,
      app_version: legacy.app_version,
      model_version: legacy.model_version,
      schema_version: legacy.schema_version,
      dataset_schema_version: SS.version.datasetSchema,
      asset_revision: SS.version.assetRevision,
      predicted_score: legacy.predicted_score,
      predicted_level: legacy.predicted_level,
      baseline_score: legacy.baseline_score,
      baseline_level: legacy.baseline_level,
      regime_label: legacy.regime_label,
      regime_strength: legacy.regime_strength,
      sky_evolution_state: legacy.sky_evolution_state,
      sky_evolution_factor: legacy.sky_evolution_factor,
      gw_factor: legacy.gw_factor,
      comp_sky_canvas: legacy.comp_sky_canvas,
      comp_horizon: legacy.comp_horizon,
      comp_illumination: legacy.comp_illumination,
      comp_atmosphere: legacy.comp_atmosphere,
      comp_weather: legacy.comp_weather,
      cloud_cover_total: legacy.cloud_cover_total,
      cloud_cover_low: legacy.cloud_cover_low,
      cloud_cover_mid: legacy.cloud_cover_mid,
      cloud_cover_high: legacy.cloud_cover_high,
      corridor_cloud_mid: legacy.corridor_cloud_mid,
      corridor_cloud_high: legacy.corridor_cloud_high,
      anti_sunset_score: legacy.anti_sunset_score,
      spatial_variance: legacy.spatial_variance,
      cloud_continuity: legacy.cloud_continuity,
      aod: legacy.aod,
      pm25: legacy.pm25,
      humidity: legacy.humidity,
      surface_pressure: legacy.surface_pressure,
      visibility_km: legacy.visibility_km,
      precipitation: legacy.precipitation,
      layer_wind_850_speed: legacy.layer_wind_850_speed,
      layer_wind_850_dir: legacy.layer_wind_850_dir,
      layer_wind_700_speed: legacy.layer_wind_700_speed,
      layer_wind_700_dir: legacy.layer_wind_700_dir,
      layer_wind_500_speed: legacy.layer_wind_500_speed,
      layer_wind_500_dir: legacy.layer_wind_500_dir,
      is_real_sounding: legacy.is_real_sounding,
      open_prob_30m: legacy.open_prob_30m,
      open_prob_60m: legacy.open_prob_60m,
      open_prob_120m: legacy.open_prob_120m,
      arrival_risk_30m: legacy.arrival_risk_30m,
      arrival_risk_60m: legacy.arrival_risk_60m,
      tile_radar_available: legacy.tile_radar_available,
      tile_sat_available: legacy.tile_sat_available,
      dyn_weight_canvas: legacy.dyn_weight_canvas,
      dyn_weight_horizon: legacy.dyn_weight_horizon,
      dyn_weight_illum: legacy.dyn_weight_illum,
      dyn_weight_atmo: legacy.dyn_weight_atmo,
      dyn_weight_weather: legacy.dyn_weight_weather,
      raw_snapshot_json: legacy.raw_snapshot_json
    };
  }

  async function send(payload) {
    try {
      var reply = await SS.network.request('/api/snapshot', {
        timeoutMs: SS.modelConfig.network.feedbackTimeoutMs,
        allowHttpError: true,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      });
      var data = reply.data || {};
      if (!reply.response.ok || data.success !== true) {
        return { remote: false, error: data.error || ('HTTP ' + reply.response.status) };
      }
      return { remote: true, id: data.id, deduplicated: !!data.deduplicated };
    } catch (error) {
      return { remote: false, error: error && error.name === 'TimeoutError'
        ? '提交超时，服务器是否保存尚未确认；请使用同一任务重试'
        : '无法连接快照服务，请稍后重试' };
    }
  }

  async function submit(result, options) {
    return send(await buildPayload(result, options));
  }

  SS.snapshotService = { buildPayload: buildPayload, send: send, submit: submit };
})(typeof window !== 'undefined' ? window : globalThis);
