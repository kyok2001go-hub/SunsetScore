import path from 'node:path';
import { appendFile, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { canonicalJson, compare, fail, hash, inventory, readSafe, removeOwned, runId, safePath, unique } from '../../dataset/lib/common.mjs';

const GENESIS = '0'.repeat(64);

export async function withPlanLock(root, planId, operation) {
  const active = await safePath(path.join(root, 'active'));
  await mkdir(active, { recursive: true });
  const lock = path.join(active, hash(planId) + '.lock');
  try { await mkdir(lock); }
  catch (error) { if (error.code === 'EEXIST') fail('VALIDATION_ACCESS_BUSY'); throw error; }
  try { return await operation(); } finally { await rmdir(lock); }
}
export async function recordLedger(root, entry) {
  return withLedgerLock(root, () => appendLedger(root, { audit_contract_revision: 1, ...entry }));
}

export function publicationReceipt(ledger, planId, resultId, descriptorSha256) {
  return ledger.rows.find(row => row.action === 'PREPUBLISH_RECOMPUTE_COMPLETED' &&
    row.plan_id === planId && row.result_id === resultId && row.descriptor_sha256 === descriptorSha256 &&
    row.comparison?.status === 'PASS' && row.comparison.descriptor_sha256 === descriptorSha256 &&
    ledger.rows.some(started => started.action === 'PREPUBLISH_RECOMPUTE_STARTED' &&
      started.plan_id === planId && started.result_id === resultId && started.attempt_id === row.attempt_id) &&
    ledger.rows.some(started => started.action === 'RUN_STARTED' && started.plan_id === planId &&
      started.attempt_id === row.attempt_id));
}
/** Called only after a successful full recompute while the caller owns the Plan lock. */
export async function completePublicationRecovery(root, entry, descriptorSha256) {
  return withLedgerLock(root, async () => {
    const ledger = await readLedger(root);
    const prepublish = publicationReceipt(ledger, entry.plan_id, entry.result_id, descriptorSha256);
    if (!prepublish) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'PREPUBLISH_RECEIPT_MISSING' });
    const completed = ledger.rows.find(row => row.action === 'RUN_COMPLETED' && row.plan_id === entry.plan_id && row.result_id === entry.result_id);
    if (!completed) {
      const { sequence, previous_sha256, at_utc, entry_sha256, ...prior } = prepublish;
      await appendLedger(root, { ...prior, action: 'RUN_COMPLETED',
        prepublish_entry_sha256: prepublish.entry_sha256, recovered: true });
    }
    if (!ledger.rows.some(row => row.action === 'PUBLISH_RECOVERED' && row.result_id === entry.result_id && row.plan_id === entry.plan_id)) {
      await appendLedger(root, { ...entry, action: 'PUBLISH_RECOVERED', prepublish_entry_sha256: prepublish.entry_sha256 });
    }
    return { status: completed ? 'ALREADY_COMPLETED' : 'RECOVERED' };
  });
}

function ledgerFile(root) { return path.join(root, 'access.jsonl'); }

export async function readLedger(root) {
  await safePath(root);
  let text;
  try { text = (await readFile(ledgerFile(root))).toString('utf8'); }
  catch (error) { if (error.code === 'ENOENT') text = ''; else throw error; }
  if (text && !text.endsWith('\n')) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'LEDGER_TRUNCATED' });
  const rows = text.trim() ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
  let previous = GENESIS;
  rows.forEach((row, index) => {
    const { entry_sha256, ...payload } = row;
    if (row.sequence !== index + 1 || row.previous_sha256 !== previous ||
        hash(canonicalJson(payload)) !== entry_sha256 || canonicalJson(row) !== text.trimEnd().split('\n')[index]) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'LEDGER_CHAIN_INVALID' });
    }
    previous = entry_sha256;
  });
  return { rows, sequence: rows.length, sha256: previous };
}

export function ledgerPrefixMatches(ledger, prefix) {
  if (!Number.isInteger(prefix.sequence) || prefix.sequence < 0 || prefix.sequence > ledger.rows.length) return false;
  return (prefix.sequence === 0 ? GENESIS : ledger.rows[prefix.sequence - 1].entry_sha256) === prefix.sha256;
}

export async function withLedgerLock(root, operation) {
  await safePath(root);
  await mkdir(root, { recursive: true });
  const lock = path.join(root, 'access.lock');
  await safePath(lock);
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') fail('VALIDATION_ACCESS_BUSY');
    throw error;
  }
  try { return await operation(); }
  finally { await rmdir(lock); }
}

export async function appendLedger(root, entry) {
  if (['sequence', 'previous_sha256', 'entry_sha256', 'at_utc'].some(key => key in entry)) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'LEDGER_RESERVED_FIELD' });
  }
  const current = await readLedger(root);
  const payload = { sequence: current.sequence + 1, previous_sha256: current.sha256,
    at_utc: new Date().toISOString(), ...entry };
  const record = { ...payload, entry_sha256: hash(canonicalJson(payload)) };
  const file = await safePath(ledgerFile(root));
  await appendFile(file, canonicalJson(record) + '\n', 'utf8');
  return record;
}

