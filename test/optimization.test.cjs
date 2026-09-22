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
    'optimization/optimization-policy',
    'optimization/optimization-schema',
    'optimization/lib/candidate',
    'optimization/lib/beam',
    'optimization/lib/generator',
    'optimization/lib/metrics',
    'optimization/lib/guardrails',
    'optimization/lib/finalist',
    'optimization/lib/search-space',
    'optimization/lib/readiness',
    'optimization/lib/input',
    'optimization/lib/package',
    'optimization/lib/build',
    'optimization/validate-optimization',
    'maintenance/maintenance-policy',
    'dataset/lib/common'
  ].map(name => import(`../tools/${name}.mjs`))).then(list => Object.assign({}, ...list));
}

/**
 * A tiny synthetic Search Space. The frozen `horizonGate` pair keeps the shared Tuning
 * Constraint layer happy without needing the production config.
 */
function syntheticSpace(overrides = {}) {
  const config = {
    a: 10,
    b: 20,
    horizonGate: [{ min: 10, gate: 30 }, { min: 5, gate: 20 }]
  };
  const unitA = {
    parameter_id: 'a', canonical_path: 'a', unit_category: 'OAT', group_id: null,
    optimizable: true, wired_status: 'WIRED', replay_class: 'REPLAY_SAFE',
    integer: false, range: [0, 20], probe_offsets: [-0.3, -0.15, 0, 0.15, 0.3]
  };
  const unitB = {
    parameter_id: 'b', canonical_path: 'b', unit_category: 'OAT', group_id: null,
    optimizable: true, wired_status: 'WIRED', replay_class: 'REPLAY_SAFE',
    integer: true, range: [0, 40], probe_absolute: [10, 20, 30]
  };
  return {
    search_space_id: 'TEST_SPACE',
    search_space_version: 1,
    candidate_normalization_version: 1,
    unit_order: ['a', 'b'],
    declared_units: ['a', 'b'],
    excluded_units: [],
    numeric_precision_decimal_places: 12,
    metric_output_decimal_places: 12,
    metric_compare_epsilon: 1e-12,
    units: [
      { unit_order: 1, parameter_id: 'a', group_id: null, unit_category: 'OAT', canonical_path: 'a',
        baseline_value: 10, coarse_values: [7, 8.5, 10, 11.5, 13], integer: false, range: [0, 20],
        refinement_step: 1.5, included: true, exclusion_reason: null },
      { unit_order: 2, parameter_id: 'b', group_id: null, unit_category: 'OAT', canonical_path: 'b',
        baseline_value: 20, coarse_values: [10, 20, 30], integer: true, range: [0, 40],
        refinement_step: 10, included: true, exclusion_reason: null }
    ],
    registry_units: { a: unitA, b: unitB },
    base_config: { config, sha256: 'synthetic' },
    optimization_input_id: 'optimization_input_synthetic',
    ...overrides
  };
}

test('Optimization Policy and Schema stay isolated from Sensitivity V2', async () => {
  const m = await api();
  const schema = m.optimizationSchema();
  assert.equal(schema.optimization_schema_version, 1);
  assert.equal(schema.optimization_policy_version, 1);
  assert.ok(schema.files.export.includes('search_points.json'));
  assert.ok(schema.files.export.includes('finalists.json'));
  assert.ok(!schema.files.export.includes('candidate_freeze.json'));
  assert.equal(schema.files.freeze, 'candidate_freeze.json');
  assert.deepEqual(m.optimizationPolicy().search_space.declared_units, [
    'component_weights', 'atmosphere_quality_base', 'atmosphere_quality_scale',
    'high_cloud_center', 'high_cloud_width'
  ]);
  assert.equal(m.optimizationPolicy().algorithm.stage_a_b_budget + m.optimizationPolicy().algorithm.stage_c_budget,
    m.optimizationPolicy().algorithm.max_unique_candidates);
});

