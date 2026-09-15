import path from 'node:path';
import { canonicalJson, hash, readSafe, safePath, within, fail, errorCode, inventory } from '../../dataset/lib/common.mjs';
import { inspectDataset } from '../../dataset/validate-dataset.mjs';
import { inspectGroundTruth } from '../../ground-truth/validate-ground-truth.mjs';
import { groundTruthSchema } from '../../ground-truth/ground-truth-schema.mjs';
import { readCsv } from '../../dataset/lib/csv.mjs';
export async function outside(destination, roots) {
  // Reject explicit parent traversal as well as links/junctions in existing ancestors.
  if (destination.split(/[\\/]/).includes('..')) fail('UNSAFE_PATH');
  const resolved = await safePath(destination);
  for (const root of roots.filter(Boolean)) if (within(await safePath(root), resolved)) fail('UNSAFE_PATH');
  return resolved;
}
export async function fingerprints(root) {
  const result = {};
  for (const f of await inventory(root)) result[f] = hash(await readSafe(path.join(root, f)));
  return result;
}
import { silentProgress } from '../../progress.mjs';
export async function loadInputs(raw, gt, progress = silentProgress) {
  try {
    await safePath(raw); await safePath(gt);
    progress.stage('读取 Raw / GT 文件指纹');
    const before = { raw: await fingerprints(raw), gt: await fingerprints(gt) };
    progress.stage('完整校验 Raw（含 Replay）');
    const r = await inspectDataset(raw);
    if (r.report.status !== 'PASS') fail('SOURCE_PACKAGE_INVALID', { reason_code: r.report.issues[0]?.error_code || 'RAW_VALIDATION_FAIL' });
    progress.stage('校验 GT 与 Raw 来源关联');
    const g = await inspectGroundTruth(gt, { source: raw, requireSource: true });
    if (g.manifest.source_dataset_id !== r.manifest.dataset_id) fail('SOURCE_DATASET_MISMATCH');
    const gtRows = readCsv(groundTruthSchema(g.manifest.ground_truth_schema_version).tables.event_ground_truth, await readSafe(path.join(gt, 'event_ground_truth.csv')));
    progress.stage('复核输入文件指纹');
    const after = { raw: await fingerprints(raw), gt: await fingerprints(gt) };
    if (canonicalJson(before) !== canonicalJson(after)) fail('SOURCE_PACKAGE_INVALID', { reason_code: 'SOURCE_CHANGED_DURING_READ' });
    return { events: r.tables.events, snapshots: r.tables.prediction_snapshots, replays: r.tables.replay_index, gt: gtRows,
      fingerprints: after,
      inputSummary: { raw: r.report.counts, gt: { status: g.status, validation_scope: g.validation_scope } },
      source: { source_dataset_id: r.manifest.dataset_id, ground_truth_id: g.manifest.ground_truth_id,
        source_dataset_manifest_sha256: after.raw['manifest.json'], ground_truth_manifest_sha256: after.gt['manifest.json'],
        source_descriptor_sha256: r.manifest.descriptor_sha256, ground_truth_descriptor_sha256: g.manifest.descriptor_sha256,
        source_versions: { raw_schema: r.manifest.offline_dataset_schema_version, gt_schema: g.manifest.ground_truth_schema_version, gt_policy: g.manifest.gt_policy_version } } };
  } catch (error) {
    if (['SOURCE_DATASET_MISMATCH', 'SOURCE_PACKAGE_INVALID', 'UNSAFE_PATH'].includes(errorCode(error))) throw error;
    fail('SOURCE_PACKAGE_INVALID', { reason_code: errorCode(error) });
  }
}
export async function recheckInputs(raw, gt, captured) {
  try {
    const current = await loadInputs(raw, gt);
    if (canonicalJson(current.fingerprints) !== canonicalJson(captured)) fail('SOURCE_CHANGED_DURING_MODEL_BUILD');
  } catch { fail('SOURCE_CHANGED_DURING_MODEL_BUILD'); }
}
