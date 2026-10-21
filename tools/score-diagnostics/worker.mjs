import { canonicalJson,errorCode } from '../dataset/lib/common.mjs';
import { digest } from '../optimization-diagnostics/engine.mjs';
import { calculateScoreDiagnostics } from './package.mjs';
try {const args=process.argv.slice(2),options={plan:args[args.indexOf('--plan')+1],sources:args[args.indexOf('--sources')+1],stage:'PREPUBLISH_INDEPENDENT_RECOMPUTE'};
  const result=await calculateScoreDiagnostics(options);console.log(canonicalJson({payload_sha256:digest(result.payloads)}));
}catch(error){console.log(canonicalJson({error_code:errorCode(error),reason_code:error.reason_code||null}));process.exitCode=1;}
