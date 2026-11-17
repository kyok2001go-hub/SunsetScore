// All global fetches from the adapters are routed here by redirect.capnp.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // V2.5.5.20 Open-Meteo relay: latitude × 10 selects the upstream status (20 → 200, 30.2 → 302, 42.9 → 429, 50.3 → 503).
    if (url.hostname === 'api.open-meteo.com') {
      if (request.redirect !== 'manual') throw new Error('Open-Meteo relay must use manual redirects');
      const status = Math.round(Number(url.searchParams.get('latitude')) * 10);
      if (status >= 300 && status < 400) return new Response('must not expose this body', { status, headers: { Location: 'https://outside.test/private-destination' } });
      if (status >= 400) return Response.json({ error: true, reason: 'status ' + status }, { status });
      return Response.json({ latitude: 20, hourly: { time: ['2026-11-17T00:00'], cloud_cover: [10] } });
    }
    const qweather = url.hostname.endsWith('.qweatherapi.com');
    if (qweather) {
      if (request.headers.get('X-QW-Api-Key') !== 'test-secret-only') throw new Error('Missing test credential');
      if (url.pathname === '/geo/v2/city/lookup') {
        if (url.searchParams.get('range') !== 'cn' || url.searchParams.get('location') !== '许昌') throw new Error('Incorrect GeoAPI parameters');
      } else if (url.searchParams.get('location') !== '114.06,22.54') throw new Error('Incorrect coordinates');
    } else if (request.headers.has('X-QW-Api-Key')) {
      throw new Error('Generic proxy must not receive QWeather credentials');
    }
    const status = Number(qweather ? url.hostname.split('.')[0].slice(7) : url.searchParams.get('status'));
    if (status >= 300 && status < 400) {
      return new Response(status === 304 ? null : 'must not expose this body', {
        status, headers: { Location: 'https://outside.test/private-destination' }
      });
    }
    if (status >= 400) return new Response('unavailable', { status });
    if (url.pathname === '/geo/v2/city/lookup' && status === 204) return Response.json({ error: { title: 'No Such Location' } }, { status: 400 });
    if (url.pathname === '/geo/v2/city/lookup' && status === 205) return new Response('invalid JSON');
    if (url.pathname === '/geo/v2/city/lookup' && status === 206) {
      let timer;
      return new Response(new ReadableStream({
        start(controller) {
          // A real pending timer keeps this mock request alive; an inert stream is
          // correctly terminated by workerd's hung-request detector before 8s.
          timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }, 10000);
        },
        cancel() { clearTimeout(timer); }
      }));
    }
    if (url.pathname === '/geo/v2/city/lookup') return Response.json({ code: '200', location: [
      { id: '101180401', name: '许昌', lat: '34.03', lon: '113.85', adm1: '河南省', adm2: '许昌', country: '中国', tz: 'Asia/Shanghai', type: 'city', rank: '40' }
    ] });
    if (qweather) return Response.json({ code: '200', minutely: [{ precip: '0.1' }] });
    return new Response(new Uint8Array([137, 80, 78, 71, 0, 255]), { headers: { 'Content-Type': 'image/png' } });
  }
};
