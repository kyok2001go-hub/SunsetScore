import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { canonicalJson, hash, safePath, within } from '../../dataset/lib/common.mjs';
import { maintenanceRoot } from '../../maintenance/lib/lease.mjs';

/** Local maintenance metadata may contain paths; immutable experiment packages may not. */
export async function protectExternalReferences(sourceRoots, output) {
  const destination = await safePath(output);
  for (const root of [...new Set(sourceRoots.map(value => path.resolve(value)))]) {
    if (within(root, destination)) continue;
    const directory = await safePath(path.join(maintenanceRoot(root), 'external-governance-references'));
    await mkdir(directory, { recursive: true });
    const guard = { external_governance_reference_version: 1, output_root: destination,
      reason: 'SINGLE_ROOT_PRUNE_CANNOT_PROVE_EXTERNAL_CLOSURE' };
    try { await writeFile(path.join(directory, hash(destination) + '.json'), canonicalJson(guard), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
