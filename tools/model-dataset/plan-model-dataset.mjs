#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { loadInputs } from './lib/input.mjs';
import { derive, selection } from './lib/core.mjs';
import { runCli } from './lib/cli.mjs';
import { selectedModelPolicyVersion } from './model-dataset-policy.mjs';
export async function planModelDataset(raw, gt, options = {}) {
  const policyVersion = selectedModelPolicyVersion(options.modelPolicyVersion);
  const input = await loadInputs(raw, gt, options.progress);
  return { ...input.source, model_dataset_schema_version: 2, model_dataset_policy_version: policyVersion,
    ...derive(input.events, input.snapshots, input.gt, input.replays, options.selection || selection(), input.inputSummary, 2, options.progress, policyVersion).plan };
}
if (isMain(import.meta.url)) await runCli('plan', o => planModelDataset(o.raw, o.gt, o));
