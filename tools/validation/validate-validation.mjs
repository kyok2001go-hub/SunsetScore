#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, fail, hash, isMain, readSafe, runId } from '../dataset/lib/common.mjs';
import { runCli } from './lib/cli.mjs';
import { inspectValidation, readPlan } from './lib/package.mjs';
import { auditSources, MODEL_ALLOW_FILES, sourceIdentity } from './lib/source.mjs';
import { ledgerPrefixMatches, readLedger, withPlanLock, withLedgerLock, recordLedger, inspectEvidence,
  publicationReceipt, completePublicationRecovery } from './lib/disclosure.mjs';
import { compareRecompute, isolatedRecompute, validationFingerprint } from './lib/recompute.mjs';
import { SOURCE_KEYS } from './lib/source.mjs';
import { fingerprintSourcePackage } from '../optimization/lib/input.mjs';
import { inspectOptimization } from '../optimization/validate-optimization.mjs';
import { loadModelHeader, readSplitRows } from '../tuning/lib/input.mjs';
import { withValidationLeases } from './lib/lease.mjs';
import { validationSupport } from './validation-policy.mjs';
import { supportCohort } from '../gt-level-support.mjs';
import { EXPERIMENT_PATH_KEYS } from './lib/source.mjs';
import { inspectFormalContext, validateFormalSourceContext, withFormalLeases } from '../formal/context.mjs';
import { TEST_FIXTURE } from '../formal/contracts.mjs';
import { historySnapshots, withHistoryLocks } from '../campaign/campaign.mjs';

