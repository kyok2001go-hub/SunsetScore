import { compare } from '../../dataset/lib/common.mjs';
import { computeLinearQuantile } from '../../evaluation/metrics.mjs';
import { bootstrapIndices, bootstrapSeed } from '../../validation/lib/stability.mjs';
import { weights, support, weightedQuantile, pairStatistic } from '../statistics.mjs';
import { scorePolicy } from '../policy.mjs';
import { digest, q, normalize } from './common.mjs';

export function statisticSeed(planCore,metric,slice) {return bootstrapSeed(digest({plan_core_sha256:planCore,metric,slice}));}
export function classDescription(rows) {
  const rs=weights(rows);
  return {...support(rs),weight:q(rs.reduce((s,r)=>s+r.weight,0)),score_min:rs.length?Math.min(...rs.map(r=>r.score)):null,
    score_max:rs.length?Math.max(...rs.map(r=>r.score)):null,
    quantiles:Object.fromEntries(scorePolicy(2).quantiles.map(p=>[`p${p*100}`,weightedQuantile(rs,'score',p)])),
    reason_code:rs.length?null:'NO_CLASS_SUPPORT'};
}
export function pairSums(rows,isHigh,isLow) {
  const rs=weights(rows),dates=[...new Set(rs.map(r=>r.event_date_local))].sort(compare),byDate=new Map();
  let correct=0,tied=0,reversed=0;
  for(const hi of rs.filter(isHigh))for(const lo of rs.filter(isLow)) {
    if(hi.event_id===lo.event_id)continue;
    const w=hi.weight*lo.weight,sign=Math.sign(hi.score-lo.score),i=dates.indexOf(hi.event_date_local),j=dates.indexOf(lo.event_date_local);
    const key=`${i}:${j}`,entry=byDate.get(key)||{i,j,correct:0,tied:0,reversed:0};
    if(sign>0){correct+=w;entry.correct+=w;}else if(sign===0){tied+=w;entry.tied+=w;}else{reversed+=w;entry.reversed+=w;}
    byDate.set(key,entry);
  }
  const denominator=correct+tied+reversed;
  return {dates,blocks:[...byDate.values()],correct_weight:correct,tied_weight:tied,reversed_weight:reversed,
    credited_weight:correct+.5*tied,denominator_weight:denominator,auc:denominator>0?(correct+.5*tied)/denominator:null};
}
export function pairInterval(sums,seed,draws=null) {
  const p=scorePolicy(2).bootstrap,values=[];let undefinedCount=0;
  if(sums.dates.length>=2)for(const draw of draws||bootstrapIndices(seed,sums.dates.length,p.replicates)) {
    const counts=Array(sums.dates.length).fill(0);draw.forEach(i=>counts[i]++);
    let numerator=0,denominator=0;
    for(const block of sums.blocks) {const repeat=counts[block.i]*counts[block.j];
      numerator+=repeat*(block.correct+.5*block.tied);denominator+=repeat*(block.correct+block.tied+block.reversed);}
    if(denominator>0)values.push(numerator/denominator);else undefinedCount++;
  }
  values.sort((a,b)=>a-b);const ok=values.length>=p.minimum_valid;
  return {seed,algorithm:p.algorithm,prng:p.prng,replicates:p.replicates,attempted_replicates:values.length+undefinedCount,
    valid_replicates:values.length,undefined_replicates:undefinedCount,status:ok?'COMPUTED':'NOT_ESTIMABLE',
    ci_lower:ok?computeLinearQuantile(values,p.lower):null,ci_upper:ok?computeLinearQuantile(values,p.upper):null,
    reason_code:ok?null:sums.dates.length<2?'INSUFFICIENT_DATES':'FEWER_THAN_1900_VALID_REPLICATES'};
}
export function classifyBoundary({low,high,auc,interval}) {
  const p=scorePolicy(2),enough=[low,high].every(s=>s.event_count>=p.support.class_events&&s.date_count>=p.support.class_dates);
  if(!enough)return 'INSUFFICIENT_SUPPORT';
  if(auc==null||interval.status!=='COMPUTED')return 'UNRESOLVED';
  if(q(auc)>=p.boundary_signal.auc_min&&interval.ci_lower>p.boundary_signal.lower_strict)return 'SIGNAL_SUPPORTED';
  if(interval.ci_upper<p.boundary_signal.inverse_upper_strict)return 'INVERSE_SIGNAL';
  return 'UNRESOLVED';
}
export function boundaryMetric(rows,{id,cohort,isHigh,isLow,planCore,totalPairWeight=null}) {
  const selected=rows.filter(r=>isHigh(r)||isLow(r)),sums=pairSums(selected,isHigh,isLow);
  const low=classDescription(selected.filter(isLow)),high=classDescription(selected.filter(isHigh));
  const interval=pairInterval(sums,statisticSeed(planCore,`auc:${id}`,cohort));
  return normalize({rule_version:2,cohort,boundary_id:id,score_path:'parent/reference_parity.json/rows/control_score',
    low,high,positive_class:'HIGHER_GT_ORDINAL',auc:sums.auc,
    reason_code:sums.auc===null?'NO_POSITIVE_OR_NEGATIVE_PAIRS':null,interval,status:classifyBoundary({low,high,auc:sums.auc,interval}),
    denominator_pair_weight:sums.denominator_weight,denominator_share:totalPairWeight>0?sums.denominator_weight/totalPairWeight:null,
    member_snapshot_ids:selected.map(r=>r.snapshot_id).sort(compare),member_event_ids:[...new Set(selected.map(r=>r.event_id))].sort(compare)});
}
export function analyzeBoundaries(rows,cohort,planCore) {
  const p=scorePolicy(2),pairData=p.ordinal_pairs.map(([low,high])=>({low,high,sums:pairSums(rows.filter(r=>[low,high].includes(r.gt_ordinal)),r=>r.gt_ordinal===high,r=>r.gt_ordinal===low)}));
  const total=pairData.reduce((s,r)=>s+r.sums.denominator_weight,0),credit=pairData.reduce((s,r)=>s+r.sums.credited_weight,0),correct=pairData.reduce((s,r)=>s+r.sums.correct_weight,0);
  const original=pairStatistic(weights(rows),'score',true).value,reconstructed=total?q(credit/total):null;
  const pairs=pairData.map(({low,high,sums})=>({...boundaryMetric(rows,{id:`pair_${low}_${high}`,cohort,planCore,
    isHigh:r=>r.gt_ordinal===high,isLow:r=>r.gt_ordinal===low,totalPairWeight:total}),
    low_ordinal:low,high_ordinal:high,correct_weight:q(sums.correct_weight),tied_weight:q(sums.tied_weight),reversed_weight:q(sums.reversed_weight),
    credited_weight:q(sums.credited_weight),credited_contribution_share:credit?q(sums.credited_weight/credit):null,
    correct_contribution_share:correct?q(sums.correct_weight/correct):null}));
  const adjacent=p.adjacent_pairs.map(([low,high])=>boundaryMetric(rows,{id:`adjacent_${low}_${high}`,cohort,planCore,
    isHigh:r=>r.gt_ordinal===high,isLow:r=>r.gt_ordinal===low,totalPairWeight:total}));
  const cumulative=p.cumulative_thresholds.map(t=>boundaryMetric(rows,{id:`gte_${t}`,cohort,planCore,
    isHigh:r=>r.gt_ordinal>=t,isLow:r=>r.gt_ordinal<t,totalPairWeight:total}));
  return {boundaries:{cohort,adjacent,cumulative},contributions:normalize({cohort,pairs,
    total_pair_weight:total,total_credited_weight:credit,reconstructed_ordered_consistency:reconstructed,
    parent_formula_ordered_consistency:original,reconstruction_abs_error:original===null||reconstructed===null?null:Math.abs(original-reconstructed),
    reconstruction_pass:original===null?reconstructed===null:reconstructed!==null&&Math.abs(original-reconstructed)<=p.reconstruction_tolerance,
    poor_fair_credited_contribution_share:pairs[0].credited_contribution_share,poor_fair_correct_contribution_share:pairs[0].correct_contribution_share})};
}
