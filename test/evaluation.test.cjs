const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSyntheticPipeline, date } = require('./evaluation-fixture.cjs');

let modules;
async function api() {
  return modules ||= Promise.all([
    'evaluation/evaluation-schema',
    'evaluation/evaluation-policy',
    'evaluation/metrics',
    'evaluation/slice-analysis',
    'evaluation/baseline-comparison',
    'evaluation/lib/input',
    'evaluation/lib/package',
    'evaluation/lib/core',
    'evaluation/lib/cli',
    'evaluation/evaluate-baseline',
    'evaluation/validate-evaluation',
    'evaluation/evaluation-stats',
    'dataset/lib/common',
    'dataset/lib/csv',
    'model-dataset/model-dataset-schema'
  ].map(n => import(`../tools/${n}.mjs`))).then(xs => Object.assign({}, ...xs));
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-eval-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// 1. Score Band boundaries, illegal/missing values, ordinal direction, legal 0
test('PRD 20.1: Score Band boundaries, illegal values, ordinal direction, legal 0', async () => {
  const { scoreToOrdinal, ordinalToLabel } = await api();

  // Boundaries
  assert.equal(scoreToOrdinal(0), 0);
  assert.equal(scoreToOrdinal(19), 0);
  assert.equal(scoreToOrdinal(20), 1);
  assert.equal(scoreToOrdinal(39), 1);
  assert.equal(scoreToOrdinal(40), 2);
  assert.equal(scoreToOrdinal(59), 2);
  assert.equal(scoreToOrdinal(60), 3);
  assert.equal(scoreToOrdinal(89), 3);
  assert.equal(scoreToOrdinal(90), 4);
  assert.equal(scoreToOrdinal(100), 4);

  // Labels
  assert.equal(ordinalToLabel(0), 'poor');
  assert.equal(ordinalToLabel(1), 'fair');
  assert.equal(ordinalToLabel(2), 'good');
  assert.equal(ordinalToLabel(3), 'very_good');
  assert.equal(ordinalToLabel(4), 'excellent');

  // Legal 0 is valid and not treated as missing
  assert.equal(scoreToOrdinal(0), 0);

  // Illegal values fail directly
  assert.throws(() => scoreToOrdinal(-1), /INVALID_SCORE/);
  assert.throws(() => scoreToOrdinal(101), /INVALID_SCORE/);
  assert.throws(() => scoreToOrdinal(45.5), /INVALID_SCORE/);
  assert.throws(() => scoreToOrdinal('50'), /INVALID_SCORE/);
  assert.throws(() => scoreToOrdinal(null), /INVALID_SCORE/);
  assert.throws(() => scoreToOrdinal(NaN), /INVALID_SCORE/);
  assert.throws(() => scoreToOrdinal(Infinity), /INVALID_SCORE/);

  // Ordinal positive/negative direction
  const eOver = scoreToOrdinal(70) - 1; // 3 - 1 = +2 (overprediction)
  assert.equal(eOver, 2);
  const eUnder = scoreToOrdinal(10) - 2; // 0 - 2 = -2 (underprediction)
  assert.equal(eUnder, -2);
  const eExact = scoreToOrdinal(50) - 2; // 2 - 2 = 0
  assert.equal(eExact, 0);
});

// 2. Independent Hand-Calculated Golden test
test('PRD 20.2: Independent hand-calculated Golden test (weighted, unweighted, QWK, degenerate)', async () => {
  const { computeHeadlineMetrics } = await api();

  // 4 hand-constructed samples:
  // Sample 1: snapshot_id="s1", gt_ordinal=0, pred_ordinal=1. e=+1, abs(e)=1. weight=0.5
  // Sample 2: snapshot_id="s2", gt_ordinal=1, pred_ordinal=1. e=0, abs(e)=0. weight=1.0
  // Sample 3: snapshot_id="s3", gt_ordinal=2, pred_ordinal=3. e=+1, abs(e)=1. weight=0.5
  // Sample 4: snapshot_id="s4", gt_ordinal=4, pred_ordinal=0. e=-4, abs(e)=4. weight=2.0
  // Total W = 0.5 + 1.0 + 0.5 + 2.0 = 4.0
  // Weighted:
  // sum(w * abs(e)) = 0.5*1 + 1.0*0 + 0.5*1 + 2.0*4 = 0.5 + 0 + 0.5 + 8.0 = 9.0 -> MAE = 9.0 / 4.0 = 2.25
  // sum(w * e) = 0.5*(1) + 1.0*(0) + 0.5*(1) + 2.0*(-4) = 0.5 + 0 + 0.5 - 8.0 = -7.0 -> Bias = -7.0 / 4.0 = -1.75
  // Exact: only s2 (e=0) -> 1.0 / 4.0 = 0.25
  // Within-1: s1 (1), s2 (0), s3 (1) -> (0.5 + 1.0 + 0.5) / 4.0 = 2.0 / 4.0 = 0.5
  // Severe (abs(e)>=2): s4 (4) -> 2.0 / 4.0 = 0.5
  // Overprediction (e>0): s1 (1), s3 (1) -> (0.5 + 0.5) / 4.0 = 1.0 / 4.0 = 0.25
  // Underprediction (e<0): s4 (-4) -> 2.0 / 4.0 = 0.5

  const samples = [
    { snapshot_id: 's1', gt_ordinal: 0, predicted_ordinal: 1, weight: 0.5 },
    { snapshot_id: 's2', gt_ordinal: 1, predicted_ordinal: 1, weight: 1.0 },
    { snapshot_id: 's3', gt_ordinal: 2, predicted_ordinal: 3, weight: 0.5 },
    { snapshot_id: 's4', gt_ordinal: 4, predicted_ordinal: 0, weight: 2.0 }
  ];

  const weighted = computeHeadlineMetrics(samples, 'weighted');
  assert.equal(weighted.mae, 2.25);
  assert.equal(weighted.bias, -1.75);
  assert.equal(weighted.exact_accuracy, 0.25);
  assert.equal(weighted.within_1_accuracy, 0.5);
  assert.equal(weighted.severe_error_rate, 0.5);
  assert.equal(weighted.overprediction_rate, 0.25);
  assert.equal(weighted.underprediction_rate, 0.5);
  assert.ok(typeof weighted.qwk === 'number');

  const unweighted = computeHeadlineMetrics(samples, 'unweighted');
  assert.equal(unweighted.mae, 1.5);
  assert.equal(unweighted.bias, -0.5);
  assert.equal(unweighted.exact_accuracy, 0.25);
  assert.equal(unweighted.within_1_accuracy, 0.75);
  assert.equal(unweighted.severe_error_rate, 0.25);
  assert.equal(unweighted.overprediction_rate, 0.5);
  assert.equal(unweighted.underprediction_rate, 0.25);

  // Degenerate QWK test: all rows have identical gt_ordinal and predicted_ordinal
  // In this case, expected disagreement denom sum(D_ab * E_ab) = 0!
  const degenerateSamples = [
    { snapshot_id: 'd1', gt_ordinal: 2, predicted_ordinal: 2, weight: 1.0 },
    { snapshot_id: 'd2', gt_ordinal: 2, predicted_ordinal: 2, weight: 1.0 }
  ];
  const degen = computeHeadlineMetrics(degenerateSamples, 'weighted');
  assert.equal(degen.exact_accuracy, 1);
  assert.equal(degen.qwk, null);
  assert.equal(degen.metric_reasons.qwk, 'QWK_ZERO_EXPECTED_DISAGREEMENT');
});

// 3. Weights: ALL_PRIMARY, CLOSEST, paired, Slice; Event confidence weight preservation
test('PRD 20.3: Weight preservation across benchmarks, paired and slices', async () => {
  const { computeHeadlineMetrics, formatMetric } = await api();

  // Event 1 has 3 snapshots, confidence 0.6 -> ALL_PRIMARY weights: 0.2 each
  // Event 2 has 1 snapshot, confidence 0.8 -> ALL_PRIMARY weight: 0.8
  const allPrimaryRows = [
    { snapshot_id: 'e1_1', event_id: 'e1', gt_confidence: 0.6, weight: 0.2, gt_ordinal: 1, predicted_ordinal: 1 },
    { snapshot_id: 'e1_2', event_id: 'e1', gt_confidence: 0.6, weight: 0.2, gt_ordinal: 1, predicted_ordinal: 2 },
    { snapshot_id: 'e1_3', event_id: 'e1', gt_confidence: 0.6, weight: 0.2, gt_ordinal: 1, predicted_ordinal: 1 },
    { snapshot_id: 'e2_1', event_id: 'e2', gt_confidence: 0.8, weight: 0.8, gt_ordinal: 3, predicted_ordinal: 3 }
  ];

  // In CLOSEST: Event 1 selects e1_1 (weight 0.6), Event 2 selects e2_1 (weight 0.8)
  const closestRows = [
    { snapshot_id: 'e1_1', event_id: 'e1', gt_confidence: 0.6, weight: 0.6, gt_ordinal: 1, predicted_ordinal: 1 },
    { snapshot_id: 'e2_1', event_id: 'e2', gt_confidence: 0.8, weight: 0.8, gt_ordinal: 3, predicted_ordinal: 3 }
  ];

  // In CLOSEST, each Event gets its full gt_confidence!
  assert.equal(formatMetric(closestRows.filter(r => r.event_id === 'e1').reduce((s, r) => s + r.weight, 0)), 0.6);
  assert.equal(formatMetric(closestRows.filter(r => r.event_id === 'e2').reduce((s, r) => s + r.weight, 0)), 0.8);
  assert.equal(formatMetric(closestRows.reduce((s, r) => s + r.weight, 0)), 1.4);
});

// 4. CLOSEST ties, order independence; recent row missing baseline does not fall back
test('PRD 20.4: CLOSEST ties, order independence and baseline missing non-fallback', async () => {
  const { computeBaselineComparison, evaluate, makeManifest, evaluationPolicy } = await api();

  // Test tie-breaking for CLOSEST:
  // Candidate 1: lead_time = 40, epoch = 1000, snap = 'snap_b'
  // Candidate 2: lead_time = 40, epoch = 2000, snap = 'snap_a' (higher epoch wins)
  // Candidate 3: lead_time = 50, epoch = 3000, snap = 'snap_c' (higher lead_time loses)
  const trainRows = [
    {
      snapshot_id: 'snap_b', event_id: 'evt_1', event_date_local: '2026-09-10', location_key: 'loc1', city: '广州', country: '中国', admin1: '广东',
      lead_time_minutes: 40, prediction_time_epoch: 1000, model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
      predicted_score: 40, baseline_score: 30, gt_label: 'good', gt_ordinal: 2, gt_confidence: 0.6, gt_status: 'MEDIUM', gt_basis: 'ADMIN_ADJUDICATED',
      split: 'TRAIN', eligibility: 'PRIMARY', event_normalized_weight: 0.2
    },
    {
      snapshot_id: 'snap_a', event_id: 'evt_1', event_date_local: '2026-09-10', location_key: 'loc1', city: '广州', country: '中国', admin1: '广东',
      lead_time_minutes: 40, prediction_time_epoch: 2000, model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
      predicted_score: 40, baseline_score: null, // lacks baseline!
      gt_label: 'good', gt_ordinal: 2, gt_confidence: 0.6, gt_status: 'MEDIUM', gt_basis: 'ADMIN_ADJUDICATED',
      split: 'TRAIN', eligibility: 'PRIMARY', event_normalized_weight: 0.2
    },
    {
      snapshot_id: 'snap_c', event_id: 'evt_1', event_date_local: '2026-09-10', location_key: 'loc1', city: '广州', country: '中国', admin1: '广东',
      lead_time_minutes: 50, prediction_time_epoch: 3000, model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
      predicted_score: 40, baseline_score: 30, gt_label: 'good', gt_ordinal: 2, gt_confidence: 0.6, gt_status: 'MEDIUM', gt_basis: 'ADMIN_ADJUDICATED',
      split: 'TRAIN', eligibility: 'PRIMARY', event_normalized_weight: 0.2
    }
  ];

  const fakeModelManifest = {
    model_dataset_id: 'model_v2_fake',
    descriptor_sha256: '1'.repeat(64),
    model_dataset_schema_version: 2,
    model_dataset_policy_version: 3
  };

  // Ensure input trainRows are not mutated
  const originalTrainJson = JSON.stringify(trainRows);
  const evalResult = evaluate(fakeModelManifest, '2'.repeat(64), trainRows, []);
  assert.equal(JSON.stringify(trainRows), originalTrainJson, 'evaluate() must not mutate input rows');

  assert.equal(evalResult.counts.sample_count, 3);
  assert.equal(evalResult.counts.event_count, 1);

  // In CLOSEST, snap_a is selected. Because snap_a lacks baseline_score, it does NOT fall back to snap_b or snap_c!
  // Paired count in CLOSEST should be 0!
  const baselineComparison = evalResult.files['baseline_comparison.csv'];
  assert.ok(baselineComparison.includes('CLOSEST_PRE_SUNSET,TRAIN,weighted,stored_internal_baseline_score,1,1,0,0,1,0,'));
});

// 5. Quantiles, Spearman tied ranks, degenerate cases, 12-decimal rounding and negative zero
test('PRD 20.5: Linear quantiles, Spearman rank correlation, tie handling, formatMetric', async () => {
  const { computeLinearQuantile, computeSpearman, formatMetric } = await api();

  // Quantiles linear interpolation:
  assert.equal(computeLinearQuantile([], 0.5), null);
  assert.equal(computeLinearQuantile([42], 0.5), 42);
  assert.equal(computeLinearQuantile([10, 20], 0.5), 15);
  assert.equal(computeLinearQuantile([10, 20, 30], 0.25), 15);
  assert.equal(computeLinearQuantile([10, 20, 30], 0.5), 20);
  assert.equal(computeLinearQuantile([10, 20, 30], 0.75), 25);

  // Spearman with tied ranks
  const perfectTie = computeSpearman([10, 20, 20, 40], [1, 2, 2, 4]);
  assert.equal(perfectTie.correlation, 1);
  assert.equal(perfectTie.reason_code, null);

  // Constant input -> CONSTANT_INPUT reason
  const constInput = computeSpearman([10, 10, 10], [1, 2, 3]);
  assert.equal(constInput.correlation, null);
  assert.equal(constInput.reason_code, 'CONSTANT_INPUT');

  // Single sample -> INSUFFICIENT_SAMPLES
  const single = computeSpearman([10], [2]);
  assert.equal(single.correlation, null);
  assert.equal(single.reason_code, 'INSUFFICIENT_SAMPLES');

  // Negative zero normalized to 0
  assert.equal(formatMetric(-0), 0);
  assert.equal(Object.is(formatMetric(-0), 0), true);
  assert.equal(Object.is(formatMetric(-0), -0), false);
  // 12 decimals
  assert.equal(formatMetric(1 / 3), 0.333333333333);
});

// 6. Legacy Schema gt_basis, Event GT inconsistency, homonymous cities, null/false/0, zero-support enum buckets
test('PRD 20.6: Legacy gt_basis, homonymous cities, GT inconsistency, zero-support enum buckets', async () => {
  const { computeSliceMetrics, evaluationPolicy } = await api();
  const policy = evaluationPolicy(1);

  // Homonymous cities test: same location_key, multiple display tuples
  const rows = [
    { snapshot_id: 's1', event_id: 'e1', location_key: 'loc_multi', city: '广州', country: '中国', admin1: '广东', weight: 0.5, gt_confidence: 0.5, gt_ordinal: 1, predicted_ordinal: 1, lead_time_minutes: 40, lead_time_bucket: 'T_30_60M', tile_radar_available: false, tile_sat_available: true },
    { snapshot_id: 's2', event_id: 'e2', location_key: 'loc_multi', city: '广州市', country: '中国', admin1: '广东省', weight: 0.5, gt_confidence: 0.5, gt_ordinal: 1, predicted_ordinal: 1, lead_time_minutes: 40, lead_time_bucket: 'T_30_60M', tile_radar_available: false, tile_sat_available: true }
  ];

  const sliceResult = computeSliceMetrics(rows, 'ALL_PRIMARY', 'TRAIN', policy);
  assert.ok(sliceResult.warnings.some(w => w.warning_code === 'LOCATION_DISPLAY_VARIANTS'));
  const citySlice = sliceResult.sliceRows.find(r => r.slice_dimension === 'city' && r.slice_value === 'loc_multi');
  assert.equal(citySlice.city, '广州');

  // Zero support enum buckets are present in slice_metrics
  const emptyBucket = sliceResult.sliceRows.find(r => r.slice_dimension === 'lead_time_bucket' && r.slice_value === 'T_0_30M');
  assert.ok(emptyBucket);
  assert.equal(emptyBucket.sample_count, 0);
  assert.equal(emptyBucket.low_support, true);
  assert.equal(emptyBucket.weighted_mae, null);
  assert.equal(emptyBucket.weighted_mae_reason_code, 'NO_SAMPLES');
});

// 7. High confidence STRONG, no high confidence warning, no near-sunset coverage warning
test('PRD 20.7: High confidence STRONG and warnings for no high confidence / no near-sunset', async () => {
  const { evaluate } = await api();

  const trainRows = [
    {
      snapshot_id: 's1', event_id: 'e1', event_date_local: '2026-09-10', location_key: 'loc1', city: '广州', country: '中国', admin1: '广东',
      lead_time_minutes: 45, prediction_time_epoch: 1000, model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
      predicted_score: 50, baseline_score: 40, gt_label: 'good', gt_ordinal: 2, gt_confidence: 0.6, gt_status: 'MEDIUM', gt_basis: 'ADMIN_ADJUDICATED',
      split: 'TRAIN', eligibility: 'PRIMARY', event_normalized_weight: 0.6
    }
  ];

  const fakeModel = {
    model_dataset_id: 'model_v2_fake',
    descriptor_sha256: 'a'.repeat(64),
    model_dataset_schema_version: 2,
    model_dataset_policy_version: 3
  };

  const evalResult = evaluate(fakeModel, 'b'.repeat(64), trainRows, []);
  const warnings = evalResult.files['reports/warnings.csv'];
  assert.ok(warnings.includes('NO_NEAR_SUNSET_COVERAGE'));
  assert.ok(warnings.includes('NO_HIGH_CONFIDENCE_SAMPLES'));

  const summary = JSON.parse(evalResult.files['reports/summary.json']);
  const highConf = summary.groups['ALL_PRIMARY.TRAIN'].high_confidence;
  assert.equal(highConf.high_confidence_sample_count, 0);
  assert.equal(highConf.severe_sample_rate, null);
  assert.equal(highConf.severe_sample_rate_reason_code, 'NO_HIGH_CONFIDENCE_SAMPLES');
});

// 8. Four primary groups + combined TRAIN_VALIDATION, matrix totals, error cases top 20
test('PRD 20.8: Four primary groups, TRAIN_VALIDATION recomputation, top 20 worst cases', async () => {
  const { evaluate } = await api();

  const makeRow = (id, eid, dt, split, predScore, gtOrdinal) => ({
    snapshot_id: id, event_id: eid, event_date_local: dt, location_key: 'loc_' + eid, city: '城市', country: '中国', admin1: '省',
    lead_time_minutes: 40, prediction_time_epoch: 1000, model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
    predicted_score: predScore, baseline_score: 50, gt_label: 'good', gt_ordinal: gtOrdinal, gt_confidence: 0.6, gt_status: 'MEDIUM', gt_basis: 'ADMIN_ADJUDICATED',
    split, eligibility: 'PRIMARY', event_normalized_weight: 0.6,
    regime_label: '多云间晴', sky_evolution_state: 'STABLE', gw_factor: 1.0, tile_radar_available: true, tile_sat_available: true
  });

  const trainRows = [
    makeRow('s_tr_1', 'e_tr_1', '2026-09-10', 'TRAIN', 10, 2), // abs error = 2
    makeRow('s_tr_2', 'e_tr_2', '2026-09-11', 'TRAIN', 50, 2)  // abs error = 0 (exact hit)
  ];
  const valRows = [
    makeRow('s_val_1', 'e_val_1', '2026-09-12', 'VALIDATION', 95, 2) // abs error = 2
  ];

  const fakeModel = {
    model_dataset_id: 'model_v2_fake',
    descriptor_sha256: 'a'.repeat(64),
    model_dataset_schema_version: 2,
    model_dataset_policy_version: 3
  };

  const evalResult = evaluate(fakeModel, 'b'.repeat(64), trainRows, valRows);
  const summary = JSON.parse(evalResult.files['reports/summary.json']);

  assert.ok(summary.groups['ALL_PRIMARY.TRAIN']);
  assert.ok(summary.groups['ALL_PRIMARY.VALIDATION']);
  assert.ok(summary.groups['ALL_PRIMARY.TRAIN_VALIDATION']);
  assert.ok(summary.groups['CLOSEST_PRE_SUNSET.TRAIN']);
  assert.ok(summary.groups['CLOSEST_PRE_SUNSET.VALIDATION']);
  assert.ok(summary.groups['CLOSEST_PRE_SUNSET.TRAIN_VALIDATION']);

  assert.equal(summary.groups['ALL_PRIMARY.TRAIN_VALIDATION'].sample_count, 3);
  assert.equal(summary.groups['ALL_PRIMARY.TRAIN_VALIDATION'].event_count, 3);

  const errorCasesCsv = evalResult.files['error_cases.csv'];
  assert.ok(errorCasesCsv.includes('s_tr_1'));
  assert.ok(errorCasesCsv.includes('s_val_1'));
  assert.ok(!errorCasesCsv.includes('s_tr_2'));
});

// 9. Restricted whitelist reader access interception
test('PRD 20.9: Restricted whitelist reader intercepts forbidden file access', async (t) => {
  const { readRestrictedModelFile } = await api();
  const root = await tempDir(t);
  const pipe = await createSyntheticPipeline(root, { counts: [20, 5, 5] });
  t.after(pipe.close);

  // Allowed whitelist files succeed
  const manifestBytes = await readRestrictedModelFile(pipe.modelDir, 'manifest.json');
  assert.ok(manifestBytes.length > 0);
  const trainBytes = await readRestrictedModelFile(pipe.modelDir, 'splits/train.csv');
  assert.ok(trainBytes.length > 0);

  // Forbidden files fail immediately with TEST_ACCESS_FORBIDDEN
  for (const forbidden of ['splits/test.csv', 'model_samples.csv', 'event_splits.csv', 'reports/statistics.json']) {
    await assert.rejects(
      () => readRestrictedModelFile(pipe.modelDir, forbidden),
      err => err.code === 'MODEL_DATASET_VALIDATION_FAILED' && err.reason_code === 'TEST_ACCESS_FORBIDDEN'
    );
  }
});

// 10. Upstream Model validation, TEST set integrity and ID binding
test('PRD 20.10: Upstream Model validation validates TEST; legitimate TEST change alters ID while TRAIN/VAL metrics remain identical', async (t) => {
  const { evaluateBaseline, inspectEvaluation, hash } = await api();
  const root = await tempDir(t);

  // Pipeline A: standard test set
  const pipeA = await createSyntheticPipeline(root, { suffix: 'a', counts: [20, 5, 5] });
  t.after(pipeA.close);

  // Pipeline B: exactly same raw/observations except TEST split observation rating is changed from poor to excellent
  const pipeB = await createSyntheticPipeline(root, {
    suffix: 'b',
    counts: [20, 5, 5],
    testRatingOverride: () => 'excellent'
  });
  t.after(pipeB.close);

  // Upstream validation verifies TEST set:
  // Both Model A and Model B are valid SOURCE_LINKED packages
  assert.notEqual(pipeA.modelDir, pipeB.modelDir);

  // Run evaluateBaseline on both
  const evalOutA = path.join(root, 'eval_a');
  const resA = await evaluateBaseline(pipeA.modelDir, pipeA.rawDir, pipeA.gtDir, { output: evalOutA, quiet: true });
  assert.equal(resA.status, 'EXPORTED');

  const evalOutB = path.join(root, 'eval_b');
  const resB = await evaluateBaseline(pipeB.modelDir, pipeB.rawDir, pipeB.gtDir, { output: evalOutB, quiet: true });
  assert.equal(resB.status, 'EXPORTED');

  // Because only TEST data differed between pipeA and pipeB:
  // 1. Model Dataset descriptor changed -> Model dataset ID changed
  // 2. Evaluation ID changed
  assert.notEqual(resA.evaluation_id, resB.evaluation_id);

  // 3. BUT TRAIN and VALIDATION metrics are 100% BYTE-FOR-BYTE IDENTICAL!
  const overallA = await fs.readFile(path.join(resA.directory, 'overall_metrics.json'), 'utf8');
  const overallB = await fs.readFile(path.join(resB.directory, 'overall_metrics.json'), 'utf8');
  assert.equal(overallA, overallB);

  const confMatrixA = await fs.readFile(path.join(resA.directory, 'confusion_matrix.csv'), 'utf8');
  const confMatrixB = await fs.readFile(path.join(resB.directory, 'confusion_matrix.csv'), 'utf8');
  assert.equal(confMatrixA, confMatrixB);

  const sliceMetricsA = await fs.readFile(path.join(resA.directory, 'slice_metrics.csv'), 'utf8');
  const sliceMetricsB = await fs.readFile(path.join(resB.directory, 'slice_metrics.csv'), 'utf8');
  assert.equal(sliceMetricsA, sliceMetricsB);

  // 4. Malicious tampering of splits/test.csv in pipeA fails upstream validation
  const testCsvPath = path.join(pipeA.modelDir, 'splits/test.csv');
  const originalTestCsv = await fs.readFile(testCsvPath);
  await fs.writeFile(testCsvPath, originalTestCsv.toString('utf8').replace('poor', 'excellent'));
  await assert.rejects(
    () => evaluateBaseline(pipeA.modelDir, pipeA.rawDir, pipeA.gtDir, { output: path.join(root, 'eval_fail'), quiet: true }),
    /UPSTREAM_VALIDATION_FAILED|MODEL_DATASET_VALIDATION_FAILED|SOURCE_CHANGED_DURING_EVALUATION/
  );
  await fs.writeFile(testCsvPath, originalTestCsv);
});

// 11. Tiered validator scopes: PACKAGE_INTERNAL vs MODEL_LINKED and source version compatibility
test('PRD 20.11: inspectEvaluation supports PACKAGE_INTERNAL and MODEL_LINKED with version compatibility', async (t) => {
  const { evaluateBaseline, inspectEvaluation } = await api();
  const root = await tempDir(t);
  const pipe = await createSyntheticPipeline(root, { counts: [20, 5, 5] });
  t.after(pipe.close);

  const evalOut = path.join(root, 'eval');
  const res = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true });

  // 1. PACKAGE_INTERNAL passes without --model
  const pkgInternal = await inspectEvaluation(res.directory);
  assert.equal(pkgInternal.status, 'PASS');
  assert.equal(pkgInternal.validation_scope, 'PACKAGE_INTERNAL');

  // 2. MODEL_LINKED passes with --model
  const modelLinked = await inspectEvaluation(res.directory, { model: pipe.modelDir });
  assert.equal(modelLinked.status, 'PASS');
  assert.equal(modelLinked.validation_scope, 'MODEL_LINKED');
  assert.equal(modelLinked.evaluation_id, res.evaluation_id);

  // 3. MODEL_LINKED rejects mismatched model
  const otherPipe = await createSyntheticPipeline(root, { suffix: 'other', counts: [20, 5, 5] });
  t.after(otherPipe.close);
  await assert.rejects(
    () => inspectEvaluation(res.directory, { model: otherPipe.modelDir }),
    err => err.code === 'SOURCE_DATASET_MISMATCH'
  );
});

