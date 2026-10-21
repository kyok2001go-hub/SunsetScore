import { canonicalJson, errorCode } from '../../dataset/lib/common.mjs';
import { calculateBoundaries } from './package.mjs';
import { digest } from './common.mjs';
try {
  const args=process.argv.slice(2),options={plan:args[args.indexOf('--plan')+1],sources:args[args.indexOf('--sources')+1],stage:'V2_PREPUBLISH_INDEPENDENT_RECOMPUTE'};
  const {payloads}=await calculateBoundaries(options);
  console.log(canonicalJson({payload_sha256:digest(payloads),scope:'V2_BOUNDARY_MAPPING_TEMPORAL_STATISTICS_ONLY'}));
}catch(error){console.log(canonicalJson({error_code:errorCode(error),reason_code:error.reason_code||null}));process.exitCode=1;}
