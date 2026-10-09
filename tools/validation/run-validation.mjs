#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, fail, hash, isMain, readSafe, runId } from '../dataset/lib/common.mjs';
import { outside } from '../tuning/lib/input.mjs';
import { withValidationLeases } from './lib/lease.mjs';
import { runCli } from './lib/cli.mjs';
import { auditSources, readValidationInput, sourceIdentity, SOURCE_KEYS, assertSourcesUnchanged } from './lib/source.mjs';
import { appendLedger, inspectEvidence, ledgerPrefixMatches, readLedger, withLedgerLock } from './lib/disclosure.mjs';
import { buildValidationResult } from './lib/build.mjs';
import { inspectValidation, packageManifest, publishValidation, readPlan } from './lib/package.mjs';

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
  if (core.mode !== 'DEVELOPMENT_VALIDATION' || core.status !== 'READY_DEVELOPMENT' ||
      core.result_usage !== 'DEVELOPMENT_ONLY') {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'FORMAL_UPSTREAM_NOT_READY' });
  }
  const audited = await auditSources(options, options);
  const input = await readValidationInput(options, audited, { mode: core.mode, progress: options.progress,
    loadReplay: true, validationPolicyVersion: core.validation_policy_version });
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
  return withLedgerLock(ledgerRoot, async () => {
    const ledger = await readLedger(ledgerRoot);
    if (!ledgerPrefixMatches(ledger, { sequence: core.ledger_prefix_sequence,
      sha256: core.ledger_prefix_sha256 }) ||
      !ledger.rows.some(row => row.action === 'PLAN_REGISTERED' && row.plan_id === plan.plan_id)) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'LEDGER_PREFIX_MISMATCH' });
    }
    const attempt = ledger.rows.some(row => row.action === 'FIRST_ACCESS_RESERVED' && row.plan_id === plan.plan_id)
      ? 'RETRY' : 'FIRST_ACCESS_RESERVED';
    const attemptId = runId();
    const ledgerEntry = { plan_id: plan.plan_id, cohort_sha256: core.validation_members_sha256,
      evidence_id: core.evidence_id, evidence_sha256: core.evidence_sha256,
      attempt_id: attemptId,
      member_event_ids: [...new Set(input.rows.map(row => row.event_id))].sort(),
      mode: core.mode, purpose: 'PHASE7_RUN', actor: 'local_operator', result_id: null };
    await appendLedger(ledgerRoot, { ...ledgerEntry, action: attempt });
    await appendLedger(ledgerRoot, { ...ledgerEntry, action: 'RUN_STARTED' });
    try {
      const built = await buildValidationResult({ plan, input, audited,
        runReplay: options.runReplay, progress: options.progress });
      const manifest = packageManifest(built.files, plan.plan_id);
      const published = await publishValidation({ output, files: built.files, manifest,
        sourceCheck: () => assertSourcesUnchanged(options, audited.sourceFingerprints) });
      const validated = await inspectValidation(published.directory);
      await appendLedger(ledgerRoot, { ...ledgerEntry, action: 'RUN_COMPLETED', result_id: validated.validation_id });
      return { status: published.status, mode: core.mode, result_usage: 'DEVELOPMENT_ONLY',
        validation_id: validated.validation_id, directory: published.directory,
        plan_id: plan.plan_id, candidate_count: validated.candidate_count,
        selected_candidate_id: null, formal_promotion_allowed: false };
    } catch (error) {
      await appendLedger(ledgerRoot, { ...ledgerEntry, action: 'RUN_FAILED',
        error_code: error.code || 'VALIDATION_OPERATION_FAILED' });
      throw error;
    }
  });
}

export async function runValidation(options) {
  if (options.validationPolicyVersion !== undefined) fail('INVALID_ARGUMENTS');
  return withValidationLeases('validation', options,
    options.output || path.resolve('dataset/validation'), () => run(options));
}

if (isMain(import.meta.url)) await runCli('run', runValidation);
