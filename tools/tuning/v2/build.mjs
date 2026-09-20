import { canonicalJson, hash, compare, fail, unique } from '../../dataset/lib/common.mjs';
import { readCsv, writeCsv } from '../../dataset/lib/csv.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';
import { runReplay } from '../../replay/replay-runner.mjs';
import { buildSensitivityPackage } from '../lib/build.mjs';
import { computeControl, ordinalOf } from '../lib/experiment.mjs';
import { metricPair, headlineFor, sliceAggregate } from '../lib/metrics.mjs';
import { leaveOneDateOut } from '../lib/stability.mjs';
import { parameterSummaryRows, buildWarnings } from '../lib/report.mjs';
import { CSV_TABLES, SLICE_DIMENSIONS, FIXED_SLICE_ENUMS, WARNING_FIELDS } from '../tuning-schema.mjs';
import { inspectBaselineLinkage } from './baseline-linkage.mjs';
import { POLICY_V2, SCHEMA_V2, CSV_TABLES_V2, FILES_V2 } from './contract.mjs';

const check = (condition, reason_code) => { if (!condition) fail('TUNING_VALIDATION_FAILED', { reason_code }); };
const parse = content => JSON.parse(content);

export function pairedWeights(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.event_id, (counts.get(row.event_id) || 0) + 1);
  return rows.map(row => ({ ...row, event_normalized_weight: row.gt_confidence / counts.get(row.event_id) }));
}

export function pairedDiagnostics(rows, referenceOrdinal) {
  const reweighted = pairedWeights(rows);
  const pair = metricPair(reweighted);
  const noSkill = Number.isInteger(referenceOrdinal) ? headlineFor(
    reweighted.map(row => ({ ...row, no_skill_score: [0, 20, 40, 60, 90][referenceOrdinal] })), 'no_skill_score'
  ) : null;
  const reason = !rows.length ? 'NO_PAIRED_SAMPLES' :
    !Number.isInteger(referenceOrdinal) ? 'NO_SKILL_REFERENCE_UNAVAILABLE' :
      noSkill?.metric_reasons.mae ?? null;
  const gap = scoreKey => {
    if (!Number.isInteger(referenceOrdinal) || !reweighted.length) return null;
    const ordered = [...reweighted].sort((a, b) => compare(a.snapshot_id, b.snapshot_id));
    let numerator = 0, denominator = 0;
    for (const row of ordered) {
      numerator += row.event_normalized_weight *
        (Math.abs(row[scoreKey] - row.gt_ordinal) - Math.abs(referenceOrdinal - row.gt_ordinal));
      denominator += row.event_normalized_weight;
    }
    return denominator > 0 ? formatMetric(numerator / denominator) : null;
  };
  const controlGap = gap('control_ordinal');
  const experimentGap = gap('experiment_ordinal');
  return {
    reweighted,
    pair,
    fields: {
      no_skill_reference_ordinal: referenceOrdinal,
      paired_no_skill_mae: noSkill?.mae ?? null,
      paired_no_skill_mae_reason_code: noSkill?.mae == null ? reason : null,
      control_mae_gap_to_no_skill: controlGap,
      control_mae_gap_reason_code: controlGap === null ? (reason || pair.control.metric_reasons.mae) : null,
      experiment_mae_gap_to_no_skill: experimentGap,
      experiment_mae_gap_reason_code: experimentGap === null ? (reason || pair.experiment.metric_reasons.mae) : null
    }
  };
}

function proxyMetricColumns(pair) {
  const out = {};
  const names = ['mae', 'bias', 'exact_accuracy', 'within_1_accuracy', 'severe_error_rate',
    'overprediction_rate', 'underprediction_rate', 'qwk'];
  for (const name of names) {
    out[`control_${name}`] = pair.control[name];
    out[`experiment_${name}`] = pair.experiment[name];
    if (`delta_${name}` in pair.deltas) out[`delta_${name}`] = pair.deltas[`delta_${name}`];
  }
  return out;
}

function columnsFor(file, values) {
  const names = new Set(CSV_TABLES_V2[file].map(field => field.name));
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name)));
}