test('Phase B readers cannot reach VALIDATION, TEST or Sensitivity sample tables', async () => {
  const m = await api();
  assert.deepEqual([...m.MODEL_ALLOW_FILES].sort(), ['manifest.json', 'policy.json', 'schema.json', 'splits/train.csv']);
  for (const file of m.SENSITIVITY_ALLOW_FILES) {
    assert.equal(file.startsWith('splits/'), false, file);
  }
  assert.equal(m.SENSITIVITY_ALLOW_FILES.some(file => file.includes('test')), false);
  for (const forbidden of ['splits/validation.csv', 'splits/test.csv', 'sample_deltas.csv', 'slice_deltas.csv']) {
    await assert.rejects(() => m.readSensitivityFile(APP, forbidden),
      error => error.code === 'OPTIMIZATION_VALIDATION_FAILED' && error.reason_code === 'OPTIMIZATION_ACCESS_FORBIDDEN');
  }
});

test('Candidate identity is defined on the effective config, not on the raw vector', async () => {
  const m = await api();
  const space = syntheticSpace();
  const base = { vector: {}, searchSpace: space, baseConfig: space.base_config, optimizationInputId: space.optimization_input_id };
  const control = m.canonicalizeCandidate(base);
  const explicit = m.canonicalizeCandidate({ ...base, vector: { a: 10, b: 20 } });
  assert.equal(control.baseline_equivalent, true);
  assert.equal(control.changed_unit_count, 0);
  assert.equal(control.candidate_id, explicit.candidate_id);
  assert.equal(m.candidateKey(control), m.candidateKey(explicit));

  const moved = m.canonicalizeCandidate({ ...base, vector: { a: 13 } });
  assert.equal(moved.changed_unit_count, 1);
  assert.notEqual(moved.candidate_id, control.candidate_id);
  assert.ok(moved.normalized_parameter_distance > 0);

  const otherCampaign = m.canonicalizeCandidate({
    ...base, vector: { a: 13 }, optimizationInputId: 'optimization_input_other'
  });
  assert.notEqual(otherCampaign.candidate_id, moved.candidate_id);

  const noisy = m.canonicalizeCandidate({ ...base, vector: { a: 13.0000000000001 } });
  assert.equal(noisy.candidate_id, moved.candidate_id);
  assert.deepEqual(noisy.canonical_vector, moved.canonical_vector);
});

test('SIMPLEX vectors with different spellings collapse to one Candidate', async () => {
  const m = await api();
  const config = {
    w: { x: 0.5, y: 0.3, z: 0.2 },
    horizonGate: [{ min: 10, gate: 30 }, { min: 5, gate: 20 }]
  };
  const unit = {
    parameter_id: 'w', canonical_path: 'w', unit_category: 'SIMPLEX', group_id: 'w',
    members: ['x', 'y', 'z'], optimizable: true, wired_status: 'WIRED', replay_class: 'REPLAY_SAFE'
  };
  const space = syntheticSpace({
    unit_order: ['w'],
    declared_units: ['w'],
    units: [{ unit_order: 1, parameter_id: 'w', unit_category: 'SIMPLEX', canonical_path: 'w',
      members: ['x', 'y', 'z'], baseline_value: { x: 0.5, y: 0.3, z: 0.2 }, probe_factors: [0.8, 1.2],
      included: true, exclusion_reason: null }],
    registry_units: { w: unit },
    base_config: { config, sha256: 'synthetic-simplex' }
  });
  const full = m.canonicalizeCandidate({
    vector: { w: { x: 0.6, y: 0.24, z: 0.16 } }, searchSpace: space,
    baseConfig: space.base_config, optimizationInputId: space.optimization_input_id
  });
  const partial = m.canonicalizeCandidate({
    vector: { w: { x: 0.6 } }, searchSpace: space,
    baseConfig: space.base_config, optimizationInputId: space.optimization_input_id
  });
  assert.equal(full.candidate_id, partial.candidate_id);
  assert.equal(full.changed_unit_count, 1);
});

