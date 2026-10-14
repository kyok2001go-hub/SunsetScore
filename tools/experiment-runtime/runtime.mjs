#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, errorCode, fail, isMain } from '../dataset/lib/common.mjs';
import { freezeRuntime, verifyBundle } from './lib/bundle.mjs';
export async function runtimeCli(args) {
  const command = args.shift();
  if (command === 'verify' && args.length === 1) return verifyBundle(path.resolve(args[0]));
  if (command !== 'freeze') fail('INVALID_ARGUMENTS');
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--source-root', '--output', '--protocol-version'].includes(name) || seen.has(name) || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    seen.add(name);
    if (name === '--protocol-version') { if (!['1', '2'].includes(value)) fail('INVALID_ARGUMENTS'); options.protocolVersion = Number(value); }
    else options[name === '--source-root' ? 'sourceRoot' : 'output'] = path.resolve(value);
  }
  return freezeRuntime(options);
}
if (isMain(import.meta.url)) {
  try { const result = await runtimeCli(process.argv.slice(2)); delete result.source; console.log(canonicalJson(result)); }
  catch (error) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(error), reason_code: error.reason_code || null })); process.exitCode = 1; }
}
