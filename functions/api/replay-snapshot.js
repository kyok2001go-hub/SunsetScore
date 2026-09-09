import {
  SNAPSHOT_INSERT_FIELDS,
  SNAPSHOT_REPLAY_METADATA_FIELDS,
  ValidationError,
  buildSnapshotRow,
  insertStatement,
  isUniqueError,
  json,
  readJsonBody
} from '../../server/event-dataset.js';
import {
  REPLAY_MAX_BODY_BYTES,
  REPLAY_SCHEMA_VERSION,
  canonicalJson,
  validateReplayPayload
} from '../../server/replay-schema.js';

const STALE_PENDING_MS = 10 * 60 * 1000;
const ALL_FIELDS = Object.freeze([...SNAPSHOT_INSERT_FIELDS, ...SNAPSHOT_REPLAY_METADATA_FIELDS]);

function codeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function digestBytes(bytes) {
  return crypto.subtle.digest('SHA-256', bytes);
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function constantTimeEqual(left, right) {
  const [a, b] = await Promise.all([
    digestBytes(new TextEncoder().encode(String(left))),
    digestBytes(new TextEncoder().encode(String(right)))
  ]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let mismatch = av.length ^ bv.length;
  for (let index = 0; index < Math.max(av.length, bv.length); index += 1) {
    mismatch |= (av[index % av.length] ^ bv[index % bv.length]);
  }
  return mismatch === 0;
}

async function authorized(request, env) {
  if (!env.REPLAY_INGEST_SECRET) return { ok: false, response: json({ success: false, error: 'Replay 鉴权未配置', errorCode: 'REPLAY_AUTH_NOT_CONFIGURED' }, 503) };
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await constantTimeEqual(token, env.REPLAY_INGEST_SECRET))) {
    return { ok: false, response: json({ success: false, error: 'Unauthorized' }, 401) };
  }
  return { ok: true };
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function existing(db, key) {
  return db.prepare(`SELECT id, event_id, replay_status, replay_sha256, replay_object_key,
    replay_object_etag, replay_updated_at_utc, replay_attempt_count
    FROM prediction_snapshots WHERE idempotency_key = ? LIMIT 1`).bind(key).first();
}

function metadata(status, now, values = {}) {
  return {
    replay_status: status,
    replay_schema_version: REPLAY_SCHEMA_VERSION,
    replay_object_key: values.objectKey || null,
    replay_size_bytes: values.sizeBytes == null ? null : values.sizeBytes,
    replay_sha256: values.sha256 || null,
    replay_object_etag: values.etag || null,
    replay_compression: values.compression || null,
    replay_saved_at_utc: values.savedAt || null,
    replay_updated_at_utc: now,
    replay_error_code: values.errorCode || null,
    replay_attempt_count: values.attemptCount || 0
  };
}

async function insertNew(db, row, replayMetadata) {
  const result = await insertStatement(db, 'prediction_snapshots', ALL_FIELDS, { ...row, ...replayMetadata }).run();
  if (result && result.success === false) throw codeError('D1_INSERT_FAILED');
}

async function setPending(db, id, values) {
  const result = await db.prepare(`UPDATE prediction_snapshots SET
    replay_status = 'PENDING', replay_schema_version = ?, replay_object_key = ?,
    replay_size_bytes = ?, replay_sha256 = ?, replay_compression = 'gzip',
    replay_updated_at_utc = ?, replay_error_code = NULL,
    replay_attempt_count = replay_attempt_count + 1 WHERE id = ?
    AND replay_status IN ('NONE', 'FAILED', 'PENDING')`).bind(
    REPLAY_SCHEMA_VERSION, values.objectKey, values.sizeBytes, values.sha256, values.now, id
  ).run();
  if (result && result.success === false) throw codeError('D1_PENDING_UPDATE_FAILED');
}

async function setReady(db, id, now, etag) {
  const result = await db.prepare(`UPDATE prediction_snapshots SET replay_status = 'READY',
    replay_object_etag = ?, replay_saved_at_utc = ?, replay_updated_at_utc = ?,
    replay_error_code = NULL WHERE id = ? AND replay_status = 'PENDING'`).bind(etag, now, now, id).run();
  if (result && result.success === false) throw codeError('D1_READY_UPDATE_FAILED');
}

async function setFailed(db, id, now, errorCode) {
  try {
    await db.prepare(`UPDATE prediction_snapshots SET replay_status = 'FAILED',
      replay_updated_at_utc = ?, replay_error_code = ? WHERE id = ?
      AND replay_status IN ('NONE', 'PENDING', 'FAILED')`).bind(now, errorCode, id).run();
  } catch { /* best effort; the original stable code remains authoritative */ }
}

function objectKey(row) {
  return ['replay', 'v1', row.event_date_local.slice(0, 4), row.event_date_local.slice(5, 7),
    row.event_date_local.slice(8, 10), row.event_id, row.id + '.json.gz'].join('/');
}

async function ensureObject(bucket, key, bytes, replaySha, compressedDigest, row, engineBuildSha) {
  let current = await bucket.head(key);
  if (current) {
    if (!current.customMetadata || current.customMetadata.content_sha256 !== replaySha) throw codeError('OBJECT_HASH_CONFLICT');
    return current;
  }
  const created = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256: compressedDigest,
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    customMetadata: {
      content_sha256: replaySha,
      compressed_checksum_sha256: hex(compressedDigest),
      replay_schema_version: String(REPLAY_SCHEMA_VERSION),
      snapshot_id: row.id,
      event_id: row.event_id,
      city: row.city,
      prediction_date: row.event_date_local,
      model_version: row.model_version,
      engine_build_sha: engineBuildSha
    }
  });
  if (created) return created;
  current = await bucket.head(key);
  if (!current || !current.customMetadata || current.customMetadata.content_sha256 !== replaySha) {
    throw codeError('OBJECT_HASH_CONFLICT');
  }
  return current;
}

