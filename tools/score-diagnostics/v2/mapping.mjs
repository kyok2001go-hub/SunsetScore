import { compare } from '../../dataset/lib/common.mjs';
import { weights, support, metrics, pairStatistic, predictPava } from '../statistics.mjs';
import { classDescription } from './boundaries.mjs';
import { digest, q, normalize } from './common.mjs';

export function gradeComposition(rows) {
  const rs=weights(rows),total=rs.reduce((s,r)=>s+r.weight,0);
  return { ...classDescription(rs),grades:Array.from({length:5},(_,ordinal)=>{
    const subset=rs.filter(r=>r.gt_ordinal===ordinal),weight=subset.reduce((s,r)=>s+r.weight,0);
    return {ordinal,...classDescription(subset),weight:q(weight),proportion:total?q(weight/total):null,
      precision_limit:subset.length?null:'NO_GRADE_SUPPORT'};
  }) };
}
export function crossing(mapping,threshold) {
  const nodes=mapping.nodes;
  if(nodes.at(-1).fitted<threshold)return {threshold,score:null,status:'NOT_REACHABLE',reason_code:'MAXIMUM_FITTED_BELOW_THRESHOLD'};
  if(nodes[0].fitted>=threshold)return {threshold,score:0,first_integer_score_reaching_threshold:0,status:'REACHABLE',reason_code:'LOWER_ENDPOINT_ALREADY_AT_OR_ABOVE_THRESHOLD'};
  const i=nodes.findIndex(n=>n.fitted>=threshold),a=nodes[i-1],b=nodes[i];
  return {threshold,score:q(a.score+(threshold-a.fitted)*(b.score-a.score)/(b.fitted-a.fitted)),
    first_integer_score_reaching_threshold:Array.from({length:101},(_,score)=>score).find(score=>predictPava(mapping,score).ordinal_estimate>=threshold)??null,
    status:'REACHABLE',reason_code:null};
}
export function highGradeCounts(rows,key='calibrated_ordinal') {
  const rs=weights(rows),counts={tp:0,fp:0,fn:0,tn:0},weighted={tp:0,fp:0,fn:0,tn:0};
  for(const r of rs){const truth=r.gt_ordinal>=2,predicted=r[key]>=2,k=truth?(predicted?'tp':'fn'):(predicted?'fp':'tn');counts[k]++;weighted[k]+=r.weight;}
  return {snapshot_counts:counts,weighted:normalize(weighted),true_high_snapshot_count:counts.tp+counts.fn,
    predicted_high_snapshot_count:counts.tp+counts.fp,
    event_counts:{true_high:new Set(rs.filter(r=>r.gt_ordinal>=2).map(r=>r.event_id)).size,
      predicted_high:new Set(rs.filter(r=>r[key]>=2).map(r=>r.event_id)).size},
    recall:weighted.tp+weighted.fn?q(weighted.tp/(weighted.tp+weighted.fn)):null,
    precision:weighted.tp+weighted.fp?q(weighted.tp/(weighted.tp+weighted.fp)):null};
}
function platformIntervals(nodes) {
  const intervals=[];let start=0;
  for(let i=1;i<=nodes.length;i++)if(i===nodes.length||nodes[i].fitted!==nodes[start].fitted){
    if(i-start>=2)intervals.push({score_min:nodes[start].score,score_max:nodes[i-1].score,value:nodes[start].fitted,node_count:i-start});start=i;}
  return intervals;
}
function mappedRows(rows,mapping) {return rows.map(r=>{const value=predictPava(mapping,r.score);return {...r,
  calibrated_estimate:value.ordinal_estimate,calibrated_ordinal:value.ordinal,endpoint_fallback:r.score<mapping.nodes[0].score||r.score>mapping.nodes.at(-1).score};});}
