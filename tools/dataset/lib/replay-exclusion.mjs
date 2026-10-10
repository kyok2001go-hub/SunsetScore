import { canonicalJson, compare, fail, safeId } from './common.mjs';
import { compareReference, REPLAY_RUNTIME_FILES } from '../../replay/replay-runner.mjs';
import { buildEventIndex } from '../build-event-index.mjs';

const REFERENCE_FIELDS = ['predicted_score', 'predicted_level', 'baseline_score', 'baseline_level',
  'regime_label', 'regime_strength', 'sky_evolution_state', 'sky_evolution_factor', 'gw_factor',
  'comp_sky_canvas', 'comp_horizon', 'comp_illumination', 'comp_atmosphere', 'comp_weather'];
export const referenceFor = row => Object.fromEntries(REFERENCE_FIELDS.map(name => [name, row[name]]));
export function filteredTables(parent, audit) {
  assertReplayExclusion(audit);
  if (parent.manifest.dataset_id !== audit.parent_dataset_id) fail('REPLAY_EXCLUSION_SOURCE_MISMATCH');
  const snapshots = new Map(parent.tables.prediction_snapshots.map(row => [row.id, row]));
  const replays = new Map(parent.tables.replay_index.map(row => [row.snapshot_id, row]));
  for (const record of audit.records) {
    if (!snapshots.has(record.snapshot_id) || replays.get(record.snapshot_id)?.replay_sha256 !== record.replay_sha256 ||
        canonicalJson(referenceFor(snapshots.get(record.snapshot_id))) !== canonicalJson(record.reference)) fail('REPLAY_EXCLUSION_SOURCE_MISMATCH');
  }
  const excluded = new Set(audit.records.map(row => row.snapshot_id));
  const prediction_snapshots = parent.tables.prediction_snapshots.filter(row => !excluded.has(row.id));
  if (!prediction_snapshots.length) fail('EMPTY_SELECTION');
  const eventIds = new Set(prediction_snapshots.map(row => row.event_id));
  const sunset_observations = parent.tables.sunset_observations.filter(row => eventIds.has(row.event_id));
  const replay_index = parent.tables.replay_index.filter(row => !excluded.has(row.snapshot_id));
  return { prediction_snapshots, sunset_observations, replay_index,
    events: buildEventIndex(prediction_snapshots, sunset_observations, replay_index) };
}

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function assertReplayExclusion(audit) {
  const reject = () => fail('REPLAY_EXCLUSION_INVALID');
  if (!audit || canonicalJson(Object.keys(audit).sort()) !== canonicalJson([
    'decision', 'parent_dataset_id', 'parent_manifest_sha256', 'reason_code', 'records', 'runtime_files'
  ]) || audit.decision !== 'EXCLUDE_UNRECOVERABLE' || audit.reason_code !== 'REFERENCE_PARITY_FAILED' ||
      !/^raw_v1_[0-9]{8}_[0-9]{8}_[a-f0-9]{12}$/.test(audit.parent_dataset_id) || !digest(audit.parent_manifest_sha256) ||
      !Array.isArray(audit.records) || !audit.records.length || audit.records.length > 1000 ||
      !Array.isArray(audit.runtime_files) || !audit.runtime_files.length) reject();
  const ids = new Set();
  for (const record of audit.records) {
    if (!record || !record.actual || !record.reference || typeof record.actual !== 'object' || typeof record.reference !== 'object') reject();
    safeId(record.snapshot_id);
    if (ids.has(record.snapshot_id) || !digest(record.replay_sha256) ||
        canonicalJson(Object.keys(record).sort()) !== canonicalJson(['actual', 'comparison', 'reference', 'replay_sha256', 'snapshot_id'])) reject();
    const comparison = compareReference(record.actual, record.reference);
    // Missing reference fields are not evidence of an irrecoverable numerical mismatch.
    if (comparison.pass || comparison.issues.length || canonicalJson(comparison) !== canonicalJson(record.comparison)) reject();
    ids.add(record.snapshot_id);
  }
  if (canonicalJson([...ids]) !== canonicalJson([...ids].sort(compare))) reject();
  for (const file of audit.runtime_files) {
    if (typeof file.path !== 'string' || !/^(js|tools\/replay)\/[A-Za-z0-9_.-]+\.(js|mjs)$/.test(file.path) || !digest(file.sha256) ||
        canonicalJson(Object.keys(file).sort()) !== canonicalJson(['path', 'sha256'])) reject();
  }
  if (canonicalJson(audit.runtime_files.map(file => file.path).sort(compare)) !==
      canonicalJson([...REPLAY_RUNTIME_FILES, 'js/replay_service.js', 'tools/replay/replay-runner.mjs'].sort(compare))) reject();
  return audit;
}
