// V2.5.5.3 P0 diagnostics: frozen plan and sunset-time features (PRD §5, §6.1, §10.3).
// Pure functions over the Replay diagnostic observer; nothing here changes a score.
import { fail } from '../dataset/lib/common.mjs';

const freeze = value => Object.freeze(value);
export const P0_POLICY = freeze({
  practical_tuning_schema_version: 9, practical_tuning_policy_version: 9,
  search_space: 'p0-diagnostics', usage: 'PERSONAL_PROJECT_DIAGNOSTICS', evaluation_scope: 'REUSED_DEVELOPMENT_DATA',
  dev: freeze({ raw: 'raw_v1_20260909_20261012_ea82b68bfe49', gt: 'gt_v3_ea82b68bfe49_49c9adac6188',
    model: 'model_v2_ea82b68bfe49_49c9adac6188_f02dbabc357c', snapshots: 655, last_date: '2026-10-12' }),
  first_holdout_date: '2026-10-13',
  baseline: 'RELEASE_LINE_2.5.5.2', reference: 'RELEASE_LINE_2.5.5.1',
  blocking_mid_share: 0.5, blocking_node_threshold: 70,
  thresholds: freeze({
    primary: freeze({ l_corr_clear: 30, s_screen: 50, b_max: 70, visibility_km: 10, rh: 85, pm25: 75, l_corr_blocked: 60 }),
    alternative_lower: freeze({ l_corr_clear: 20, s_screen: 40, b_max: 60, visibility_km: 8, rh: 80, pm25: 75, l_corr_blocked: 60 }),
    alternative_upper: freeze({ l_corr_clear: 40, s_screen: 60, b_max: 80, visibility_km: 12, rh: 90, pm25: 75, l_corr_blocked: 60 })
  }),
  group_priority: freeze(['G4', 'G3', 'G2', 'G1', 'G0']),
  support: freeze({ events: 15, dates: 7, ge3_events: 5 }),
  slots: freeze({ '1213': 'S1213', '1613': 'S1613', '1720': 'EVENING', '1729': 'EVENING', '1755': 'EVENING' }),
  bins: freeze({ count: 5, minimum_for_peak: 3 }),
  t_avg_bins: freeze([0, 20, 40, 60, 80, 101]),
  probes: freeze(['GWP-0', 'GWP-1', 'GWP-2', 'GWP-3']),
  probe_spot_checks: 20,
  logistic: freeze({ lambda: 1, max_iterations: 100, tolerance: 1e-10 }),
  bootstrap: freeze({ algorithm: 'DATE_BLOCK_PERCENTILE', prng: 'xorshift32-v1', replicates: 2000, minimum_valid: 1900,
    lower: 0.025, upper: 0.975, seed: 'P0_DIAGNOSTICS_V2553' }),
  feature_ids: freeze(['l_corr', 'b_mean', 'b_max', 'b_robust', 'b_count', 's_screen', 's_ring', 't_avg', 'center_low', 'center_mid',
    'center_high', 'visibility_km', 'rh', 'pm25', 'aod', 'twilight_minutes', 'forecast_trend']),
  bin_variables: freeze(['rh', 'aod', 'pm25', 'visibility_km', 'center_low', 'center_mid', 'center_high', 'l_corr', 'b_mean',
    'b_max', 's_screen', 't_avg', 'twilight_minutes']),
  conditional_bin_variables: freeze(['s_screen', 'center_mid', 'center_high']),
  atmosphere_variables: freeze(['visibility_km', 'rh', 'pm25', 'aod']),
  decision_rules_version: 1
});

