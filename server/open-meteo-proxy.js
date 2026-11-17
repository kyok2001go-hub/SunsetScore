/**
 * V2.5.5.20 Open-Meteo fallback relay, shared by the Pages Function (functions/api/open-meteo.js) and the local dev server.
 * The browser calls Open-Meteo directly first and only uses this relay when the direct request fails.
 * Only three fixed upstream endpoints and the parameters the app actually sends are accepted: this is not an open proxy.
 * PRD: ref_docs/PRD/V2.5.5.20--Open-Meteo请求超时修复方案.md
 */
import { createEdgeErrorLogger, logEdgeUsage, EDGE_APP_VERSION } from './edge-log.js';

export const UPSTREAM_DEADLINE_MS = 12000;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_COORDINATES = 40;
const MAX_QUERY_LENGTH = 4000;

const NUMBER_LIST = /^-?\d{1,3}(?:\.\d{1,6})?(?:,-?\d{1,3}(?:\.\d{1,6})?)*$/;
const VARIABLE_LIST = /^[a-z0-9_]{1,40}(?:,[a-z0-9_]{1,40}){0,39}$/;
const INTEGER = /^\d{1,3}$/;
const TIMEZONE = /^(?:auto|[A-Za-z]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){0,2})$/;
const FORECAST_PARAMS = Object.freeze({
  latitude: 'latitudes', longitude: 'longitudes', hourly: 'variables', minutely_15: 'variables',
  forecast_days: 'days', forecast_minutely_15: 'steps', timezone: 'timezone'
});
export const OPEN_METEO_SERVICES = Object.freeze({
  forecast: Object.freeze({ upstream: 'https://api.open-meteo.com/v1/forecast', params: FORECAST_PARAMS, coordinates: true, ttlSeconds: 600 }),
  'air-quality': Object.freeze({ upstream: 'https://air-quality-api.open-meteo.com/v1/air-quality',
    params: Object.freeze({ latitude: 'latitudes', longitude: 'longitudes', hourly: 'variables', forecast_days: 'days', timezone: 'timezone' }), coordinates: true, ttlSeconds: 600 }),
  geocoding: Object.freeze({ upstream: 'https://geocoding-api.open-meteo.com/v1/search',
    params: Object.freeze({ name: 'name', count: 'count', language: 'language', format: 'format' }), coordinates: false, ttlSeconds: 86400 })
});

function validValue(kind, value) {
  switch (kind) {
    case 'latitudes': case 'longitudes': return NUMBER_LIST.test(value);
    case 'variables': return VARIABLE_LIST.test(value);
    case 'days': return INTEGER.test(value) && Number(value) >= 1 && Number(value) <= 16;
    case 'steps': return INTEGER.test(value) && Number(value) >= 1 && Number(value) <= 192;
    case 'count': return INTEGER.test(value) && Number(value) >= 1 && Number(value) <= 100;
    case 'timezone': return TIMEZONE.test(value);
    case 'language': return /^[a-z]{2}$/.test(value);
    case 'format': return value === 'json';
    case 'name': return value.trim().length >= 1 && value.length <= 100 && !/[\u0000-\u001f]/.test(value);
    default: return false;
  }
}

/**
 * Validates the relay query and returns the canonical upstream URL (parameters sorted, so the cache key does not depend
 * on their order), or null when anything is outside the allowlist.
 */
export function openMeteoTarget(requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  if (url.search.length > MAX_QUERY_LENGTH) return null;
  const service = OPEN_METEO_SERVICES[url.searchParams.get('service')];
  if (!service || url.searchParams.getAll('service').length !== 1) return null;
  const params = [];
  for (const name of new Set(url.searchParams.keys())) {
    if (name === 'service') continue;
    const values = url.searchParams.getAll(name), kind = service.params[name];
    if (!kind || values.length !== 1 || !validValue(kind, values[0])) return null;
    params.push([name, values[0]]);
  }
  const get = name => params.find(p => p[0] === name)?.[1];
  if (service.coordinates) {
    const lat = get('latitude')?.split(','), lon = get('longitude')?.split(',');
    if (!lat || !lon || lat.length !== lon.length || lat.length > MAX_COORDINATES) return null;
    if (lat.some(v => Math.abs(Number(v)) > 90) || lon.some(v => Math.abs(Number(v)) > 180)) return null;
  } else if (!get('name')) return null;
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const upstream = new URL(service.upstream);
  for (const [name, value] of params) upstream.searchParams.append(name, value);
  return { service: url.searchParams.get('service'), upstream, ttlSeconds: service.ttlSeconds };
}

function reply(body, status, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store', ...headers } });
}

