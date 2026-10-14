#!/usr/bin/env node
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { canonicalJson, fail, hash, isMain, readSafe, removeOwned, runId, safePath } from '../dataset/lib/common.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { withValidationLeases } from './lib/lease.mjs';
import { bootstrapSeed } from './lib/stability.mjs';
import { auditSources, readValidationInput, sourceIdentity, SOURCE_KEYS, assertSourcesUnchanged } from './lib/source.mjs';
import { appendLedger, makeDevelopmentEvidence, publishEvidence, readLedger, withLedgerLock } from './lib/disclosure.mjs';
import { effectiveSelectionPolicy, validationPolicy } from './validation-policy.mjs';
import { runCli } from './lib/cli.mjs';
import { supportCohort } from '../gt-level-support.mjs';
import { formalContextIdentity, formalMissingReasons, loadFormalContext, withFormalLeases } from '../formal/context.mjs';
import { assertExecutableUsage } from '../formal/contracts.mjs';
import { formalEvidenceIdentity, inspectFormalEvidence } from './lib/formal-evidence.mjs';
import { historySnapshots, historyOverlap, withHistoryLocks } from '../campaign/campaign.mjs';

export const defaultValidationRoot = () => path.resolve('dataset/validation');

export function planIdentity(core) {
  const coreSha256 = hash(canonicalJson(core));
  const payload = { plan_core: core, plan_core_sha256: coreSha256,
    bootstrap_seed: bootstrapSeed(coreSha256) };
  const planSha256 = hash(canonicalJson(payload));
  return { payload, planSha256, planId: `validation_plan_v${core.validation_schema_version || 1}_${planSha256.slice(0, 16)}` };
}

export function planManifest(plan, evidenceManifestSha256 = null) {
  const core = plan.payload.plan_core;
  const descriptor = { validation_plan_schema_version: core.validation_schema_version || 1,
    ...(core.validation_policy_version === 3 ? formalContextIdentity(core.formal_context) : {}),
    validation_plan_id: plan.planId, validation_plan_sha256: plan.planSha256,
    source_ids: core.source, evidence_id: core.evidence_id,
    evidence_manifest_sha256: evidenceManifestSha256,
    files: { 'validation_plan.json': { sha256: plan.planSha256,
      bytes: Buffer.byteLength(canonicalJson(plan.payload)) } } };
  return { ...descriptor, descriptor, descriptor_sha256: hash(canonicalJson(descriptor)) };
}

async function publishPlan(output, plan, evidenceManifestSha256) {
  const parent = await safePath(path.join(output, 'plans'));
  await mkdir(parent, { recursive: true });
  const staging = await safePath(path.join(output, 'staging', runId()));
  await mkdir(path.dirname(staging), { recursive: true });
  await mkdir(staging);
  const target = await safePath(path.join(parent, plan.planId));
  const manifest = planManifest(plan, evidenceManifestSha256);
  await writeFile(path.join(staging, 'validation_plan.json'), canonicalJson(plan.payload), { flag: 'wx' });
  await writeFile(path.join(staging, 'plan_manifest.json'), canonicalJson(manifest), { flag: 'wx' });
  try { await rename(staging, target); }
  catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    const current = (await readFile(path.join(target, 'validation_plan.json'))).toString('utf8');
    if (current !== canonicalJson(plan.payload)) fail('VALIDATION_ID_CONFLICT');
    // An identical plan may have been published by a previous interrupted attempt.
    await removeOwned(path.join(output, 'staging'), staging);
  }
  return target;
}

