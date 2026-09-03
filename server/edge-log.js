/** Request-scoped, allowlisted diagnostics. Never serialize an Error or Request. */
export const EDGE_APP_VERSION = '2.4.1';

const SOURCES = ['qweather', 'rainviewer', 'gibs', 'openmeteo'];
const STAGES = ['configuration', 'validation', 'fetch', 'upstream_response', 'body_cancel', 'response_forward', 'body_parse'];
const ERROR_CODES = ['NOT_CONFIGURED', 'INVALID_COORDINATES', 'MISSING_TARGET', 'INVALID_TARGET',
  'FORBIDDEN_TARGET', 'UPSTREAM_REDIRECT', 'UPSTREAM_HTTP_ERROR', 'UPSTREAM_TIMEOUT',
  'UPSTREAM_ABORTED', 'UPSTREAM_FETCH_ERROR', 'RESPONSE_ERROR', 'INVALID_QUERY', 'INVALID_PAYLOAD', 'UPSTREAM_BUSINESS_ERROR'];
const ERROR_NAMES = ['Error', 'TypeError', 'TimeoutError', 'AbortError', 'RangeError', 'SyntaxError'];

function allowed(value, values) {
  return values.includes(value) ? value : 'unknown';
}

function statusOrNull(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function errorName(error) {
  if (error == null) return null;
  try { return allowed(error.name, ERROR_NAMES); } catch { return 'unknown'; }
}

export function sourceForHost(hostname) {
  for (const [suffix, source] of [['qweatherapi.com', 'qweather'], ['rainviewer.com', 'rainviewer'],
    ['earthdata.nasa.gov', 'gibs'], ['open-meteo.com', 'openmeteo']]) {
    if (hostname === suffix || hostname.endsWith('.' + suffix)) return source;
  }
  return 'unknown';
}

export function exceptionCode(error, stage) {
  if (stage !== 'fetch') return 'RESPONSE_ERROR';
  const name = errorName(error);
  return name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT'
    : name === 'AbortError' ? 'UPSTREAM_ABORTED' : 'UPSTREAM_FETCH_ERROR';
}

export function createEdgeErrorLogger(request, adapter) {
  const startedAt = Date.now();
  let emitted = false;
  return function logError(details) {
    // Diagnostic failures must never replace the adapter's response or cause retries.
    if (emitted) return;
    emitted = true;
    try {
      const ray = request.headers.get('cf-ray');
      const elapsed = Date.now() - startedAt;
      console.error({
        event: 'edge_proxy_error', logSchema: 1, appVersion: EDGE_APP_VERSION,
        adapter: allowed(adapter, ['qweather', 'proxy', 'geocoding']),
        source: allowed(details.source, SOURCES),
        stage: allowed(details.stage, STAGES),
        errorCode: allowed(details.errorCode, ERROR_CODES),
        errorName: errorName(details.error),
        upstreamStatus: statusOrNull(details.upstreamStatus),
        responseStatus: statusOrNull(details.responseStatus),
        elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null,
        cfRay: typeof ray === 'string' && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(ray) ? ray : null
      });
    } catch {
      // No fallback raw logging: it could expose the very data this helper excludes.
    }
  };
}
