import { createEdgeErrorLogger } from './edge-log.js';
import { gcj02ToWgs84 } from './geo-coordinates.js';

const MAX_BODY_BYTES = 128 * 1024;
const DEADLINE_MS = 8000;

function reply(data, status = 200, cache = false) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache ? 'public, max-age=300, s-maxage=3600' : 'no-store',
    'X-Content-Type-Options': 'nosniff'
  } });
}

export function geoQuery(url) {
  const query = (url.searchParams.get('q') || '').normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/，/g, ',');
  const parts = query.split(',').map(part => part.trim());
  // Only a bounded city keyword + optional administrative qualifier. No URL, ID or coordinates.
  if (query.length > 60 || parts.length > 2 || parts[0].length < 2 ||
      parts.some(part => !part || !/^[\p{L}\p{M}\s.'’·-]+$/u.test(part))) return null;
  return { location: parts[0], adm: parts[1] || '' };
}

async function boundedJson(response) {
  if (!response.body) throw new SyntaxError('Empty payload');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError('Payload too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

function finiteNumber(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
}

export function geoLocation(row) {
  if (!row || row.type !== 'city' || typeof row.id !== 'string' || !/^[a-z0-9]{1,32}$/i.test(row.id) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100 ||
      !['中国', 'China'].includes(row.country) || /香港|澳门|澳門|台湾|臺灣|台灣|Hong Kong|Macao|Macau|Taiwan/i.test(row.adm1 || '')) return null;
  const latitude = finiteNumber(row.lat), longitude = finiteNumber(row.lon);
  const position = gcj02ToWgs84(latitude, longitude);
  if (!position || typeof row.tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en', { timeZone: row.tz }); } catch { return null; }
  const safeText = value => typeof value === 'string' ? value.slice(0, 100) : '';
  const rank = finiteNumber(row.rank);
  return { id: 'qweather:' + row.id, source: 'qweather', name: row.name.trim(),
    country: '中国', country_code: 'CN', admin1: safeText(row.adm1), admin2: safeText(row.adm2),
    ...position, timezone: row.tz, feature_code: 'QW_CITY', population: 0,
    rank: rank != null && rank >= 1 && rank <= 100 ? rank : 100,
    coordinate_system: 'WGS84', original_coordinate_system: 'GCJ-02' };
}

// Shared by Pages and the local server; no filesystem or Node dependency here.
export async function handleGeo(request, env) {
  const logError = createEdgeErrorLogger(request, 'geocoding');
  let stage = 'validation', upstreamStatus = null;
  const fail = (errorCode, status, error, businessCode = null) => {
    logError({ source: 'qweather', stage, errorCode, upstreamStatus, responseStatus: status, error });
    return reply({ error: '国内城市检索暂时不可用，请稍后重试', errorCode, upstreamStatus, businessCode }, status);
  };
  if (request.method !== 'GET') return reply({ error: 'Method Not Allowed' }, 405);
  const query = geoQuery(new URL(request.url));
  if (!query) return fail('INVALID_QUERY', 400);
  stage = 'configuration';
  if (!env.QWEATHER_API_KEY) return fail('NOT_CONFIGURED', 503);
  // Never allow caller-selected paths/hosts, credentials in URLs, or redirected key forwarding.
  const host = env.QWEATHER_HOST;
  if (typeof host !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+qweatherapi\.com$/i.test(host)) return fail('INVALID_TARGET', 503);
  const upstream = new URL(`https://${host}/geo/v2/city/lookup`);
  upstream.search = new URLSearchParams({ location: query.location, range: 'cn', number: '20', lang: 'zh' }).toString();
  if (query.adm) upstream.searchParams.set('adm', query.adm);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DEADLINE_MS);
  try {
    stage = 'fetch';
    const response = await fetch(upstream, { headers: { 'X-QW-Api-Key': env.QWEATHER_API_KEY },
      redirect: 'manual', signal: controller.signal });
    upstreamStatus = response.status;
    stage = 'upstream_response';
    if (upstreamStatus >= 300 && upstreamStatus < 400) {
      await response.body?.cancel();
      return fail('UPSTREAM_REDIRECT', 502);
    }
    // Preserve HTTP errors, but distinguish QWeather's documented no-location response.
    if (!response.ok && upstreamStatus !== 400) {
      await response.body?.cancel();
      return fail('UPSTREAM_HTTP_ERROR', upstreamStatus);
    }
    stage = 'body_parse';
    const data = await boundedJson(response);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (upstreamStatus === 400 && typeof data?.error?.title === 'string' &&
        data.error.title.toUpperCase().replace(/ /g, '_') === 'NO_SUCH_LOCATION') return reply({ results: [] });
    if (!response.ok) return fail('UPSTREAM_HTTP_ERROR', upstreamStatus);
    const code = String(data?.code || '');
    // Legacy GeoAPI reports no-match as business code 404 inside HTTP200.
    if (code === '404') return reply({ results: [] });
    if (code !== '200') return fail('UPSTREAM_BUSINESS_ERROR', 502, undefined, /^\d{3}$/.test(code) ? code : null);
    if (!Array.isArray(data.location)) return fail('INVALID_PAYLOAD', 502);
    const results = data.location.slice(0, 20).map(geoLocation).filter(Boolean);
    return reply({ results, source: 'qweather' }, 200, results.length > 0);
  } catch (error) {
    return fail(timedOut ? 'UPSTREAM_TIMEOUT' : controller.signal.aborted ? 'UPSTREAM_ABORTED'
      : stage === 'fetch' ? 'UPSTREAM_FETCH_ERROR' : 'INVALID_PAYLOAD', timedOut ? 504 : 502, error);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
  }
}
