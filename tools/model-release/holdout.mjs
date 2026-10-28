// H1 forward-holdout check for the release line: compares V2.5.5.0 / V2.5.5.1 / V2.5.5.2 / V2.5.5.4 on data collected
// after the development pool. Each version is graded with its own grade lines. `status` only counts labels
// (no prediction is computed, the holdout stays unused); `check` is single-use per policy version.
import path from 'node:path';
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {hash,canonicalJson,fail} from '../dataset/lib/common.mjs';
import {APP_ROOT,loadPool,checkInputs,codeIdentity} from '../practical-tuning/data.mjs';
import {preflight,replayCalculator,gradeThresholdsOf} from '../practical-tuning/compute.mjs';
import {digest} from '../practical-tuning/policy.mjs';
import {productMetrics,weightedRows} from '../product-evaluation/metrics.mjs';
import {gradeScore} from '../evaluation/metrics.mjs';
import {loadProduction,previousReleaseScoring,candidateReleaseScoring,differences,safeOutput,SOURCE_RUN,RELEASE_VERSION} from './release.mjs';

export const HOLDOUT_POLICY=Object.freeze({
  // Version 2 (V2.5.5.4 PRD §3.5) adds the V2.5.5.4 candidate before H1 is first used; version 1 was never executed.
  version:2,name:'H1_RELEASE_LINE_CHECK',
  first_holdout_date:'2026-10-13',
  // Standard readiness: distinct dates, Events, and Events with GT>=2 / GT>=3 after Replay exclusions.
  thresholds:Object.freeze({dates:15,events:100,ge2_events:25,ge3_events:10}),
  cohort:'PRIMARY_LAST_CLOSEST_SNAPSHOT_TO_SUNSET_PER_EVENT',
  bootstrap:Object.freeze({replicates:2000,block:'event_date_local',seed:'H1_RELEASE_LINE_CHECK_1'}),
  versions:Object.freeze(['2.5.5.0','2.5.5.1','2.5.5.2','2.5.5.4']),
  comparisons:Object.freeze([
    // V2.5.5.1 PRD §6: roll back when the sky-off release does not improve AUC>=3 or raises product loss.
    Object.freeze({id:'V2551_VS_V2550',candidate:'2.5.5.1',control:'2.5.5.0',rollback_rule:'AUC_GE3_NOT_HIGHER_OR_PRODUCT_LOSS_HIGHER'}),
    // V2.5.5.2 PRD §6: roll back when product loss rises or >=2 recall falls by more than 0.05.
    Object.freeze({id:'V2552_VS_V2551',candidate:'2.5.5.2',control:'2.5.5.1',rollback_rule:'PRODUCT_LOSS_HIGHER_OR_GE2_RECALL_DROP_OVER_0_05'}),
    // V2.5.5.4 PRD §6: do not release (or roll back) on the same rule against V2.5.5.2.
    Object.freeze({id:'V2554_VS_V2552',candidate:'2.5.5.4',control:'2.5.5.2',rollback_rule:'PRODUCT_LOSS_HIGHER_OR_GE2_RECALL_DROP_OVER_0_05'})
  ]),
  decision_owner:'PROJECT_OWNER'
});
export const LEDGER=path.join(APP_ROOT,'dataset/holdout/usage.jsonl');
const DEFAULT_KEYS=['version','illuminationModel.bankShare','illuminationModel.twilightSaturationMinutes','skyState.factorCoefficients.arrivalRiskSlope'];

