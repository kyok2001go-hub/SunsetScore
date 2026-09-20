import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail } from '../dataset/lib/common.mjs';

export const TOOL_VERSION = '2.5.2.2';
export const MAINTENANCE_SCHEMA_VERSION = 1;

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DATASET_ROOT = path.join(APP_ROOT, 'dataset');

/** The CLI prefers `<cwd>/dataset` so it works both inside SunsetScore-main and from the repo root. */
export function resolveDefaultDatasetRoot(cwd = process.cwd()) {
  const local = path.resolve(cwd, 'dataset');
  return existsSync(local) ? local : DEFAULT_DATASET_ROOT;
}

/**
 * The maintenance gate lives next to the data it protects. Phase 1 writes `<output>/exports`,
 * so its dataset root is the output itself; the other four write `<output>/exports`, so their
 * dataset root is the output's parent. Deriving this from the output keeps temporary or custom
 * build roots from sharing the default `dataset/` gate.
 */
export function datasetRootForPhaseOutput(phaseKey, outputRoot) {
  const resolved = path.resolve(outputRoot);
  return phaseKey === 'raw' ? resolved : path.dirname(resolved);
}

export const EDGE_KINDS = Object.freeze(['SOURCE', 'REFERENCE', 'EVIDENCE']);

/**
 * Advisory diagnostics never block a prune plan; every other code does. Anything that makes a
 * package's lineage uncertain has to stop the plan rather than guess at the dependents.
 */
export const ADVISORY_DIAGNOSTIC_CODES = Object.freeze(['UNEXPECTED_FILE', 'IGNORED_ENTRY']);

export const PHASES = Object.freeze([
  Object.freeze({
    phase: 1, key: 'raw', label: 'Phase 1 Raw Dataset', relativeRoot: 'exports',
    idField: 'dataset_id', schemaField: 'offline_dataset_schema_version', policyField: null,
    supportedVersions: Object.freeze([[1, null]])
  }),
  Object.freeze({
    phase: 2, key: 'ground_truth', label: 'Phase 2 Ground Truth', relativeRoot: 'ground_truth/exports',
    idField: 'ground_truth_id', schemaField: 'ground_truth_schema_version', policyField: 'gt_policy_version',
    supportedVersions: Object.freeze([[1, 1], [2, 1], [3, 2]])
  }),
  Object.freeze({
    phase: 3, key: 'model', label: 'Phase 3 Model Dataset', relativeRoot: 'model/exports',
    idField: 'model_dataset_id', schemaField: 'model_dataset_schema_version', policyField: 'model_dataset_policy_version',
    supportedVersions: Object.freeze([[1, 1], [2, 2], [2, 3]])
  }),
  Object.freeze({
    phase: 4, key: 'evaluation', label: 'Phase 4 Baseline Evaluation', relativeRoot: 'evaluation/exports',
    idField: 'evaluation_id', schemaField: 'evaluation_schema_version', policyField: 'evaluation_policy_version',
    supportedVersions: Object.freeze([[1, 1], [2, 2]])
  }),
  Object.freeze({
    phase: 5, key: 'sensitivity', label: 'Phase 5 Parameter Sensitivity', relativeRoot: 'tuning/exports',
    idField: 'sensitivity_id', schemaField: 'tuning_schema_version', policyField: 'tuning_policy_version',
    supportedVersions: Object.freeze([[1, 1], [2, 2]])
  })
]);

export function phaseByKey(key) {
  const phase = PHASES.find(item => item.key === key);
  if (!phase) fail('MAINTENANCE_INTERNAL', { reason_code: 'UNKNOWN_PHASE_KEY', detail: key });
  return phase;
}

export function phaseByNumber(number) {
  const phase = PHASES.find(item => item.phase === Number(number));
  if (!phase) fail('INVALID_ARGUMENTS', { reason_code: 'UNKNOWN_PHASE', detail: number });
  return phase;
}

export function isSupportedVersion(phase, schemaVersion, policyVersion) {
  return phase.supportedVersions.some(([schema, policy]) =>
    schema === schemaVersion && (phase.policyField === null || policy === policyVersion));
}

export function supportedVersionLabel(phase) {
  return phase.supportedVersions
    .map(([schema, policy]) => phase.policyField === null ? `schema ${schema}` : `schema ${schema} / policy ${policy}`)
    .join(', ');
}

/**
 * Declared upstream references of one package, in manifest order. `expectedManifestSha256` is
 * null when the package only names the parent (Tuning repeats Raw / GT without their hashes);
 * those references are still real edges and are cross-checked against the Model package.
 */
export function dependenciesOf(phase, manifest) {
  const dependencies = [];
  const add = (idField, hashField, kind) => {
    const id = manifest[idField];
    if (id === undefined || id === null) return;
    if (typeof id !== 'string' || !id) {
      fail('MAINTENANCE_INVALID_MANIFEST', { reason_code: 'INVALID_DEPENDENCY_ID', detail: idField });
    }
    const declaredHash = hashField ? manifest[hashField] : null;
    if (declaredHash !== undefined && declaredHash !== null && typeof declaredHash !== 'string') {
      fail('MAINTENANCE_INVALID_MANIFEST', { reason_code: 'INVALID_DEPENDENCY_HASH', detail: hashField });
    }
    dependencies.push({ idField, id, expectedManifestSha256: declaredHash ?? null, kind });
  };
  switch (phase.key) {
    case 'ground_truth':
      add('source_dataset_id', 'source_dataset_manifest_sha256', 'SOURCE');
      break;
    case 'model':
      add('source_dataset_id', 'source_dataset_manifest_sha256', 'SOURCE');
      add('ground_truth_id', 'ground_truth_manifest_sha256', 'SOURCE');
      break;
    case 'evaluation':
      add('model_dataset_id', 'model_dataset_manifest_sha256', 'SOURCE');
      break;
    case 'sensitivity':
      add('model_dataset_id', 'model_dataset_manifest_sha256', 'SOURCE');
      add('evaluation_id', 'evaluation_manifest_sha256', 'SOURCE');
      add('source_dataset_id', null, 'REFERENCE');
      add('ground_truth_id', null, 'REFERENCE');
      add('validation_disclosure_evidence_id', 'validation_disclosure_evidence_sha256', 'EVIDENCE');
      break;
    default:
      break;
  }
  return dependencies;
}