export function alignmentSummary(rows) {
  const valid = rows.filter(row => row.control_score !== null);
  const builds = unique(rows.map(row => row.engine_build_sha));
  return {
    sample_count: rows.length,
    aligned_count: valid.length,
    exact_score_count: valid.filter(row => row.score_delta === 0).length,
    exact_score_rate: valid.length ? formatMetric(valid.filter(row => row.score_delta === 0).length / valid.length) : null,
    exact_ordinal_count: valid.filter(row => row.ordinal_changed === false).length,
    exact_ordinal_rate: valid.length ? formatMetric(valid.filter(row => row.ordinal_changed === false).length / valid.length) : null,
    max_abs_score_delta: valid.length ? Math.max(...valid.map(row => Math.abs(row.score_delta))) : null,
    by_engine_build: builds.map(build => ({
      engine_build_sha: build,
      sample_count: rows.filter(row => row.engine_build_sha === build).length,
      aligned_count: valid.filter(row => row.engine_build_sha === build).length
    }))
  };
}

function addPairedMetrics(files, ctx, referenceOrdinal) {
  const read = file => readCsv(CSV_TABLES[file], Buffer.from(files[file]));
  const metrics = read('experiment_metrics.csv');
  const ablations = read('ablation_metrics.csv');
  const deltas = read('sample_deltas.csv');
  const cohortById = new Map(ctx.cohort.map(row => [row.snapshot_id, row]));
  const byExperiment = new Map();
  for (const row of deltas) {
    const source = cohortById.get(row.snapshot_id);
    check(source && source.event_id === row.event_id && source.gt_ordinal === row.gt_ordinal,
      'PAIRED_COHORT_IDENTITY_MISMATCH');
    if (!byExperiment.has(row.experiment_id)) byExperiment.set(row.experiment_id, []);
    byExperiment.get(row.experiment_id).push({ ...source, ...row });
  }
  const metricById = new Map();
  const diagnosticsById = new Map();
  for (const metric of metrics) {
    const diagnostics = pairedDiagnostics(byExperiment.get(metric.experiment_id) || [], referenceOrdinal);
    Object.assign(metric, columnsFor('experiment_metrics.csv', proxyMetricColumns(diagnostics.pair)), diagnostics.fields, {
      weight_sum: formatMetric(diagnostics.reweighted.reduce((sum, row) => sum + row.event_normalized_weight, 0)) ?? 0
    });
    const stability = leaveOneDateOut(diagnostics.reweighted, 'experiment_ordinal');
    Object.assign(metric, {
      lodo_fold_count: stability.fold_count,
      lodo_improved_count: stability.improved_date_count,
      lodo_degraded_count: stability.degraded_date_count,
      lodo_stability_ratio: stability.direction_stability_ratio,
      lodo_reason_code: stability.reason_code,
      limited_date_coverage: stability.limited_date_coverage
    });
    metricById.set(metric.experiment_id, metric);
    diagnosticsById.set(metric.experiment_id, diagnostics);
  }
  const slices = metrics.flatMap(metric => sliceAggregate(byExperiment.get(metric.experiment_id) || [],
    metric, SLICE_DIMENSIONS, FIXED_SLICE_ENUMS));
  for (const ablation of ablations) {
    const metric = metricById.get(ablation.experiment_id);
    Object.assign(ablation, columnsFor('ablation_metrics.csv', proxyMetricColumns(diagnosticsById.get(ablation.experiment_id).pair)),
      Object.fromEntries(Object.keys(diagnosticsById.get(ablation.experiment_id).fields)
        .map(key => [key, metric[key]])), { weight_sum: metric.weight_sum });
  }
  for (const slice of slices) {
    const key = slice.slice_dimension === 'city' ? 'location_key' : slice.slice_dimension;
    const matching = (byExperiment.get(slice.experiment_id) || []).filter(row =>
      slice.slice_value_is_null ? row[key] == null : String(row[key]) === slice.slice_value);
    check(matching.length === slice.sample_count, 'SLICE_COHORT_MISMATCH');
    const diagnostic = pairedDiagnostics(matching, referenceOrdinal);
    Object.assign(slice, columnsFor('slice_deltas.csv', proxyMetricColumns(diagnostic.pair)), diagnostic.fields, {
      weight_sum: formatMetric(diagnostic.reweighted.reduce((sum, row) => sum + row.event_normalized_weight, 0)) ?? 0
    });
  }
  for (const row of deltas) {
    const paired = diagnosticsById.get(row.experiment_id).reweighted.find(item => item.snapshot_id === row.snapshot_id);
    row.event_normalized_weight = paired.event_normalized_weight;
    for (const key of ['location_key', 'gt_status', 'gt_basis', 'regime_label', 'sky_evolution_state',
      'scheduled_slot', 'snapshot_source', 'tile_radar_available', 'tile_sat_available']) {
      row[key] = paired[key] ?? null;
    }
  }
  const parameterSummary = parameterSummaryRows({
    ctx,
    results: metrics.map(metric => ({ entry: metric, rows: byExperiment.get(metric.experiment_id) || [] })),
    experimentMetrics: metrics
  });
  for (const row of parameterSummary) row.metric_usage = 'PROXY_EXPLORATORY';
  for (const [file, rows] of [
    ['experiment_metrics.csv', metrics], ['ablation_metrics.csv', ablations],
    ['slice_deltas.csv', slices], ['sample_deltas.csv', deltas], ['parameter_summary.csv', parameterSummary]
  ]) files[file] = writeCsv(CSV_TABLES_V2[file], rows);
  return { metrics, ablations, parameterSummary };
}

