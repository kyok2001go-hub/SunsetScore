#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, fail, hash, isMain, readSafe, runId } from '../dataset/lib/common.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { withValidationLeases } from './lib/lease.mjs';
import { runCli } from './lib/cli.mjs';
import { auditSources, readValidationInput, sourceIdentity, SOURCE_KEYS, EXPERIMENT_PATH_KEYS } from './lib/source.mjs';
import { loadFormalContext, withFormalLeases } from '../formal/context.mjs';
import { historySnapshots, historyOverlap, withHistoryLocks } from '../campaign/campaign.mjs';
import { appendLedger, inspectEvidence, ledgerPrefixMatches, readLedger, withLedgerLock, withPlanLock, recordLedger } from './lib/disclosure.mjs';
import { buildValidationResult } from './lib/build.mjs';
import { inspectValidation, packageManifest, publishValidation, readPlan } from './lib/package.mjs';
import { compareRecompute, isolatedRecompute, validationFingerprint } from './lib/recompute.mjs';
import { runReplay } from '../replay/replay-runner.mjs';

async function run(options) {
  const output = await outside(options.output || path.resolve('dataset/validation'), SOURCE_KEYS.map(key => options[key]));
  const ledgerRoot = await outside(options.accessLedger || path.join(output, 'access-ledger'), SOURCE_KEYS.map(key => options[key]));
  const plan = await readPlan(options.plan);
  const core = plan.plan_core;
  if (!core.evidence_id || !core.evidence_sha256) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'DISCLOSURE_EVIDENCE_MISSING' });
  }
  const evidenceDirectory = path.join(output, 'evidence', 'exports', core.evidence_id);
  await inspectEvidence(evidenceDirectory);
  const evidence = JSON.parse((await readSafe(path.join(evidenceDirectory, 'evidence.json'))).toString('utf8'));
  if (hash(canonicalJson(evidence)) !== core.evidence_sha256 ||
      evidence.model_dataset_id !== core.source.model.id ||
      evidence.validation_csv_sha256 !== core.validation_csv_sha256) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'DISCLOSURE_EVIDENCE_MISMATCH' });
  }
  if (options.mode && (options.mode === 'development' ? 'DEVELOPMENT_VALIDATION' : options.mode === 'formal'
    ? 'FORMAL_VALIDATION' : null) !== core.mode) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'MODE_MISMATCH' });
  const formal = core.validation_policy_version === 3 && core.mode === 'FORMAL_VALIDATION' && core.status === 'READY_FORMAL';
  if (!formal && (core.mode !== 'DEVELOPMENT_VALIDATION' || core.status !== 'READY_DEVELOPMENT' || core.result_usage !== 'DEVELOPMENT_ONLY')) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'FORMAL_UPSTREAM_NOT_READY' });
  }
  if (formal) await loadFormalContext({ ...options, formalContext: core.formal_context });
  const audited = await auditSources(options, options);
  const input = await readValidationInput(options, audited, { mode: core.mode, progress: options.progress,
    root: options.root, loadReplay: false, validationPolicyVersion: core.validation_policy_version });
  if (canonicalJson(sourceIdentity(audited)) !== canonicalJson(core.source) ||
      hash(canonicalJson(audited.sourceFingerprints)) !== core.source_fingerprints_sha256 ||
      input.validationCsvSha256 !== core.validation_csv_sha256 ||
      canonicalJson(input.candidates.map(({ resolved }) => ({
        candidate_id: resolved.candidate_id, canonical_vector: resolved.canonical_vector,
        effective_config_sha256: resolved.effective_config_sha256,
        changed_unit_count: resolved.changed_unit_count,
        normalized_parameter_distance: resolved.normalized_parameter_distance
      }))) !== canonicalJson(core.candidates)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'PLAN_SOURCE_CHANGED' });
  }
  const protectedFiles = {};
  for (const file of [path.join(options.plan, 'validation_plan.json'), path.join(options.plan, 'plan_manifest.json'),
    path.join(evidenceDirectory, 'evidence.json'), path.join(evidenceDirectory, 'manifest.json')]) {
    protectedFiles[file] = hash(await readSafe(file));
  }
  if (formal) protectedFiles[path.join(evidenceDirectory, 'campaign_source.json')] = hash(await readSafe(path.join(evidenceDirectory, 'campaign_source.json')));
  if (options.historyLedgers) protectedFiles[options.historyLedgers] = hash(await readSafe(options.historyLedgers));
  const sourceCheck = await validationFingerprint(options, audited, protectedFiles, options.root);
  return withPlanLock(ledgerRoot, plan.plan_id, async () => {
    const attemptId = runId();
    let authorization;
    const histories = formal ? await historySnapshots({ ...options, accessLedger: ledgerRoot }) : null;
    const shortLock = operation => histories ? withHistoryLocks(histories.roots, operation) : withLedgerLock(ledgerRoot, operation);
    await shortLock(async () => {
    const ledger = await readLedger(ledgerRoot);
    if (formal) {
      const current = await historySnapshots({ ...options, accessLedger: ledgerRoot });
      if (canonicalJson(current.history.map(x => x.key).sort()) !== canonicalJson(core.history_prefixes.map(x => x.key).sort()) ||
          core.history_prefixes.some(prior => !ledgerPrefixMatches(current.history.find(x => x.key === prior.key), prior))) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'FORMAL_HISTORY_PREFIX_MISMATCH' });
      if (historyOverlap(current.history, [...core.formal_context.campaign.files['summary.json'].split_members.VALIDATION,
        ...core.formal_context.campaign.files['summary.json'].split_members.TEST], { allowPlanId: plan.plan_id }).length) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'VALIDATION_PREVIOUSLY_EXPOSED' });
    }
    if (!ledgerPrefixMatches(ledger, { sequence: core.ledger_prefix_sequence,
      sha256: core.ledger_prefix_sha256 }) ||
      !ledger.rows.some(row => row.action === 'PLAN_REGISTERED' && row.plan_id === plan.plan_id)) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'LEDGER_PREFIX_MISMATCH' });
    }
    const attempt = ledger.rows.some(row => row.action === 'FIRST_ACCESS_RESERVED' && row.plan_id === plan.plan_id)
      ? 'RETRY' : 'FIRST_ACCESS_RESERVED';
    authorization = await appendLedger(ledgerRoot, { plan_id: plan.plan_id, action: attempt,
      cohort_sha256: core.validation_members_sha256, attempt_id: attemptId, mode: core.mode,
      purpose: 'PHASE7_RUN', evidence_id: core.evidence_id, evidence_sha256: core.evidence_sha256,
      ...(formal ? { campaign_id: core.campaign_id, members: core.formal_context.campaign.files['summary.json'].split_members.VALIDATION,
        member_event_ids: [...new Set(input.rows.map(row => row.event_id))].sort() } : {}) });
    });
    const ledgerEntry = { audit_contract_revision: 1,
      authorization_entry_sha256: authorization.entry_sha256,
      plan_id: plan.plan_id, cohort_sha256: core.validation_members_sha256,
      evidence_id: core.evidence_id, evidence_sha256: core.evidence_sha256,
      attempt_id: attemptId,
      source_ids: core.source, source_fingerprints_sha256: core.source_fingerprints_sha256,
      runtime_bundle_sha256: process.env.SUNSETSCORE_RUNTIME_BUNDLE_SHA256 || null,
      member_event_ids: [...new Set(input.rows.map(row => row.event_id))].sort(),
      mode: core.mode, purpose: 'PHASE7_RUN', actor: 'local_operator', result_id: null };
    await recordLedger(ledgerRoot, { ...ledgerEntry, action: 'RUN_STARTED' });
    let published, recomputeReceipt;
    try {
      await sourceCheck();
      input.cohort = (await readValidationInput(options, audited, { root: options.root, mode: core.mode,
        loadReplay: true, validationPolicyVersion: core.validation_policy_version })).cohort;
      const built = await buildValidationResult({ plan, input, audited,
        runReplay: options.runReplay || ((replay, runOptions) => runReplay(replay, { ...runOptions, engineRoot: options.root })),
        progress: options.progress });
      const manifest = packageManifest(built.files, plan.plan_id);
      published = await publishValidation({ output, files: built.files, manifest, sourceCheck,
        prepublish: async staging => {
          await sourceCheck();
          await recordLedger(ledgerRoot, { ...ledgerEntry, action: 'PREPUBLISH_RECOMPUTE_STARTED',
            result_id: manifest.validation_id });
          try {
            const rebuilt = await isolatedRecompute({ plan, audited,
              paths: Object.fromEntries(EXPERIMENT_PATH_KEYS.filter(key => options[key]).map(key => [key, options[key]])), root: options.root });
            const staged = await inspectValidation(staging);
            const comparison = compareRecompute(staged.files, staged.manifest, rebuilt);
            await sourceCheck();
            recomputeReceipt = await recordLedger(ledgerRoot, { ...ledgerEntry,
              action: 'PREPUBLISH_RECOMPUTE_COMPLETED', result_id: manifest.validation_id,
              descriptor_sha256: manifest.descriptor_sha256, comparison });
          } catch (error) {
            await recordLedger(ledgerRoot, { ...ledgerEntry, action: 'PREPUBLISH_RECOMPUTE_FAILED',
              result_id: manifest.validation_id, error_code: error.code || 'VALIDATION_OPERATION_FAILED',
              differing_files: error.differing_files || [] });
            throw error;
          }
        } });
      const validated = await inspectValidation(published.directory);
      try {
        await recordLedger(ledgerRoot, { ...ledgerEntry, action: 'RUN_COMPLETED', result_id: validated.validation_id,
          prepublish_entry_sha256: recomputeReceipt.entry_sha256, descriptor_sha256: manifest.descriptor_sha256 });
      } catch { fail('PUBLISHED_AUDIT_INCOMPLETE', { validation_id: validated.validation_id }); }
      const selection = JSON.parse(validated.files['selection_result.json']);
      return { status: published.status, mode: core.mode, result_usage: selection.result_usage,
        validation_id: validated.validation_id, directory: published.directory,
        plan_id: plan.plan_id, candidate_count: validated.candidate_count,
        selected_candidate_id: selection.selected_candidate_id, formal_promotion_allowed: selection.formal_promotion_allowed };
    } catch (error) {
      if (published) fail('PUBLISHED_AUDIT_INCOMPLETE', { validation_id: published.validation_id });
      await recordLedger(ledgerRoot, { ...ledgerEntry, action: 'RUN_FAILED',
        error_code: error.code || 'VALIDATION_OPERATION_FAILED' });
      throw error;
    }
  });
}

export async function runValidation(options) {
  if (options.validationPolicyVersion !== undefined) fail('INVALID_ARGUMENTS');
  const core = (await readPlan(options.plan)).plan_core;
  if (core.validation_policy_version === 3) return withFormalLeases('validation', options,
    options.output || path.resolve('dataset/validation'), () => run(options));
  return withValidationLeases('validation', options,
    options.output || path.resolve('dataset/validation'), () => run(options));
}

if (isMain(import.meta.url)) await runCli('run', runValidation);
