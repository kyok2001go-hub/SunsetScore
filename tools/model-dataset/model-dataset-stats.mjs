#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { inspectModelDataset } from './validate-model-dataset.mjs';
import { runCli } from './lib/cli.mjs';
export async function modelDatasetStats(directory) { return (await inspectModelDataset(directory)).statistics; }
if (isMain(import.meta.url)) await runCli('stats', o => modelDatasetStats(o.path));
