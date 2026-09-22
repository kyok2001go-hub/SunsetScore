import { errorCode } from '../../dataset/lib/common.mjs';
import { silentProgress } from '../../progress.mjs';

/**
 * Package-internal re-validation for `--verify`. Loaded lazily so the plain lineage listing
 * stays a manifest-only scan and never pulls the Replay runtime into the process.
 */
const VALIDATORS = Object.freeze({
  raw: async () => (await import('../../dataset/validate-dataset.mjs')).validateDataset,
  ground_truth: async () => (await import('../../ground-truth/validate-ground-truth.mjs')).inspectGroundTruth,
  model: async () => (await import('../../model-dataset/validate-model-dataset.mjs')).inspectModelDataset,
  evaluation: async () => (await import('../../evaluation/validate-evaluation.mjs')).inspectEvaluation,
  sensitivity: async () => (await import('../../tuning/validate-sensitivity.mjs')).inspectSensitivity,
  optimization: async () => (await import('../../optimization/validate-optimization.mjs')).inspectOptimization
});

export async function verifyPackages(nodes, options = {}) {
  const progress = options.progress || silentProgress;
  const results = [];
  const cache = new Map();
  for (const node of nodes) {
    progress.stage(`包内校验 ${node.id}`);
    const validator = cache.get(node.phase_key) ||
      await VALIDATORS[node.phase_key]().then(loaded => { cache.set(node.phase_key, loaded); return loaded; });
    if (node.status !== 'OK' || !node.absolute_path) {
      results.push({ id: node.id, phase: node.phase, status: 'SKIPPED', error_code: null });
      continue;
    }
    try {
      const result = await validator(node.absolute_path);
      results.push({
        id: node.id, phase: node.phase,
        status: result?.status ?? 'PASS',
        validation_scope: result?.validation_scope ?? 'PACKAGE_INTERNAL',
        error_code: null
      });
    } catch (error) {
      results.push({ id: node.id, phase: node.phase, status: 'FAIL', validation_scope: null, error_code: errorCode(error) });
    }
  }
  return results;
}
