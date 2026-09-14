import path from 'node:path';
import { canonicalJson, errorCode, fail, safePath, within, reportOutside } from '../../dataset/lib/common.mjs';
export function parseArgs(args, mode) {
  if (!args[0] || args[0].startsWith('--')) fail('INVALID_ARGUMENTS');
  const result = { path: path.resolve(args[0]) }, seen = new Set();
  const allowed = mode === 'build' ? ['--output'] : mode === 'validate' ? ['--source', '--report-dir'] : ['--report-dir'];
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!allowed.includes(flag) || seen.has(flag) || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    seen.add(flag); result[flag === '--report-dir' ? 'reportDir' : flag.slice(2)] = path.resolve(value);
  }
  return result;
}
export async function cli(mode, operation) {
  try {
    const { data, options } = await operation(process.argv.slice(2));
    if (options?.reportDir) {
      await safePath(options.reportDir);
      if (options.source && within(options.source, options.reportDir)) fail('REPORT_DIRECTORY_INSIDE_DATASET');
      await reportOutside(options.path, options.reportDir, mode === 'stats' ? 'statistics.json' : 'validation.json', data);
    }
    console.log(canonicalJson(data));
  } catch (error) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(error) })); process.exitCode = 1; }
}
