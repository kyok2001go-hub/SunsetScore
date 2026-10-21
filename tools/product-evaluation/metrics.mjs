import { compare, fail } from '../dataset/lib/common.mjs';
import { computeHeadlineMetrics,computeLinearQuantile,formatMetric as q } from '../evaluation/metrics.mjs';
import { renormalizeEventWeights } from '../optimization/lib/metrics.mjs';
import { bootstrapIndices,bootstrapSeed } from '../validation/lib/stability.mjs';
import { productPolicy,digest } from './policy.mjs';
export {q};
export const support=rows=>({snapshot_count:rows.length,event_count:new Set(rows.map(r=>r.event_id)).size,date_count:new Set(rows.map(r=>r.event_date_local)).size});
export function weightedRows(rows){
  const snapshots=new Set(),events=new Map();
  for(const r of rows){if(snapshots.has(r.snapshot_id)||!Number.isInteger(r.gt_ordinal)||r.gt_ordinal<0||r.gt_ordinal>4||!Number.isFinite(r.gt_confidence)||r.gt_confidence<=0||r.gt_confidence>1)fail('PRODUCT_INVALID_COHORT');
    snapshots.add(r.snapshot_id);const prior=events.get(r.event_id);if(prior&&['gt_ordinal','gt_confidence','event_date_local','location_key'].some(k=>prior[k]!==r[k]))fail('PRODUCT_EVENT_INCONSISTENCY');events.set(r.event_id,r);}
  return renormalizeEventWeights([...rows].sort((a,b)=>compare(a.snapshot_id,b.snapshot_id))).map(r=>({...r,weight:r.event_normalized_weight}));
}
const sum=(rows,fn=()=>1)=>rows.reduce((s,r)=>s+r.weight*fn(r),0);
export function productMetrics(rows,key='predicted_ordinal'){
  const rs=weightedRows(rows);for(const r of rs)if(!Number.isInteger(r[key])||r[key]<0||r[key]>4)fail('PRODUCT_INVALID_PREDICTION');
  const p=productPolicy(),W=sum(rs),ratio=(fn,den=W)=>den>0?q(sum(rs,fn)/den):null;
  const count=Array.from({length:5},()=>Array(5).fill(0)),weighted=count.map(row=>[...row]);
  for(const r of rs){count[r[key]][r.gt_ordinal]++;weighted[r[key]][r.gt_ordinal]+=r.weight;}
  const critical=rs.filter(r=>r[key]===4&&r.gt_ordinal<=1),four=rs.filter(r=>r[key]===4),fourWeight=sum(four);
  const binary=t=>{const positive=rs.filter(r=>r.gt_ordinal>=t),predicted=rs.filter(r=>r[key]>=t),tp=sum(rs.filter(r=>r.gt_ordinal>=t&&r[key]>=t));
    return {target_ordinals:Array.from({length:5-t},(_,i)=>i+t),support:support(positive),predicted_support:support(predicted),
      recall:sum(positive)?q(tp/sum(positive)):null,precision:sum(predicted)?q(tp/sum(predicted)):null,
      miss_rate:sum(positive)?q(1-tp/sum(positive)):null,predicted_usage_rate:W?q(sum(predicted)/W):null,
      reason_code:positive.length?null:'NO_TARGET_SUPPORT'};};
  const headline=computeHeadlineMetrics(rs.map(r=>({...r,predicted_ordinal:r[key]})),'weighted');
  return {...support(rs),...headline,absolute_bias:headline.bias===null?null:q(Math.abs(headline.bias)),
    product_loss:ratio(r=>p.loss_matrix[r[key]][r.gt_ordinal]),
    confusion_matrix:{orientation:p.loss_orientation,count,weighted:weighted.map(row=>row.map(q))},
    critical_overprediction:{...support(critical),rate:ratio(r=>Number(r[key]===4&&r.gt_ordinal<=1)),
      conditional_on_predicted4:fourWeight?q(sum(critical)/fourWeight):null},
    overprediction_ge2:ratio(r=>Number(r[key]-r.gt_ordinal>=2)),underprediction_ge2:ratio(r=>Number(r.gt_ordinal-r[key]>=2)),
    predicted4_support:support(four),grade4_status:four.length?'OBSERVED_DEVELOPMENT_EVIDENCE_NOT_ZERO_FUTURE_RISK':'NOT_ASSESSED',
    predicted4_actual_ge3_precision:fourWeight?q(sum(four,r=>Number(r.gt_ordinal>=3))/fourWeight):null,
    predicted4_actual_ge2_precision:fourWeight?q(sum(four,r=>Number(r.gt_ordinal>=2))/fourWeight):null,
    target_ge2:binary(2),target_ge3:binary(3),
    prediction_distribution:Array.from({length:5},(_,ordinal)=>({ordinal,...support(rs.filter(r=>r[key]===ordinal)),weight:q(sum(rs,r=>Number(r[key]===ordinal))),proportion:ratio(r=>Number(r[key]===ordinal))})),
    grades:Array.from({length:5},(_,ordinal)=>{const subset=weightedRows(rs.filter(r=>r.gt_ordinal===ordinal)),w=sum(subset);return {ordinal,...support(subset),
      mae:w?q(sum(subset,r=>Math.abs(r[key]-r.gt_ordinal))/w):null,bias:w?q(sum(subset,r=>r[key]-r.gt_ordinal)/w):null,
      recall:w?q(sum(subset,r=>Number(r[key]===ordinal))/w):null,precision:sum(rs.filter(r=>r[key]===ordinal))?q(sum(rs.filter(r=>r[key]===ordinal&&r.gt_ordinal===ordinal))/sum(rs.filter(r=>r[key]===ordinal))):null,
      reason_code:w?null:'NO_GRADE_SUPPORT'};})};
}
export function estimateConstant(training){
  if(!training.length)fail('PRODUCT_CONSTANT_TRAIN_REQUIRED');
  const evaluated=Array.from({length:5},(_,ordinal)=>({ordinal,product_loss:productMetrics(training.map(r=>({...r,constant:ordinal})),'constant').product_loss}));
  const best=[...evaluated].sort((a,b)=>a.product_loss-b.product_loss||a.ordinal-b.ordinal)[0];
  return {...best,evaluated,training_members_sha256:digest(training.map(r=>r.snapshot_id).sort(compare)),training_support:support(training),selected_on:'TRAIN_ONLY'};
}
export function productSupportSufficient(s){const t=productPolicy().qualification;return s.event_count>=t.target_ge3_events&&s.date_count>=t.target_ge3_dates;}
export function qualification(metrics,control,constantLoss,coverage=1){
  const p=productPolicy(),e=p.epsilon,t=p.qualification;
  const checks=[['COMPLETE_COVERAGE',coverage===1],['LOSS_BELOW_CONTROL',metrics.product_loss!==null&&control.product_loss!==null&&metrics.product_loss<control.product_loss-e],
    ['LOSS_BELOW_TRAIN_CONSTANT',constantLoss!==null&&metrics.product_loss!==null&&metrics.product_loss<constantLoss-e],
    ['NO_OBSERVED_CRITICAL_OVERPREDICTION',metrics.critical_overprediction.snapshot_count===0],
    ...[2,3].map(n=>[`TARGET_GE${n}_RECALL_PRESERVED`,metrics[`target_ge${n}`].recall!==null&&control[`target_ge${n}`].recall!==null&&metrics[`target_ge${n}`].recall>=control[`target_ge${n}`].recall-t.recall_absolute_tolerance-e]),
    ['SUFFICIENT_PRODUCT_SUPPORT',productSupportSufficient(metrics.target_ge3.support)]];
  return {development_qualified:checks.every(([,ok])=>ok),basic_guards_pass:checks.filter(([n])=>!['LOSS_BELOW_TRAIN_CONSTANT','SUFFICIENT_PRODUCT_SUPPORT'].includes(n)).every(([,ok])=>ok),
    gates:checks.map(([gate,ok])=>({gate,status:ok?'PASS':'FAIL'})),reason_codes:checks.filter(([,ok])=>!ok).map(([n])=>n==='SUFFICIENT_PRODUCT_SUPPORT'?'INSUFFICIENT_PRODUCT_SUPPORT':n),
    classification:checks.every(([,ok])=>ok)?'PRODUCT_DEVELOPMENT_QUALIFIED':metrics.target_ge3.support.event_count<t.target_ge3_events||metrics.target_ge3.support.date_count<t.target_ge3_dates?'INSUFFICIENT_PRODUCT_SUPPORT':'PRODUCT_DEVELOPMENT_NOT_QUALIFIED',formal_capable:false};
}
export function deltaLossInterval(rows,identity,predicted='predicted_ordinal'){
  const rs=weightedRows(rows),p=productPolicy(),dates=[...new Set(rs.map(r=>r.event_date_local))].sort(compare),seed=bootstrapSeed(digest({identity,metric:'PRODUCT_LOSS_DELTA',policy:digest(p)}));
  const blocks=dates.map(date=>{const group=rs.filter(r=>r.event_date_local===date);return {weight:sum(group),delta:sum(group,r=>p.loss_matrix[r[predicted]][r.gt_ordinal]-p.loss_matrix[r.control_ordinal][r.gt_ordinal])};});
  const values=[];if(dates.length>=2)for(const draw of bootstrapIndices(seed,dates.length,p.bootstrap.replicates)){let w=0,d=0;for(const i of draw){w+=blocks[i].weight;d+=blocks[i].delta;}if(w>0)values.push(d/w);}
  values.sort((a,b)=>a-b);const ok=values.length>=p.bootstrap.minimum_valid;
  const W=blocks.reduce((s,b)=>s+b.weight,0);
  return {...p.bootstrap,seed,status:ok?'COMPUTED':'NOT_ESTIMABLE',valid_replicates:values.length,undefined_replicates:dates.length>=2?p.bootstrap.replicates-values.length:0,
    point_delta_loss:W?q(blocks.reduce((s,b)=>s+b.delta,0)/W):null,ci_lower:ok?computeLinearQuantile(values,p.bootstrap.lower):null,ci_upper:ok?computeLinearQuantile(values,p.bootstrap.upper):null,
    reason_code:ok?null:'INSUFFICIENT_DATES_OR_VALID_REPLICATES'};
}
export function productSlices(rows,key='predicted_ordinal'){
  const p=productPolicy();return p.slice_dimensions.flatMap(dimension=>[...new Set(rows.map(r=>r[dimension]??null))].sort((a,b)=>compare(String(a),String(b))).map(value=>{
    const subset=rows.filter(r=>(r[dimension]??null)===value),s=support(subset);return {dimension,value,...s,supported:s.event_count>=p.slice_support.events&&s.date_count>=p.slice_support.dates,
      metrics:productMetrics(subset,key),control:productMetrics(subset,'control_ordinal')};}));
}