test('Beam search is deterministic and honours the frozen stage budgets', async () => {
  const m = await api();
  const policy = {
    ...m.optimizationPolicy(),
    algorithm: {
      ...m.optimizationPolicy().algorithm,
      beam_width: 2, max_rounds: 2, stage_a_b_budget: 6, stage_c_budget: 3
    }
  };
  const space = syntheticSpace();
  const evaluate = async candidate => ({
    status: 'FEASIBLE',
    reason_code: null,
    promotable: true,
    reason_codes: [],
    metrics: { mae: Math.abs(Number(candidate.canonical_vector.a ?? 10) - 12), severe_error_rate: 0, within_1_accuracy: 1, bias: 0, qwk: 1 },
    control: { mae: 1, severe_error_rate: 0, within_1_accuracy: 1, bias: 0, qwk: 1 },
    deltas: { delta_mae: -0.5 },
    rules: []
  });
  const rank = records => [...records].sort((left, right) =>
    left.metrics.mae - right.metrics.mae || (left.candidate.candidate_id < right.candidate.candidate_id ? -1 : 1));
  const first = await m.runBeamSearch({ searchSpace: space, policy, mode: 'EXPLORATORY_SEARCH', evaluate, rank });
  const second = await m.runBeamSearch({ searchSpace: space, policy, mode: 'EXPLORATORY_SEARCH', evaluate, rank });
  assert.equal(first.budget.used_ab, 6);
  assert.equal(first.budget.used_c, 3);
  assert.deepEqual(first.traces, second.traces);
  assert.deepEqual(
    first.records.map(record => record.candidate.candidate_id),
    second.records.map(record => record.candidate.candidate_id)
  );
  const controlTrace = first.traces.find(trace => trace.stage === 'CONTROL');
  assert.equal(controlTrace.outcome, 'ACCEPTED');
  assert.equal(controlTrace.budget_index, 1);
  assert.equal(first.traces.filter(trace => trace.outcome === 'DUPLICATE').every(trace => trace.budget_index === null), true);
});

test('Guardrails separate coverage, no-skill, Date Robustness and Slice Regression', async () => {
  const m = await api();
  const policy = m.optimizationPolicy();
  const candidate = { candidate_id: 'candidate_x', changed_unit_count: 1, normalized_parameter_distance: 0.1 };
  const control = { mae: 1, severe_error_rate: 0.2, within_1_accuracy: 0.5, bias: 0.1, qwk: 0.4 };
  const metrics = { mae: 0.9, severe_error_rate: 0.2, within_1_accuracy: 0.5, bias: 0.1, qwk: 0.4 };
  const coverage = { control_source_coverage_rate: 1, candidate_control_coverage_rate: 1 };
  const allDegraded = {
    date_count: 14,
    per_date_summary: { improved_count: 0, degraded_count: 14, neutral_count: 0, improvement_rate: 0, worst_delta_mae: 0.2 },
    lodo_summary: { evaluated_count: 14, improved_count: 0, degraded_count: 14, neutral_count: 0, improvement_rate: 0, worst_delta_mae: 0.3 }
  };
  const exploratory = m.evaluateGuardrails({
    candidate, coverage, control, metrics, noSkill: 1.2, dateStats: allDegraded, slices: [], mode: 'EXPLORATORY_SEARCH', policy
  });
  assert.equal(exploratory.search_eligible, true);
  assert.equal(exploratory.promotable, false);
  const dateGate = exploratory.gates.find(gate => gate.gate === 'DATE_ROBUSTNESS');
  assert.equal(dateGate.status, 'NOT_APPLICABLE');

  const formal = m.evaluateGuardrails({
    candidate, coverage, control, metrics, noSkill: 1.2, dateStats: allDegraded, slices: [], mode: 'FORMAL_OPTIMIZATION', policy
  });
  assert.equal(formal.promotable, false);
  assert.equal(formal.gates.find(gate => gate.gate === 'DATE_ROBUSTNESS').status, 'FAIL');
  assert.equal(formal.gates.find(gate => gate.gate === 'LODO_ROBUSTNESS').status, 'FAIL');

  // A perfect LODO ratio with one Fold missing must not pass the full-coverage requirement.
  const partialFolds = {
    date_count: 14,
    per_date_summary: { improved_count: 14, degraded_count: 0, neutral_count: 0, improvement_rate: 1, worst_delta_mae: -0.05 },
    lodo_summary: { evaluated_count: 13, improved_count: 13, degraded_count: 0, neutral_count: 0, improvement_rate: 1, worst_delta_mae: -0.02 }
  };
  const partial = m.evaluateGuardrails({
    candidate, coverage, control, metrics, noSkill: 1.2, dateStats: partialFolds, slices: [], mode: 'FORMAL_OPTIMIZATION', policy
  });
  assert.equal(partial.gates.find(gate => gate.gate === 'LODO_ROBUSTNESS').status, 'FAIL');

  const slices = [{ regression: true, slice_dimension: 'city', slice_value: 'x' }];
  const sliced = m.evaluateGuardrails({
    candidate, coverage, control, metrics, noSkill: 1.2, dateStats: partialFolds, slices, mode: 'FORMAL_OPTIMIZATION', policy
  });
  assert.equal(sliced.gates.find(gate => gate.gate === 'SLICE_REGRESSION').status, 'FAIL');

  const shortCoverage = m.evaluateGuardrails({
    candidate, coverage: { control_source_coverage_rate: 1, candidate_control_coverage_rate: 0.9 },
    control, metrics, noSkill: 1.2, dateStats: partialFolds, slices: [], mode: 'FORMAL_OPTIMIZATION', policy
  });
  assert.equal(shortCoverage.promotable, false);
  assert.equal(shortCoverage.gates.find(gate => gate.gate === 'COVERAGE_CANDIDATE_CONTROL').status, 'FAIL');

  const exploratoryPartial = m.evaluateGuardrails({
    candidate, coverage: { control_source_coverage_rate: 0.96, candidate_control_coverage_rate: 0.96 },
    control, metrics, noSkill: 1.2, dateStats: partialFolds, slices: [], mode: 'EXPLORATORY_SEARCH', policy
  });
  assert.equal(exploratoryPartial.coverage_pass, true);
  assert.equal(exploratoryPartial.search_eligible, true);
  assert.equal(exploratoryPartial.promotable, false);
  assert.equal(exploratoryPartial.gates.find(gate => gate.gate === 'PARTIAL_COVERAGE').status, 'FAIL');
});

