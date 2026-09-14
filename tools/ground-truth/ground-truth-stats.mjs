#!/usr/bin/env node
import { isMain } from '../dataset/lib/common.mjs';
import { inspectGroundTruth } from './validate-ground-truth.mjs';
import { cli, parseArgs } from './lib/cli.mjs';
export async function groundTruthStats(directory) { return (await inspectGroundTruth(directory)).statistics; }
if (isMain(import.meta.url)) await cli('stats', async args => {
  const options = parseArgs(args, 'stats');
  return { options, data: await groundTruthStats(options.path) };
});
