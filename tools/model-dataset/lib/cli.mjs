import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson, errorCode, fail } from '../../dataset/lib/common.mjs';
import { outside } from './input.mjs';
import { selection } from './core.mjs';
import { createProgress } from '../../progress.mjs';
export function parseArgs(args, mode) {
  const result = {}, seen = new Set();
  let start = 0;
  if (['validate', 'stats'].includes(mode)) {
    if (!args[0] || args[0].startsWith('--')) fail('INVALID_ARGUMENTS');
    result.path = args[0]; start = 1;
  }
  const allowed = mode === 'build' ? ['raw', 'gt', 'model-version', 'output'] : mode === 'plan' ? ['raw', 'gt', 'model-version', 'report-dir'] : mode === 'validate' ? ['raw', 'gt', 'report-dir'] : ['report-dir'];
  for (let i = start; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1], key = flag.slice(2);
    if (flag === '--quiet' && !seen.has(key)) { seen.add(key); result.quiet = true; i--; continue; }
    if (!flag.startsWith('--') || !allowed.includes(key) || seen.has(key) || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    seen.add(key);
    if (key === 'model-version') result.selection = selection(value);
    else result[key === 'report-dir' ? 'reportDir' : key] = value;
  }
  if (['build', 'plan'].includes(mode) && (!result.raw || !result.gt)) fail('INVALID_ARGUMENTS');
  if (!!result.raw !== !!result.gt) fail('INVALID_ARGUMENTS');
  return result;
}
export async function writeReport(directory, name, data, roots) {
  const root = await outside(directory, roots);
  await mkdir(root, { recursive: true });
  const file = await outside(path.join(root, name), roots);
  try { await writeFile(file, canonicalJson(data), { encoding: 'utf8', flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') fail('UNSAFE_PATH', { reason_code: 'REPORT_EXISTS' }); throw e; }
}
export async function runCli(mode, operation) {
  let progress;
  try {
    const o = parseArgs(process.argv.slice(2), mode);
    progress = createProgress(o); o.progress = progress;
    progress.stage({ build: '准备构建 Model Dataset', plan: '准备预检 Model Dataset', validate: '校验 Model 数据包', stats: '校验数据包并计算统计' }[mode]);
    if (o.reportDir) await outside(o.reportDir, [o.raw, o.gt, o.path]);
    let data = await operation(o);
    if (mode === 'validate') data = { status: data.status, validation_scope: data.validation_scope, model_dataset_id: data.model_dataset_id };
    if (o.reportDir) await writeReport(o.reportDir, { plan: 'plan.json', validate: 'validation.json', stats: 'statistics.json' }[mode], data, [o.path, o.raw, o.gt]);
    progress.finish(data.status === 'DEDUPLICATED' ? '完成：数据包已存在，已去重' : data.publishable === false ? '预检完成：样本不足，详见最终 JSON' : '完成');
    console.log(canonicalJson(data));
  } catch (e) {
    progress?.fail(errorCode(e));
    console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(e), ...(e.reason_code ? { reason_code: e.reason_code } : {}), ...(e.plan ? { plan: e.plan } : {}) }));
    process.exitCode = 1;
  }
}
