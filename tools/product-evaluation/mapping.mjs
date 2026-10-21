import path from 'node:path';
import vm from 'node:vm';
import {readSafe,hash} from '../dataset/lib/common.mjs';
import {RATING_LABELS} from '../../server/event-dataset.js';
import {LABELS} from '../ground-truth/ground-truth-policy.mjs';
import {LABEL_TO_ORDINAL,scoreToOrdinal} from '../evaluation/metrics.mjs';
import {PRODUCT_LABELS,PRODUCT_NAMES,digest} from './policy.mjs';
const FILES=['server/event-dataset.js','js/observation_service.js','admin/backfill.html','index.html','js/config.js','js/model_config.js','js/engine.js','js/ui.js',
  'tools/ground-truth/ground-truth-policy.mjs','tools/evaluation/metrics.mjs','tools/replay/replay-runner.mjs','tools/product-evaluation/policy.mjs'];
export async function mappingAudit(root){
  const texts={};for(const file of FILES)texts[file]=(await readSafe(path.join(root,file))).toString('utf8');
  const sandbox={};vm.runInNewContext(texts['js/config.js'],sandbox,{timeout:1000});
  const levels=sandbox.SunsetScore.config.levels,rows=[];
  const add=(file,field,mapping,pass,evidence)=>rows.push({path:file,original_field:field,version:'V2548_MAPPING_AUDIT_1',mapping,status:pass?'PASS':'BLOCKED',evidence,source_sha256:hash(texts[file])});
  add('server/event-dataset.js','Observation.rating',PRODUCT_LABELS.map((label,ordinal)=>({label,ordinal,display:RATING_LABELS[label]})),PRODUCT_LABELS.every(l=>typeof RATING_LABELS[l]==='string')&&Object.keys(RATING_LABELS).length===5,'EXPORTED_SERVER_ENUM');
  for(const file of ['js/observation_service.js','admin/backfill.html','index.html'])add(file,'rating enum',PRODUCT_LABELS,PRODUCT_LABELS.every(label=>texts[file].includes(label)),'ALL_FIVE_STABLE_ENUMS_PRESENT_NO_DISPLAY_ALIAS_USED_AS_ORDINAL');
  add('tools/ground-truth/ground-truth-policy.mjs','GT.ordinal',PRODUCT_LABELS.map((label,ordinal)=>({label,ordinal})),digest(LABELS)===digest(PRODUCT_LABELS),'EXPORTED_GT_LABEL_ORDER');
  add('tools/evaluation/metrics.mjs','LABEL_TO_ORDINAL / scoreToOrdinal',PRODUCT_LABELS.map((label,ordinal)=>({label,ordinal})),PRODUCT_LABELS.every((l,i)=>LABEL_TO_ORDINAL[l]===i),'EXPORTED_MAPPING_AND_BOUNDARY_GOLDEN');
  const thresholds=Array.from({length:101},(_,score)=>({score,ordinal:scoreToOrdinal(score),legacy_alias:levels.find(l=>score>=l.min)?.label}));
  add('js/config.js','levels[].min',levels.map((l,i)=>({ordinal:4-i,min:l.min,legacy_alias:l.label})),digest(levels.map(l=>l.min))===digest([90,60,40,20,0])&&thresholds.every(r=>r.legacy_alias===levels[4-r.ordinal].label),'EXECUTED_FROZEN_CONFIG_ALL_101_INTEGER_SCORES');
  add('js/engine.js','score -> config.levels',thresholds.filter(r=>[0,19,20,39,40,59,60,89,90,100].includes(r.score)),texts['js/engine.js'].includes('score >= cfg.levels[li].min'),'ENGINE_SOURCE_THRESHOLD_LOOKUP_PLUS_SCORING_GOLDEN');
  add('js/ui.js','legacy levelClasses',PRODUCT_LABELS.map((label,ordinal)=>({ordinal,label,product_name:PRODUCT_NAMES[ordinal],legacy_alias:levels[4-ordinal].label})),texts['js/ui.js'].includes('levelClasses'),'DISPLAY_ALIASES_ONLY_EXISTING_UI_UNCHANGED_PRODUCT_REPORTS_USE_ORDINAL');
  add('tools/replay/replay-runner.mjs','actual.score -> product ordinal',[20,40,60,90],texts['tools/replay/replay-runner.mjs'].includes('score'),'REPLAY_INTEGER_SCORE_CONSUMED_BY_TESTED_SCORE_TO_ORDINAL_NO_ALIAS_RELABEL');
  add('tools/product-evaluation/policy.mjs','ordinal_labels / ordinal_names',PRODUCT_LABELS.map((label,ordinal)=>({ordinal,label,name:PRODUCT_NAMES[ordinal]})),true,'NEW_NUMERIC_REPORT_CONTRACT');
  return {status:rows.every(r=>r.status==='PASS')?'PASS':'BLOCKED',rule_version:1,paths:rows,
    display_alias_limitation:'LEGACY_UI_NAMES_ARE_NOT_GT_ORDINALS_NO_PRODUCTION_UI_CHANGE',on_mismatch:'STOP_CANDIDATE_COMPARISON_PRESERVE_IMMUTABLE_PACKAGES_CREATE_REPAIR_PLAN'};
}
