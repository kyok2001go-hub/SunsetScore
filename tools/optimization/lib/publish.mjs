import path from 'node:path';
import { mkdir, writeFile, readFile, rename, lstat, rmdir } from 'node:fs/promises';
import { canonicalJson, safePath, fail, runId, removeOwned, errorCode } from '../../dataset/lib/common.mjs';
import { silentProgress } from '../../progress.mjs';
import { APP_ROOT } from '../../tuning/lib/engine-runtime.mjs';
import { outside } from '../../tuning/lib/input.mjs';
import { FILES, FREEZE_FILE, MANIFEST_FILE } from '../optimization-schema.mjs';

/**
 * Same governance as the Sensitivity publisher: staging, internal validation, an exclusive
 * lock, a source recheck, then one atomic rename. Identical content deduplicates and the same id
 * with different content is a conflict, so an Optimization package is write-once.
 */
export function defaultOutputRoot(root = APP_ROOT) {
  return path.join(root, 'dataset/optimization');
}

export async function withOptimizationLock(lock, operation, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    await safePath(lock);
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('OPTIMIZATION_LOCK_BUSY');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    if (performance.now() >= deadline) fail('OPTIMIZATION_LOCK_BUSY');
  }
  try {
    return await operation();
  } finally {
    try {
      await safePath(lock);
      await rmdir(lock);
    } catch { /* a foreign lock must never be removed by guesswork */ }
  }
}

export async function publishOptimizationPackage({ output, roots, files, manifest, validateStaging, sourceCheck, progress = silentProgress }) {
  const outputRoot = await outside(output || defaultOutputRoot(), roots);
  const staging = await outside(path.join(outputRoot, 'staging', runId()), roots);
  await mkdir(path.join(staging, 'reports'), { recursive: true });
  const exported = [...FILES, ...(manifest.candidate_freeze_allowed ? [FREEZE_FILE] : [])];

  try {
    progress.stage('写入 staging Optimization 文件');
    for (const file of [...exported, MANIFEST_FILE]) {
      const content = file === MANIFEST_FILE ? canonicalJson(manifest) : files[file];
      const target = path.join(staging, file);
      await safePath(target);
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    }

    progress.stage('校验 staging Optimization 包');
    await validateStaging(staging);

    const exportsDir = await outside(path.join(outputRoot, 'exports'), roots);
    await mkdir(exportsDir, { recursive: true });
    const target = await outside(path.join(exportsDir, manifest.optimization_id), roots);
    const lock = await outside(target + '.lock', roots);

    progress.stage('等待发布锁并检查重复');
    const status = await withOptimizationLock(lock, async () => {
      await sourceCheck();
      let exists = false;
      try {
        await lstat(target);
        exists = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (exists) {
        const oldManifest = JSON.parse((await readFile(path.join(target, MANIFEST_FILE))).toString('utf8'));
        if (canonicalJson(oldManifest.descriptor) !== canonicalJson(manifest.descriptor) ||
            canonicalJson(oldManifest.files) !== canonicalJson(manifest.files)) {
          fail('OPTIMIZATION_ID_CONFLICT');
        }
        await sourceCheck();
        return 'DEDUPLICATED';
      }
      await safePath(target);
      await rename(staging, target);
      return 'EXPORTED';
    });

    if (status === 'DEDUPLICATED') await removeOwned(path.join(outputRoot, 'staging'), staging);
    return { status, directory: target, optimization_id: manifest.optimization_id };
  } catch (error) {
    try {
      await writeFile(path.join(staging, 'failure.json'), canonicalJson({ status: 'FAIL', error_code: errorCode(error) }), { flag: 'wx' });
    } catch { /* preserve original failure */ }
    throw error;
  }
}
