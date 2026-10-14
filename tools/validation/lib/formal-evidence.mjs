import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { canonicalJson, compare, hash, inventory, readSafe, removeOwned, runId, safePath } from '../../dataset/lib/common.mjs';
import { inspectCampaign, inspectCampaignSnapshot, historySnapshots, historyOverlap, withHistoryLocks } from '../../campaign/campaign.mjs';
import { assert, equal, keys, members, sha, snapshot, sourceRef, text, utc, TEST_FIXTURE } from '../../formal/contracts.mjs';
import { appendLedger, ledgerPrefixMatches } from './disclosure.mjs';
import { outside } from '../../tuning/lib/input.mjs';
import { withOptimizationLock } from '../../optimization/lib/publish.mjs';
import { withFormalLeases } from '../../formal/context.mjs';

export function formalEvidenceIdentity(core) {
  const digest = hash(canonicalJson(core)); return { evidence_id: `validation_evidence_v2_${digest.slice(0, 16)}`, sha256: digest, core };
}
export function formalEvidenceManifest(evidence, modelManifestSha256, campaign) {
  const core = evidence.core;
  const files = Object.fromEntries(Object.entries({ 'evidence.json': core, 'campaign_source.json': campaign })
    .map(([file, body]) => [file, { sha256: hash(canonicalJson(body)), bytes: Buffer.byteLength(canonicalJson(body)) }]));
  const descriptor = { evidence_schema_version: 2, evidence_policy_version: 1, evidence_id: evidence.evidence_id,
    evidence_sha256: evidence.sha256, model_dataset_id: core.model_dataset_id,
    model_dataset_manifest_sha256: modelManifestSha256, campaign_id: core.campaign_id,
    campaign_manifest_sha256: core.campaign_manifest_sha256, semantic_evidence_id: core.semantic_evidence_id,
    semantic_evidence_manifest_sha256: core.semantic_evidence_manifest_sha256,
    ledger_prefix_sequence: core.ledger_prefix_sequence, ledger_prefix_sha256: core.ledger_prefix_sha256,
    result_usage: core.result_usage, files };
  return { ...descriptor, descriptor, descriptor_sha256: hash(canonicalJson(descriptor)),
    validation_disclosure_status: 'INDEPENDENT_ATTESTED' };
}
export function inspectFormalEvidenceCore(core, campaign) {
  inspectCampaignSnapshot(campaign);
  keys(core, ['evidence_schema_version', 'evidence_policy_version', 'mode', 'model_dataset_id', 'validation_csv_sha256',
    'members', 'member_sha256', 'date_set_sha256', 'ledger_prefix_sequence', 'ledger_prefix_sha256', 'history_prefixes',
    'campaign_id', 'campaign_manifest_sha256', 'semantic_evidence_id', 'semantic_evidence_manifest_sha256',
    'human_declaration', 'reviewer', 'reviewed_at_utc', 'allowed_purpose', 'validation_disclosure_status', 'result_usage']);
  assert(core.evidence_schema_version === 2 && core.evidence_policy_version === 1 && core.mode === 'FORMAL_VALIDATION' &&
    core.allowed_purpose === 'FORMAL_VALIDATION' && core.validation_disclosure_status === 'INDEPENDENT_ATTESTED', 'FORMAL_EVIDENCE_PROTOCOL_INVALID');
  equal(core.result_usage, campaign.files['summary.json'].result_usage, 'FORMAL_EVIDENCE_USAGE_MISMATCH');
  const source = sourceRef(campaign), model = campaign.files['source_manifests.json'].model.manifest;
  equal(core.campaign_id, source.id, 'FORMAL_EVIDENCE_CAMPAIGN_MISMATCH'); equal(core.campaign_manifest_sha256, source.manifest_sha256, 'FORMAL_EVIDENCE_CAMPAIGN_MISMATCH');
  const semantic = sourceRef(campaign.files['semantic_source.json']);
  equal(core.semantic_evidence_id, semantic.id, 'FORMAL_EVIDENCE_SEMANTIC_MISMATCH'); equal(core.semantic_evidence_manifest_sha256, semantic.manifest_sha256, 'FORMAL_EVIDENCE_SEMANTIC_MISMATCH');
  equal(core.model_dataset_id, model.model_dataset_id, 'FORMAL_EVIDENCE_MODEL_MISMATCH');
  equal(core.validation_csv_sha256, model.files['splits/validation.csv'].sha256, 'FORMAL_EVIDENCE_CSV_MISMATCH');
  equal(core.members, members(campaign.files['summary.json'].split_members.VALIDATION), 'FORMAL_EVIDENCE_MEMBERS_MISMATCH');
  equal(core.member_sha256, hash(canonicalJson(core.members)), 'FORMAL_EVIDENCE_MEMBERS_HASH');
  equal(core.date_set_sha256, hash(canonicalJson([...new Set(core.members.map(x => x.event_date_local))].sort(compare))), 'FORMAL_EVIDENCE_DATE_HASH');
  keys(core.human_declaration, ['reviewer_id', 'reviewed_at_utc', 'validation_unexposed', 'test_unexposed', 'all_known_access_declared', 'remarks']);
  assert(text(core.reviewer) && core.reviewer === core.human_declaration.reviewer_id &&
    core.reviewed_at_utc === core.human_declaration.reviewed_at_utc && text(core.human_declaration.remarks) &&
    ['validation_unexposed', 'test_unexposed', 'all_known_access_declared'].every(key => core.human_declaration[key] === true), 'FORMAL_DISCLOSURE_NOT_ATTESTED');
  assert(utc(core.reviewed_at_utc) >= utc(campaign.files['campaign.json'].specification.frozen_at_utc), 'FORMAL_DISCLOSURE_TIMELINE_INVALID');
  assert(Array.isArray(core.history_prefixes) && core.history_prefixes.length >= 2 &&
    new Set(core.history_prefixes.map(x => x.key)).size === core.history_prefixes.length, 'FORMAL_EVIDENCE_HISTORY_MISSING');
  equal(core.history_prefixes.map(x => x.key).sort(compare), campaign.files['history.json'].map(x => x.key).sort(compare), 'FORMAL_EVIDENCE_HISTORY_SCOPE_MISMATCH');
  for (const item of core.history_prefixes) {
    keys(item, ['key', 'sequence', 'sha256']); assert(text(item.key) && Number.isInteger(item.sequence) && item.sequence >= 0 && sha(item.sha256), 'FORMAL_EVIDENCE_HISTORY_PREFIX_INVALID');
  }
  const primary = core.history_prefixes.find(x => x.key === 'primary');
  assert(primary && core.ledger_prefix_sequence === primary.sequence && core.ledger_prefix_sha256 === primary.sha256, 'FORMAL_EVIDENCE_PRIMARY_PREFIX_MISMATCH');
  return core;
}
export async function inspectFormalEvidence(directory) {
  const manifestBytes = await readSafe(path.join(directory, 'manifest.json')), evidenceBytes = await readSafe(path.join(directory, 'evidence.json'));
  const campaignBytes = await readSafe(path.join(directory, 'campaign_source.json'));
  const core = JSON.parse(evidenceBytes), campaign = JSON.parse(campaignBytes), manifest = JSON.parse(manifestBytes);
  equal(manifestBytes.toString(), canonicalJson(manifest), 'FORMAL_EVIDENCE_NOT_CANONICAL');
  equal(evidenceBytes.toString(), canonicalJson(core), 'FORMAL_EVIDENCE_NOT_CANONICAL'); equal(campaignBytes.toString(), canonicalJson(campaign), 'FORMAL_EVIDENCE_NOT_CANONICAL');
  inspectFormalEvidenceCore(core, campaign); const identity = formalEvidenceIdentity(core);
  equal(manifest, formalEvidenceManifest(identity, campaign.files['source_manifests.json'].model.manifest_sha256, campaign), 'FORMAL_EVIDENCE_MANIFEST_MISMATCH');
  equal(await inventory(directory), ['campaign_source.json', 'evidence.json', 'manifest.json'], 'FORMAL_EVIDENCE_INVENTORY_MISMATCH');
  equal(path.basename(path.resolve(directory)), identity.evidence_id, 'FORMAL_EVIDENCE_DIRECTORY_ID_MISMATCH');
  return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL', evidence_id: identity.evidence_id, core, campaign, manifest };
}
export async function publishFormalEvidence(outputRoot, evidence, campaign) {
  inspectFormalEvidenceCore(evidence.core, campaign);
  const manifest = formalEvidenceManifest(evidence, campaign.files['source_manifests.json'].model.manifest_sha256, campaign);
  const parent = await safePath(path.join(outputRoot, 'evidence/exports')); await mkdir(parent, { recursive: true });
  const target = path.join(parent, evidence.evidence_id), stagingRoot = await safePath(path.join(outputRoot, 'staging'));
  await mkdir(stagingRoot, { recursive: true }); const staging = path.join(stagingRoot, runId()); await mkdir(staging);
  for (const [name, value] of Object.entries({ 'evidence.json': evidence.core, 'campaign_source.json': campaign, 'manifest.json': manifest }))
    await writeFile(path.join(staging, name), canonicalJson(value), { flag: 'wx' });
  return withOptimizationLock(target + '.lock', async () => {
    try {
      const old = await inspectFormalEvidence(target); equal(old.manifest, manifest, 'FORMAL_EVIDENCE_ID_CONFLICT');
      await removeOwned(stagingRoot, staging); return target;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rename(staging, target); return target;
  });
}
export async function createFormalDisclosure(options) {
  const output = await outside(options.output || path.resolve('dataset/validation'), [options.campaign, options.model]);
  return withFormalLeases('validation_evidence', options, output, async () => {
    const campaign = await inspectCampaign(options.campaign), usage = campaign.files['summary.json'].result_usage;
    equal(options.historyLedgers ? hash(await readSafe(options.historyLedgers)) : null,
      campaign.files['source_manifests.json'].history_registry_sha256, 'FORMAL_HISTORY_REGISTRY_CHANGED');
    assert(usage === 'FORMAL' || options.testFixture === TEST_FIXTURE, 'TEST_FIXTURE_CLI_FORBIDDEN');
    const source = campaign.files['source_manifests.json'].model;
    assert(hash(await readSafe(path.join(options.model, 'manifest.json'))) === source.manifest_sha256, 'FORMAL_DISCLOSURE_MODEL_MISMATCH');
    const histories = await historySnapshots(options);
    return withHistoryLocks(histories.roots, async () => {
      const current = await historySnapshots(options), expectedKeys = campaign.files['history.json'].map(x => x.key).sort(compare);
      equal(current.history.map(x => x.key).sort(compare), expectedKeys, 'FORMAL_DISCLOSURE_HISTORY_SCOPE_CHANGED');
      for (const old of campaign.files['history.json']) assert(ledgerPrefixMatches(current.history.find(x => x.key === old.key), old), 'FORMAL_DISCLOSURE_HISTORY_BROKEN');
      const cohort = campaign.files['summary.json'].split_members;
      assert(historyOverlap(current.history, [...cohort.VALIDATION, ...cohort.TEST]).length === 0, 'VALIDATION_PREVIOUSLY_EXPOSED');
      const primary = current.history.find(x => x.key === 'primary'), declaration = options.declaration;
      const core = { evidence_schema_version: 2, evidence_policy_version: 1, mode: 'FORMAL_VALIDATION',
        model_dataset_id: source.manifest.model_dataset_id, validation_csv_sha256: source.manifest.files['splits/validation.csv'].sha256,
        members: cohort.VALIDATION, member_sha256: hash(canonicalJson(cohort.VALIDATION)),
        date_set_sha256: hash(canonicalJson([...new Set(cohort.VALIDATION.map(x => x.event_date_local))].sort(compare))),
        ledger_prefix_sequence: primary.sequence, ledger_prefix_sha256: primary.sha256,
        history_prefixes: current.history.map(x => ({ key: x.key, sequence: x.sequence, sha256: x.sha256 })),
        campaign_id: campaign.manifest.campaign_id, campaign_manifest_sha256: sourceRef(campaign).manifest_sha256,
        semantic_evidence_id: campaign.manifest.semantic_evidence_id, semantic_evidence_manifest_sha256: campaign.manifest.semantic_evidence_manifest_sha256,
        human_declaration: declaration, reviewer: declaration?.reviewer_id, reviewed_at_utc: declaration?.reviewed_at_utc,
        allowed_purpose: 'FORMAL_VALIDATION', validation_disclosure_status: 'INDEPENDENT_ATTESTED', result_usage: usage };
      const evidence = formalEvidenceIdentity(inspectFormalEvidenceCore(core, campaign));
      const directory = await publishFormalEvidence(output, evidence, snapshot(campaign));
      await appendLedger(current.roots.primary, { action: 'FORMAL_EVIDENCE_REGISTERED', evidence_id: evidence.evidence_id,
        campaign_id: campaign.manifest.campaign_id, members: core.members, result_usage: usage });
      return { status: 'EXPORTED', evidence_id: evidence.evidence_id, directory, result_usage: usage };
    });
  });
}
