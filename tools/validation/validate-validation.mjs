#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, fail, hash, isMain, readSafe } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { inspectValidation, packageManifest } from './lib/package.mjs';
import { auditSources, MODEL_ALLOW_FILES, readValidationInput, sourceIdentity } from './lib/source.mjs';
import { buildValidationResult } from './lib/build.mjs';
import { ledgerPrefixMatches, readLedger } from './lib/disclosure.mjs';
import { inspectOptimization } from '../optimization/validate-optimization.mjs';
import { loadModelHeader, readSplitRows } from '../tuning/lib/input.mjs';
import { withValidationLeases } from './lib/lease.mjs';

export async function validateValidation(options) {
  const inspected = await inspectValidation(options.path);
  if (!options.model) return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL',
    validation_id: inspected.validation_id, result_usage: inspected.manifest.descriptor.result_usage };
  if (inspected.manifest.test_fixture_only === true) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'TEST_FIXTURE_SOURCE_LINK_FORBIDDEN' });
  }
  const plan = JSON.parse(inspected.files['validation_plan.json']);
  const core = plan.plan_core;
  const modelManifest = JSON.parse((await readSafe(path.join(options.model, 'manifest.json'))).toString('utf8'));
  const optimizationManifest = JSON.parse((await readSafe(path.join(options.optimization, 'manifest.json'))).toString('utf8'));
  if (hash(await readSafe(path.join(options.model, 'manifest.json'))) !== core.source.model.manifest_sha256 ||
      hash(await readSafe(path.join(options.optimization, 'manifest.json'))) !== core.source.optimization.manifest_sha256 ||
      modelManifest.model_dataset_id !== core.source.model.id ||
      optimizationManifest.optimization_id !== core.source.optimization.id ||
      optimizationManifest.model_dataset_id !== modelManifest.model_dataset_id) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'MODEL_OPTIMIZATION_IDENTITY_MISMATCH' });
  }
  await inspectOptimization(options.optimization);
  const header = await loadModelHeader(options.model, { allowFiles: MODEL_ALLOW_FILES,
    progress: options.progress });
  const validationRows = await readSplitRows(options.model, { manifest: header.manifest,
    schemaVersion: header.schemaVersion, split: 'VALIDATION',
    allowFiles: MODEL_ALLOW_FILES, progress: options.progress });
  const members = validationRows.map(row => ({ snapshot_id: row.snapshot_id,
    event_id: row.event_id, location_key: row.location_key,
    event_date_local: row.event_date_local }));
  const finalists = JSON.parse((await readSafe(path.join(options.optimization, 'finalists.json'))).toString('utf8'));
  if (hash(await readSafe(path.join(options.model, 'splits', 'validation.csv'))) !== core.validation_csv_sha256 ||
      canonicalJson(members) !== canonicalJson(core.validation_members) ||
      canonicalJson(finalists.finalists.map(row => ({ candidate_id: row.candidate_id,
        canonical_vector: row.canonical_vector, effective_config_sha256: row.effective_config_sha256 }))) !==
        canonicalJson(core.candidates.map(row => ({ candidate_id: row.candidate_id,
          canonical_vector: row.canonical_vector,
          effective_config_sha256: row.effective_config_sha256 })))) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'MODEL_OPTIMIZATION_COHORT_MISMATCH' });
  }
  if (!options.raw) return { status: 'PASS', validation_scope: 'MODEL_LINKED',
    validation_id: inspected.validation_id, result_usage: inspected.manifest.descriptor.result_usage };
  const validationRoot = path.dirname(path.dirname(options.path));
  return withValidationLeases('validation_verify', options, validationRoot, async () => {
  const ledger = await readLedger(options.accessLedger || path.join(validationRoot, 'access-ledger'));
  if (!ledgerPrefixMatches(ledger, { sequence: core.ledger_prefix_sequence,
    sha256: core.ledger_prefix_sha256 }) ||
      !ledger.rows.some(row => row.action === 'PLAN_REGISTERED' &&
        row.plan_id === inspected.plan_id && row.evidence_id === core.evidence_id) ||
      !ledger.rows.some(row => row.action === 'RUN_COMPLETED' &&
        row.result_id === inspected.validation_id)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'LEDGER_RECEIPT_MISMATCH' });
  }
  const audited = await auditSources(options, options);
  if (canonicalJson(sourceIdentity(audited)) !== canonicalJson(core.source)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'SOURCE_IDENTITY_MISMATCH' });
  }
  const input = await readValidationInput(options, audited, {
    mode: core.mode, progress: options.progress, loadReplay: true
  });
  if (input.validationCsvSha256 !== core.validation_csv_sha256) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'VALIDATION_COHORT_CHANGED' });
  }
  const rebuilt = await buildValidationResult({ plan, input, audited, progress: options.progress });
  const remanifest = packageManifest(rebuilt.files, inspected.plan_id, {
    legacy: inspected.manifest.descriptor?.manifest_contract_revision == null
  });
  if (canonicalJson(remanifest) !== canonicalJson(inspected.manifest)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'SOURCE_RECOMPUTE_MISMATCH' });
  }
  return { status: 'PASS', validation_scope: 'SOURCE_LINKED_RECOMPUTED',
    validation_id: inspected.validation_id, result_usage: inspected.manifest.descriptor.result_usage };
  });
}

if (isMain(import.meta.url)) await runCli('validate', validateValidation);