// The release-line configurations, rebuilt from the current production config (2.5.5.4 = the candidate fix).
export async function releaseConfigs(root=APP_ROOT) {
  const production=await loadProduction(root);
  if(production.version.model!==RELEASE_VERSION.model)fail('HOLDOUT_PRODUCTION_VERSION_MISMATCH');
  const v2552=production.scoring,v2551=previousReleaseScoring(v2552),v2550=structuredClone(v2551);
  v2550.version='2.5.5.0';v2550.skyState.factorRange=[0.65,1.15];
  return {'2.5.5.0':v2550,'2.5.5.1':v2551,'2.5.5.2':v2552,'2.5.5.4':candidateReleaseScoring(v2552)};
}
// V2.5.5.0 is the V6 selected configuration plus already-proved default-equivalent fields.
export function assertV2550(selected,v2550) {
  const extra=differences(selected,v2550).filter(d=>!DEFAULT_KEYS.includes(d.path));
  if(extra.length)fail('HOLDOUT_V2550_CONFIG_MISMATCH',{detail:extra.map(d=>d.path).join(',')});
}
export async function devMembers(root=APP_ROOT) {
  const dir=path.join(root,'dataset/practical_tuning',SOURCE_RUN),request=JSON.parse(await readFile(path.join(dir,'verification_request.json'),'utf8'));
  return {snapshots:new Set(request.pool.included.map(r=>r.snapshot_id)),events:new Set(request.pool.included.map(r=>r.event_id)),
    selected:JSON.parse(await readFile(path.join(dir,'selected_effective_config.json'),'utf8'))};
}
export function independence(rows,dev,policy=HOLDOUT_POLICY) {
  const early=rows.filter(r=>r.event_date_local<policy.first_holdout_date),overlap=rows.filter(r=>dev.snapshots.has(r.snapshot_id)||dev.events.has(r.event_id));
  return {independent:!early.length&&!overlap.length,before_first_date:early.length,overlapping_dev:overlap.length};
}
export function readiness(rows,policy=HOLDOUT_POLICY) {
  const events=new Map();for(const r of rows)events.set(r.event_id,r);
  const ev=[...events.values()],counts={dates:new Set(ev.map(r=>r.event_date_local)).size,events:ev.length,
    ge2_events:ev.filter(r=>r.gt_ordinal>=2).length,ge3_events:ev.filter(r=>r.gt_ordinal>=3).length};
  const shortfalls=Object.fromEntries(Object.entries(policy.thresholds).filter(([k,v])=>counts[k]<v).map(([k,v])=>[k,v-counts[k]]));
  return {counts,thresholds:policy.thresholds,shortfalls,ready:!Object.keys(shortfalls).length};
}
export function primaryLast(rows) {
  const best=new Map();
  for(const r of rows){const b=best.get(r.event_id);if(!b||r.lead_time_minutes<b.lead_time_minutes||r.lead_time_minutes===b.lead_time_minutes&&r.snapshot_id<b.snapshot_id)best.set(r.event_id,r);}
  return [...best.values()];
}
// Weighted AUC of GT>=threshold vs below, Event weight = gt_confidence; ties count half.
export function weightedAuc(rows,key,threshold) {
  let num=0,den=0;
  for(const p of rows)if(p.gt_ordinal>=threshold)for(const n of rows)if(n.gt_ordinal<threshold){const w=p.gt_confidence*n.gt_confidence;den+=w;num+=w*(p[key]>n[key]?1:p[key]===n[key]?.5:0);}
  return den?num/den:null;
}
export function versionMetrics(rows,version,thresholds) {
  const key=`score_${version}`,graded=rows.map(r=>({...r,predicted_ordinal:gradeScore(r[key],thresholds)})),m=productMetrics(graded),last=primaryLast(rows);
  return {product_loss:m.product_loss,ge2_recall:m.target_ge2.recall,ge2_precision:m.target_ge2.precision,ge3_recall:m.target_ge3.recall,ge3_precision:m.target_ge3.precision,
    auc_ge2_primary_last:weightedAuc(last,key,2),auc_ge3_primary_last:weightedAuc(last,key,3)};
}
export function rollbackSuggested(rule,candidate,control) {
  if(rule==='AUC_GE3_NOT_HIGHER_OR_PRODUCT_LOSS_HIGHER')return !(candidate.auc_ge3_primary_last>control.auc_ge3_primary_last)||candidate.product_loss>control.product_loss;
  if(rule==='PRODUCT_LOSS_HIGHER_OR_GE2_RECALL_DROP_OVER_0_05')return candidate.product_loss>control.product_loss||candidate.ge2_recall<control.ge2_recall-.05;
  fail('UNKNOWN_ROLLBACK_RULE');
}
// Deterministic date-block bootstrap of candidate − control differences.
export function bootstrapDeltas(rows,thresholdsByVersion,policy=HOLDOUT_POLICY) {
  const dates=[...new Set(rows.map(r=>r.event_date_local))].sort(),byDate=new Map(dates.map(d=>[d,rows.filter(r=>r.event_date_local===d)]));
  let state=Number.parseInt(hash(policy.bootstrap.seed).slice(0,8),16)>>>0;
  const rnd=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const keys=['product_loss','ge2_recall','auc_ge2_primary_last','auc_ge3_primary_last'],acc=Object.fromEntries(policy.comparisons.map(c=>[c.id,Object.fromEntries(keys.map(k=>[k,[]]))]));
  for(let b=0;b<policy.bootstrap.replicates;b++){
    const sample=Array.from(dates,()=>dates[Math.floor(rnd()*dates.length)]).flatMap((d,i)=>byDate.get(d).map(r=>({...r,snapshot_id:`${r.snapshot_id}#${i}`,event_id:`${r.event_id}#${i}`})));
    const weighted=weightedRows(sample),metrics=Object.fromEntries(policy.versions.map(v=>[v,versionMetrics(weighted,v,thresholdsByVersion[v])]));
    for(const c of policy.comparisons)for(const k of keys){const d=metrics[c.candidate][k]-metrics[c.control][k];if(Number.isFinite(d))acc[c.id][k].push(d);}
  }
  const summary=(values,betterIsLower)=>{const s=[...values].sort((a,b)=>a-b),at=p=>s.length?s[Math.min(s.length-1,Math.floor(p*s.length))]:null;
    return {replicates:s.length,ci95:[at(.025),at(.975)],probability_better:s.length?s.filter(v=>betterIsLower?v<0:v>0).length/s.length:null};};
  return Object.fromEntries(Object.entries(acc).map(([id,v])=>[id,Object.fromEntries(keys.map(k=>[k,summary(v[k],k==='product_loss')]))]));
}

