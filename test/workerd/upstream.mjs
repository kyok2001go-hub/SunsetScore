// All global fetches from the adapters are routed here by redirect.capnp.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const qweather = url.hostname.endsWith('.qweatherapi.com');
    if (qweather) {
      if (request.headers.get('X-QW-Api-Key') !== 'test-secret-only') throw new Error('Missing test credential');
      if (url.searchParams.get('location') !== '114.06,22.54') throw new Error('Incorrect coordinates');
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
    if (qweather) return Response.json({ code: '200', minutely: [{ precip: '0.1' }] });
    return new Response(new Uint8Array([137, 80, 78, 71, 0, 255]), { headers: { 'Content-Type': 'image/png' } });
  }
};