test('FORMAL readiness requires a newer Tuning policy, never a rewritten V2 manifest', async () => {
  const m = await api();
  const profile = {
    samples: 100, primary_events: 100, unique_dates: 14, gt_levels: 3,
    gt_level_event_counts: { ordinal_0: 34, ordinal_1: 33, ordinal_2: 33 },
    max_date_event_share: 0.1, max_city_event_share: 0.1, max_gt_level_event_share: 0.34
  };
  const linkage = {
    engineering_readiness: { status: 'READY', reasons: [] },
    metric_readiness: { status: 'READY', reasons: [] },
    result_usage: 'FORMAL'
  };
  const rewrittenV2 = m.computeOptimizationReadiness({
    profile, replayUsableRate: 1, sensitivityLinkage: { ...linkage, tuning_policy_version: 2 }
  });
  assert.equal(rewrittenV2.optimization_mode, 'EXPLORATORY_SEARCH');
  assert.ok(rewrittenV2.reasons.includes('SENSITIVITY_POLICY_NOT_FORMAL_CAPABLE'));
  const futurePolicy = m.computeOptimizationReadiness({
    profile, replayUsableRate: 1, sensitivityLinkage: { ...linkage, tuning_policy_version: 3 }
  });
  assert.equal(futurePolicy.optimization_mode, 'FORMAL_OPTIMIZATION');
});