async function boundedText(response, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  const onAbort = () => reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError('Payload too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { signal.removeEventListener('abort', onAbort); }
}

/**
 * options.cache: a Cache API object (caches.default on Pages) or null; options.waitUntil: defers the cache write;
 * options.fetchImpl and options.deadlineMs exist for tests only.
 */
export async function handleOpenMeteo(request, options = {}) {
  const startedAt = Date.now(), logError = createEdgeErrorLogger(request, 'open-meteo');
  const fetchImpl = options.fetchImpl ?? fetch, deadlineMs = options.deadlineMs ?? UPSTREAM_DEADLINE_MS;
  let stage = 'validation', upstreamStatus = null, service = null;
  const usage = (cacheStatus, status) => logEdgeUsage(request, { adapter: 'open-meteo', service, cacheStatus, upstreamStatus, responseStatus: status, startedAt });
  if (request.method !== 'GET') return reply({ error: 'Method Not Allowed' }, 405, { Allow: 'GET' });
  const target = openMeteoTarget(new URL(request.url));
  if (!target) {
    logError({ source: 'openmeteo', stage, errorCode: 'INVALID_QUERY', responseStatus: 400 });
    return reply({ error: 'Invalid Open-Meteo relay query' }, 400);
  }
  service = target.service;
  // Cache key on this origin: the canonical upstream query, independent of parameter order.
  const cacheKey = new Request(new URL('/api/open-meteo/__cache?' + target.upstream.searchParams.toString() + '&service=' + service, request.url).toString());
  if (options.cache) {
    try {
      const hit = await options.cache.match(cacheKey);
      if (hit) { usage('HIT', 200); return new Response(hit.body, { status: 200, headers: hit.headers }); }
    } catch { /* The edge cache is an optimisation; a failure must not break the relay. */ }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Upstream timeout', 'TimeoutError')), deadlineMs);
  stage = 'fetch';
  try {
    // Pages runtime compatibility: inspect 3xx ourselves instead of redirect:'error'; never follow or expose Location.
    const upstreamResponse = await fetchImpl(target.upstream.toString(), {
      redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': `SunsetScore-Relay/${EDGE_APP_VERSION} (Cloudflare Edge)` }
    });
    upstreamStatus = upstreamResponse.status;
    if (upstreamStatus >= 300 && upstreamStatus < 400) {
      stage = 'body_cancel';
      await upstreamResponse.body?.cancel();
      logError({ source: 'openmeteo', stage: 'upstream_response', errorCode: 'UPSTREAM_REDIRECT', upstreamStatus, responseStatus: 502 });
      usage('BYPASS', 502);
      return reply({ error: 'Open-Meteo upstream 3xx rejected', upstreamStatus }, 502);
    }
    stage = 'response_forward';
    const text = await boundedText(upstreamResponse, controller.signal);
    if (!upstreamResponse.ok) {
      logError({ source: 'openmeteo', stage: 'upstream_response', errorCode: 'UPSTREAM_HTTP_ERROR', upstreamStatus, responseStatus: upstreamStatus });
      usage('BYPASS', upstreamStatus);
      // Upstream 4xx/5xx keep their status (the browser does not fall back again on 4xx); the body is Open-Meteo's own JSON error.
      return reply(text || JSON.stringify({ error: 'Open-Meteo upstream error', upstreamStatus }), upstreamStatus);
    }
    stage = 'body_parse';
    JSON.parse(text);
    const headers = { 'Cache-Control': `public, max-age=${Math.min(300, target.ttlSeconds)}, s-maxage=${target.ttlSeconds}`, 'X-Relay-By': 'SunsetScore-Open-Meteo-Relay' };
    if (options.cache) {
      const write = options.cache.put(cacheKey, reply(text, 200, headers)).catch(() => {});
      if (options.waitUntil) options.waitUntil(write); else await write;
    }
    usage('MISS', 200);
    return reply(text, 200, headers);
  } catch (error) {
    const timeout = controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError';
    const status = timeout ? 504 : 502;
    logError({ source: 'openmeteo', stage, errorCode: timeout ? 'UPSTREAM_TIMEOUT' : stage === 'body_parse' ? 'INVALID_PAYLOAD'
      : stage === 'fetch' ? 'UPSTREAM_FETCH_ERROR' : 'RESPONSE_ERROR', error, upstreamStatus, responseStatus: status });
    usage('BYPASS', status);
    return reply({ error: timeout ? 'Open-Meteo upstream timeout' : 'Open-Meteo upstream unavailable', errorCode: timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', upstreamStatus }, status);
  } finally { clearTimeout(timer); }
}
