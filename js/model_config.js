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
      radar: cfg.nowcast.radar.enabled,
      satellite: cfg.nowcast.satellite.enabled,
      goldenWindow: cfg.goldenWindow,
      sampling: cfg.sampling.enabled
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