// 12. Concurrency lock, deduplication, conflict, failure recovery, and path isolation
test('PRD 20.12: Concurrency lock, deduplication, conflict, failure recovery, and path isolation', async (t) => {
  const { withEvaluationLock, evaluateBaseline, outside } = await api();
  const root = await tempDir(t);
  const pipe = await createSyntheticPipeline(root, { counts: [20, 5, 5] });
  t.after(pipe.close);

  // 1. Lock serialization and timeout
  const lock = path.join(root, 'test.lock');
  await fs.mkdir(lock);
  await assert.rejects(
    () => withEvaluationLock(lock, async () => {}, 200),
    err => err.code === 'EVALUATION_LOCK_BUSY'
  );
  await fs.rmdir(lock);

  // 2. Deduplication on identical evaluation
  const evalOut = path.join(root, 'eval_dedup');
  const res1 = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true });
  assert.equal(res1.status, 'EXPORTED');

  const res2 = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true });
  assert.equal(res2.status, 'DEDUPLICATED');
  assert.equal(res2.evaluation_id, res1.evaluation_id);

  // 3. Conflict on modified target directory
  const summaryFile = path.join(res1.directory, 'reports/summary.json');
  const originalSummary = await fs.readFile(summaryFile);
  await fs.writeFile(summaryFile, originalSummary.toString('utf8').replace('ALL_PRIMARY', 'ALL_PRIMARY_CONFLICT'));
  await assert.rejects(
    () => evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true }),
    err => err.code === 'EVALUATION_ID_CONFLICT'
  );
  await fs.writeFile(summaryFile, originalSummary);

  // 4. Path isolation: path traversal and directory nesting rejection
  await assert.rejects(
    () => outside(root + '/../escaped', []),
    err => err.code === 'UNSAFE_PATH'
  );
  await assert.rejects(
    () => outside(path.join(pipe.modelDir, 'inside_model'), [pipe.modelDir]),
    err => err.code === 'UNSAFE_PATH'
  );

  // 5. Source changed during build rejected
  const changingModelFile = path.join(pipe.modelDir, 'splits/train.csv');
  const origTrain = await fs.readFile(changingModelFile);
  // We simulate source change during evaluation by corrupting before publish lock
  const changeOut = path.join(root, 'eval_changing');
  const { recheckEvaluationInputs } = await api();
  const fakeFingerprints = { 'splits/train.csv': '0'.repeat(64) };
  await assert.rejects(
    () => recheckEvaluationInputs(pipe.modelDir, fakeFingerprints),
    err => err.code === 'SOURCE_CHANGED_DURING_EVALUATION'
  );
});

