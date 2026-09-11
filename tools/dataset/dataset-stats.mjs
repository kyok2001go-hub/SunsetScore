#!/usr/bin/env node
import { validateDataset } from './validate-dataset.mjs';
import { canonicalJson, errorCode, fail, isMain, parseReadArgs, reportOutside } from './lib/common.mjs';
export { datasetStatistics } from './lib/statistics.mjs';
export async function datasetStats(directory) {
  const result = await validateDataset(directory);
  if (result.report.status !== 'PASS') fail('DATASET_VALIDATION_FAILED');
  return result.statistics;
}
if (isMain(import.meta.url)) {
  try {
    const options = parseReadArgs(process.argv.slice(2)), report = await datasetStats(options.dataset);
    if (options.reportDir) await reportOutside(options.dataset, options.reportDir, 'statistics.json', report);
    console.log(canonicalJson(report));
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
}
