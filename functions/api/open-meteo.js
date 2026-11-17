/**
 * SunsetScore V2.5.5.20 - Open-Meteo fallback relay (GET /api/open-meteo?service=forecast|air-quality|geocoding&...).
 * Used only after a direct browser request to Open-Meteo fails. Fixed upstreams and an allowlist of parameters;
 * successful responses are kept in the edge cache (caches.default; a no-op on *.pages.dev).
 */
import { handleOpenMeteo } from '../../server/open-meteo-proxy.js';

export function onRequest(context) {
  let cache = null;
  try { cache = globalThis.caches?.default ?? null; } catch { cache = null; }
  return handleOpenMeteo(context.request, { cache, waitUntil: typeof context.waitUntil === 'function' ? p => context.waitUntil(p) : null });
}
