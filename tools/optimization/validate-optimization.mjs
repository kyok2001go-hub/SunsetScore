#!/usr/bin/env node
import path from 'node:path';
import { canonicalJson, compare, errorCode, fail, hash, inventory, isMain, readSafe } from '../dataset/lib/common.mjs';
import { readCsv } from '../dataset/lib/csv.mjs';
import { CSV_TABLES, FILES, FREEZE_FILE, MANIFEST_FILE, SCHEMA, optimizationSchema } from './optimization-schema.mjs';
import { guardrailPolicyDocument, objectivePolicyDocument, optimizationPolicy } from './optimization-policy.mjs';
import { identity } from './lib/package.mjs';
import { runCli } from './lib/cli.mjs';
import {
  buildOptimizationPackage, candidateSetIdentity, optimizationInputIdentity, searchResultIdentity
} from './lib/build.mjs';
import { buildFreezeDocument, compareRecords } from './lib/finalist.mjs';

export const parseJson = bytes => {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!Buffer.from(canonicalJson(value)).equals(bytes)) {
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'JSON_NOT_CANONICAL' });
  }
  return value;
};

function requireKeys(value, keys, label) {
  for (const key of keys) {
    if (!(key in (value || {}))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'MISSING_FIELD', detail: `${label}.${key}` });
    }
  }
}

