import { createRemoteJWKSet, jwtVerify } from 'jose';

export const ADMIN_HOST = 'admin.sunsetscore.ky-ok.com';

function privateHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  };
}

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function configuredTeamDomain(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    if (!url.hostname.toLowerCase().endsWith('.cloudflareaccess.com')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function claim(value, maxLength) {
  return typeof value === 'string' && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

export function isAdminPath(pathname) {
  const path = String(pathname || '').toLowerCase();
  return path === '/admin' || path.startsWith('/admin/') || path === '/api/admin' || path.startsWith('/api/admin/');
}

export async function authenticateAdminRequest(request, env = {}, options = {}) {
  let url;
  try { url = new URL(request.url); }
  catch { return failure(404, 'invalid_host', 'Not Found'); }
  if (url.host.toLowerCase() !== ADMIN_HOST) return failure(404, 'invalid_host', 'Not Found');

  const teamDomain = configuredTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audience = claim(env.CF_ACCESS_AUD, 200);
  if (!teamDomain || !audience) {
    return failure(503, 'access_not_configured', '管理员认证不可用');
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return failure(401, 'missing_access_token', '未认证');

  try {
    const jwksFactory = options.createRemoteJWKSet || createRemoteJWKSet;
    const verify = options.jwtVerify || jwtVerify;
    const jwks = jwksFactory(new URL(teamDomain + '/cdn-cgi/access/certs'));
    const verified = await verify(token, jwks, { issuer: teamDomain, audience });
    const payload = verified && verified.payload || {};
    const email = claim(payload.email, 320);
    const serviceName = claim(payload.common_name, 320);
    const subject = email || serviceName || claim(payload.sub, 320);
    if (!subject) return failure(403, 'invalid_access_identity', '无权访问');
    return {
      ok: true,
      actor: {
        type: email ? 'human' : 'service',
        subject,
        email
      }
    };
  } catch {
    return failure(403, 'invalid_access_token', '无权访问');
  }
}

export function adminAuthResponse(result) {
  const isNotFound = result && result.status === 404;
  if (isNotFound) {
    return new Response('Not Found', { status: 404, headers: privateHeaders('text/plain; charset=utf-8') });
  }
  return new Response(JSON.stringify({
    success: false,
    error: result && result.message || '无权访问',
    code: result && result.code || 'access_denied'
  }), {
    status: result && result.status || 403,
    headers: privateHeaders()
  });
}
