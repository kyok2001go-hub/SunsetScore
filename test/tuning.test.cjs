const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = path.resolve(__dirname, '..');

let modules;
async function api() {
  return modules ||= Promise.all([
    'tuning/tuning-policy',
    'tuning/tuning-schema',
    'tuning/parameter-registry',
    'tuning/lib/base-config',
    'tuning/lib/engine-runtime',
    'tuning/lib/registry-audit',
    'tuning/lib/constraints',
    'tuning/lib/composition',
    'tuning/lib/experiment',
    'tuning/lib/candidate',
    'tuning/lib/metrics',
    'tuning/lib/stability',
    'tuning/lib/report',
    'tuning/lib/input',
    'tuning/lib/package',
    'tuning/lib/publish',
    'tuning/lib/objective',
    'tuning/candidate-policy',
    'tuning/validate-sensitivity',
    'dataset/lib/common',
    'dataset/lib/csv',
    'evaluation/metrics',
    'progress'
  ].map(name => import(`../tools/${name}.mjs`))).then(list => Object.assign({}, ...list));
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-tuning-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Copies only the files a focused check needs, keeping the suite light on shared runners. */
async function copyFiles(root, relatives) {
  for (const rel of relatives) {
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(APP, rel), target);
  }
}

test('Engine Runtime hash binds the declared file list and detects import-graph drift', async () => {
  const m = await api();
  const doc = await m.runtimeDocument(APP);
  assert.equal(doc.runtime_file_count, m.tuningPolicy().runtime_files.length);
  assert.match(doc.engine_runtime_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(doc.non_scoring_namespace_references, {
    'js/data.js': ['citySearch'],
    'js/nowcast.js': ['cache', 'cacheKeys', 'corridor']
  });

  // A new unlisted scoring namespace must be reported instead of silently hashed away.
  const root = await tempDir(test);
  await copyFiles(root, [
    ...m.tuningPolicy().runtime_files,
    'js/city_search.js', 'js/cache.js', 'js/corridor.js'
  ]);
  const enginePath = path.join(root, 'js/engine.js');
  const source = await fs.readFile(enginePath, 'utf8');
  // citySearch is defined outside the frozen Runtime list and is not declared for engine.js.
  await fs.writeFile(enginePath, source + '\nSS.citySearch.resolve("probe");\n');
  await assert.rejects(
    () => m.verifyRuntimeImports(root),
    error => error.code === 'TUNING_VALIDATION_FAILED' && error.reason_code === 'RUNTIME_IMPORT_GRAPH_DRIFT'
  );
});

test('Tuning Base Config keeps production aliasing and is stable across loads', async () => {
  const m = await api();
  const first = await m.loadFrozenBaseConfig(APP);
  const second = await m.loadFrozenBaseConfig(APP);
  assert.equal(first.sha256, second.sha256);
  const modelConfig = m.buildModelConfig(first.config);
  assert.equal(modelConfig.scoring, first.config);
  assert.equal(modelConfig.goldenWindow, first.config.goldenWindow);
  assert.equal(modelConfig.evolution, first.config.evolution);
  assert.deepEqual(m.verifyAliasIdentity(modelConfig), m.verifyAliasIdentity(modelConfig));
  assert.equal(m.verifyAliasIdentity(modelConfig).ok, true);

  // A broken alias must be rejected rather than silently changing runtime semantics.
  const broken = { ...modelConfig, goldenWindow: { ...first.config.goldenWindow } };
  const report = m.verifyAliasIdentity(broken);
  assert.equal(report.ok, false);
  assert.equal(report.issues[0].issue, 'ALIAS_IDENTITY_BROKEN');
});

test('Registry audit verifies wiring anchors, namespaces and truncation evidence', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const modelConfig = m.buildModelConfig(loaded.config);
  const report = await m.auditRegistry({
    units: m.UNITS, config: loaded.config, modelConfig, root: APP,
    verifyAliasIdentity: m.verifyAliasIdentity, policy: m.tuningPolicy()
  });
  assert.equal(report.units.length, m.UNITS.length);
  const partiallyWired = report.units.find(unit => unit.parameter_id === 'sky_state_factor_range');
  assert.equal(partiallyWired.wired_status, 'PARTIALLY_WIRED');
  assert.equal(partiallyWired.wiring_class, 'DECLARED_SITES_ONLY');
  assert.ok(partiallyWired.verified_truncation_sites.length >= 2);
  const operational = report.units.find(unit => unit.parameter_id === 'viewing_window_peak_offset');
  assert.equal(operational.wired_status, 'OPERATIONAL_ONLY');
  assert.equal(operational.wiring_class, 'DECLARED_SITES_ONLY');

  const stale = [{ ...m.UNITS[0], wiring_evidence: { read_at: [{ file: 'js/engine.js', line: 5, token: 'highCloudCenter' }] } }];
  await assert.rejects(
    () => m.auditRegistry({ units: stale, config: loaded.config, modelConfig, root: APP, verifyAliasIdentity: m.verifyAliasIdentity, policy: m.tuningPolicy() }),
    error => error.reason_code === 'WIRING_ANCHOR_STALE'
  );
  const unreferenced = [{ ...m.UNITS[0], canonical_path: 'highCloudCenter', scan_token: 'noSuchParameterToken' }];
  await assert.rejects(
    () => m.auditRegistry({ units: unreferenced, config: loaded.config, modelConfig, root: APP, verifyAliasIdentity: m.verifyAliasIdentity, policy: m.tuningPolicy() }),
    error => error.reason_code === 'WIRED_BUT_UNREFERENCED'
  );
});

