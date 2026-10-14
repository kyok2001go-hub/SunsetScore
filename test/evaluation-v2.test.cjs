const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSyntheticPipeline } = require('./evaluation-fixture.cjs');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-evaluation-v2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Model Policy 4 reaches TRAIN-only evaluation and restricted downstream readers without widening legacy V1 or TEST access', async t => {
  const root = await temporary(t);
  const pipe = await createSyntheticPipeline(root, { counts: Array(20).fill(5), modelPolicyVersion: 4 });
  t.after(pipe.close);
  const { evaluateBaseline } = await import('../tools/evaluation/evaluate-baseline.mjs');
  const { inspectEvaluation } = await import('../tools/evaluation/validate-evaluation.mjs');
  const { loadModelEvaluationInput } = await import('../tools/evaluation/lib/input.mjs');
  const { loadModelHeader, readRestrictedFile } = await import('../tools/tuning/lib/input.mjs');
  const { phaseByKey, isSupportedVersion } = await import('../tools/maintenance/maintenance-policy.mjs');
  const header = await loadModelHeader(pipe.modelDir);
  assert.equal(header.policyVersion, 4);
  assert.ok(isSupportedVersion(phaseByKey('model'), 2, 4));
  await assert.rejects(loadModelEvaluationInput(pipe.modelDir), error => error.code === 'UNSUPPORTED_MODEL_DATASET_VERSION');
  const evaluated = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { evaluationVersion: 2, output: path.join(root, 'evaluation') });
  const checked = await inspectEvaluation(evaluated.directory, { model: pipe.modelDir });
  assert.equal(checked.status, 'PASS');
  assert.equal(checked.manifest.model_dataset_policy_version, 4);
  assert.deepEqual(checked.manifest.evaluated_splits, ['TRAIN']);
  await assert.rejects(readRestrictedFile(pipe.modelDir, 'splits/test.csv'), error => error.reason_code === 'TEST_ACCESS_FORBIDDEN');
});

test('Hong Kong missing country is corrected only in error reports, with source-linked audit', async t => {
  const root = await temporary(t);
  const pipe = await createSyntheticPipeline(root, {
    counts: [20, 5, 5],
    snapshotMetadataOverride: i => i === 7 || i === 23 ? { city: '香港', country: null } : {}
  });
  t.after(pipe.close);
  const { evaluateBaseline, capturePackageFingerprint } = await import('../tools/evaluation/evaluate-baseline.mjs');
  const { inspectEvaluation } = await import('../tools/evaluation/validate-evaluation.mjs');
  const { loadModelEvaluationInput } = await import('../tools/evaluation/lib/input.mjs');
  const { evaluateV2 } = await import('../tools/evaluation/v2/core.mjs');
  const { evaluationSchemaV2 } = await import('../tools/evaluation/v2/schema.mjs');
  const { readCsv } = await import('../tools/dataset/lib/csv.mjs');
  const before = await Promise.all([pipe.rawDir, pipe.gtDir, pipe.modelDir].map(capturePackageFingerprint));
  const input = await loadModelEvaluationInput(pipe.modelDir, { trainOnly: true });
  const source = structuredClone(input.trainRows);
  const corrected = evaluateV2(input.modelManifest, input.modelManifestSha256, input.trainRows, input.warnings);
  const explicit = evaluateV2(input.modelManifest, input.modelManifestSha256,
    input.trainRows.map(r => r.city === '香港' && r.country === null ? { ...r, country: '中国' } : r), input.warnings);
  for (const name of ['overall_metrics.json', 'confusion_matrix.csv', 'score_distribution.csv',
    'baseline_comparison.csv', 'no_skill_comparison.csv']) {
    assert.equal(corrected.files[name], explicit.files[name], name);
  }
  assert.deepEqual(input.trainRows, source);
  const cases = readCsv(evaluationSchemaV2().tables.error_cases, corrected.files['error_cases.csv']);
  assert.equal(cases.find(r => r.snapshot_id === 'snap_fixture_7').country, '中国');
  assert.ok(cases.every(r => r.split === 'TRAIN'));
  const warnings = readCsv(evaluationSchemaV2().tables.warnings, corrected.files['reports/warnings.csv']);
  assert.equal(warnings.filter(r => r.warning_code === 'HONG_KONG_COUNTRY_NORMALIZED').length, 1);
  assert.throws(() => evaluateV2(input.modelManifest, input.modelManifestSha256,
    input.trainRows.map(r => r.snapshot_id === 'snap_fixture_7' ? { ...r, city: '深圳' } : r), input.warnings),
    error => error.code === 'FIELD_INVALID' && error.field === 'country');
  const out = path.join(root, 'evaluation');
  for (const evaluationVersion of [1, 2]) {
    const published = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: out, evaluationVersion });
    assert.equal((await inspectEvaluation(published.directory, { model: pipe.modelDir })).status, 'PASS');
    const repeated = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: out, evaluationVersion });
    assert.equal(repeated.directory, published.directory);
  }
  assert.deepEqual(await Promise.all([pipe.rawDir, pipe.gtDir, pipe.modelDir].map(capturePackageFingerprint)), before);
});

