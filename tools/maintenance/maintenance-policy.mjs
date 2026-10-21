import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail } from '../dataset/lib/common.mjs';

export const TOOL_VERSION = '2.5.4';
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
 * so its dataset root is the output itself; Phases 2–6 write `<output>/exports`, so their
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
    supportedVersions: Object.freeze([[1, 1], [2, 2], [2, 3], [2, 4]])
  }),
  Object.freeze({
    phase: 4, key: 'evaluation', label: 'Phase 4 Baseline Evaluation', relativeRoot: 'evaluation/exports',
    idField: 'evaluation_id', schemaField: 'evaluation_schema_version', policyField: 'evaluation_policy_version',
    supportedVersions: Object.freeze([[1, 1], [2, 2], [3, 3]])
  }),
  Object.freeze({
    phase: 5, key: 'sensitivity', label: 'Phase 5 Parameter Sensitivity', relativeRoot: 'tuning/exports',
    idField: 'sensitivity_id', schemaField: 'tuning_schema_version', policyField: 'tuning_policy_version',
    supportedVersions: Object.freeze([[1, 1], [2, 2], [2, 3], [3, 4]])
  }),
  Object.freeze({
    phase: 6, key: 'optimization', label: 'Phase 6 Parameter Optimization', relativeRoot: 'optimization/exports',
    idField: 'optimization_id', schemaField: 'optimization_schema_version',
    policyField: 'optimization_policy_version',
    supportedVersions: Object.freeze([[1, 1], [1, 2], [2, 3], [2, 4], [2, 5]])
  }),
  Object.freeze({
    phase: 7, key: 'validation_evidence', label: 'Phase 7 Disclosure Evidence',
    relativeRoot: 'validation/evidence/exports', idField: 'evidence_id',
    schemaField: 'evidence_schema_version', policyField: null,
    supportedVersions: Object.freeze([[1, null], [2, null]])
  }),
  Object.freeze({
    phase: 8, key: 'validation_plan', label: 'Phase 7 Validation Plan',
    relativeRoot: 'validation/plans', idField: 'validation_plan_id',
    schemaField: 'validation_plan_schema_version', policyField: null,
    supportedVersions: Object.freeze([[1, null], [2, null]])
  }),
  Object.freeze({
    phase: 9, key: 'validation', label: 'Phase 7 Validation Result',
    relativeRoot: 'validation/exports', idField: 'validation_id',
    schemaField: 'validation_schema_version', policyField: 'validation_policy_version',
    supportedVersions: Object.freeze([[1, 1], [1, 2], [2, 3], [2, 4], [2, 5]])
  }),
  Object.freeze({ phase: 10, key: 'experiment_runtime', label: 'Experiment Runtime',
    relativeRoot: 'experiment_runtime/exports', idField: 'runtime_bundle_id',
    schemaField: 'experiment_runtime_protocol_version', policyField: null, supportedVersions: Object.freeze([[1, null], [2, null]]) }),
  Object.freeze({ phase: 11, key: 'replay_quality_plan', label: 'Replay Quality Plan',
    relativeRoot: 'replay_quality/plans/exports', idField: 'replay_quality_plan_id',
    schemaField: 'governance_schema_version', policyField: null, supportedVersions: Object.freeze([[1, null]]) }),
  Object.freeze({ phase: 12, key: 'replay_quality_report', label: 'Replay Quality Report',
    relativeRoot: 'replay_quality/exports', idField: 'replay_quality_report_id',
    schemaField: 'governance_schema_version', policyField: null, supportedVersions: Object.freeze([[1, null]]) }),
  Object.freeze({ phase: 13, key: 'runtime_execution', label: 'Runtime Execution Receipt',
    relativeRoot: 'experiment_runtime/executions/exports', idField: 'execution_receipt_id',
    schemaField: 'governance_schema_version', policyField: null, supportedVersions: Object.freeze([[1, null]]) }),
  ...[
    [19, 'optimization_diagnostic_plan', 'optimization_diagnostics/plans/exports', 'diagnostic_plan_id'],
    [20, 'optimization_diagnostic', 'optimization_diagnostics/exports', 'diagnostic_id'],
    [21, 'optimization_search_plan', 'optimization/plans/exports', 'optimization_plan_id'],
    [22, 'score_diagnostic_plan', 'score_diagnostics/plans/exports', 'score_diagnostic_plan_id'],
    [23, 'score_diagnostic', 'score_diagnostics/exports', 'score_diagnostic_id'],
    [24,'product_evaluation_plan','product_evaluation/plans/exports','product_plan_id'],
    [25,'product_evaluation','product_evaluation/exports','product_evaluation_id'],
    [26,'product_validation_plan','validation/product_plans/exports','product_validation_plan_id'],
    [14, 'metric_rubric', 'metric_semantics/rubrics/exports', 'rubric_id'],
    [15, 'metric_pilot', 'metric_semantics/pilots/exports', 'pilot_id'],
    [16, 'metric_review_plan', 'metric_semantics/review_plans/exports', 'review_plan_id'],
    [17, 'semantic_evidence', 'metric_semantics/exports', 'semantic_evidence_id'],
    [18, 'campaign', 'campaign/exports', 'campaign_id']
  ].map(([phase, key, relativeRoot, idField]) => Object.freeze({ phase, key, label: key, relativeRoot, idField,
    ...(key === 'product_evaluation_plan'||key==='product_evaluation'
      ? {schemaField:'product_evaluation_schema_version',policyField:'product_evaluation_policy_version',supportedVersions:Object.freeze([[1,1]])}
      : key==='product_validation_plan'?{schemaField:'validation_schema_version',policyField:'validation_policy_version',supportedVersions:Object.freeze([[2,5]])}
      : key === 'score_diagnostic_plan' || key === 'score_diagnostic'
      ? { schemaField: 'score_diagnostic_schema_version', policyField: 'score_diagnostic_policy_version', supportedVersions: Object.freeze([[1, 1], [2, 2]]) }
      : { schemaField: 'governance_schema_version', policyField: null, supportedVersions: Object.freeze([[1, null]]) }) }))
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
    // Governance families use the same field names for their own ID and for links in children.
    // The package's primary identity is not an upstream dependency.
    if (idField === phase.idField) return;
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
    case 'product_evaluation_plan':
    case 'product_evaluation':
    case 'product_validation_plan':
    case 'score_diagnostic_plan':
    case 'score_diagnostic':
    case 'optimization_diagnostic_plan':
    case 'optimization_diagnostic':
    case 'optimization_search_plan':
      for (const [key, item] of Object.entries(manifest.source_ids || {})) dependencies.push({
        idField: `source_ids.${key}.id`, id: item.id, expectedManifestSha256: item.manifest_sha256, kind: 'SOURCE' });
      break;
    case 'metric_rubric':
    case 'metric_pilot':
    case 'metric_review_plan':
    case 'semantic_evidence':
    case 'campaign':
      add('rubric_id', 'rubric_manifest_sha256', 'SOURCE');
      add('pilot_id', 'pilot_manifest_sha256', 'SOURCE');
      add('review_plan_id', 'review_plan_manifest_sha256', 'SOURCE');
      if (phase.key === 'campaign' || phase.key === 'semantic_evidence') {
        for (const [key, item] of Object.entries(manifest.source_ids || {})) dependencies.push({ idField: `source_ids.${key}.id`,
          id: item.id, expectedManifestSha256: item.manifest_sha256, kind: 'SOURCE' });
        for (const item of manifest.build_runtime_sources || []) dependencies.push({ idField: 'build_runtime_sources.runtime_bundle_id',
          id: item.id, expectedManifestSha256: item.manifest_sha256, kind: 'SOURCE' });
      }
      break;
    case 'replay_quality_plan':
      add('runtime_bundle_id', 'runtime_bundle_manifest_sha256', 'SOURCE');
      break;
    case 'replay_quality_report':
      add('runtime_bundle_id', 'runtime_bundle_manifest_sha256', 'SOURCE');
      add('replay_quality_plan_id', 'replay_quality_plan_manifest_sha256', 'SOURCE');
      add('source_dataset_id', 'source_dataset_manifest_sha256', 'SOURCE');
      break;
    case 'runtime_execution':
      add('runtime_bundle_id', 'runtime_bundle_manifest_sha256', 'SOURCE');
      add('result_id', 'result_manifest_sha256', 'SOURCE');
      for (const [key, item] of Object.entries(manifest.source_ids || {})) {
        if (!item.id || typeof item.manifest_sha256 !== 'string') fail('MAINTENANCE_INVALID_MANIFEST');
        dependencies.push({ idField: `source_ids.${key}.id`, id: item.id,
          expectedManifestSha256: item.manifest_sha256, kind: 'SOURCE' });
      }
      break;
    case 'raw': {
      const audit = manifest.selection?.replay_exclusion;
      if (audit) dependencies.push({ idField: 'selection.replay_exclusion.parent_dataset_id', id: audit.parent_dataset_id,
        expectedManifestSha256: audit.parent_manifest_sha256, kind: 'SOURCE' });
      break;
    }
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
    case 'optimization':
      if(manifest.optimization_policy_version===5)for(const [key,item] of Object.entries(manifest.source_ids||{}))dependencies.push({idField:`source_ids.${key}.id`,id:item.id,expectedManifestSha256:item.manifest_sha256,kind:'SOURCE'});
      add('model_dataset_id', 'model_dataset_manifest_sha256', 'SOURCE');
      add('evaluation_id', 'evaluation_manifest_sha256', 'SOURCE');
      add('sensitivity_id', 'sensitivity_manifest_sha256', 'SOURCE');
      add('source_dataset_id', null, 'REFERENCE');
      add('ground_truth_id', null, 'REFERENCE');
      add('validation_disclosure_evidence_id', 'validation_disclosure_evidence_sha256', 'EVIDENCE');
      break;
    case 'validation_evidence':
      add('model_dataset_id', 'model_dataset_manifest_sha256', 'SOURCE');
      break;
    case 'validation_plan':
    case 'validation': {
      const source = manifest.source_ids || {};
      for (const key of ['raw', 'gt', 'model', 'baseline', 'sensitivity', 'optimization']) {
        const item = source[key];
        if (!item) continue;
        if (typeof item.id !== 'string' || !item.id ||
            typeof item.manifest_sha256 !== 'string') {
          fail('MAINTENANCE_INVALID_MANIFEST', { reason_code: 'INVALID_SOURCE_IDENTITY', detail: key });
        }
        dependencies.push({ idField: `source_ids.${key}.id`, id: item.id,
          expectedManifestSha256: item.manifest_sha256, kind: 'SOURCE' });
      }
      if (phase.key === 'validation_plan') {
        add('evidence_id', 'evidence_manifest_sha256', 'EVIDENCE');
      } else {
        add('validation_plan_id', null, 'SOURCE');
        add('evidence_id', null, 'EVIDENCE');
      }
      break;
    }
    default:
      break;
  }
  if (phase.key !== 'experiment_runtime') {
    add('product_plan_id','product_plan_manifest_sha256','SOURCE');
    add('product_evaluation_id','product_evaluation_manifest_sha256','SOURCE');
    add('product_validation_plan_id','product_validation_plan_manifest_sha256','SOURCE');
    add('optimization_id','optimization_manifest_sha256','SOURCE');
    for(const [key,item] of Object.entries(manifest.legacy_source_ids||{})){
      const historicalProduct=phase.key==='optimization'&&manifest.optimization_schema_version===2&&manifest.optimization_policy_version===5&&
        manifest.formal_capable===false&&manifest.result_usage==='DEVELOPMENT_ONLY'&&typeof manifest.product_plan_id==='string'&&typeof manifest.product_evaluation_id==='string'&&
        ['fixedOptimizations','fixedValidations'].includes(item.kind)&&typeof item.manifest_sha256==='string';
      dependencies.push({idField:`legacy_source_ids.${key}.id`,id:item.id,expectedManifestSha256:item.manifest_sha256,kind:'SOURCE',
        ...(historicalProduct?{product_history_parent_phase:item.kind==='fixedOptimizations'?'optimization':'validation'}:{})});
    }
    add('parent_score_diagnostic_id', 'parent_score_diagnostic_manifest_sha256', 'SOURCE');
    add('parent_score_diagnostic_plan_id', 'parent_score_diagnostic_plan_manifest_sha256', 'SOURCE');
    add('parent_runtime_bundle_id', 'parent_runtime_bundle_manifest_sha256', 'SOURCE');
    add('score_diagnostic_plan_id', 'score_diagnostic_plan_manifest_sha256', 'SOURCE');
    add('source_runtime_bundle_id', 'source_runtime_bundle_manifest_sha256', 'SOURCE');
    add('diagnostic_plan_id', 'diagnostic_plan_manifest_sha256', 'SOURCE');
    add('diagnostic_id', 'diagnostic_manifest_sha256', 'SOURCE');
    add('optimization_plan_id', 'optimization_plan_manifest_sha256', 'SOURCE');
    add('campaign_id', 'campaign_manifest_sha256', 'EVIDENCE');
    add('semantic_evidence_id', 'semantic_evidence_manifest_sha256', 'EVIDENCE');
    if (!dependencies.some(x => x.idField === 'runtime_bundle_id')) add('runtime_bundle_id', 'runtime_bundle_manifest_sha256', 'SOURCE');
  }
  return dependencies;
}
