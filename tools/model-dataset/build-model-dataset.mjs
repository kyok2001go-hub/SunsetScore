#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile, rename, lstat, rmdir } from 'node:fs/promises';
import { canonicalJson, safePath, fail, runId, removeOwned, isMain, errorCode } from '../dataset/lib/common.mjs';
import { loadInputs, outside, recheckInputs } from './lib/input.mjs';
import { derive, selection, equal } from './lib/core.mjs';
import { contents, makeManifest } from './lib/package.mjs';
import { inspectModelDataset } from './validate-model-dataset.mjs';
import { runCli } from './lib/cli.mjs';
import { silentProgress } from '../progress.mjs';
import { withBuildLease } from '../maintenance/lib/lease.mjs';
import { datasetRootForPhaseOutput } from '../maintenance/maintenance-policy.mjs';
/**
 * Publish lock budget. The lock is held across a full source re-verification, which on slow
 * disks and larger fixtures can exceed the previous 10 second budget and make a legitimate
 * concurrent build fail with MODEL_DATASET_LOCK_BUSY.
 */
export const MODEL_LOCK_TIMEOUT_MS = 60000;

export async function withModelLock(lock, operation, timeoutMs = MODEL_LOCK_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    await safePath(lock);
    try { await mkdir(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('MODEL_DATASET_LOCK_BUSY');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    if (performance.now() >= deadline) fail('MODEL_DATASET_LOCK_BUSY');
  }
  try { return await operation(); }
  finally { await safePath(lock); await rmdir(lock); }
}
async function runModelDataset(raw, gt, options = {}) {
  const progress = options.progress || silentProgress;
  const output = await outside(options.output || path.resolve('dataset/model'), [raw, gt]);
  const input = await loadInputs(raw, gt, progress), result = derive(input.events, input.snapshots, input.gt, input.replays, options.selection || selection(), input.inputSummary, 2, progress, 3);
  // Data insufficiency is a planning result, not a partial package.
  progress.stage(result.plan.publishable ? '样本门禁通过，准备写入数据包' : '样本门禁未通过');
  if (!result.plan.publishable) fail('INSUFFICIENT_SPLIT_DATA', { plan: { ...input.source, ...result.plan } });
  const staging = await outside(path.join(output, 'staging', runId()), [raw, gt]);
  await mkdir(path.join(staging, 'reports'), { recursive: true });
  await mkdir(path.join(staging, 'splits'));
  try {
    progress.stage('生成 CSV、划分文件与报告');
    const files = contents(result), manifest = makeManifest(input.source, result, files);
    for (const [name, value] of Object.entries({ ...files, 'manifest.json': canonicalJson(manifest) })) {
      await safePath(path.join(staging, name));
      await writeFile(path.join(staging, name), value, { encoding: 'utf8', flag: 'wx' });
    }
    progress.stage('校验新 Model 包及来源关联');
    try { await inspectModelDataset(staging, { raw, gt, staging: true }); }
    catch (e) { await recheckInputs(raw, gt, input.fingerprints); throw e; }
    const exports = await outside(path.join(output, 'exports'), [raw, gt]);
    await mkdir(exports, { recursive: true });
    const target = await outside(path.join(exports, manifest.model_dataset_id), [raw, gt]);
    progress.stage('等待发布锁、复核来源及检查重复');
    const status = await withModelLock(await outside(target + '.lock', [raw, gt]), async () => {
      await recheckInputs(raw, gt, input.fingerprints);
      let exists = false;
      try { await lstat(target); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (exists) {
        try {
          const old = await inspectModelDataset(target, { raw, gt });
          equal(old.manifest.descriptor, manifest.descriptor);
          equal(old.manifest.files, manifest.files);
        } catch { fail('MODEL_DATASET_ID_CONFLICT'); }
        // inspectModelDataset already re-verified the source linkage against this same
        // raw/gt, so a further recheck here only lengthened the lock hold window.
        return 'DEDUPLICATED';
      }
      await safePath(target); await rename(staging, target);
      return 'EXPORTED';
    });
    if (status === 'DEDUPLICATED') await removeOwned(path.join(output, 'staging'), staging);
    return { status, model_dataset_id: manifest.model_dataset_id, directory: target, counts: manifest.counts };
  } catch (error) {
    try { await writeFile(path.join(staging, 'failure.json'), canonicalJson({ status: 'FAIL', error_code: errorCode(error) }), { flag: 'wx' }); } catch { /* Preserve original failure. */ }
    throw error;
  }
}
/** Holds the shared maintenance lease for the whole build so prune never races a Model publish. */
export async function buildModelDataset(raw, gt, options = {}) {
  return withBuildLease('model', () => runModelDataset(raw, gt, options), {
    datasetRoot: datasetRootForPhaseOutput('model', options.output || path.resolve('dataset/model'))
  });
}

if (isMain(import.meta.url)) await runCli('build', o => buildModelDataset(o.raw, o.gt, o));
