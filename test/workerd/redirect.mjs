import { onRequestGet as qweather } from '../../functions/api/qweather.js';
import { onRequestGet as proxy } from '../../functions/api/proxy.js';
import { onRequest as geocoding } from '../../functions/api/geocoding.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function invoke(kind, status) {
  const request = new Request(kind === 'qweather'
    ? 'https://example.test/api/qweather?lat=22.54&lon=114.06'
    : 'https://example.test/api/proxy?url=' + encodeURIComponent(`https://tilecache.rainviewer.com/test.png?status=${status}`),
  { headers: { 'cf-ray': '0123456789abcdef-HKG', authorization: 'Bearer test-secret-only' } });
  return (kind === 'qweather' ? qweather : proxy)({
    request, env: { QWEATHER_API_KEY: 'test-secret-only', QWEATHER_HOST: `status-${status}.qweatherapi.com` }
  });
}

export const successfulNativeFetch = {
  async test() {
    const response = await invoke('qweather', 200);
    check(response.status === 200, 'QWeather must succeed in workerd');
    const data = await response.json();
    check(data.code === '200' && data.minutely[0].precip === '0.1', 'QWeather body must survive native forwarding');
    const image = await invoke('proxy', 200);
    check(image.status === 200, 'Tile proxy must succeed in workerd');
    check(image.headers.get('Content-Type') === 'image/png', 'Keep image MIME type');
    check(Array.from(new Uint8Array(await image.arrayBuffer())).join(',') === '137,80,78,71,0,255', 'Keep binary bytes');
  }
};

export const geoApiNativeFetch = {
  async test() {
    for (const status of [200, 204, 205, 302, 401, 403, 429, 503]) {
      const response = await geocoding({ request: new Request('https://example.test/api/geocoding?q=' + encodeURIComponent('许昌')),
        env: { QWEATHER_API_KEY: 'test-secret-only', QWEATHER_HOST: `status-${status}.qweatherapi.com` } });
      check(response.status === (status === 204 ? 200 : [205, 302].includes(status) ? 502 : status), 'GeoAPI native fetch status');
      const data = await response.json();
      if (status === 200) {
        check(data.results[0].id === 'qweather:101180401', 'GeoAPI source namespace');
        check(data.results[0].latitude !== 34.03 && data.results[0].coordinate_system === 'WGS84', 'GeoAPI coordinate conversion');
      } else check(response.headers.get('Cache-Control') === 'no-store', 'GeoAPI errors must not be cached');
      if (status === 204) check(data.results.length === 0, 'Modern no-location is not an outage');
      check(!JSON.stringify(data).includes('test-secret-only'), 'GeoAPI must not expose key');
      check(!response.headers.has('Location'), 'GeoAPI never exposes redirect destination');
    }
  }
};

export const geoApiBodyDeadline = {
  async test() {
    const response = await geocoding({ request: new Request('https://example.test/api/geocoding?q=' + encodeURIComponent('许昌')),
      env: { QWEATHER_API_KEY: 'test-secret-only', QWEATHER_HOST: 'status-206.qweatherapi.com' } });
    check(response.status === 504, 'Native body read must be aborted by deadline');
    check((await response.json()).errorCode === 'UPSTREAM_TIMEOUT', 'Preserve timeout classification');
  }
};

export const rejectRedirects = {
  async test() {
    for (const kind of ['qweather', 'proxy']) {
      for (const status of [300, 301, 302, 303, 304, 307, 308]) {
        const response = await invoke(kind, status);
        check(response.status === 502, `${kind}: block upstream ${status}`);
        check(!response.headers.has('Location'), 'Never forward redirect destination');
        check(response.headers.get('Cache-Control') === 'no-store', 'Never cache rejection');
        const data = await response.json();
        check(data.upstreamStatus === status, 'Keep original 3xx status for diagnostics');
        check(!JSON.stringify(data).includes('test-secret-only'), 'Do not expose test credential');
        check(!JSON.stringify(data).includes('private-destination'), 'Do not expose redirect destination');
      }
    }
  }
};

export const preserveUpstreamErrors = {
  async test() {
    for (const kind of ['qweather', 'proxy']) {
      for (const status of [401, 403, 429, 503]) {
        const response = await invoke(kind, status);
        check(response.status === status, `${kind}: preserve upstream ${status}`);
        await response.body?.cancel();
      }
    }
  }
};

export const structuredErrorLogs = {
  async test() {
    const records = [];
    const originalError = console.error;
    console.error = (record) => records.push(record);
    try {
      for (const kind of ['qweather', 'proxy']) {
        for (const status of [200, 302, 429]) {
          const response = await invoke(kind, status);
          await response.body?.cancel();
        }
      }
      check(records.length === 4, 'One log per failure; no success logs');
      for (const record of records) {
        check(typeof record === 'object', 'Structured object, not raw message');
        check(record.event === 'edge_proxy_error' && record.appVersion === '2.3.9', 'Keep event/version');
        check(record.cfRay === '0123456789abcdef-HKG', 'Keep validated request correlation');
        check(record.stage === 'upstream_response', 'Keep failure stage');
        check(record.source === (record.adapter === 'qweather' ? 'qweather' : 'rainviewer'), 'Keep provider category');
        check(record.errorCode === (record.upstreamStatus === 302 ? 'UPSTREAM_REDIRECT' : 'UPSTREAM_HTTP_ERROR'), 'Keep error class');
        check(record.responseStatus === (record.upstreamStatus === 302 ? 502 : 429), 'Keep response status');
        check(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0, 'Keep bounded elapsed time');
        const text = JSON.stringify(record);
        for (const forbidden of ['test-secret-only', 'Bearer', 'https:', 'test.png', 'private-destination', '22.54', '114.06']) {
          check(!text.includes(forbidden), 'Sensitive values must not appear in custom logs');
        }
      }
    } finally {
      console.error = originalError;
    }
  }
};
