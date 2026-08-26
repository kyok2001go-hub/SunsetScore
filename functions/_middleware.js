/** Prevent accidental publication of local secret files on Cloudflare Pages. */
export async function onRequest(context) {
  const pathname = new URL(context.request.url).pathname.toLowerCase();
  if (pathname === '/qweatherkey.txt' || pathname.startsWith('/.dev.vars') || pathname.startsWith('/.env')) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' }
    });
  }
  return context.next();
}

