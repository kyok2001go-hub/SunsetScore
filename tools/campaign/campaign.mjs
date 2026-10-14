import path from 'node:path';
import { canonicalJson, compare, hash, readSafe } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { modelSchema } from '../model-dataset/model-dataset-schema.mjs';
import { modelPolicy } from '../model-dataset/model-dataset-policy.mjs';
import { inspectModelDataset } from '../model-dataset/validate-model-dataset.mjs';
import { inspectGovernancePackage, inspectGovernanceSnapshot, publishGovernancePackage } from '../experiment-runtime/lib/package.mjs';
import { verifyBundle } from '../experiment-runtime/lib/bundle.mjs';
import { withGovernanceLeases } from '../experiment-runtime/lib/lease.mjs';
import { protectExternalReferences } from '../experiment-runtime/lib/references.mjs';
import { fingerprintSourcePackage } from '../optimization/lib/input.mjs';
import { inspectMetricPackage, inspectMetricSnapshot, semanticPreparationMembers } from '../metric-semantics/semantics.mjs';
import { appendLedger, ledgerPrefixMatches, readLedger, withLedgerLock } from '../validation/lib/disclosure.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { artifactDatasetRoot, assert, day, equal, fixtureUsage, intersects, keys, member, members,
  sha, snapshot, sourceRef, text, utc } from '../formal/contracts.mjs';

export const CAMPAIGN_POLICY = Object.freeze({ campaign_schema_version: 1, campaign_policy_version: 1,
  split_strategy: 'complete_primary_local_date_blocks_prefix_counts_exhaustive', percentages: [70, 15, 15],
  task: 'SUNSET_AESTHETIC_FIVE_LEVEL', search_space_id: 'GLOBAL_CORE_V1',
  search_algorithm: { name: 'DETERMINISTIC_CONSTRAINED_BEAM_COORDINATE_SEARCH', beam_width: 8, max_rounds: 4,
    max_unique_candidates: 500, stage_a_b_budget: 400, stage_c_budget: 100, refinement_rounds: 2,
    refinement_step_factor: 0.5, seed_includes_control: true },
  selection_policy_version: 3, train_effects: 'TRAIN_ONLY', validation_first_access: 'FROZEN_PLAN_ONLY', test_effects: 'FORBIDDEN' });
export const CAMPAIGN_POLICY_V2 = Object.freeze({ ...CAMPAIGN_POLICY, campaign_policy_version: 2,
  percentages: Object.freeze([55, 30, 15]), model_dataset_schema_version: 2, model_dataset_policy_version: 4 });
export function campaignPolicy(version) {
  assert([1, 2].includes(version), 'CAMPAIGN_POLICY_UNSUPPORTED');
  return version === 2 ? CAMPAIGN_POLICY_V2 : CAMPAIGN_POLICY;
}
const schema = { campaign_schema_version: 1, campaign_policy_version: 1,
  required_files: ['campaign.json', 'semantic_source.json', 'runtime_sources.json', 'source_manifests.json', 'history.json', 'summary.json'] };
const campaignSchema = version => ({ ...schema, campaign_policy_version: version });
const jsonFile = async (dir, name) => JSON.parse(await readSafe(path.join(dir, name)));