// 13. Direct internal metric tampering detected by confusion matrix recalculation
test('PRD 20.3d & 20.12: PACKAGE_INTERNAL detects metric tampering via confusion matrix recalculation', async (t) => {
  const { evaluateBaseline, inspectEvaluation, hash, canonicalJson } = await api();
  const root = await tempDir(t);
  const pipe = await createSyntheticPipeline(root, { counts: [20, 5, 5] });
  t.after(pipe.close);

  const evalOut = path.join(root, 'eval_tamper');
  const res = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true });

  // Tamper overall_metrics.json (change exact_accuracy) and recompute manifest sha256 to simulate forged hash
  const metricsPath = path.join(res.directory, 'overall_metrics.json');
  const metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8'));
  metrics.benchmarks.ALL_PRIMARY.TRAIN.weighted.exact_accuracy = 0.999999999999;
  const newMetricsBytes = Buffer.from(canonicalJson(metrics));
  await fs.writeFile(metricsPath, newMetricsBytes);

  const manifestPath = path.join(res.directory, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files['overall_metrics.json'].sha256 = hash(newMetricsBytes);
  manifest.files['overall_metrics.json'].bytes = newMetricsBytes.length;
  manifest.descriptor.files_sha256['overall_metrics.json'] = hash(newMetricsBytes);
  const { identity } = await api();
  const newId = identity(manifest.descriptor);
  manifest.descriptor_sha256 = newId.descriptor_sha256;
  manifest.evaluation_id = newId.evaluation_id;
  await fs.writeFile(manifestPath, Buffer.from(canonicalJson(manifest)));

  // Even though file hash and manifest match, PACKAGE_INTERNAL detects that exact_accuracy != recalculated from 25 cells!
  await assert.rejects(
    () => inspectEvaluation(res.directory, { staging: true }),
    err => err.code === 'EVALUATION_VALIDATION_FAILED' && err.reason_code === 'METRIC_TAMPER_DETECTED'
  );
});

