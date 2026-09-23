// Page routing stays inside the authenticated /admin middleware boundary.
const PAGES = Object.freeze({
  '/admin/backfill': true,
  '/admin/snapshot': true,
  '/admin/observation': true
});

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (path === '/admin/backfill.html') {
    return Response.redirect(new URL('/admin/backfill', url), 301);
  }
  if (!PAGES[path]) return new Response('Not Found', { status: 404 });
  // ASSETS.fetch expects the pretty path for /admin/<page>.html.
  return context.env.ASSETS.fetch(new URL(path, url));
}
