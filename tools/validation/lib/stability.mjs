import { createHash } from 'node:crypto';
import { canonicalJson, compare, fail, hash, unique } from '../../dataset/lib/common.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';
import { renormalizeEventWeights } from '../../optimization/lib/metrics.mjs';
import { validationPolicy } from '../validation-policy.mjs';

export function bootstrapSeed(planCoreSha256) {
  if (!/^[0-9a-f]{64}$/.test(planCoreSha256)) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'PLAN_HASH_INVALID' });
  return createHash('sha256').update('PHASE7_BOOTSTRAP_V1\n' + planCoreSha256, 'utf8')
    .digest().readUInt32BE(0);
}

export function bootstrapIndices(seed, dateCount, replicates = validationPolicy().bootstrap.replicates) {
  if (!Number.isInteger(dateCount) || dateCount < 1 || dateCount > 0xffffffff ||
      !Number.isInteger(replicates) || replicates < 1) {
    fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'BOOTSTRAP_DIMENSIONS_INVALID' });
  }
  let state = seed >>> 0;
  if (state === 0) state = 0x6D2B79F5;
  const limit = Math.floor(0x100000000 / dateCount) * dateCount;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return Array.from({ length: replicates }, () => Array.from({ length: dateCount }, () => {
    let value;
    do { value = next(); } while (value >= limit);
    return value % dateCount;
  }));
}

function rawQuantile(sorted, p) {
  const h = (sorted.length - 1) * p;
  const index = Math.floor(h);
  return sorted[index] + (h - index) * (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]);
}

/** Repeated dates multiply precomputed date error and weight; rows are never renormalized twice. */
export function dateBlockBootstrap(rows, seed, draws = null) {
  const ordered = [...rows].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
  const weighted = renormalizeEventWeights(ordered);
  const dates = unique(weighted.map(row => row.event_date_local));
  if (dates.length < 2) return { status: 'BOOTSTRAP_INSUFFICIENT_DATES', date_count: dates.length,
    ci_lower: null, ci_upper: null, point_delta_mae: null };
  const aggregates = dates.map(date => {
    let weight = 0, error = 0;
    for (const row of weighted.filter(item => item.event_date_local === date)) {
      const w = row.event_normalized_weight;
      const delta = Math.abs(row.experiment_ordinal - row.gt_ordinal) - Math.abs(row.control_ordinal - row.gt_ordinal);
      if (!Number.isFinite(w) || w <= 0 || !Number.isInteger(row.experiment_ordinal) ||
          !Number.isInteger(row.control_ordinal) || !Number.isInteger(row.gt_ordinal)) {
        fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'BOOTSTRAP_INPUT_INVALID' });
      }
      weight += w;
      error += w * delta;
    }
    return { weight, error };
  });
  const totalW = aggregates.reduce((sum, item) => sum + item.weight, 0);
  const totalE = aggregates.reduce((sum, item) => sum + item.error, 0);
  if (!(totalW > 0)) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'BOOTSTRAP_DENOMINATOR_INVALID' });
  const indices = draws || bootstrapIndices(seed, dates.length);
  const samples = indices.map(round => {
    if (round.length !== dates.length || round.some(index => !Number.isInteger(index) || index < 0 || index >= dates.length)) {
      fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'BOOTSTRAP_INDEX_INVALID' });
    }
    let w = 0, e = 0;
    for (const index of round) { w += aggregates[index].weight; e += aggregates[index].error; }
    if (!(w > 0)) fail('VALIDATION_VALIDATION_FAILED', { reason_code: 'BOOTSTRAP_DENOMINATOR_INVALID' });
    return e / w;
  }).sort((a, b) => a - b);
  return {
    status: 'COMPUTED', algorithm: validationPolicy().bootstrap.algorithm,
    cohort_sha256: hash(canonicalJson(ordered.map(row => row.snapshot_id))),
    date_count: dates.length, replicate_count: samples.length, seed: seed >>> 0,
    point_delta_mae: formatMetric(totalE / totalW),
    ci_lower: formatMetric(rawQuantile(samples, 0.025)),
    ci_upper: formatMetric(rawQuantile(samples, 0.975))
  };
}
