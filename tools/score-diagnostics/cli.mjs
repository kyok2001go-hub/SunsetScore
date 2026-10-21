import path from 'node:path';
import { canonicalJson,errorCode,fail,isMain } from '../dataset/lib/common.mjs';
import { createProgress } from '../progress.mjs';
import { planScoreDiagnostics,runScoreDiagnostics,validateScoreDiagnostics,statsScoreDiagnostics } from './package.mjs';
export function parseScoreArgs(args) {
  const command=args.shift(),options={};
  const allowed={plan:['sources','output','parent','diagnostic-version'],run:['sources','plan','output'],validate:['sources','plan','input'],stats:['input']};
  if(!allowed[command])fail('INVALID_ARGUMENTS');
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--quiet'&&!options.quiet){options.quiet=true;continue;}
    const key=args[i].slice(2),value=args[++i];
    if(!args[i-1].startsWith('--')||!allowed[command].includes(key)||options[key]||!value||value.startsWith('--'))fail('INVALID_ARGUMENTS');
    if (key === 'diagnostic-version') {
      if (!['1','2'].includes(value) || options.diagnosticVersion) fail('INVALID_ARGUMENTS');
      options.diagnosticVersion=Number(value);
    } else options[key]=path.resolve(value);
  }
  if(['plan','run'].includes(command)&&!options.sources||command==='run'&&!options.plan||['validate','stats'].includes(command)&&!options.input||options.plan&&!options.sources)fail('INVALID_ARGUMENTS');
  if(command==='plan'&&((options.diagnosticVersion===2&&!options.parent)||(options.parent&&options.diagnosticVersion!==2)))fail('INVALID_ARGUMENTS');
  return {command,options};
}
if(isMain(import.meta.url)) {
  let progress;try {const {command,options}=parseScoreArgs(process.argv.slice(2));progress=createProgress(options);options.progress=progress;
    const result=await({plan:planScoreDiagnostics,run:runScoreDiagnostics,validate:validateScoreDiagnostics,stats:statsScoreDiagnostics})[command](options);
    progress.finish(result.status);console.log(canonicalJson(result));
  }catch(error){progress?.fail(errorCode(error));console.log(canonicalJson({status:'FAIL',error_code:errorCode(error),reason_code:error.reason_code||null}));process.exitCode=1;}
}
