const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/p0-features', 'practical-tuning/horizon-fix-workflow', 'practical-tuning/policy',
  'model-release/release', 'model-release/holdout', 'evaluation/metrics'].map(n => import(`../tools/${n}.mjs`)))
  .then(([features, hfix, policy, release, holdout, metrics]) => ({ ...features, ...hfix, digest: policy.digest, release, holdout, metrics })); }

// 33-point grid: centre low 80 / high 70 / mid 20; every ring node low 40 / high 30 / mid 10. Corridor nodes then share the ring
// values, so the hand results are: 0° ray opening 60; centre opening 20; ±30° bank opening 60.
function runEngine(spatialPatch, centreOffset) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47, sunset = new Date('2026-08-26T18:30:00Z');
  Object.assign(SS.config.spatialField, spatialPatch);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: centreOffset != null && p.distanceKm === 0 ? { ...p, azimuthOffset: centreOffset } : p,
    forecast: forecast(p.distanceKm === 0 ? { low: 80, high: 70, mid: 20, cloud: 90 } : { low: 40, high: 30, mid: 10, cloud: 50 }) }));
  const corridor = SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]);
  return SS.engine.compute({ location: { name: 'Fixture City', country: 'Test', latitude: lat, longitude: lon }, utcOffsetSeconds: 0,
    localNowUtc: new Date('2026-08-26T17:00:00Z'), solar: { sunset, civilDusk: new Date('2026-08-26T19:00:00Z'), sunsetAzimuthDeg: 270, twilightMinutes: 30 },
    sunsetLocal: sunset, samples: corridor, air: null, cloudField: SS.cloudField.buildCloudField(sky, sunset), expectedSampleCount: 13,
    spatialCompleteness: 1, samplingMode: 'FULL_SKY_33', cacheStatus: 'MISS', dataAgeMinutes: 0 });
}

test('Engine without the key keeps the voided bank sector; the fix restores centre and bank; HORIZON scope leaves structure as before', () => {
  const legacy = runEngine({}), all = runEngine({ centerAzimuthOffset: 0 }), horizonOnly = runEngine({ centerAzimuthOffset: 0, centerAzimuthOffsetScope: 'HORIZON' });
  // Legacy: centre falls into the bank sector with a NaN angular weight, so horizon is the 0° ray only.
  assert.equal(legacy.components.horizon, 60); assert.equal(legacy.sector_openings.bank, null); assert.equal(legacy.sector_openings.corridor, 60);
  // Fixed: corridor = (0.3·20 + 0.7·60) / 1.0 = 48; bank = 60; horizon = (0.6·48 + 0.3·60) / 0.9 = 52.
  for (const r of [all, horizonOnly]) { assert.equal(r.components.horizon, 52); assert.equal(r.sector_openings.corridor, 48); assert.equal(r.sector_openings.bank, 60); }
  // Cloud-bank contrast: legacy counts the centre (high+mid 90) as side → 40 − (8·40+90)/9 = −5.6; fixed (4·40+90)/5 − 40 = 10.
  assert.equal(legacy.cloud_structure.contrast, -6); assert.equal(all.cloud_structure.contrast, 10); assert.equal(horizonOnly.cloud_structure.contrast, -6);
  assert.equal(horizonOnly.spatial_gradient.value, legacy.spatial_gradient.value);
  assert.notEqual(all.score, legacy.score);
});

test('An explicit centre offset is never overridden, and non-finite keys behave as absent', () => {
  const explicit = runEngine({}, 0), explicitFixed = runEngine({ centerAzimuthOffset: 0 }, 0);
  assert.deepEqual([explicit.score, explicit.components.horizon, explicit.cloud_structure.contrast], [explicitFixed.score, explicitFixed.components.horizon, explicitFixed.cloud_structure.contrast]);
  assert.equal(explicit.components.horizon, 52);
  const legacy = runEngine({});
  for (const bad of [null, '0', NaN]) assert.equal(runEngine({ centerAzimuthOffset: bad }).score, legacy.score, String(bad));
});

test('P0 features follow the effective offset only when the key is set', async () => {
  const m = await api(), scoring = { horizonDistanceWeights: { 0: .3, 50: .25, 100: .2, 200: .15, 300: .1 }, spatialField: { angularPower: 2, sectorWeights: { corridor: .6, bank: .3, side: .1 } } };
  const corridor = [{ azimuth_offset: null, distance_km: 0, low: 80 }, ...[-30, 0, 30].flatMap(o => [50, 100, 200, 300].map(d => ({ azimuth_offset: o, distance_km: d, low: 40 })))];
  const opening = s => 100 - s.low;
  assert.equal(m.effectiveCorridor(corridor, scoring), corridor);
  assert.equal(m.sectorAggregate(corridor, scoring, opening), 60); assert.equal(m.bankSectorVoided(corridor), true);
  const fixed = { ...scoring, spatialField: { ...scoring.spatialField, centerAzimuthOffset: 0 } }, eff = m.effectiveCorridor(corridor, fixed);
  assert.ok(Math.abs(m.sectorAggregate(eff, fixed, opening) - 52) < 1e-9); assert.equal(m.bankSectorVoided(eff), false);
  assert.equal(corridor[0].azimuth_offset, null);
});