test('SIMPLEX local refinement produces in-range steps on both rounds', async () => {
  const m = await api();
  const config = {
    w: { x: 0.5, y: 0.3, z: 0.2 },
    horizonGate: [{ min: 10, gate: 30 }, { min: 5, gate: 20 }]
  };
  const space = syntheticSpace({
    unit_order: ['w'],
    declared_units: ['w'],
    units: [{
      unit_order: 1, parameter_id: 'w', unit_category: 'SIMPLEX', canonical_path: 'w',
      members: ['x', 'y', 'z'], baseline_value: { x: 0.5, y: 0.3, z: 0.2 },
      probe_factors: [0.8, 1.2], included: true, exclusion_reason: null
    }],
    registry_units: {
      w: {
        parameter_id: 'w', canonical_path: 'w', unit_category: 'SIMPLEX', group_id: 'w',
        members: ['x', 'y', 'z'], optimizable: true, wired_status: 'WIRED', replay_class: 'REPLAY_SAFE'
      }
    },
    base_config: { config, sha256: 'synthetic-simplex' }
  });
  const parent = { canonical_vector: { w: { x: 0.6, y: 0.24, z: 0.16 } } };
  const first = m.refinementProposals({ searchSpace: space, parent, round: 1 });
  const second = m.refinementProposals({ searchSpace: space, parent, round: 2 });
  assert.ok(first.length > 0);
  assert.ok(second.length > 0);
  for (const proposal of [...first, ...second]) {
    const value = proposal.vector.w[proposal.member];
    assert.ok(value > 0 && value < 1, `${proposal.member}=${value}`);
    assert.notEqual(value, parent.canonical_vector.w[proposal.member]);
  }
  // The second round must be a smaller move than the first for the same member and direction.
  const firstUp = first.find(item => item.member === 'x' && item.factor === 1.2);
  const secondUp = second.find(item => item.member === 'x' && item.factor === 1.2);
  assert.ok(
    Math.abs(secondUp.value - parent.canonical_vector.w.x) < Math.abs(firstUp.value - parent.canonical_vector.w.x)
  );
});

test('Slice support threshold keeps thin slices out of the hard gate', async () => {
  const m = await api();
  const rows = [];
  for (let index = 0; index < 8; index++) {
    rows.push({
      snapshot_id: `s${index}`, event_id: `e${index}`, event_date_local: index < 4 ? '2026-09-01' : '2026-09-02',
      city: index < 2 ? 'Thin' : 'Wide', location_key: index < 2 ? 'Thin' : 'Wide',
      gt_label: 'fair', gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1,
      control_score: 40, experiment_score: 20, control_ordinal: 2, experiment_ordinal: 1,
      control_abs_error: 1, experiment_abs_error: 0, abs_error_delta: -1,
      regime_label: 'CLEAR', sky_evolution_state: 'STABLE', scheduled_slot: '2026-09-01T10:00',
      snapshot_source: 'github_schedule', tile_radar_available: false, tile_sat_available: false
    });
  }
  const slices = m.sliceAnalysis(rows, 1e-12, { min_event_count: 5, min_date_count: 2 });
  const thin = slices.find(slice => slice.slice_dimension === 'city' && slice.slice_value === 'Thin');
  const wide = slices.find(slice => slice.slice_dimension === 'city' && slice.slice_value === 'Wide');
  assert.equal(thin.supported, false);
  assert.equal(thin.support_reason, 'INSUFFICIENT_SLICE_SUPPORT');
  assert.equal(thin.regression, false);
  assert.equal(wide.supported, true);
  assert.equal(wide.regression, false);
});

test('Date robustness separates per-date effects from Leave-One-Date-Out folds', async () => {
  const m = await api();
  const rows = [];
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) {
    rows.push({
      snapshot_id: `${date}-a`, event_id: `e-${date}`, event_date_local: date,
      gt_ordinal: 1, gt_confidence: 1, event_normalized_weight: 1,
      control_ordinal: 2, experiment_ordinal: 1
    });
  }
  // One date clearly improves, the other two are much worse. Every single date can be dropped
  // and the remainder still gets worse, so the per-date rate and the LODO rate must disagree.
  rows[0].experiment_ordinal = 1;
  rows[1].experiment_ordinal = 4;
  rows[2].experiment_ordinal = 4;
  const stats = m.dateRobustness(rows, 1e-12);
  assert.equal(stats.date_count, 3);
  assert.equal(stats.per_date_summary.improved_count, 1);
  assert.equal(stats.lodo_summary.improved_count, 0);
  assert.equal(stats.lodo_summary.degraded_count, 3);
  assert.equal(stats.lodo_summary.improvement_rate, 0);
});

