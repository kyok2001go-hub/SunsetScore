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
      var data;
      try {
        data = await response[options.responseType || 'json']();
      } catch (error) {
        throwIfAborted(signal);
        if (response.ok || !options.allowHttpError) throw error;
        data = {};
      }
      throwIfAborted(signal);
      if (!response.ok && !options.allowHttpError) {
        var error = failure('HttpError', '请求失败（HTTP ' + response.status + '）');
        error.status = response.status;
        throw error;
      }
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

  SS.network = {
    run: run, request: request, sleep: sleep, loadImage: loadImage,
    throwIfAborted: throwIfAborted,
    json: function (url, options) {
      return request(url, options).then(function (result) { return result.data; });
    },
    text: function (url, options) {
      return request(url, Object.assign({}, options, { responseType: 'text' }))
        .then(function (result) { return result.data; });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