// dev / ledger / policy are injectable for tests only; the CLI always uses the V6 pool, the default ledger and HOLDOUT_POLICY.
export async function holdoutStatus(sources,{root=APP_ROOT,progress=()=>{},dev=null,policy=HOLDOUT_POLICY}={}) {
  const loaded=await loadPool(sources,progress);dev??=await devMembers(root);
  return {policy:policy.name,scope:'LABEL_COUNTS_ONLY_NO_PREDICTION_COMPUTED',source_ids:loaded.source_ids,labeled_rows:loaded.rows.length,
    unlabeled_or_unavailable:loaded.exclusions.length,independence:independence(loaded.rows,dev,policy),readiness:readiness(loaded.rows,policy),
    note:'Replay 预检排除可能使正式核验时的计数略少。'};
}

async function ledgerEntries(ledger) {
  try{return (await readFile(ledger,'utf8')).split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));}catch(e){if(e.code==='ENOENT')return [];throw e;}
}
export async function holdoutCheck(sources,output,{root=APP_ROOT,progress=()=>{},dev=null,ledger=LEDGER,policy=HOLDOUT_POLICY}={}) {
  output=await safeOutput(output,root);
  if((await ledgerEntries(ledger)).some(e=>e.policy===policy.name&&e.policy_version===policy.version))fail('HOLDOUT_ALREADY_USED');
  const loaded=await loadPool(sources,progress),code=await codeIdentity();dev??=await devMembers(root);
  const guard=independence(loaded.rows,dev,policy);if(!guard.independent)fail('HOLDOUT_OVERLAPS_DEV',{detail:canonicalJson(guard)});
  const before=readiness(loaded.rows,policy);if(!before.ready)fail('HOLDOUT_BELOW_THRESHOLD',{detail:canonicalJson(before.shortfalls)});
  const configs=await releaseConfigs(root);assertV2550(dev.selected,configs['2.5.5.0']);
  const thresholds=Object.fromEntries(policy.versions.map(v=>[v,gradeThresholdsOf(configs[v])]));
  const calculator=replayCalculator(code.engine_sha256),checked=await preflight(loaded,configs['2.5.5.0'],calculator,progress);
  const ready=readiness(checked.rows,policy);if(!ready.ready)fail('HOLDOUT_BELOW_THRESHOLD_AFTER_REPLAY_EXCLUSIONS',{detail:canonicalJson(ready.shortfalls)});
  const rows=[];
  for(const [i,row]of checked.rows.entries()){
    const scored={snapshot_id:row.snapshot_id,event_id:row.event_id,event_date_local:row.event_date_local,city:row.city??null,gt_ordinal:row.gt_ordinal,gt_confidence:row.gt_confidence,
      event_normalized_weight:row.event_normalized_weight,lead_time_minutes:row.lead_time_minutes,location_key:row.location_key,model_version:row.model_version??null};
    for(const v of policy.versions)scored[`score_${v}`]=(await calculator.calculate(row,configs[v])).score;
    rows.push(scored);
    if((i+1)%100===0||i+1===checked.rows.length)progress(`H1 核验 ${i+1}/${checked.rows.length}：各版本重算`);
  }
  const metrics=Object.fromEntries(policy.versions.map(v=>[v,versionMetrics(rows,v,thresholds[v])]));
  progress(`按日期整块抽样（${policy.bootstrap.replicates} 次）`);
  const deltas=bootstrapDeltas(rows,thresholds,policy);
  const comparisons=policy.comparisons.map(c=>({...c,rollback_suggested:rollbackSuggested(c.rollback_rule,metrics[c.candidate],metrics[c.control]),
    point_difference:Object.fromEntries(Object.keys(metrics[c.candidate]).map(k=>[k,metrics[c.candidate][k]==null||metrics[c.control][k]==null?null:metrics[c.candidate][k]-metrics[c.control][k]])),
    bootstrap:deltas[c.id]}));
  await checkInputs(loaded);if((await codeIdentity()).sha256!==code.sha256)fail('CODE_CHANGED_DURING_HOLDOUT');
  const result={status:'COMPLETE',scope:'FORWARD_HOLDOUT_SINGLE_USE; DECISION_BY_PROJECT_OWNER',policy,source_ids:loaded.source_ids,
    snapshot_count:rows.length,excluded_count:checked.exclusions.length,readiness:ready,independence:guard,grade_thresholds:thresholds,
    config_sha256:Object.fromEntries(policy.versions.map(v=>[v,hash(canonicalJson(configs[v]))])),metrics,comparisons,
    predictions_sha256:digest(rows.map(r=>[r.snapshot_id,...policy.versions.map(v=>r[`score_${v}`])])),code_sha256:code.sha256,engine_sha256:code.engine_sha256};
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'holdout_result.json'),canonicalJson(result)+'\n');
  await writeFile(path.join(output,'holdout_inputs.json'),canonicalJson({fingerprints:loaded.fingerprints,exclusions:checked.exclusions,configs})+'\n');
  const headers=Object.keys(rows[0]);
  await writeFile(path.join(output,'holdout_predictions.csv'),headers.join(',')+'\r\n'+rows.map(r=>headers.map(k=>String(r[k]??'')).join(',')).join('\r\n')+'\r\n');
  await writeFile(path.join(output,'report.md'),report(result).replace(/\r?\n/g,'\r\n'));
  await mkdir(path.dirname(ledger),{recursive:true});
  await appendFile(ledger,canonicalJson({policy:policy.name,policy_version:policy.version,source_ids:loaded.source_ids,result_sha256:hash(canonicalJson(result))})+'\n');
  return {status:result.status,output,snapshots:rows.length,rollback_suggested:Object.fromEntries(comparisons.map(c=>[c.id,c.rollback_suggested]))};
}
function report(r) {
  const versions=r.policy.versions,f=x=>x==null?'—':Number(x).toFixed(3),row=(label,k)=>`| ${label} | ${versions.map(v=>f(r.metrics[v][k])).join(' | ')} |`;
  const c0=r.readiness.counts,lines=['# H1 前向留出核验（发布线）','',
    `数据：${r.snapshot_count} 条 Snapshot，${c0.events} 个 Event，${c0.dates} 天；GT≥2 Event ${c0.ge2_events}，GT≥3 Event ${c0.ge3_events}。各版本按自身等级线判级。结论由项目负责人决定。`,'',
    `| 指标 | ${versions.join(' | ')} |`,`| --- |${versions.map(()=>' --- |').join('')}`,row('产品损失','product_loss'),row('≥2 召回','ge2_recall'),row('≥2 精确','ge2_precision'),
    row('≥3 召回','ge3_recall'),row('≥3 精确','ge3_precision'),row('AUC≥2（最近一条）','auc_ge2_primary_last'),row('AUC≥3（最近一条）','auc_ge3_primary_last'),''];
  for(const c of r.comparisons){
    lines.push(`## ${c.candidate} 对 ${c.control}`,'',`回退规则：${c.rollback_rule}。**${c.rollback_suggested?'建议回退':'不触发回退'}**。`,'','| 差值（候选 − 对照） | 点估计 | 95% 区间 | 变好的概率 |','| --- | --- | --- | --- |');
    for(const [k,label] of [['product_loss','产品损失'],['ge2_recall','≥2 召回'],['auc_ge2_primary_last','AUC≥2'],['auc_ge3_primary_last','AUC≥3']])
      lines.push(`| ${label} | ${f(c.point_difference[k])} | ${f(c.bootstrap[k].ci95[0])} ~ ${f(c.bootstrap[k].ci95[1])} | ${f(c.bootstrap[k].probability_better)} |`);
    lines.push('');
  }
  return lines.join('\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [command,...args]=process.argv.slice(2),flags={};
    for(let i=0;i<args.length;i+=2){if(!['--raw','--gt','--model','--output'].includes(args[i])||!args[i+1]||flags[args[i]])fail('INVALID_ARGUMENTS');flags[args[i]]=path.resolve(args[i+1]);}
    if(!flags['--raw']||!flags['--gt']||!flags['--model'])fail('INVALID_ARGUMENTS');
    const sources={raw:flags['--raw'],gt:flags['--gt'],model:flags['--model']};
    let result;
    if(command==='status')result=await holdoutStatus(sources,{progress:console.error});
    else if(command==='check'&&flags['--output'])result=await holdoutCheck(sources,flags['--output'],{progress:console.error});
    else fail('USAGE_STATUS_OR_CHECK');
    console.log(canonicalJson(result));
  }catch(e){console.error(e.code??e.message);if(e.detail)console.error(e.detail);process.exitCode=1;}
}
