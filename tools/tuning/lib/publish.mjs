import path from 'node:path';
import { mkdir, writeFile, readFile, rename, lstat, rmdir } from 'node:fs/promises';
import { canonicalJson, safePath, fail, runId, removeOwned, errorCode } from '../../dataset/lib/common.mjs';
import { FILES, MANIFEST_FILE } from './package.mjs';
import { outside } from './input.mjs';
import { APP_ROOT } from './engine-runtime.mjs';
import { silentProgress } from '../../progress.mjs';

export async function withTuningLock(lock, operation, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    await safePath(lock);
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('TUNING_LOCK_BUSY');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    if (performance.now() >= deadline) fail('TUNING_LOCK_BUSY');
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

function defaultOutputRoot(root) {
  return path.join(root, 'dataset/tuning');
}

/**
 * staging -> internal validation -> lock -> source recheck -> atomic rename.
 * Identical content deduplicates; the same id with different content fails.
 */
export async function publishPackage({ output, roots, files, manifest, validateStaging, sourceCheck, root = APP_ROOT, progress = silentProgress, exportFiles = FILES }) {
  const outputRoot = await outside(output || defaultOutputRoot(root), roots);
  const staging = await outside(path.join(outputRoot, 'staging', runId()), roots);
  await mkdir(path.join(staging, 'reports'), { recursive: true });

  try {
    progress.stage('写入 staging 敏感度文件');
    for (const file of [...exportFiles, MANIFEST_FILE]) {
      const content = file === MANIFEST_FILE ? canonicalJson(manifest) : files[file];
      const target = path.join(staging, file);
      await safePath(target);
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    }

    progress.stage('校验 staging 敏感度包');
    await validateStaging(staging);

    const exportsDir = await outside(path.join(outputRoot, 'exports'), roots);
    await mkdir(exportsDir, { recursive: true });
    const target = await outside(path.join(exportsDir, manifest.sensitivity_id), roots);
    const lock = await outside(target + '.lock', roots);

    progress.stage('等待发布锁并检查重复');
    const status = await withTuningLock(lock, async () => {
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
          fail('SENSITIVITY_ID_CONFLICT');
        }
        await sourceCheck();
        return 'DEDUPLICATED';
      }
      await safePath(target);
      await rename(staging, target);
      return 'EXPORTED';
    });

    if (status === 'DEDUPLICATED') await removeOwned(path.join(outputRoot, 'staging'), staging);
    return { status, directory: target, sensitivity_id: manifest.sensitivity_id };
  } catch (error) {
    try {
      await writeFile(path.join(staging, 'failure.json'), canonicalJson({ status: 'FAIL', error_code: errorCode(error) }), { flag: 'wx' });
    } catch { /* preserve original failure */ }
    throw error;
  }
}
