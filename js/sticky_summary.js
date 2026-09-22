/* ============================================================
 * SunsetScore V2.4.6 - 预测页吸顶摘要
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var initialized = false;
  var framePending = false;

  function $(id) { return root.document.getElementById(id); }

  function setVisible(visible) {
    var summary = $('sticky-prediction-summary');
    if (!summary) return;
    summary.classList.toggle('is-visible', visible);
    summary.setAttribute('aria-hidden', String(!visible));
  }

  function updateVisibility() {
    framePending = false;
    var result = $('result');
    var card = result && result.querySelector ? result.querySelector('.result-card') : null;
    var visible = Boolean(card && !result.classList.contains('hidden') && card.getBoundingClientRect().top <= 0);
    setVisible(visible);
  }

  function requestUpdate() {
    if (framePending) return;
    framePending = true;
    if (root.requestAnimationFrame) root.requestAnimationFrame(updateVisibility);
    else updateVisibility();
  }

  function focusSearchAtTop() {
    var input = $('city-input');
    var reducedMotion = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (root.scrollTo) root.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    if (!input || !input.focus) return;
    try { input.focus({ preventScroll: true }); }
    catch (error) { input.focus(); }
  }

  function setData(result, cityTitle) {
    if (!result) return;
    var score = $('sticky-summary-score');
    var city = $('sticky-summary-city');
    var date = $('sticky-summary-date');
    if (score) score.textContent = result.score == null ? '—' : String(result.score);
    if (city) city.textContent = cityTitle || result.city || '—';
    if (date) {
      date.textContent = result.date || '—';
      if (result.date) date.setAttribute('datetime', result.date);
      else date.removeAttribute('datetime');
    }
    requestUpdate();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    var search = $('sticky-summary-search');
    if (search) search.addEventListener('click', focusSearchAtTop);
    if (root.addEventListener) {
      root.addEventListener('scroll', requestUpdate, { passive: true });
      root.addEventListener('resize', requestUpdate);
    }
    updateVisibility();
  }

  SS.stickySummary = {
    init: init,
    setData: setData,
    update: requestUpdate,
    focusSearchAtTop: focusSearchAtTop
  };
})(typeof window !== 'undefined' ? window : globalThis);
