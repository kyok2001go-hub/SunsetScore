import path from 'node:path';
import { canonicalJson, compare, hash, readSafe } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { datasetSchema } from '../dataset/dataset-schema.mjs';
import { groundTruthSchema } from '../ground-truth/ground-truth-schema.mjs';
import { inspectGroundTruth } from '../ground-truth/validate-ground-truth.mjs';
import { inspectGovernancePackage, publishGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../experiment-runtime/lib/references.mjs';
import { recordLedger } from '../validation/lib/disclosure.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { artifactDatasetRoot, assert, equal, FIXED_MAPPING, fixtureUsage, keys, LABELS, members, rejectCliFixture, text, utc } from '../formal/contracts.mjs';

export const TEAM_SEMANTIC_POLICY = Object.freeze({ semantic_policy_version: 2,
  task: 'SUNSET_AESTHETIC_FIVE_LEVEL', fixed_mapping: FIXED_MAPPING,
  acceptance: 'OWNER_ATTESTED_PRE_ENTRY_TEAM_REVIEW', repeated_annotation_required: false,
  independent_blind_review_measured: false, excellent_support: 'SOFT_WARNING',
  unresolved_gt: 'KEEP_EXISTING_GT_POLICY', holdout_independence: 'KEEP_ACTUAL_ACCESS_HISTORY' });

// This is an attestation of prior work, not a reconstruction of reviewers or agreement statistics.
export function teamConfirmationPayloads(declaration, sources, options = {}) {
  keys(declaration, ['team_confirmation_version', 'authority', 'recorded_at_utc', 'statement',
    'all_entered_observations_team_confirmed', 'task', 'fixed_mapping_retained', 'source_ids']);
  assert(declaration.team_confirmation_version === 1 && declaration.authority === 'PROJECT_OWNER_AND_TEAM' &&
    text(declaration.statement) && declaration.all_entered_observations_team_confirmed === true &&
    declaration.task === TEAM_SEMANTIC_POLICY.task && declaration.fixed_mapping_retained === true,
  'TEAM_CONFIRMATION_INVALID');
  utc(declaration.recorded_at_utc);
  keys(sources, ['raw_manifest', 'gt_manifest', 'events_csv', 'observations_csv', 'event_ground_truth_csv']);
  const raw = sources.raw_manifest, gt = sources.gt_manifest;
  assert(raw.offline_dataset_schema_version === 1, 'TEAM_RAW_VERSION_INVALID');
  const schema = groundTruthSchema(gt.ground_truth_schema_version);
  assert(gt.gt_policy_version === (gt.ground_truth_schema_version === 3 ? 2 : 1), 'TEAM_GT_POLICY_INVALID');
  for (const manifest of [raw, gt]) equal(hash(canonicalJson(manifest.descriptor)), manifest.descriptor_sha256, 'TEAM_SOURCE_DESCRIPTOR_INVALID');
  equal(raw.dataset_id, `raw_v1_${raw.selection.event_date_from.replaceAll('-', '')}_${raw.selection.event_date_to.replaceAll('-', '')}_${raw.descriptor_sha256.slice(0, 12)}`, 'TEAM_RAW_ID_INVALID');
  equal(gt.ground_truth_id, `gt_v${gt.ground_truth_schema_version}_${raw.descriptor_sha256.slice(0, 12)}_${gt.descriptor_sha256.slice(0, 12)}`, 'TEAM_GT_ID_INVALID');
  const ids = { raw: { id: raw.dataset_id, manifest_sha256: hash(canonicalJson(raw)) },
    gt: { id: gt.ground_truth_id, manifest_sha256: hash(canonicalJson(gt)) } };
  equal(declaration.source_ids, ids, 'TEAM_DECLARATION_SOURCE_MISMATCH');
  equal(gt.source_dataset_id, ids.raw.id, 'TEAM_GT_SOURCE_MISMATCH');
  equal(gt.source_dataset_manifest_sha256, ids.raw.manifest_sha256, 'TEAM_GT_SOURCE_MISMATCH');
  equal(gt.source_descriptor_sha256, raw.descriptor_sha256, 'TEAM_GT_SOURCE_MISMATCH');
  for (const key of ['source_dataset_id', 'source_dataset_manifest_sha256', 'source_descriptor_sha256', 'source_input_files'])
    equal(gt[key], gt.descriptor[key], 'TEAM_GT_DESCRIPTOR_MISMATCH');
  equal(raw.selection, raw.descriptor.selection, 'TEAM_RAW_DESCRIPTOR_MISMATCH');
  for (const file of ['raw/events.csv', 'raw/sunset_observations.csv']) {
    equal(raw.files[file].sha256, raw.descriptor.raw_files[file], 'TEAM_RAW_DESCRIPTOR_MISMATCH');
    equal({ sha256: raw.files[file].sha256, bytes: raw.files[file].bytes }, gt.source_input_files[file], 'TEAM_GT_SOURCE_MISMATCH');
  }
  equal(gt.files['event_ground_truth.csv'].sha256, gt.descriptor.event_ground_truth_sha256, 'TEAM_GT_DESCRIPTOR_MISMATCH');
  for (const [file, value, manifest] of [['raw/events.csv', sources.events_csv, raw],
    ['raw/sunset_observations.csv', sources.observations_csv, raw], ['event_ground_truth.csv', sources.event_ground_truth_csv, gt]]) {
    assert(typeof value === 'string', 'TEAM_SOURCE_BYTES_INVALID');
    equal(hash(value), manifest.files[file].sha256, 'TEAM_SOURCE_FILE_MISMATCH');
    equal(Buffer.byteLength(value), manifest.files[file].bytes, 'TEAM_SOURCE_FILE_MISMATCH');
  }
  const rawSchema = datasetSchema(raw.selection.include_comments);
  const events = readCsv(rawSchema.tables.events, Buffer.from(sources.events_csv));
  const observations = readCsv(rawSchema.tables.sunset_observations, Buffer.from(sources.observations_csv));
  const labels = readCsv(schema.tables.event_ground_truth, Buffer.from(sources.event_ground_truth_csv));
  const eventMap = new Map(events.map(x => [x.event_id, x]));
  assert(eventMap.size === events.length && new Set(labels.map(x => x.event_id)).size === labels.length &&
    labels.length === gt.counts.event_count && events.length === raw.counts.events && observations.length === raw.counts.observations &&
    labels.every(x => eventMap.has(x.event_id)), 'TEAM_LABEL_SOURCE_INVALID');
  const labeled = labels.filter(x => LABELS.includes(x.gt_label));
  assert(labeled.length > 0, 'TEAM_LABELED_EVENTS_EMPTY');
  const cohort = members(labeled.map(x => eventMap.get(x.event_id)));
  equal(cohort.length, gt.counts.labeled_event_count, 'TEAM_GT_LABELED_COUNT_MISMATCH');
  const byLevel = Object.fromEntries(LABELS.map(x => [x, labeled.filter(row => row.gt_label === x).length]));
  const dates = cohort.map(x => x.event_date_local).sort(compare);
  const scope = { locations: [...new Set(cohort.map(x => x.location_key))].sort(compare),
    date_from: dates[0], date_to: dates.at(-1),
    source_kinds: [...new Set(observations.filter(x => cohort.some(y => y.event_id === x.event_id)).map(x => x.source))].sort(compare) };
  const limitations = ['PRIOR_TEAM_REVIEW_ATTESTED_BY_OWNER', 'INDEPENDENT_BLIND_AGREEMENT_NOT_MEASURED',
    'FIXED_BANDS_RETAINED_BY_PRODUCT_DECISION_NOT_EMPIRICALLY_CALIBRATED',
    ...(byLevel.excellent < 5 ? ['EXCELLENT_PERFORMANCE_NOT_ESTABLISHED'] : [])];
  return { 'schema.json': { semantic_schema_version: 2, package_kind: 'semantic_evidence',
    labels: LABELS, policy_sha256: hash(canonicalJson(TEAM_SEMANTIC_POLICY)) },
  'policy.json': TEAM_SEMANTIC_POLICY, 'team_confirmation.json': declaration, 'team_sources.json': sources,
  'mapping_contract.json': { ...FIXED_MAPPING, qualification_basis: 'OWNER_ATTESTED_PRE_ENTRY_TEAM_REVIEW',
    source_ids: ids, scope, limitations },
  'summary.json': { status: 'REVIEWED_PASS', review_basis: 'OWNER_ATTESTED_PRE_ENTRY_TEAM_REVIEW',
    metric_readiness: 'READY', result_usage: fixtureUsage(options) || 'FORMAL', sample_count: cohort.length,
    by_level: byLevel, confirmed_members: cohort, limitations } };
}

export async function publishTeamConfirmation(o) {
  const raw = path.resolve(o.raw), gt = path.resolve(o.gt);
  const output = await outside(o.output || path.resolve('dataset/metric_semantics'), [raw, gt, path.dirname(o.declaration)]);
  const ledger = o['access-ledger'] || path.resolve('dataset/validation/access-ledger');
  const roots = [path.dirname(output), path.resolve(raw, '../..'), artifactDatasetRoot(gt), path.resolve(ledger, '../..')];
  return withGovernanceLeases('team_confirmation', roots, async () => {
    const declarationBytes = await readSafe(o.declaration);
    const declaration = JSON.parse(declarationBytes);
    rejectCliFixture(declaration);
    const load = async () => {
      await inspectGroundTruth(gt, { source: raw, requireSource: true });
      return { raw_manifest: JSON.parse(await readSafe(path.join(raw, 'manifest.json'))),
        gt_manifest: JSON.parse(await readSafe(path.join(gt, 'manifest.json'))),
        events_csv: (await readSafe(path.join(raw, 'raw/events.csv'))).toString('utf8'),
        observations_csv: (await readSafe(path.join(raw, 'raw/sunset_observations.csv'))).toString('utf8'),
        event_ground_truth_csv: (await readSafe(path.join(gt, 'event_ground_truth.csv'))).toString('utf8') };
    };
    const sources = await load(), payloads = teamConfirmationPayloads(declaration, sources);
    await protectExternalReferences(roots.slice(1), output);
    const result = await publishGovernancePackage({ output, kind: 'semantic_evidence', idField: 'semantic_evidence_id',
      payloads, links: { source_ids: declaration.source_ids, result_usage: 'FORMAL' },
      sourceCheck: async () => {
        equal(await load(), sources, 'TEAM_SOURCE_CHANGED');
        equal(hash(await readSafe(o.declaration)), hash(declarationBytes), 'TEAM_DECLARATION_CHANGED');
      }, validateStaging: async directory => {
        const packet = await inspectGovernancePackage(directory);
        equal(packet.files, teamConfirmationPayloads(packet.files['team_confirmation.json'], packet.files['team_sources.json']), 'TEAM_DERIVED_CONTENT_MISMATCH');
      } });
    await recordLedger(ledger, { action: 'TEAM_LABEL_CONFIRMATION_REGISTERED', semantic_evidence_id: result.semantic_evidence_id,
      source_ids: declaration.source_ids, result_usage: 'FORMAL', confirmation_basis: 'OWNER_ATTESTED_PRE_ENTRY_TEAM_REVIEW' });
    return { ...result, result_usage: 'FORMAL', summary: payloads['summary.json'] };
  });
}
