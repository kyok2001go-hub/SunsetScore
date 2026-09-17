import { compare, unique, fail } from '../dataset/lib/common.mjs';
import { computeHeadlineMetrics, formatMetric } from './metrics.mjs';

function compareDisplayTuples(a, b) {
  for (const k of ['city', 'country', 'admin1']) {
    if (a[k] === b[k]) continue;
    if (a[k] == null) return -1;
    if (b[k] == null) return 1;
    const d = compare(a[k], b[k]);
    if (d) return d;
  }
  return 0;
}

export function computeSliceMetrics(benchmarkRows, benchmarkMode, split, policy) {
  const sliceRows = [];
  const warnings = [];

  // Group city metadata by location_key
  const locationDisplays = new Map();
  const locationVariants = new Map();

  for (const r of benchmarkRows) {
    if (r.location_key == null) continue;
    const currentTuple = { city: r.city, country: r.country, admin1: r.admin1 };
    if (!locationDisplays.has(r.location_key)) {
      locationDisplays.set(r.location_key, currentTuple);
      locationVariants.set(r.location_key, [currentTuple]);
    } else {
      const variants = locationVariants.get(r.location_key);
      const exists = variants.some(v => v.city === currentTuple.city && v.country === currentTuple.country && v.admin1 === currentTuple.admin1);
      if (!exists) variants.push(currentTuple);
      const chosen = locationDisplays.get(r.location_key);
      if (compareDisplayTuples(currentTuple, chosen) < 0) {
        locationDisplays.set(r.location_key, currentTuple);
      }
    }
  }

  // Check for location display variants warning
  for (const [locKey, variants] of locationVariants.entries()) {
    if (variants.length > 1) {
      warnings.push({
        warning_code: 'LOCATION_DISPLAY_VARIANTS',
        benchmark_mode: benchmarkMode,
        split,
        slice_dimension: 'city',
        slice_value: locKey,
        slice_value_is_null: false
      });
    }
  }

  for (const dimension of policy.slice_dimensions) {
    const isFixedEnum = Boolean(policy.fixed_slice_enums[dimension]);
    const values = [];

    // Collect values
    if (isFixedEnum) {
      // A value outside the frozen enum would otherwise vanish silently from the slice table.
      const known = policy.fixed_slice_enums[dimension];
      const unknown = unique(benchmarkRows.filter(r => r[dimension] != null && !known.includes(String(r[dimension])))
        .map(r => String(r[dimension])));
      if (unknown.length) {
        fail('MODEL_DATASET_VALIDATION_FAILED', { reason_code: 'SLICE_VALUE_NOT_IN_POLICY_ENUM',
          slice_dimension: dimension, slice_value: unknown[0] });
      }
      const hasNull = benchmarkRows.some(r => r[dimension] == null);
      if (hasNull) values.push({ value: null, isNull: true });
      for (const enumVal of policy.fixed_slice_enums[dimension]) {
        values.push({ value: enumVal, isNull: false });
      }
    } else if (dimension === 'city') {
      const hasNull = benchmarkRows.some(r => r.location_key == null);
      if (hasNull) values.push({ value: null, isNull: true });
      const keys = unique(benchmarkRows.filter(r => r.location_key != null).map(r => r.location_key));
      for (const k of keys) values.push({ value: k, isNull: false });
    } else {
      const hasNull = benchmarkRows.some(r => r[dimension] == null);
      if (hasNull) values.push({ value: null, isNull: true });
      const rawVals = unique(benchmarkRows.filter(r => r[dimension] != null).map(r => String(r[dimension])));
      for (const v of rawVals) values.push({ value: v, isNull: false });
    }

    for (const sliceTarget of values) {
      let matching;
      if (sliceTarget.isNull) {
        matching = dimension === 'city'
          ? benchmarkRows.filter(r => r.location_key == null)
          : benchmarkRows.filter(r => r[dimension] == null);
      } else {
        if (dimension === 'city') {
          matching = benchmarkRows.filter(r => r.location_key === sliceTarget.value);
        } else if (dimension === 'tile_radar_available' || dimension === 'tile_sat_available') {
          matching = benchmarkRows.filter(r => String(r[dimension]) === sliceTarget.value);
        } else {
          matching = benchmarkRows.filter(r => r[dimension] != null && String(r[dimension]) === sliceTarget.value);
        }
      }

      let cityDisplay = null, countryDisplay = null, admin1Display = null;
      if (dimension === 'city' && !sliceTarget.isNull) {
        const display = locationDisplays.get(sliceTarget.value);
        if (display) {
          cityDisplay = display.city;
          countryDisplay = display.country;
          admin1Display = display.admin1;
        }
      }

      if (matching.length === 0) {
        sliceRows.push({
          benchmark_mode: benchmarkMode,
          split,
          slice_dimension: dimension,
          slice_value: sliceTarget.value,
          slice_value_is_null: sliceTarget.isNull,
          city: cityDisplay,
          country: countryDisplay,
          admin1: admin1Display,
          sample_count: 0,
          event_count: 0,
          date_count: 0,
          weight_sum: 0,
          low_support: true,
          limited_date_coverage: true,
          weighted_mae: null,
          weighted_mae_reason_code: 'NO_SAMPLES',
          weighted_bias: null,
          weighted_bias_reason_code: 'NO_SAMPLES',
          weighted_exact_accuracy: null,
          weighted_exact_accuracy_reason_code: 'NO_SAMPLES',
          weighted_within_1_accuracy: null,
          weighted_within_1_accuracy_reason_code: 'NO_SAMPLES',
          weighted_severe_error_rate: null,
          weighted_severe_error_rate_reason_code: 'NO_SAMPLES',
          weighted_overprediction_rate: null,
          weighted_overprediction_rate_reason_code: 'NO_SAMPLES',
          weighted_underprediction_rate: null,
          weighted_underprediction_rate_reason_code: 'NO_SAMPLES'
        });
        continue;
      }

      const sampleCount = matching.length;
      const eventIds = unique(matching.map(r => r.event_id));
      const eventCount = eventIds.length;
      const dateCount = unique(matching.map(r => r.event_date_local)).length;
      const lowSupport = eventCount < policy.support_thresholds.min_event_count;
      const limitedDateCoverage = dateCount < policy.support_thresholds.min_date_count;

      // Event counts in this slice
      const eventRowCounts = new Map();
      for (const r of matching) {
        eventRowCounts.set(r.event_id, (eventRowCounts.get(r.event_id) || 0) + 1);
      }

      // Renormalize weights: gt_confidence / k_slice
      const reweightedRows = matching.map(r => ({
        ...r,
        weight: r.gt_confidence / eventRowCounts.get(r.event_id)
      }));

      // Sort reweighted rows by snapshot_id ASC for deterministic sum
      reweightedRows.sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
      const totalWeight = formatMetric(reweightedRows.reduce((sum, r) => sum + r.weight, 0)) ?? 0;
      const metrics = computeHeadlineMetrics(reweightedRows, 'weighted');

      sliceRows.push({
        benchmark_mode: benchmarkMode,
        split,
        slice_dimension: dimension,
        slice_value: sliceTarget.value,
        slice_value_is_null: sliceTarget.isNull,
        city: cityDisplay,
        country: countryDisplay,
        admin1: admin1Display,
        sample_count: sampleCount,
        event_count: eventCount,
        date_count: dateCount,
        weight_sum: totalWeight,
        low_support: lowSupport,
        limited_date_coverage: limitedDateCoverage,
        weighted_mae: metrics.mae,
        weighted_mae_reason_code: metrics.metric_reasons.mae,
        weighted_bias: metrics.bias,
        weighted_bias_reason_code: metrics.metric_reasons.bias,
        weighted_exact_accuracy: metrics.exact_accuracy,
        weighted_exact_accuracy_reason_code: metrics.metric_reasons.exact_accuracy,
        weighted_within_1_accuracy: metrics.within_1_accuracy,
        weighted_within_1_accuracy_reason_code: metrics.metric_reasons.within_1_accuracy,
        weighted_severe_error_rate: metrics.severe_error_rate,
        weighted_severe_error_rate_reason_code: metrics.metric_reasons.severe_error_rate,
        weighted_overprediction_rate: metrics.overprediction_rate,
        weighted_overprediction_rate_reason_code: metrics.metric_reasons.overprediction_rate,
        weighted_underprediction_rate: metrics.underprediction_rate,
        weighted_underprediction_rate_reason_code: metrics.metric_reasons.underprediction_rate
      });
    }
  }

  return { sliceRows, warnings };
}

