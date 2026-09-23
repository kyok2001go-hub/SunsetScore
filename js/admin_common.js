(function () {
  'use strict';

  var api = document.body.getAttribute('data-admin-api');
  if (!api) return;

  var form = document.getElementById('admin-filter-form');
  var status = document.getElementById('admin-list-status');
  var head = document.getElementById('admin-result-head');
  var body = document.getElementById('admin-result-body');
  var resultWrap = document.getElementById('admin-result-wrap');
  var resultTable = document.getElementById('admin-result-table');
  var stickyHead = document.getElementById('admin-sticky-head');
  var stickyTable = document.getElementById('admin-sticky-table');
  var stickyThead = document.getElementById('admin-sticky-thead');
  var total = document.getElementById('admin-total');
  var pageInfo = document.getElementById('admin-page-info');
  var pageSize = document.getElementById('admin-page-size');
  var prev = document.getElementById('admin-prev');
  var next = document.getElementById('admin-next');
  var reset = document.getElementById('admin-reset');
  var submit = form.querySelector('[type="submit"]');
  var clearButtons = form.querySelectorAll('[data-clear-for]');
  var currentPage = 1;
  var pageCount = 0;
  var activeFilters = new URLSearchParams();
  var optionsLoaded = false;
  var requestNumber = 0;
  var controller = null;

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle('error', !!isError);
  }

  function readFilters() {
    var filters = new URLSearchParams();
    form.querySelectorAll('[name]').forEach(function (control) {
      if (control.value !== '') filters.set(control.name, control.value);
    });
    return filters;
  }

  function updateClearButtons() {
    clearButtons.forEach(function (button) {
      var control = form.elements.namedItem(button.getAttribute('data-clear-for'));
      button.hidden = !control || control.value === '';
    });
  }

  clearButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var control = form.elements.namedItem(button.getAttribute('data-clear-for'));
      if (!control) return;
      control.value = '';
      updateClearButtons();
      control.focus();
    });
  });
  form.addEventListener('input', updateClearButtons);
  form.addEventListener('change', updateClearButtons);

  function fillOptions(options, labels) {
    form.querySelectorAll('[data-options]').forEach(function (control) {
      var selected = control.value;
      var name = control.getAttribute('data-options');
      var values = options[name] || [];
      var descriptions = (labels && labels[name]) || {};
      var all = document.createElement('option');
      all.value = '';
      all.textContent = '全部';
      control.replaceChildren(all);
      values.forEach(function (value) {
        var option = document.createElement('option');
        option.value = value;
        option.textContent = value === '__NULL__' ? '空值' : (descriptions[value] || value);
        control.appendChild(option);
      });
      control.value = values.includes(selected) ? selected : '';
    });
    updateClearButtons();
  }

  function updateStickyHead() {
    var wrapRect = resultWrap.getBoundingClientRect();
    var headerHeight = head.getBoundingClientRect().height;
    stickyHead.hidden = !body.children.length || !headerHeight ||
      wrapRect.top > 0 || wrapRect.bottom <= headerHeight;
    if (stickyHead.hidden) return;
    stickyHead.style.left = wrapRect.left + 'px';
    stickyHead.style.width = wrapRect.width + 'px';
    stickyHead.scrollLeft = resultWrap.scrollLeft;
  }

  function syncStickyHead() {
    var sourceRow = head.firstElementChild;
    if (!sourceRow) { stickyHead.hidden = true; return; }
    var copy = sourceRow.cloneNode(true);
    for (var i = 0; i < sourceRow.children.length; i++) {
      copy.children[i].style.width = sourceRow.children[i].getBoundingClientRect().width + 'px';
    }
    stickyThead.replaceChildren(copy);
    stickyTable.style.width = resultTable.getBoundingClientRect().width + 'px';
    updateStickyHead();
  }

  function renderTable(columns, items) {
    var row = document.createElement('tr');
    columns.forEach(function (column) {
      var cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = column;
      row.appendChild(cell);
    });
    head.replaceChildren(row);
    body.replaceChildren();
    items.forEach(function (item) {
      var tr = document.createElement('tr');
      columns.forEach(function (column) {
        var td = document.createElement('td');
        var value = item[column];
        td.textContent = value === null || value === undefined ? '—' : String(value);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    syncStickyHead();
  }

  async function loadPage(page) {
    if (controller) controller.abort();
    controller = new AbortController();
    var sequence = ++requestNumber;
    var params = new URLSearchParams(activeFilters);
    params.set('page', String(page));
    params.set('page_size', pageSize.value);
    if (!optionsLoaded) params.set('include_filter_options', '1');
    submit.disabled = true;
    setStatus('正在查询…', false);
    try {
      var response = await fetch(api + '?' + params.toString(), {
        signal: controller.signal, credentials: 'same-origin', cache: 'no-store'
      });
      var data = await response.json();
      if (sequence !== requestNumber) return;
      if (!response.ok || !data.success) throw new Error(data.error || '数据查询暂时失败');
      if (data.filter_options) {
        fillOptions(data.filter_options, data.filter_labels);
        optionsLoaded = true;
      }
      pageCount = data.pagination.total_pages;
      if (page > Math.max(1, pageCount)) {
        loadPage(Math.max(1, pageCount));
        return;
      }
      currentPage = page;
      renderTable(data.columns, data.items);
      total.textContent = '共 ' + data.pagination.total + ' 条';
      pageInfo.textContent = currentPage + ' / ' + Math.max(1, pageCount);
      prev.disabled = currentPage <= 1;
      next.disabled = currentPage >= pageCount;
      setStatus(data.items.length ? '已显示 ' + data.items.length + ' 条记录。' : '没有符合条件的数据。', false);
      updateStickyHead();
    } catch (error) {
      if (sequence !== requestNumber || error.name === 'AbortError') return;
      setStatus(error.message || '数据查询暂时失败，请重试。', true);
    } finally {
      if (sequence === requestNumber) { submit.disabled = false; controller = null; }
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    activeFilters = readFilters();
    loadPage(1);
  });
  reset.addEventListener('click', function () {
    form.reset();
    updateClearButtons();
    activeFilters = new URLSearchParams();
    optionsLoaded = false;
    loadPage(1);
  });
  pageSize.addEventListener('change', function () { loadPage(1); });
  prev.addEventListener('click', function () { if (currentPage > 1) loadPage(currentPage - 1); });
  next.addEventListener('click', function () { if (currentPage < pageCount) loadPage(currentPage + 1); });
  resultWrap.addEventListener('scroll', updateStickyHead, { passive: true });
  window.addEventListener('scroll', updateStickyHead, { passive: true });
  window.addEventListener('resize', syncStickyHead);
  updateClearButtons();
  loadPage(1);
})();
