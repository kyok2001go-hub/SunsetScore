#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { loadInputs } from './lib/input.mjs';
import { derive, selection } from './lib/core.mjs';
import { runCli } from './lib/cli.mjs';
export async function planModelDataset(raw, gt, options = {}) {
  const input = await loadInputs(raw, gt, options.progress);
  return { ...input.source, ...derive(input.events, input.snapshots, input.gt, input.replays, options.selection || selection(), input.inputSummary, 2, options.progress, 3).plan };
}
if (isMain(import.meta.url)) await runCli('plan', o => planModelDataset(o.raw, o.gt, o));
