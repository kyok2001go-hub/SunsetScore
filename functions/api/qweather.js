import { fetchWithDeadline } from '../../server/network.js';
/**
 * SunsetScore V2.3 - QWeather secret-preserving edge adapter.
 * Bind QWEATHER_API_KEY as a Pages secret. QWEATHER_HOST is optional.
 */

function response(data, status = 200) {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': status === 200 ? 'public, max-age=300, s-maxage=600' : 'no-store'
    }
  });
}

export async function onRequestGet(context) {
  const request = context.request;
  const env = context.env;
  if (!env.QWEATHER_API_KEY) return response({ error: 'QWeather is not configured' }, 503);

  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return response({ error: 'Invalid coordinates' }, 400);
  }

  const host = env.QWEATHER_HOST || 'nn33jrmyy9.re.qweatherapi.com';
  const upstream = new URL(`https://${host}/v7/minutely/5m`);
  upstream.searchParams.set('location', `${lon.toFixed(2)},${lat.toFixed(2)}`);

  try {
    const upstreamResponse = await fetchWithDeadline(upstream, {
      headers: { 'X-QW-Api-Key': env.QWEATHER_API_KEY }, redirect: 'error'
    }, { signal: request.signal });
    if (!upstreamResponse.ok) {
      await upstreamResponse.body?.cancel();
      return response({ error: 'QWeather upstream failed' }, upstreamResponse.status);
    }
    return new Response(upstreamResponse.body, {
      status: 200,
      headers: {
        'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300, s-maxage=600'
      }
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'qweather upstream failed', error: error instanceof Error ? error.message : String(error) }));
    return response({ error: error.name === 'TimeoutError' ? 'QWeather upstream timeout' : 'QWeather upstream unavailable' }, error.name === 'TimeoutError' ? 504 : 502);
  }
}
