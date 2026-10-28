import { assertCompatibleEngine } from './engine-compatibility.mjs';
import { readSafe, canonicalJson, errorCode, fail, isMain } from '../dataset/lib/common.mjs';
import { codeIdentity, loadPool, checkInputs } from './data.mjs';
import { replayCalculator, preflight, evaluateWeights } from './compute.mjs';
import { digest, installWeights, POLICY, RECOGNITION_POLICY } from './policy.mjs';
export async function verifyRequest(request, { compatibleV1Tools = false, compatibleTools = false } = {}) {
  if (request.spec.practical_tuning_schema_version === 12 && request.spec.practical_tuning_policy_version === 12) return (await import('./gw-split-workflow.mjs')).verifyGwRequest(request);
  if (request.spec.practical_tuning_schema_version === 11 && request.spec.practical_tuning_policy_version === 11) return (await import('./aod-shape-workflow.mjs')).verifyAodRequest(request);
  if (request.spec.practical_tuning_schema_version === 10 && request.spec.practical_tuning_policy_version === 10) return (await import('./horizon-fix-workflow.mjs')).verifyHorizonFixRequest(request);
  if (request.spec.practical_tuning_schema_version === 9 && request.spec.practical_tuning_policy_version === 9) return (await import('./p0-workflow.mjs')).verifyP0Request(request);
  if (request.spec.practical_tuning_schema_version === 6 && request.spec.practical_tuning_policy_version === 6) return (await import('./illumination-workflow.mjs')).verifyIlluminationRequest(request, { compatibleTools });
  if (request.spec.practical_tuning_schema_version === 5 && request.spec.practical_tuning_policy_version === 5) return (await import('./sky-branch-workflow.mjs')).verifySkyRequest(request, { compatibleTools });
  if (request.spec.practical_tuning_schema_version === 4 && request.spec.practical_tuning_policy_version === 4)
    return (await import('./mechanism-workflow.mjs')).verifyMechanismRequest(request, { compatibleTools });
  if (request.spec.practical_tuning_schema_version === 3 && request.spec.practical_tuning_policy_version === 3)
    return (await import('./mid-cloud-workflow.mjs')).verifyMidCloudRequest(request, { compatibleTools });
  if (request.spec.practical_tuning_schema_version === 2 && request.spec.practical_tuning_policy_version === 2)
    return (await import('./high-cloud-workflow.mjs')).verifyHighCloudRequest(request, { compatibleTools });
  const { spec } = request, code = await codeIdentity();
  if (spec.practical_tuning_schema_version !== 1 || spec.practical_tuning_policy_version !== 1 ||
      (!compatibleV1Tools && code.sha256 !== spec.code.sha256) || code.node_version !== spec.code.node_version) fail('PRACTICAL_CODE_MISMATCH');
  const engineCompatibility = assertCompatibleEngine(code, spec.code, { allowDefaultCompatibility: compatibleV1Tools });
  if (compatibleV1Tools && (digest(spec.identity.policy) !== digest(POLICY) ||
      (spec.identity.recognition_policy && digest(spec.identity.recognition_policy) !== digest(RECOGNITION_POLICY)))) fail('PRACTICAL_POLICY_MISMATCH');
  const loaded = await loadPool(spec.sources), calculator = replayCalculator(code.engine_sha256);
  if (digest(loaded.fingerprints) !== digest(spec.identity.inputs)) fail('PRACTICAL_INPUT_MISMATCH');
  const checked = await preflight(loaded, spec.control_config, calculator);
  if (digest(checked.included) !== digest(request.pool.included) || digest(checked.exclusions) !== digest(request.exclusions)) fail('PRACTICAL_COHORT_MISMATCH');
  if (digest(installWeights(spec.control_config, request.selected.weights)) !== digest(request.selected_effective_config)) fail('NON_WEIGHT_CONFIG_CHANGED');
  const control = await evaluateWeights(checked.rows, spec.control_config, spec.control_config.weights, calculator);
  const selected = await evaluateWeights(checked.rows, spec.control_config, request.selected.weights, calculator);
  for (const [actual, expected, scores] of [[control, request.control, request.control_predictions], [selected, request.selected, request.selected_predictions]]) {
    if (digest(actual.scores) !== digest(scores) || actual.predictions_sha256 !== expected.predictions_sha256 || digest(actual.metrics) !== digest(expected.metrics)) fail('FINAL_RECOMPUTE_MISMATCH');
  }
  await checkInputs(loaded); if ((await codeIdentity()).sha256 !== code.sha256) fail('CODE_CHANGED_DURING_RUN');
  return { status: 'PASS', engine_compatibility: engineCompatibility, scope: 'FRESH_PROCESS_CONTROL_AND_SELECTED_ONLY', engine_replayed: true,
    recomputed_snapshots: checked.rows.length, control_predictions_sha256: control.predictions_sha256,
    selected_predictions_sha256: selected.predictions_sha256, per_sample_score_and_ordinal_equal: true, metrics_equal: true,
    ...(code.sha256 !== spec.code.sha256 ? { tool_compatibility: engineCompatibility.mode === 'IDENTICAL_ENGINE' ? 'CURRENT_POLICY1_TOOLS_SAME_ENGINE_EXACT_OLD_PREDICTIONS_AND_METRICS' : 'CURRENT_POLICY1_PINNED_DEFAULT_COMPATIBLE_ENGINE_EXACT_OLD_PREDICTIONS_AND_METRICS',
      original_tool_sha256: spec.code.sha256, current_tool_sha256: code.sha256 } : {}) };
}
if (isMain(import.meta.url)) {
  try { console.log(canonicalJson(await verifyRequest(JSON.parse(await readSafe(process.argv[2])), { compatibleV1Tools: process.argv[3] === '--compatible-v1-tools', compatibleTools: process.argv[3] === '--compatible-cloud-tools' }))); }
  catch (e) { console.log(canonicalJson({ status: 'FAIL', error_code: errorCode(e) })); process.exitCode = 1; }
}
