import {
  BackfillConflictError,
  commitBackfill,
  previewBackfill,
  validateBackfillEnvelope
} from '../../../server/admin-backfill.js';
import {
  adminAuthResponse,
  authenticateAdminRequest
} from '../../../server/admin-access.js';
import {
  ValidationError,
  readJsonBody
} from '../../../server/event-dataset.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

async function adminActor(context) {
  if (context.data && context.data.adminActor) return { ok: true, actor: context.data.adminActor };
  return authenticateAdminRequest(context.request, context.env);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.DB || typeof env.DB.batch !== 'function') {
    return json({ success: false, error: '数据库服务不可用' }, 503);
  }
  const authenticated = await adminActor(context);
  if (!authenticated.ok) return adminAuthResponse(authenticated);
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return json({ success: false, error: 'Content-Type 必须为 application/json' }, 415);
  }

  try {
    const body = validateBackfillEnvelope(await readJsonBody(request));
    if (body.mode === 'preview') {
      return json({
        success: true,
        mode: 'preview',
        items: await previewBackfill(env.DB, body.items)
      });
    }
    const result = await commitBackfill(
      env.DB,
      authenticated.actor,
      body.request_id,
      body.items
    );
    return json({ success: true, mode: 'commit', ...result });
  } catch (error) {
    if (error instanceof ValidationError) return json({ success: false, error: error.message }, 400);
    if (error instanceof BackfillConflictError) {
      return json({ success: false, error: error.message, items: error.items }, 409);
    }
    console.error('[admin_backfill] DATASET_WRITE_FAILED');
    return json({ success: false, error: '管理员补录失败' }, 503);
  }
}
