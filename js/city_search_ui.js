/* Accessible combobox: IME-aware debounce, stale-request cancellation and explicit selection. */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function init(onSearch) {
    var doc = root.document;
    var form = doc.getElementById('search-form'), input = doc.getElementById('city-input');
    var field = doc.getElementById('city-search-field'), panel = doc.getElementById('city-suggestions');
    var list = doc.getElementById('city-options'), status = doc.getElementById('city-search-status');
    if (!form || !input || !field || !panel || !list || !status) return null;
    var items = [], readyQuery = null, selected = null, active = -1;
    var generation = 0, timer, pending = null, controller = null, submitting = false;
    var composing = false, compositionJustEnded = false, wantOpen = false;

    function text() { return SS.citySearch.normalize(input.value); }
    function close() {
      wantOpen = false;
      panel.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function render(message) {
      list.replaceChildren();
      items.forEach(function (location, index) {
        var option = doc.createElement('li');
        option.id = 'city-option-' + index;
        option.dataset.index = String(index);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === active));
        var name = doc.createElement('span');
        name.className = 'city-option-name';
        name.textContent = location.name;
        var meta = doc.createElement('span');
        meta.className = 'city-option-meta';
        meta.textContent = SS.citySearch.detail(location);
        option.append(name, meta);
        list.append(option);
      });
      status.textContent = message || items.warning || (items.length ? '可点击候选城市；直接搜索使用第一项。' : SS.citySearch.hint(text()));
      panel.hidden = !wantOpen;
      input.setAttribute('aria-expanded', String(wantOpen));
      if (wantOpen && active >= 0) input.setAttribute('aria-activedescendant', 'city-option-' + active);
      else input.removeAttribute('aria-activedescendant');
    }
    function invalidate() {
      generation++;
      clearTimeout(timer);
      if (controller) controller.abort();
      controller = null;
      pending = null;
      readyQuery = null;
      selected = null;
      items = [];
      active = -1;
      submitting = false;
      input.setAttribute('aria-busy', 'false');
    }
    function load() {
      clearTimeout(timer);
      var query = text();
      if (readyQuery === query && !items.partial) { render(); return Promise.resolve(items); }
      if (pending && pending.query === query) return pending.promise;
      var revision = generation;
      var request = new AbortController();
      controller = request;
      input.setAttribute('aria-busy', 'true');
      render('正在匹配城市…');
      var promise = SS.citySearch.search(query, { signal: request.signal }).then(function (found) {
        if (generation !== revision || text() !== query || request.signal.aborted) return null;
        items = found;
        readyQuery = query;
        active = -1;
        render();
        return found;
      }).catch(function (error) {
        if (generation !== revision || request.signal.aborted) return null;
        items = [];
        readyQuery = null;
        render('城市检索暂时失败，请点击搜索重试。' + (error.name === 'TimeoutError' ? '（请求超时）' : ''));
        return null;
      }).finally(function () {
        if (controller === request) {
          controller = null;
          pending = null;
          input.setAttribute('aria-busy', 'false');
        }
      });
      pending = { query: query, promise: promise };
      return promise;
    }
    function choose(location) {
      var resolved = SS.citySearch.toLocation(location);
      if (!resolved) return;
      invalidate();
      input.value = SS.citySearch.label(resolved);
      selected = { text: text(), location: resolved };
      close();
      input.blur(); // Dismiss the mobile keyboard after a deliberate selection.
      return onSearch(resolved.name, resolved);
    }
    async function submit() {
      if (composing || compositionJustEnded || submitting || !text()) return;
      if (selected && selected.text === text()) return choose(selected.location);
      var query = text();
      if (SS.prediction.parseCoordinates(query)) {
        invalidate(); close(); input.blur();
        return onSearch(query);
      }
      wantOpen = true;
      submitting = true;
      var revision = generation;
      var found = await load();
      if (generation !== revision || text() !== query) return;
      submitting = false;
      if (found && found.length && !found.requiresSelection) return choose(found[0]);
    }
    function onInput() {
      invalidate();
      if (composing || !text()) { close(); return; }
      wantOpen = true;
      if (SS.prediction.parseCoordinates(text())) { render('点击搜索，按输入的经纬度预测。'); return; }
      render('输入城市名称，稍候显示候选…');
      timer = setTimeout(load, SS.config.citySearch.debounceMs);
    }
    input.addEventListener('compositionstart', function () { composing = true; invalidate(); close(); });
    input.addEventListener('compositionend', function () {
      composing = false;
      compositionJustEnded = true;
      setTimeout(function () { compositionJustEnded = false; }, 0);
      onInput();
    });
    input.addEventListener('input', onInput);
    input.addEventListener('focus', function () {
      if (text() && !selected && !composing) { wantOpen = true; load(); }
    });
    input.addEventListener('keydown', function (event) {
      if (event.isComposing || composing || event.keyCode === 229) {
        if (event.key === 'Enter') event.preventDefault();
        return;
      }
      if (event.key === 'Escape' || event.key === 'Tab') { close(); return; }
      if (event.key === 'Enter' && !panel.hidden && active >= 0) {
        event.preventDefault(); choose(items[active]); return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        wantOpen = true;
        if (!items.length) { load(); return; }
        active = event.key === 'ArrowDown' ? (active + 1) % items.length : (active <= 0 ? items.length - 1 : active - 1);
        render();
        var option = doc.getElementById('city-option-' + active);
        if (option) option.scrollIntoView({ block: 'nearest' });
      }
    });
    // Mouse focus stays in the combobox; touch selection uses click, not touchstart,
    // so scrolling the list cannot accidentally start a prediction.
    list.addEventListener('pointerdown', function (event) { if (event.pointerType === 'mouse') event.preventDefault(); });
    list.addEventListener('click', function (event) {
      var option = event.target.closest('[role="option"]');
      if (option && list.contains(option) && readyQuery === text()) choose(items[Number(option.dataset.index)]);
    });
    doc.addEventListener('pointerdown', function (event) { if (!field.contains(event.target)) close(); });
    doc.addEventListener('focusin', function (event) { if (!field.contains(event.target)) close(); });
    form.addEventListener('submit', function (event) { event.preventDefault(); submit(); });
    return { submit: submit, close: close, setQuery: function (query) { invalidate(); input.value = query; return submit(); } };
  }
  SS.citySearchUi = { init: init };
})(typeof window !== 'undefined' ? window : globalThis);