async function buildPlan(options) {
  const mode = options.mode === 'development' ? 'DEVELOPMENT_VALIDATION'
    : options.mode === 'formal' ? 'FORMAL_VALIDATION' : null;
  if (!mode || (mode === 'DEVELOPMENT_VALIDATION' && options.acknowledgeExposedValidation !== true) ||
      (mode === 'FORMAL_VALIDATION' && (options.acknowledgeExposedValidation || !options.disclosureEvidence))) {
    fail('INVALID_ARGUMENTS');
  }
  const roots = SOURCE_KEYS.map(key => options[key]);
  const output = await outside(options.output || defaultValidationRoot(), roots);
  const ledgerRoot = await outside(options.accessLedger || path.join(output, 'access-ledger'), roots);
  const audited = await auditSources(options, options);
  const version = options.validationPolicyVersion ?? 1;
  const formalContext = version === 3 ? await loadFormalContext(options) : null;
  const importedEvidence = version === 3 ? await inspectFormalEvidence(options.disclosureEvidence) : null;
  if (formalContext) {
    assertExecutableUsage(formalContext.result_usage, options);
    if (importedEvidence.core.campaign_id !== formalContext.campaign.manifest.campaign_id ||
        importedEvidence.core.campaign_manifest_sha256 !== formalContextIdentity(formalContext).campaign_manifest_sha256) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'DISCLOSURE_CAMPAIGN_MISMATCH' });
  }
  const input = await readValidationInput(options, audited, { mode, root: options.root, progress: options.progress,
    validationPolicyVersion: version });
  const policy = validationPolicy(version);
  const selectionPolicy = effectiveSelectionPolicy(audited.manifest.validation_selection_rule, version);
  const blocking = [];
  if (!input.candidates.length) blocking.push('CANDIDATE_SET_EMPTY');
  if (mode === 'FORMAL_VALIDATION') {
    if (audited.manifest.optimization_mode !== 'FORMAL_OPTIMIZATION' ||
        audited.manifest.candidate_freeze_allowed !== true ||
        audited.manifest.validation_promotion_allowed !== true) blocking.push('CANDIDATE_FREEZE_MISSING');
    if (audited.manifest.metric_readiness?.status !== 'READY' ||
        audited.manifest.mapping_status !== 'READY') blocking.push('METRIC_MAPPING_NOT_READY');
    if (input.support.status !== 'READY') blocking.push('VALIDATION_SUPPORT_INSUFFICIENT');
    // A hash-only future package is never a semantic Policy validator. Wire real v3 validators
    // and historical Runtime proofs before the formal branch can become executable.
    if (version !== 3) blocking.push('UPSTREAM_FORMAL_NOT_READY');
  }
  const status = blocking.length ? 'BLOCKED' : version === 3 ? 'READY_FORMAL' : 'READY_DEVELOPMENT';
  const histories = version === 3 ? await historySnapshots({ ...options, accessLedger: ledgerRoot }) : null;
  const locked = operation => histories ? withHistoryLocks(histories.roots, operation) : withLedgerLock(ledgerRoot, operation);
  return locked(async () => {
    const ledger = await readLedger(ledgerRoot);
    const prefix = { sequence: ledger.sequence, sha256: ledger.sha256 };
    const currentHistory = histories ? await historySnapshots({ ...options, accessLedger: ledgerRoot }) : null;
    if (currentHistory) {
      const expected = importedEvidence.core.history_prefixes.map(x => x.key).sort();
      if (canonicalJson(currentHistory.history.map(x => x.key).sort()) !== canonicalJson(expected)) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'DISCLOSURE_HISTORY_SCOPE_MISMATCH' });
      for (const prior of importedEvidence.core.history_prefixes) if (!(await import('./lib/disclosure.mjs')).ledgerPrefixMatches(currentHistory.history.find(x => x.key === prior.key), prior)) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'DISCLOSURE_HISTORY_PREFIX_MISMATCH' });
      if (historyOverlap(currentHistory.history, [...importedEvidence.core.members, ...formalContext.campaign.files['summary.json'].split_members.TEST]).length) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'VALIDATION_PREVIOUSLY_EXPOSED' });
    }
    const evidence = mode === 'DEVELOPMENT_VALIDATION'
      ? makeDevelopmentEvidence({ rows: input.rows,
        modelId: input.header.manifest.model_dataset_id,
        csvSha256: input.validationCsvSha256, prefix }) : importedEvidence ? formalEvidenceIdentity(importedEvidence.core) : null;
    const members = input.rows.map(row => ({ snapshot_id: row.snapshot_id, event_id: row.event_id,
      location_key: row.location_key, event_date_local: row.event_date_local }));
    const core = {
      validation_schema_version: version === 3 ? 2 : 1, validation_policy_version: version, mode, status,
      ...(version >= 2 ? { gt_level_support: input.support.gt_level_support,
        gt_level_support_sha256: input.support.gt_level_support_sha256,
        gt_level_support_cohort: supportCohort(input.rows),
        upstream_train_support: audited.manifest.upstream_train_support } : {}),
      blocking_reasons: [...new Set(blocking)], result_usage: formalContext ? formalContext.result_usage : 'DEVELOPMENT_ONLY',
      ...(formalContext ? { ...formalContextIdentity(formalContext), formal_context: formalContext,
        history_prefixes: currentHistory.history.map(x => ({ key: x.key, sequence: x.sequence, sha256: x.sha256 })) } : {}),
      source: sourceIdentity(audited), source_fingerprints_sha256: hash(canonicalJson(audited.sourceFingerprints)),
      optimization_input_id: audited.manifest.optimization_input_id,
      candidate_set_id: audited.manifest.candidate_set_id,
      search_space_sha256: audited.manifest.search_space_sha256,
      candidates: input.candidates.map(({ resolved }) => ({
        candidate_id: resolved.candidate_id, canonical_vector: resolved.canonical_vector,
        effective_config_sha256: resolved.effective_config_sha256,
        changed_unit_count: resolved.changed_unit_count,
        normalized_parameter_distance: resolved.normalized_parameter_distance
      })),
      engine_runtime_sha256: audited.manifest.engine_runtime_sha256,
      runtime_compatibility: { status: formalContext ? 'ATTESTED_RUNTIME_BUNDLE_BYTES' : 'REFERENCE_RUNTIME_UNATTESTED',
        historical_engine_build_shas: [...new Set(input.rows.map(row => row.engine_build_sha))].sort() },
      tuning_base_config_sha256: audited.manifest.tuning_base_config_sha256,
      parameter_registry_sha256: audited.manifest.parameter_registry_sha256,
      mapping_status: audited.manifest.mapping_status,
      no_skill_reference_ordinal: audited.manifest.no_skill_reference_ordinal,
      validation_csv_sha256: input.validationCsvSha256,
      validation_members: members,
      validation_members_sha256: hash(canonicalJson(members)),
      support: input.support,
      evidence_id: evidence?.evidence_id ?? null, evidence_sha256: evidence?.sha256 ?? null,
      ledger_prefix_sequence: prefix.sequence, ledger_prefix_sha256: prefix.sha256,
      source_validation_selection_rule: audited.manifest.validation_selection_rule,
      source_validation_selection_rule_sha256: selectionPolicy.source_validation_selection_rule_sha256,
      effective_selection_policy: selectionPolicy,
      effective_selection_policy_sha256: hash(canonicalJson(selectionPolicy)),
      policy, evaluated_splits: ['VALIDATION'], test_evaluated: false
    };
    const plan = planIdentity(core);
    await assertSourcesUnchanged(options, audited.sourceFingerprints);
    if (evidence) await publishEvidence(output, evidence, audited.sourceManifestHashes.model, importedEvidence?.campaign);
    const evidenceManifestSha256 = evidence ? hash(await readSafe(path.join(output,
      'evidence', 'exports', evidence.evidence_id, 'manifest.json'))) : null;
    const directory = await publishPlan(output, plan, evidenceManifestSha256);
    await appendLedger(ledgerRoot, { action: 'PLAN_REGISTERED',
      plan_id: plan.planId, cohort_sha256: core.validation_members_sha256,
      evidence_id: evidence?.evidence_id ?? null,
      evidence_sha256: evidence?.sha256 ?? null,
      member_event_ids: [...new Set(input.rows.map(row => row.event_id))].sort(),
      mode, purpose: 'PHASE7_PLAN', actor: 'local_operator', result_id: null });
    return { status, plan_id: plan.planId, plan_dir: directory,
      evidence_id: evidence?.evidence_id ?? null, mode,
      blocking_reasons: core.blocking_reasons,
      validation_support: input.support };
  });
}

