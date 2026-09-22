import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson, errorCode, fail } from '../../dataset/lib/common.mjs';
import { createProgress } from '../../progress.mjs';
import { outside } from '../../tuning/lib/input.mjs';

const FLAGS = {
  plan: ['model', 'raw', 'gt', 'baseline', 'sensitivity', 'output', 'report-dir'],
  run: ['model', 'raw', 'gt', 'baseline', 'sensitivity', 'output', 'report-dir'],
  validate: ['model', 'raw', 'gt', 'baseline', 'sensitivity', 'report-dir'],
  stats: ['report-dir']
};

const REQUIRED = {
  plan: ['model', 'raw', 'gt', 'baseline', 'sensitivity'],
  run: ['model', 'raw', 'gt', 'baseline', 'sensitivity']
};

const PATH_FLAGS = new Set(['model', 'raw', 'gt', 'baseline', 'sensitivity', 'output']);

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
    else if (PATH_FLAGS.has(key)) result[key] = path.resolve(value);
    else fail('INVALID_ARGUMENTS');
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
      plan: '准备 Optimization 计划',
      run: '准备受约束参数优化',
      validate: '校验 Optimization 数据包',
      stats: '校验数据包并展示优化统计'
    }[mode]);

    const roots = [options.path, options.model, options.raw, options.gt, options.baseline, options.sensitivity].filter(Boolean);
    if (options.reportDir) await outside(options.reportDir, roots);

    let data = await operation(options);
    if (mode === 'validate') {
      data = {
        status: data.status, validation_scope: data.validation_scope,
        optimization_id: data.optimization_id, optimization_mode: data.optimization_mode,
        optimization_outcome: data.optimization_outcome,
        candidate_freeze_allowed: data.candidate_freeze_allowed
      };
    }
    if (options.reportDir) {
      await writeReport(options.reportDir, {
        validate: 'validation.json', stats: 'statistics.json'
      }[mode] || 'report.json', data, roots);
    }
    progress.finish(data.status === 'DEDUPLICATED' ? '完成：Optimization 包已存在，已去重'
      : (data.optimization_mode && data.optimization_outcome
        ? `完成：${data.optimization_mode} · ${data.optimization_outcome}`
        : (data.optimization_mode ? `完成：${data.optimization_mode}` : '完成')));
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
