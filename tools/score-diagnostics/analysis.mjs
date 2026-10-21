import { compare } from '../dataset/lib/common.mjs';
import { digest } from '../optimization-diagnostics/engine.mjs';
import { weights, support, supported, weightedQuantile, pairStatistic, q } from './statistics.mjs';
import { scorePolicy } from './policy.mjs';

export function cases(rows) {
  const selected=[];
  for(let ordinal=0;ordinal<5;ordinal++) {
    const grade=weights(rows.filter(r=>r.gt_ordinal===ordinal));
    for(const direction of ['OVER','UNDER']) {
      const seen=new Set();let rank=0;
      for(const r of grade.filter(r=>direction==='OVER'?r.control_ordinal>ordinal:r.control_ordinal<ordinal)
        .sort((a,b)=>b.weight*Math.abs(b.control_ordinal-ordinal)-a.weight*Math.abs(a.control_ordinal-ordinal)||compare(a.snapshot_id,b.snapshot_id))) {
        if(seen.has(r.event_id))continue;seen.add(r.event_id);selected.push({ordinal,direction,rank:++rank,snapshot_id:r.snapshot_id,event_id:r.event_id,
          weighted_abs_error:q(r.weight*Math.abs(r.control_ordinal-ordinal))});if(rank===3)break;
      }
    }
    const control=grade.sort((a,b)=>Math.abs(a.control_ordinal-ordinal)-Math.abs(b.control_ordinal-ordinal)||compare(a.snapshot_id,b.snapshot_id))[0];
    if(control)selected.push({ordinal,direction:'MIN_ERROR_CONTROL',rank:1,snapshot_id:control.snapshot_id,event_id:control.event_id,weighted_abs_error:q(control.weight*Math.abs(control.control_ordinal-ordinal))});
  }
  return {selection_rule:scorePolicy().case_rule,members:selected,members_sha256:digest(selected)};
}
const paths={atmosphere_quality:'scoring.atmosphereQuality',horizon_gate:'scoring.horizonGate',structure_bonus:'scoring.spatialEvolution.structure',
  transition_bonus:'scoring.weatherRegime.transitionBonusPerStep',weather_penalty:'scoring.penalty',core_clamp:'engine.clamp',hard_gate:'scoring.hardGate',core_round:'engine.Math.round',
  sky_evolution:'skyState',golden_window:'goldenWindow',final_clamp:'replay.clamp',final_round:'replay.Math.round',weighted_components:'scoring.weights'};
const stageRows=(rows,traces,stage)=>weights(rows.map(r=>{const s=traces.get(r.snapshot_id)?.stages.find(s=>s.stage===stage);return {
  ...r,before:s?.input_score??null,after:s?.output_score??null,change:s?.input_score==null?null:s.output_score-s.input_score };}));
