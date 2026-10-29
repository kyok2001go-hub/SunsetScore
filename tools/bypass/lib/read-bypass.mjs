// V2.5.5.9 reader for a local bypass package: manifest + file hashes, index, and verified per-Snapshot payloads.
// Used by bypass:validate and by later analysis tools. Reads only the package; no network.
import path from 'node:path';
import { canonicalJson, fail, hash, inventory, readJson, readSafe } from '../../dataset/lib/common.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
import { BYPASS_PACKAGE_VERSION, INDEX_FIELDS, rowFromIndex, verifyObject } from './core.mjs';

export async function openBypassPackage(directory) {
  const root = path.resolve(directory), manifest = await readJson(path.join(root, 'manifest.json'));
  if (manifest?.descriptor?.bypass_package_version !== BYPASS_PACKAGE_VERSION) fail('BYPASS_PACKAGE_VERSION_UNSUPPORTED');
  if (hash(canonicalJson(manifest.descriptor)) !== manifest.descriptor_sha256 ||
      manifest.bypass_dataset_id !== `bypass_v1_${manifest.descriptor_sha256.slice(0, 16)}`) fail('BYPASS_MANIFEST_INVALID');
  const listed = Object.keys(manifest.files || {}).sort(), present = (await inventory(root)).filter(name => name !== 'manifest.json').sort();
  if (canonicalJson(listed) !== canonicalJson(present)) fail('BYPASS_FILES_MISMATCH');
  for (const name of listed) if (hash(await readSafe(path.join(root, name))) !== manifest.files[name]) fail('BYPASS_FILE_HASH_MISMATCH', { detail: name });
  const indexBytes = await readSafe(path.join(root, 'index.csv'));
  if (hash(indexBytes) !== manifest.descriptor.index_sha256) fail('BYPASS_INDEX_HASH_MISMATCH');
  const index = readCsv(INDEX_FIELDS, indexBytes), byId = new Map(index.map(row => [row.snapshot_id, row]));
  if (byId.size !== index.length) fail('BYPASS_INDEX_DUPLICATE');
  return {
    root, manifest, index,
    /** Verified payload for a VALID row, or null when the Snapshot has no valid object in this package. */
    async read(snapshotId) {
      const row = byId.get(snapshotId);
      if (!row || row.object_status !== 'VALID') return null;
      const verified = verifyObject(rowFromIndex(row), await readSafe(path.join(root, row.local_path)));
      if (verified.contentSha256 !== row.content_sha256) fail('BYPASS_CONTENT_HASH_MISMATCH', { detail: snapshotId });
      return verified.payload;
    }
  };
}