test('Finalists are capped and a run with no promotable Candidate freezes nothing', async () => {
  const m = await api();
  const policy = m.optimizationPolicy();
  const promotable = [1, 2, 3, 4, 5, 6].map(index => ({
    status: 'FEASIBLE', promotable: true,
    candidate: { candidate_id: `candidate_${index}`, changed_unit_count: index, normalized_parameter_distance: index / 10 },
    metrics: { mae: 1 / index, severe_error_rate: 0, within_1_accuracy: 1, bias: 0, qwk: 1 },
    deltas: { delta_mae: -1 / index }
  }));
  const selected = m.selectFinalists(promotable, { maxCount: policy.finalist_count_max, epsilon: 1e-12 });
  assert.equal(selected.length, 5);
  assert.notEqual(selected.length, promotable.length);

  const none = m.selectFinalists(promotable.map(record => ({ ...record, promotable: false })), {
    maxCount: policy.finalist_count_max, epsilon: 1e-12
  });
  assert.equal(none.length, 0);
});

test('Freeze identity chain has no self-hash or optimization_id cycle', async () => {
  const m = await api();
  const space = syntheticSpace();
  const finalist = {
    candidate: {
      candidate_id: 'candidate_a', canonical_vector: { a: 12 }, effective_config_sha256: 'deadbeef',
      changed_unit_count: 1, normalized_parameter_distance: 0.1
    },
    metrics: { mae: 0.5 }, deltas: { delta_mae: -0.1 }
  };
  const freeze = m.buildFreezeDocument({
    optimizationInputId: space.optimization_input_id,
    searchResultId: 'search_result_x',
    candidateSetId: 'candidate_set_x',
    finalists: [finalist],
    source: { model_dataset_id: 'm', evaluation_id: 'e', sensitivity_id: 's',
      engine_runtime_sha256: 'a', tuning_base_config_sha256: 'b', parameter_registry_sha256: 'c' },
    searchSpace: { search_space_id: 'TEST_SPACE' },
    searchSpaceSha256: 'd'
  });
  assert.equal('optimization_id' in freeze, false);
  assert.equal('candidate_freeze_sha256' in freeze, false);
  assert.equal(freeze.optimization_input_id, space.optimization_input_id);
  assert.deepEqual(freeze.candidate_ids, ['candidate_a']);
  assert.ok(freeze.validation_selection_rule.ranking.length > 0);
  assert.equal(freeze.guardrail_policy_sha256,
    m.hash(m.canonicalJson(m.guardrailPolicyDocument())));

  const source = { model_dataset_descriptor_sha256: 'a'.repeat(64) };
  const base = {
    source, searchSpace: { search_space_id: 'TEST_SPACE', candidate_normalization_version: 1 },
    searchSpaceSha256: 'b'.repeat(64), mode: 'FORMAL_OPTIMIZATION',
    counts: { candidate_count: 1, feasible_candidate_count: 1, finalist_count: 1, candidate_freeze_allowed: true }
  };
  const firstDescriptor = m.descriptorOf({
    ...base,
    metadata: {
      'candidate_freeze.json': { sha256: 'c'.repeat(64) },
      'reports/summary.json': { sha256: 'd'.repeat(64) }
    }
  });
  const secondDescriptor = m.descriptorOf({
    ...base,
    metadata: {
      'candidate_freeze.json': { sha256: 'e'.repeat(64) },
      'reports/summary.json': { sha256: 'd'.repeat(64) }
    }
  });
  assert.equal(firstDescriptor.file_sha256['candidate_freeze.json'], 'c'.repeat(64));
  assert.notEqual(m.identity(firstDescriptor).optimization_id, m.identity(secondDescriptor).optimization_id);
});

