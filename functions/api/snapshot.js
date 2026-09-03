import {
  SNAPSHOT_FIELDS,
  ValidationError,
  buildSnapshotRow,
  insertStatement,
  isUniqueError,
  json,
  readJsonBody
} from '../../server/event-dataset.js';

async function existing(db, key) {
  return db.prepare('SELECT id FROM prediction_snapshots WHERE idempotency_key = ? LIMIT 1')
    .bind(key).first();
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.DB) return json({ success: false, error: '数据库服务不可用' }, 503);
  try {
    const body = await readJsonBody(request);
    const row = await buildSnapshotRow(body);
    const duplicate = await existing(env.DB, row.idempotency_key);
    if (duplicate) {
      return json({ success: true, id: duplicate.id, deduplicated: true });
    }
    try {
      const result = await insertStatement(env.DB, 'prediction_snapshots', SNAPSHOT_FIELDS, row).run();
      if (result && result.success === false) throw new Error('D1_INSERT_FAILED');
    } catch (error) {
      if (!isUniqueError(error)) throw error;
      const raced = await existing(env.DB, row.idempotency_key);
      if (!raced) throw error;
      return json({ success: true, id: raced.id, deduplicated: true });
    }
    return json({ success: true, id: row.id, deduplicated: false });
  } catch (error) {
    if (error instanceof ValidationError) return json({ success: false, error: error.message }, 400);
    console.error('[snapshot] DATASET_WRITE_FAILED');
    return json({ success: false, error: '快照保存失败' }, 503);
  }
}
