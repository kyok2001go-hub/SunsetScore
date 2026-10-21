import { canonicalJson, compare, fail } from '../dataset/lib/common.mjs';
import { digest, members, cohortDigest, dateFolds, estimateNoSkill } from '../optimization-diagnostics/engine.mjs';
import { buildModelConfig, cloneConfig } from '../tuning/lib/base-config.mjs';
import { scoreToOrdinal } from '../evaluation/metrics.mjs';
import { bootstrapSeed } from '../validation/lib/stability.mjs';
import { scorePolicy, scoreSchema } from './policy.mjs';
import { metrics, discrimination, distribution, bootstrap, fitPava, predictPava, closest, q, weights } from './statistics.mjs';
import { cases, stageAnalysis, route } from './analysis.mjs';

export function makeScorePlan({cohort,input,sourceManifest,parentPlan}) {
  const folds=parentPlan.files['plan.json'].fold_assignments;
  if(digest(folds)!==digest(dateFolds(cohort)))fail('SCORE_FROZEN_FOLD_MISMATCH');
  const core={score_diagnostic_schema_version:1,score_diagnostic_policy_version:1,result_usage:'DEVELOPMENT_ONLY',
    policy:scorePolicy(),source_manifest_sha256:digest(sourceManifest),train_members:members(cohort),cohort_sha256:cohortDigest(cohort),
    control_config:input.sensitivity.baseConfig.config,control_config_sha256:input.sensitivity.baseConfig.sha256,
    fold_assignments:folds,computation_access_policy:'TRAIN_ONLY',validation_evaluated:false,test_evaluated:false};
  return {...core,plan_core_sha256:digest(core),bootstrap_seed:bootstrapSeed(digest(core))};
}
export function fitFolds(rows,foldAssignments) {
  const folds=[],oof=[];
  for(const fold of foldAssignments.folds) {
    const ids=new Set(fold.train_members.map(r=>r.snapshot_id));
    const training=rows.filter(r=>ids.has(r.snapshot_id));
    const mapping=fitPava(training),noSkill=estimateNoSkill(training);
    const frozen={fold:fold.fold,...mapping,train_members:members(training),no_skill_ordinal:noSkill,
      mapping_sha256:digest(mapping),frozen_before_holdout:true};
    folds.push(frozen);
    if(mapping.status!=='FITTED')continue;
    // This is the first evaluation of held labels, after the fold's map and no-skill are frozen.
    const heldIds=new Set(fold.held_members.map(r=>r.snapshot_id));
    for(const r of rows.filter(r=>heldIds.has(r.snapshot_id))) {
      const estimate=predictPava(mapping,r.score);
      oof.push({...r,fold:fold.fold,mapping_sha256:frozen.mapping_sha256,calibrated_estimate:estimate.ordinal_estimate,
        calibrated_ordinal:estimate.ordinal,no_skill_ordinal:noSkill});
    }
  }
  return {folds,oof:oof.sort((a,b)=>compare(a.snapshot_id,b.snapshot_id))};
}
const normalize=value=>typeof value==='number'?q(value):Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?
  Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)])):value;