export function checkCampaignSpecification(spec) {
  keys(spec, ['campaign_specification_version', 'name', 'frozen_at_utc', 'locations', 'date_from', 'date_to',
    'source_kinds', 'gt_review', 'split_strategy', 'percentages', 'search_space_id', 'search_algorithm',
    'selection_policy_version', 'stopping_rule', 'history_declaration']);
  assert([1, 2].includes(spec.campaign_specification_version) && text(spec.name) && text(spec.stopping_rule), 'CAMPAIGN_SPECIFICATION_INVALID');
  const policy = campaignPolicy(spec.campaign_specification_version);
  utc(spec.frozen_at_utc); day(spec.date_from); day(spec.date_to);
  assert(spec.date_from <= spec.date_to && Array.isArray(spec.locations) && spec.locations.length > 0 &&
    spec.locations.every(text) && new Set(spec.locations).size === spec.locations.length &&
    Array.isArray(spec.source_kinds) && spec.source_kinds.length > 0 && spec.source_kinds.every(text), 'CAMPAIGN_SCOPE_INVALID');
  for (const key of ['split_strategy', 'percentages', 'search_space_id', 'search_algorithm', 'selection_policy_version']) equal(spec[key], policy[key], 'CAMPAIGN_FROZEN_RULE_MISMATCH');
  keys(spec.gt_review, ['reviewer_id', 'annotation_procedure', 'dispute_rule', 'audit_rule']);
  assert(Object.values(spec.gt_review).every(text), 'GT_REVIEW_PROCEDURE_MISSING');
  keys(spec.history_declaration, ['reviewer_id', 'reviewed_at_utc', 'all_known_ledgers_declared',
    'validation_not_used_for_search_or_rubric', 'test_not_used_for_search_or_rubric', 'remarks']);
  assert(text(spec.history_declaration.reviewer_id) && text(spec.history_declaration.remarks), 'HISTORY_DECLARATION_INVALID');
  assert(utc(spec.history_declaration.reviewed_at_utc) <= utc(spec.frozen_at_utc), 'CAMPAIGN_TIMELINE_INVALID');
  assert(['all_known_ledgers_declared', 'validation_not_used_for_search_or_rubric', 'test_not_used_for_search_or_rubric']
    .every(key => typeof spec.history_declaration[key] === 'boolean'), 'HISTORY_DECLARATION_INVALID'); return spec;
}

export function runtimeSnapshot(manifest) {
  const d = manifest?.descriptor; assert(d && d.experiment_runtime_protocol_version === 2 &&
    d.formal_contract_revision === 1 && d.result_usage === 'FORMAL_EXECUTION_CAPABLE', 'FORMAL_RUNTIME_PROTOCOL_UNSUPPORTED');
  const digest = hash(canonicalJson(d));
  assert(manifest.runtime_bundle_id === `experiment_runtime_v2_${digest.slice(0, 16)}` &&
    manifest.descriptor_sha256 === digest && manifest.experiment_runtime_protocol_version === 2 &&
    sha(d.engine_runtime_sha256) && sha(d.parameter_registry_sha256), 'FORMAL_RUNTIME_IDENTITY_INVALID');
  return { manifest, manifest_sha256: hash(canonicalJson(manifest)), runtime_bundle_id: manifest.runtime_bundle_id,
    runtime_bundle_sha256: digest, descriptor: d };
}

/** Audit only identities and registered access facts, never derive prediction-vs-GT effects. */
export function historyOverlap(history, protectedMembers, { allowPlanId = null, campaignId = null } = {}) {
  const ids = new Set(protectedMembers.map(x => x.event_id)), keysSet = new Set(protectedMembers.map(x => `${x.location_key}\u0000${x.event_date_local}`));
  const exposureActions = new Set(['RUN_STARTED', 'FIRST_ACCESS_RESERVED', 'MANUAL_EFFECT_ACCESS', 'VERIFY_RECOMPUTE_STARTED',
    'SEMANTIC_USE_REGISTERED', 'SEMANTIC_TEMPLATE_REGISTERED', 'TRAIN_EFFECT_ACCESS']);
  const conflicts = [];
  for (const item of history) for (const row of item.rows) {
    if (!exposureActions.has(row.action)) continue;
    if (allowPlanId && row.plan_id === allowPlanId) continue;
    if (campaignId && row.action === 'TRAIN_EFFECT_ACCESS' && row.campaign_id === campaignId) continue;
    if ((row.member_event_ids || []).some(id => ids.has(id)) || (row.members || []).some(x => ids.has(x.event_id) ||
        keysSet.has(`${x.location_key}\u0000${x.event_date_local}`))) conflicts.push({ ledger_key: item.key, action: row.action, entry_sha256: row.entry_sha256 });
  }
  return conflicts;
}
export function checkHistorySnapshot(history) {
  assert(Array.isArray(history) && history.length > 0 && new Set(history.map(x => x.key)).size === history.length, 'HISTORY_SCOPE_MISSING');
  assert(history.some(x => x.key === 'primary') && history.some(x => x.key === 'model_root'), 'MANDATORY_HISTORY_ROOT_MISSING');
  for (const item of history) {
    keys(item, ['key', 'sequence', 'sha256', 'rows']); assert(text(item.key) && sha(item.sha256) && Array.isArray(item.rows), 'HISTORY_SNAPSHOT_INVALID');
    let previous = '0'.repeat(64);
    for (let i = 0; i < item.rows.length; i++) {
      const { entry_sha256, ...body } = item.rows[i];
      assert(body.sequence === i + 1 && body.previous_sha256 === previous && hash(canonicalJson(body)) === entry_sha256, 'HISTORY_CHAIN_INVALID'); previous = entry_sha256;
    }
    assert(item.sequence === item.rows.length && item.sha256 === previous, 'HISTORY_PREFIX_INVALID');
  }
  return history;
}