test('Composition Parity gates on both composition branches and config restoration', async () => {
  const m = await api();
  const report = await m.verifyCompositionParity(APP);
  assert.equal(report.check_count, 7);
  assert.ok(report.checks.every(check => check.production && check.runner));

  const root = await tempDir(test);
  await copyFiles(root, ['js/prediction_service.js']);
  await fs.mkdir(path.join(root, 'tools/replay'), { recursive: true });
  const runner = await fs.readFile(path.join(APP, 'tools/replay/replay-runner.mjs'), 'utf8');
  await fs.writeFile(path.join(root, 'tools/replay/replay-runner.mjs'), runner.replace('0.65, 1.15', '0.60, 1.20'));
  await assert.rejects(
    () => m.verifyCompositionParity(root),
    error => error.reason_code === 'COMPOSITION_PARITY_FAILED'
  );
});

test('Constraint layer rejects out-of-range, integer, enum, simplex, monotonic and dependent violations', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const checks = m.validateBaseConfig(m.UNITS, loaded.config);
  assert.ok(checks.length >= m.UNITS.length);

  const unit = m.UNITS.find(item => item.parameter_id === 'high_cloud_center');
  assert.throws(() => m.validateUnitValue(unit, 140, loaded.config), error => error.reason_code === 'RANGE_CONSTRAINT_VIOLATION');
  assert.throws(() => m.validateUnitValue(unit, 42.5, loaded.config), error => error.reason_code === 'INTEGER_CONSTRAINT_VIOLATION');
  assert.deepEqual(m.probeValues(unit, 60), [42, 51, 60, 69, 78]);

  const pair = m.UNITS.find(item => item.parameter_id === 'rain_to_clear_golden_window_min');
  // 100 stays inside the declared range but breaks min <= max(90).
  assert.throws(() => m.validateUnitValue(pair, 100, loaded.config), error => error.reason_code === 'MIN_MAX_CONSTRAINT_VIOLATION');
  assert.throws(() => m.validateUnitValue(pair, 200, loaded.config), error => error.reason_code === 'RANGE_CONSTRAINT_VIOLATION');

  const dependent = m.UNITS.find(item => item.parameter_id === 'satellite_high_cloud_center');
  const disabled = JSON.parse(JSON.stringify(loaded.config));
  disabled.nowcast.satellite.enabled = false;
  assert.throws(() => m.validateUnitValue(dependent, 50, disabled), error => error.reason_code === 'DEPENDENT_CONSTRAINT_VIOLATION');

  // ENUM is a declared per-unit domain; members pass, anything else is rejected outright.
  const enumUnit = { parameter_id: 'enum_probe', canonical_path: 'goldenWindow.enabled', unit_category: 'OAT',
    integer: false, range: null, enum_values: [true, false], extra_constraint_types: [] };
  assert.equal(m.constraintTypesFor(enumUnit).includes('ENUM'), true);
  for (const allowed of [true, false]) m.validateUnitValue(enumUnit, allowed, loaded.config);
  assert.throws(
    () => m.validateUnitValue(enumUnit, 'enabled', loaded.config),
    error => error.reason_code === 'ENUM_CONSTRAINT_VIOLATION'
  );
  assert.throws(
    () => m.validateUnitValue({ ...enumUnit, enum_values: [1, 2, 3] }, 4, loaded.config),
    error => error.reason_code === 'ENUM_CONSTRAINT_VIOLATION'
  );

  const broken = JSON.parse(JSON.stringify(loaded.config));
  broken.weights.skyCanvas = 0.9;
  assert.throws(() => m.validateBaseConfig(m.UNITS, broken), error => error.reason_code === 'SIMPLEX_SUM_VIOLATION');

  const unmonotonic = JSON.parse(JSON.stringify(loaded.config));
  unmonotonic.horizonGate = [...unmonotonic.horizonGate].reverse();
  assert.throws(() => m.validateBaseConfig(m.UNITS, unmonotonic), error => error.reason_code === 'MONOTONIC_CONSTRAINT_VIOLATION');
});

