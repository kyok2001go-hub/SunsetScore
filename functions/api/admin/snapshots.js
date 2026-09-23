import { adminAuthResponse, authenticateAdminRequest } from '../../../server/admin-access.js';
import { ValidationError } from '../../../server/event-dataset.js';
import { parseAdminQuery, queryPagedRows } from '../../../server/admin-query.js';

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff', ...extra
  } });
}

export async function onRequest(context) {
  const auth = context.data?.adminActor
    ? { ok: true } : await authenticateAdminRequest(context.request, context.env);
  if (!auth.ok) return adminAuthResponse(auth);
  if (context.request.method !== 'GET') return json({ success: false, error: '仅支持 GET' }, 405, { Allow: 'GET' });
  if (!context.env?.DB) return json({ success: false, error: '数据库服务不可用' }, 503);
  try {
    return json(await queryPagedRows(context.env.DB, parseAdminQuery(context.request.url, 'snapshots')));
  } catch (error) {
    if (error instanceof ValidationError) return json({ success: false, error: error.message }, 400);
    console.error('[admin_snapshots] QUERY_FAILED');
    return json({ success: false, error: '数据查询暂时失败' }, 503);
  }
}
