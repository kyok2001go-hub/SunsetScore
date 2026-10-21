/* 当前生产模型入口：只保留一套算法；历史版本由独立归档保存。 */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var cfg = SS.config;
  SS.modelConfig = Object.freeze({
    version: SS.version.model,
    scoring: cfg,
    api: cfg.endpoints,
    cache: cfg.cachePolicy,
    sampling: cfg.sampling,
    nowcast: cfg.nowcast,
    cloudField: cfg.cloudField,
    wind: cfg.wind,
    skyState: cfg.skyState,
    evolution: cfg.evolution,
    goldenWindow: cfg.goldenWindow,
    network: cfg.network
  });
  // Key operational switches must not reuse a result or observation from a different policy.
  SS.modelConfigKey = function () {
    return JSON.stringify({
      nowcast: cfg.nowcast.enabled,
      qweather: cfg.nowcast.qweather.enabled,
      precipRetryMinutes: cfg.nowcast.precipRetryMinutes,
      precipCoveragePolicy: {
        version: cfg.nowcast.coveragePolicyVersion,
        fetchBeforeSunsetMinutes: cfg.nowcast.fetchBeforeSunsetMinutes,
        analysisHorizonMinutes: cfg.nowcast.analysisHorizonMinutes,
        coverageFadeMinutes: cfg.nowcast.coverageFadeMinutes
      },
      radar: cfg.nowcast.radar.enabled,
      satellite: cfg.nowcast.satellite.enabled,
      weights: cfg.weights,
      highCloudCenter: cfg.highCloudCenter, highCloudWidth: cfg.highCloudWidth,
      midCloudCenter: cfg.midCloudCenter, midCloudWidth: cfg.midCloudWidth,
      goldenWindow: cfg.goldenWindow,
      illuminationModel: cfg.illuminationModel || { bankShare: 0.5, twilightSaturationMinutes: 35 },
      sampling: cfg.sampling.enabled,
      batchRetry: cfg.sampling.batchRetry,
      networkPolicy: {
        localForecastTimeoutMs: cfg.network.localForecastTimeoutMs,
        spatialBatchTimeoutMs: cfg.network.spatialBatchTimeoutMs,
        airQualityTimeoutMs: cfg.network.airQualityTimeoutMs,
        minutePrecipTimeoutMs: cfg.network.minutePrecipTimeoutMs,
        observationTimeoutMs: cfg.network.observationTimeoutMs,
        tileTimeoutMs: cfg.network.tileTimeoutMs,
        radarSourceTimeoutMs: cfg.network.radarSourceTimeoutMs,
        satelliteSourceTimeoutMs: cfg.network.satelliteSourceTimeoutMs
      },
      levels: cfg.levels
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