test('SIMPLEX probe renormalises remaining members and keeps the group sum at one', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const group = m.UNITS.find(item => item.parameter_id === 'component_weights');
  const baseline = m.resolvePath(loaded.config, group.canonical_path).value;
  const probes = m.simplexProbes(group, baseline);
  assert.equal(probes.length, group.members.length * group.probe_factors.length);
  for (const probe of probes) {
    const applied = m.applyUnitOverride(loaded.config, group, { member: probe.member, value: probe.value });
    const group2 = m.resolvePath(applied.config, group.canonical_path).value;
    const sum = group.members.reduce((total, name) => total + group2[name], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum} for ${JSON.stringify(probe)}`);
    assert.equal(group2[probe.member], probe.value);
    // Non-target members keep their original proportions.
    const ratioBase = baseline.horizon / baseline.illumination;
    const ratioAfter = group2.horizon / group2.illumination;
    if (probe.member !== 'horizon' && probe.member !== 'illumination') {
      assert.ok(Math.abs(ratioBase - ratioAfter) < 1e-9);
    }
  }
});

test('OAT enforcement allows only one changed path and treats the baseline probe as control parity', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const unit = m.UNITS.find(item => item.parameter_id === 'high_cloud_center');
  const probe = m.applyUnitOverride(loaded.config, unit, { value: 45 });
  const ok = m.assertExperimentDiff(loaded.config, probe.config, { experiment_id: 'x', experiment_kind: 'OAT', probe_value: 45 }, unit, 60);
  assert.deepEqual(ok.changed, ['highCloudCenter']);

  const baseline = m.assertExperimentDiff(loaded.config, m.cloneConfig(loaded.config),
    { experiment_id: 'y', experiment_kind: 'OAT', probe_value: 60 }, unit, 60);
  assert.equal(baseline.control_parity, true);
  assert.deepEqual(baseline.changed, []);

  const multi = m.cloneConfig(loaded.config);
  multi.highCloudWidth = 33;
  assert.throws(
    () => m.assertExperimentDiff(loaded.config, multi, { experiment_id: 'z', experiment_kind: 'OAT', probe_value: 45 }, unit, 60),
    error => error.reason_code === 'OAT_MULTIPLE_CHANGES'
  );
  assert.throws(
    () => m.assertExperimentDiff(loaded.config, m.cloneConfig(loaded.config), { experiment_id: 'w', experiment_kind: 'ABLATION' }, null, null),
    error => error.reason_code === 'ABLATION_CHANGED_NOTHING'
  );
});

test('Phase B reader refuses every non-whitelisted Model path', async () => {
  const m = await api();
  const modelDir = path.join(APP, 'dataset/model/exports/model_v2_ec472a1ae79a_a7e4b16fa93e_7e48bb52a4b9');
  for (const allowed of ['manifest.json', 'schema.json', 'policy.json', 'splits/train.csv']) {
    assert.ok((await m.readRestrictedFile(modelDir, allowed)).length > 0);
  }
  for (const forbidden of ['splits/validation.csv', 'splits/test.csv', 'model_samples.csv', 'event_splits.csv', 'reports/statistics.json']) {
    await assert.rejects(
      () => m.readRestrictedFile(modelDir, forbidden),
      error => error.reason_code === 'TEST_ACCESS_FORBIDDEN' && error.attempted_file === forbidden
    );
  }
});

test('Metrics, score response and Date Stability follow the frozen definitions', async () => {
  const m = await api();
  const rows = [
    { snapshot_id: 's1', event_id: 'e1', event_date_local: '2026-09-10', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1, control_score: 40, experiment_score: 45, control_ordinal: 2, experiment_ordinal: 2, predicted_ordinal: 2, abs_error_delta: 0 },
    { snapshot_id: 's2', event_id: 'e2', event_date_local: '2026-09-11', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1, control_score: 40, experiment_score: 30, control_ordinal: 2, experiment_ordinal: 1, predicted_ordinal: 1, abs_error_delta: -1 }
  ];
  const response = m.scoreResponse([40, 40], [45, 30], [2, 2], [2, 1]);
  assert.equal(response.changed_score_rate, 1);
  assert.equal(response.changed_ordinal_rate, 0.5);
  assert.equal(response.mean_score_delta, -2.5);
  assert.equal(response.mean_abs_score_delta, 7.5);

  const pair = m.metricPair(rows);
  assert.equal(pair.control.mae, 1);
  assert.equal(pair.experiment.mae, 0.5);
  assert.equal(pair.deltas.delta_mae, -0.5);
  assert.equal(pair.deltas.delta_exact_accuracy, 0.5);

  const folds = m.leaveOneDateOut(rows, 'experiment_ordinal');
  assert.equal(folds.date_count, 2);
  // Dropping 09-11 leaves only the improving sample; dropping 09-10 leaves a neutral fold.
  assert.equal(folds.fold_count, 1);
  assert.equal(folds.improved_date_count, 1);
  assert.equal(folds.degraded_date_count, 0);
  assert.equal(folds.direction_stability_ratio, 1);
  assert.equal(folds.limited_date_coverage, true);
  const single = m.leaveOneDateOut([rows[0]], 'experiment_ordinal');
  assert.equal(single.reason_code, 'INSUFFICIENT_DATES_FOR_LODO');
  assert.equal(single.fold_count, 0);
});

test('Per-experiment metric rows carry their own Leave-One-Date-Out folds', async () => {
  const m = await api();
  const rows = [
    { snapshot_id: 's1', event_id: 'e1', event_date_local: '2026-09-10', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1, control_score: 40, experiment_score: 45, control_ordinal: 2, experiment_ordinal: 2 },
    { snapshot_id: 's2', event_id: 'e2', event_date_local: '2026-09-11', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1, control_score: 40, experiment_score: 30, control_ordinal: 2, experiment_ordinal: 1 }
  ];
  const stability = m.leaveOneDateOut(rows, 'experiment_ordinal');
  const metric = m.experimentMetricRow({
    entry: { experiment_id: 'oat_x_1', experiment_kind: 'OAT', parameter_id: 'x', group_id: null, canonical_path: 'x', probe_value: 1, ablation: null },
    rows, composition: null, stability,
    coverage: { cohort_sample_count: 2, paired_sample_count: 2, paired_event_count: 2, coverage_rate: 1, failure_count: 0, control_failure_count: 0, experiment_failure_count: 0 }
  });
  assert.equal(metric.lodo_fold_count, stability.fold_count);
  assert.equal(metric.lodo_improved_count, 1);
  assert.equal(metric.lodo_degraded_count, 0);
  assert.equal(metric.lodo_stability_ratio, 1);
  assert.equal(metric.limited_date_coverage, true);
  assert.equal(metric.lodo_reason_code, null);
  assert.equal(metric.coverage_rate, 1);
  assert.equal(metric.paired_sample_count, metric.sample_count);
  assert.equal(metric.failure_count, 0);

  // Every column the schema declares must be present, otherwise writeCsv would reject it.
  for (const field of m.EXPERIMENT_METRICS_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(metric, field.name), `missing column ${field.name}`);
  }
  assert.throws(
    () => m.experimentMetricRow({ entry: { experiment_id: 'x' }, rows, composition: null }),
    error => error.reason_code === 'MISSING_EXPERIMENT_STABILITY'
  );
  assert.throws(
    () => m.experimentMetricRow({ entry: { experiment_id: 'x' }, rows, composition: null, stability }),
    error => error.reason_code === 'MISSING_EXPERIMENT_COVERAGE'
  );
});

test('Parameter level stability uses the most consequential probe instead of mixing folds', async () => {
  const m = await api();
  // Two probes with opposite directions: probe A improves on every fold, probe B degrades on
  // every fold. Max-merging their fold counts would report 3 improved + 3 degraded = 0.5 and
  // hide that each probe is perfectly date stable.
  const ctx = {
    units: [{
      parameter_id: 'p1', group_id: null, canonical_path: 'x', unit_category: 'OAT',
      replay_class: 'REPLAY_SAFE', wired_status: 'WIRED', optimizable: true,
      ablation_supported: false, activation_condition: 'always', integer: false,
      range: [0, 10], extra_constraint_types: [], probe_offsets: [], trigger_regimes: null,
      min_support: { events: 5, dates: 2 }
    }],
    cohort: [
      { snapshot_id: 's1', event_id: 'e1', event_date_local: '2026-09-10', support: {} },
      { snapshot_id: 's2', event_id: 'e2', event_date_local: '2026-09-11', support: {} },
      { snapshot_id: 's3', event_id: 'e3', event_date_local: '2026-09-12', support: {} }
    ]
  };
  const entry = (id, probe) => ({ experiment_id: id, experiment_kind: 'OAT', parameter_id: 'p1', group_id: null, canonical_path: 'x', probe_value: probe, ablation: null });
  const metric = (id, deltaMae, improved, degraded) => ({
    experiment_id: id, changed_score_rate: 1, mean_abs_score_delta: Math.abs(deltaMae), delta_mae: deltaMae,
    lodo_fold_count: improved + degraded, lodo_improved_count: improved, lodo_degraded_count: degraded,
    lodo_stability_ratio: (improved + degraded) ? Math.max(improved, degraded) / (improved + degraded) : null,
    lodo_reason_code: (improved + degraded) ? null : 'NO_DIRECTIONAL_FOLDS',
    limited_date_coverage: true
  });
  const results = [
    { entry: entry('probe_a', 1), rows: [] },
    { entry: entry('probe_b', 2), rows: [] }
  ];
  const experimentMetrics = [metric('probe_a', -0.10, 3, 0), metric('probe_b', 0.40, 0, 3)];
  const summary = m.parameterSummaryRows({ ctx, results, experimentMetrics });
  const row = summary.find(item => item.parameter_id === 'p1');

  assert.equal(row.stability_representative_experiment_id, 'probe_b');
  assert.equal(row.date_count, 3);
  assert.equal(row.improved_date_count, 0);
  assert.equal(row.degraded_date_count, 3);
  assert.equal(row.direction_stability_ratio, 1);

  // With equal |delta_mae| the tie breaks on the smaller experiment_id.
  const tied = m.parameterSummaryRows({
    ctx, results,
    experimentMetrics: [metric('probe_a', 0.25, 3, 0), metric('probe_b', -0.25, 0, 3)]
  }).find(item => item.parameter_id === 'p1');
  assert.equal(tied.stability_representative_experiment_id, 'probe_a');
  assert.equal(tied.improved_date_count, 3);
  assert.equal(tied.direction_stability_ratio, 1);
});

test('Slice rows carry the originating experiment, parameter and probe value', async () => {
  const m = await api();
  assert.ok(m.SLICE_DELTA_FIELDS.some(field => field.name === 'parameter_id'));
  assert.ok(m.SLICE_DELTA_FIELDS.some(field => field.name === 'parameter_value'));

  const row = (id, eventId, control, experiment, controlOrdinal, experimentOrdinal) => ({
    snapshot_id: id, event_id: eventId, event_date_local: '2026-09-10', location_key: 'loc1',
    lead_time_bucket: 'T_1_3H', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1,
    control_score: control, experiment_score: experiment,
    control_ordinal: controlOrdinal, experiment_ordinal: experimentOrdinal,
    abs_error_delta: Math.abs(experimentOrdinal - 1) - Math.abs(controlOrdinal - 1)
  });
  const rows = [row('s1', 'e1', 40, 35, 2, 1), row('s2', 'e2', 40, 45, 2, 2)];

  const oat = m.sliceAggregate(rows, { experiment_id: 'oat_p1_7', parameter_id: 'p1', probe_value: 7, ablation: null },
    ['lead_time_bucket'], m.FIXED_SLICE_ENUMS);
  const bucket = oat.find(item => item.slice_value === 'T_1_3H');
  assert.equal(bucket.experiment_id, 'oat_p1_7');
  assert.equal(bucket.parameter_id, 'p1');
  assert.equal(bucket.parameter_value, 7);
  for (const field of m.SLICE_DELTA_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(bucket, field.name), `missing column ${field.name}`);
  }

  // Ablations have no parameter or probe value; the columns stay null instead of being omitted.
  const ablation = m.sliceAggregate(rows, { experiment_id: 'ablation_no_golden_window', parameter_id: null, probe_value: null, ablation: 'NO_GOLDEN_WINDOW' },
    ['lead_time_bucket'], m.FIXED_SLICE_ENUMS);
  assert.equal(ablation[0].parameter_id, null);
  assert.equal(ablation[0].parameter_value, null);
});

test('A failed experiment Replay drops only that Snapshot and reports coverage', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const unit = m.UNITS.find(item => item.parameter_id === 'high_cloud_center');
  const plan = m.planExperiments({ units: [unit], ablations: [], config: loaded.config }).slice(0, 1);

  const cohortRow = (index, failMode) => ({
    snapshot_id: `snap_${String(index).padStart(2, '0')}`,
    event_id: `evt_${index}`,
    event_date_local: '2026-09-10',
    city: '测试市',
    location_key: `loc_${index}`,
    lead_time_bucket: 'T_1_3H',
    gt_label: 'fair', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1,
    replay: { failMode, score: 40 + index }
  });
  // 20 snapshots: one experiment failure keeps coverage at exactly the 0.95 gate.
  const cohort = Array.from({ length: 20 }, (_, index) => cohortRow(index, index === 7 ? 'experiment' : 'none'));
  const attempts = new WeakMap();
  const stub = async replay => {
    // Control runs first, then every experiment; a replay can therefore be told apart.
    const attempt = (attempts.get(replay) || 0) + 1;
    attempts.set(replay, attempt);
    const failing = (replay.failMode === 'control' && attempt === 1) ||
      (replay.failMode === 'experiment' && attempt > 1);
    if (failing) throw Object.assign(new Error('REPLAY_FAILED'), { code: 'REPLAY_FAILED' });
    return { actual: { score: replay.score, gw_factor: 1, sky_evolution_factor: 1 }, pass: true, reference: null, deltas: {} };
  };

  const { results, failures } = await m.runExperiments({
    plan, units: [unit], ablations: [], cohort, config: loaded.config, runReplay: stub, progress: m.silentProgress
  });
  const coverage = results[0].coverage;
  assert.equal(coverage.cohort_sample_count, 20);
  assert.equal(coverage.paired_sample_count, 19);
  assert.equal(coverage.failure_count, 1);
  assert.equal(coverage.experiment_failure_count, 1);
  assert.equal(coverage.control_failure_count, 0);
  assert.equal(coverage.coverage_rate, 0.95);
  assert.equal(results[0].rows.some(row => row.snapshot_id === 'snap_07'), false);
  assert.equal(results[0].rows.length, 19);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, 'EXPERIMENT');
  assert.equal(failures[0].experiment_id, results[0].entry.experiment_id);
  assert.equal(failures[0].snapshot_id, 'snap_07');
  assert.equal(failures[0].error_code, 'REPLAY_FAILED');

  // The reduced-coverage row must be acceptable to the validator: a degraded package is
  // publishable as long as it stays above the policy floor.
  const metricRow = m.experimentMetricRow({
    entry: results[0].entry, rows: results[0].rows, composition: null,
    stability: m.leaveOneDateOut(results[0].rows, 'experiment_ordinal'),
    coverage
  });
  assert.equal(m.assertCoverageAccounting(metricRow, { cohortSampleCount: 20, minCoverageRate: 0.95 }), true);
  assert.throws(
    () => m.assertCoverageAccounting({ ...metricRow, coverage_rate: 1 }, { cohortSampleCount: 20, minCoverageRate: 0.95 }),
    error => error.reason_code === 'COVERAGE_RATE_MISMATCH'
  );
  assert.throws(
    () => m.assertCoverageAccounting({ ...metricRow, failure_count: 0 }, { cohortSampleCount: 20, minCoverageRate: 0.95 }),
    error => error.reason_code === 'COVERAGE_FAILURE_COUNT_MISMATCH'
  );
  assert.throws(
    () => m.assertCoverageAccounting(
      {
        ...metricRow,
        sample_count: 9, paired_sample_count: 9, event_count: 9, paired_event_count: 9,
        failure_count: 11, control_failure_count: 0, experiment_failure_count: 11, coverage_rate: 0.45
      },
      { cohortSampleCount: 20, minCoverageRate: 0.95 }),
    error => error.reason_code === 'COVERAGE_BELOW_MINIMUM'
  );
});

test('Coverage below the policy floor fails the whole run instead of shipping it', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const unit = m.UNITS.find(item => item.parameter_id === 'high_cloud_center');
  const plan = m.planExperiments({ units: [unit], ablations: [], config: loaded.config }).slice(0, 1);
  const cohortRow = (index, failMode) => ({
    snapshot_id: `snap_${index}`, event_id: `evt_${index}`, event_date_local: '2026-09-10',
    city: '测试市', location_key: `loc_${index}`, lead_time_bucket: 'T_1_3H',
    gt_label: 'fair', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1,
    replay: { failMode, score: 40 + index }
  });
  const attempts = new WeakMap();
  const stub = async replay => {
    const attempt = (attempts.get(replay) || 0) + 1;
    attempts.set(replay, attempt);
    const failing = (replay.failMode === 'control' && attempt === 1) ||
      (replay.failMode === 'experiment' && attempt > 1);
    if (failing) throw Object.assign(new Error('REPLAY_FAILED'), { code: 'REPLAY_FAILED' });
    return { actual: { score: replay.score, gw_factor: 1, sky_evolution_factor: 1 }, pass: true, reference: null, deltas: {} };
  };

  // 10 snapshots with 1 experiment failure: 0.9 < 0.95, so the run must fail rather than publish.
  const short = Array.from({ length: 10 }, (_, index) => cohortRow(index, index === 3 ? 'experiment' : 'none'));
  await assert.rejects(
    () => m.runExperiments({ plan, units: [unit], ablations: [], cohort: short, config: loaded.config, runReplay: stub, progress: m.silentProgress }),
    error => error.code === 'TUNING_COVERAGE_BELOW_MINIMUM' && error.coverage_rate === 0.9 && error.min_coverage_rate === 0.95
  );

  // A failing Control removes the Snapshot from every experiment and is reported as CONTROL.
  const twenty = Array.from({ length: 20 }, (_, index) => cohortRow(index, index === 4 ? 'control' : 'none'));
  const controlFailure = await m.runExperiments({
    plan, units: [unit], ablations: [], cohort: twenty, config: loaded.config, runReplay: stub, progress: m.silentProgress
  });
  assert.equal(controlFailure.results[0].coverage.control_failure_count, 1);
  assert.equal(controlFailure.results[0].coverage.experiment_failure_count, 0);
  assert.equal(controlFailure.results[0].coverage.coverage_rate, 0.95);
  assert.equal(controlFailure.failures[0].stage, 'CONTROL');
  assert.equal(controlFailure.failures[0].experiment_id, null);
  assert.equal(controlFailure.failures[0].parameter_id, null);
});

/** Cohort rows in the shape loadReplayCohort produces, driven by a scripted Replay stub. */
function candidateCohort(count, failModes = {}) {
  return Array.from({ length: count }, (_, index) => ({
    snapshot_id: `snap_${String(index).padStart(2, '0')}`,
    event_id: `evt_${index}`,
    event_date_local: '2026-09-10',
    city: '测试市',
    location_key: `loc_${index}`,
    lead_time_bucket: 'T_1_3H',
    gt_label: 'fair', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1,
    replay: { failMode: failModes[index] || 'none', score: 40 + index }
  }));
}

function scriptedReplay(attempts) {
  return async replay => {
    const attempt = (attempts.get(replay) || 0) + 1;
    attempts.set(replay, attempt);
    const failing = (replay.failMode === 'control' && attempt === 1) ||
      (replay.failMode === 'experiment' && attempt > 1);
    if (failing) throw Object.assign(new Error('REPLAY_FAILED'), { code: 'REPLAY_FAILED' });
    return { actual: { score: replay.score, gw_factor: 1, sky_evolution_factor: 1 }, pass: true, reference: null, deltas: {} };
  };
}

test('A joint candidate vector moves several registry units and reports one objective value', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const cohort = candidateCohort(12);
  let replays = 0;
  const inner = scriptedReplay(new WeakMap());
  const runReplay = async (replay, options) => { replays++; return inner(replay, options); };

  const prepared = await m.prepareCandidateRun({
    cohort, config: loaded.config, units: m.UNITS, runReplay, progress: m.silentProgress
  });
  // Control is computed once for the whole batch, not once per candidate.
  assert.equal(replays, 12);

  const vector = { high_cloud_center: 55, high_cloud_width: 20, canvas_weights: { high: 0.34 } };
  const resolved = m.resolveCandidate({ vector, units: m.UNITS, config: loaded.config });
  assert.equal(resolved.status, 'FEASIBLE');
  assert.equal(resolved.changes.length, 3);
  // The same move is illegal for a single-unit sensitivity experiment, which is exactly the
  // restriction a joint search has to leave behind.
  assert.ok(m.diffConfigPaths(loaded.config, resolved.config).length >= 3);

  const result = await m.evaluateCandidate({ prepared, vector });
  assert.equal(result.status, 'FEASIBLE');
  assert.equal(result.changes.length, 3);
  assert.equal(result.vector.high_cloud_center, 55);
  assert.equal(result.coverage.coverage_rate, 1);
  assert.equal(result.objective.primary.metric, 'mae');
  assert.equal(typeof result.objective_value, 'number');
  assert.equal(result.objective_value, result.metrics.weighted.mae);
  assert.equal(result.deltas.delta_mae, result.metrics.weighted.mae - result.control_metrics.weighted.mae);
  // The simplex member renormalises the untouched members instead of silently breaking the sum.
  const composition = result.composition.canvas_weights;
  assert.ok(Math.abs(composition.high + composition.mid + composition.low - 1) < 1e-9);

  // A vector equal to the frozen base is legal and scores exactly like the Control.
  const parity = await m.evaluateCandidate({ prepared, vector: {} });
  assert.equal(parity.status, 'FEASIBLE');
  assert.equal(parity.changes.length, 0);
  assert.equal(parity.objective_value, parity.control_metrics.weighted.mae);
});

test('Infeasible candidate vectors are refused by the constraint gate before any Replay', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const cohort = candidateCohort(10);
  let replays = 0;
  const inner = scriptedReplay(new WeakMap());
  const runReplay = async (replay, options) => { replays++; return inner(replay, options); };
  const prepared = await m.prepareCandidateRun({
    cohort, config: loaded.config, units: m.UNITS, runReplay, progress: m.silentProgress
  });
  const afterControl = replays;

  const cases = [
    [{ high_cloud_center: 999 }, 'RANGE_CONSTRAINT_VIOLATION'],
    [{ high_cloud_center: 55.5 }, 'INTEGER_CONSTRAINT_VIOLATION'],
    [{ rain_to_clear_golden_window_min: 100 }, 'MIN_MAX_CONSTRAINT_VIOLATION'],
    [{ canvas_weights: { high: 0.9, mid: 0.9, low: 0.9 } }, 'SIMPLEX_SUM_VIOLATION'],
    [{ sky_state_factor_range: [0, 2] }, 'PARAMETER_NOT_OPTIMIZABLE'],
    [{ not_a_parameter: 1 }, 'UNKNOWN_PARAMETER']
  ];
  for (const [vector, reason_code] of cases) {
    const result = await m.evaluateCandidate({ prepared, vector });
    assert.equal(result.status, 'INFEASIBLE', `${reason_code} should be INFEASIBLE`);
    assert.equal(result.reason_code, reason_code);
    assert.equal(result.metrics, null);
    assert.equal(result.objective_value, null);
  }
  // A refused vector never reaches the Replay runtime: the batch costs nothing but the Control.
  assert.equal(replays, afterControl);
});

test('A candidate below the coverage floor is UNEVALUABLE instead of silently scored', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const vector = { high_cloud_center: 55 };
  const run = async cohort => m.prepareCandidateRun({
    cohort, config: loaded.config, units: m.UNITS,
    runReplay: scriptedReplay(new WeakMap()), progress: m.silentProgress
  });

  // 18/20 pairs = 0.90 < 0.95: the candidate cannot be ranked.
  const short = await run(candidateCohort(20, { 3: 'experiment', 7: 'experiment' }));
  const unevaluable = await m.evaluateCandidate({ prepared: short, vector });
  assert.equal(unevaluable.status, 'UNEVALUABLE');
  assert.equal(unevaluable.reason_code, 'COVERAGE_BELOW_MINIMUM');
  assert.equal(unevaluable.coverage.coverage_rate, 0.9);
  assert.equal(unevaluable.coverage.failure_count, 2);
  assert.equal(unevaluable.metrics, null);
  assert.equal(unevaluable.objective_value, null);

  // 19/20 pairs = 0.95 is exactly at the floor and stays rankable.
  const at = await run(candidateCohort(20, { 3: 'experiment' }));
  const feasible = await m.evaluateCandidate({ prepared: at, vector });
  assert.equal(feasible.status, 'FEASIBLE');
  assert.equal(feasible.coverage.coverage_rate, 0.95);
  assert.ok(feasible.metrics.weighted.mae !== null);
});

test('Candidate ranking orders feasibility, the primary objective and tie-breakers', async () => {
  const m = await api();
  const objective = m.candidatePolicy().objective;
  const entry = (candidate_id, status, values) => ({
    candidate_id, status, metrics: { weighted: { mae: null, severe_error_rate: null, qwk: null, ...values } }
  });
  const best = entry('c_ccc', 'FEASIBLE', { mae: 0.5, severe_error_rate: 0.05, qwk: 0.1 });
  const betterQwk = entry('c_ddd', 'FEASIBLE', { mae: 0.5, severe_error_rate: 0.1, qwk: 0.6 });
  const worseQwk = entry('c_aaa', 'FEASIBLE', { mae: 0.5, severe_error_rate: 0.1, qwk: 0.4 });
  const worsePrimary = entry('c_bbb', 'FEASIBLE', { mae: 0.6, severe_error_rate: 0, qwk: 0.9 });
  const nullish = entry('c_ggg', 'FEASIBLE', {});
  const violated = entry('c_eee', 'INFEASIBLE', { mae: 0.1, severe_error_rate: 0, qwk: 1 });
  const uncovered = entry('c_fff', 'UNEVALUABLE', { mae: 0.1, severe_error_rate: 0, qwk: 1 });

  const ranked = m.rankCandidates(
    [worsePrimary, violated, worseQwk, betterQwk, uncovered, best, nullish], objective
  ).map(result => result.candidate_id);
  assert.deepEqual(ranked, ['c_ccc', 'c_ddd', 'c_aaa', 'c_bbb', 'c_ggg', 'c_eee', 'c_fff']);

  // The comparator must be antisymmetric, otherwise Array.sort order depends on input order.
  for (const [left, right] of [[best, worsePrimary], [betterQwk, worseQwk], [violated, uncovered], [nullish, best]]) {
    assert.equal(
      Math.sign(m.compareCandidates(left, right, objective)),
      -Math.sign(m.compareCandidates(right, left, objective))
    );
  }
  assert.equal(m.compareCandidates(best, { ...best }), 0);
  assert.equal(m.compareCandidates(best, { ...best, candidate_id: 'c_zzz' }), -1);
  // Ranking is stable: the same batch in a different submission order returns the same order.
  assert.deepEqual(
    m.rankCandidates([nullish, uncovered, best, violated], objective).map(result => result.candidate_id),
    ['c_ccc', 'c_ggg', 'c_eee', 'c_fff']
  );
});

test('Candidate cohort reads VALIDATION but can never reach TEST', async () => {
  const m = await api();
  const modelDir = path.join(APP, 'dataset/model/exports/model_v2_ec472a1ae79a_a7e4b16fa93e_7e48bb52a4b9');
  const rawDir = path.join(APP, 'dataset/exports/raw_v1_20260907_20260914_ec472a1ae79a');

  const cohort = await m.loadCandidateCohort({ modelDir, rawDir, split: 'VALIDATION' });
  assert.equal(cohort.split, 'VALIDATION');
  assert.ok(cohort.rows.length > 0);
  assert.ok(cohort.cohort.every(row => row.split === 'VALIDATION'));
  assert.deepEqual(cohort.allowFiles, ['manifest.json', 'schema.json', 'policy.json', 'splits/validation.csv']);
  assert.equal(m.SPLIT_FILE.TEST, undefined);
  assert.equal(m.candidatePolicy().allowed_splits.includes('TEST'), false);
  assert.equal(m.candidatePolicy().forbidden_splits.includes('TEST'), true);

  assert.throws(() => m.candidateAllowFiles('TEST'), error => error.reason_code === 'UNSUPPORTED_SPLIT');
  await assert.rejects(
    () => m.loadCandidateCohort({ modelDir, rawDir, split: 'TEST' }),
    error => error.reason_code === 'UNSUPPORTED_SPLIT'
  );
  await assert.rejects(
    () => m.readRestrictedFile(modelDir, 'splits/test.csv', { allowFiles: m.candidateAllowFiles('VALIDATION') }),
    error => error.reason_code === 'TEST_ACCESS_FORBIDDEN'
  );
});

test('Package contents are deterministic and the identity changes with the inputs', async () => {
  const m = await api();
  const loaded = await m.loadFrozenBaseConfig(APP);
  const input = {
    engineRuntime: { engine_runtime_sha256: 'a'.repeat(64), runtime_file_count: 15, runtime_files: [], non_scoring_namespace_references: {} },
    baseConfig: { tuning_base_config_sha256: loaded.sha256, config: loaded.config },
    registry: m.registryDocument(),
    readiness: { global_readiness: 'EXPLORATORY', reasons: [], metrics: {}, thresholds: {}, cohort: {}, parameter_readiness: [], warnings: [] },
    parityRows: [], planRows: [], experimentMetrics: [], sampleDeltas: [], sliceDeltas: [],
    ablationMetrics: [], experimentFailureRows: [], parameterSummary: [], warningRows: [],
    summary: { sensitivity_id: null, model_dataset_id: 'm', evaluation_id: 'e', global_readiness: 'EXPLORATORY', result_usage: 'EXPLORATORY_ONLY', cohort: {}, experiment_count: 0, replay_parity: {}, parameter_summary: [], ablation_summary: [], warnings_summary: {} }
  };
  const first = m.contents(input);
  const second = m.contents(input);
  assert.deepEqual(Object.keys(first).sort(), [...m.FILES].sort());
  for (const file of m.FILES) assert.equal(first[file], second[file], file);
  assert.match(first['schema.json'], /tuning_schema_version/);
  assert.ok(first['replay_parity.csv'].endsWith('\r\n'));
  assert.ok(first['replay_parity.csv'].startsWith('\uFEFF'));

  const metadata = m.filesMetadata(first);
  const descriptor = m.descriptorOf({
    model_dataset_id: 'm', model_dataset_manifest_sha256: 'b'.repeat(64), model_dataset_descriptor_sha256: 'c'.repeat(64),
    evaluation_id: 'e', evaluation_manifest_sha256: 'd'.repeat(64),
    engine_runtime_sha256: 'a'.repeat(64), tuning_base_config_sha256: loaded.sha256, parameter_registry_sha256: 'e'.repeat(64)
  }, metadata, { splits: ['TRAIN'], experiment_count: 0 });
  const identity = m.identity(descriptor);
  assert.match(identity.sensitivity_id, /^sensitivity_v1_[a-f0-9]{12}_[a-f0-9]{12}$/);
  const changed = { ...descriptor, tuning_base_config_sha256: 'f'.repeat(64) };
  assert.notEqual(m.identity(changed).sensitivity_id, identity.sensitivity_id);
});

test('Publish publishes atomically, deduplicates identical content and rejects conflicts', async (t) => {
  const m = await api();
  const root = await tempDir(t);
  const files = Object.fromEntries(m.FILES.map(file => [file, `\uFEFF${file}\r\nx\r\n`]));
  const manifest = {
    sensitivity_id: 'sensitivity_v1_aaaaaaaaaaaa_bbbbbbbbbbbb',
    descriptor: { k: 1 },
    files: Object.fromEntries(m.FILES.map(file => [file, { sha256: 'x', bytes: 10, rows: 1 }]))
  };
  const options = {
    output: path.join(root, 'out'), roots: [], files, manifest,
    validateStaging: async () => {}, sourceCheck: async () => {}
  };
  const first = await m.publishPackage(options);
  assert.equal(first.status, 'EXPORTED');
  const second = await m.publishPackage(options);
  assert.equal(second.status, 'DEDUPLICATED');

  const conflict = { ...options, manifest: { ...manifest, descriptor: { k: 2 } } };
  await assert.rejects(() => m.publishPackage(conflict), error => error.code === 'SENSITIVITY_ID_CONFLICT');

  const lock = path.join(root, 'out', 'exports', `${manifest.sensitivity_id}.lock`);
  await fs.mkdir(lock, { recursive: true });
  await assert.rejects(
    () => m.withTuningLock(lock, async () => 'never', 200),
    error => error.code === 'TUNING_LOCK_BUSY'
  );
  assert.ok((await fs.stat(lock)).isDirectory(), 'a foreign lock must not be removed');
  await fs.rmdir(lock);
});

test('Published Sensitivity package is internally consistent when present', async (t) => {
  const exportsDir = path.join(APP, 'dataset/tuning/exports');
  if (!fssync.existsSync(exportsDir)) {
    t.skip('no published tuning package in this checkout');
    return;
  }
  const entries = fssync.readdirSync(exportsDir).filter(name => name.startsWith('sensitivity_v1_'));
  if (!entries.length) {
    t.skip('no published tuning package in this checkout');
    return;
  }
  const m = await api();
  const result = await m.inspectSensitivity(path.join(exportsDir, entries[0]));
  assert.equal(result.status, 'PASS');
  assert.equal(result.validation_scope, 'PACKAGE_INTERNAL');
  assert.equal(result.manifest.evaluated_splits.join(','), 'TRAIN');
  assert.equal(result.manifest.validation_evaluated, false);
  assert.equal(result.manifest.test_evaluated, false);
  assert.equal(result.manifest.computation_access_policy, 'TRAIN_ONLY');
});
