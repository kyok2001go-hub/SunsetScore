import {
  OBSERVATION_FIELDS,
  SNAPSHOT_FIELDS,
  ValidationError,
  buildObservationRow,
  buildSnapshotRow,
  hashClientIp,
  insertStatement,
  isUniqueError,
  json,
  readJsonBody
} from '../../server/event-dataset.js';

const WINDOW_AFTER_SUNSET_MS = 45 * 60 * 1000;
const RATE_LIMIT_MS = 30 * 60 * 1000;
const REQUEST_FIELDS = new Set(['observation', 'snapshot']);

async function existing(db, submissionId) {
  return db.prepare('SELECT id, snapshot_id FROM sunset_observations WHERE submission_id = ? LIMIT 1')
    .bind(submissionId).first();
}

function validateEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('请求体必须是对象');
  for (const key of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(key)) throw new ValidationError('请求体包含未知字段：' + key);
  }
  if (!body.observation) throw new ValidationError('observation 不能为空');
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.DB || typeof env.DB.batch !== 'function') {
    return json({ success: false, error: '数据库服务不可用' }, 503);
  }
  try {
    const body = await readJsonBody(request);
    validateEnvelope(body);
    const submittedAt = new Date();
    const userIpHash = await hashClientIp(request);
    const clientUa = (request.headers.get('user-agent') || '').slice(0, 500) || null;
    const provisional = await buildObservationRow(body.observation, {
      submittedAt,
      userIpHash,
      clientUa
    });
    const duplicate = await existing(env.DB, provisional.submission_id);
    if (duplicate) {
      return json({
        success: true,
        id: duplicate.id,
        snapshotId: duplicate.snapshot_id || null,
        snapshotSaved: !!duplicate.snapshot_id,
        deduplicated: true
      });
    }

    if (userIpHash) {
      const recent = await env.DB.prepare(
        'SELECT id FROM sunset_observations WHERE user_ip_hash = ? AND city = ? AND submitted_at_epoch >= ? LIMIT 1'
      ).bind(userIpHash, provisional.city, submittedAt.getTime() - RATE_LIMIT_MS).first();
      if (recent) return json({ success: false, cooldown: true, error: '30 分钟内限提交一次反馈' }, 429);
    }

    const shouldSaveSnapshot = submittedAt.getTime() <= provisional.sunset_epoch + WINDOW_AFTER_SUNSET_MS;
    let snapshot = null;
    if (shouldSaveSnapshot) {
      if (!body.snapshot) throw new ValidationError('当前时段必须携带 prediction snapshot');
      snapshot = await buildSnapshotRow(body.snapshot, {
        source: 'user_feedback',
        submissionId: provisional.submission_id,
        submittedAt
      });
      if (snapshot.event_id !== provisional.event_id) throw new ValidationError('observation 与 snapshot 的 event_id 不一致');
      provisional.snapshot_id = snapshot.id;
    }
    delete provisional.sunset_epoch;

    const statements = [];
    if (snapshot) statements.push(insertStatement(env.DB, 'prediction_snapshots', SNAPSHOT_FIELDS, snapshot));
    statements.push(insertStatement(env.DB, 'sunset_observations', OBSERVATION_FIELDS, provisional));
    try {
      const results = await env.DB.batch(statements);
      if (!Array.isArray(results) || results.some((result) => result && result.success === false)) {
        throw new Error('D1_BATCH_FAILED');
      }
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const raced = await existing(env.DB, provisional.submission_id);
      if (!raced) throw error;
      return json({
        success: true,
        id: raced.id,
        snapshotId: raced.snapshot_id || null,
        snapshotSaved: !!raced.snapshot_id,
        deduplicated: true
      });
    }
    return json({
      success: true,
      id: provisional.id,
      snapshotId: snapshot ? snapshot.id : null,
      snapshotSaved: !!snapshot,
      deduplicated: false
    });
  } catch (error) {
    if (error instanceof ValidationError) return json({ success: false, error: error.message }, 400);
    console.error('[observation] DATASET_WRITE_FAILED');
    return json({ success: false, error: '观测保存失败' }, 503);
  }
}
