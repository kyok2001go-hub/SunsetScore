// Test-only in-memory Phase 7 FORMAL fixture. Never import this from production CLI.
const load = name => import('../tools/validation/' + name);

const SCORE_BY_ORDINAL = [10, 30, 50, 70, 95];

async function makeFormalFixture(scenario = 'mixed') {
  const [{ planIdentity }, { loadFrozenBaseConfig }, { UNITS },
    { canonicalizeCandidate }, { validationSupport }] = await Promise.all([
      load('plan-validation.mjs'), import('../tools/tuning/lib/base-config.mjs'),
      import('../tools/tuning/parameter-registry.mjs'),
      import('../tools/optimization/lib/candidate.mjs'),
      load('validation-policy.mjs')
    ]);
  const config = (await loadFrozenBaseConfig()).config;
  const registryUnits = Object.fromEntries(UNITS.map(unit => [unit.parameter_id, unit]));
  const searchSpace = { registry_units: registryUnits, unit_order: ['high_cloud_center'] };
  const baseConfig = { config };
  const candidates = [10, 20, 30].map(value => {
    const resolved = canonicalizeCandidate({
      vector: { high_cloud_center: value }, searchSpace, baseConfig,
      optimizationInputId: 'synthetic_formal_fixture_only'
    });
    if (!resolved.ok) throw Error('fixture candidate must be feasible');
    return { candidate_id: resolved.candidate_id,
      canonical_vector: resolved.canonical_vector,
      effective_config_sha256: resolved.effective_config_sha256,
      resolved };
  });
  const members = Array.from({ length: 35 }, (_, index) => ({
    snapshot_id: `formal_v${String(index).padStart(2, '0')}`,
    event_id: `formal_e${String(index).padStart(2, '0')}`,
    location_key: `fixture_city_${index % 3}`,
    event_date_local: `2026-09-${String(1 + Math.floor(index / 5)).padStart(2, '0')}`
  }));
  const cohort = members.map((member, index) => {
    const gtOrdinal = index % 3;
    return { ...member, city: `Fixture ${index % 3}`,
      lead_time_bucket: 'T_1_3H', lead_time_minutes: 60 + index % 5,
      prediction_time_epoch: 1780000000000 + index,
      gt_label: ['poor', 'fair', 'good'][gtOrdinal],
      gt_ordinal: gtOrdinal, gt_confidence: 1, event_normalized_weight: 1,
      gt_status: 'STRONG', gt_basis: 'SYNTHETIC_FIXTURE_ONLY',
      regime_label: 'CLEAR', sky_evolution_state: 'STABLE',
      scheduled_slot: '1755', snapshot_source: 'fixture',
      tile_radar_available: true, tile_sat_available: true,
      predicted_score: SCORE_BY_ORDINAL[gtOrdinal + 1],
      engine_build_sha: 'f'.repeat(40),
      replay: { gtOrdinal, dateIndex: Math.floor(index / 5),
        historicalScore: SCORE_BY_ORDINAL[gtOrdinal + 1] } };
  });
  const support = validationSupport(cohort);
  if (support.status !== 'READY') throw Error('fixture VALIDATION support must pass');
  const core = { mode: 'FORMAL_VALIDATION', status: 'READY_FORMAL',
    fixture_only: true, result_usage: 'TEST_FIXTURE_ONLY',
    synthetic_train_support: { event_count: 100, date_count: 14 },
    candidates: candidates.map(item => ({
      candidate_id: item.candidate_id,
      canonical_vector: item.canonical_vector,
      effective_config_sha256: item.effective_config_sha256,
      changed_unit_count: item.resolved.changed_unit_count,
      normalized_parameter_distance: item.resolved.normalized_parameter_distance
    })),
    validation_members: members, support,
    no_skill_reference_ordinal: 4,
    source: { optimization: { id: 'optimization_synthetic_fixture_only' } },
    engine_runtime_sha256: 'f'.repeat(64) };
  const plan = planIdentity(core);
  const runReplay = async (replay, options) => {
    let ordinal = replay.gtOrdinal + 1;
    if (options.reference) ordinal = replay.gtOrdinal + 1;
    else if (options.modelConfig) {
      const center = options.modelConfig.scoring.highCloudCenter;
      if (center === 20 && replay.dateIndex === 0 &&
          (scenario === 'candidate-failure' || scenario === 'transient')) {
        const error = Error('synthetic failure details must not enter result files');
        error.code = scenario === 'transient' ? 'ETIMEDOUT' : 'SYNTHETIC_DETERMINISTIC_FAILURE';
        throw error;
      }
      const mixedLike = scenario === 'mixed' || scenario === 'candidate-failure' ||
        scenario === 'transient';
      if (center === 10) {
        ordinal = mixedLike ? replay.gtOrdinal
          : scenario === 'all-uncertain'
            ? (replay.dateIndex < 2 ? replay.gtOrdinal : replay.gtOrdinal + 1)
            : (replay.dateIndex === 0 ? replay.gtOrdinal + 2 : replay.gtOrdinal);
      } else if (center === 20) {
        ordinal = mixedLike && replay.dateIndex < 2
          ? replay.gtOrdinal : mixedLike
            ? replay.gtOrdinal + 1
            : (replay.dateIndex === 0 ? replay.gtOrdinal + 2 : replay.gtOrdinal);
      } else if (center === 30) {
        ordinal = replay.dateIndex === 0 ? replay.gtOrdinal + 2 : replay.gtOrdinal;
      }
    }
    const score = SCORE_BY_ORDINAL[ordinal];
    return { actual: { score, gw_factor: 1, sky_evolution_factor: 1 },
      reference: { score: replay.historicalScore },
      deltas: { components: {} }, pass: true, comparison_errors: [] };
  };
  return { plan: plan.payload, planId: plan.planId,
    input: { cohort, candidates, sensitivity: { baseConfig },
      searchSpace }, runReplay, candidates, support };
}

module.exports = { makeFormalFixture };
