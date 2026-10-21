import {canonicalJson,fail,errorCode} from '../dataset/lib/common.mjs';
import {calculateProduct} from './package.mjs';
import {digest} from './policy.mjs';
try{
  const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--plan'||args[2]!=='--sources')fail('INVALID_ARGUMENTS');
  const result=await calculateProduct({plan:args[1],sources:args[3],stage:'PRODUCT_PREPUBLISH_INDEPENDENT_RECOMPUTE'});
  console.log(canonicalJson({payload_sha256:digest(result.payloads),scope:result.kind==='product_evaluation'?'FROZEN_PREDICTION_RESUMMARIZATION_NO_REPLAY':'FULL_PRODUCT_REPLAY_AND_STATISTICS'}));
}catch(error){console.log(canonicalJson({status:'FAIL',error_code:errorCode(error),reason_code:error.reason_code||null}));process.exitCode=1;}