export function campaignSummary(spec, semantic, runtimes, sources, history, cohort, usage) {
  checkCampaignSpecification(spec); inspectMetricSnapshot(semantic); checkHistorySnapshot(history);
  assert(semantic.manifest.id_field === 'semantic_evidence_id', 'SEMANTIC_EVIDENCE_REQUIRED');
  const runtime = runtimeSnapshot(runtimes.execution);
  assert(Array.isArray(runtimes.builds) && runtimes.builds.length > 0, 'BUILD_ATTESTATIONS_MISSING');
  assert(['FORMAL', 'TEST_FIXTURE_ONLY'].includes(usage), 'CAMPAIGN_USAGE_INVALID');
  const reasons = [];
  if (semantic.files['summary.json'].status !== 'REVIEWED_PASS') reasons.push('SEMANTIC_REVIEW_NOT_PASSED');
  if (usage === 'FORMAL' && semantic.files['summary.json'].result_usage !== 'FORMAL') reasons.push('SEMANTIC_FIXTURE_NOT_FORMAL');
  if (Object.values(spec.history_declaration).some(value => value === false)) reasons.push('HISTORY_NOT_ATTESTED');
  const scope = semantic.files['mapping_contract.json'].scope;
  if (!spec.locations.every(x => scope.locations.includes(x)) || !spec.source_kinds.every(x => scope.source_kinds.includes(x)) ||
    spec.date_from < scope.date_from || spec.date_to > scope.date_to) reasons.push('MAPPING_SCOPE_NOT_COVERED');
  for (const key of ['raw', 'gt', 'model']) {
    assert(sources[key]?.manifest && sha(sources[key].manifest_sha256) &&
      hash(canonicalJson(sources[key].manifest)) === sources[key].manifest_sha256, 'CAMPAIGN_SOURCE_IDENTITY_INVALID');
    assert(hash(canonicalJson(sources[key].manifest.descriptor)) === sources[key].manifest.descriptor_sha256, 'CAMPAIGN_SOURCE_DESCRIPTOR_INVALID');
  }
  assert(sources.model.manifest.source_dataset_id === sources.raw.manifest.dataset_id &&
    sources.model.manifest.ground_truth_id === sources.gt.manifest.ground_truth_id, 'CAMPAIGN_SOURCE_LINKAGE_MISMATCH');
  if (semantic.files['schema.json'].semantic_schema_version === 2) {
    for (const key of ['raw', 'gt']) equal(semantic.files['mapping_contract.json'].source_ids[key],
      { id: sources[key].manifest[key === 'raw' ? 'dataset_id' : 'ground_truth_id'], manifest_sha256: sources[key].manifest_sha256 },
      'TEAM_CONFIRMATION_CAMPAIGN_SOURCE_MISMATCH');
  }
  assert(Array.isArray(sources.observed_source_kinds) && sources.observed_source_kinds.every(text), 'GT_SOURCE_SCOPE_MISSING');
  assert(sources.history_registry_sha256 === null || sha(sources.history_registry_sha256), 'HISTORY_REGISTRY_HASH_INVALID');
  if (!sources.observed_source_kinds.every(source => spec.source_kinds.includes(source))) reasons.push('GT_SOURCE_SCOPE_NOT_COVERED');
  const policy = modelPolicy(sources.model.manifest.model_dataset_policy_version);
  const frozenPolicy = campaignPolicy(spec.campaign_specification_version);
  if (frozenPolicy.campaign_policy_version === 2) {
    assert(sources.model.manifest.model_dataset_schema_version === frozenPolicy.model_dataset_schema_version &&
      sources.model.manifest.model_dataset_policy_version === frozenPolicy.model_dataset_policy_version, 'CAMPAIGN_MODEL_POLICY_MISMATCH');
  }
  equal(policy.split_strategy, spec.split_strategy, 'MODEL_SPLIT_STRATEGY_MISMATCH'); equal(policy.percentages, spec.percentages, 'MODEL_SPLIT_RATIO_MISMATCH');
  const all = members(cohort); assert(all.length === cohort.length && cohort.every(x => ['TRAIN', 'VALIDATION', 'TEST'].includes(x.split)), 'CAMPAIGN_COHORT_INVALID');
  assert(cohort.every(x => spec.locations.includes(x.location_key) && x.event_date_local >= spec.date_from &&
    x.event_date_local <= spec.date_to), 'CAMPAIGN_MEMBER_OUTSIDE_SCOPE');
  const splitMembers = Object.fromEntries(['TRAIN', 'VALIDATION', 'TEST'].map(split => [split, members(cohort.filter(x => x.split === split))]));
  for (const split of ['TRAIN', 'VALIDATION', 'TEST']) assert(splitMembers[split].length > 0, 'CAMPAIGN_SPLIT_EMPTY');
  const usedForSemantics = semanticPreparationMembers(semantic);
  if (intersects([...splitMembers.VALIDATION, ...splitMembers.TEST], members(usedForSemantics)).length) reasons.push('SEMANTIC_HOLDOUT_OVERLAP');
  if (historyOverlap(history, [...splitMembers.VALIDATION, ...splitMembers.TEST]).length) reasons.push('HOLDOUT_PREVIOUSLY_EXPOSED');
  const builds = [];
  for (const item of runtimes.builds) {
    keys(item, ['engine_build_sha', 'manifest']); assert(/^[a-f0-9]{40}$/.test(item.engine_build_sha), 'BUILD_SHA_INVALID');
    const checked = runtimeSnapshot(item.manifest); builds.push(item.engine_build_sha);
    if (checked.descriptor.engine_runtime_sha256 !== runtime.descriptor.engine_runtime_sha256) reasons.push('HISTORICAL_RUNTIME_UNSUPPORTED');
    if (usage === 'FORMAL' && (checked.descriptor.git?.commit !== item.engine_build_sha || checked.descriptor.git?.worktree_clean !== true)) reasons.push('BUILD_RUNTIME_NOT_ATTESTED');
  }
  assert(new Set(builds).size === builds.length, 'DUPLICATE_BUILD_ATTESTATION');
  equal([...new Set(sources.observed_engine_build_shas)].sort(compare), builds.sort(compare), 'BUILD_ATTESTATION_COVERAGE_INCOMPLETE');
  return { status: reasons.length ? 'BLOCKED' : 'READY_CAMPAIGN', result_usage: usage,
    blocking_reasons: [...new Set(reasons)].sort(compare), split_members: splitMembers,
    semantic_train_overlap: intersects(splitMembers.TRAIN, members(usedForSemantics)),
    correlated_dates: [...new Set(all.filter(x => usedForSemantics.some(y => y.event_date_local === x.event_date_local)).map(x => x.event_date_local))].sort(compare),
    runtime_bundle_id: runtime.runtime_bundle_id, engine_runtime_sha256: runtime.descriptor.engine_runtime_sha256,
    limitations: semantic.files['mapping_contract.json'].limitations };
}