export async function planValidation(options) {
  validationPolicy(options.validationPolicyVersion ?? 1);
  if (options.validationPolicyVersion === 3) {
    if (options.mode !== 'formal' || !options.disclosureEvidence || options.acknowledgeExposedValidation) fail('INVALID_ARGUMENTS');
    const reasons = formalMissingReasons(options); if (reasons.length) return { status: 'BLOCKED', mode: 'FORMAL_VALIDATION', plan_id: null, blocking_reasons: reasons };
    return withFormalLeases('validation_plan', options, options.output || defaultValidationRoot(), () => buildPlan(options));
  }
  if (options.mode === 'formal') {
    if (!options.disclosureEvidence || options.acknowledgeExposedValidation) fail('INVALID_ARGUMENTS');
    const bytes = await readSafe(path.join(options.optimization, 'manifest.json'));
    const manifest = JSON.parse(bytes.toString('utf8'));
    const blockers = [];
    if (manifest.optimization_mode !== 'FORMAL_OPTIMIZATION' ||
        manifest.candidate_freeze_allowed !== true ||
        manifest.validation_promotion_allowed !== true) blockers.push('CANDIDATE_FREEZE_MISSING');
    if (!Number.isInteger(manifest.evaluation_policy_version) ||
        manifest.evaluation_policy_version < 3 ||
        !Number.isInteger(manifest.tuning_policy_version) ||
        manifest.tuning_policy_version < 3) {
      blockers.push('UPSTREAM_POLICY_3_MISSING');
    }
    blockers.push('UPSTREAM_FORMAL_NOT_READY');
    return { status: 'BLOCKED', mode: 'FORMAL_VALIDATION',
      plan_id: null, blocking_reasons: blockers, result_usage: null };
  }
  const output = options.output || defaultValidationRoot();
  return withValidationLeases('validation_plan', options, output, () => buildPlan(options));
}

if (isMain(import.meta.url)) await runCli('plan', planValidation);
