#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile, rename, lstat, rmdir } from 'node:fs/promises';
import { canonicalJson, safePath, fail, runId, removeOwned, isMain, errorCode, inventory, compare, readSafe, hash } from '../dataset/lib/common.mjs';
import { inspectModelDataset } from '../model-dataset/validate-model-dataset.mjs';
import { outside, loadModelEvaluationInput, recheckEvaluationInputs, TRAIN_WHITELIST_FILES, WHITELIST_FILES } from './lib/input.mjs';
import { evaluate } from './lib/core.mjs';
import { evaluateV2 } from './v2/core.mjs';
import { inspectEvaluation } from './validate-evaluation.mjs';
import { runCli } from './lib/cli.mjs';
import { silentProgress } from '../progress.mjs';

export async function capturePackageFingerprint(dir) {
  if (!dir) return null;
  await safePath(dir);
  const files = (await inventory(dir)).sort(compare);
  const hashes = {};
  for (const f of files) {
    hashes[f] = hash(await readSafe(path.join(dir, f)));
  }
  return { files: hashes, digest: hash(canonicalJson(hashes)) };
}

export async function verifyPackageFingerprint(dir, expected) {
  if (!dir && !expected) return;
  const current = await capturePackageFingerprint(dir);
  if (!current || !expected || current.digest !== expected.digest || canonicalJson(current.files) !== canonicalJson(expected.files)) {
    fail('SOURCE_CHANGED_DURING_EVALUATION');
  }
}

export async function withEvaluationLock(lock, operation, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    await safePath(lock);
    try { await mkdir(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('EVALUATION_LOCK_BUSY');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    if (performance.now() >= deadline) fail('EVALUATION_LOCK_BUSY');
  }
  try { return await operation(); }
  finally {
    try { await safePath(lock); await rmdir(lock); } catch { /* Ignore lock removal errors on cleanup */ }
  }
}

import { existsSync } from 'node:fs';

function defaultEvaluationRoot() {
  if (existsSync(path.resolve('SunsetScore-main/dataset'))) {
    return path.resolve('SunsetScore-main/dataset/evaluation');
  }
  return path.resolve('dataset/evaluation');
}

export async function evaluateBaseline(model, raw, gt, options = {}) {
  const version = options.evaluationVersion ?? 1;
  if (![1, 2].includes(version)) fail('INVALID_ARGUMENTS');
  const whitelist = version === 2 ? TRAIN_WHITELIST_FILES : WHITELIST_FILES;
  const progress = options.progress || silentProgress;
  const roots = [model, raw, gt].filter(Boolean);
  const output = await outside(options.output || defaultEvaluationRoot(), roots);

  progress.stage('记录 Model、Raw、GT 完整来源指纹');
  const packageFingerprintsBefore = {
    model: await capturePackageFingerprint(model),
    raw: raw ? await capturePackageFingerprint(raw) : null,
    gt: gt ? await capturePackageFingerprint(gt) : null
  };

  progress.stage('上游验收：校验 Model 数据包 SOURCE_LINKED 关联');
  const upstream = await inspectModelDataset(model, { raw, gt });
  if (upstream.status !== 'PASS' || upstream.validation_scope !== 'SOURCE_LINKED') {
    fail('UPSTREAM_VALIDATION_FAILED');
  }

  progress.stage('复核上游验收后来源指纹未变化');
  await verifyPackageFingerprint(model, packageFingerprintsBefore.model);
  if (raw) await verifyPackageFingerprint(raw, packageFingerprintsBefore.raw);
  if (gt) await verifyPackageFingerprint(gt, packageFingerprintsBefore.gt);

  progress.stage('受限读取 Model 白名单数据');
  const input = await loadModelEvaluationInput(model, { progress, trainOnly: version === 2 });

  progress.stage('计算 Baseline 指标、分布、切片与对比');
  const result = version === 2
    ? evaluateV2(input.modelManifest, input.modelManifestSha256, input.trainRows, input.warnings, progress)
    : evaluate(input.modelManifest, input.modelManifestSha256, input.trainRows,
      input.validationRows, input.warnings, progress);

  const staging = await outside(path.join(output, 'staging', runId()), roots);
  await mkdir(path.join(staging, 'reports'), { recursive: true });

  try {
    progress.stage('写入 staging 评估文件');
    for (const [name, content] of Object.entries(result.files)) {
      const targetFile = path.join(staging, name);
      await safePath(targetFile);
      await writeFile(targetFile, content, { encoding: 'utf8', flag: 'wx' });
    }

    progress.stage('校验 staging 评估包与模型关联');
    try {
      await inspectEvaluation(staging, { model, staging: true, progress });
    } catch (e) {
      await recheckEvaluationInputs(model, input.fingerprints, whitelist);
      throw e;
    }

    const exportsDir = await outside(path.join(output, 'exports'), roots);
    await mkdir(exportsDir, { recursive: true });
    const target = await outside(path.join(exportsDir, result.manifest.evaluation_id), roots);
    const lock = await outside(target + '.lock', roots);

    progress.stage('等待发布锁、复核输入并检查重复');
    const status = await withEvaluationLock(lock, async () => {
      await verifyPackageFingerprint(model, packageFingerprintsBefore.model);
      if (raw) await verifyPackageFingerprint(raw, packageFingerprintsBefore.raw);
      if (gt) await verifyPackageFingerprint(gt, packageFingerprintsBefore.gt);
      await recheckEvaluationInputs(model, input.fingerprints, whitelist);
      let exists = false;
      try {
        await lstat(target);
        exists = true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      if (exists) {
        try {
          const old = await inspectEvaluation(target, { model, progress });
          if (canonicalJson(old.manifest.descriptor) !== canonicalJson(result.manifest.descriptor) ||
              canonicalJson(old.manifest.files) !== canonicalJson(result.manifest.files)) {
            fail('EVALUATION_ID_CONFLICT');
          }
        } catch (e) {
          if (errorCode(e) === 'EVALUATION_ID_CONFLICT') throw e;
          fail('EVALUATION_ID_CONFLICT');
        }
        await verifyPackageFingerprint(model, packageFingerprintsBefore.model);
        if (raw) await verifyPackageFingerprint(raw, packageFingerprintsBefore.raw);
        if (gt) await verifyPackageFingerprint(gt, packageFingerprintsBefore.gt);
        await recheckEvaluationInputs(model, input.fingerprints, whitelist);
        return 'DEDUPLICATED';
      }

      await safePath(target);
      await rename(staging, target);
      return 'EXPORTED';
    });

    if (status === 'DEDUPLICATED') {
      await removeOwned(path.join(output, 'staging'), staging);
    }

    return {
      status,
      evaluation_id: result.manifest.evaluation_id,
      directory: target,
      counts: result.counts,
      benchmark_counts: result.benchmarkCounts
    };
  } catch (error) {
    try {
      await writeFile(
        path.join(staging, 'failure.json'),
        canonicalJson({ status: 'FAIL', error_code: errorCode(error) }),
        { flag: 'wx' }
      );
    } catch {
      /* Preserve original failure */
    }
    throw error;
  }
}

if (isMain(import.meta.url)) await runCli('baseline', o => evaluateBaseline(o.model, o.raw, o.gt, o));
