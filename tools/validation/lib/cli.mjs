import path from 'node:path';
import { canonicalJson, errorCode, fail } from '../../dataset/lib/common.mjs';
import { createProgress } from '../../progress.mjs';

const SOURCE_FLAGS = ['model', 'raw', 'gt', 'baseline', 'sensitivity', 'optimization'];
const FLAGS = {
  plan: [...SOURCE_FLAGS, 'mode', 'output', 'access-ledger', 'disclosure-evidence', 'validation-policy-version'],
  run: [...SOURCE_FLAGS, 'plan', 'mode', 'output', 'access-ledger'],
  validate: [...SOURCE_FLAGS, 'access-ledger'],
  stats: []
};

export function parseArgs(args, command) {
  if (!FLAGS[command]) fail('INVALID_ARGUMENTS');
  const options = {}, seen = new Set();
  let i = 0;
  if (command === 'validate' || command === 'stats') {
    if (!args[0] || args[0].startsWith('--')) fail('INVALID_ARGUMENTS');
    options.path = path.resolve(args[0]);
    i = 1;
  }
  for (; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--quiet' && !seen.has(flag)) { options.quiet = true; seen.add(flag); continue; }
    if (flag === '--acknowledge-exposed-validation' && command === 'plan' && !seen.has(flag)) {
      options.acknowledgeExposedValidation = true; seen.add(flag); continue;
    }
    if (!flag.startsWith('--') || seen.has(flag) || !FLAGS[command].includes(flag.slice(2))) fail('INVALID_ARGUMENTS');
    seen.add(flag);
    const value = args[++i];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    const name = flag.slice(2);
    if (name === 'access-ledger') options.accessLedger = path.resolve(value);
    else if (name === 'disclosure-evidence') options.disclosureEvidence = path.resolve(value);
    else if (name === 'validation-policy-version') {
      if (!['1', '2'].includes(value)) fail('INVALID_ARGUMENTS');
      options.validationPolicyVersion = Number(value);
    }
    else if (name === 'mode') options.mode = value;
    else options[name] = path.resolve(value);
  }
  if (command === 'plan' || command === 'run') {
    if (SOURCE_FLAGS.some(key => !options[key]) || (command === 'plan' && !options.mode) ||
        (command === 'run' && !options.plan)) fail('INVALID_ARGUMENTS');
  }
  if (command === 'validate' && SOURCE_FLAGS.some(key => Boolean(options[key])) &&
      !(SOURCE_FLAGS.every(key => Boolean(options[key])) ||
        Boolean(options.model && options.optimization && SOURCE_FLAGS.filter(key => !['model', 'optimization'].includes(key))
          .every(key => !options[key])))) fail('INVALID_ARGUMENTS');
  return options;
}

export async function runCli(command, operation) {
  let progress;
  try {
    const options = parseArgs(process.argv.slice(2), command);
    progress = createProgress(options);
    options.progress = progress;
    const result = await operation(options);
    progress.finish(result.status || 'PASS');
    console.log(canonicalJson(result));
  } catch (error) {
    progress?.fail(errorCode(error));
    console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(error),
      ...(error.reason_code ? { reason_code: error.reason_code } : {}) }));
    process.exitCode = 1;
  }
}