test('FORMAL fixture builds a descriptor-bound Freeze and passes package validation', async t => {
  const m = await api();
  const unitIds = [...m.optimizationPolicy().search_space.declared_units];
  const config = Object.fromEntries(unitIds.map(id => [id, 1]));
  config.horizonGate = [{ min: 10, gate: 30 }, { min: 5, gate: 20 }];
  const units = unitIds.map(id => ({
    parameter_id: id, canonical_path: id, unit_category: 'OAT', group_id: null,
    optimizable: true, wired_status: 'WIRED', replay_class: 'REPLAY_SAFE',
    integer: false, range: [0, 2], probe_absolute: [1, 2]
  }));
  const registry = { units };
  const digest = value => m.hash(m.canonicalJson(value));
  const h = char => char.repeat(64);
  const rows = Array.from({ length: 100 }, (_, index) => {
    const ordinal = index % 5;
    const targetScore = [10, 30, 50, 70, 95][ordinal];
    return {
      snapshot_id: `formal-s${String(index).padStart(3, '0')}`,
      event_id: `formal-e${String(index).padStart(3, '0')}`,
      event_date_local: `2026-08-${String((index % 14) + 1).padStart(2, '0')}`,
      city: `city-${index % 10}`, location_key: `city-${index % 10}`,
      lead_time_bucket: '0_30', gt_label: ['poor', 'fair', 'good', 'great', 'spectacular'][ordinal],
      gt_ordinal: ordinal, gt_confidence: 1, event_normalized_weight: 1,
      replay: { targetScore }, regime_label: 'CLEAR', sky_evolution_state: 'STABLE',
      scheduled_slot: '1755', snapshot_source: 'fixture',
      tile_radar_available: true, tile_sat_available: true
    };
  });
  const linkage = {
    sensitivity_id: 'sensitivity_v3_formal_fixture', tuning_schema_version: 2, tuning_policy_version: 3,
    sensitivity_manifest_sha256: h('1'), sensitivity_descriptor_sha256: h('2'),
    parameter_registry_version: 1, parameter_registry_sha256: digest(registry),
    tuning_base_config_sha256: digest(config), engine_runtime_sha256: h('3'),
    model_dataset_id: 'model_v2_formal_fixture', model_dataset_manifest_sha256: h('4'),
    model_dataset_descriptor_sha256: h('5'), source_dataset_id: 'raw_v1_formal_fixture',
    ground_truth_id: 'gt_v3_formal_fixture', evaluation_id: 'baseline_v3_formal_fixture',
    evaluation_manifest_sha256: h('6'), engineering_readiness: { status: 'READY', reasons: [] },
    data_readiness: { status: 'READY', reasons: [] }, metric_readiness: { status: 'READY', reasons: [] },
    result_usage: 'FORMAL', mapping_status: 'VALIDATED', interpretation_scope: 'ORDINAL',
    no_skill_reference_ordinal: 2, validation_disclosure_status: 'UNEXPOSED',
    validation_disclosure_evidence_id: null, validation_disclosure_evidence_sha256: null,
    validation_access_ledger_sha256: h('7')
  };
  const input = {
    upstream: { status: 'PASS', validation_scope: 'SOURCE_LINKED' }, sourceFingerprints: {},
    model: {
      manifest: {
        model_dataset_id: linkage.model_dataset_id, descriptor_sha256: linkage.model_dataset_descriptor_sha256,
        source_dataset_id: linkage.source_dataset_id, ground_truth_id: linkage.ground_truth_id
      },
      manifestSha256: linkage.model_dataset_manifest_sha256, schemaVersion: 2, policyVersion: 3,
      rows, fingerprints: { 'manifest.json': linkage.model_dataset_manifest_sha256 }
    },
    evaluation: {
      evaluation_id: linkage.evaluation_id, evaluation_manifest_sha256: linkage.evaluation_manifest_sha256,
      evaluation_schema_version: 2, evaluation_policy_version: 3,
      evaluation_validation_scope: 'SOURCE_LINKED'
    },
    sensitivity: {
      linkage, registry, baseConfig: { config, sha256: linkage.tuning_base_config_sha256 },
      runtime: { engine_runtime_sha256: linkage.engine_runtime_sha256 },
      readiness: {
        metrics: { replay_usable_rate: 1 },
        parameter_readiness: unitIds.map(parameter_id => ({
          parameter_id, observability_status: 'OBSERVABLE', parameter_readiness: 'READY',
          support_samples: 100, support_events: 100, support_dates: 14, reason_code: null,
          metric_usage: 'FORMAL'
        }))
      },
      fingerprints: {}
    },
    runtime: { engine_runtime_sha256: linkage.engine_runtime_sha256 },
    cohort: rows, summary: { sample_count: 100, event_count: 100, date_count: 14 }
  };
  const runReplay = async (replay, { modelConfig }) => {
    const sum = unitIds.reduce((total, id) => total + Number(modelConfig.scoring[id]), 0);
    return { actual: { score: sum === unitIds.length ? Math.min(100, replay.targetScore + 20) : replay.targetScore,
      gw_factor: 1, sky_evolution_factor: 1 } };
  };
  const built = await m.buildOptimizationPackage({ input, runReplay, progress: {
    stage() {}, update() {}, finish() {}, fail() {}
  } });
  assert.equal(built.mode, 'FORMAL_OPTIMIZATION');
  assert.equal(built.manifest.candidate_freeze_allowed, true);
  assert.ok(built.files['candidate_freeze.json']);
  assert.equal(built.manifest.descriptor.file_sha256['candidate_freeze.json'],
    built.manifest.files['candidate_freeze.json'].sha256);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-formal-optimization-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(built.files)) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  const inspected = await m.inspectOptimization(directory, { staging: true });
  assert.equal(inspected.status, 'PASS');
  assert.equal(inspected.optimization_mode, 'FORMAL_OPTIMIZATION');
});