export function inspectCampaignSnapshot(input) {
  const packet = inspectGovernanceSnapshot(input), f = packet.files;
  assert(packet.manifest.id_field === 'campaign_id', 'CAMPAIGN_REQUIRED');
  const version = f['policy.json'].campaign_policy_version, policy = campaignPolicy(version), expectedSchema = campaignSchema(version);
  equal(f['schema.json'], expectedSchema, 'CAMPAIGN_SCHEMA_MISMATCH'); equal(f['policy.json'], policy, 'CAMPAIGN_POLICY_MISMATCH');
  equal(Object.keys(f).sort(compare), ['schema.json', 'policy.json', ...schema.required_files].sort(compare), 'CAMPAIGN_FILE_INVENTORY_MISMATCH');
  const body = f['campaign.json']; keys(body, ['specification', 'members']);
  assert(body.specification.campaign_specification_version === version, 'CAMPAIGN_POLICY_SPECIFICATION_MISMATCH');
  const summary = campaignSummary(body.specification, f['semantic_source.json'], f['runtime_sources.json'],
    f['source_manifests.json'], f['history.json'], body.members, f['summary.json'].result_usage);
  equal(summary, f['summary.json'], 'CAMPAIGN_SUMMARY_MISMATCH');
  assert(summary.status === 'READY_CAMPAIGN', 'CAMPAIGN_NOT_READY');
  const { governance_schema_version, package_kind, files, ...links } = packet.manifest.descriptor;
  equal(links, campaignLinks(f), 'CAMPAIGN_SOURCE_LINKS_MISMATCH'); return packet;
}
export async function inspectCampaign(directory) {
  const packet = inspectCampaignSnapshot(await inspectGovernancePackage(directory));
  assert(path.basename(path.resolve(directory)) === packet.manifest.campaign_id, 'CAMPAIGN_DIRECTORY_ID_MISMATCH'); return packet;
}
function campaignLinks(f) {
  const source = f['source_manifests.json'], runtime = runtimeSnapshot(f['runtime_sources.json'].execution), semantic = sourceRef(f['semantic_source.json']);
  return { result_usage: f['summary.json'].result_usage,
    semantic_evidence_id: semantic.id, semantic_evidence_manifest_sha256: semantic.manifest_sha256,
    runtime_bundle_id: runtime.runtime_bundle_id, runtime_bundle_manifest_sha256: runtime.manifest_sha256,
    source_ids: Object.fromEntries(['raw', 'gt', 'model'].map(key => [key, { id: source[key].manifest[
      key === 'raw' ? 'dataset_id' : key === 'gt' ? 'ground_truth_id' : 'model_dataset_id'], manifest_sha256: source[key].manifest_sha256 }])),
    build_runtime_sources: f['runtime_sources.json'].builds.map(x => ({ id: x.manifest.runtime_bundle_id, manifest_sha256: hash(canonicalJson(x.manifest)) })) };
}
export async function historySnapshots(options) {
  const primary = path.resolve(options.accessLedger || 'dataset/validation/access-ledger');
  const roots = { primary, model_root: path.join(artifactDatasetRoot(options.model), 'validation/access-ledger') };
  if (options.historyLedgers) {
    const doc = JSON.parse(await readSafe(options.historyLedgers)); keys(doc, ['history_ledgers_schema_version', 'ledgers']);
    assert(doc.history_ledgers_schema_version === 1 && Array.isArray(doc.ledgers), 'HISTORY_REGISTRY_INVALID');
    for (const row of doc.ledgers) {
      keys(row, ['key', 'path']); assert(text(row.key) && text(row.path) && !Object.hasOwn(roots, row.key), 'HISTORY_REGISTRY_INVALID');
      roots[row.key] = path.resolve(path.dirname(options.historyLedgers), row.path);
    }
  }
  const history = [];
  for (const [key, root] of Object.entries(roots).sort(([a], [b]) => compare(a, b))) {
    const value = await readLedger(root); history.push({ key, sequence: value.sequence, sha256: value.sha256, rows: value.rows });
  }
  return { roots, history };
}
export async function withHistoryLocks(roots, operation) {
  const byKey = new Map(Object.values(roots).map(root => [process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root), path.resolve(root)]));
  const ordered = [...byKey].sort(([a], [b]) => compare(a, b)).map(([, root]) => root);
  const acquire = index => index === ordered.length ? operation() : withLedgerLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}

