import path from 'node:path';
import {isMain,canonicalJson,errorCode,fail} from '../dataset/lib/common.mjs';
import {createProgress} from '../progress.mjs';
import {planProductEvaluation,runProductArtifact,validateProductArtifact,statsProductArtifact,planProductSearch,planProductValidation} from './package.mjs';
export function parseProductArgs(args){
  const command=args.shift(),options={},allowed={plan:['sources','output','policy-version'],run:['sources','plan','output'],validate:['sources','plan','input'],stats:['input'],
    'search-plan':['sources','output','product-plan','product-result'],'search-run':['sources','plan','output'],
    'validation-plan':['sources','output','product-plan','product-result','optimization'],'validation-run':['sources','plan','output']};
  if(!allowed[command])fail('INVALID_ARGUMENTS');const seen=new Set();
  for(let i=0;i<args.length;i++){const flag=args[i];if(flag==='--quiet'&&!seen.has(flag)){seen.add(flag);options.quiet=true;continue;}
    const key=flag.slice(2),value=args[++i];if(!flag.startsWith('--')||seen.has(flag)||!allowed[command].includes(key)||!value||value.startsWith('--'))fail('INVALID_ARGUMENTS');seen.add(flag);
    if(key==='policy-version'){if(value!=='1')fail('UNSUPPORTED_PRODUCT_POLICY');options.policyVersion=1;}
    else options[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=path.resolve(value);}
  if(command!=='stats'&&command!=='validate'&&!options.sources||['run','search-run','validation-run'].includes(command)&&!options.plan||['stats','validate'].includes(command)&&!options.input||['search-plan','validation-plan'].includes(command)&&(!options.productPlan||!options.productResult))fail('INVALID_ARGUMENTS');
  return {command,options};
}
if(isMain(import.meta.url)){let progress;try{const {command,options}=parseProductArgs(process.argv.slice(2));progress=createProgress(options);options.progress=progress;
  const result=await({plan:planProductEvaluation,run:runProductArtifact,validate:validateProductArtifact,stats:statsProductArtifact,'search-plan':planProductSearch,'search-run':runProductArtifact,'validation-plan':planProductValidation,'validation-run':runProductArtifact})[command](options);
  progress.finish(result.status);console.log(canonicalJson(result));
}catch(e){progress?.fail(errorCode(e));console.log(canonicalJson({status:'FAIL',error_code:errorCode(e),reason_code:e.reason_code||null}));process.exitCode=1;}}
