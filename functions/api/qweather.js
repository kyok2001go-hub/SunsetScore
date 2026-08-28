/**
 * SunsetScore V2.3 - QWeather secret-preserving edge adapter.
 * Bind QWEATHER_API_KEY as a Pages secret. QWEATHER_HOST is optional.
 */

import { createEdgeErrorLogger, exceptionCode } from '../../server/edge-log.js';

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
  const logError = createEdgeErrorLogger(request, 'qweather');
  if (!env.QWEATHER_API_KEY) {
    logError({ source: 'qweather', stage: 'configuration', errorCode: 'NOT_CONFIGURED', responseStatus: 503 });
    return response({ error: 'QWeather is not configured' }, 503);
  }

  const url = new URL(request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    logError({ source: 'qweather', stage: 'validation', errorCode: 'INVALID_COORDINATES', responseStatus: 400 });
    return response({ error: 'Invalid coordinates' }, 400);
  }

  const host = env.QWEATHER_HOST || 'nn33jrmyy9.re.qweatherapi.com';
  const upstream = new URL(`https://${host}/v7/minutely/5m`);
  upstream.searchParams.set('location', `${lon.toFixed(2)},${lat.toFixed(2)}`);

  let stage = 'fetch';
  let upstreamStatus = null;
  try {
    // Restore the V2.3.1 native body forwarding path. Do not wrap the edge stream.
    // Browser deadlines remain active; server/network.js is local-server-only for now.
    const upstreamResponse = await fetch(upstream, {
      // The deployed Pages runtime rejects redirect:'error' before any request.
      // Manual mode keeps the secret on this host; reject 3xx below, never follow.
      headers: { 'X-QW-Api-Key': env.QWEATHER_API_KEY }, redirect: 'manual'
    });
    upstreamStatus = upstreamResponse.status;
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      stage = 'body_cancel';
      await upstreamResponse.body?.cancel();
      logError({ source: 'qweather', stage: 'upstream_response', errorCode: 'UPSTREAM_REDIRECT', upstreamStatus, responseStatus: 502 });
      return response({ error: 'QWeather upstream 3xx rejected', upstreamStatus: upstreamResponse.status }, 502);
    }
    if (!upstreamResponse.ok) {
      stage = 'body_cancel';
      await upstreamResponse.body?.cancel();
      logError({ source: 'qweather', stage: 'upstream_response', errorCode: 'UPSTREAM_HTTP_ERROR', upstreamStatus, responseStatus: upstreamStatus });
      return response({ error: 'QWeather upstream failed' }, upstreamResponse.status);
    }
    stage = 'response_forward';
    return new Response(upstreamResponse.body, {
      status: 200,
      headers: {
        'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300, s-maxage=600'
      }
    });
  } catch (error) {
    logError({ source: 'qweather', stage, errorCode: exceptionCode(error, stage), error,
      upstreamStatus, responseStatus: error.name === 'TimeoutError' ? 504 : 502 });
    return response({ error: error.name === 'TimeoutError' ? 'QWeather upstream timeout' : 'QWeather upstream unavailable' }, error.name === 'TimeoutError' ? 504 : 502);
  }
}
