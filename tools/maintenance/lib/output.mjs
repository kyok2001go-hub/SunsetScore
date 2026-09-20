import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fail, safePath } from '../../dataset/lib/common.mjs';
import { isInsidePublishedRoot } from './plan.mjs';

/** Reports and plans are never written inside a published package root. */
export async function writeOutput(datasetRoot, target, text) {
  const resolved = await safePath(target);
  if (isInsidePublishedRoot(datasetRoot, resolved)) {
    fail('MAINTENANCE_UNSAFE_PATH', { reason_code: 'OUTPUT_INSIDE_PUBLISHED_ROOT', detail: resolved });
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  try {
    await writeFile(resolved, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') fail('MAINTENANCE_REPORT_EXISTS', { detail: resolved });
    throw error;
  }
  return resolved;
}
