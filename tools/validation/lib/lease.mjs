import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { compare, fail, safePath } from '../../dataset/lib/common.mjs';
import { withBuildLease } from '../../maintenance/lib/lease.mjs';
import { datasetRootForPhaseOutput } from '../../maintenance/maintenance-policy.mjs';
import { outside } from '../../tuning/lib/input.mjs';
import { SOURCE_KEYS } from './source.mjs';

/** Acquire all roots in canonical order, release in reverse via nested finally blocks. */
export async function withValidationLeases(phase, paths, output, operation) {
  await outside(output, SOURCE_KEYS.map(key => paths[key]).filter(Boolean));
  const roots = [datasetRootForPhaseOutput('validation', output)];
  for (const key of SOURCE_KEYS) {
    if (!paths[key]) fail('INVALID_ARGUMENTS');
    const directory = path.resolve(paths[key]);
    await safePath(directory);
    if (path.basename(path.dirname(directory)) !== 'exports') {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'SOURCE_LAYOUT_UNSUPPORTED', source: key });
    }
    const exportsRoot = path.dirname(directory);
    roots.push(key === 'raw' ? path.dirname(exportsRoot) : path.dirname(path.dirname(exportsRoot)));
  }
  await safePath(roots[0]);
  await mkdir(roots[0], { recursive: true });
  const canonical = await Promise.all(roots.map(async root => {
    await safePath(root);
    return realpath(path.resolve(root));
  }));
  const byKey = new Map(canonical.map(root => [process.platform === 'win32' ? root.toLowerCase() : root, root]));
  const uniqueRoots = [...byKey.entries()].sort((a, b) => compare(a[0], b[0])).map(([, root]) => root);
  const acquire = index => index === uniqueRoots.length ? operation() :
    withBuildLease(phase, () => acquire(index + 1), { datasetRoot: uniqueRoots[index] });
  return acquire(0);
}
