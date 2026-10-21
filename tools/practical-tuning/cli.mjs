import path from 'node:path';
import { canonicalJson, fail, errorCode } from '../dataset/lib/common.mjs';
import { practicalRun, inspectPractical, verifyPractical } from './workflow.mjs';
const start = Date.now();
const progress = text => process.stderr.write(`[${Math.round((Date.now() - start) / 1000)}s] ${text}\n`);
try {
  const [command, ...args] = process.argv.slice(2), flags = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--recognition-first') { if (flags.recognitionFirst) fail('DUPLICATE_ARGUMENT'); flags.recognitionFirst = true; continue; }
    if (key === '--resume') { if (flags.resume) fail('DUPLICATE_ARGUMENT'); flags.resume = true; continue; }
    if (!['--model', '--raw', '--gt', '--output', '--input', '--max-candidates', '--search-space', '--baseline-run'].includes(key) || flags[key] != null || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    flags[key] = args[++i];
  }
  let result;
  if (command === 'run') {
    if (['--model', '--raw', '--gt'].some(k => !flags[k]) || flags['--input']) fail('INVALID_ARGUMENTS');
    if (['high-cloud', 'mid-cloud', 'mechanism-targeted', 'sky-branch', 'illumination-targeted'].includes(flags['--search-space']) && !flags['--baseline-run']) fail('BASELINE_RUN_REQUIRED');
    if (flags['--baseline-run'] && !['high-cloud', 'mid-cloud', 'mechanism-targeted', 'sky-branch', 'illumination-targeted'].includes(flags['--search-space'])) fail('INVALID_ARGUMENTS');
    result = await practicalRun({ model: path.resolve(flags['--model']), raw: path.resolve(flags['--raw']), gt: path.resolve(flags['--gt']),
      output: flags['--output'] ? path.resolve(flags['--output']) : undefined, resume: flags.resume === true,
      recognitionFirst: flags.recognitionFirst === true,
      searchSpace: flags['--search-space'], baselineRun: flags['--baseline-run'] ? path.resolve(flags['--baseline-run']) : undefined,
      maxCandidates: flags['--max-candidates'] ? Number(flags['--max-candidates']) : undefined }, progress);
  } else if (['stats', 'verify'].includes(command)) {
    if (!flags['--input'] || Object.keys(flags).length !== 1) fail('INVALID_ARGUMENTS');
    if (command === 'verify') { progress('按产物版本独立复算基准与选中配置'); result = await verifyPractical(path.resolve(flags['--input'])); }
    else { const r = await inspectPractical(path.resolve(flags['--input'])); result = { status: r.status, run_id: r.manifest.run_id, ...r.result }; }
  } else fail('INVALID_ARGUMENTS');
  progress('完成'); console.log(canonicalJson(result));
} catch (e) {
  console.log(canonicalJson({ phase7_completed: false, selection_status: 'EXECUTION_ERROR', error_code: errorCode(e),
    ...(e.detail ? { detail: e.detail } : {}) })); process.exitCode = 1;
}
