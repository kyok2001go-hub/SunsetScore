// Shared by Pages Functions and the local server. No request state lives at module scope.
export async function fetchWithDeadline(input, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const parent = options.signal ?? init.signal;
  const controller = new AbortController();
  let reader, streamController, finished = false, timer, rejectAbort;
  const abortError = () => controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  function cleanup() {
    finished = true;
    clearTimeout(timer);
    parent?.removeEventListener('abort', parentAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
  function parentAbort() { controller.abort(parent.reason); }
  function onAbort() {
    const error = abortError();
    rejectAbort(error);
    if (streamController && !finished) streamController.error(error);
    cleanup();
    // Cancellation is observed; the upstream transport is also aborted by fetch's signal.
    return reader?.cancel(error).catch(() => {});
  }
  controller.signal.addEventListener('abort', onAbort, { once: true });
  parent?.addEventListener('abort', parentAbort, { once: true });
  if (parent?.aborted) parentAbort();
  else timer = setTimeout(() => controller.abort(new DOMException('Upstream timeout', 'TimeoutError')), timeoutMs);
  try {
    const response = await Promise.race([
      Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const result = await fetch(input, { ...init, signal: controller.signal });
        if (controller.signal.aborted) {
          await result.body?.cancel().catch(() => {});
          throw abortError();
        }
        return result;
      }), aborted
    ]);
    if (!response.body) { cleanup(); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream({
      start(stream) { streamController = stream; },
      async pull(stream) {
        try {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) { cleanup(); stream.close(); }
          else stream.enqueue(chunk.value);
        } catch (error) {
          if (!finished) { cleanup(); stream.error(error); }
        }
      },
      async cancel(reason) {
        cleanup();
        controller.abort(reason);
        await reader.cancel(reason).catch(() => {});
      }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    cleanup();
    controller.abort(error);
    throw error;
  }
}
