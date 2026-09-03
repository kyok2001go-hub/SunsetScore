/* ============================================================
 * SunsetScore V2.3 - 实况反馈弹窗交互
 * ============================================================ */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};
  var initialized = false;
  var selectedRating = null;
  var selectedLabel = '';
  var pendingSubmissionId = null;
  function $(id) { return root.document.getElementById(id); }
  function toast(message, warning) {
    var host = $('toast-container'); if (!host) return;
    var node = root.document.createElement('div'); node.className = 'ss-toast' + (warning ? ' warning' : '');
    var icon = root.document.createElement('span'); icon.className = 'ss-toast-icon'; icon.textContent = warning ? '⚠️' : '🎉';
    var text = root.document.createElement('span'); text.textContent = message;
    node.appendChild(icon); node.appendChild(text); host.appendChild(node);
    root.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 3500);
  }
  function reset() {
    selectedRating = null; selectedLabel = ''; pendingSubmissionId = null;
    var group = $('modal-feedback-btn-group');
    if (group) Array.prototype.forEach.call(group.querySelectorAll('.modal-fb-btn'), function (button) { button.classList.remove('active'); });
    if ($('modal-feedback-comment')) $('modal-feedback-comment').value = '';
  }
  function formatDate(result) {
    var value = result && typeof result.date === 'string' ? result.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && result && typeof result.sunset_time_local === 'string') {
      var matched = result.sunset_time_local.match(/^\d{4}-\d{2}-\d{2}/);
      value = matched ? matched[0] : '';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { value: '', label: '日期未知' };
    var parts = value.split('-');
    return { value: value, label: parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日' };
  }
  function renderContext(result) {
    var city = $('feedback-modal-city');
    var date = $('feedback-modal-date');
    if (city) city.textContent = result && typeof result.city === 'string' && result.city.trim() ? result.city.trim() : '未知城市';
    if (date) {
      var formatted = formatDate(result);
      date.textContent = formatted.label;
      if (formatted.value) date.setAttribute('datetime', formatted.value);
      else date.removeAttribute('datetime');
    }
  }
  function open() {
    var result = SS.ui.getCurrentResult();
    if (!result) { toast('请先搜索城市获取今日晚霞预测~', true); return; }
    reset(); renderContext(result); SS.ui.show($('feedback-modal')); root.document.body.style.overflow = 'hidden';
  }
  function close() { SS.ui.hide($('feedback-modal')); root.document.body.style.overflow = ''; reset(); }
  async function submit() {
    var result = SS.ui.getCurrentResult();
    if (!selectedRating) { toast('请先选择实况评级（如极佳彩霞）~', true); return; }
    if (!result) { toast('暂无预测数据，请先搜索城市~', true); return; }
    var remaining = SS.feedbackService.remainingCooldownMinutes(result.city);
    if (remaining > 0) { toast('30 分钟内限提交一次反馈，还需等待 ' + remaining + ' 分钟~', true); return; }
    var button = $('modal-feedback-submit-btn');
    button.disabled = true; button.textContent = '提交中…';
    try {
      var comment = $('modal-feedback-comment') ? $('modal-feedback-comment').value : '';
      if (!pendingSubmissionId) pendingSubmissionId = SS.observationService.createSubmissionId();
      var response = await SS.observationService.submit(result, {
        submissionId: pendingSubmissionId,
        rating: selectedRating,
        comment: comment
      });
      if (response.cooldown || response.error && response.error.indexOf('30 分钟') >= 0) {
        toast(response.error || '提交过于频繁，请稍后再试', true);
        return;
      }
      if (!response.remote) {
        toast('提交未成功：' + (response.error || '服务器未确认保存') +
          (response.local ? '（已在本机备份，请稍后重试）' : ''), true);
        return;
      }
      SS.feedbackService.markSubmitted(result.city);
      close(); toast('感谢反馈~我们会努力做得更好', false);
    } catch (error) {
      toast(error && error.message ? error.message : '反馈提交失败', true);
    } finally {
      button.disabled = false; button.textContent = '提交';
    }
  }
  function init() {
    if (initialized) return;
    initialized = true;
    if ($('floating-feedback-btn')) $('floating-feedback-btn').addEventListener('click', open);
    if ($('feedback-modal-close')) $('feedback-modal-close').addEventListener('click', close);
    if ($('feedback-modal')) $('feedback-modal').addEventListener('click', function (event) { if (event.target === $('feedback-modal')) close(); });
    if ($('modal-feedback-btn-group')) $('modal-feedback-btn-group').addEventListener('click', function (event) {
      var button = event.target.closest('.modal-fb-btn'); if (!button) return;
      Array.prototype.forEach.call(this.querySelectorAll('.modal-fb-btn'), function (item) { item.classList.remove('active'); });
      button.classList.add('active'); selectedRating = button.getAttribute('data-rating');
      selectedLabel = (button.querySelector('.modal-fb-label') || button).textContent.trim();
    });
    if ($('modal-feedback-submit-btn')) $('modal-feedback-submit-btn').addEventListener('click', submit);
    root.document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !$('feedback-modal').classList.contains('hidden')) close(); });
  }
  SS.feedbackUi = { init: init, open: open, close: close };
})(typeof window !== 'undefined' ? window : globalThis);
