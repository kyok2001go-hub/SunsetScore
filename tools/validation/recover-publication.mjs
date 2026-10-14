#!/usr/bin/env node
import { isMain, fail } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { validateValidation } from './validate-validation.mjs';
import { SOURCE_KEYS } from './lib/source.mjs';
export async function recoverPublication(options) {
  if (!SOURCE_KEYS.every(key => options[key])) fail('INVALID_ARGUMENTS');
  return validateValidation({ ...options, recoverPublication: true });
}
if (isMain(import.meta.url)) await runCli('recover', recoverPublication);
