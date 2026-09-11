import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { canonicalJson, validateReplayPayload } from '../../../server/replay-schema.js';

export function verifyReplay(row, downloadedBytes) {
  if (!row || row.replay_status !== 'READY' || Number(row.replay_schema_version) !== 1 ||
      row.replay_compression !== 'gzip' || typeof row.replay_object_key !== 'string' ||
      !row.replay_object_key || !/^[a-f0-9]{64}$/.test(row.replay_sha256 || '')) {
    throw new Error('REPLAY_METADATA_INVALID');
  }
  let plain;
  const isGzip = downloadedBytes[0] === 0x1f && downloadedBytes[1] === 0x8b;
  if (isGzip) {
    if (downloadedBytes.byteLength !== Number(row.replay_size_bytes)) throw new Error('SIZE_MISMATCH');
    try { plain = gunzipSync(downloadedBytes); }
    catch { throw new Error('GZIP_INVALID'); }
  } else {
    // Wrangler transparently decodes objects stored with Content-Encoding: gzip.
    // In that case replay_size_bytes still describes the compressed R2 object,
    // so integrity is established against the canonical uncompressed SHA-256.
    plain = downloadedBytes;
  }
  const digest = createHash('sha256').update(plain).digest('hex');
  if (digest !== row.replay_sha256) throw new Error('CONTENT_HASH_MISMATCH');
  let replay;
  try { replay = JSON.parse(plain.toString('utf8')); }
  catch { throw new Error('REPLAY_JSON_INVALID'); }
  if (replay.replay_schema_version !== 1 || Number(row.replay_schema_version) !== 1 ||
      !replay.identity || replay.identity.snapshot_id !== row.id || replay.identity.event_id !== row.event_id) {
    throw new Error('IDENTITY_MISMATCH');
  }
  return replay;
}

export async function validateDownloadedReplay(row, compressedBytes) {
  const replay = verifyReplay(row, compressedBytes);
  if (!replay.identity || !/^[a-f0-9]{40}$/.test(replay.identity.engine_build_sha || '')) {
    throw new Error('ENGINE_VERSION_INVALID');
  }
  const configDigest = createHash('sha256').update(canonicalJson(replay.effective_config)).digest('hex');
  if (!replay.identity || configDigest !== replay.identity.config_hash) throw new Error('CONFIG_MISMATCH');
  try { return await validateReplayPayload(replay, row); }
  catch (error) {
    if (/config_hash/.test(String(error && error.message || ''))) throw new Error('CONFIG_MISMATCH');
    throw new Error('SCHEMA_VALIDATION_FAILED');
  }
}

