import path from 'node:path';
import { hash, readSafe, fail } from '../../dataset/lib/common.mjs';
import { inspectEvaluation } from '../../evaluation/validate-evaluation.mjs';
import { loadTuningInput } from '../lib/input.mjs';

const check = (condition, reason_code) => {
  if (!condition) fail('TUNING_VALIDATION_FAILED', { reason_code });
};

export async function inspectBaselineLinkage({ baseline, model, validationEvidence }) {
  const inspected = await inspectEvaluation(baseline, { model });
  check(inspected.status === 'PASS' && inspected.validation_scope === 'MODEL_LINKED', 'EVALUATION_MODEL_LINKED_FAILED');
  const m = inspected.manifest;
  const input = await loadTuningInput(model);
  check(m.evaluation_schema_version === 2 && m.evaluation_policy_version === 2, 'EVALUATION_V2_REQUIRED');
  check(m.model_dataset_id === input.linkage.model_dataset_id &&
    m.model_dataset_manifest_sha256 === input.manifestSha256 &&
    m.model_dataset_descriptor_sha256 === input.linkage.model_dataset_descriptor_sha256,
  'EVALUATION_MODEL_MISMATCH');
  check(JSON.stringify(m.evaluated_splits) === '["TRAIN"]' && m.validation_evaluated === false &&
    m.test_evaluated === false && m.validation_evaluation_sample_count === 0 &&
    m.test_evaluation_sample_count === 0, 'EVALUATION_HOLDOUT_CONTRACT');
  check(m.mapping_status === 'PROVISIONAL' && m.interpretation_scope === 'PROXY_ORDINAL_ONLY',
    'EVALUATION_MAPPING_CONTRACT');
  const ref = m.no_skill_reference;
  check(ref?.comparator === 'TRAIN_WEIGHTED_MEDIAN_ORDINAL' &&
    (Number.isInteger(ref.reference_ordinal) && ref.reference_ordinal >= 0 && ref.reference_ordinal <= 4) &&
    ref.train_event_count === m.event_count, 'EVALUATION_NO_SKILL_CONTRACT');
  let disclosure = {
    validation_disclosure_status: 'NOT_ATTESTED',
    validation_disclosure_evidence_id: null,
    validation_disclosure_evidence_sha256: null,
    validation_access_ledger_sha256: null
  };
  if (validationEvidence) {
    const evidence = await inspectEvaluation(validationEvidence, { model });
    const em = evidence.manifest;
    check(evidence.validation_scope === 'MODEL_LINKED' && em.evaluation_schema_version === 1 &&
      em.model_dataset_id === m.model_dataset_id && em.evaluated_splits.includes('VALIDATION'),
    'VALIDATION_EVIDENCE_MISMATCH');
    disclosure = {
      ...disclosure,
      validation_disclosure_status: 'DEVELOPMENT_EXPOSED',
      validation_disclosure_evidence_id: em.evaluation_id,
      validation_disclosure_evidence_sha256: hash(await readSafe(path.join(validationEvidence, 'manifest.json')))
    };
  }
  return {
    evaluation_id: m.evaluation_id,
    evaluation_manifest_sha256: hash(await readSafe(path.join(baseline, 'manifest.json'))),
    evaluation_schema_version: 2,
    evaluation_policy_version: 2,
    evaluation_validation_scope: 'MODEL_LINKED',
    evaluation_evaluated_splits: ['TRAIN'],
    mapping_status: m.mapping_status,
    interpretation_scope: m.interpretation_scope,
    no_skill_reference_ordinal: ref.reference_ordinal,
    no_skill_reference_gt_label: ref.reference_gt_label,
    ...disclosure
  };
}
