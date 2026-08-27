/* ============================================================
 * SunsetScore V2.3 - 应用启动器
 * 只负责绑定入口事件，并连接 Prediction Service 与 UI。
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var initialized = false;
  var activeQuery = null;
  function $(id) { return root.document.getElementById(id); }

  async function predict(query) {
    var normalized = String(query || '').trim();
    if (!normalized) return;
    if (activeQuery) activeQuery.abort();
    var controller = new AbortController();
    activeQuery = controller;
    SS.ui.beginPrediction();
    try {
      var result = await SS.prediction.predict(normalized, { signal: controller.signal, onProgress: function (message) {
        if (activeQuery === controller) SS.ui.setLoading(message);
      } });
      if (activeQuery === controller && !controller.signal.aborted) SS.ui.renderResult(result);
    } catch (error) {
      if (activeQuery !== controller || controller.signal.aborted) return;
      if (root.console && root.console.error) root.console.error('[SunsetScore]', error);
      SS.ui.showError(error && error.message ? error.message : '预测失败，请检查网络后重试');
    } finally {
      if (activeQuery === controller) { activeQuery = null; SS.ui.endPrediction(); }
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    var form = $('search-form');
    var input = $('city-input');
    var chips = $('quick-chips');
    var details = $('details-toggle');
    if (form) form.addEventListener('submit', function (event) {
      event.preventDefault();
      predict(input && input.value);
    });
    if (chips) chips.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-city]');
      if (!button) return;
      if (input) input.value = button.dataset.city;
      predict(button.dataset.city);
    });
    if (details) details.addEventListener('click', SS.ui.toggleDetails);
    if (SS.feedbackUi) SS.feedbackUi.init();
  }

  SS.app = { init: init, predict: predict };
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