async function validateCore(options) {
  const inspected = await inspectValidation(options.path);
  if (!options.model) return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL',
    validation_id: inspected.validation_id, result_usage: inspected.manifest.descriptor.result_usage };
  if (inspected.manifest.test_fixture_only === true && !(inspected.manifest.validation_policy_version === 3 && options.testFixture === TEST_FIXTURE)) {
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
  await inspectOptimization(options.optimization, { root: options.root });
  const header = await loadModelHeader(options.model, { allowFiles: MODEL_ALLOW_FILES,
    progress: options.progress });
  const validationRows = await readSplitRows(options.model, { manifest: header.manifest,
    schemaVersion: header.schemaVersion, split: 'VALIDATION',
    allowFiles: MODEL_ALLOW_FILES, progress: options.progress });
  if (core.validation_policy_version >= 2 && (optimizationManifest.optimization_policy_version !== core.validation_policy_version ||
      canonicalJson(supportCohort(validationRows)) !== canonicalJson(core.gt_level_support_cohort) ||
      canonicalJson(validationSupport(validationRows, core.validation_policy_version)) !== canonicalJson(core.support) ||
      canonicalJson(optimizationManifest.upstream_train_support) !== canonicalJson(core.upstream_train_support))) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'MODEL_LINKED_SUPPORT_MISMATCH' });
  }
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
  const leased = operation => core.validation_policy_version === 3 ? operation() : withValidationLeases('validation_verify', options, validationRoot, operation);
  return leased(async () => {
  const ledgerRoot = options.accessLedger || path.join(validationRoot, 'access-ledger');
  return withPlanLock(ledgerRoot, inspected.plan_id, async () => {
  const ledger = await withLedgerLock(ledgerRoot, () => readLedger(ledgerRoot));
  const completed = ledger.rows.find(row => row.action === 'RUN_COMPLETED' && row.result_id === inspected.validation_id && row.plan_id === inspected.plan_id);
  const prepublish = publicationReceipt(ledger, inspected.plan_id, inspected.validation_id, inspected.manifest.descriptor_sha256);
  if (!ledgerPrefixMatches(ledger, { sequence: core.ledger_prefix_sequence,
    sha256: core.ledger_prefix_sha256 }) ||
      !ledger.rows.some(row => row.action === 'PLAN_REGISTERED' &&
        row.plan_id === inspected.plan_id && row.evidence_id === core.evidence_id) ||
      !(completed || options.recoverPublication && prepublish && ledger.rows.some(row => row.action === 'RUN_STARTED' &&
        row.attempt_id === prepublish.attempt_id && row.plan_id === inspected.plan_id))) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'LEDGER_RECEIPT_MISMATCH' });
  }
  const authorization = ledger.rows.find(row => row.action === 'FIRST_ACCESS_RESERVED' && row.plan_id === inspected.plan_id);
  if (!authorization) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'FIRST_ACCESS_RECEIPT_MISSING' });
  if (core.validation_policy_version === 3) {
    inspectFormalContext(core.formal_context);
    const histories = await historySnapshots({ ...options, accessLedger: ledgerRoot });
    await withHistoryLocks(histories.roots, async () => {
      const current = await historySnapshots({ ...options, accessLedger: ledgerRoot });
      if (canonicalJson(current.history.map(x => x.key).sort()) !== canonicalJson(core.history_prefixes.map(x => x.key).sort()) ||
          core.history_prefixes.some(prior => !ledgerPrefixMatches(current.history.find(x => x.key === prior.key), prior)) ||
          authorization.cohort_sha256 !== core.validation_members_sha256 || authorization.evidence_sha256 !== core.evidence_sha256 ||
          canonicalJson(authorization.members) !== canonicalJson(core.formal_context.campaign.files['summary.json'].split_members.VALIDATION)) {
        fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'FORMAL_ACCESS_RECEIPT_MISMATCH' });
      }
    });
    await validateFormalSourceContext(core.formal_context, options);
  }
  const entry = { plan_id: inspected.plan_id, result_id: inspected.validation_id, attempt_id: runId(),
    mode: core.mode, purpose: options.recoverPublication ? 'PHASE7_PUBLISH_RECOVERY' : 'PHASE7_VERIFY',
    evidence_id: core.evidence_id, evidence_sha256: core.evidence_sha256,
    cohort_sha256: core.validation_members_sha256, source_ids: core.source,
    authorization_entry_sha256: authorization.entry_sha256,
    runtime_bundle_sha256: process.env.SUNSETSCORE_RUNTIME_BUNDLE_SHA256 || null };
  await recordLedger(ledgerRoot, { ...entry, action: 'VERIFY_RECOMPUTE_STARTED' });
  try {
  const evidenceDirectory = path.join(validationRoot, 'evidence/exports', core.evidence_id);
  await inspectEvidence(evidenceDirectory);
  if (hash(await readSafe(path.join(evidenceDirectory, 'evidence.json'))) !== core.evidence_sha256) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'DISCLOSURE_EVIDENCE_MISMATCH' });
  }
  const protectedFiles = {};
  if (core.validation_policy_version === 3) protectedFiles[path.join(evidenceDirectory, 'campaign_source.json')] = hash(await readSafe(path.join(evidenceDirectory, 'campaign_source.json')));
  if (options.historyLedgers) protectedFiles[options.historyLedgers] = hash(await readSafe(options.historyLedgers));
  for (const file of [path.join(evidenceDirectory, 'manifest.json'), path.join(evidenceDirectory, 'evidence.json'),
    path.join(validationRoot, 'plans', inspected.plan_id, 'validation_plan.json'),
    path.join(validationRoot, 'plans', inspected.plan_id, 'plan_manifest.json')]) protectedFiles[file] = hash(await readSafe(file));
  const resultFingerprint = await fingerprintSourcePackage(options.path);
  if (resultFingerprint['manifest.json'] !== hash(canonicalJson(inspected.manifest)) ||
      Object.entries(inspected.files).some(([name, value]) => resultFingerprint[name] !== hash(value))) fail('VALIDATION_RESULT_CHANGED');
  const externalPlan = await readPlan(path.join(validationRoot, 'plans', inspected.plan_id));
  if (externalPlan.plan_id !== inspected.plan_id || canonicalJson(externalPlan.plan_core) !== canonicalJson(core)) {
    fail('VALIDATION_PLAN_SOURCE_CHANGED');
  }
  const audited = await auditSources(options, options);
  if (canonicalJson(sourceIdentity(audited)) !== canonicalJson(core.source) ||
      hash(canonicalJson(audited.sourceFingerprints)) !== core.source_fingerprints_sha256) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'SOURCE_IDENTITY_MISMATCH' });
  }
  const sourceCheck = await validationFingerprint(options, audited, protectedFiles, options.root);
  await sourceCheck();
  const rebuilt = await isolatedRecompute({ plan: { ...plan, plan_id: inspected.plan_id }, audited,
    paths: Object.fromEntries(EXPERIMENT_PATH_KEYS.filter(key => options[key]).map(key => [key, options[key]])), root: options.root,
    legacy: inspected.manifest.descriptor?.manifest_contract_revision == null });
  const comparison = compareRecompute(inspected.files, inspected.manifest, rebuilt);
  await sourceCheck();
  if (canonicalJson(await fingerprintSourcePackage(options.path)) !== canonicalJson(resultFingerprint)) fail('VALIDATION_RESULT_CHANGED');
  await recordLedger(ledgerRoot, { ...entry, action: 'VERIFY_RECOMPUTE_COMPLETED', comparison });
  if (options.recoverPublication && prepublish) await completePublicationRecovery(ledgerRoot, entry, inspected.manifest.descriptor_sha256);
  return { status: 'PASS', validation_scope: 'SOURCE_LINKED_RECOMPUTED',
    validation_id: inspected.validation_id, result_usage: inspected.manifest.descriptor.result_usage };
  } catch (error) {
    await recordLedger(ledgerRoot, { ...entry, action: 'VERIFY_RECOMPUTE_FAILED',
      error_code: error.code || 'VALIDATION_OPERATION_FAILED' });
    throw error;
  }
  });
  });
}

export async function validateValidation(options) {
  if (options.raw) {
    const manifest = JSON.parse(await readSafe(path.join(options.path, 'manifest.json')));
    if (manifest.validation_policy_version === 3) return withFormalLeases('validation_verify', options,
      path.dirname(path.dirname(options.path)), () => validateCore(options));
  }
  return validateCore(options);
}

if (isMain(import.meta.url)) await runCli('validate', validateValidation);