export async function campaignPreflight(options) {
  const spec = checkCampaignSpecification(options.specification), semantic = await inspectMetricPackage(options.metricEvidence);
  const runtime = await verifyBundle(options.runtimeBundle, { requireEnvironment: true });
  assert(runtime.descriptor.experiment_runtime_protocol_version === 2, 'FORMAL_RUNTIME_PROTOCOL_UNSUPPORTED');
  const before = {}; for (const key of ['raw', 'gt', 'model']) before[key] = await fingerprintSourcePackage(options[key]);
  const checked = await inspectModelDataset(options.model, { raw: options.raw, gt: options.gt });
  assert(checked.status === 'PASS' && checked.validation_scope === 'SOURCE_LINKED', 'CAMPAIGN_MODEL_SOURCE_NOT_LINKED');
  const sources = {};
  sources.history_registry_sha256 = options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null;
  for (const key of ['raw', 'gt', 'model']) {
    const manifest = await jsonFile(options[key], 'manifest.json'); sources[key] = { manifest, manifest_sha256: before[key]['manifest.json'] };
  }
  const eventsSchema = (await jsonFile(options.raw, 'schema.json')).tables.events;
  const events = new Map(readCsv(eventsSchema, await readSafe(path.join(options.raw, 'raw/events.csv'))).map(x => [x.event_id, x]));
  const eventRows = readCsv(modelSchema(sources.model.manifest.model_dataset_schema_version).tables.event_splits,
    await readSafe(path.join(options.model, 'event_splits.csv'))).filter(x => x.eligibility === 'PRIMARY');
  const cohort = eventRows.map(row => { const raw = events.get(row.event_id); assert(raw && raw.event_date_local === row.event_date_local, 'CAMPAIGN_EVENT_SOURCE_INVALID'); return { ...member(raw), split: row.split }; });
  const rawSchema = await jsonFile(options.raw, 'schema.json');
  const snapshotRows = readCsv(rawSchema.tables.prediction_snapshots, await readSafe(path.join(options.raw, 'raw/prediction_snapshots.csv')));
  const primarySnapshots = new Set(snapshotRows.filter(row => eventRows.some(e => e.event_id === row.event_id)).map(x => x.id));
  const replayRows = readCsv(rawSchema.tables.replay_index, await readSafe(path.join(options.raw, 'raw/replay_index.csv')));
  sources.observed_engine_build_shas = [...new Set(replayRows.filter(row => primarySnapshots.has(row.snapshot_id)).map(x => x.engine_build_sha))].sort(compare);
  const observations = readCsv(rawSchema.tables.sunset_observations, await readSafe(path.join(options.raw, 'raw/sunset_observations.csv')));
  sources.observed_source_kinds = [...new Set(observations.filter(row => eventRows.some(e => e.event_id === row.event_id)).map(x => x.source))].sort(compare);
  const builds = options.buildRuntimes || [{ engine_build_sha: runtime.descriptor.git?.commit, directory: options.runtimeBundle }];
  const runtimeSources = { execution: await jsonFile(options.runtimeBundle, 'manifest.json'), builds: [] };
  for (const build of builds) {
    await verifyBundle(build.directory, { requireEnvironment: true });
    runtimeSources.builds.push({ engine_build_sha: build.engine_build_sha, manifest: await jsonFile(build.directory, 'manifest.json') });
  }
  const { roots, history } = await historySnapshots(options), usage = fixtureUsage(options) || 'FORMAL';
  const summary = campaignSummary(spec, semantic, runtimeSources, sources, history, cohort, usage);
  const policy = campaignPolicy(spec.campaign_specification_version);
  const payloads = { 'schema.json': campaignSchema(policy.campaign_policy_version), 'policy.json': policy, 'campaign.json': { specification: spec, members: cohort },
    'semantic_source.json': snapshot(semantic), 'runtime_sources.json': runtimeSources,
    'source_manifests.json': sources, 'history.json': history, 'summary.json': summary };
  const sourceCheck = async () => {
    equal(options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null, sources.history_registry_sha256, 'CAMPAIGN_HISTORY_REGISTRY_CHANGED');
    for (const key of ['raw', 'gt', 'model']) equal(await fingerprintSourcePackage(options[key]), before[key], 'CAMPAIGN_SOURCE_CHANGED');
    equal(sourceRef(await inspectMetricPackage(options.metricEvidence)), sourceRef(semantic), 'CAMPAIGN_SEMANTIC_SOURCE_CHANGED');
    await verifyBundle(options.runtimeBundle, { requireEnvironment: true });
    for (const build of builds) await verifyBundle(build.directory, { requireEnvironment: true });
    for (const item of history) assert(ledgerPrefixMatches(await readLedger(roots[item.key]), item), 'CAMPAIGN_HISTORY_CHANGED');
  };
  await sourceCheck(); return { status: summary.status, blocking_reasons: summary.blocking_reasons, payloads, roots, sourceCheck };
}