function inputAudit(row,trace) {
  const replay=row.replay,when=Date.parse(replay.identity.prediction_time_utc),sunset=Date.parse(replay.context.sunset_time_utc);
  const fields=['cloud_cover','cloud_cover_low','cloud_cover_mid','cloud_cover_high','visibility','relative_humidity_2m',
    'precipitation','precipitation_probability','surface_pressure','wind_speed_10m','wind_direction_10m'];
  return {snapshot_id:row.snapshot_id,replay_sha256:digest(replay),prediction_time_utc:replay.identity.prediction_time_utc,
    sunset_time_utc:replay.context.sunset_time_utc,minutes_to_sunset:q((sunset-when)/60000),
    collection_time_utc:null,collection_time_reason_code:'NOT_AVAILABLE',nwp_issue_time_utc:null,nwp_issue_time_reason_code:'NOT_AVAILABLE',
    sampling_mode:replay.engine_inputs.sampling_mode,cache_status:replay.engine_inputs.cache_status??null,
    data_age_minutes:replay.engine_inputs.data_age_minutes??null,spatial_completeness:replay.engine_inputs.spatial_completeness??null,
    nwp_nodes:replay.nwp.nodes.map((node,index)=>({node_index:index,time_start_utc:node.time_utc[0]??null,time_end_utc:node.time_utc.at(-1)??null,
      covers_prediction:node.time_utc.some(t=>Date.parse(t)<=when)&&node.time_utc.some(t=>Date.parse(t)>=when),
      covers_sunset:node.time_utc.some(t=>Date.parse(t)<=sunset)&&node.time_utc.some(t=>Date.parse(t)>=sunset),
      fields:fields.map(field=>{const series=node.variables[field];return {field,available:Array.isArray(series),
        zero_count:series?.filter(v=>v===0).length??null,missing_count:series?.filter(v=>!Number.isFinite(v)).length??null,
        reason_code:Array.isArray(series)?null:'NOT_AVAILABLE'};})})),
    sources:['minute_precip','radar','satellite','air_quality'].map(source=>({source,available:replay[source]?.available??null,
      status:replay[source]?.source_status??null,reason_code:replay[source]?'HISTORICAL_PAYLOAD_ONLY':'NOT_AVAILABLE'})),
    actual_atmosphere_inputs:trace?.atmosphere_inputs??null,
    limitation:'COVERAGE_AND_READY_DO_NOT_PROVE_FORECAST_PHASE_OR_COLLECTION_TIME_CORRECT'};
}
export async function computeScoreDiagnostics({plan,sourceManifest,cohort,input,parentPlan,parentResult,runReplay,oldControl,progress}) {
  if(digest(makeScorePlan({cohort,input,sourceManifest,parentPlan}))!==digest(plan))fail('SCORE_PLAN_SOURCE_CHANGED');
  const config=buildModelConfig(cloneConfig(plan.control_config));
  const old=new Map(oldControl.map(r=>[r.snapshot_id,r]));
  const historical=new Map(parentResult.files['sample_diagnostics.json'].filter(r=>r.matrix_label==='CONTROL').map(r=>[r.snapshot_id,r]));
  if(old.size!==cohort.length||historical.size!==cohort.length)fail('SCORE_CONTROL_MEMBERS_MISMATCH');
  const parity=[],compatibility=[],rows=[],traces=[],audit=[];
  for(const row of cohort) {
    try {
      const reference=await runReplay(row.replay,{reference:row});
      const plain=await runReplay(row.replay,{modelConfig:config});
      const observed=await runReplay(row.replay,{modelConfig:config,trace:true});
      const previous=old.get(row.snapshot_id),history=historical.get(row.snapshot_id),trace=observed.trace;
      const chain=trace?.stages||[];
      const continuous=canonicalJson(chain.map(s=>s.stage))===canonicalJson(plan.policy.required_trace_stages)&&
        chain.every((s,i)=>Number.isFinite(s.output_score)&&(i===0||s.input_score===chain[i-1].output_score));
      const match=previous?.actual&&canonicalJson(previous.actual)===canonicalJson(plain.actual)&&canonicalJson(plain.actual)===canonicalJson(observed.actual);
      const pass=!!(match&&trace?.status==='COMPLETE_REPLAY_PATH'&&trace.final_score===plain.actual.score&&chain.at(-1)?.output_score===plain.actual.score&&continuous&&plain.actual.score===history?.control_score);
      parity.push({snapshot_id:row.snapshot_id,reference_pass:reference.pass===true,source_reference_pass:previous?.reference_pass===true,
        historical_control_score:history?.control_score??null,source_control_score:previous?.actual?.score??null,control_score:plain.actual.score,
        pass:reference.pass===true&&previous?.reference_pass===true&&pass,
        reason_code:reference.pass===true&&previous?.reference_pass===true&&pass?null:'REFERENCE_CONTROL_OR_TRACE_MISMATCH'});
      compatibility.push({snapshot_id:row.snapshot_id,pass,trace_on_off_equal:canonicalJson(plain.actual)===canonicalJson(observed.actual),
        old_new_equal:!!match,stage_chain_equal:continuous,source_output_sha256:previous?.actual?digest(previous.actual):null,new_output_sha256:digest(plain.actual)});
      traces.push({snapshot_id:row.snapshot_id,event_id:row.event_id,trace:trace??null});audit.push(inputAudit(row,trace));
      rows.push({snapshot_id:row.snapshot_id,event_id:row.event_id,location_key:row.location_key,event_date_local:row.event_date_local,
        gt_ordinal:row.gt_ordinal,gt_confidence:row.gt_confidence,lead_time_minutes:row.lead_time_minutes,
        lead_time_bucket:row.lead_time_bucket,regime_label:row.regime_label,score:plain.actual.score,rounded_score:true,
        control_ordinal:scoreToOrdinal(plain.actual.score),error_direction:scoreToOrdinal(plain.actual.score)>row.gt_ordinal?'OVER':scoreToOrdinal(plain.actual.score)<row.gt_ordinal?'UNDER':'EXACT',
        replay_sha256:digest(row.replay)});
    }catch(error) {parity.push({snapshot_id:row.snapshot_id,pass:false,reason_code:error.code||'REPLAY_OR_TRACE_FAILED'});
      compatibility.push({snapshot_id:row.snapshot_id,pass:false,reason_code:'REPLAY_OR_TRACE_FAILED'});}
    progress?.update(`Control 与 trace 复核 ${parity.length}/${cohort.length}`);
  }
  const blocked=parity.length!==cohort.length||parity.some(r=>!r.pass);
  // No silently reduced analysis cohort: any failed sample blocks all effect routing and fitting.
  const analysisRows=blocked?[]:rows;
  const fitted=blocked?{folds:[],oof:[]}:fitFolds(analysisRows,plan.fold_assignments);
  const benchmarkRows={ALL_PRIMARY:analysisRows,CLOSEST_PRE_SUNSET:closest(analysisRows),OOF:fitted.oof,OOF_CLOSEST_PRE_SUNSET:closest(fitted.oof)};
  progress?.stage('计算固定区分统计、三折校准与 2000 次日期块 Bootstrap');
  const discriminationReport=Object.fromEntries(Object.entries(benchmarkRows).map(([key,rs])=>[key,discrimination(rs)]));
  const boot=bootstrap(fitted.oof,plan.bootstrap_seed);
  const bootFull=bootstrap(analysisRows,plan.bootstrap_seed);
  const primary={control:metrics(fitted.oof),calibration:metrics(fitted.oof,'calibrated_ordinal'),no_skill:metrics(fitted.oof,'no_skill_ordinal')};
  const compareRows=rs=>({control:metrics(rs),calibration:metrics(rs,'calibrated_ordinal'),no_skill:metrics(rs,'no_skill_ordinal')});
  const sliceReport=['location_key','lead_time_bucket','regime_label'].flatMap(dimension=>[...new Set(fitted.oof.map(r=>r[dimension]))].sort(compare).map(value=>{
    const rs=fitted.oof.filter(r=>r[dimension]===value);return {dimension,value,exploratory:true,...compareRows(rs),support_sufficient:new Set(rs.map(r=>r.event_id)).size>=5&&new Set(rs.map(r=>r.event_date_local)).size>=2};}));
  const dateReport=[...new Set(fitted.oof.map(r=>r.event_date_local))].sort(compare).map(date=>({event_date_local:date,...compareRows(fitted.oof.filter(r=>r.event_date_local===date))}));
  const caseManifest={ALL_PRIMARY:cases(analysisRows),OOF:cases(fitted.oof)},stages=stageAnalysis(fitted.oof,traces,caseManifest.OOF);
  const decision=route({blocked,signal:discriminationReport.OOF,boot,folds:fitted.folds,...primary,noSkill:primary.no_skill,stages});
  const summary=`# V2.5.4.6 评分诊断\n\n执行：${decision.execution_status}。研究路线：${decision.recommendation}。\n\n`+
    `评分信号支持：${decision.score_signal_supported}；校准支持：${decision.calibration_supported}。\n\n`+
    `OOF Control MAE=${primary.control.mae}，校准 MAE=${primary.calibration.mae}，no-skill MAE=${primary.no_skill.mae}。\n\n`+
    `高等级分数 AUC=${discriminationReport.OOF.auc.value}，95% CI=[${boot.intervals.auc.ci_lower}, ${boot.intervals.auc.ci_upper}]。\n\n`+
    `有序一致率=${discriminationReport.OOF.ordered_consistency.value}。完整门槛及证据见 decision.json。\n\n`+
    `本报告仅为 TRAIN 开发证据。三个折映射未合并为已验证的全量模型；未拟合全 TRAIN 映射。未访问 VALIDATION/TEST 效果，未生成正式 selected。\n\n`+
    `输入时相审计见 input_quality.json；缺失历史字段为 NOT_AVAILABLE。stage 前后差异及分项 AUC 不代表因果效应。\n`;
  const payloads=normalize({'schema.json':scoreSchema(),'policy.json':scorePolicy(),'plan.json':plan,'source_manifest.json':sourceManifest,
    'reference_parity.json':{rows:parity,status:blocked?'BLOCKED':'PASS'},
    'trace_compatibility.json':{status:compatibility.every(r=>r.pass)?'PASS':'BLOCKED',scope:'DEVELOPMENT_OBSERVATIONAL_COMPATIBILITY_ONLY',
      formal_cross_runtime_authorization:false,source_runtime:sourceManifest.source_runtime,diagnostic_runtime:sourceManifest.runtime,rows:compatibility},
    'input_quality.json':{rows:audit,reason_code:blocked?'EFFECT_ANALYSIS_BLOCKED':null},
    'score_distribution.json':Object.fromEntries(Object.entries(benchmarkRows).map(([key,rs])=>[key,distribution(rs)])),
    'discrimination.json':discriminationReport,'confusion.json':Object.fromEntries(Object.entries(benchmarkRows).map(([key,rs])=>[key,metrics(rs)])),
    'stage_trace.json':traces,'stage_summary.json':{OOF:stages,FULL_TRAIN:stageAnalysis(analysisRows,traces,caseManifest.ALL_PRIMARY)},'case_manifest.json':caseManifest,
    'fold_assignments.json':plan.fold_assignments,'fold_calibrators.json':fitted.folds,'oof_predictions.json':weights(fitted.oof),
    'oof_metrics.json':{...primary,closest_pre_sunset:compareRows(closest(fitted.oof)),folds:fitted.folds.map(f=>({fold:f.fold,...compareRows(fitted.oof.filter(r=>r.fold===f.fold))})),slices:sliceReport,dates:dateReport},
    'bootstrap.json':{OOF:boot,FULL_TRAIN:bootFull},'decision.json':decision,'reports/summary.md':summary});
  // Identity documents retain their original frozen bytes/precision. Quantization applies to
  // newly computed statistics and traces, never retroactively to an upstream configuration.
  Object.assign(payloads,{'plan.json':plan,'source_manifest.json':sourceManifest,'policy.json':scorePolicy(),
    'schema.json':scoreSchema(),'fold_assignments.json':plan.fold_assignments});
  return payloads;
}
