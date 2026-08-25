/**
 * Cloudflare Pages Functions - 跨域瓦片与气象接口安全边缘反向代理
 * 路由：GET /api/proxy?url=<ENCODED_URL>
 * 作用：解决 NASA GIBS / RainViewer / QWeather 等公开源偶尔缺少 CORS 头或被客户端网络阻断的问题
 */

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
  const urlObj = new URL(request.url);
  const targetUrlStr = urlObj.searchParams.get('url');

  if (!targetUrlStr) {
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
    return new Response(JSON.stringify({ error: 'Invalid target URL format' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /* 白名单安全校验，杜绝开放代理 (Open Proxy) 滥用风险 */
  if (!isHostAllowed(parsedTarget.hostname)) {
    return new Response(JSON.stringify({ error: `Forbidden: Host ${parsedTarget.hostname} is not in proxy whitelist` }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  /* 转发请求至上游源 */
  try {
    const upstreamRes = await fetch(parsedTarget.toString(), {
      headers: {
        'User-Agent': 'SunsetScore-Proxy/2.2.2 (Cloudflare Edge)'
      }
    });

    if (!upstreamRes.ok) {
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': upstreamRes.headers.get('content-type') || 'text/plain'
        }
      });
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
    return new Response(JSON.stringify({ error: 'Upstream fetch error: ' + err.message }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
