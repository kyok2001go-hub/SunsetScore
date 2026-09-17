import { canonicalJson, compare, fail, unique } from '../../dataset/lib/common.mjs';
import { BENCHMARK_MODES, REPORT_SPLITS, GT_LABELS } from '../evaluation-schema.mjs';
import { computeWorstSlices } from '../slice-analysis.mjs';
import { evaluationPolicy } from '../evaluation-policy.mjs';

const check = (ok, reason) => { if (!ok) fail('EVALUATION_VALIDATION_FAILED', { reason_code: reason }); };
const equal = (a, b, reason) => check(canonicalJson(a) === canonicalJson(b), reason);
const close = (a, b, reason) => check(a === null || b === null ? a === b :
  typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= 1e-10, reason);
const keys = (obj, names, reason) => equal(Object.keys(obj).sort(compare), [...names].sort(compare), reason);
const counts = ['sample_count', 'event_count', 'date_count', 'weight_sum'];
const metricNames = ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate', 'overprediction_rate', 'underprediction_rate', 'qwk'];

// Reconstruct from published matrix cells, independent of the row-based metric engine.
function fromMatrix(cells, weighting) {
  const value = r => weighting === 'weighted' ? r.weight_sum : r.sample_count;
  const W = cells.reduce((s, r) => s + value(r), 0);
  const avg = f => W ? cells.reduce((s, r) => s + value(r) * f(r.predicted_ordinal - r.gt_ordinal), 0) / W : null;
  const result = { mae: avg(Math.abs), bias: avg(e => e), exact_accuracy: avg(e => +(e === 0)),
    within_1_accuracy: avg(e => +(Math.abs(e) <= 1)), severe_error_rate: avg(e => +(Math.abs(e) >= 2)),
    overprediction_rate: avg(e => +(e > 0)), underprediction_rate: avg(e => +(e < 0)) };
  const g = Array(5).fill(0), p = Array(5).fill(0);
  let observed = 0, expected = 0;
  for (const r of cells) { g[r.gt_ordinal] += value(r); p[r.predicted_ordinal] += value(r); observed += value(r) * (r.gt_ordinal - r.predicted_ordinal) ** 2; }
  if (W) for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) expected += g[a] * p[b] * (a - b) ** 2 / W;
  result.qwk = expected ? 1 - observed / expected : null;
  return result;
}