// V2.5.5.14 pooled re-run (Practical Tuning Schema/Policy 13; v9–v12 are taken). PRD: ref_docs/PRD/V2.5.5.14--P0机制诊断合并数据重跑方案.md
// Same frozen features, thresholds, support, bins, probes, logistic and bootstrap as Policy 9; only the data (DEV + H1 + H2),
// the baseline (2.5.5.11), the H3 date guard, the handling of non-standard slots and two supplementary rules (§5) differ.
const { practical_tuning_schema_version: _s, practical_tuning_policy_version: _p, search_space: _ss, dev: _dev, first_holdout_date: _h, baseline: _b, ...P0_SHARED } = P0_POLICY;
export const P0_POOLED_POLICY = freeze({
  ...P0_SHARED,
  practical_tuning_schema_version: 13, practical_tuning_policy_version: 13, search_space: 'p0-diagnostics-pooled',
  pools: freeze([
    freeze({ name: 'DEV', raw: 'raw_v1_20260909_20261012_ea82b68bfe49', gt: 'gt_v3_ea82b68bfe49_49c9adac6188',
      model: 'model_v2_ea82b68bfe49_49c9adac6188_f02dbabc357c', snapshots: 655, first_date: '2026-09-09', last_date: '2026-10-12' }),
    freeze({ name: 'H1', raw: 'raw_v1_20261013_20261029_746b90031b27', gt: 'gt_v3_746b90031b27_8100bdd7e028',
      model: 'model_v2_746b90031b27_8100bdd7e028_f8b2ac54193b', snapshots: 393, first_date: '2026-10-13', last_date: '2026-10-29' }),
    freeze({ name: 'H2', raw: 'raw_v1_20261030_20261115_b9e8fffd7bf4', gt: 'gt_v3_b9e8fffd7bf4_8abdd390b201',
      model: 'model_v2_b9e8fffd7bf4_8abdd390b201_a7e3d4d1758e', snapshots: 329, first_date: '2026-10-30', last_date: '2026-11-15' })
  ]),
  h3_first_date: '2026-11-16',
  baseline: 'RELEASE_LINE_2.5.5.11', reference: 'RELEASE_LINE_2.5.5.1',
  // Manual and catch-up captures (e.g. 1414, 1626) are kept but take no part in per-slot breakdowns.
  other_slot: 'OTHER',
  live_parity_model_versions: freeze(['2.5.5.4', '2.5.5.11']),
  supplementary_rules: freeze({
    version: 1,
    // §5 rule 1: directions already tested and found NO_GAIN need evidence for a different, specific change.
    already_tested: freeze({
      P1_ATMOSPHERE_FUNCTION: freeze({ tested_by: 'V2.5.5.5 (AOD monotone response)', different_change_if: 'RH_SHAPE_MONOTONE' }),
      P1_GW_LAYERED_BLOCKING_PROXY: freeze({ tested_by: 'V2.5.5.6 (golden-window cloud/rain split; layered proxy retired in the roadmap)', different_change_if: 'GWP2_DELTA_AUC_GE2_LOWER_ABOVE_0' })
    }),
    // §5 rule 2: a significant G1 severe-miss excess puts the mid/high response at PRIORITY_2 or better.
    g1_severe_miss_item: 'P1_CONDITIONAL_MID_HIGH_RESPONSE', g1_severe_miss_max_rank: 2
  })
});