export function eventMembership(rows) {
  const map = new Map();
  for (const row of rows) {
    const item = { event_id: row.event_id, location_key: row.location_key,
      event_date_local: row.event_date_local };
    const prior = map.get(item.event_id);
    if (prior && canonicalJson(prior) !== canonicalJson(item)) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'EVENT_IDENTITY_CONFLICT' });
    }
    map.set(item.event_id, item);
  }
  return [...map.values()].sort((a, b) => compare(a.event_id, b.event_id));
}

export function makeDevelopmentEvidence({ rows, modelId, csvSha256, prefix }) {
  const members = eventMembership(rows);
  const core = {
    evidence_schema_version: 1, mode: 'DEVELOPMENT_VALIDATION',
    model_dataset_id: modelId, validation_csv_sha256: csvSha256,
    members, member_sha256: hash(canonicalJson(members)),
    date_set_sha256: hash(canonicalJson(unique(members.map(row => row.event_date_local)))),
    ledger_prefix_sequence: prefix.sequence, ledger_prefix_sha256: prefix.sha256,
    validation_disclosure_status: 'DEVELOPMENT_EXPOSED',
    historical_exposure_audit: 'DEVELOPMENT_ONLY',
    human_declaration: null, reviewer: null, reviewed_at_utc: null,
    allowed_purpose: 'DEVELOPMENT_VALIDATION'
  };
  const digest = hash(canonicalJson(core));
  return { evidence_id: `validation_evidence_v1_${digest.slice(0, 16)}`,
    sha256: digest, core };
}

export function evidenceManifest(evidence, modelManifestSha256 = null) {
  const file = { sha256: evidence.sha256,
    bytes: Buffer.byteLength(canonicalJson(evidence.core)) };
  const descriptor = { evidence_schema_version: 1, evidence_id: evidence.evidence_id,
    evidence_sha256: evidence.sha256, model_dataset_id: evidence.core.model_dataset_id,
    model_dataset_manifest_sha256: modelManifestSha256,
    ledger_prefix_sequence: evidence.core.ledger_prefix_sequence,
    ledger_prefix_sha256: evidence.core.ledger_prefix_sha256,
    files: { 'evidence.json': file } };
  return { ...descriptor, descriptor,
    descriptor_sha256: hash(canonicalJson(descriptor)), files: descriptor.files,
    validation_disclosure_status: evidence.core.validation_disclosure_status };
}

export async function inspectEvidence(directory) {
  const manifestBytes = await readSafe(path.join(directory, 'manifest.json'));
  if (JSON.parse(manifestBytes).evidence_schema_version === 2) return (await import('./formal-evidence.mjs')).inspectFormalEvidence(directory);
  const evidenceBytes = await readSafe(path.join(directory, 'evidence.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const core = JSON.parse(evidenceBytes.toString('utf8'));
  const digest = hash(canonicalJson(core));
  const evidence = { evidence_id: `validation_evidence_v1_${digest.slice(0, 16)}`,
    sha256: digest, core };
  if (canonicalJson(manifest) !== manifestBytes.toString('utf8') ||
      canonicalJson(core) !== evidenceBytes.toString('utf8') ||
      canonicalJson(manifest) !== canonicalJson(evidenceManifest(evidence, manifest.model_dataset_manifest_sha256)) ||
      canonicalJson(await inventory(directory)) !== canonicalJson(['evidence.json', 'manifest.json']) ||
      path.basename(directory) !== evidence.evidence_id) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'EVIDENCE_PACKAGE_INVALID' });
  }
  return { status: 'PASS', validation_scope: 'PACKAGE_INTERNAL', evidence_id: evidence.evidence_id };
}

export async function publishEvidence(outputRoot, evidence, modelManifestSha256 = null, campaign = null) {
  if (evidence.core.evidence_schema_version === 2) return (await import('./formal-evidence.mjs')).publishFormalEvidence(outputRoot, evidence, campaign);
  const target = await safePath(path.join(outputRoot, 'evidence', 'exports', evidence.evidence_id));
  await mkdir(path.dirname(target), { recursive: true });
  const stagingRoot = await safePath(path.join(outputRoot, 'staging'));
  await mkdir(stagingRoot, { recursive: true });
  const staging = await safePath(path.join(stagingRoot, runId()));
  await mkdir(staging);
  await writeFile(path.join(staging, 'evidence.json'), canonicalJson(evidence.core), { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(staging, 'manifest.json'),
    canonicalJson(evidenceManifest(evidence, modelManifestSha256)), { encoding: 'utf8', flag: 'wx' });
  try { await rename(staging, target); }
  catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    const existing = JSON.parse((await readFile(path.join(target, 'evidence.json'))).toString('utf8'));
    if (canonicalJson(existing) !== canonicalJson(evidence.core)) fail('VALIDATION_ID_CONFLICT');
    await removeOwned(stagingRoot, staging);
  }
  return target;
}
