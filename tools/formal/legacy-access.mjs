import path from 'node:path';
import { compare, readSafe, hash } from '../dataset/lib/common.mjs';
import { loadModelHeader, readSplitRows } from '../tuning/lib/input.mjs';
import { appendLedger } from '../validation/lib/disclosure.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { withHistoryLocks } from '../campaign/campaign.mjs';
import { artifactDatasetRoot, members } from './contracts.mjs';

/** Legacy effect readers remain usable, but cannot silently restore VAL independence. */
export async function recordLegacyValidationAccess({ model, output, accessLedger, stage }) {
  const sourceRoot = artifactDatasetRoot(model);
  const primary = accessLedger || path.join(output ? path.dirname(path.resolve(output)) : sourceRoot, 'validation/access-ledger');
  const roots = { primary: path.resolve(primary), model_root: path.join(sourceRoot, 'validation/access-ledger') };
  return withGovernanceLeases('legacy_validation_access', [sourceRoot, path.resolve(primary, '../..')], () =>
    withHistoryLocks(roots, async () => {
      const allowFiles = ['manifest.json', 'schema.json', 'policy.json', 'splits/validation.csv'];
      const header = await loadModelHeader(model, { allowFiles });
      const rows = await readSplitRows(model, { ...header, split: 'VALIDATION', allowFiles });
      const identities = members(rows);
      const entry = { action: 'MANUAL_EFFECT_ACCESS', stage, purpose: 'LEGACY_VALIDATION_EFFECTS',
        actor: 'offline_cli', model_dataset_id: header.manifest.model_dataset_id,
        model_manifest_sha256: hash(await readSafe(path.join(model, 'manifest.json'))),
        members: identities, result_usage: 'DEVELOPMENT_ONLY' };
      const unique = new Map(Object.values(roots).map(root => [process.platform === 'win32' ? root.toLowerCase() : root, root]));
      for (const [, root] of [...unique].sort(([a], [b]) => compare(a, b))) await appendLedger(root, entry);
    }));
}