export async function inspectOptimization(directory, options = {}) {
  try {
    const policy = optimizationPolicy();
    const manifest = parseJson(await readSafe(path.join(directory, MANIFEST_FILE)));
    requireKeys(manifest, SCHEMA.json.manifest.required, 'manifest');
    if (manifest.optimization_schema_version !== policy.optimization_schema_version ||
        manifest.optimization_policy_version !== policy.optimization_policy_version) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_OPTIMIZATION_VERSION' });
    }
    const freezePresent = Boolean(manifest.candidate_freeze_allowed);
    const expected = [...FILES, MANIFEST_FILE, ...(freezePresent ? [FREEZE_FILE] : [])].sort(compare);
    const actual = (await inventory(directory)).sort(compare);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'INVENTORY_MISMATCH' });
    }
    const declaredFiles = Object.keys(manifest.files || {}).sort(compare);
    if (canonicalJson(declaredFiles) !== canonicalJson(expected.filter(file => file !== MANIFEST_FILE).sort(compare))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'MANIFEST_FILES_MISMATCH' });
    }
    const loaded = {};
    for (const file of expected.filter(file => file !== MANIFEST_FILE)) {
      const bytes = await readSafe(path.join(directory, file));
      const entry = manifest.files[file];
      if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FILE_HASH', detail: file });
      }
      loaded[file] = bytes;
    }
    if (canonicalJson(parseJson(loaded['schema.json'])) !== canonicalJson(optimizationSchema())) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SCHEMA_MISMATCH' });
    }
    if (canonicalJson(parseJson(loaded['policy.json'])) !== canonicalJson(policy)) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'POLICY_MISMATCH' });
    }
    const tables = {};
    for (const [file, fields] of Object.entries(CSV_TABLES)) {
      tables[file] = readCsv(fields, loaded[file]);
      if (manifest.files[file].rows !== tables[file].length) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'CSV_ROWS_MISMATCH', detail: file });
      }
    }
    const searchSpace = parseJson(loaded['search_space.json']);
    const readiness = parseJson(loaded['readiness.json']);
    const summary = parseJson(loaded['reports/summary.json']);
    const searchPoints = parseJson(loaded['search_points.json']);
    const finalists = parseJson(loaded['finalists.json']);
    const verifiedSources = parseJson(loaded['verified_source_identities.json']);
    requireKeys(readiness, SCHEMA.json.readiness.required, 'readiness');
    requireKeys(summary, SCHEMA.json.summary.required, 'summary');

    if (manifest.search_space_sha256 !== hash(canonicalJson(searchSpace))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SEARCH_SPACE_SHA_MISMATCH' });
    }
    if (manifest.descriptor.search_space_sha256 !== manifest.search_space_sha256) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_SEARCH_SPACE_MISMATCH' });
    }
    if (manifest.descriptor.objective_policy_sha256 !== hash(canonicalJson(parseJson(loaded['objective_policy.json'])))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'OBJECTIVE_POLICY_SHA_MISMATCH' });
    }
    if (manifest.descriptor.objective_policy_sha256 !== hash(canonicalJson(objectivePolicyDocument()))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'OBJECTIVE_POLICY_CONTRACT_MISMATCH' });
    }
    const guardrailPolicySha256 = hash(canonicalJson(parseJson(loaded['guardrail_policy.json'])));
    if (guardrailPolicySha256 !== hash(canonicalJson(guardrailPolicyDocument()))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'GUARDRAIL_POLICY_SHA_MISMATCH' });
    }
    const descriptorFileNames = Object.keys(manifest.descriptor.file_sha256 || {}).sort(compare);
    const expectedDescriptorFileNames = expected
      .filter(file => file !== MANIFEST_FILE && file !== 'reports/summary.json').sort(compare);
    if (canonicalJson(descriptorFileNames) !== canonicalJson(expectedDescriptorFileNames)) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_FILES_MISMATCH' });
    }
    for (const [file, digest] of Object.entries(manifest.descriptor.file_sha256 || {})) {
      if (manifest.files[file]?.sha256 !== digest) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_FILE_SHA_MISMATCH', detail: file });
      }
    }
    if (manifest.descriptor.summary_template_sha256 === null) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SUMMARY_TEMPLATE_MISSING' });
    }
    if (hash(canonicalJson(manifest.descriptor)) !== manifest.descriptor_sha256) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_SHA_MISMATCH' });
    }
    const derived = identity(manifest.descriptor);
    if (derived.descriptor_sha256 !== manifest.descriptor_sha256 || derived.optimization_id !== manifest.optimization_id) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DESCRIPTOR_ID_MISMATCH' });
    }
    if (!options.staging && path.basename(path.resolve(directory)) !== manifest.optimization_id) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DIRECTORY_ID_MISMATCH' });
    }
    if (manifest.evaluated_splits.length !== 1 || manifest.evaluated_splits[0] !== 'TRAIN' ||
        manifest.validation_evaluated !== false || manifest.test_evaluated !== false ||
        manifest.computation_access_policy !== 'TRAIN_ONLY') {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'HOLDOUT_CONTRACT' });
    }
    const expectedOptimizationInputId = `optimization_input_${hash(canonicalJson(optimizationInputIdentity({
      source: verifiedSources.identities,
      searchSpaceSha256: manifest.search_space_sha256,
      policy
    }))).slice(0, 16)}`;
    if (manifest.optimization_input_id !== expectedOptimizationInputId ||
        searchPoints.optimization_input_id !== expectedOptimizationInputId) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'OPTIMIZATION_INPUT_ID_MISMATCH' });
    }

    const metricIds = tables['candidate_metrics.csv'].map(row => row.candidate_id);
    if (new Set(metricIds).size !== metricIds.length) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DUPLICATE_CANDIDATE_METRIC' });
    }
    const metricSet = new Set(metricIds);
    if (manifest.candidate_count !== metricIds.length) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'CANDIDATE_COUNT_MISMATCH' });
    }
    const feasibleIds = new Set(tables['candidate_metrics.csv']
      .filter(row => row.status === 'FEASIBLE').map(row => row.candidate_id));
    if (manifest.feasible_candidate_count !== feasibleIds.size) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FEASIBLE_COUNT_MISMATCH' });
    }
    const leaderboardIds = tables['leaderboard.csv'].map(row => row.candidate_id);
    if (canonicalJson([...leaderboardIds].sort(compare)) !== canonicalJson([...feasibleIds].sort(compare))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'LEADERBOARD_MISMATCH' });
    }
    for (let index = 0; index < tables['leaderboard.csv'].length; index++) {
      if (tables['leaderboard.csv'][index].rank !== index + 1) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'LEADERBOARD_RANK_MISMATCH' });
      }
    }
    const asRecord = row => ({
      status: row.status,
      promotable: row.promotable,
      candidate: {
        candidate_id: row.candidate_id,
        changed_unit_count: row.changed_unit_count,
        normalized_parameter_distance: row.normalized_parameter_distance
      },
      metrics: {
        mae: row.candidate_mae,
        severe_error_rate: row.severe_error_rate,
        within_1_accuracy: row.within_1_accuracy,
        bias: row.abs_bias,
        qwk: row.qwk
      }
    });
    const expectedLeaderboardIds = [...tables['leaderboard.csv']].map(asRecord)
      .sort((left, right) => compareRecords(left, right, policy.numeric.metric_compare_epsilon))
      .map(record => record.candidate.candidate_id);
    if (canonicalJson(leaderboardIds) !== canonicalJson(expectedLeaderboardIds)) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'LEADERBOARD_SORT_MISMATCH' });
    }
    for (const row of tables['candidate_guardrails.csv']) {
      if (!metricSet.has(row.candidate_id)) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'GUARDRAIL_CANDIDATE_UNKNOWN', detail: row.candidate_id });
      }
    }
    for (const row of tables['candidate_date_stability.csv']) {
      if (!metricSet.has(row.candidate_id)) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'DATE_CANDIDATE_UNKNOWN', detail: row.candidate_id });
      }
    }
    for (const row of tables['candidate_slice_regressions.csv']) {
      if (!metricSet.has(row.candidate_id)) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SLICE_CANDIDATE_UNKNOWN', detail: row.candidate_id });
      }
    }
    const pointIds = new Set((searchPoints.points || []).map(point => point.candidate_id));
    if (canonicalJson([...pointIds].sort(compare)) !== canonicalJson([...metricSet].sort(compare))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SEARCH_POINT_MISMATCH' });
    }
    const finalistIds = finalists.finalists.map(item => item.candidate_id);
    for (const candidateId of finalistIds) {
      const metric = tables['candidate_metrics.csv'].find(row => row.candidate_id === candidateId);
      const valid = manifest.optimization_mode === 'FORMAL_OPTIMIZATION'
        ? metric?.promotable === true
        : metric?.status === 'FEASIBLE';
      if (!valid) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FINALIST_NOT_PROMOTABLE', detail: candidateId });
      }
    }
    if (finalists.finalist_count !== finalistIds.length) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FINALIST_COUNT_MISMATCH' });
    }
    const expectedFinalistIds = tables['leaderboard.csv']
      .filter(row => manifest.optimization_mode === 'FORMAL_OPTIMIZATION' ? row.promotable === true : true)
      .slice(0, policy.finalist_count_max)
      .map(row => row.candidate_id);
    if (canonicalJson(finalistIds) !== canonicalJson(expectedFinalistIds)) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FINALIST_TOP_K_MISMATCH' });
    }

    const metricsById = new Map(tables['candidate_metrics.csv'].map(row => [row.candidate_id, row]));
    const orderedResultRows = tables['candidate_trace.csv']
      .filter(row => row.candidate_id && (row.outcome === 'ACCEPTED' || row.outcome === 'UNEVALUABLE'))
      .map(row => metricsById.get(row.candidate_id));
    if (orderedResultRows.some(row => !row) || orderedResultRows.length !== metricIds.length) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SEARCH_RESULT_TRACE_MISMATCH' });
    }
    const expectedSearchResultId = searchResultIdentity({
      optimizationInputId: expectedOptimizationInputId,
      records: orderedResultRows.map(row => ({
        candidate: { candidate_id: row.candidate_id }, status: row.status,
        promotable: row.promotable, metrics: row.candidate_mae === null ? null : {
          mae: row.candidate_mae, severe_error_rate: row.candidate_severe_error_rate
        }
      }))
    });
    const expectedCandidateSetId = candidateSetIdentity({
      searchResultId: expectedSearchResultId, finalistIds
    });
    if (manifest.search_result_id !== expectedSearchResultId || manifest.candidate_set_id !== expectedCandidateSetId ||
        summary.search_result_id !== expectedSearchResultId || summary.candidate_set_id !== expectedCandidateSetId) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'RESULT_IDENTITY_MISMATCH' });
    }
    if (freezePresent) {
      const freeze = parseJson(loaded[FREEZE_FILE]);
      if (canonicalJson(freeze.candidate_ids) !== canonicalJson(finalistIds)) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FREEZE_CANDIDATE_MISMATCH' });
      }
      if (manifest.optimization_mode !== 'FORMAL_OPTIMIZATION') {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'EXPLORATORY_FREEZE_FORBIDDEN' });
      }
      if (!finalistIds.length) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FREEZE_WITHOUT_FINALIST' });
      }
      const expectedFreeze = buildFreezeDocument({
        optimizationInputId: expectedOptimizationInputId,
        searchResultId: expectedSearchResultId,
        candidateSetId: expectedCandidateSetId,
        finalists: finalists.finalists.map(item => ({
          candidate: {
            candidate_id: item.candidate_id,
            canonical_vector: item.canonical_vector,
            effective_config_sha256: item.effective_config_sha256,
            changed_unit_count: item.changed_unit_count,
            normalized_parameter_distance: item.normalized_parameter_distance
          },
          metrics: item.train_metrics,
          deltas: item.train_deltas
        })),
        source: verifiedSources.identities,
        searchSpace,
        searchSpaceSha256: manifest.search_space_sha256
      });
      if (canonicalJson(freeze) !== canonicalJson(expectedFreeze)) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FREEZE_CONTRACT_MISMATCH' });
      }
    } else {
      if (manifest.optimization_mode === 'EXPLORATORY_SEARCH' && manifest.finalist_count > 0 &&
          finalists.usage !== 'EXPLORATORY_ONLY') {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'EXPLORATORY_FINALIST_USAGE' });
      }
      if (manifest.candidate_freeze_allowed !== false) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'FREEZE_ALLOWED_WITHOUT_FILE' });
      }
    }
    if (manifest.finalist_count !== finalistIds.length ||
        summary.finalist_count !== finalistIds.length ||
        summary.optimization_outcome !== manifest.optimization_outcome ||
        summary.candidate_freeze_allowed !== manifest.candidate_freeze_allowed) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SUMMARY_MANIFEST_MISMATCH' });
    }
    const exploratory = manifest.optimization_mode === 'EXPLORATORY_SEARCH';
    const expectedOutcome = exploratory
      ? (finalistIds.length ? 'EXPLORATORY_POINTS_GENERATED' : 'NO_EXPLORATORY_POINT')
      : (finalistIds.length ? 'CANDIDATES_PROMOTED' : 'NO_PROMOTABLE_CANDIDATE');
    if (manifest.optimization_outcome !== expectedOutcome ||
        finalists.optimization_outcome !== expectedOutcome) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'OPTIMIZATION_OUTCOME_MISMATCH' });
    }
    if (exploratory && (manifest.candidate_freeze_allowed !== false ||
        manifest.validation_promotion_allowed !== false || finalists.usage !== 'EXPLORATORY_ONLY' ||
        tables['candidate_metrics.csv'].some(row => row.promotable === true))) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'EXPLORATORY_PROMOTION_FORBIDDEN' });
    }
    if (summary.optimization_id !== manifest.optimization_id) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'SUMMARY_ID_MISMATCH' });
    }
    if (readiness.optimization_mode !== manifest.optimization_mode) {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'READINESS_MODE_MISMATCH' });
    }
    if (manifest.candidate_freeze_allowed && manifest.result_usage !== 'FORMAL') {
      fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'RESULT_USAGE_MISMATCH' });
    }

    if (options.model && options.raw && options.gt && options.baseline && options.sensitivity) {
      const rebuilt = await buildOptimizationPackage({
        model: options.model, raw: options.raw, gt: options.gt,
        baseline: options.baseline, sensitivity: options.sensitivity,
        progress: options.progress
      });
      for (const file of expected.filter(name => name !== MANIFEST_FILE)) {
        if (!loaded[file].equals(Buffer.from(rebuilt.files[file]))) {
          fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'RECOMPUTED_FILE_MISMATCH', detail: file });
        }
      }
      if (canonicalJson(manifest) !== canonicalJson(rebuilt.manifest)) {
        fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: 'MANIFEST_MISMATCH' });
      }
    }

    return {
      status: 'PASS',
      validation_scope: options.model ? 'SOURCE_LINKED_RECOMPUTED' : 'PACKAGE_INTERNAL',
      optimization_id: manifest.optimization_id,
      optimization_mode: manifest.optimization_mode,
      optimization_outcome: manifest.optimization_outcome,
      candidate_freeze_allowed: manifest.candidate_freeze_allowed,
      manifest,
      summary
    };
  } catch (error) {
    if (['UNSAFE_PATH', 'UNSUPPORTED_OPTIMIZATION_SCHEMA', 'UNSUPPORTED_OPTIMIZATION_POLICY', 'INVALID_ARGUMENTS',
      'OPTIMIZATION_VALIDATION_FAILED'].includes(errorCode(error))) throw error;
    fail('OPTIMIZATION_VALIDATION_FAILED', { reason_code: errorCode(error) });
  }
}

if (isMain(import.meta.url)) await runCli('validate', options => inspectOptimization(options.path, options));
