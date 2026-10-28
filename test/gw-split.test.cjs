const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, load, CORE_FILES, forecast } = require('./helpers.cjs');
let modules;
async function api() { return modules ||= Promise.all(['practical-tuning/gw-split-workflow', 'practical-tuning/policy', 'model-release/release',
  'model-release/holdout', 'evaluation/metrics'].map(n => import(`../tools/${n}.mjs`)))
  .then(([gw, policy, release, holdout, metrics]) => ({ ...gw, digest: policy.digest, release, holdout, metrics })); }

const sunsetMs = Date.parse('2026-08-26T18:30:00Z');
// 33-point grid: centre low 80 / mid 20 (blocking 90); every ring node low 40 / mid 20 (blocking 50).
function setup(patch = {}, scoringPatch = {}) {
  const SS = load(createRuntime(), CORE_FILES), lat = 31.23, lon = 121.47;
  Object.assign(SS.config.evolution, patch); Object.assign(SS.config.spatialField, scoringPatch);
  const sky = SS.cloudField.generateGridNodes(lat, lon).map(p => ({ point: p,
    forecast: forecast(p.distanceKm === 0 ? { low: 80, mid: 20, high: 10, cloud: 90 } : { low: 40, mid: 20, high: 10, cloud: 50 }) }));
  return { SS, corridor: SS.cloudField.interpolateCorridorSamples(sky, lat, lon, 270, [50, 100, 200, 300], [-30, 0, 30]) };
}
const radar = pct => ({ available: true, coverageSeries: [0, 1, 2].map(i => ({ pct, t: sunsetMs - (80 - i * 10) * 60000 })) });
const run = (SS, corridor, minutes, extra = {}) => SS.evolution.fuseEvolution({ forecastTrend: null, precip: null, radar: radar(10), satellite: null,
  motionForecast: null, sunsetCloudCover: 70, corridorSamples: corridor, nowMs: sunsetMs - minutes * 60000, sunsetMs, ...extra });
// Hand formula of PRD §3.1 with the configured threshold, σ and clamp; background prior 0.5 at weight 0.3. Within 120 minutes
// the per-horizon probability is clamped and rounded before the blend; the NWP_SUNSET path (t > 120) blends it unrounded.
function expected(SS, cloud, h, radarP = 1, t = h) {
  const c = SS.modelConfig.evolution, logistic = x => 1 / (1 + Math.exp(-x)), round2 = v => Math.round(v * 100) / 100;
  const clamp = v => Math.min(c.probClamp[1], Math.max(c.probClamp[0], v));
  const pc = logistic((c.openCoverageThreshold - cloud) / (c.sigma0 + c.sigmaPerMin * t));
  const p = t > 120 ? pc : round2(clamp(pc * radarP));
  return round2(c.backgroundWeight * 0.5 + (1 - c.backgroundWeight) * p);
}

test('Sun-side blocking uses the horizon aggregation: 50 without the centre fix, 58 with it', () => {
  const plain = setup({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'IGNORE' }), fixed = setup({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'IGNORE' }, { centerAzimuthOffset: 0 });
  const a = run(plain.SS, plain.corridor, 60), b = run(fixed.SS, fixed.corridor, 60);
  assert.ok(Math.abs(a.cloudSignalValue - 50) < 1e-9); assert.ok(Math.abs(b.cloudSignalValue - 58) < 1e-9);
  assert.equal(a.cloudSignalMode, 'SUN_SIDE_BLOCKING');
  assert.equal(b.sunsetOpenProbability, expected(fixed.SS, 58, 60)); assert.equal(b.sunsetProbabilitySource, 'EVOLUTION_60M');
});

test('Rain gate multiplies the radar open probability; IGNORE drops it; TOTAL_CLOUD uses the 33-node cloud cover', () => {
  const g = setup({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'RAIN_GATE' }, { centerAzimuthOffset: 0 });
  const legacy = setup({}, { centerAzimuthOffset: 0 });
  const radarP = run(legacy.SS, legacy.corridor, 60).detail.radar.openProbability['60m'];
  assert.equal(run(g.SS, g.corridor, 60).sunsetOpenProbability, expected(g.SS, 58, 60, radarP));
  const t = setup({ cloudSignal: 'TOTAL_CLOUD', radarRole: 'IGNORE' });
  const rt = run(t.SS, t.corridor, 60);
  assert.equal(rt.cloudSignalValue, 70); assert.equal(rt.sunsetOpenProbability, expected(t.SS, 70, 60));
});

test('Beyond 120 minutes the NWP_SUNSET path uses the same cloud signal instead of the total cloud cover', () => {
  const g = setup({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'RAIN_GATE' }, { centerAzimuthOffset: 0 }), legacy = setup({}, { centerAzimuthOffset: 0 });
  const a = run(g.SS, g.corridor, 150), b = run(legacy.SS, legacy.corridor, 150);
  assert.equal(a.sunsetProbabilitySource, 'NWP_SUNSET'); assert.equal(a.sunsetOpenProbability, expected(g.SS, 58, 150, 1, 150));
  assert.equal(b.sunsetOpenProbability, expected(legacy.SS, 70, 150, 1, 150));
});