export function computeWorstSlices(sliceRows, benchmarkMode, split, dimensions) {
  const result = {};
  for (const dim of dimensions) {
    const matching = sliceRows.filter(r =>
      r.benchmark_mode === benchmarkMode &&
      r.split === split &&
      r.slice_dimension === dim &&
      r.sample_count > 0
    );

    const sortFn = (a, b) => {
      if (b.weighted_mae !== a.weighted_mae) return (b.weighted_mae ?? -Infinity) - (a.weighted_mae ?? -Infinity);
      if (b.weighted_severe_error_rate !== a.weighted_severe_error_rate) return (b.weighted_severe_error_rate ?? -Infinity) - (a.weighted_severe_error_rate ?? -Infinity);
      if (b.event_count !== a.event_count) return b.event_count - a.event_count;
      if (a.slice_value_is_null !== b.slice_value_is_null) return a.slice_value_is_null ? -1 : 1;
      return compare(a.slice_value || '', b.slice_value || '');
    };

    const supported = matching.filter(r => !r.low_support && !r.limited_date_coverage).sort(sortFn).slice(0, 5);
    const limitedSupport = matching.filter(r => r.low_support || r.limited_date_coverage).sort(sortFn).slice(0, 5);

    const formatEntry = r => ({
      slice_dimension: r.slice_dimension,
      slice_value: r.slice_value,
      slice_value_is_null: r.slice_value_is_null,
      city: r.city,
      country: r.country,
      admin1: r.admin1,
      sample_count: r.sample_count,
      event_count: r.event_count,
      date_count: r.date_count,
      weight_sum: r.weight_sum,
      weighted_mae: r.weighted_mae,
      weighted_severe_error_rate: r.weighted_severe_error_rate
    });

    result[dim] = {
      supported: supported.map(formatEntry),
      limited_support: limitedSupport.map(formatEntry)
    };
  }
  return result;
}