test('V2 no-skill reference uses distinct TRAIN Events, confidence weights, and lower tie', async () => {
  const { selectNoSkillReference } = await import('../tools/evaluation/v2/no-skill.mjs');
  const rows = [
    { event_id: 'a', gt_ordinal: 0, gt_confidence: 0.6 },
    { event_id: 'a', gt_ordinal: 0, gt_confidence: 0.6 },
    { event_id: 'b', gt_ordinal: 2, gt_confidence: 0.6 }
  ];
  const selected = selectNoSkillReference(rows);
  assert.equal(selected.reference_ordinal, 0);
  assert.equal(selected.reference_gt_label, 'poor');
  assert.equal(selected.train_event_count, 2);
  assert.equal(selected.train_weight_sum, 1.2);
  assert.equal(selectNoSkillReference([]).reason_code, 'NO_TRAIN_EVENTS');
});

test('V2 publishes TRAIN-only package, revalidates from Model, and preserves V1', async t => {
  const root = await temporary(t);
  const pipe = await createSyntheticPipeline(root, { counts: [20, 5, 5] });
  t.after(pipe.close);
  const { evaluateBaseline } = await import('../tools/evaluation/evaluate-baseline.mjs');
  const { inspectEvaluation } = await import('../tools/evaluation/validate-evaluation.mjs');
  const { evaluationStats } = await import('../tools/evaluation/evaluation-stats.mjs');
  const { readRestrictedModelFile, TRAIN_WHITELIST_FILES } = await import('../tools/evaluation/lib/input.mjs');
  await assert.rejects(() => readRestrictedModelFile(pipe.modelDir, 'splits/validation.csv', TRAIN_WHITELIST_FILES),
    /MODEL_DATASET_VALIDATION_FAILED/);
  const out = path.join(root, 'evaluation');
  const v1 = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: out });
  const v2 = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir,
    { output: out, evaluationVersion: 2 });
  assert.match(v1.evaluation_id, /^baseline_v1_/);
  assert.match(v2.evaluation_id, /^baseline_v2_/);
  assert.equal((await inspectEvaluation(v1.directory, { model: pipe.modelDir })).status, 'PASS');
  assert.equal((await inspectEvaluation(v2.directory)).validation_scope, 'PACKAGE_INTERNAL');
  assert.equal((await inspectEvaluation(v2.directory, { model: pipe.modelDir })).validation_scope, 'MODEL_LINKED');
  const manifest = JSON.parse(await fs.readFile(path.join(v2.directory, 'manifest.json'), 'utf8'));
  const summary = JSON.parse(await fs.readFile(path.join(v2.directory, 'reports/summary.json'), 'utf8'));
  const overall = JSON.parse(await fs.readFile(path.join(v2.directory, 'overall_metrics.json'), 'utf8'));
  assert.deepEqual(manifest.evaluated_splits, ['TRAIN']);
  assert.equal(manifest.validation_evaluated, false);
  assert.equal(manifest.validation_evaluation_sample_count, 0);
  assert.equal(manifest.test_evaluated, false);
  assert.equal(manifest.mapping_status, 'PROVISIONAL');
  assert.equal(manifest.interpretation_scope, 'PROXY_ORDINAL_ONLY');
  assert.deepEqual(Object.keys(summary.groups).sort(), ['ALL_PRIMARY.TRAIN', 'CLOSEST_PRE_SUNSET.TRAIN']);
  assert.deepEqual(overall.splits, ['TRAIN']);
  assert.ok(summary.no_skill_reference.reference_ordinal !== null);
  const errorCsv = await fs.readFile(path.join(v2.directory, 'error_cases.csv'), 'utf8');
  assert.doesNotMatch(errorCsv, /VALIDATION|TEST/);
  const stats = await evaluationStats(v2.directory);
  assert.equal(stats.status, 'PASS');
  assert.equal(stats.mapping_status, 'PROVISIONAL');
  assert.equal(stats.no_skill_reference.reference_gt_label, summary.no_skill_reference.reference_gt_label);

  // A self-hashed package still cannot falsify the no-skill metric.
  const tampered = path.join(root, 'tampered-staging');
  await fs.cp(v2.directory, tampered, { recursive: true });
  const { evaluationSchemaV2 } = await import('../tools/evaluation/v2/schema.mjs');
  const { readCsv, writeCsv } = await import('../tools/dataset/lib/csv.mjs');
  const { canonicalJson, hash } = await import('../tools/dataset/lib/common.mjs');
  const matrix = readCsv(evaluationSchemaV2().tables.confusion_matrix,
    await fs.readFile(path.join(v2.directory, 'confusion_matrix.csv')));
  assert.equal(matrix[0].gt_label, 'poor');
  assert.equal(matrix[0].predicted_label, '很差');
  const comparisonFile = path.join(tampered, 'no_skill_comparison.csv');
  const rows = readCsv(evaluationSchemaV2().tables.no_skill_comparison, await fs.readFile(comparisonFile));
  rows[0].reference_mae += 0.1;
  const changed = Buffer.from(writeCsv(evaluationSchemaV2().tables.no_skill_comparison, rows));
  await fs.writeFile(comparisonFile, changed);
  const changedManifest = JSON.parse(await fs.readFile(path.join(tampered, 'manifest.json')));
  changedManifest.files['no_skill_comparison.csv'].sha256 = hash(changed);
  changedManifest.files['no_skill_comparison.csv'].bytes = changed.length;
  changedManifest.descriptor.files_sha256['no_skill_comparison.csv'] = hash(changed);
  changedManifest.descriptor_sha256 = hash(canonicalJson(changedManifest.descriptor));
  changedManifest.evaluation_id = `baseline_v2_${changedManifest.model_dataset_descriptor_sha256.slice(0, 12)}_${changedManifest.descriptor_sha256.slice(0, 12)}`;
  await fs.writeFile(path.join(tampered, 'manifest.json'), canonicalJson(changedManifest));
  await assert.rejects(() => inspectEvaluation(tampered, { staging: true }),
    error => error.reason_code === 'NO_SKILL_REFERENCE_METRIC');

  const repeated = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir,
    { output: out, evaluationVersion: 2 });
  assert.equal(repeated.status, 'DEDUPLICATED');
  assert.equal(repeated.evaluation_id, v2.evaluation_id);

  // MODEL_LINKED is TRAIN-only; complete source acceptance remains a separate gate.
  const validationCsv = path.join(pipe.modelDir, 'splits/validation.csv');
  await fs.appendFile(validationCsv, 'corrupt');
  assert.equal((await inspectEvaluation(v2.directory, { model: pipe.modelDir })).status, 'PASS');
  const { inspectModelDataset } = await import('../tools/model-dataset/validate-model-dataset.mjs');
  await assert.rejects(() => inspectModelDataset(pipe.modelDir, { raw: pipe.rawDir, gt: pipe.gtDir }));
});