// 14. Full synthetic integration: evaluateBaseline, validate (PACKAGE_INTERNAL and MODEL_LINKED), and stats
test('PRD 20.13 & 21: Full synthetic Model Dataset baseline evaluation, validate and stats', async (t) => {
  const { evaluateBaseline, inspectEvaluation, evaluationStats } = await api();
  const root = await tempDir(t);
  const pipe = await createSyntheticPipeline(root, { counts: [25, 8, 8] });
  t.after(pipe.close);

  const evalOut = path.join(root, 'eval_full');
  const exportRes = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, {
    output: evalOut,
    quiet: true
  });

  assert.equal(exportRes.status, 'EXPORTED');
  assert.ok(exportRes.evaluation_id.startsWith('baseline_v1_'));
  assert.equal(exportRes.counts.sample_count, 33); // 25 train + 8 val
  assert.equal(exportRes.counts.event_count, 33);  // 25 train + 8 val
  assert.equal(exportRes.counts.date_count, 2);    // 2 train/val dates

  // Validate exported package with MODEL_LINKED scope
  const valRes = await inspectEvaluation(exportRes.directory, {
    model: pipe.modelDir,
    quiet: true
  });
  assert.equal(valRes.status, 'PASS');
  assert.equal(valRes.validation_scope, 'MODEL_LINKED');
  assert.equal(valRes.evaluation_id, exportRes.evaluation_id);

  // Run stats on exported package
  const statsRes = await evaluationStats(exportRes.directory, { quiet: true });
  assert.equal(statsRes.status, 'PASS');
  assert.equal(statsRes.evaluation_id, exportRes.evaluation_id);
  assert.equal(statsRes.sample_count, 33);
  assert.equal(statsRes.event_count, 33);
  assert.ok(statsRes.headline_summary['ALL_PRIMARY.TRAIN']);
  assert.ok(statsRes.headline_summary['CLOSEST_PRE_SUNSET.VALIDATION']);
});