export async function buildSensitivityPackageV2(options) {
  const linkage = await inspectBaselineLinkage(options);
  const built = await buildSensitivityPackage(options);
  check(linkage.evaluation_id === built.ctx.source.evaluation_id &&
    linkage.evaluation_manifest_sha256 === built.ctx.source.evaluation_manifest_sha256,
  'EVALUATION_LINKAGE_CHANGED');
  const { ctx } = built;
  const files = { ...built.files };
  const paired = addPairedMetrics(files, ctx, linkage.no_skill_reference_ordinal);
  const { control, controlFailures } = await computeControl({
    cohort: ctx.cohort, config: ctx.loaded.config, runReplay, progress: options.progress
  });
  const controlById = new Map(control.map(item => [item.snapshot_id, item]));
  const failureIds = new Set(controlFailures.map(row => row.snapshot_id));
  const alignment = ctx.cohort.map(row => {
    const c = controlById.get(row.snapshot_id);
    check(c || failureIds.has(row.snapshot_id), 'CONTROL_ALIGNMENT_MISSING');
    const historicalOrdinal = ordinalOf(row.predicted_score);
    return {
      snapshot_id: row.snapshot_id, event_id: row.event_id,
      engine_build_sha: row.engine_build_sha, config_hash: row.config_hash,
      historical_score: row.predicted_score, historical_ordinal: historicalOrdinal,
      control_score: c?.control_score ?? null, control_ordinal: c?.control_ordinal ?? null,
      score_delta: c ? c.control_score - row.predicted_score : null,
      ordinal_changed: c ? c.control_ordinal !== historicalOrdinal : null,
      reason_code: c ? null : 'CONTROL_REPLAY_FAILED'
    };
  });
  files['control_alignment.csv'] = writeCsv(CSV_TABLES_V2['control_alignment.csv'], alignment);
  const dataReasons = ctx.readiness.reasons.filter(reason => reason !== 'REPLAY_USABLE_RATE_BELOW_REQUIRED');
  const engineering = { status: 'READY', reasons: [] };
  const data = { status: dataReasons.length ? 'INSUFFICIENT' : 'READY', reasons: dataReasons };
  const metric = { status: 'PROVISIONAL_PROXY', reasons: ['PROXY_MAPPING_NOT_VALIDATED'] };
  const globalReasons = [...(dataReasons.length ? ['DATA_SUPPORT_INSUFFICIENT'] : []),
    ...metric.reasons];
  const belowNoSkill = paired.metrics.some(row => row.control_mae_gap_to_no_skill > 0);
  if (belowNoSkill) globalReasons.push('MODEL_BELOW_NO_SKILL_REFERENCE');
  const warningRows = buildWarnings({ ctx, parameterSummary: paired.parameterSummary,
    ablationMetrics: paired.ablations });
  for (const code of globalReasons) warningRows.push({
    warning_code: code, scope: 'readiness', parameter_id: null, experiment_id: null,
    slice_dimension: null, slice_value: null, slice_value_is_null: null
  });
  warningRows.sort((a, b) => compare(a.warning_code, b.warning_code));
  files['reports/warnings.csv'] = writeCsv(WARNING_FIELDS, warningRows);
  const warningCounts = {};
  for (const row of warningRows) warningCounts[row.warning_code] = (warningCounts[row.warning_code] || 0) + 1;
  const readiness = {
    ...parse(files['readiness.json']),
    engineering_readiness: engineering, data_readiness: data, metric_readiness: metric,
    global_readiness: 'EXPLORATORY', reasons: [...new Set(globalReasons)].sort(compare),
    evaluation_linkage: linkage, metric_usage: 'PROXY_EXPLORATORY',
    parameter_readiness: paired.parameterSummary.map(row => ({
      parameter_id: row.parameter_id, wired_status: row.wired_status,
      parameter_readiness: row.parameter_readiness, observability_status: row.observability_status,
      reason_code: row.reason_code, support_samples: row.support_samples,
      support_events: row.support_events, support_dates: row.support_dates,
      metric_usage: row.metric_usage
    })),
    warnings: warningRows.map(row => row.warning_code)
  };
  files['readiness.json'] = canonicalJson(readiness);
  const summary = {
    ...parse(files['reports/summary.json']),
    sensitivity_id: null,
    engineering_readiness: engineering, data_readiness: data, metric_readiness: metric,
    global_readiness: 'EXPLORATORY', result_usage: 'EXPLORATORY_ONLY',
    mapping_status: linkage.mapping_status, interpretation_scope: linkage.interpretation_scope,
    no_skill_reference_ordinal: linkage.no_skill_reference_ordinal,
    validation_disclosure_status: linkage.validation_disclosure_status,
    control_alignment: alignmentSummary(alignment),
    warnings_summary: warningCounts,
    parameter_summary: paired.parameterSummary.map(row => ({
      parameter_id: row.parameter_id, parameter_readiness: row.parameter_readiness,
      observability_status: row.observability_status, metric_usage: row.metric_usage,
      best_delta_mae: row.best_delta_mae, reason_code: row.reason_code
    })),
    ablation_summary: paired.ablations.map(row => ({
      ablation: row.ablation, control_mae: row.control_mae, experiment_mae: row.experiment_mae,
      paired_no_skill_mae: row.paired_no_skill_mae,
      control_mae_gap_to_no_skill: row.control_mae_gap_to_no_skill,
      experiment_mae_gap_to_no_skill: row.experiment_mae_gap_to_no_skill,
      delta_mae: row.delta_mae
    }))
  };
  files['reports/summary.json'] = canonicalJson(summary);
  files['schema.json'] = canonicalJson(SCHEMA_V2);
  files['policy.json'] = canonicalJson(POLICY_V2);
  const metadataOf = value => {
    const result = {};
    for (const file of FILES_V2) {
      const bytes = Buffer.from(value[file]);
      result[file] = { sha256: hash(bytes), bytes: bytes.length };
      if (CSV_TABLES_V2[file]) result[file].rows = value[file].split('\r\n').length - 2;
    }
    return result;
  };
  const preIdMetadata = metadataOf(files);
  const descriptor = {
    tuning_schema_version: 2, tuning_policy_version: 2,
    source: { ...ctx.source, ...linkage },
    selection: built.manifest.descriptor.selection,
    file_sha256: Object.fromEntries(FILES_V2.filter(file => file !== 'reports/summary.json')
      .map(file => [file, preIdMetadata[file].sha256])),
    summary_template_sha256: preIdMetadata['reports/summary.json'].sha256
  };
  const descriptorSha256 = hash(canonicalJson(descriptor));
  const sensitivityId = `sensitivity_v2_${ctx.source.model_dataset_descriptor_sha256.slice(0, 12)}_${descriptorSha256.slice(0, 12)}`;
  summary.sensitivity_id = sensitivityId;
  files['reports/summary.json'] = canonicalJson(summary);
  const metadata = metadataOf(files);
  const manifest = {
    ...built.manifest, ...linkage,
    tuning_schema_version: 2, tuning_policy_version: 2,
    sensitivity_id: sensitivityId, descriptor_sha256: descriptorSha256, descriptor,
    engineering_readiness: engineering, data_readiness: data, metric_readiness: metric,
    result_usage: 'EXPLORATORY_ONLY', files: metadata,
    schema_sha256: metadata['schema.json'].sha256, policy_sha256: metadata['policy.json'].sha256
  };
  return { ctx, files, manifest, summary, counts: built.counts };
}
