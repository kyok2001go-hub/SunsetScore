const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const exists = require('node:fs').existsSync;
const path = require('node:path');
const os = require('node:os');

const APP = path.resolve(__dirname, '..');
const model = path.join(APP, 'dataset/model/exports/model_v2_ec472a1ae79a_a7e4b16fa93e_7e48bb52a4b9');
const baselineV1 = path.join(APP, 'dataset/evaluation/exports/baseline_v1_7e48bb52a4b9_626d7073a563');
const baselineV2 = path.join(APP, 'dataset/evaluation/exports/baseline_v2_7e48bb52a4b9_fba94a3ae9f7');
const exportsDir = path.join(APP, 'dataset/tuning/exports');

test('V2 contract is isolated from historical V1', async () => {
  const v1 = await import('../tools/tuning/tuning-schema.mjs');
  const v2 = await import('../tools/tuning/v2/contract.mjs');
  assert.equal(v1.tuningSchema().tuning_schema_version, 1);
  assert.equal(v2.SCHEMA_V2.tuning_schema_version, 2);
  assert.equal(v2.POLICY_V2.tuning_policy_version, 2);
  assert.ok(v2.FILES_V2.includes('control_alignment.csv'));
  assert.ok(!v1.POLICY_FILES.includes('control_alignment.csv'));
  for (const table of ['experiment_metrics', 'ablation_metrics', 'slice_deltas']) {
    assert.ok(v2.SCHEMA_V2.tables[table].some(field => field.name === 'paired_no_skill_mae'));
    assert.ok(!v1.tuningSchema().tables[table].some(field => field.name === 'paired_no_skill_mae'));
  }
});

test('paired no-skill comparator keeps the frozen ordinal and renormalizes each surviving Event', async () => {
  const { pairedDiagnostics } = await import('../tools/tuning/v2/build.mjs');
  const rows = [
    { snapshot_id: 'a', event_id: 'A', gt_ordinal: 1, gt_confidence: 1,
      control_score: 40, experiment_score: 20, control_ordinal: 2, experiment_ordinal: 1 },
    { snapshot_id: 'b', event_id: 'A', gt_ordinal: 1, gt_confidence: 1,
      control_score: 40, experiment_score: 20, control_ordinal: 2, experiment_ordinal: 1 },
    { snapshot_id: 'c', event_id: 'B', gt_ordinal: 3, gt_confidence: 0.5,
      control_score: 40, experiment_score: 60, control_ordinal: 2, experiment_ordinal: 3 }
  ];
  const full = pairedDiagnostics(rows, 1);
  assert.deepEqual(full.reweighted.map(row => row.event_normalized_weight), [0.5, 0.5, 0.5]);
  assert.ok(Math.abs(full.fields.paired_no_skill_mae - 2 / 3) < 1e-12);
  assert.ok(Math.abs(full.fields.control_mae_gap_to_no_skill - 1 / 3) < 1e-12);
  assert.ok(Math.abs(full.fields.experiment_mae_gap_to_no_skill + 2 / 3) < 1e-12);
  const reduced = pairedDiagnostics(rows.slice(1), 1);
  assert.deepEqual(reduced.reweighted.map(row => row.event_normalized_weight), [1, 0.5]);
  assert.equal(reduced.fields.paired_no_skill_mae, full.fields.paired_no_skill_mae);
  assert.equal(reduced.fields.control_mae_gap_to_no_skill, full.fields.control_mae_gap_to_no_skill);
});

test('V2 baseline gate rejects historical Evaluation V1', {
  skip: !exists(path.join(model, 'manifest.json')) || !exists(path.join(baselineV1, 'manifest.json'))
}, async () => {
  const { inspectBaselineLinkage } = await import('../tools/tuning/v2/baseline-linkage.mjs');
  await assert.rejects(() => inspectBaselineLinkage({ baseline: baselineV1, model }),
    error => error.code === 'TUNING_VALIDATION_FAILED' && error.reason_code === 'EVALUATION_V2_REQUIRED');
  const linked = await inspectBaselineLinkage({ baseline: baselineV2, model, validationEvidence: baselineV1 });
  assert.equal(linked.no_skill_reference_ordinal, 1);
  assert.equal(linked.validation_disclosure_status, 'DEVELOPMENT_EXPOSED');
});

test('published V2 package is internally reproducible and detects file tampering', async t => {
  if (!exists(exportsDir)) return t.skip('no local Tuning package');
  const packages = (await fs.readdir(exportsDir)).filter(name => name.startsWith('sensitivity_v2_'));
  if (!packages.length) return t.skip('no local Tuning V2 package');
  const { inspectSensitivity } = await import('../tools/tuning/validate-sensitivity.mjs');
  const source = path.join(exportsDir, packages.at(-1));
  const result = await inspectSensitivity(source);
  assert.equal(result.validation_scope, 'PACKAGE_INTERNAL');
  assert.equal(result.manifest.result_usage, 'EXPLORATORY_ONLY');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-tuning-v2-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await fs.cp(source, tmp, { recursive: true });
  await fs.appendFile(path.join(tmp, 'control_alignment.csv'), 'tamper');
  await assert.rejects(() => inspectSensitivity(tmp, { staging: true }),
    error => error.code === 'TUNING_VALIDATION_FAILED' && error.reason_code === 'FILE_HASH');
});
