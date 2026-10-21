import { compare } from '../../dataset/lib/common.mjs';
import { computeLinearQuantile } from '../../evaluation/metrics.mjs';
import { bootstrapIndices } from '../../validation/lib/stability.mjs';
import { metrics, support, weights, pairStatistic, closest } from '../statistics.mjs';
import { scorePolicy } from '../policy.mjs';
import { boundaryMetric, classDescription, statisticSeed } from './boundaries.mjs';
import { gradeComposition } from './mapping.mjs';
import { leadValidity } from './temporal.mjs';
import { normalize, q } from './common.mjs';

export function pairedEvents(rows,earlierBucket) {
  const p=scorePolicy(2),valid=rows.filter(r=>leadValidity(r).status==='VALID'),events=[...new Set(rows.map(r=>r.event_id))].sort(compare);
  const select=(event,bucket)=>valid.filter(r=>r.event_id===event&&r.lead_time_bucket===bucket)
    .sort((a,b)=>a.lead_time_minutes-b.lead_time_minutes||compare(a.snapshot_id,b.snapshot_id))[0];
  const pairs=[],unmatched=[];
  for(const event of events){const early=select(event,earlierBucket),near=select(event,p.near_bucket);
    if(early&&near)pairs.push({event_id:event,event_date_local:early.event_date_local,gt_confidence:early.gt_confidence,early,near});
    else unmatched.push({event_id:event,has_earlier:!!early,has_near:!!near,reason_code:!early&&!near?'NEITHER_BUCKET':!early?'EARLIER_BUCKET_MISSING':'NEAR_BUCKET_MISSING'});}
  return {pairs,unmatched};
}
export function pairedErrorInterval(pairs,seed,draws=null) {
  const p=scorePolicy(2).bootstrap,dates=[...new Set(pairs.map(r=>r.event_date_local))].sort(compare);
  const blocks=dates.map(date=>pairs.filter(r=>r.event_date_local===date).reduce((sum,r)=>({weight:sum.weight+r.gt_confidence,
    delta:sum.delta+r.gt_confidence*(Math.abs(r.near.control_ordinal-r.near.gt_ordinal)-Math.abs(r.early.control_ordinal-r.early.gt_ordinal))}),{weight:0,delta:0}));
  const values=[];
  if(dates.length>=2)for(const draw of draws||bootstrapIndices(seed,dates.length,p.replicates)){
    const total=draw.reduce((s,i)=>({weight:s.weight+blocks[i].weight,delta:s.delta+blocks[i].delta}),{weight:0,delta:0});
    values.push(total.delta/total.weight);}
  values.sort((a,b)=>a-b);const ok=values.length>=p.minimum_valid,total=blocks.reduce((s,b)=>({weight:s.weight+b.weight,delta:s.delta+b.delta}),{weight:0,delta:0});
  return {seed,point_delta_mae:total.weight?q(total.delta/total.weight):null,status:ok?'COMPUTED':'NOT_ESTIMABLE',
    ci_lower:ok?computeLinearQuantile(values,p.lower):null,ci_upper:ok?computeLinearQuantile(values,p.upper):null,
    valid_replicates:values.length,undefined_replicates:0,replicates:p.replicates,reason_code:ok?null:'INSUFFICIENT_DATES'};
}
export function leadTimeAnalysis(rows,cohort,planCore,temporalRows) {
  const policy=scorePolicy(2),invalid=rows.map(r=>({r,validity:leadValidity(r)})).filter(r=>r.validity.status!=='VALID')
    .map(({r,validity})=>({snapshot_id:r.snapshot_id,event_id:r.event_id,field_path:'TRAIN.lead_time_minutes',rule_version:2,cohort,...validity}));
  const valid=rows.filter(r=>leadValidity(r).status==='VALID');
  const bucketReport=(rs,benchmark)=>policy.lead_buckets.map(bucket=>{
    const subset=rs.filter(r=>r.lead_time_bucket===bucket),ids=new Set(subset.map(r=>r.snapshot_id));
    const quality=temporalRows.filter(r=>ids.has(r.snapshot_id));
    return {cohort,benchmark,bucket,...support(subset),metrics:metrics(subset),gt_distribution:gradeComposition(subset),score_distribution:classDescription(subset),
      high_grade_discrimination:boundaryMetric(subset,{id:`lead_${benchmark}_${bucket}_gte_2`,cohort,planCore,isHigh:r=>r.gt_ordinal>=2,isLow:r=>r.gt_ordinal<2}),
      ordered_consistency:pairStatistic(weights(subset),'score',true),input_quality_counts:Object.fromEntries(policy.temporal_statuses.map(status=>[status,quality.filter(r=>r.status===status).length])),
      error_support_status:support(subset).event_count>=10&&support(subset).date_count>=3?'SUFFICIENT_SUPPORT':'INSUFFICIENT_SUPPORT',
      reason_code:subset.length?null:'NO_BUCKET_SUPPORT',composition_warning:'UNPAIRED_BUCKET_EVENT_COMPOSITIONS_MAY_DIFFER'};});
  const paired=policy.earlier_buckets.map(bucket=>{
    const {pairs,unmatched}=pairedEvents(rows,bucket),early=pairs.map(p=>p.early),near=pairs.map(p=>p.near),s=support(early);
    const enough=s.event_count>=policy.support.paired_events&&s.date_count>=policy.support.paired_dates;
    const earlyMetric=metrics(early),nearMetric=metrics(near);
    return {rule_version:2,cohort,earlier_bucket:bucket,near_bucket:policy.near_bucket,weighting:'ONCE_PER_EVENT_GT_CONFIDENCE',
      field_path:'TRAIN.lead_time_bucket',...s,support_status:enough?'SUFFICIENT_SUPPORT':'INSUFFICIENT_SUPPORT',
      coverage:{total_event_count:new Set(rows.map(r=>r.event_id)).size,matched_event_count:pairs.length,
        unmatched_event_count:unmatched.length,events_with_earlier:pairs.length+unmatched.filter(r=>r.has_earlier).length,
        events_with_near:pairs.length+unmatched.filter(r=>r.has_near).length},unmatched,
      members:pairs.map(r=>({event_id:r.event_id,early_snapshot_id:r.early.snapshot_id,near_snapshot_id:r.near.snapshot_id,weight:r.gt_confidence})),
      early_metrics:earlyMetric,near_metrics:nearMetric,
      early_auc:boundaryMetric(early,{id:`paired_${bucket}_early_gte_2`,cohort,planCore,isHigh:r=>r.gt_ordinal>=2,isLow:r=>r.gt_ordinal<2}),
      near_auc:boundaryMetric(near,{id:`paired_${bucket}_near_gte_2`,cohort,planCore,isHigh:r=>r.gt_ordinal>=2,isLow:r=>r.gt_ordinal<2}),
      delta_mae_interval:pairedErrorInterval(pairs,statisticSeed(planCore,'paired_delta_mae',`${cohort}:${bucket}`)),
      delta_high_grade_recall:earlyMetric.high_grade_recall===null||nearMetric.high_grade_recall===null?null:q(nearMetric.high_grade_recall-earlyMetric.high_grade_recall),
      conclusion:enough?'PAIRED_DESCRIPTIVE_COMPARISON_AND_DATE_INTERVAL':'NO_DIRECTIONAL_TIME_IMPROVEMENT_CLAIM_INSUFFICIENT_PAIRED_SUPPORT'};
  });
  return normalize({buckets:[...bucketReport(valid,'ALL_PRIMARY'),...bucketReport(closest(valid),'CLOSEST_PRE_SUNSET')],paired,
    invalid_members:invalid,valid_snapshot_count:valid.length,invalid_snapshot_count:invalid.length});
}
