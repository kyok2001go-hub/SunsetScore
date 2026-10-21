import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, errorCode } from '../dataset/lib/common.mjs';
import { readScoreSources } from './sources.mjs';
import { verifyBundle } from '../experiment-runtime/lib/bundle.mjs';
import { loadOptimizationInput } from '../optimization/lib/input.mjs';
import { buildModelConfig, cloneConfig } from '../tuning/lib/base-config.mjs';
try {
  const paths=await readScoreSources(process.argv[3]);
  const runtime=await verifyBundle(paths.sourceRuntime,{requireEnvironment:true});
  const input=await loadOptimizationInput({...paths,root:runtime.source,optimizationPolicyVersion:4});
  const {runReplay}=await import(pathToFileURL(path.join(runtime.source,'tools/replay/replay-runner.mjs')).href);
  const config=buildModelConfig(cloneConfig(input.sensitivity.baseConfig.config)),rows=[];
  for(const row of input.cohort) {
    try {const ref=await runReplay(row.replay,{reference:row,engineRoot:runtime.source});
      const control=await runReplay(row.replay,{modelConfig:config,engineRoot:runtime.source});
      rows.push({snapshot_id:row.snapshot_id,reference_pass:ref.pass===true,actual:control.actual});}
    catch(error){rows.push({snapshot_id:row.snapshot_id,reference_pass:false,error_code:errorCode(error)});}
  }
  console.log(canonicalJson(rows));
}catch(error){console.log(canonicalJson({error_code:errorCode(error)}));process.exitCode=1;}