test('Maintenance registers Phase 6 and derives its upstream edges', async () => {
  const m = await api();
  const phase = m.PHASES.find(item => item.key === 'optimization');
  assert.equal(phase.phase, 6);
  assert.equal(phase.relativeRoot, 'optimization/exports');
  assert.equal(phase.idField, 'optimization_id');
  const edges = m.dependenciesOf(phase, {
    optimization_id: 'optimization_v1_x', model_dataset_id: 'model_v2_x',
    model_dataset_manifest_sha256: 'm', evaluation_id: 'baseline_v2_x',
    evaluation_manifest_sha256: 'e', sensitivity_id: 'sensitivity_v2_x',
    sensitivity_manifest_sha256: 's', source_dataset_id: 'raw_v1_x', ground_truth_id: 'gt_v3_x'
  });
  assert.deepEqual(edges.map(edge => edge.idField).sort(), [
    'evaluation_id', 'ground_truth_id', 'model_dataset_id', 'sensitivity_id', 'source_dataset_id'
  ].sort());
  const evidenceEdges = m.dependenciesOf(phase, {
    optimization_id: 'optimization_v1_x',
    validation_disclosure_evidence_id: 'baseline_v1_evidence',
    validation_disclosure_evidence_sha256: 'f'.repeat(64)
  });
  assert.deepEqual(evidenceEdges, [{
    idField: 'validation_disclosure_evidence_id', id: 'baseline_v1_evidence',
    expectedManifestSha256: 'f'.repeat(64), kind: 'EVIDENCE'
  }]);
});

test('Cross-validation rejects tampering with a published Optimization package', async t => {
  const exportsDir = path.join(APP, 'dataset/optimization/exports');
  if (!fssync.existsSync(exportsDir)) return t.skip('no local Optimization package');
  const packages = (await fs.readdir(exportsDir)).filter(name => name.startsWith('optimization_v1_'));
  if (!packages.length) return t.skip('no local Optimization package');
  const m = await api();
  const compatible = [];
  for (const name of packages) {
    const manifest = JSON.parse(await fs.readFile(path.join(exportsDir, name, 'manifest.json'), 'utf8'));
    if (Object.hasOwn(manifest, 'validation_disclosure_evidence_id')) compatible.push(name);
  }
  if (!compatible.length) {
    return t.skip('local Optimization package predates the final V2.5.3 contract');
  }
  const source = path.join(exportsDir, compatible.sort().at(-1));
  const result = await m.inspectOptimization(source);
  assert.equal(result.validation_scope, 'PACKAGE_INTERNAL');
  assert.equal(result.manifest.computation_access_policy, 'TRAIN_ONLY');
  assert.equal(result.manifest.test_evaluated, false);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sunset-optimization-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await fs.cp(source, tmp, { recursive: true });
  await fs.appendFile(path.join(tmp, 'leaderboard.csv'), 'tamper');
  await assert.rejects(() => m.inspectOptimization(tmp, { staging: true }),
    error => error.code === 'OPTIMIZATION_VALIDATION_FAILED' && error.reason_code === 'FILE_HASH');
});
