import { mkdir, writeFile, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, errorCode, fail, hash, readSafe, runId, safeId, safePath, withLock } from './common.mjs';
import { validateDownloadedReplay } from './replay-integrity.mjs';

export async function validateDatasetReplay(row, bytes) {
  const replay = await validateDownloadedReplay(row, bytes);
  if (replay.context.timezone !== row.timezone || replay.context.dataset_schema_version !== row.dataset_schema_version) fail('REPLAY_CONTEXT_MISMATCH');
  return replay;
}

export async function retryDownload(download, row, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await download(row); }
    catch (error) {
      if (errorCode(error) !== 'NETWORK_TRANSIENT' || attempt === 2) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
}
export async function cachedReplay(row, cacheDir, download, options = {}) {
  safeId(row.id);
  if (!/^[a-f0-9]{64}$/.test(row.replay_sha256 || '')) fail('REPLAY_METADATA_INVALID');
  await safePath(cacheDir);
  await mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${row.replay_sha256}.json`);
  async function existing() {
    try { await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const bytes = await readSafe(target);
    if (hash(bytes) !== row.replay_sha256) fail('CACHE_HASH_CONFLICT');
    const replay = await validateDatasetReplay(row, bytes);
    if (!bytes.equals(Buffer.from(canonicalJson(replay)))) fail('REPLAY_NOT_CANONICAL');
    return { bytes, replay, hit: true };
  }
  const hit = await existing();
  if (hit) return hit;
  return withLock(`${target}.lock`, async () => {
    const winner = await existing();
    if (winner) return winner;
    const downloaded = await retryDownload(download, row, options.sleep);
    const replay = await validateDatasetReplay(row, downloaded);
    const bytes = Buffer.from(canonicalJson(replay));
    if (hash(bytes) !== row.replay_sha256) fail('REPLAY_NOT_CANONICAL');
    const temp = path.join(cacheDir, `.${runId()}.tmp`);
    try {
      await writeFile(temp, bytes, { flag: 'wx' });
      // All writers cooperate on this hash lock; never replace an existing object.
      const concurrent = await existing();
      if (concurrent) return concurrent;
      await rename(temp, target);
    } finally { await rm(temp, { force: true }); }
    return { bytes, replay, hit: false };
  });
}