test('V2.5.5.4 candidate configuration, grade lines and H1 Policy 2', async () => {
  const m = await api(), configs = await m.holdout.releaseConfigs(), base = configs['2.5.5.2'];
  const all = m.release.candidateReleaseScoring(base), horizon = m.release.candidateReleaseScoring(base, { scope: 'HORIZON' });
  assert.equal(all.version, '2.5.5.4'); assert.equal(all.spatialField.centerAzimuthOffset, 0); assert.equal(all.spatialField.centerAzimuthOffsetScope, undefined);
  assert.equal(horizon.spatialField.centerAzimuthOffsetScope, 'HORIZON'); assert.equal(base.spatialField.centerAzimuthOffset, undefined);
  assert.deepEqual(m.release.differences(base, all).map(d => d.path), ['spatialField.centerAzimuthOffset', 'version']);
  assert.throws(() => m.release.candidateReleaseScoring(configs['2.5.5.1']), /RELEASE_CANDIDATE_BASE_MISMATCH/);
  assert.throws(() => m.release.candidateReleaseScoring(all), /RELEASE_CANDIDATE_BASE_MISMATCH/);
  assert.throws(() => m.release.candidateReleaseScoring(base, { scope: 'X' }), /RELEASE_CANDIDATE_SCOPE_UNKNOWN/);
  assert.deepEqual([...m.metrics.gradeThresholdsForModelVersion('2.5.5.4')], [22, 47, 66, 90]);
  assert.equal(m.digest(configs['2.5.5.4']), m.digest(all));
  const p = m.holdout.HOLDOUT_POLICY;
  assert.equal(p.version, 2); assert.deepEqual([...p.versions], ['2.5.5.0', '2.5.5.1', '2.5.5.2', '2.5.5.4']);
  assert.deepEqual(p.comparisons.map(c => c.id), ['V2551_VS_V2550', 'V2552_VS_V2551', 'V2554_VS_V2552']);
  const c = p.comparisons[2], ctl = { product_loss: 1, ge2_recall: .7 };
  assert.equal(m.holdout.rollbackSuggested(c.rollback_rule, { product_loss: 1, ge2_recall: .65 }, ctl), false);
  assert.equal(m.holdout.rollbackSuggested(c.rollback_rule, { product_loss: 1.001, ge2_recall: .7 }, ctl), true);
  assert.equal(m.holdout.rollbackSuggested(c.rollback_rule, { product_loss: 1, ge2_recall: .64 }, ctl), true);
  assert.equal(m.digest(m.evaluationConfigs(configs).FIX_ALL), m.digest(all));
});

test('Pre-registered decision rule: loss +0.01, ≥2 recall −0.05, AUC≥2 upper bound above 0', async () => {
  const m = await api(), rules = m.HFIX_POLICY.rules;
  const metrics = (h, a) => ({ C0: { product_loss: 1, ge2_recall: .7 }, FIX_H: h, FIX_ALL: a });
  const deltas = (uh, ua) => ({ FIX_H_VS_C0: { auc_ge2_primary_last: { ci95: [-.05, uh] } }, FIX_ALL_VS_C0: { auc_ge2_primary_last: { ci95: [-.05, ua] } } });
  let d = m.decideFix(metrics({ product_loss: 1.01, ge2_recall: .65 }, { product_loss: 1.01, ge2_recall: .65 }), deltas(.01, .01), rules);
  assert.equal(d.FIX_ALL.status, 'RELEASE_CANDIDATE'); assert.equal(d.recommendation, 'FIX_ALL');
  d = m.decideFix(metrics({ product_loss: 1, ge2_recall: .7 }, { product_loss: 1.0101, ge2_recall: .7 }), deltas(.01, .01), rules);
  assert.equal(d.FIX_ALL.checks.product_loss, false); assert.equal(d.recommendation, 'FIX_H_ONLY_OWNER_DECISION');
  d = m.decideFix(metrics({ product_loss: 1, ge2_recall: .6499 }, { product_loss: 1, ge2_recall: .7 }), deltas(.01, 0), rules);
  assert.equal(d.FIX_ALL.checks.auc_ge2_not_clearly_worse, false); assert.equal(d.FIX_H.checks.ge2_recall, false); assert.equal(d.recommendation, 'NEEDS_RETUNE_STOP');
});

test('Policy 10 plan is pinned; changing it requires a new policy version', async () => {
  const m = await api();
  assert.equal(m.digest(m.HFIX_POLICY), '31714b434fe127952bf91b40c60659a34b3fa4507ed2ad487ac4cc5c41be76fb');
  assert.deepEqual([m.HFIX_POLICY.practical_tuning_schema_version, m.HFIX_POLICY.practical_tuning_policy_version], [10, 10]);
  assert.equal(m.release.V2554_REFERENCE.score_changed_vs_V2552, 323);
});
