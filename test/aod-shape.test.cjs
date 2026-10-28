const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast, localSample } = require('./helpers.cjs');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/aod-shape-workflow', 'practical-tuning/policy', 'model-release/release',
  'model-release/holdout', 'evaluation/metrics'].map(n => import(`../tools/${n}.mjs`)))
  .then(([aod, policy, release, holdout, metrics]) => ({ ...aod, digest: policy.digest, release, holdout, metrics })); }

// Local-only input with visibility 18 km, RH 55 %, no PM2.5; only the AOD value varies.
function atmosphere(aod, response) {
  const SS = load(createRuntime(), CORE_FILES), sunset = new Date('2026-08-26T18:30:00Z'), fc = forecast(), sample = localSample(fc);
  if (response !== undefined) SS.config.aodResponse = response;
  const air = { hourly: { time: fc.hourly.time, aerosol_optical_depth: fc.hourly.time.map(() => aod) } };
  return SS.engine.compute({ location: { name: 'Fixture City', country: 'Test', latitude: 31.23, longitude: 121.47 }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: [sample], air, cloudField: SS.cloudField.buildCloudField([sample], sunset), expectedSampleCount: 1,
    spatialCompleteness: 1, samplingMode: 'LOCAL_ONLY', cacheStatus: 'MISS', dataAgeMinutes: 0 }).components.atmosphere;
}
// Hand value: weights visibility .35 / AOD .30 / humidity .15 (PM2.5 missing, renormalised); config aodCenter .25, aodWidth .18.
const gauss = (v, c, w) => 100 * Math.exp(-0.5 * ((v - c) / w) ** 2);
const expected = aodScore => Math.round((.35 * 100 * (1 - Math.exp(-18 / 8)) + .30 * aodScore + .15 * gauss(55, 55, 30)) / .8);

test('HALF_GAUSSIAN scores AOD at or below the centre as 100 and leaves higher AOD on the original Gaussian', () => {
  assert.equal(atmosphere(0.06), expected(gauss(0.06, .25, .18)));
  assert.equal(atmosphere(0.06, 'HALF_GAUSSIAN'), expected(100));
  assert.ok(atmosphere(0.06, 'HALF_GAUSSIAN') > atmosphere(0.06));
  for (const aod of [0.25, 0.4, 0.9]) assert.equal(atmosphere(aod, 'HALF_GAUSSIAN'), atmosphere(aod), String(aod));
  assert.equal(atmosphere(0.4), expected(gauss(0.4, .25, .18)));
});

test('Any other aodResponse value behaves as the absent key', () => {
  const legacy = atmosphere(0.06);
  for (const v of [null, 'half_gaussian', true, 'GAUSSIAN']) assert.equal(atmosphere(0.06, v), legacy, String(v));
});

test('V2.5.5.5 candidate configuration and grade lines', async () => {
  const m = await api(), configs = await m.holdout.releaseConfigs(), cfg = m.aodConfigs(configs);
  assert.equal(cfg.A1.version, '2.5.5.5'); assert.equal(cfg.A1.aodResponse, 'HALF_GAUSSIAN'); assert.equal(cfg.C0.aodResponse, undefined);
  assert.deepEqual(m.release.differences(cfg.C0, cfg.A1).map(d => d.path), ['aodResponse', 'version']);
  assert.deepEqual(m.release.differences(cfg.B0, cfg.B1).map(d => d.path), ['aodResponse', 'version']);
  assert.equal(cfg.A1.aodCenter, cfg.C0.aodCenter); assert.equal(cfg.A1.aodWidth, cfg.C0.aodWidth);
  assert.throws(() => m.release.aodCandidateScoring(configs['2.5.5.1']), /RELEASE_AOD_CANDIDATE_BASE_MISMATCH/);
  assert.throws(() => m.release.aodCandidateScoring(cfg.A1), /RELEASE_AOD_CANDIDATE_BASE_MISMATCH/);
  assert.deepEqual([...m.metrics.gradeThresholdsForModelVersion('2.5.5.5')], [22, 47, 66, 90]);
});

test('Affected rows and frozen P0 AOD bins', async () => {
  const m = await api(), upper = m.AOD_POLICY.aod_bin_upper;
  assert.equal(m.affectedByAod(0.249, .25), true); assert.equal(m.affectedByAod(0.25, .25), false); assert.equal(m.affectedByAod(null, .25), false);
  // A value on an upper bound belongs to the next bin.
  assert.deepEqual([0.06, 0.215, 0.31, 0.38, 0.385, 0.6, 0.61, 1.3, null].map(a => m.aodBin(a, upper)), [1, 2, 2, 3, 4, 4, 5, 5, null]);
});

test('Pre-registered rule: loss lower, AUC≥2 not lower with upper bound above 0, ≥2 recall drop at most 0.02', async () => {
  const m = await api(), rules = m.AOD_POLICY.rules;
  const metrics = (a1, b1 = a1) => ({ C0: { product_loss: 1, ge2_recall: .7, auc_ge2_primary_last: .68 }, A1: a1, B0: { product_loss: 1, ge2_recall: .7, auc_ge2_primary_last: .68 }, B1: b1 });
  const deltas = (u = .01) => ({ A1_VS_C0: { auc_ge2_primary_last: { ci95: [-.01, u] } }, B1_VS_B0: { auc_ge2_primary_last: { ci95: [-.01, u] } } });
  let d = m.decideAod(metrics({ product_loss: .999, ge2_recall: .68, auc_ge2_primary_last: .68 }), deltas(), rules);
  assert.equal(d.recommendation, 'ADOPT_CANDIDATE'); assert.equal(d.robustness_B1_vs_B0.same_direction, true);
  d = m.decideAod(metrics({ product_loss: 1, ge2_recall: .7, auc_ge2_primary_last: .69 }), deltas(), rules);
  assert.equal(d.A1.checks.product_loss_lower, false); assert.equal(d.recommendation, 'NO_GAIN');
  d = m.decideAod(metrics({ product_loss: .99, ge2_recall: .7, auc_ge2_primary_last: .679 }), deltas(), rules);
  assert.equal(d.A1.checks.auc_ge2_not_lower, false);
  d = m.decideAod(metrics({ product_loss: .99, ge2_recall: .6799, auc_ge2_primary_last: .68 }), deltas(0), rules);
  assert.equal(d.A1.checks.ge2_recall, false); assert.equal(d.A1.checks.auc_ge2_ci_upper_above_zero, false);
  d = m.decideAod(metrics({ product_loss: .99, ge2_recall: .7, auc_ge2_primary_last: .69 }, { product_loss: 1.01, ge2_recall: .7, auc_ge2_primary_last: .69 }), deltas(), rules);
  assert.equal(d.recommendation, 'ADOPT_CANDIDATE'); assert.equal(d.robustness_B1_vs_B0.same_direction, false); assert.equal(d.robustness_B1_vs_B0.decision_weight, 'NONE');
});

test('Policy 11 plan and the V2.5.5.5 reference are pinned', async () => {
  const m = await api();
  assert.equal(m.digest(m.AOD_POLICY), '617f01aa7778fd306b46f0ee0e30e7ee831cdccc00f987a0b9b0c5ca334f1d46');
  assert.deepEqual([m.AOD_POLICY.practical_tuning_schema_version, m.AOD_POLICY.practical_tuning_policy_version], [11, 11]);
  assert.equal(m.release.V2555_REFERENCE.score_changed_vs_V2554, 52); assert.equal(m.release.V2555_REFERENCE.grade_changed_vs_V2554, 5);
});
