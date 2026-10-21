import path from 'node:path';
import { canonicalJson, errorCode, fail, isMain } from '../dataset/lib/common.mjs';
import { createProgress } from '../progress.mjs';
import { planDiagnostics, runDiagnostics, validateDiagnostics } from './package.mjs';

export function parseDiagnosticArgs(args) {
  const command = args.shift(), options = {};
  if (!['plan', 'run', 'validate'].includes(command)) fail('INVALID_ARGUMENTS');
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--quiet' && !options.quiet) { options.quiet = true; continue; }
    const name = key.slice(2), value = args[++i];
    if (!key.startsWith('--') || !['sources', 'plan', 'input', 'output'].includes(name) || options[name] || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    options[name] = path.resolve(value);
  }
  if (!options.sources || command === 'run' && !options.plan || command === 'validate' && !options.input) fail('INVALID_ARGUMENTS');
  return { command, options };
}
if (isMain(import.meta.url)) {
  let progress;
  try {
    const { command, options } = parseDiagnosticArgs(process.argv.slice(2));
    progress = createProgress(options); options.progress = progress;
    const result = await ({ plan: planDiagnostics, run: runDiagnostics, validate: validateDiagnostics })[command](options);
    progress.finish(result.status); console.log(canonicalJson(result));
  } catch (error) { progress?.fail(errorCode(error)); console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(error),
    ...(error.reason_code ? { reason_code: error.reason_code } : {}) })); process.exitCode = 1; }
}