export async function freezeCampaign(options) {
  const output = await outside(options.output || path.resolve('dataset/campaign'), [options.raw, options.gt, options.model, options.metricEvidence, options.runtimeBundle]);
  const allRoots = [path.dirname(output), ...['raw', 'gt', 'model', 'metricEvidence', 'runtimeBundle'].map(key =>
    key === 'raw' ? path.resolve(options[key], '../..') : artifactDatasetRoot(options[key]))];
  const registrySha256 = options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null;
  allRoots.push(...Object.values((await historySnapshots(options)).roots).map(root => path.resolve(root, '../..')));
  allRoots.push(...(options.buildRuntimes || []).map(x => artifactDatasetRoot(x.directory)));
  return withGovernanceLeases('campaign', allRoots, async () => {
    equal(options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null, registrySha256, 'CAMPAIGN_HISTORY_REGISTRY_CHANGED');
    const planned = await campaignPreflight(options); if (planned.status !== 'READY_CAMPAIGN') return { status: 'BLOCKED', blocking_reasons: planned.blocking_reasons };
    return withHistoryLocks(planned.roots, async () => {
      // New access after the frozen prefix must not race Campaign publication.
      const protectedMembers = [...planned.payloads['summary.json'].split_members.VALIDATION, ...planned.payloads['summary.json'].split_members.TEST];
      const current = await historySnapshots(options);
      assert(historyOverlap(current.history, protectedMembers).length === 0, 'CAMPAIGN_HISTORY_CHANGED');
      await protectExternalReferences(allRoots.slice(1), output);
      const result = await publishGovernancePackage({ output, kind: 'campaign', idField: 'campaign_id', payloads: planned.payloads,
        links: campaignLinks(planned.payloads), sourceCheck: planned.sourceCheck,
        validateStaging: async dir => inspectCampaignSnapshot(await inspectGovernancePackage(dir)) });
      await appendLedger(planned.roots.primary, { action: 'CAMPAIGN_REGISTERED', campaign_id: result.campaign_id,
        campaign_manifest_sha256: hash(await readSafe(path.join(result.directory, 'manifest.json'))),
        members: members(planned.payloads['campaign.json'].members), mode: 'FORMAL_PREPARATION', result_usage: planned.payloads['summary.json'].result_usage });
      return { ...result, result_usage: planned.payloads['summary.json'].result_usage, readiness: 'READY_CAMPAIGN' };
    });
  });
}