test('Absent, invalid or unusable settings keep the legacy factor exactly', () => {
  const legacy = setup(), base = run(legacy.SS, legacy.corridor, 60);
  for (const v of [null, 'sun_side_blocking', true, 'RADAR']) {
    const s = setup({ cloudSignal: v }), r = run(s.SS, s.corridor, 60);
    assert.equal(r.gwFactor, base.gwFactor, String(v)); assert.equal(r.cloudSignalMode, undefined);
  }
  const g = setup({ cloudSignal: 'SUN_SIDE_BLOCKING', radarRole: 'RAIN_GATE' }), r = run(g.SS, null, 60);
  assert.equal(r.cloudSignalMode, 'LEGACY_FALLBACK'); assert.equal(r.gwFactor, base.gwFactor);
});

test('Reference rule, candidate configurations and grade lines', async () => {
  const m = await api();
  assert.equal(m.referenceByRule([0.5, 1, null], 0.5), 0.875);
  assert.throws(() => m.referenceByRule([null], 0.5), /GW_REFERENCE_NO_ACTIVE_ROWS/);
  const configs = await m.holdout.releaseConfigs(), base = configs['2.5.5.4'], cfg = m.gwConfigs(base, { W1: 0.8, W_TOTAL: 0.7, W_NORADAR: 0.9 });
  assert.deepEqual(m.release.differences(base, cfg.W1).map(d => d.path), ['evolution.cloudSignal', 'evolution.radarRole', 'goldenWindow.reference', 'version']);
  assert.equal(cfg.W1_NOREF.goldenWindow.reference, base.goldenWindow.reference); assert.equal(cfg.W_NORADAR.evolution.radarRole, 'IGNORE');
  assert.equal(cfg.W_TOTAL.evolution.cloudSignal, 'TOTAL_CLOUD'); assert.equal(cfg.W1.version, '2.5.5.6');
  assert.throws(() => m.release.gwSplitScoring(configs['2.5.5.2']), /RELEASE_GW_SPLIT_BASE_MISMATCH/);
  assert.throws(() => m.release.gwSplitScoring(base, { cloudSignal: 'X' }), /RELEASE_GW_SPLIT_OPTION_UNKNOWN/);
  assert.throws(() => m.release.gwSplitScoring(base, { reference: 0 }), /RELEASE_GW_SPLIT_REFERENCE_INVALID/);
  assert.deepEqual([...m.metrics.gradeThresholdsForModelVersion('2.5.5.6')], [22, 47, 66, 90]);
});

test('Scenario classification and the pre-registered decision rule', async () => {
  const m = await api(), t = m.GW_POLICY.scenarios;
  const row = (radarCov, extra = {}) => ({ gw: { active: true, radar_coverage_now: radarCov }, features: { center_high: 0, s_screen: 0, ...extra } });
  assert.equal(m.scenarioOf(row(35), 10, t), 'S_C_ECHO');
  assert.equal(m.scenarioOf(row(4.9), 60, t), 'S_B_THICK_NO_ECHO');
  assert.equal(m.scenarioOf(row(4.9, { s_screen: 50 }), 29.9, t), 'S_A_SCREEN_NO_ECHO');
  assert.equal(m.scenarioOf(row(4.9, { s_screen: 49 }), 29.9, t), null); assert.equal(m.scenarioOf(row(5), 70, t), null);
  assert.equal(m.scenarioOf({ gw: { active: false }, features: {} }, 70, t), null);
  const metrics = w1 => ({ C0: { product_loss: 1, ge2_recall: .7, auc_ge2_primary_last: .68 }, W1: w1 });
  const deltas = u => ({ W1_VS_C0: { auc_ge2_primary_last: { ci95: [-.01, u] } } });
  assert.equal(m.decideGw(metrics({ product_loss: .99, ge2_recall: .68, auc_ge2_primary_last: .68 }), deltas(.01), m.GW_POLICY.rules).recommendation, 'ADOPT_CANDIDATE');
  const d = m.decideGw(metrics({ product_loss: 1, ge2_recall: .6799, auc_ge2_primary_last: .679 }), deltas(0), m.GW_POLICY.rules);
  assert.deepEqual(d.W1.checks, { product_loss_lower: false, auc_ge2_not_lower: false, auc_ge2_ci_upper_above_zero: false, ge2_recall: false });
  assert.equal(d.recommendation, 'NO_GAIN');
});

test('Policy 12 plan and the V2.5.5.6 reference are pinned', async () => {
  const m = await api();
  assert.equal(m.digest(m.GW_POLICY), '83f11df181ea3903e8dae75aa3585ee7b34ca1fd729db51a5ac3327d809371dd');
  assert.deepEqual([m.GW_POLICY.practical_tuning_schema_version, m.GW_POLICY.practical_tuning_policy_version], [12, 12]);
  assert.equal(m.release.V2556_REFERENCE.gw_reference, 0.795492); assert.equal(m.release.V2556_REFERENCE.grade_changed_vs_V2554, 49);
});
