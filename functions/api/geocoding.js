import { handleGeo } from '../../server/qweather-geo.js';

export function onRequest(context) {
  return handleGeo(context.request, context.env);
}
