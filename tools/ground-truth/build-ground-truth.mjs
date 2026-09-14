#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile, rename, lstat, rmdir } from 'node:fs/promises';
import { canonicalJson, hash, safePath, within, fail, runId, removeOwned, isMain, errorCode } from '../dataset/lib/common.mjs';
import { loadInput, recheckInput, equal } from './lib/input.mjs';
import { derive } from './lib/aggregate.mjs';
import { contents, makeManifest } from './lib/package.mjs';
import { inspectGroundTruth } from './validate-ground-truth.mjs';
import { cli, parseArgs } from './lib/cli.mjs';

async function withGroundTruthLock(lock, operation) {
  const deadline = performance.now() + 10000;
  for (;;) {
    await safePath(lock);
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('GROUND_TRUTH_LOCK_BUSY');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
    if (performance.now() >= deadline) fail('GROUND_TRUTH_LOCK_BUSY');
  }
  try { return await operation(); }
  finally { await safePath(lock); await rmdir(lock); }
}

export async function buildGroundTruth(raw, options = {}) {
  raw = await safePath(raw);
  const output = await safePath(options.output || path.resolve('dataset/ground_truth'));
  if (within(raw, output)) fail('OUTPUT_DIRECTORY_INSIDE_DATASET');
  const staging = path.join(output, 'staging', runId());
  if (within(raw, staging)) fail('OUTPUT_DIRECTORY_INSIDE_DATASET');
  await safePath(path.join(staging, 'reports'));
  await mkdir(path.join(staging, 'reports'), { recursive: true });
  try {
    const input = await loadInput(raw), result = derive(input.events, input.observations), files = contents(result, input.issues);
    const manifest = makeManifest(input.source, result, files);
    for (const [name, text] of Object.entries({ ...files, 'manifest.json': canonicalJson(manifest) })) {
      await safePath(path.join(staging, name)); await writeFile(path.join(staging, name), text, { encoding: 'utf8', flag: 'wx' });
    }
    try { await inspectGroundTruth(staging, { source: raw, requireSource: true, staging: true }); }
    catch (error) { await recheckInput(raw, input.fingerprints); throw error; }
    const exports = path.join(output, 'exports'); await safePath(exports); await mkdir(exports, { recursive: true });
    const target = path.join(exports, manifest.ground_truth_id); await safePath(target);
    if (within(raw, target) || within(raw, target + '.lock')) fail('OUTPUT_DIRECTORY_INSIDE_DATASET');
    const status = await withGroundTruthLock(target + '.lock', async () => {
        await recheckInput(raw, input.fingerprints);
        let exists = false;
        try { await lstat(target); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (exists) {
          try {
            const prior = await inspectGroundTruth(target, { source: raw, requireSource: true });
            equal(prior.manifest.descriptor, manifest.descriptor);
            for (const f of Object.keys(files)) if (prior.manifest.files[f].sha256 !== hash(files[f])) fail('GROUND_TRUTH_ID_CONFLICT');
          } catch { fail('GROUND_TRUTH_ID_CONFLICT'); }
          await recheckInput(raw, input.fingerprints);
          return 'DEDUPLICATED';
        }
        await safePath(target); await rename(staging, target);
        return 'EXPORTED';
    });
    if (status === 'DEDUPLICATED') await removeOwned(path.join(output, 'staging'), staging);
    return { status, ground_truth_id: manifest.ground_truth_id, directory: target, counts: manifest.counts };
  } catch (error) {
    // Keep diagnostics separate from any completed package files; never print raw input or paths from errors.
    try { await writeFile(path.join(staging, 'failure.json'), canonicalJson({ status: 'FAIL', error_code: errorCode(error) }), { flag: 'wx' }); } catch { /* preserve the original failure */ }
    throw error;
  }
}
if (isMain(import.meta.url)) await cli('build', async args => {
  const options = parseArgs(args, 'build'); return { options, data: await buildGroundTruth(options.path, options) };
});
