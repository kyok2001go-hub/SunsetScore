import path from 'node:path';
import { fail } from '../dataset/lib/common.mjs';
import { readSources, SOURCE_KEYS } from './sources.mjs';

/** Policy 4 always uses the history registry bound by the diagnostic sources file. */
export async function developmentValidationOptions(options) {
  if (!options.sources) fail('DIAGNOSTIC_CONTEXT_REQUIRED');
  const bound = await readSources(options.sources);
  const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  for (const key of [...SOURCE_KEYS, 'historyLedgers', 'accessLedger', 'runtimeBundle']) {
    if (options[key] && !samePath(options[key], bound[key])) fail('DIAGNOSTIC_SOURCE_PATH_MISMATCH');
  }
  return { ...options, ...bound };
}
