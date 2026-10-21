import { fail } from '../dataset/lib/common.mjs';
import { digest } from './policy.mjs';
import { collectMechanismTraces } from './mechanism-trace.mjs';
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function verifyIlluminationTrace(t) {
  const i = t.illumination_internal; if (!i) fail('ILLUMINATION_INTERNAL_TRACE_MISSING');
  const eq = (a, b) => { if (!near(a, b)) fail('ILLUMINATION_RECONSTRUCTION_FAILED'); };
  const mean = m => {
    const items = m.items.filter(v => Number.isFinite(v.value)), numerator = items.reduce((s, v) => s + v.value * v.weight, 0), denominator = items.reduce((s, v) => s + v.weight, 0);
    eq(numerator, m.numerator); eq(denominator, m.denominator);
    if (denominator > 0) eq(numerator / denominator, m.value); else if (m.value !== null) fail('ILLUMINATION_MISSING_MEAN_MISMATCH');
  };
  for (const name of ['center_mean', 'distance_mean', 'bank_mean']) mean(i[name]);
  let numerator = 0, denominator = 0, bandWeight = 0;
  for (const b of i.bands) {
    if (b.available_count !== b.available_values.length) fail('ILLUMINATION_BAND_COUNT_MISMATCH');
    for (const index of b.node_indices) {
      const d = i.nodes[index]?.distance_km, band = d < 50 ? 'near' : d < 100 ? 'medium' : d < 200 ? 'far' : 'veryFar';
      if (b.band !== band) fail('ILLUMINATION_BAND_BOUNDARY_MISMATCH');
    }
    if (b.available_count) {
      eq(b.available_values.reduce((s, v) => s + v, 0) / b.available_count, b.mean);
      eq(b.effective_confidence, b.configured_confidence || 1); eq(b.distance_weight * b.effective_confidence, b.weight); eq(b.weight * b.mean, b.numerator);
      numerator += b.numerator; denominator += b.weight; bandWeight += b.distance_weight;
    }
  }
  eq(numerator, i.spatial.numerator); eq(denominator, i.spatial.denominator); eq(bandWeight, i.spatial.band_weight_sum);
  eq(denominator > 0 ? numerator / denominator : i.spatial.canvas, i.spatial.value);
  if (bandWeight > 0) eq(denominator / bandWeight, i.spatial.distance_reliability);
  eq(denominator > 0 ? 1 : (i.spatial.configured_far_confidence || .75), i.spatial.data_factor);
  eq(i.bank_mean.value == null ? i.spatial.canvas : i.bank_mean.value, i.bank.value);
  if (i.bank.contrast_raw != null) {
    eq(i.bank.center_cloud_raw - i.bank.side_cloud_raw, i.bank.contrast_raw);
    eq(clamp(i.bank.contrast_raw / i.bank.contrast_full, 0, 1) * i.bank.contrast_bonus_max, i.bank.contrast_bonus);
    if (i.bank.contrast_bonus_max !== 0) eq(i.bank.contrast_bonus / i.bank.contrast_bonus_max * 100, i.bank.contrast_score_normalized);
  }
  eq(i.solar.twilight_minutes / i.solar.saturation_minutes, i.solar.ratio); eq(clamp(i.solar.ratio, 0, 1), i.solar.clamped_ratio);
  eq(30 + 70 * i.solar.clamped_ratio, i.solar.score);
  eq(i.formula.bank_share * i.bank.value + i.formula.spatial_share * i.spatial.value, i.formula.cloud_bank_potential);
  eq(i.solar.score * i.formula.cloud_bank_potential / 100 * i.spatial.data_factor, i.formula.raw);
  eq(clamp(i.formula.raw, 0, 100), i.formula.value); eq(i.formula.value, t.components.illumination);
  eq(t.dynamic_weights.illumination * i.formula.value, t.contributions.illumination); eq(i.contribution.value, t.contributions.illumination);
  eq(i.contribution.P, t.P); eq(i.contribution.Q, t.Q);
  return { status: 'PASS', tolerance: 1e-8 };
}
export async function collectIlluminationTraces(...args) {
  const traces = await collectMechanismTraces(...args); for (const t of traces) verifyIlluminationTrace(t); return traces;
}
export function illuminationLight(t) {
  verifyIlluminationTrace(t);
  const i = t.illumination_internal, s = t.sky_branch;
  if (!s) fail('ILLUMINATION_SKY_TRACE_REQUIRED');
  const { illumination, ...others } = t.components;
  const protectedValue = { others, dynamic_weights: t.dynamic_weights, Q: t.Q, horizon_gate: t.horizon_gate, hard_gate_reasons: t.hard_gate_reasons,
    fixed_modifiers: { structure_bonus: i.contribution.structure_bonus, transition_bonus: i.contribution.transition_bonus, weather_penalty: i.contribution.weather_penalty },
    solar_inputs: { twilight_minutes: i.solar.twilight_minutes, source: i.solar.source, sunset_utc: i.solar.sunset_utc, civil_dusk_utc: i.solar.civil_dusk_utc },
    sky: { branch: s.branch_id, state: s.state, formula: s.formula, inputs: s.inputs, nodes: s.nodes, sector: s.sector, thresholds: s.thresholds, decisions: s.decisions,
      returned_factor: s.returned_factor, applied_factor: s.fusion.applied_factor, F_gw: s.fusion.F_gw },
    shared_cloud_inputs: { nodes: i.nodes, bands: i.bands, bank: i.bank, spatial: i.spatial, center_mean: i.center_mean, distance_mean: i.distance_mean, bank_mean: i.bank_mean } };
  return { snapshot_id: t.snapshot_id, illumination, P: t.P, final_score: t.predicted_score, protected_sha256: digest(protectedValue) };
}
export function assertIlluminationCoupling(current, candidate) {
  if (current.length !== candidate.length) fail('ILLUMINATION_COHORT_CHANGED'); let changed = 0;
  for (const [index, a] of current.entries()) { const b = candidate[index];
    if (!b || a.snapshot_id !== b.snapshot_id || a.protected_sha256 !== b.protected_sha256) fail('ILLUMINATION_NON_TARGET_COMPONENT_CHANGED');
    if (a.illumination !== b.illumination) changed++;
  }
  return { status: 'PASS', snapshots: current.length, changed_illumination: changed,
    other_four_components_dynamic_weights_Q_gates_penalties_bonuses_sky_and_Fgw_equal: true };
}