export function stageAnalysis(rows,traceRows,caseManifest) {
  const traces=new Map(traceRows.map(r=>[r.snapshot_id,r.trace]));
  const stages=[...new Set(traceRows.flatMap(r=>r.trace?.stages.map(s=>s.stage)||[]))];
  const summarize=(rs,stage)=>{const ws=stageRows(rs,traces,stage),available=ws.filter(r=>Number.isFinite(r.change));
    const width=key=>{const p10=weightedQuantile(available,key,.1),p90=weightedQuantile(available,key,.9);return p10===null?null:q(p90-p10);};
    const before=width('before'),after=width('after'),W=available.reduce((s,r)=>s+r.weight,0);
    return {...support(rs),available_samples:available.length,reason_code:available.length?null:'STAGE_INPUT_UNAVAILABLE',
      before_p10:weightedQuantile(available,'before',.1),before_p50:weightedQuantile(available,'before',.5),before_p90:weightedQuantile(available,'before',.9),
      after_p10:weightedQuantile(available,'after',.1),after_p50:weightedQuantile(available,'after',.5),after_p90:weightedQuantile(available,'after',.9),
      delta_p10:weightedQuantile(available,'change',.1),delta_p50:weightedQuantile(available,'change',.5),delta_p90:weightedQuantile(available,'change',.9),
      mean_delta:W?q(available.reduce((s,r)=>s+r.weight*r.change,0)/W):null,
      change_rate:W?q(available.filter(r=>r.change!==0).reduce((s,r)=>s+r.weight,0)/W):null,
      compression_ratio:before>0?q(after/before):null,rank_before:pairStatistic(ws,'before',true),rank_after:pairStatistic(ws,'after',true),
      auc_before:pairStatistic(ws,'before'),auc_after:pairStatistic(ws,'after'),
      supported:supported(rs,5,2)};};
  const summaries=stages.map(stage=>({stage,trace_path:`stage_trace.json/trace/stages/${stage}`,config_path:paths[stage]||'NOT_AVAILABLE',
    ...summarize(rows,stage),slices:['gt_ordinal','error_direction','lead_time_bucket','regime_label'].flatMap(dimension=>
      [...new Set(rows.map(r=>r[dimension]))].sort(compare).map(value=>({dimension,value,...summarize(rows.filter(r=>r[dimension]===value),stage)}))),
    fair_vs_high:{fair:summarize(rows.filter(r=>r.gt_ordinal===1),stage),high:summarize(rows.filter(r=>r.gt_ordinal>=2),stage)} }));
  const numericKeys=[...new Set(traceRows.flatMap(r=>Object.entries(r.trace||{}).flatMap(([key,value])=>typeof value==='number'?[key]:
    ['components','dynamic_weights','contributions','atmosphere_inputs'].includes(key)?Object.keys(value).map(k=>`${key}.${k}`):[])))].sort(compare);
  const components=numericKeys.map(key=>{const rs=weights(rows.map(r=>{const value=key.split('.').reduce((o,k)=>o?.[k],traces.get(r.snapshot_id));
    return {...r,value:Number.isFinite(value)?value:null};}).filter(r=>r.value!==null));return {path:key,natural_direction:'RAW_INCREASING_VALUE_NO_POSTHOC_FLIP',
      ...support(rs),auc:pairStatistic(rs,'value'),missing_samples:rows.length-rs.length,binary_support:[false,true].map(high=>support(rs.filter(r=>(r.gt_ordinal>=2)===high))),
      reason_code:rs.length?null:'NOT_AVAILABLE'};});
  const hypotheses=summaries.filter(s=>s.supported&&s.fair_vs_high.fair.supported&&s.fair_vs_high.high.supported&&
    (s.rank_after.value!==null&&s.rank_before.value!==null&&s.rank_after.value-s.rank_before.value<=-scorePolicy().module_localization.minimum_rank_drop||
      s.compression_ratio!==null&&s.compression_ratio<=scorePolicy().module_localization.maximum_p10_p90_compression_ratio)&&
    traceRows.every(r=>r.trace?.status==='COMPLETE_REPLAY_PATH')&& !['sky_evolution','golden_window'].includes(s.stage))
    .map(s=>{const affected=stageRows(rows,traces,s.stage).filter(r=>r.change!==0);
      const errorCases=caseManifest.members.filter(c=>c.direction!=='MIN_ERROR_CONTROL'&&affected.some(r=>r.snapshot_id===c.snapshot_id));
      return {stage:s.stage,config_path:s.config_path,trace_path:s.trace_path,affected_support:support(affected),
        supported:supported(affected,5,2)&&supported(affected.filter(r=>r.gt_ordinal===1),5,2)&&supported(affected.filter(r=>r.gt_ordinal>=2),5,2),
        affected_fair_support:support(affected.filter(r=>r.gt_ordinal===1)),affected_high_support:support(affected.filter(r=>r.gt_ordinal>=2)),
        rank_before:s.rank_before,rank_after:s.rank_after,compression_ratio:s.compression_ratio,
        case_snapshot_ids:errorCases.map(c=>c.snapshot_id),hypothesis:'STAGE_MAY_COMPRESS_OR_REORDER_USEFUL_GRADE_SIGNAL',
        confounders:['SHARED_WEATHER_INPUTS','CORRELATED_COMPONENTS','GT_NOISE','COHORT_COMPOSITION'],
        alternative_explanation:'VALID_WEATHER_OR_VISIBILITY_GATE_ON_DIFFICULT_CASES',
        required_experiment:'NEW_PLAN_SINGLE_STAGE_COUNTERFACTUAL_WITH_ALL_OTHER_CONFIG_AND_COHORT_FIXED',
        causal_claim:false};}).filter(h=>h.supported&&h.case_snapshot_ids.length).slice(0,2);
  return {stages:summaries,components,module_hypotheses:hypotheses,causal_claim:false,
    limitation:'TRACE_ASSOCIATIONS_ARE_NOT_SINGLE_MODULE_CAUSAL_EFFECTS'};
}
export function route({blocked,signal,boot,folds,control,calibration,noSkill,stages}) {
  const eps=scorePolicy().routing.epsilon,interval=boot?.intervals;
  const checks=[];const add=(id,pass,evidence)=>checks.push({id,pass:!!pass,evidence});
  add('COHORT_SUPPORT',signal?.main_support&&signal?.binary_support_sufficient,'discrimination.json/OOF');
  add('THREE_FOLDS',folds.length===3&&folds.every(f=>f.status==='FITTED'),'fold_calibrators.json');
  add('SCORE_SIGNAL',signal?.auc.value>=.6&&interval?.auc.status==='COMPUTED'&&interval.auc.ci_lower>.5&&
    signal?.ordered_consistency.value>.5&&interval?.ordered_consistency.status==='COMPUTED','discrimination.json/OOF; bootstrap.json/auc');
  const le=(a,b)=>a!==null&&a!==undefined&&b!==null&&b!==undefined&&a<=b+eps;
  const ge=(a,b)=>a!==null&&a!==undefined&&b!==null&&b!==undefined&&a+eps>=b;
  add('CALIBRATED_MAE',calibration?.mae!=null&&control?.mae!=null&&noSkill?.mae!=null&&calibration.mae<control.mae-eps&&calibration.mae<noSkill.mae-eps,'oof_metrics.json');
  add('CALIBRATED_BASIC',le(Math.abs(calibration?.bias??NaN),Math.abs(control?.bias??NaN))&&
    (control?.qwk==null||ge(calibration?.qwk,control?.qwk))&&
    le(calibration?.severe_error_rate,control?.severe_error_rate)&&ge(calibration?.within_1_accuracy,control?.within_1_accuracy)&&ge(calibration?.high_grade_recall,control?.high_grade_recall),'oof_metrics.json');
  add('CALIBRATED_CI',interval?.delta_mae.status==='COMPUTED'&&interval.delta_mae.ci_upper < -eps,'bootstrap.json/delta_mae');
  const calibrationSupported=checks.filter(c=>['THREE_FOLDS','CALIBRATED_MAE','CALIBRATED_BASIC','CALIBRATED_CI'].includes(c.id)).every(c=>c.pass);
  const enough=checks.filter(c=>['COHORT_SUPPORT','THREE_FOLDS'].includes(c.id)).every(c=>c.pass);
  const scoreSupported=checks.find(c=>c.id==='SCORE_SIGNAL').pass&&enough;
  const recommendation=blocked?'BLOCKED':!enough?'COLLECT_MORE_EVIDENCE':scoreSupported&&calibrationSupported?'CALIBRATION_RESEARCH':
    !calibrationSupported&&stages.module_hypotheses.length?'MODULE_RESEARCH':'INCONCLUSIVE';
  return {execution_status:blocked?'BLOCKED':'COMPLETED',recommendation,score_signal_supported:scoreSupported,
    calibration_supported:calibrationSupported,checks,result_usage:'DEVELOPMENT_ONLY',formal_promotion_allowed:false,
    selected:null,test_evaluated:false,validation_evaluated:false,module_hypotheses:recommendation==='MODULE_RESEARCH'?stages.module_hypotheses:[],
    reason_codes:blocked?['REFERENCE_CONTROL_OR_TRACE_INCONSISTENCY']:checks.filter(c=>!c.pass).map(c=>c.id),
    limitations:['TRAIN_DEVELOPMENT_EVIDENCE_ONLY','OOF_IS_THREE_DISTINCT_FITTED_MAPPINGS','NO_FULL_TRAIN_MAPPING_FITTED','NO_CAUSAL_MODULE_CLAIM']};
}
