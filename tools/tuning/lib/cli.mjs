import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson, errorCode, fail } from '../../dataset/lib/common.mjs';
import { outside } from './input.mjs';
import { createProgress } from '../../progress.mjs';

const FLAGS = {
  readiness: ['model', 'raw', 'gt', 'baseline', 'output', 'report-dir'],
  plan: ['model', 'raw', 'gt', 'baseline', 'output', 'report-dir'],
  sensitivity: ['model', 'raw', 'gt', 'baseline', 'output', 'report-dir'],
  validate: ['model', 'raw', 'gt', 'baseline', 'report-dir'],
  stats: ['report-dir'],
  candidate: ['model', 'raw', 'gt', 'split', 'candidates', 'output', 'report-dir']
};

/** Flags a mode cannot run without. Candidate evaluation may skip the Phase A source check. */
const REQUIRED = {
  readiness: ['model', 'raw', 'gt', 'baseline'],
  plan: ['model', 'raw', 'gt', 'baseline'],
  sensitivity: ['model', 'raw', 'gt', 'baseline'],
  candidate: ['model', 'raw', 'candidates']
};

export function parseArgs(args, mode) {
  const result = {}, seen = new Set();
  let start = 0;
  if (['validate', 'stats'].includes(mode)) {
    if (!args[0] || args[0].startsWith('--')) fail('INVALID_ARGUMENTS');
    result.path = path.resolve(args[0]);
    start = 1;
  }
  const allowed = FLAGS[mode];
  for (let index = start; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--quiet' && !seen.has('quiet')) {
      seen.add('quiet');
      result.quiet = true;
      continue;
    }
    if (!flag.startsWith('--')) fail('INVALID_ARGUMENTS');
    const key = flag.slice(2);
    if (!allowed.includes(key) || seen.has(key)) fail('INVALID_ARGUMENTS');
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    index++;
    seen.add(key);
    if (key === 'report-dir') result.reportDir = path.resolve(value);
    else if (key === 'split') result.split = value;
    else result[key] = path.resolve(value);
  }
  const required = REQUIRED[mode];
  if (required && required.some(key => !result[key])) fail('INVALID_ARGUMENTS');
  return result;
}

export async function writeReport(directory, name, data, roots) {
  const root = await outside(directory, roots);
  await mkdir(root, { recursive: true });
  const file = await outside(path.join(root, name), roots);
  try {
    await writeFile(file, canonicalJson(data), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') fail('UNSAFE_PATH', { reason_code: 'REPORT_EXISTS' });
    throw error;
  }
}

export async function runCli(mode, operation) {
  let progress;
  try {
    const options = parseArgs(process.argv.slice(2), mode);
    progress = createProgress(options);
    options.progress = progress;
    progress.stage({
      readiness: '准备调参就绪度检查',
      plan: '准备敏感度实验计划',
      sensitivity: '准备参数敏感度实验',
      validate: '校验敏感度数据包',
      stats: '校验数据包并展示敏感度统计',
      candidate: '准备候选点评估'
    }[mode]);

    const roots = [options.path, options.model, options.raw, options.gt, options.baseline].filter(Boolean);
    if (options.reportDir) await outside(options.reportDir, roots);

    let data = await operation(options);
    if (mode === 'validate') {
      data = { status: data.status, validation_scope: data.validation_scope, sensitivity_id: data.sensitivity_id };
    }

    if (options.reportDir) {
      await writeReport(
        options.reportDir,
        { validate: 'validation.json', stats: 'statistics.json', candidate: 'candidates.json' }[mode] || 'report.json',
        data,
        roots
      );
    }

    progress.finish(
      data.status === 'DEDUPLICATED' ? '完成：敏感度包已存在，已去重'
        : (data.global_readiness ? `完成：Global Readiness = ${data.global_readiness}`
          : (data.evaluated_count ? `完成：已评估 ${data.evaluated_count} 个候选点，最优 ${data.best_candidate_id}` : '完成'))
    );
    console.log(canonicalJson(data));
  } catch (error) {
    progress?.fail(errorCode(error));
    console.log(canonicalJson({
      status: 'FAIL',
      error_code: errorCode(error),
      ...(error.reason_code ? { reason_code: error.reason_code } : {})
    }));
    process.exitCode = 1;
  }
}