export function checkInternalConsistency({ manifest: m, overall, summary, matrix, slices, distributions, paired, errors, warnings }) {
  const policy = evaluationPolicy();
  equal(Object.keys(overall.benchmarks).sort(), [...BENCHMARK_MODES].sort(), 'BENCHMARK_KEYS');
  equal(Object.keys(summary.groups).sort(), BENCHMARK_MODES.flatMap(mode => REPORT_SPLITS.map(s => `${mode}.${s}`)).sort(), 'SUMMARY_GROUP_KEYS');
  equal(m.schema_sha256, m.files['schema.json'].sha256, 'SCHEMA_HASH');
  equal(m.policy_sha256, m.files['policy.json'].sha256, 'POLICY_HASH');
  equal(summary.model_dataset_id, m.model_dataset_id, 'SUMMARY_SOURCE');
  equal(summary.evaluated_versions, m.evaluated_versions, 'SUMMARY_VERSIONS');
  check((m.model_dataset_schema_version === 1 && m.model_dataset_policy_version === 1) ||
    (m.model_dataset_schema_version === 2 && [2, 3].includes(m.model_dataset_policy_version)), 'SOURCE_VERSION');
  check(m.model_dataset_id.startsWith(`model_v${m.model_dataset_schema_version}_`) &&
    m.model_dataset_id.endsWith(m.model_dataset_descriptor_sha256.slice(0, 12)), 'SOURCE_ID');
  for (const values of Object.values(m.evaluated_versions)) equal(values, unique(values), 'VERSION_ORDER');
  const all = overall.benchmarks.ALL_PRIMARY.TRAIN_VALIDATION;
  for (const k of counts.slice(0, 3)) equal(m[k], all[k], 'MANIFEST_COUNTS');
  check(matrix.length === 150 && paired.length === 12 && distributions.length === 30, 'TABLE_GROUP_COUNTS');
  for (const mode of BENCHMARK_MODES) {
    keys(overall.benchmarks[mode], REPORT_SPLITS, 'SPLIT_KEYS');
    for (const split of REPORT_SPLITS) {
      const group = overall.benchmarks[mode][split], sum = summary.groups[`${mode}.${split}`];
      check(group.date_count <= group.event_count && group.event_count <= group.sample_count, 'SUPPORT_ORDER');
      if (mode === 'CLOSEST_PRE_SUNSET') equal(group.sample_count, group.event_count, 'CLOSEST_EVENT_COUNT');
      for (const k of counts) equal(group[k], m.benchmark_counts[mode][split][k], 'BENCHMARK_COUNTS');
      const cells = matrix.filter(r => r.benchmark_mode === mode && r.split === split);
      equal(cells.map(r => [r.gt_ordinal, r.predicted_ordinal]), Array.from({ length: 25 }, (_, i) => [Math.floor(i / 5), i % 5]), 'MATRIX_COORDINATES');
      for (const cell of cells) {
        equal(cell.gt_label, GT_LABELS[cell.gt_ordinal], 'MATRIX_LABEL');
        equal(cell.predicted_label, GT_LABELS[cell.predicted_ordinal], 'MATRIX_LABEL');
        check(cell.sample_count > 0 || cell.weight_sum === 0, 'MATRIX_EMPTY_WEIGHT');
      }
      for (const wt of ['weighted', 'unweighted']) {
        keys(group[wt], [...metricNames, 'metric_reasons'], 'HEADLINE_KEYS');
        keys(group[wt].metric_reasons, metricNames, 'METRIC_REASON_KEYS');
        const reference = fromMatrix(cells, wt);
        for (const k of metricNames) {
          close(group[wt][k], reference[k], 'METRIC_TAMPER_DETECTED');
          const expectedReason = reference[k] !== null ? null : !group.sample_count ? 'NO_SAMPLES' :
            wt === 'weighted' && group.weight_sum === 0 ? 'ZERO_WEIGHT' : 'QWK_ZERO_EXPECTED_DISAGREEMENT';
          equal(group[wt].metric_reasons[k], expectedReason, 'METRIC_REASON');
        }
      }
      // Compared after metric verification so tampered headline values surface as tampering.
      for (const k of Object.keys(group)) equal(sum[k], group[k], 'SUMMARY_OVERALL_MISMATCH');
      const dist = distributions.filter(r => r.benchmark_mode === mode && r.split === split);
      equal(dist.map(r => r.gt_label), GT_LABELS, 'DISTRIBUTION_LEVELS');
      for (const d of dist) {
        equal(d.sample_count, cells.filter(r => r.gt_label === d.gt_label).reduce((s, r) => s + r.sample_count, 0), 'DISTRIBUTION_COUNT');
        check(d.event_count <= d.sample_count, 'DISTRIBUTION_SUPPORT');
        for (const k of ['mean', 'median', 'p25', 'p75', 'min', 'max']) {
          equal(d[`${k}_reason_code`], d.sample_count ? null : 'NO_SAMPLES', 'DISTRIBUTION_REASON');
          check(d.sample_count ? d[k] !== null && d[k] >= 0 && d[k] <= 100 : d[k] === null, 'DISTRIBUTION_RANGE');
        }
        if (d.sample_count) check(d.min <= d.p25 && d.p25 <= d.median && d.median <= d.p75 && d.p75 <= d.max && d.min <= d.mean && d.mean <= d.max, 'DISTRIBUTION_ORDER');
      }
      const pairs = paired.filter(r => r.benchmark_mode === mode && r.split === split);
      equal(pairs.map(r => r.weighting), ['weighted', 'unweighted'], 'PAIRED_WEIGHTINGS');
      for (const r of pairs) {
        equal(r.benchmark_sample_count, group.sample_count, 'PAIRED_SUPPORT');
        equal(r.benchmark_event_count, group.event_count, 'PAIRED_SUPPORT');
        check(r.paired_event_count <= r.paired_sample_count && r.paired_sample_count <= group.sample_count, 'PAIRED_SUPPORT');
        equal(r.missing_baseline_sample_count, group.sample_count - r.paired_sample_count, 'PAIRED_SUPPORT');
        close(r.paired_sample_coverage, group.sample_count ? r.paired_sample_count / group.sample_count : null, 'PAIRED_COVERAGE');
        close(r.paired_event_coverage, group.event_count ? r.paired_event_count / group.event_count : null, 'PAIRED_COVERAGE');
        if (r.paired_sample_count && r.weight_sum) {
          close(r.delta_mae, r.final_mae - r.baseline_mae, 'PAIRED_DELTA');
          close(r.final_win_rate + r.tie_rate + r.baseline_win_rate, 1, 'PAIRED_RATES');
        }
        for (const [k, value] of Object.entries(r)) if (k.endsWith('_reason_code')) {
          const metric = k.slice(0, -12);
          check(r[metric] === null ? typeof value === 'string' && !!value : value === null, 'PAIRED_REASON');
        }
      }
      equal(sum.worst_slices, computeWorstSlices(slices, mode, split, policy.worst_slices_dimensions), 'WORST_SLICES');
      const candidates = errors.filter(r => (split === 'TRAIN_VALIDATION' || r.split === split) && (mode === 'ALL_PRIMARY' || r.selected_in_closest));
      const seen = new Set();
      const expectedCases = candidates.filter(r => { if (seen.has(r.event_id)) return false; seen.add(r.event_id); return true; }).slice(0, 20);
      equal(sum.worst_cases.map(r => r.snapshot_id), expectedCases.map(r => r.snapshot_id), 'WORST_CASES');
      for (let i = 0; i < expectedCases.length; i++) for (const [key, value] of Object.entries(sum.worst_cases[i])) equal(value, expectedCases[i][key], 'WORST_CASE_VALUES');
      const hc = sum.high_confidence;
      check(hc.high_confidence_sample_count <= group.sample_count && hc.high_confidence_event_count <= group.event_count, 'HIGH_CONFIDENCE_SUPPORT');
      const severe = candidates.filter(r => r.is_high_confidence && r.is_severe);
      equal(hc.high_confidence_severe_sample_count, severe.length, 'HIGH_CONFIDENCE_ERRORS');
      equal(hc.high_confidence_severe_event_count, unique(severe.map(r => r.event_id)).length, 'HIGH_CONFIDENCE_EVENTS');
      close(hc.severe_sample_rate, hc.high_confidence_sample_count ? severe.length / hc.high_confidence_sample_count : null, 'HIGH_CONFIDENCE_RATE');
      close(hc.severe_event_rate, hc.high_confidence_event_count ? hc.high_confidence_severe_event_count / hc.high_confidence_event_count : null, 'HIGH_CONFIDENCE_RATE');
    }
    const b = overall.benchmarks[mode];
    for (const k of ['sample_count', 'event_count']) equal(b.TRAIN[k] + b.VALIDATION[k], b.TRAIN_VALIDATION[k], 'SPLIT_TOTAL');
    close(b.TRAIN.weight_sum + b.VALIDATION.weight_sum, b.TRAIN_VALIDATION.weight_sum, 'SPLIT_TOTAL');
  }
  const errorIds = new Set();
  for (const r of errors) {
    check(!errorIds.has(r.snapshot_id), 'DUPLICATE_ERROR'); errorIds.add(r.snapshot_id);
    equal(r.ordinal_error, r.predicted_ordinal - r.gt_ordinal, 'ERROR_VALUE');
    equal(r.absolute_error, Math.abs(r.ordinal_error), 'ERROR_VALUE');
    equal(r.is_severe, r.absolute_error >= 2, 'ERROR_SEVERE'); equal(r.is_high_confidence, r.gt_status === 'STRONG', 'ERROR_CONFIDENCE');
  }
  const warningKeys = warnings.map(canonicalJson);
  equal(new Set(warningKeys).size, warnings.length, 'DUPLICATE_WARNING');
  const warningCounts = {};
  for (const r of warnings) warningCounts[r.warning_code] = (warningCounts[r.warning_code] || 0) + 1;
  equal(summary.warnings_summary, warningCounts, 'WARNING_COUNTS');
}
