import { canonicalJson, hash, compare, fail } from '../../dataset/lib/common.mjs';
import { formatMetric } from '../../evaluation/metrics.mjs';
export const digest=value=>hash(canonicalJson(value));
export const q=formatMetric;
export const memberRows=rows=>[...rows].sort((a,b)=>compare(a.snapshot_id,b.snapshot_id)).map(({snapshot_id,event_id,location_key,event_date_local})=>
  ({snapshot_id,event_id,location_key,event_date_local}));
export function normalize(value) {
  if(typeof value==='number')return q(value);
  if(Array.isArray(value))return value.map(normalize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));
  return value;
}
export function assertSame(a,b,code) {if(digest(a)!==digest(b))fail(code);}
