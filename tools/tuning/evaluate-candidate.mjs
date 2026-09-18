#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fail, isMain, safePath } from '../dataset/lib/common.mjs';
import { UNITS } from './parameter-registry.mjs';
import { candidatePolicy } from './candidate-policy.mjs';
import { loadFrozenBaseConfig } from './lib/base-config.mjs';
import { evaluateCandidates, prepareCandidateRun } from './lib/candidate.mjs';
import { loadCandidateCohort, verifyUpstreamSources } from './lib/input.mjs';
import { runReplay } from '../replay/replay-runner.mjs';
import { runCli } from './lib/cli.mjs';

/**
 * Reads the candidate file. Accepted shapes: a bare array of vectors, a bare array of
 * `{ label, vector }` entries, or `{ candidates: [...] }` around either form.
 */
async function readCandidates(file) {
  const path = await safePath(file);
  let parsed;
  try {
    parsed = JSON.parse((await readFile(path)).toString('utf8'));
  } catch {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'CANDIDATE_FILE_UNREADABLE' });
  }
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.candidates;
  if (!Array.isArray(list) || !list.length) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'CANDIDATE_LIST_EMPTY' });
  }
  const vectors = [];
  const labels = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'vector' in entry) {
      vectors.push(entry.vector);
      labels.push(entry.label ?? null);
      continue;
    }
    vectors.push(entry);
    labels.push(null);
  }
  return { vectors, labels };
}

export async function evaluateCandidateFile(options) {
  const split = options.split || candidatePolicy().default_split;
  const policy = candidatePolicy();
  if (!policy.allowed_splits.includes(split) || policy.forbidden_splits.includes(split)) {
    fail('TUNING_VALIDATION_FAILED', { reason_code: 'UNSUPPORTED_SPLIT', detail: split });
  }
  const cohortInput = await loadCandidateCohort({
    modelDir: options.model, rawDir: options.raw, split, progress: options.progress
  });
  const { vectors, labels } = await readCandidates(options.candidates);
  const loaded = await loadFrozenBaseConfig();
  const prepared = await prepareCandidateRun({
    cohort: cohortInput.cohort, config: loaded.config, units: UNITS, runReplay,
    progress: options.progress, policy
  });
  const evaluated = await evaluateCandidates({ prepared, vectors, labels });

  // Phase A source linkage stays available, but only when the caller offers the Ground Truth
  // directory; reading the candidate cohort itself never widens the Model allowlist.
  const upstream = options.gt ? await verifyUpstreamSources(options.model, options.raw, options.gt, options.progress) : null;
  const counts = evaluated.results.reduce((accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] || 0) + 1;
    return accumulator;
  }, {});
  const best = evaluated.results.find(result => result.status === 'FEASIBLE') || null;
  return {
    status: 'EVALUATED',
    candidate_policy_version: evaluated.candidate_policy_version,
    split,
    model_dataset_id: cohortInput.manifest.model_dataset_id,
    cohort_sample_count: evaluated.cohort_sample_count,
    control_failure_count: evaluated.control_failure_count,
    control_metrics: evaluated.control_metrics,
    upstream: upstream,
    evaluated_count: evaluated.results.length,
    status_counts: counts,
    best_candidate_id: best ? best.candidate_id : null,
    best_objective_value: best ? best.objective_value : null,
    results: evaluated.results
  };
}

if (isMain(import.meta.url)) await runCli('candidate', evaluateCandidateFile);
