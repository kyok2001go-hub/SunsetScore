#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, utf8ByteLength, validateReplayPayload } from '../../server/replay-schema.js';
import { createSizedReplay } from './replay-fixture.mjs';

const DEFAULT_SIZES = Object.freeze([100 * 1024, 400 * 1024, 1536 * 1024]);

function elapsed(startedAt) {
  return Math.max(0, performance.now() - startedAt);
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function measure(replay) {
  const totalStarted = performance.now();
  let started = performance.now();
  const validated = await validateReplayPayload(replay);
  const validationMs = elapsed(started);
  started = performance.now();
  const serialized = canonicalJson(validated);
  const canonicalizeMs = elapsed(started);
  started = performance.now();
  createHash('sha256').update(serialized).digest('hex');
  const hashMs = elapsed(started);
  started = performance.now();
  const compressed = gzipSync(serialized);
  const gzipMs = elapsed(started);
  return {
    raw_bytes: utf8ByteLength(serialized),
    envelope_bytes: utf8ByteLength(JSON.stringify({ snapshot: {}, replay: validated })),
    gzip_bytes: compressed.byteLength,
    compression_ratio: compressed.byteLength / utf8ByteLength(serialized),
    validation_ms: validationMs,
    canonicalize_ms: canonicalizeMs,
    hash_ms: hashMs,
    gzip_ms: gzipMs,
    total_ms: elapsed(totalStarted)
  };
}

function summarize(size, runs) {
  const timingFields = ['validation_ms', 'canonicalize_ms', 'hash_ms', 'gzip_ms', 'total_ms'];
  const timing = Object.fromEntries(timingFields.map((field) => [field, {
    median: median(runs.map((run) => run[field])),
    max: Math.max(...runs.map((run) => run[field]))
  }]));
  return {
    target_bytes: size,
    raw_bytes: runs[0].raw_bytes,
    envelope_bytes: runs[0].envelope_bytes,
    gzip_bytes: runs[0].gzip_bytes,
    compression_ratio: runs[0].compression_ratio,
    timing
  };
}

export async function runBenchmark(options = {}) {
  const iterations = Number.isInteger(options.iterations) && options.iterations >= 5 ? options.iterations : 5;
  const sizes = options.sizes || DEFAULT_SIZES;
  const cases = [];
  for (const size of sizes) {
    const replay = await createSizedReplay(size, options);
    await measure(replay);
    const runs = [];
    for (let index = 0; index < iterations; index += 1) runs.push(await measure(replay));
    cases.push(summarize(size, runs));
  }
  let regression = false;
  if (options.baseline && Array.isArray(options.baseline.cases)) {
    for (const current of cases) {
      const previous = options.baseline.cases.find((entry) => entry.target_bytes === current.target_bytes);
      const previousMedian = previous && previous.timing && previous.timing.total_ms && previous.timing.total_ms.median;
      if (Number.isFinite(previousMedian) && current.timing.total_ms.median > previousMedian * 2) regression = true;
    }
  }
  return {
    status: regression ? 'FAIL' : (options.baseline ? 'PASS' : 'MEASURED'),
    generated_at_utc: new Date().toISOString(),
    runtime: 'node',
    node_version: process.version,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    warmup_iterations: 1,
    iterations,
    cases
  };
}

function parseArgs(args) {
  const result = { output: null, baseline: null };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!value || !['--output', '--baseline'].includes(name)) throw new Error('Usage: benchmark-replay.mjs [--output file] [--baseline file]');
    result[name.slice(2)] = value;
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseline = options.baseline ? JSON.parse(await readFile(options.baseline, 'utf8')) : null;
  const report = await runBenchmark({ baseline });
  if (options.output) {
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'FAIL') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
