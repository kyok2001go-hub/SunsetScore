import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { compare, safePath } from '../../dataset/lib/common.mjs';
import { withBuildLease } from '../../maintenance/lib/lease.mjs';
export async function withGovernanceLeases(phase, roots, operation) {
  const canonical = [];
  for (const value of roots) {
    const root = await safePath(path.resolve(value));
    await mkdir(root, { recursive: true });
    canonical.push(await realpath(root));
  }
  const keyed = new Map(canonical.map(root => [process.platform === 'win32' ? root.toLowerCase() : root, root]));
  const ordered = [...keyed.entries()].sort((a, b) => compare(a[0], b[0])).map(([, root]) => root);
  const acquire = i => i === ordered.length ? operation() :
    withBuildLease(phase, () => acquire(i + 1), { datasetRoot: ordered[i] });
  return acquire(0);
}
