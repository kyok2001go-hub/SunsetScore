import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson, errorCode, fail } from '../../dataset/lib/common.mjs';
import { outside } from './input.mjs';
import { createProgress } from '../../progress.mjs';

export function parseArgs(args, mode) {
  const result = {}, seen = new Set();
  let start = 0;
  if (['validate', 'stats'].includes(mode)) {
    if (!args[0] || args[0].startsWith('--')) fail('INVALID_ARGUMENTS');
    result.path = path.resolve(args[0]);
    start = 1;
  }
  const allowed = mode === 'baseline'
    ? ['model', 'raw', 'gt', 'output']
    : mode === 'validate'
    ? ['model', 'report-dir']
    : ['report-dir'];

  for (let i = start; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--quiet' && !seen.has('quiet')) {
      seen.add('quiet');
      result.quiet = true;
      continue;
    }
    if (!flag.startsWith('--')) fail('INVALID_ARGUMENTS');
    const key = flag.slice(2);
    if (!allowed.includes(key) || seen.has(key)) fail('INVALID_ARGUMENTS');
    const value = args[i + 1];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    i++;
    seen.add(key);
    if (key === 'report-dir') result.reportDir = path.resolve(value);
    else if (['model', 'raw', 'gt', 'output'].includes(key)) result[key] = path.resolve(value);
    else result[key] = value;
  }

  if (mode === 'baseline' && (!result.model || !result.raw || !result.gt)) {
    fail('INVALID_ARGUMENTS');
  }
  return result;
}

export async function writeReport(directory, name, data, roots) {
  const root = await outside(directory, roots);
  await mkdir(root, { recursive: true });
  const file = await outside(path.join(root, name), roots);
  try {
    await writeFile(file, canonicalJson(data), { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') fail('UNSAFE_PATH', { reason_code: 'REPORT_EXISTS' });
    throw e;
  }
}

export async function runCli(mode, operation) {
  let progress;
  try {
    const o = parseArgs(process.argv.slice(2), mode);
    progress = createProgress(o);
    o.progress = progress;
    progress.stage({
      baseline: '准备评估 Baseline',
      validate: '校验 Evaluation 数据包',
      stats: '校验数据包并展示评估统计'
    }[mode]);

    const roots = [o.path, o.model, o.raw, o.gt].filter(Boolean);
    if (o.reportDir) await outside(o.reportDir, roots);

    let data = await operation(o);
    if (mode === 'validate') {
      data = {
        status: data.status,
        validation_scope: data.validation_scope,
        evaluation_id: data.evaluation_id
      };
    }

    if (o.reportDir) {
      await writeReport(
        o.reportDir,
        { validate: 'validation.json', stats: 'statistics.json' }[mode],
        data,
        roots
      );
    }

    progress.finish(
      data.status === 'DEDUPLICATED'
        ? '完成：评估包已存在，已去重'
        : '完成'
    );
    console.log(canonicalJson(data));
  } catch (e) {
    progress?.fail(errorCode(e));
    console.log(canonicalJson({
      status: 'FAIL',
      error_code: errorCode(e),
      ...(e.reason_code ? { reason_code: e.reason_code } : {})
    }));
    process.exitCode = 1;
  }
}
