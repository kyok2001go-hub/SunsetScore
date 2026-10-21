import { compare, fail } from '../dataset/lib/common.mjs';
import { computeHeadlineMetrics, computeLinearQuantile, formatMetric as q } from '../evaluation/metrics.mjs';
import { renormalizeEventWeights } from '../optimization/lib/metrics.mjs';
import { bootstrapIndices } from '../validation/lib/stability.mjs';
import { scorePolicy } from './policy.mjs';
export { q };
export const support = rows => ({ sample_count: rows.length, event_count: new Set(rows.map(r => r.event_id)).size,
  date_count: new Set(rows.map(r => r.event_date_local)).size });
export function weights(rows) { return renormalizeEventWeights([...rows].sort((a,b) => compare(a.snapshot_id,b.snapshot_id)))
  .map(r => ({ ...r, weight: r.event_normalized_weight })); }
export function supported(rows, events = 30, dates = 7) { const s = support(rows); return s.event_count >= events && s.date_count >= dates; }
export function binarySupport(rows) { return [false,true].map(high => ({ high_grade: high, ...support(rows.filter(r => (r.gt_ordinal >= 2) === high)) })); }
export function weightedQuantile(rows, key, p) {
  const ordered = rows.filter(r => Number.isFinite(r[key]) && r.weight > 0).sort((a,b) => a[key]-b[key] || compare(a.snapshot_id,b.snapshot_id));
  const total = ordered.reduce((s,r) => s+r.weight,0); if (!total) return null;
  let sum=0; for(const r of ordered) { sum+=r.weight; if(sum >= p*total) return q(r[key]); } return q(ordered.at(-1)[key]);
}
export function pairStatistic(rows, key = 'score', ordered = false) {
  let numerator=0, denominator=0;
  if (ordered) {
    for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++) {
      const a=rows[i],b=rows[j]; if(a.event_id===b.event_id || a.gt_ordinal===b.gt_ordinal || !Number.isFinite(a[key]) || !Number.isFinite(b[key])) continue;
      const w=a.weight*b.weight, sign=(a[key]-b[key])*(a.gt_ordinal-b.gt_ordinal);
      denominator+=w; numerator+=w*(sign>0?1:sign===0?0.5:0);
    }
  } else {
    const positives=rows.filter(r => r.gt_ordinal>=2 && Number.isFinite(r[key]));
    const negatives=rows.filter(r => r.gt_ordinal<2 && Number.isFinite(r[key]));
    for(const a of positives) for(const b of negatives) { const w=a.weight*b.weight; denominator+=w; numerator+=w*(a[key]>b[key]?1:a[key]===b[key]?0.5:0); }
  }
  return { value: denominator>0?q(numerator/denominator):null, reason_code: denominator>0?null:ordered?'NO_CROSS_EVENT_DIFFERENT_GRADE_PAIRS':'NO_POSITIVE_OR_NEGATIVE_WEIGHT', pair_weight: q(denominator) };
}
export function metrics(rows, predicted = 'control_ordinal', alreadyWeighted = false) {
  const rs=alreadyWeighted?rows:weights(rows);
  const headline=computeHeadlineMetrics(rs.map(r=>({...r,predicted_ordinal:r[predicted]})),'weighted');
  const confusion=Array.from({length:5},()=>Array(5).fill(0)); let pos=0, pp=0, tp=0;
  for(const r of rs) { confusion[r.gt_ordinal][r[predicted]]+=r.weight;
    if(r.gt_ordinal>=2)pos+=r.weight; if(r[predicted]>=2)pp+=r.weight; if(r.gt_ordinal>=2&&r[predicted]>=2)tp+=r.weight; }
  return { ...support(rs), ...headline, high_grade_recall:pos?q(tp/pos):null, high_grade_precision:pp?q(tp/pp):null,
    high_grade_recall_reason_code:pos?null:'NO_HIGH_GRADE', high_grade_precision_reason_code:pp?null:'NO_PREDICTED_HIGH_GRADE',
    confusion:confusion.map(row=>row.map(q)),
    grades: confusion.map((row,i)=>{const total=row.reduce((a,b)=>a+b,0);return {ordinal:i,...support(rs.filter(r=>r.gt_ordinal===i)),
      mae:total?q(row.reduce((s,w,j)=>s+w*Math.abs(i-j),0)/total):null, recall:total?q(row[i]/total):null,
      reason_code:total?null:'NO_GRADE_SUPPORT', limitation:i===4&&!supported(rs.filter(r=>r.gt_ordinal===4),5,1)?'EXCELLENT_FEWER_THAN_5_EVENTS':null };}),
    prediction_distribution: confusion.map((_,j)=>({ordinal:j,weight:q(confusion.reduce((s,row)=>s+row[j],0)),
      proportion:rs.length?q(confusion.reduce((s,row)=>s+row[j],0)/rs.reduce((s,r)=>s+r.weight,0)):null,
      sample_count:rs.filter(r=>r[predicted]===j).length,reason_code:rs.length?null:'NO_SAMPLES'})) };
}
export function distribution(rows) {
  const rs=weights(rows), quantiles=[.1,.25,.5,.75,.9];
  return { grades:Array.from({length:5},(_,ordinal)=>{const subset=rs.filter(r=>r.gt_ordinal===ordinal);return {
    ordinal,...support(subset),quantiles:Object.fromEntries(quantiles.map(p=>[`p${p*100}`,weightedQuantile(subset,'score',p)])),reason_code:subset.length?null:'NO_GRADE_SUPPORT' };}),
    bins:Array.from({length:10},(_,bin)=>{const subset=weights(rows.filter(r=>Math.min(9,Math.floor(r.score/10))===bin));
      const W=subset.reduce((s,r)=>s+r.weight,0);return {min:bin*10,max:bin===9?100:bin*10+9,...support(subset),
        grade_weights:Array.from({length:5},(_,i)=>q(subset.filter(r=>r.gt_ordinal===i).reduce((s,r)=>s+r.weight,0))),
        mean_gt:W?q(subset.reduce((s,r)=>s+r.weight*r.gt_ordinal,0)/W):null, reason_code:W?null:'NO_BIN_SUPPORT'};}),
    overlap:Array.from({length:4},(_,i)=>{const a=rs.filter(r=>r.gt_ordinal===i),b=rs.filter(r=>r.gt_ordinal===i+1);
      const low=Math.max(weightedQuantile(a,'score',.1)??Infinity,weightedQuantile(b,'score',.1)??Infinity);
      const high=Math.min(weightedQuantile(a,'score',.9)??-Infinity,weightedQuantile(b,'score',.9)??-Infinity);
      return {grades:[i,i+1],p10_p90_overlap:a.length&&b.length?q(Math.max(0,high-low)):null,reason_code:a.length&&b.length?null:'MISSING_GRADE'};}) };
}
export function discrimination(rows) {
  const rs=weights(rows);return {...support(rs),main_support:supported(rs), binary_support:binarySupport(rs),
    binary_support_sufficient:binarySupport(rs).every(s=>s.event_count>=10&&s.date_count>=3),
    auc:pairStatistic(rs), ordered_consistency:pairStatistic(rs,'score',true), score_type:'rounded_score'};
}
export function closest(rows) {
  const best=new Map();for(const r of [...rows].filter(r=>r.lead_time_minutes>=0).sort((a,b)=>a.lead_time_minutes-b.lead_time_minutes||compare(a.snapshot_id,b.snapshot_id)))
    if(!best.has(r.event_id))best.set(r.event_id,r);return [...best.values()].sort((a,b)=>compare(a.snapshot_id,b.snapshot_id));
}
export function fitPava(rows) {
  const rs=weights(rows); if(!supported(rs)||new Set(rs.map(r=>r.gt_ordinal)).size<2) return {status:'CALIBRATION_INSUFFICIENT',reason_code:'TRAIN_SUPPORT_OR_LEVELS'};
  const grouped=new Map();for(const r of rs) {if(!Number.isFinite(r.score))fail('INVALID_CALIBRATION_SCORE');
    const g=grouped.get(r.score)||{score:r.score,weight:0,sum:0};g.weight+=r.weight;g.sum+=r.weight*r.gt_ordinal;grouped.set(r.score,g);}
  const nodes=[...grouped.values()].sort((a,b)=>a.score-b.score),blocks=[];
  for(let i=0;i<nodes.length;i++){blocks.push({start:i,end:i,weight:nodes[i].weight,sum:nodes[i].sum});
    while(blocks.length>=2){const b=blocks.at(-1),a=blocks.at(-2);if(a.sum/a.weight<=b.sum/b.weight)break;
      blocks.splice(-2,2,{start:a.start,end:b.end,weight:a.weight+b.weight,sum:a.sum+b.sum});}}
  for(const b of blocks)for(let i=b.start;i<=b.end;i++)nodes[i].fitted=q(Math.max(0,Math.min(4,b.sum/b.weight)));
  return {status:'FITTED',nodes:nodes.map(n=>({score:n.score,fitted:n.fitted,weight:q(n.weight)})),...support(rs)};
}
export function predictPava(mapping,score) {
  const nodes=mapping.nodes;if(mapping.status!=='FITTED'||!Number.isFinite(score))fail('INVALID_CALIBRATION_MAPPING');
  let value=nodes[0].fitted;
  if(score>=nodes.at(-1).score)value=nodes.at(-1).fitted;
  else for(let i=1;i<nodes.length;i++)if(score<=nodes[i].score){const a=nodes[i-1],b=nodes[i];value=a.fitted+(b.fitted-a.fitted)*(score-a.score)/(b.score-a.score);break;}
  value=q(Math.max(0,Math.min(4,value)));return {ordinal_estimate:value,ordinal:Math.max(0,Math.min(4,Math.floor(value+.5)))};
}
export function bootstrap(rows,seed,draws=null) {
  const policy=scorePolicy().bootstrap,rs=weights(rows), dates=[...new Set(rs.map(r=>r.event_date_local))].sort(compare);
  const values={auc:[],ordered_consistency:[],delta_mae:[]};
  if(dates.length>=2)for(const draw of draws||bootstrapIndices(seed,dates.length,policy.replicates)) {
    const counts=Array(dates.length).fill(0);for(const i of draw)counts[i]++;
    const sampled=rs.map(r=>({...r,weight:r.weight*counts[dates.indexOf(r.event_date_local)]})).filter(r=>r.weight>0);
    values.auc.push(pairStatistic(sampled).value);values.ordered_consistency.push(pairStatistic(sampled,'score',true).value);
    const total=sampled.reduce((s,r)=>s+r.weight,0);
    values.delta_mae.push(total&&sampled.every(r=>Number.isInteger(r.calibrated_ordinal))?q(sampled.reduce((s,r)=>s+r.weight*(Math.abs(r.calibrated_ordinal-r.gt_ordinal)-Math.abs(r.control_ordinal-r.gt_ordinal)),0)/total):null);
  }
  return {seed:seed>>>0,date_count:dates.length,...policy,intervals:Object.fromEntries(Object.entries(values).map(([key,list])=>{
    const valid=list.filter(Number.isFinite).sort((a,b)=>a-b),ok=valid.length>=policy.minimum_valid;
    return [key,{status:ok?'COMPUTED':'NOT_ESTIMABLE',attempted_replicates:list.length,valid_replicates:valid.length,undefined_replicates:list.length-valid.length,
      reason_code:ok?null:dates.length<2?'INSUFFICIENT_DATES':'FEWER_THAN_1900_VALID_REPLICATES',
      ci_lower:ok?computeLinearQuantile(valid,policy.lower):null,ci_upper:ok?computeLinearQuantile(valid,policy.upper):null}];}))};
}
