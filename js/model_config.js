/* ============================================================
 * SunsetScore V2.3 - 生产模型配置入口
 *
 * V2.3 期间保持原参数对象的引用兼容，所有新代码只读取 SS.modelConfig。
 * 后续模型校准只修改本文件导出的当前生产配置，不再新增历史版本分支。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var legacy = SS.config;
  SS.modelConfig = Object.freeze({
    version: SS.version.model,
    scoring: legacy,
    api: legacy.endpoints,
    cache: legacy.cacheV18,
    sampling: legacy.samplingV18,
    nowcast: legacy.nowcastV19,
    cloudField: legacy.cloudFieldV21,
    wind: legacy.windMotionV21,
    skyState: legacy.skyStateV21,
    evolution: legacy.evolutionV20,
    goldenWindow: Object.freeze({
      startMinutes: -30,
      endMinutes: legacy.nowcastV19.proximityGate.activationHours * 60,
      model: legacy.goldenWindowV4
    })
  });
})(typeof window !== 'undefined' ? window : globalThis);
