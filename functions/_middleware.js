import {
  adminAuthResponse,
  authenticateAdminRequest,
  isAdminPath
} from '../server/admin-access.js';

function secureAdminResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/** Prevent secret publication and enforce the admin origin boundary. */
export async function handleRequest(context, authOptions = {}) {
  const pathname = new URL(context.request.url).pathname.toLowerCase();
  if (pathname === '/qweatherkey.txt' || pathname.startsWith('/.dev.vars') || pathname.startsWith('/.env')) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  if (!isAdminPath(pathname)) return context.next();
  const authenticated = await authenticateAdminRequest(context.request, context.env, authOptions);
  if (!authenticated.ok) return adminAuthResponse(authenticated);
  if (!context.data) context.data = {};
  context.data.adminActor = authenticated.actor;
  return secureAdminResponse(await context.next());
}

export async function onRequest(context) {
  return handleRequest(context);
}