const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const blocking = (s, share) => finite(s.low) && finite(s.mid) ? clamp(s.low + share * s.mid, 0, 100) : null;
// Same semantics as the engine: missing values are skipped; a NaN weight voids the mean (NaN > 0 is false).
function weightedMean(items) {
  let sum = 0, weight = 0;
  for (const it of items) if (finite(it.value)) { sum += it.weight * it.value; weight += it.weight; }
  return weight > 0 ? sum / weight : null;
}
// Whether the bank sector is voided by an offset-less sample (reported as a finding, not corrected).
export const bankSectorVoided = corridor => corridor.some(s => s.azimuth_offset !== 0 && !finite(s.azimuth_offset));
const median = values => { const s = values.filter(finite).sort((a, b) => a - b); if (!s.length) return null;
  const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Exactly the engine's effective horizon aggregation (js/engine.js sectorOpening): offset 0 = corridor sector, any other
// offset = bank sector, distance weights within an offset, cos^power between offsets, sector weights renormalised.
// As in the engine, a sample whose offset is missing (the Replay/production center point) falls into the bank sector with
// a NaN angular weight, which voids that sector; horizon then reflects only the 0° ray at 50–300 km.
export function sectorAggregate(corridor, scoring, valueOf) {
  const sf = scoring.spatialField, sectors = { corridor: [], bank: [] };
  for (const s of corridor) { const v = valueOf(s); if (finite(v)) (s.azimuth_offset === 0 ? sectors.corridor : sectors.bank).push({ ...s, v }); }
  const sector = nodes => {
    if (!nodes.length) return null;
    const byOffset = new Map();
    for (const n of nodes) { const key = String(n.azimuth_offset); if (!byOffset.has(key)) byOffset.set(key, []); byOffset.get(key).push(n); }
    return weightedMean([...byOffset].map(([key, list]) => ({
      value: weightedMean(list.map(n => ({ value: n.v, weight: scoring.horizonDistanceWeights[n.distance_km] || 0.1 }))),
      weight: Math.pow(Math.cos(Number(key) * Math.PI / 180), sf.angularPower) })));
  };
  return weightedMean([{ value: sector(sectors.corridor), weight: sf.sectorWeights.corridor },
    { value: sector(sectors.bank), weight: sf.sectorWeights.bank }]);
}

// V2.5.5.4: the engine's effective offsets (js/engine.js offsetFor). With spatialField.centerAzimuthOffset set, the offset-less
// 0 km sample takes that offset (both scopes: these features describe horizon). Without the key the corridor is returned as is.
export function effectiveCorridor(corridor, scoring) {
  const fix = scoring?.spatialField?.centerAzimuthOffset;
  if (!finite(fix)) return corridor;
  return corridor.map(s => s.distance_km === 0 && s.azimuth_offset == null ? { ...s, azimuth_offset: fix } : s);
}

// Features F01–F17 for one Snapshot (PRD §5). `trace` is the replay trace with diagnostic_observer.
export function sunsetFeatures(trace, scoring, policy = P0_POLICY) {
  const o = trace?.diagnostic_observer;
  if (!o || o.observer_version !== 1) fail('P0_OBSERVER_MISSING');
  const share = policy.blocking_mid_share, corridor = effectiveCorridor(o.corridor, scoring), ray = corridor.filter(s => s.azimuth_offset === 0 && s.distance_km > 0);
  const opening = sectorAggregate(corridor, scoring, s => finite(s.low) ? clamp(1 - s.low / 100, 0, 1) * 100 : null);
  const offsets = [...new Set(corridor.map(s => s.azimuth_offset))].sort((a, b) => a - b);
  const rayMax = offset => { const v = corridor.filter(s => s.azimuth_offset === offset && s.distance_km > 0).map(s => blocking(s, share)).filter(finite);
    return v.length ? Math.max(...v) : null; };
  const rayBlocking = ray.map(s => blocking(s, share)).filter(finite);
  const center = o.sunset_field.center, screen = n => finite(n?.mid) || finite(n?.high) ? Math.max(n.mid ?? -Infinity, n.high ?? -Infinity) : null;
  const ring = o.sunset_field.nodes.filter(n => n.distance_km === 50 && n.has_data).map(screen).filter(finite);
  const air = trace.atmosphere_inputs || {};
  return {
    l_corr: opening == null ? null : 100 - opening,
    b_mean: sectorAggregate(corridor, scoring, s => blocking(s, share)),
    b_max: rayBlocking.length ? Math.max(...rayBlocking) : null,
    b_robust: median(offsets.map(rayMax)),
    b_count: rayBlocking.length ? rayBlocking.filter(v => v >= policy.blocking_node_threshold).length : null,
    s_screen: screen(center), s_ring: ring.length ? ring.reduce((a, b) => a + b, 0) / ring.length : null,
    t_avg: o.sunset_field.avg_cloud_cover ?? null, engine_bank_sector_voided: bankSectorVoided(corridor),
    center_low: center?.low ?? null, center_mid: center?.mid ?? null, center_high: center?.high ?? null,
    visibility_km: air.visibility_km ?? null, rh: air.humidity ?? null, pm25: air.pm25 ?? null, aod: air.aod ?? null,
    twilight_minutes: o.twilight_minutes ?? null, forecast_trend: o.golden_window?.forecast_trend ?? null
  };
}

// Mechanism groups (PRD §6.1). Groups may overlap; `exclusive` follows the frozen priority G4 > G3 > G2 > G1 > G0.
export function mechanismGroups(f, t) {
  const has = v => finite(v);
  const G1 = has(f.l_corr) && has(f.s_screen) && f.l_corr <= t.l_corr_clear && f.s_screen >= t.s_screen;
  const G2 = has(f.l_corr) && has(f.b_max) && f.l_corr <= t.l_corr_clear && f.b_max >= t.b_max;
  const G3 = (has(f.visibility_km) && f.visibility_km < t.visibility_km) || (has(f.rh) && f.rh >= t.rh) || (has(f.pm25) && f.pm25 >= t.pm25);
  const G4 = has(f.l_corr) && f.l_corr >= t.l_corr_blocked;
  const flags = { G1, G2, G3, G4, G0: !(G1 || G2 || G3 || G4) };
  return { ...flags, exclusive: P0_POLICY.group_priority.find(g => flags[g]) };
}