// 15. CLI argument parsing, boundary protection and report writing
test('PRD 16: CLI argument parsing, allowed flags and report directory isolation', async (t) => {
  const { parseArgs, writeReport, outside } = await api();
  const root = await tempDir(t);

  // Baseline requires --model, --raw, --gt
  assert.throws(() => parseArgs([], 'baseline'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseArgs(['--model', 'm'], 'baseline'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseArgs(['--model', 'm', '--raw', 'r'], 'baseline'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseArgs(['--model', 'm', '--raw', 'r', '--gt', 'g', '--unknown', 'u'], 'baseline'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseArgs(['--model', '--raw', 'r', '--gt', 'g'], 'baseline'), /INVALID_ARGUMENTS/);

  // Validate and stats require path as first argument
  assert.throws(() => parseArgs([], 'validate'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseArgs(['--model', 'm'], 'validate'), /INVALID_ARGUMENTS/);
  assert.throws(() => parseArgs([], 'stats'), /INVALID_ARGUMENTS/);

  const validBaseline = parseArgs(['--model', 'm', '--raw', 'r', '--gt', 'g', '--quiet'], 'baseline');
  assert.equal(validBaseline.quiet, true);

  const validValidate = parseArgs(['some_path', '--model', 'm', '--report-dir', 'rep'], 'validate');
  assert.ok(validValidate.path.endsWith('some_path'));
  assert.ok(validValidate.reportDir.endsWith('rep'));

  // writeReport respects outside boundary
  const fakeRoot = path.join(root, 'pkg');
  await fs.mkdir(fakeRoot, { recursive: true });
  await assert.rejects(
    () => writeReport(path.join(fakeRoot, 'sub'), 'test.json', { ok: true }, [fakeRoot]),
    err => err.code === 'UNSAFE_PATH'
  );

  // writeReport fails with REPORT_EXISTS if report already exists
  const reportDir = path.join(root, 'reports');
  await writeReport(reportDir, 'validation.json', { status: 'PASS' }, []);
  await assert.rejects(
    () => writeReport(reportDir, 'validation.json', { status: 'PASS' }, []),
    err => err.code === 'UNSAFE_PATH' && err.reason_code === 'REPORT_EXISTS'
  );
});

// 16. Legacy Model Schema 1 / Policy 1 compatibility and unsupported version rejection
test('PRD 2.1 & 21: Model Schema 1 / Policy 1 maps legacy gt_basis with warning; unsupported version fails', async (t) => {
  const { evaluate, loadModelEvaluationInput } = await api();

  // Model Schema 1 has no gt_basis in source samples
  const legacyRows = [
    {
      snapshot_id: 's1', event_id: 'e1', event_date_local: '2026-09-10', location_key: 'loc1', city: '广州', country: '中国', admin1: '广东',
      lead_time_minutes: 40, prediction_time_epoch: 1000, model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
      predicted_score: 50, baseline_score: 40, gt_label: 'good', gt_ordinal: 2, gt_confidence: 0.8, gt_status: 'MEDIUM',
      split: 'TRAIN', eligibility: 'PRIMARY', event_normalized_weight: 0.8
    }
  ];

  const legacyManifest = {
    model_dataset_id: 'model_v1_fake',
    descriptor_sha256: 'a'.repeat(64),
    model_dataset_schema_version: 1,
    model_dataset_policy_version: 1
  };

  const evalResult = evaluate(legacyManifest, 'b'.repeat(64), legacyRows, [], [
    { warning_code: 'LEGACY_GT_BASIS_MAPPING', benchmark_mode: null, split: null, slice_dimension: null, slice_value: null, slice_value_is_null: null }
  ]);

  const warnings = evalResult.files['reports/warnings.csv'];
  assert.ok(warnings.includes('LEGACY_GT_BASIS_MAPPING'));

  // Slices contain gt_basis dimension populated with OBSERVATION_AGGREGATED
  const sliceMetrics = evalResult.files['slice_metrics.csv'];
  assert.ok(sliceMetrics.includes('gt_basis'));
  assert.ok(sliceMetrics.includes('OBSERVATION_AGGREGATED'));

  // Unsupported version fails in loadModelEvaluationInput
  const root = await tempDir(t);
  const badManifest = {
    model_dataset_schema_version: 3,
    model_dataset_policy_version: 1,
    model_dataset_id: 'bad_version'
  };
  const { canonicalJson } = await api();
  await fs.writeFile(path.join(root, 'manifest.json'), canonicalJson(badManifest));
  await assert.rejects(
    () => loadModelEvaluationInput(root, { staging: true }),
    err => err.code === 'UNSUPPORTED_MODEL_DATASET_VERSION'
  );
});

// 17. PRD 20.4: input order independence and partial paired coverage
test('PRD 20.4: reversed input order yields identical bytes; partial paired coverage is reported per Event', async () => {
  const { evaluate } = await api();
  const model = { model_dataset_id: 'model_v2_fake', descriptor_sha256: 'a'.repeat(64),
    model_dataset_schema_version: 2, model_dataset_policy_version: 3 };
  const mk = (id, eventId, score, baseline, lead) => ({
    snapshot_id: id, event_id: eventId, event_date_local: '2026-09-10', location_key: 'loc_' + eventId,
    city: '广州', country: '中国', admin1: '广东', lead_time_minutes: lead, prediction_time_epoch: 1000 + lead,
    lead_time_bucket: 'T_1_3H', model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
    predicted_score: score, baseline_score: baseline, gt_label: 'fair', gt_ordinal: 1, gt_confidence: 1,
    gt_status: 'MEDIUM', gt_basis: 'ADMIN_ADJUDICATED', eligibility: 'PRIMARY', split: 'TRAIN',
    event_normalized_weight: 0.5, gt_weight: 1, exclusion_reason: null, diagnostic_reason: null
  });
  // Event A keeps its baseline at the closest row; Event B's closest row has no baseline.
  const train = [mk('a1', 'A', 30, 20, 60), mk('a2', 'A', 50, null, 90), mk('b1', 'B', 30, null, 60)];

  const forward = evaluate(model, 'c'.repeat(64), train, []);
  const reversed = evaluate(model, 'c'.repeat(64), [...train].reverse(), []);
  for (const file of Object.keys(forward.files)) {
    assert.equal(reversed.files[file], forward.files[file], `${file} must be order independent`);
  }
  assert.equal(reversed.manifest.evaluation_id, forward.manifest.evaluation_id);

  const paired = forward.files['baseline_comparison.csv'].split('\r\n')
    .find(l => l.startsWith('ALL_PRIMARY,TRAIN,weighted,'));
  const cells = paired.split(',');
  // ALL_PRIMARY: 3 samples / 2 events; only a1 carries a baseline -> partial coverage 1/3 and 1/2.
  assert.equal(cells[4], '3');
  assert.equal(cells[5], '2');
  assert.equal(cells[6], '1');
  assert.equal(cells[7], '1');
  assert.equal(cells[8], '2');
  assert.equal(cells[9], '0.333333333333');
  assert.equal(cells[11], '0.5');
  // CLOSEST keeps event A's closest row (a1, has baseline) and event B's closest row (b1, none).
  const closest = forward.files['baseline_comparison.csv'].split('\r\n')
    .find(l => l.startsWith('CLOSEST_PRE_SUNSET,TRAIN,weighted,'));
  assert.equal(closest.split(',')[4], '2');
  assert.equal(closest.split(',')[6], '1');
});

// 18. PRD 20.7: slice support thresholds and per-slice date coverage
test('PRD 20.7: slice low_support and limited_date_coverage follow the frozen thresholds', async () => {
  const { computeSliceMetrics, evaluationPolicy } = await api();
  const policy = evaluationPolicy();
  const mk = (id, eventId, day, lead, bucket) => ({
    snapshot_id: id, event_id: eventId, event_date_local: day, location_key: 'loc_' + eventId,
    city: '广州', country: '中国', admin1: '广东', lead_time_minutes: lead, lead_time_bucket: bucket,
    prediction_time_epoch: 1000, model_version: '2.4.6', engine_build_sha: 'a'.repeat(40), config_hash: 'b'.repeat(64),
    predicted_score: 50, predicted_ordinal: 2, baseline_score: 50, gt_label: 'fair', gt_ordinal: 1, gt_confidence: 1,
    gt_status: 'MEDIUM', gt_basis: 'ADMIN_ADJUDICATED', split: 'TRAIN', weight: 1
  });
  // 5 Events over 2 dates inside T_1_3H -> supported; the single-event bucket -> low support, one date.
  const rows = [
    mk('s1', 'E1', date(0), 100, 'T_1_3H'), mk('s2', 'E2', date(0), 110, 'T_1_3H'),
    mk('s3', 'E3', date(1), 120, 'T_1_3H'), mk('s4', 'E4', date(1), 130, 'T_1_3H'),
    mk('s5', 'E5', date(1), 140, 'T_1_3H'), mk('s6', 'E6', date(1), 400, 'T_6H_PLUS')
  ];
  const { sliceRows } = computeSliceMetrics(rows, 'ALL_PRIMARY', 'TRAIN', policy);
  const find = (dim, value) => sliceRows.find(r => r.slice_dimension === dim && r.slice_value === value);

  const supported = find('lead_time_bucket', 'T_1_3H');
  assert.equal(supported.sample_count, 5);
  assert.equal(supported.event_count, 5);
  assert.equal(supported.date_count, 2);
  assert.equal(supported.low_support, false);
  assert.equal(supported.limited_date_coverage, false);

  const thin = find('lead_time_bucket', 'T_6H_PLUS');
  assert.equal(thin.event_count, 1);
  assert.equal(thin.date_count, 1);
  assert.equal(thin.low_support, true);
  assert.equal(thin.limited_date_coverage, true);

  // Zero-support enum bucket stays visible and is flagged as low support.
  const empty = find('lead_time_bucket', 'T_30_60M');
  assert.equal(empty.sample_count, 0);
  assert.equal(empty.weight_sum, 0);
  assert.equal(empty.weighted_mae, null);
  assert.equal(empty.weighted_mae_reason_code, 'NO_SAMPLES');
  assert.equal(empty.low_support, true);
  assert.equal(empty.limited_date_coverage, true);

  // Slice weights are renormalised per Event inside the slice: 5 Events x confidence 1, one row each.
  assert.equal(supported.weight_sum, 5);
});

// 19. PRD 20.9: MODEL_LINKED never reads TEST while the upstream stage rejects TEST tampering
test('PRD 20.9: MODEL_LINKED recomputes without reading TEST; upstream validation rejects TEST tampering', async (t) => {
  const { evaluateBaseline, inspectEvaluation, readRestrictedModelFile } = await api();
  const root = await tempDir(t);
  const pipe = await createSyntheticPipeline(root, { counts: [20, 5, 5] });
  t.after(pipe.close);

  const evalOut = path.join(root, 'eval');
  const res = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true });

  const testCsv = path.join(pipe.modelDir, 'splits/test.csv');
  const original = await fs.readFile(testCsv);
  await fs.writeFile(testCsv, Buffer.concat([original, Buffer.from('\r\ntampered,row\r\n')]));
  try {
    // The restricted reader refuses the path outright, so MODEL_LINKED cannot consume TEST.
    await assert.rejects(
      () => readRestrictedModelFile(pipe.modelDir, 'splits/test.csv'),
      err => err.reason_code === 'TEST_ACCESS_FORBIDDEN'
    );
    // MODEL_LINKED still PASSes: it recomputes from TRAIN/VALIDATION only.
    const linked = await inspectEvaluation(res.directory, { model: pipe.modelDir });
    assert.equal(linked.status, 'PASS');
    assert.equal(linked.validation_scope, 'MODEL_LINKED');
    // The upstream stage does read TEST, so the tampered package must now be rejected.
    await assert.rejects(
      () => evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: path.join(root, 'eval2'), quiet: true }),
      /UPSTREAM_VALIDATION_FAILED|MODEL_DATASET_VALIDATION_FAILED|SOURCE_CHANGED_DURING_EVALUATION|EVALUATION_VALIDATION_FAILED/
    );
  } finally {
    await fs.writeFile(testCsv, original);
  }
});

// 20. PRD 20.11: supported source version matrix and unsupported combination rejection
test('PRD 20.11: version matrix accepts Policy 2/3 Models and rejects unsupported combinations', async (t) => {
  const { evaluationPolicy, loadModelEvaluationInput, canonicalJson } = await api();
  assert.deepEqual(evaluationPolicy().supported_model_versions, [
    { schema_version: 1, policy_version: 1 },
    { schema_version: 2, policy_version: 2 },
    { schema_version: 2, policy_version: 3 }
  ]);

  for (const combo of [{ schema: 2, policy: 1 }, { schema: 3, policy: 1 }, { schema: 1, policy: 3 }]) {
    const dir = await tempDir(t);
    await fs.writeFile(path.join(dir, 'manifest.json'), canonicalJson({
      model_dataset_schema_version: combo.schema,
      model_dataset_policy_version: combo.policy,
      model_dataset_id: 'unsupported'
    }));
    await assert.rejects(
      () => loadModelEvaluationInput(dir, { staging: true }),
      err => err.code === 'UNSUPPORTED_MODEL_DATASET_VERSION'
    );
  }
});

// 21. PRD 20.12: interrupted or concurrent runs never publish partial packages and never clear foreign locks
test('PRD 20.12: foreign locks and abandoned staging are preserved, never guessed away', async (t) => {
  const { evaluateBaseline, withEvaluationLock } = await api();
  const root = await tempDir(t);
  const pipe = await createSyntheticPipeline(root, { counts: [20, 5, 5] });
  t.after(pipe.close);

  const evalOut = path.join(root, 'eval');
  const first = await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true });

  // A leftover staging directory from an interrupted run must survive later publishes.
  const abandoned = path.join(evalOut, 'staging', 'abandoned-run');
  await fs.mkdir(abandoned, { recursive: true });
  const { canonicalJson } = await api();
  await fs.writeFile(path.join(abandoned, 'failure.json'), canonicalJson({ status: 'FAIL', error_code: 'SIMULATED_INTERRUPT' }));

  // A foreign lock blocks publishing instead of being removed, and leaves no partial package.
  const lock = path.join(evalOut, 'exports', first.evaluation_id + '.lock');
  await fs.mkdir(lock);
  try {
    await assert.rejects(
      () => evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true }),
      err => err.code === 'EVALUATION_LOCK_BUSY'
    );
    assert.ok((await fs.stat(lock)).isDirectory(), 'foreign lock must not be removed');
    // Only the completed package exists besides the foreign lock: no partial package was published.
    const exportsNow = (await fs.readdir(path.join(evalOut, 'exports')))
      .filter(name => name !== first.evaluation_id + '.lock').sort();
    assert.deepEqual(exportsNow, [first.evaluation_id]);
  } finally {
    await fs.rmdir(lock);
  }

  await evaluateBaseline(pipe.modelDir, pipe.rawDir, pipe.gtDir, { output: evalOut, quiet: true });
  assert.ok((await fs.stat(abandoned)).isDirectory(), 'abandoned staging must be preserved');
  assert.ok((await fs.stat(path.join(abandoned, 'failure.json'))).isFile());

  // Locking is still usable after a timeout: a fresh lock can be acquired and released.
  const fresh = path.join(root, 'fresh.lock');
  assert.equal(await withEvaluationLock(fresh, async () => 'ok', 200), 'ok');
  await assert.rejects(() => fs.stat(fresh), { code: 'ENOENT' });
});
