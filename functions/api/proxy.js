/**
 * Cloudflare Pages Functions - 跨域瓦片与气象接口安全边缘反向代理
 * 路由：GET /api/proxy?url=<ENCODED_URL>
 * 作用：解决 NASA GIBS / RainViewer / QWeather 等公开源偶尔缺少 CORS 头或被客户端网络阻断的问题
 */

import { createEdgeErrorLogger, exceptionCode, sourceForHost, EDGE_APP_VERSION } from '../../server/edge-log.js';

const ALLOWED_HOST_PATTERNS = [
  /^([a-z0-9-]+\.)*rainviewer\.com$/i,
  /^([a-z0-9-]+\.)*earthdata\.nasa\.gov$/i,
  /^([a-z0-9-]+\.)*qweatherapi\.com$/i,
  /^([a-z0-9-]+\.)*open-meteo\.com$/i
];

function isHostAllowed(hostname) {
  return ALLOWED_HOST_PATTERNS.some(p => p.test(hostname));
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const logError = createEdgeErrorLogger(request, 'proxy');
  const urlObj = new URL(request.url);
  const targetUrlStr = urlObj.searchParams.get('url');

  if (!targetUrlStr) {
    logError({ stage: 'validation', errorCode: 'MISSING_TARGET', responseStatus: 400 });
    return new Response(JSON.stringify({ error: 'Missing target URL parameter (?url=...)' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrlStr);
  } catch (e) {
    logError({ stage: 'validation', errorCode: 'INVALID_TARGET', responseStatus: 400 });
    return new Response(JSON.stringify({ error: 'Invalid target URL format' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /* 白名单安全校验，杜绝开放代理 (Open Proxy) 滥用风险 */
  if (parsedTarget.protocol !== 'https:' || !isHostAllowed(parsedTarget.hostname)) {
    logError({ stage: 'validation', errorCode: 'FORBIDDEN_TARGET', responseStatus: 403 });
    return new Response(JSON.stringify({ error: `Forbidden: Host ${parsedTarget.hostname} is not in proxy whitelist` }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /* 转发请求至上游源 */
  const source = sourceForHost(parsedTarget.hostname);
  let stage = 'fetch';
  let upstreamStatus = null;
  try {
    // Match the proven V2.3.1 native stream path; retain HTTPS/redirect restrictions.
    const upstreamRes = await fetch(parsedTarget.toString(), {
      // Pages runtime compatibility: inspect 3xx ourselves instead of redirect:'error'.
      redirect: 'manual',
      headers: {
        'User-Agent': `SunsetScore-Proxy/${EDGE_APP_VERSION} (Cloudflare Edge)`
      }
    });
    upstreamStatus = upstreamRes.status;

    // Do not follow a redirect outside the validated target or expose its Location.
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      stage = 'body_cancel';
      await upstreamRes.body?.cancel();
      logError({ source, stage: 'upstream_response', errorCode: 'UPSTREAM_REDIRECT', upstreamStatus, responseStatus: 502 });
      return new Response(JSON.stringify({ error: 'Upstream 3xx rejected', upstreamStatus: upstreamRes.status }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    }

    stage = 'response_forward';
    if (!upstreamRes.ok) {
      const result = new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': upstreamRes.headers.get('content-type') || 'text/plain'
        }
      });
      logError({ source, stage: 'upstream_response', errorCode: 'UPSTREAM_HTTP_ERROR', upstreamStatus, responseStatus: upstreamStatus });
      return result;
    }

    const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    const isImage = contentType.startsWith('image/');
    const cacheControl = isImage ? 'public, max-age=1800, s-maxage=3600' : 'public, max-age=300';

    const responseHeaders = new Headers();
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Cache-Control', cacheControl);
    responseHeaders.set('X-Proxy-By', 'SunsetScore-Cloudflare-Pages');

    return new Response(upstreamRes.body, {
      status: 200,
      headers: responseHeaders
    });
  } catch (err) {
    logError({ source, stage, errorCode: exceptionCode(err, stage), error: err,
      upstreamStatus, responseStatus: err.name === 'TimeoutError' ? 504 : 502 });
    return new Response(JSON.stringify({ error: 'Upstream fetch error: ' + err.message }), {
      status: err.name === 'TimeoutError' ? 504 : 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
