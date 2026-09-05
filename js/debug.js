/* ============================================================
 * SunsetScore V2.4.3 - 调试视图
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  function enabled() { return /[?&]debug=1/.test(root.location && root.location.search || ''); }
  function render(result) {
    if (!enabled() || !root.document || !result) return;
    var old = root.document.getElementById('debug-panel');
    if (old) old.remove();
    var panel = root.document.createElement('section');
    panel.id = 'debug-panel';
    panel.className = 'card debug-panel';
    var title = root.document.createElement('h3');
    title.textContent = 'V' + SS.version.app + ' Debug Snapshot';
    var pre = root.document.createElement('pre');
    pre.textContent = JSON.stringify({
      versions: { app: result.app_version, model: result.model_version, schema: result.schema_version },
      sampling: result.sampling_mode,
      cache: { result: result.result_cache_status || 'MISS', spatial: result.cache_status },
      performance_timing: result.performance_timing || null,
      pipeline_status: {
        spatial_cache: result.spatial_cache_status,
        spatial_final_mode: result.spatial_final_mode,
        batch_attempts: result.batch_attempts,
        qweather: result.qweather_status,
        radar: result.radar_status,
        satellite: result.satellite_status
      },
      score: result.score,
      components: result.components,
      distance_diagnostics: {
        reliability: result.distance_reliability,
        band_coverage: result.distance_band_coverage,
        illumination_data_factor: result.illumination_data_factor
      },
      regime: result.regime_state,
      skyState: result.all_day_sky_state,
      observation_sources: result.nowcast ? result.nowcast.sourcesStatus : null,
      evolution: result.sky_evolution
    }, null, 2);
    panel.appendChild(title);
    panel.appendChild(pre);
    var resultHost = root.document.getElementById('result');
    if (resultHost) resultHost.appendChild(panel);
  }
  SS.debugView = { enabled: enabled, render: render };
})(typeof window !== 'undefined' ? window : globalThis);
