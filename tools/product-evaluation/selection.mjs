import { canonicalJson,compare } from '../dataset/lib/common.mjs';
const value=(x)=>Number.isFinite(x)?Number(x.toFixed(12)):null;
function cmp(a,b,descending=false){a=value(a);b=value(b);return a===b?0:a===null?1:b===null?-1:descending?b-a:a-b;}
export function rankProduct(records){return [...records].sort((a,b)=>{
  const x=a.metrics,y=b.metrics;return cmp(x.product_loss,y.product_loss)||cmp(x.target_ge2.recall,y.target_ge2.recall,true)||cmp(x.mae,y.mae)||
    cmp(a.candidate.changed_unit_count,b.candidate.changed_unit_count)||cmp(a.candidate.normalized_parameter_distance,b.candidate.normalized_parameter_distance)||compare(a.candidate.candidate_id,b.candidate.candidate_id);
});}
export function productDominates(a,b){const pairs=[[a.metrics.product_loss,b.metrics.product_loss,false],[a.metrics.critical_overprediction.rate,b.metrics.critical_overprediction.rate,false],[a.metrics.target_ge3.recall,b.metrics.target_ge3.recall,true]],relations=pairs.map(([x,y,d])=>cmp(x,y,d));return relations.every(v=>v<=0)&&relations.some(v=>v<0);}
export function productPareto(records){let rest=rankProduct(records),layers=[];while(rest.length){const front=rest.filter(r=>!rest.some(other=>other!==r&&productDominates(other,r)));layers.push(front);const ids=new Set(front.map(r=>r.candidate.candidate_id));rest=rest.filter(r=>!ids.has(r.candidate.candidate_id));}return layers;}
export function selectProductParents(records,width=8){
  const seen=new Set(),pool=rankProduct(records.filter(r=>r.status==='FEASIBLE'&&r.metrics)).filter(r=>{const k=canonicalJson(r.candidate.canonical_vector);if(seen.has(k))return false;seen.add(k);return true;});
  const seats=[],used=new Set(),groups=new Set();const take=(list,n,source)=>{const remaining=list.filter(r=>!used.has(r.candidate.candidate_id));while(n--&&seats.length<width&&remaining.length){let i=remaining.findIndex(r=>!groups.has(Object.keys(r.candidate.canonical_vector).sort().join('|')));const record=remaining.splice(i<0?0:i,1)[0];used.add(record.candidate.candidate_id);groups.add(Object.keys(record.candidate.canonical_vector).sort().join('|'));seats.push({record,seat:seats.length+1,source,candidate_id:record.candidate.candidate_id,quality:record.quality,reason_codes:record.reason_codes,gates:record.gates});}};
  const all=pool.filter(r=>r.train_all_guards_pass),basic=pool.filter(r=>!r.train_all_guards_pass&&r.basic_guards_pass),other=pool.filter(r=>!r.basic_guards_pass);
  take(all,4,'PRODUCT_TRAIN_QUALIFIED');take(productPareto(basic)[0]||[],2,'PRODUCT_BASIC_PARETO');take(productPareto(other)[0]||[],2,'PRODUCT_EXPLORATORY_PARETO');
  take(all,width,'PRODUCT_FILL_QUALIFIED');take(basic,width,'PRODUCT_FILL_BASIC');for(const layer of productPareto(other))take(layer,width,'PRODUCT_FILL_PARETO');return seats;
}