export async function onRequestPost({ request, env }) {
  const auth = await authorized(request, env || {});
  if (!auth.ok) return auth.response;
  if (new URL(request.url).protocol !== 'https:') return json({ success: false, error: 'Replay 仅允许 HTTPS', errorCode: 'HTTPS_REQUIRED' }, 400);
  if (!env.DB || !env.REPLAY_BUCKET) return json({ success: false, error: 'Replay 存储服务不可用' }, 503);

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > REPLAY_MAX_BODY_BYTES) {
    return json({ success: false, error: '请求体过大', errorCode: 'REPLAY_TOO_LARGE' }, 413);
  }

  let row;
  let duplicate;
  try {
    const body = await readJsonBody(request, REPLAY_MAX_BODY_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.snapshot || !body.replay ||
        Object.keys(body).some((key) => key !== 'snapshot' && key !== 'replay')) {
      throw new ValidationError('请求必须只包含 snapshot 与 replay');
    }
    row = await buildSnapshotRow(body.snapshot);
    if (!['github_schedule', 'github_manual'].includes(row.snapshot_source)) {
      throw new ValidationError('Replay 仅接受 GitHub 采集来源');
    }
    // A deterministic ID makes concurrent first writes materialize the same R2
    // object and content hash. Existing pre-Replay snapshots keep their ID.
    row.id = 'snap_replay_' + row.idempotency_key.slice('snap_v1_'.length, 'snap_v1_'.length + 32);
    duplicate = await existing(env.DB, row.idempotency_key);
    if (duplicate) row.id = duplicate.id;

    let replay;
    try {
      replay = await validateReplayPayload(body.replay, row);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const now = new Date().toISOString();
      if (!duplicate) {
        try { await insertNew(env.DB, row, metadata('FAILED', now, { errorCode: 'INVALID_REPLAY', attemptCount: 1 })); }
        catch (insertError) { if (!isUniqueError(insertError)) throw insertError; }
      } else if (duplicate.replay_status !== 'READY') await setFailed(env.DB, row.id, now, 'INVALID_REPLAY');
      else return json({ success: false, error: 'Replay 校验失败', errorCode: 'INVALID_REPLAY' }, 400);
      return json({ success: true, id: row.id, snapshotSaved: true, replaySaved: false, replayStatus: 'FAILED', errorCode: 'INVALID_REPLAY' });
    }

    replay.identity.snapshot_id = row.id;
    replay.identity.event_id = row.event_id;
    const serialized = canonicalJson(replay);
    const serializedBytes = new TextEncoder().encode(serialized);
    const replaySha = hex(await digestBytes(serializedBytes));
    const compressed = await gzip(serialized);
    const compressedDigest = await digestBytes(compressed);
    const key = objectKey(row);
    const now = new Date().toISOString();

    if (duplicate && duplicate.replay_status === 'READY') {
      if (duplicate.replay_sha256 !== replaySha) return json({ success: false, error: 'Replay 内容冲突', errorCode: 'OBJECT_HASH_CONFLICT' }, 409);
      const readyObject = await env.REPLAY_BUCKET.head(duplicate.replay_object_key);
      if (!readyObject) return json({ success: false, error: 'Replay 对象缺失', errorCode: 'R2_OBJECT_MISSING' }, 503);
      if (!readyObject.customMetadata || readyObject.customMetadata.content_sha256 !== replaySha) {
        return json({ success: false, error: 'Replay 内容冲突', errorCode: 'OBJECT_HASH_CONFLICT' }, 409);
      }
      return json({ success: true, id: row.id, snapshotSaved: true, replaySaved: true, replayStatus: 'READY', deduplicated: true });
    }
    if (duplicate && duplicate.replay_status === 'PENDING' && duplicate.replay_sha256 !== replaySha) {
      return json({ success: false, error: 'Replay 内容冲突', errorCode: 'OBJECT_HASH_CONFLICT' }, 409);
    }
    if (duplicate && duplicate.replay_status === 'PENDING') {
      const updated = Date.parse(duplicate.replay_updated_at_utc || '');
      if (Number.isFinite(updated) && Date.now() - updated < STALE_PENDING_MS) {
        return json({ success: true, id: row.id, snapshotSaved: true, replaySaved: false,
          replayStatus: 'PENDING', replayPending: true, deduplicated: true });
      }
    }

    if (!duplicate) {
      try {
        await insertNew(env.DB, row, metadata('PENDING', now, {
          objectKey: key, sizeBytes: compressed.byteLength, sha256: replaySha,
          compression: 'gzip', attemptCount: 1
        }));
      } catch (error) {
        if (!isUniqueError(error)) throw error;
        duplicate = await existing(env.DB, row.idempotency_key);
        if (!duplicate) throw error;
        if (duplicate.id !== row.id) throw codeError('D1_CONCURRENT_RETRY_REQUIRED');
      }
    } else {
      await setPending(env.DB, row.id, { objectKey: key, sizeBytes: compressed.byteLength, sha256: replaySha, now });
    }

    if (compressed.byteLength > 500 * 1024) console.warn('[replay-snapshot] REPLAY_GZIP_LARGE', { sizeBytes: compressed.byteLength });
    let stored;
    try {
      stored = await ensureObject(env.REPLAY_BUCKET, key, compressed, replaySha, compressedDigest, row,
        replay.identity.engine_build_sha);
    } catch (error) {
      const stableCode = error && error.code === 'OBJECT_HASH_CONFLICT' ? error.code : 'R2_PUT_FAILED';
      await setFailed(env.DB, row.id, new Date().toISOString(), stableCode);
      console.error('[replay-snapshot]', stableCode, { snapshotId: row.id, eventId: row.event_id });
      return json({ success: true, id: row.id, snapshotSaved: true, replaySaved: false, replayStatus: 'FAILED', errorCode: stableCode });
    }
    try {
      await setReady(env.DB, row.id, new Date().toISOString(), stored.etag);
      return json({ success: true, id: row.id, snapshotSaved: true, replaySaved: true,
        replayStatus: 'READY', replaySizeBytes: compressed.byteLength, replaySha256: replaySha,
        deduplicated: !!duplicate });
    } catch {
      console.error('[replay-snapshot] READY_UPDATE_FAILED', { snapshotId: row.id, eventId: row.event_id });
      return json({ success: true, id: row.id, snapshotSaved: true, replaySaved: false,
        replayStatus: 'PENDING', replayPending: true, errorCode: 'READY_UPDATE_FAILED' });
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      const tooLarge = /请求体过大/.test(error.message);
      return json({ success: false, error: error.message, errorCode: tooLarge ? 'REPLAY_TOO_LARGE' : 'INVALID_REPLAY' }, tooLarge ? 413 : 400);
    }
    console.error('[replay-snapshot] REPLAY_INGEST_FAILED');
    return json({ success: false, error: 'Replay 保存失败' }, 503);
  }
}