export function auditFrozenMappings(rows,parentFolds,assignments,parentOof) {
  const audits=[],routes=[],reapplication=[];
  for(const mapping of parentFolds) {
    const frozen=assignments.folds.find(f=>f.fold===mapping.fold),trainIds=new Set(frozen.train_members.map(r=>r.snapshot_id)),heldIds=new Set(frozen.held_members.map(r=>r.snapshot_id));
    const training=mappedRows(rows.filter(r=>trainIds.has(r.snapshot_id)),mapping),held=mappedRows(rows.filter(r=>heldIds.has(r.snapshot_id)),mapping),wh=weights(held);
    const originals=new Map(parentOof.filter(r=>r.fold===mapping.fold).map(r=>[r.snapshot_id,r]));
    for(const r of held) {
      const old=originals.get(r.snapshot_id),pass=!!old&&r.calibrated_estimate===old.calibrated_estimate&&r.calibrated_ordinal===old.calibrated_ordinal&&mapping.mapping_sha256===old.mapping_sha256;
      reapplication.push({snapshot_id:r.snapshot_id,event_id:r.event_id,fold:mapping.fold,pass,
        mapping_sha256:mapping.mapping_sha256,reason_code:pass?null:'FROZEN_MAPPING_REAPPLICATION_MISMATCH'});
      routes.push({rule_version:2,cohort:`OOF_FOLD_${mapping.fold}`,snapshot_id:r.snapshot_id,event_id:r.event_id,
        field_path:'parent/oof_predictions.json/calibrated_estimate',gt_ordinal:r.gt_ordinal,score:r.score,
        calibrated_estimate:r.calibrated_estimate,calibrated_ordinal:r.calibrated_ordinal,
        true_high:r.gt_ordinal>=2,predicted_high:r.calibrated_ordinal>=2,
        route:r.gt_ordinal>=2?(r.calibrated_ordinal>=2?'TP':'FN'):(r.calibrated_ordinal>=2?'FP':'TN'),
        endpoint_fallback:r.endpoint_fallback,reason_code:r.endpoint_fallback?'OUTSIDE_TRAINING_SCORE_RANGE':'WITHIN_TRAINING_SCORE_RANGE'});
    }
    const trainDescription=gradeComposition(training),heldDescription=gradeComposition(held),counts=highGradeCounts(held);
    const possible=[...new Set(Array.from({length:101},(_,score)=>predictPava(mapping,score).ordinal))].sort((a,b)=>a-b);
    const highTrain=training.filter(r=>r.gt_ordinal>=2),highHeld=held.filter(r=>r.gt_ordinal>=2),out=wh.filter(r=>r.endpoint_fallback);
    const weight=wh.reduce((s,r)=>s+r.weight,0),error=wh.reduce((s,r)=>s+r.weight*Math.abs(r.calibrated_ordinal-r.gt_ordinal),0);
    const platforms=platformIntervals(mapping.nodes).map(p=>({...p,training:gradeComposition(training.filter(r=>r.score>=p.score_min&&r.score<=p.score_max)),
      holdout:gradeComposition(held.filter(r=>r.score>=p.score_min&&r.score<=p.score_max))}));
    const labels=[];
    if(mapping.nodes.at(-1).fitted<1.5)labels.push('MAPPING_RANGE_LIMIT');
    if(mapping.nodes.at(-1).fitted>=1.5&&highHeld.some(r=>r.calibrated_estimate<1.5))labels.push('HOLDOUT_SCORE_PLACEMENT');
    if(out.length)labels.push('ENDPOINT_DEPENDENCE');
    if(platforms.length||new Set(held.map(r=>r.score)).size>new Set(held.map(r=>r.calibrated_ordinal)).size)labels.push('PLATEAU_COMPRESSION');
    if([highTrain,highHeld].some(rs=>{const s=support(rs);return s.event_count<10||s.date_count<3;}))labels.push('SUPPORT_LIMITATION');
    const compare=(rs)=>({control:metrics(rs),calibration:metrics(rs,'calibrated_ordinal'),high_grade_counts:highGradeCounts(rs)});
    const mixed=Array.from({length:5},(_,ordinal)=>({ordinal,training:gradeComposition(training.filter(r=>r.calibrated_ordinal===ordinal)),
      holdout:gradeComposition(held.filter(r=>r.calibrated_ordinal===ordinal))}));
    audits.push(normalize({rule_version:2,cohort:`OOF_FOLD_${mapping.fold}`,fold:mapping.fold,mapping_sha256:mapping.mapping_sha256,
      field_path:`parent/fold_calibrators.json/fold=${mapping.fold}`,mapping_reapplied_only:true,refitted:false,
      training:trainDescription,holdout:heldDescription,training_dates:frozen.train_dates,holdout_dates:frozen.held_dates,
      nodes:mapping.nodes,platforms,continuous_range:{min:mapping.nodes[0].fitted,max:mapping.nodes.at(-1).fitted},
      possible_discrete_ordinals:possible,crossings:[1.5,2.5,3.5].map(t=>crossing(mapping,t)),labels,
      endpoint:{...support(out),snapshot_fraction:held.length?out.length/held.length:null,weighted_fraction:weight?out.reduce((s,r)=>s+r.weight,0)/weight:null,
        weighted_error:out.reduce((s,r)=>s+r.weight*Math.abs(r.calibrated_ordinal-r.gt_ordinal),0),
        error_contribution_share:error?out.reduce((s,r)=>s+r.weight*Math.abs(r.calibrated_ordinal-r.gt_ordinal),0)/error:null,
        reason_code:out.length?'ENDPOINT_FALLBACK_OBSERVED_NOT_CAUSAL_HARM':'NO_OUT_OF_RANGE_SCORE'},
      true_high_routes:routes.filter(r=>r.cohort===`OOF_FOLD_${mapping.fold}`&&r.true_high),high_grade_counts:counts,
      metrics:{training:compare(training),holdout:compare(held)},discrete_compression:mixed,
      ordering:{before:pairStatistic(weights(held),'score',true),continuous:pairStatistic(weights(held),'calibrated_estimate',true),discrete:pairStatistic(weights(held),'calibrated_ordinal',true)},
      composition_shift:{gt_total_variation:.5*trainDescription.grades.reduce((s,g,i)=>s+Math.abs((g.proportion??0)-(heldDescription.grades[i].proportion??0)),0),
        interpretation:'DESCRIPTIVE_CLASS_AND_DATE_COMPOSITION_DIFFERENCE_NOT_CAUSAL_EXPLANATION'},causal_claim:false}));
  }
  const fullPass=reapplication.length===parentOof.length&&reapplication.every(r=>r.pass)&&new Set(reapplication.map(r=>r.snapshot_id)).size===parentOof.length;
  return {audits,reapplication:{status:fullPass?'PASS':'BLOCKED',rows:reapplication,parent_mappings_sha256:digest(parentFolds)},
    routes:routes.sort((a,b)=>compare(a.snapshot_id,b.snapshot_id))};
}