test('VALIDATION label changes alter source identity but not V2 TRAIN results', async t => {
  const root = await temporary(t);
  const a = await createSyntheticPipeline(root, { suffix: 'a', counts: [20, 5, 5] });
  const b = await createSyntheticPipeline(root, { suffix: 'b', counts: [20, 5, 5],
    validationRatingOverride: () => 'excellent' });
  t.after(a.close);
  t.after(b.close);
  const { evaluateBaseline } = await import('../tools/evaluation/evaluate-baseline.mjs');
  const outA = await evaluateBaseline(a.modelDir, a.rawDir, a.gtDir,
    { output: path.join(root, 'eval-a'), evaluationVersion: 2 });
  const outB = await evaluateBaseline(b.modelDir, b.rawDir, b.gtDir,
    { output: path.join(root, 'eval-b'), evaluationVersion: 2 });
  assert.notEqual(outA.evaluation_id, outB.evaluation_id);
  for (const file of ['overall_metrics.json', 'confusion_matrix.csv', 'no_skill_comparison.csv',
    'error_cases.csv']) {
    const x = await fs.readFile(path.join(outA.directory, file));
    const y = await fs.readFile(path.join(outB.directory, file));
    assert.deepEqual(x, y, file);
  }
  const summaryA = JSON.parse(await fs.readFile(path.join(outA.directory, 'reports/summary.json')));
  const summaryB = JSON.parse(await fs.readFile(path.join(outB.directory, 'reports/summary.json')));
  assert.deepEqual(summaryA.groups, summaryB.groups);
  assert.deepEqual(summaryA.no_skill_reference, summaryB.no_skill_reference);
});
