/* Request-scoped cancellation, deadlines (including body reads), and retry delays. */
(function (root) {
  'use strict';
  var SS = root.SunsetScore = root.SunsetScore || {};

  function failure(name, message) {
    var error = new Error(message);
    error.name = name;
    return error;
  }
  function abortReason(signal) {
    return signal.reason instanceof Error ? signal.reason : failure('AbortError', '查询已取消');
  }
  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortReason(signal);
  }

  async function run(operation, options) {
    options = options || {};
    var parent = options.signal;
    throwIfAborted(parent);
    var controller = new AbortController();
    var timeoutMs = options.timeoutMs == null ? SS.modelConfig.network.requestTimeoutMs : options.timeoutMs;
    var timer;
    var rejectAbort;
    var aborted = new Promise(function (_, reject) { rejectAbort = reject; });
    function onAbort() { rejectAbort(abortReason(controller.signal)); }
    function onParentAbort() { controller.abort(abortReason(parent)); }
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (parent) parent.addEventListener('abort', onParentAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(function () {
      controller.abort(failure('TimeoutError', '请求超时，请稍后重试'));
    }, timeoutMs);
    try {
      // The race also bounds non-conforming/mock transports that ignore AbortSignal.
      return await Promise.race([Promise.resolve().then(function () {
        throwIfAborted(controller.signal);
        return operation(controller.signal);
      }), aborted]);
    } catch (error) {
      controller.abort(error); // Stop siblings when a composite operation fails.
      throw error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (parent) parent.removeEventListener('abort', onParentAbort);
    }
  }

  function request(url, options) {
    options = options || {};
    return run(async function (signal) {
      var response = await fetch(url, Object.assign({}, options.init, { signal: signal }));
      throwIfAborted(signal);
      // HTTP failures need not contain JSON (edge 502 pages often do not).
      // Preserve the status without persisting arbitrary error bodies or URLs.
      if (!response.ok && !options.allowHttpError) {
        var httpError = failure('HttpError', '请求失败（HTTP ' + response.status + '）');
        httpError.status = response.status;
        httpError.requestId = response.headers && response.headers.get('cf-ray');
        if (response.body) response.body.cancel().catch(function () {});
        throw httpError;
      }
      var data;
      try {
        data = await response[options.responseType || 'json']();
      } catch (error) {
        throwIfAborted(signal);
        if (response.ok) {
          if (error.name !== 'SyntaxError') throw error;
          var parseError = failure('ParseError', '响应不是有效的 JSON');
          parseError.status = response.status;
          throw parseError;
        }
        data = {};
      }
      throwIfAborted(signal);
      return { response: response, data: data };
    }, options);
  }

  function sleep(ms, options) {
    var signal = options && options.signal;
    return new Promise(function (resolve, reject) {
      function clean() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', cancel); }
      function cancel() { clean(); reject(abortReason(signal)); }
      var timer = setTimeout(function () { clean(); resolve(); }, ms);
      if (signal) {
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }
    });
  }

  function loadImage(url, options) {
    return run(function (signal) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        function clean() {
          img.onload = img.onerror = null;
          signal.removeEventListener('abort', cancel);
        }
        function cancel() { clean(); img.src = ''; reject(abortReason(signal)); }
        img.onload = function () { clean(); resolve(img); };
        img.onerror = function () { clean(); reject(failure('ImageError', '瓦片加载失败')); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        else img.src = url;
      });
    }, Object.assign({ timeoutMs: SS.modelConfig.network.tileTimeoutMs }, options));
  }

  /* V2.5.5.20 Open-Meteo：先直连，失败（超时、网络错误、非 JSON、HTTP 5xx）后改走本站 /api/open-meteo 转发。
     HTTP 4xx 与用户取消不回退。某个域名直连失败后，本页面 stickyMinutes 内对它直接走转发；只存内存，不写 LocalStorage。
     options.openMeteoRoute：'AUTO'（默认，直连失败即转发）、'PRIMARY'（只发一次：直连，或会话记忆生效时转发）、'PROXY'（只走转发）。
     options.onTransport(kind)：成功后报告实际路径 'DIRECT' / 'PROXY'。依据：ref_docs/PRD/V2.5.5.20--Open-Meteo请求超时修复方案.md */
  var OPEN_METEO_HOSTS = { 'api.open-meteo.com': 'forecast', 'air-quality-api.open-meteo.com': 'air-quality', 'geocoding-api.open-meteo.com': 'geocoding' };
  var directFailedAt = {};
  function openMeteoRoute(url) {
    var parsed;
    try { parsed = new URL(url); } catch (e) { return null; }
    var service = parsed.protocol === 'https:' && Object.prototype.hasOwnProperty.call(OPEN_METEO_HOSTS, parsed.hostname) ? OPEN_METEO_HOSTS[parsed.hostname] : null;
    if (!service) return null;
    return { host: parsed.hostname, service: service,
      proxyUrl: SS.transport.openMeteo.proxyPath + '?service=' + service + (parsed.search ? '&' + parsed.search.slice(1) : '') };
  }
  function stickyActive(host) {
    var at = directFailedAt[host];
    return at != null && Date.now() - at < SS.transport.openMeteo.stickyMinutes * 60000;
  }
  function shouldFallBack(error, signal) {
    if (signal && signal.aborted) return false;
    if (!error || error.name === 'AbortError') return false;
    if (error.name === 'HttpError') return !(error.status >= 400 && error.status < 500);
    return true;
  }
  async function openMeteoJson(url, options) {
    options = options || {};
    var route = openMeteoRoute(url);
    if (!route) return requestJson(url, options);
    var mode = options.openMeteoRoute || 'AUTO', report = typeof options.onTransport === 'function' ? options.onTransport : null;
    if (mode !== 'PROXY' && !stickyActive(route.host)) {
      try {
        var direct = await requestJson(url, options);
        if (report) report('DIRECT');
        return direct;
      } catch (error) {
        if (!shouldFallBack(error, options.signal)) throw error;
        directFailedAt[route.host] = Date.now();
        if (mode === 'PRIMARY') throw error;
      }
    }
    var relayed = await requestJson(route.proxyUrl, Object.assign({}, options, { timeoutMs: SS.transport.openMeteo.proxyTimeoutMs }));
    if (report) report('PROXY');
    return relayed;
  }
  function requestJson(url, options) {
    return request(url, options).then(function (result) { return result.data; });
  }

  SS.network = {
    run: run, request: request, sleep: sleep, loadImage: loadImage,
    openMeteoJson: openMeteoJson, openMeteoRoute: openMeteoRoute,
    resetOpenMeteoRoutes: function () { directFailedAt = {}; },
    throwIfAborted: throwIfAborted,
    json: requestJson,
    text: function (url, options) {
      return request(url, Object.assign({}, options, { responseType: 'text' }))
        .then(function (result) { return result.data; });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
