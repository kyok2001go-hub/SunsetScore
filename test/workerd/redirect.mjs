import { onRequestGet as qweather } from '../../functions/api/qweather.js';
import { onRequestGet as proxy } from '../../functions/api/proxy.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function invoke(kind, status) {
  const request = new Request(kind === 'qweather'
    ? 'https://example.test/api/qweather?lat=22.54&lon=114.06'
    : 'https://example.test/api/proxy?url=' + encodeURIComponent(`https://tilecache.rainviewer.com/test.png?status=${status}`));
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
