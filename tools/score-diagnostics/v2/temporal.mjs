import { compare } from '../../dataset/lib/common.mjs';
import { computeLeadTimeBucket } from '../../evaluation/metrics.mjs';
import { support } from '../statistics.mjs';
import { normalize, digest } from './common.mjs';

export const NWP_FIELDS=['cloud_cover','cloud_cover_low','cloud_cover_mid','cloud_cover_high','visibility','relative_humidity_2m',
  'precipitation','precipitation_probability','surface_pressure','wind_speed_10m','wind_direction_10m',
  'wind_speed_850hPa','wind_direction_850hPa','wind_speed_700hPa','wind_direction_700hPa','wind_speed_500hPa','wind_direction_500hPa'];
export const TEMPORAL_REPLAY_PATHS=['identity.snapshot_id','identity.event_id','identity.prediction_time_utc','context.latitude','context.longitude',
  'context.timezone','context.utc_offset_seconds','context.sunset_time_utc','nwp.nodes[*].time_utc','nwp.nodes[*].variables.<NWP_FIELDS>',
  'air_quality.available','air_quality.time_utc','air_quality.variables.aerosol_optical_depth','air_quality.variables.pm2_5','minute_precip.available','minute_precip.coverage_start','minute_precip.coverage_end',
  'minute_precip.interval_anchor','minute_precip.step_ms','minute_precip.minute_series.time_utc_ms','minute_precip.minute_series.precipitation_mm',
  'radar.available','radar.coverage_series[*].t','satellite.available','satellite.coverage_series[*].t','cloud_motion.base_time_utc',
  '<source>.issued_at_utc','<source>.available_at_utc','<source>.collected_at_utc','engine_inputs.source_degradation_flags'];
const epoch=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
export function localDate(instant,timezone) {
  if(!Number.isFinite(instant))return null;
  try {const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant));
    const value=k=>parts.find(p=>p.type===k)?.value;return `${value('year')}-${value('month')}-${value('day')}`;}catch{return null;}
}
export function ianaOffsetSeconds(instant,timezone) {
  if(!Number.isFinite(instant))return null;
  try {const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
    const part=k=>Number(parts.find(p=>p.type===k)?.value);
    return (Date.UTC(part('year'),part('month')-1,part('day'),part('hour'),part('minute'),part('second'))-Math.floor(instant/1000)*1000)/1000;
  }catch{return null;}
}
export function leadValidity(row) {
  const prediction=epoch(row.prediction_time_utc),sunset=epoch(row.sunset_time_utc),lead=(sunset-prediction)/60000;
  if(!Number.isFinite(lead))return {status:'EXCLUDED',reason_code:'MISSING_OR_INVALID_EXPLICIT_TIME',minutes:null};
  if(lead<=0)return {status:'EXCLUDED',reason_code:'NONPOSITIVE_MINUTES_TO_SUNSET',minutes:lead};
  const bucket=computeLeadTimeBucket(lead);
  if(lead!==row.lead_time_minutes||bucket!==row.lead_time_bucket||
    Number.isFinite(row.prediction_time_epoch)&&row.prediction_time_epoch!==prediction)
    return {status:'EXCLUDED',reason_code:'FROZEN_LEAD_TIME_OR_EPOCH_CONTRACT_CONFLICT',minutes:lead,computed_bucket:bucket};
  return {status:'VALID',reason_code:null,minutes:lead,bucket};
}
export function temporalContract(codeIdentity,observationFields,config={}) {
  return {temporal_rules_version:2,code_identity:codeIdentity,projection_allowlist:TEMPORAL_REPLAY_PATHS,nwp_fields:NWP_FIELDS,
    time_classes:['PREDICTION','TARGET_VALID','DATA_VALID','ISSUE_AVAILABILITY_COLLECTION'],
    fields:[
      {path:'identity.prediction_time_utc',unit:'UTC_ISO8601',semantic:'PREDICTION',rule:'EXACT_MODEL_TRAIN_IDENTITY',source:'tools/replay/replay-runner.mjs'},
      {path:'context.sunset_time_utc',unit:'UTC_ISO8601',semantic:'TARGET_VALID',rule:'EXACT_MODEL_TARGET_AND_IANA_EVENT_DATE',source:'tools/replay/replay-runner.mjs'},
      {path:'context.utc_offset_seconds',unit:'second',semantic:'PROVIDER_FIXED_OFFSET',rule:'REPORT_PREDICTION_AND_TARGET_IANA_OFFSETS_WITHOUT_SELECTING_FAVORABLE_VALUE',
        missing:'UNKNOWN_PROVIDER_OFFSET_SEMANTICS_NOT_PER_INSTANT_AVAILABILITY',source:'js/prediction_service.js / js/time.js'},
      {path:'nwp.nodes[*].time_utc',unit:'UTC_ISO8601',semantic:'DATA_VALID',target:'PREDICTION_AND_SUNSET',
        rule:'ASCENDING_AXIS_LINEAR_BRACKET_ENDPOINT_CLAMP_OUTSIDE_RANGE',missing:'FIELD_SPECIFIC_FALLBACK_NOT_OBSERVED_WEATHER',source:'js/cloud_field.js'},
      {path:'air_quality.time_utc',unit:'UTC_ISO8601',semantic:'DATA_VALID',target:'LOCAL_SUNSET_HOUR',
        rule:'ENGINE_NEAREST_LOCAL_FLOORED_SUNSET_HOUR',missing:'NULL_COMPONENT_REWEIGHT_OR_ATMOSPHERE_NEUTRAL',source:'js/engine.js'},
      {path:'minute_precip.minute_series.time_utc_ms',unit:'UTC_EPOCH_MS',semantic:'DATA_VALID',target:'PREDICTION_THEN_BOUNDED_HORIZONS',
        rule:'START_OR_END_ANCHORED_CONTIGUOUS_INTERVAL_CURRENT_COVERAGE_NO_EXTENSION',missing:'NO_PRECIP_EVIDENCE_NWP_OR_MOTION_FALLBACK',source:'js/nowcast.js'},
      {path:'radar.coverage_series[*].t',unit:'UTC_EPOCH_MS',semantic:'COVERAGE_SERIES_EFFECTIVE_TIME',target:'EVOLUTION_FROM_PREDICTION',
        rule:'POSITIVE_TIME_DELTAS_FIT_TREND_NOT_AVAILABILITY_PROOF',missing:'FORECAST_OR_MOTION_FALLBACK',source:'js/evolution.js'},
      {path:'satellite.coverage_series[*].t',unit:'UTC_EPOCH_MS',semantic:'COVERAGE_SERIES_EFFECTIVE_TIME',target:'EVOLUTION_FROM_PREDICTION',
        rule:'POSITIVE_TIME_DELTAS_FIT_TREND_RAIN_EXCLUSION_NOT_FULLY_TRACEABLE',missing:'FORECAST_OR_MOTION_FALLBACK',source:'js/evolution.js'},
      {path:'cloud_motion.base_time_utc',unit:'UTC_ISO8601',semantic:'PREDICTION_ANCHOR',rule:'EXACT_PREDICTION_ANCHOR_IF_PRESENT',source:'js/replay_service.js'},
      {path:'<source>.issued_at_utc|available_at_utc|collected_at_utc',unit:'UTC_ISO8601',semantic:'ISSUE_AVAILABILITY_COLLECTION',
        rule:'EXPLICIT_SEMANTIC_TIMESTAMPS_ONLY_NEVER_USE_UPLOAD_EXPORT_OR_SUBMISSION',missing:'UNKNOWN_NO_BACKFILL',source:'HISTORICAL_REPLAY_FIELDS'},
      {path:'raw/sunset_observations/actual_observation_window',unit:'UTC_INTERVAL',semantic:'OBSERVATION_TARGET',
        rule:'ACTUAL_WINDOW_ONLY_SUBMITTED_AT_IS_NOT_OBSERVATION_TIME',missing:'UNKNOWN_NO_RETROSPECTIVE_WINDOW_ENFORCEMENT',source:'raw/schema.json'}],
    variable_contracts:NWP_FIELDS.map(field=>({path:`nwp.nodes[*].variables.${field}`,unit:/^cloud_|humidity|probability/.test(field)?'percent':field==='visibility'?'m':
      field==='precipitation'?'mm':field==='surface_pressure'?'hPa':field.includes('direction')?'degree':'km/h',
      target:'PREDICTION_CLOUD_FIELD_AND_SUNSET_CORE',interpolation:'LINEAR_TIME_ANGULAR_FOR_WIND_DIRECTION',missing:'SOURCE_CODE_FIELD_SPECIFIC_FALLBACK',
      evidence_source:'js/cloud_field.js / js/engine.js'})),
    inherited_time_config:{forecast_window:config.forecastWindow??null,golden_window:config.goldenWindow??null,
      nowcast_analysis_horizon_minutes:config.nowcast?.analysisHorizonMinutes??null,nowcast_coverage_fade_minutes:config.nowcast?.coverageFadeMinutes??null},
    observation_source_fields:observationFields,observation_aggregation:'EXISTING_EVENT_LEVEL_GT_POLICY_2_TEAM_REVIEW_REMAINS_VALID',
    future_forecast_valid_time_is_leakage:false,uniform_tolerance_invented:false,network_backfill:false};
}
function availability(source,prediction) {
  const originals=Object.fromEntries(['issued_at_utc','available_at_utc','collected_at_utc'].filter(k=>source?.[k]!=null).map(k=>[k,source[k]]));
  const parsed=Object.fromEntries(Object.entries(originals).map(([k,v])=>[k,Number.isFinite(epoch(v))?epoch(v):null]));
  if(!Number.isFinite(prediction))return {status:'UNKNOWN',reason_code:'PREDICTION_TIME_NOT_AVAILABLE',originals,parsed};
  if(Object.entries(parsed).some(([k,v])=>k!=='collected_at_utc'&&v!==null&&v>prediction))return {status:'PROVEN_MISMATCH',reason_code:'EXPLICIT_ISSUE_OR_AVAILABILITY_AFTER_PREDICTION',originals,parsed};
  if(Object.entries(parsed).some(([,v])=>v===null))return {status:'UNKNOWN',reason_code:'UNPARSEABLE_EXPLICIT_SOURCE_TIME',originals,parsed};
  if(parsed.issued_at_utc!=null&&parsed.available_at_utc!=null&&parsed.available_at_utc<parsed.issued_at_utc)
    return {status:'UNKNOWN',reason_code:'CONFLICTING_SOURCE_TIME_SEMANTICS',originals,parsed};
  if(parsed.collected_at_utc!=null&&parsed.collected_at_utc>prediction)return {status:'UNKNOWN',reason_code:'COLLECTION_AFTER_PREDICTION_DOES_NOT_PROVE_PROVIDER_UNAVAILABILITY',originals,parsed};
  if(parsed.available_at_utc!=null)return {status:'PASS',reason_code:'EXPLICIT_SOURCE_AVAILABILITY_NOT_AFTER_PREDICTION',originals,parsed};
  return {status:'UNKNOWN',reason_code:Object.keys(originals).length?'ISSUE_OR_COLLECTION_ALONE_NOT_FULL_AVAILABILITY_PROOF':'SOURCE_ISSUE_AVAILABILITY_COLLECTION_NOT_CAPTURED',originals,parsed};
}
function axisEvidence(times,target) {
  const parsed=(times||[]).map(epoch);
  if(!parsed.length)return {status:'UNKNOWN',reason_code:'NO_EFFECTIVE_TIME_AXIS',selected_indices:[]};
  if(parsed.some(t=>!Number.isFinite(t))||parsed.some((t,i)=>i>0&&t<=parsed[i-1]))return {status:'PROVEN_MISMATCH',reason_code:'INVALID_OR_NONINCREASING_EFFECTIVE_TIME_AXIS',selected_indices:[]};
  if(!Number.isFinite(target))return {status:'UNKNOWN',reason_code:'TARGET_TIME_MISSING',selected_indices:[]};
  if(target<=parsed[0]||target>=parsed.at(-1)) {const i=target<=parsed[0]?0:parsed.length-1;return {status:'PASS',reason_code:'CONTRACT_ENDPOINT_SELECTION_ALLOWED',
    selection_mode:target===parsed[i]?'EXACT_ENDPOINT':'ENDPOINT_CLAMP',selected_indices:[i],selected_valid_times:[times[i]],target_utc_ms:target};}
  const upper=parsed.findIndex(t=>t>=target),lower=upper-1;
  return {status:'PASS',reason_code:'LINEAR_BRACKET_CONTAINS_TARGET',selection_mode:'LINEAR_BRACKET',selected_indices:[lower,upper],
    selected_valid_times:[times[lower],times[upper]],target_utc_ms:target};
}
export function auditTemporalSnapshot(row,replay,trace,contract) {
  const prediction=epoch(replay.identity?.prediction_time_utc),target=epoch(replay.context?.sunset_time_utc),judgments=[];
  const add=(rule,path,result)=>judgments.push({rule_version:2,cohort:row.in_oof?'ALL_PRIMARY_AND_OOF':'ALL_PRIMARY',snapshot_id:row.snapshot_id,
    event_id:row.event_id,event_date_local:row.event_date_local,gt_ordinal:row.gt_ordinal,error_direction:row.error_direction,
    lead_time_bucket:row.lead_time_bucket,field_path:path,rule,...result});
  const identityOkay=replay.identity?.snapshot_id===row.snapshot_id&&replay.identity?.event_id===row.event_id&&prediction===epoch(row.prediction_time_utc);
  add('PREDICTION_IDENTITY','identity.prediction_time_utc',{status:identityOkay?'PASS':'PROVEN_MISMATCH',reason_code:identityOkay?null:'REPLAY_MODEL_PREDICTION_IDENTITY_CONFLICT',
    original:replay.identity?.prediction_time_utc??null,model_original:row.prediction_time_utc,parsed_epoch_ms:Number.isFinite(prediction)?prediction:null});
  const predictionOffset=ianaOffsetSeconds(prediction,row.timezone),targetOffset=ianaOffsetSeconds(target,row.timezone),capturedOffset=replay.context?.utc_offset_seconds;
  const offsetAgrees=Number.isFinite(capturedOffset)&&predictionOffset!==null&&targetOffset!==null&&capturedOffset===predictionOffset&&capturedOffset===targetOffset;
  add('IANA_OFFSET_EVIDENCE','context.utc_offset_seconds',{status:offsetAgrees?'PASS':'UNKNOWN',
    reason_code:offsetAgrees?'CAPTURED_AND_BOTH_IANA_OFFSETS_AGREE':'FIXED_PROVIDER_OFFSET_OR_DST_CONFLICT_RETAIN_ALL_VALUES_NO_CAUSAL_MISMATCH_CLAIM',
    captured_offset_seconds:capturedOffset??null,prediction_iana_offset_seconds:predictionOffset,target_iana_offset_seconds:targetOffset,
    parser:'INTL_IANA_PARTS_MINUS_UTC_EPOCH_NO_MACHINE_TIMEZONE'});
  for(const source of ['nwp','air_quality','minute_precip','radar','satellite']) {
    const payload=replay[source],applicable=source==='nwp'||payload?.available===true;
    add('SOURCE_AVAILABILITY',`${source}.<explicit_source_timestamps>`,applicable?availability(payload,prediction):
      {status:'NOT_APPLICABLE',reason_code:'SOURCE_UNAVAILABLE_DEGRADED_NOT_USED'});
  }
  for(const [name,targetMs] of [['PREDICTION',prediction],['SUNSET',target]]) {
    const nodes=(replay.nwp?.nodes||[]).map((node,index)=>{
      const axis=axisEvidence(node.time_utc,targetMs);
      const fields=NWP_FIELDS.map(field=>{const values=node.variables?.[field],selected=axis.selected_indices.map(i=>values?.[i]);return {field,
        available:Array.isArray(values),selected_valid_count:selected.filter(Number.isFinite).length,selected_zero_count:selected.filter(v=>v===0).length,
        selected_missing_count:selected.filter(v=>!Number.isFinite(v)).length,reason_code:Array.isArray(values)?null:'NOT_AVAILABLE_FIELD_SPECIFIC_FALLBACK'};});
      return {node_index:index,node_key:node.key,...axis,fields};
    });
    const status=nodes.some(n=>n.status==='PROVEN_MISMATCH')?'PROVEN_MISMATCH':nodes.length&&nodes.every(n=>n.status==='PASS')?'PASS':'UNKNOWN';
    add('NWP_EFFECTIVE_TIME',`nwp.nodes[*].time_utc@${name}`,{status,reason_code:status==='PASS'?'FUTURE_FORECAST_VALID_TIME_IS_ALLOWED':status==='UNKNOWN'?'NWP_TIME_EVIDENCE_MISSING':'NWP_AXIS_CONTRACT_VIOLATION',
      target_kind:name,target_utc_ms:Number.isFinite(targetMs)?targetMs:null,nodes,endpoint_clamp_node_count:nodes.filter(n=>n.selection_mode==='ENDPOINT_CLAMP').length});
  }
  const air=replay.air_quality;
  if(air?.available) {
    const offset=(replay.context?.utc_offset_seconds||0)*1000,floor=Math.floor((target+offset)/3600000)*3600000-offset;
    const base=axisEvidence(air.time_utc,target),parsed=air.time_utc?.map(epoch)||[];
    const nearest=parsed.reduce((best,t,i)=>best<0||Math.abs(t-floor)<Math.abs(parsed[best]-floor)?i:best,-1);
    add('AIR_EFFECTIVE_TIME','air_quality.time_utc',{...base,selection_mode:'NEAREST_LOCAL_FLOORED_SUNSET_HOUR',
      selected_indices:nearest<0?[]:[nearest],selected_valid_times:nearest<0?[]:[air.time_utc[nearest]],
      fields:['aerosol_optical_depth','pm2_5'].map(field=>({path:`air_quality.variables.${field}`,unit:field==='pm2_5'?'µg/m³':'dimensionless',
        selected_value_available:nearest>=0&&Number.isFinite(air.variables?.[field]?.[nearest]),selected_is_zero:nearest>=0&&air.variables?.[field]?.[nearest]===0})),
      local_floored_target_utc_ms:Number.isFinite(floor)?floor:null,reason_code:base.status==='PASS'?'ENGINE_NEAREST_LOCAL_HOUR_SELECTION':base.reason_code});
  }else add('AIR_EFFECTIVE_TIME','air_quality.time_utc',{status:'NOT_APPLICABLE',reason_code:'AIR_UNAVAILABLE_COMPONENT_FALLBACK'});
  const precip=replay.minute_precip;
  if(precip?.available) {
    const times=precip.minute_series?.time_utc_ms||[],step=precip.step_ms,endAnchored=precip.interval_anchor==='interval_end',starts=times.map(t=>t-(endAnchored?step:0));
    const hasCurrent=starts.some((t,i)=>prediction>=t&&prediction<t+step&&Number.isFinite(precip.minute_series?.precipitation_mm?.[i]));
    const valid=times.length>0&&['interval_start','interval_end'].includes(precip.interval_anchor)&&Number.isFinite(step)&&step>0&&times.every(Number.isFinite)&&starts.every((t,i)=>i===0||t===starts[i-1]+step);
    const consistent=valid&&precip.coverage_start===starts[0]&&precip.coverage_end===starts.at(-1)+step;
    add('PRECIP_INTERVAL_COVERAGE','minute_precip.minute_series',{status:consistent?'PASS':'PROVEN_MISMATCH',reason_code:consistent?
      hasCurrent?'CURRENT_INTERVAL_COVERED':'CURRENT_UNCOVERED_ANALYZER_RETURNS_NO_EVIDENCE':'INTERVAL_ANCHOR_STEP_OR_COVERAGE_CONFLICT',
      prediction_covered:hasCurrent,coverage_start:precip.coverage_start,coverage_end:precip.coverage_end,step_ms:step,interval_anchor:precip.interval_anchor,
      minimum_analysis_steps_met:times.length>=8,
      sunset_outside_coverage:Number.isFinite(target)&&target>=precip.coverage_end,
      sunset_outside_interpretation:'NO_AUTOMATIC_120_MINUTE_PROBABILITY_EXTENSION_MINUTE_WEIGHT_RETURNS_NEUTRAL'});
  }else add('PRECIP_INTERVAL_COVERAGE','minute_precip',{status:'NOT_APPLICABLE',reason_code:'PRECIP_UNAVAILABLE_NWP_OR_MOTION_FALLBACK'});
  for(const name of ['radar','satellite']) {
    const source=replay[name],times=source?.coverage_series?.map(r=>r.t)||[];
    add('VISUAL_EFFECTIVE_TIME',`${name}.coverage_series[*].t`,source?.available?{
      status:times.length&&times.every(Number.isFinite)?'PASS':'UNKNOWN',reason_code:times.length?'EFFECTIVE_FRAME_TIMES_ARE_NOT_SOURCE_AVAILABILITY':'NO_FRAME_TIME_EVIDENCE',
      effective_times:times,positive_delta_count:times.filter((t,i)=>i>0&&t>times[i-1]).length,
      has_future_effective_time:times.some(t=>t>prediction),internal_fusion_evidence:'PARTIAL_TRACE_NO_CAUSAL_SOURCE_ATTRIBUTION'}:
      {status:'NOT_APPLICABLE',reason_code:'SOURCE_UNAVAILABLE_FORECAST_OR_MOTION_FALLBACK'});
  }
  const motion=epoch(replay.cloud_motion?.base_time_utc);
  add('MOTION_PREDICTION_ANCHOR','cloud_motion.base_time_utc',{status:!Number.isFinite(motion)?'UNKNOWN':motion===prediction?'PASS':'PROVEN_MISMATCH',
    reason_code:!Number.isFinite(motion)?'MOTION_ANCHOR_NOT_AVAILABLE':motion===prediction?null:'MOTION_ANCHOR_DIFFERS_FROM_PREDICTION',original:replay.cloud_motion?.base_time_utc??null});
  add('FINAL_FUSION_TARGET','context.sunset_time_utc',{status:trace?.final_score===row.score&&target===epoch(row.sunset_time_utc)?'PASS':'PROVEN_MISMATCH',
    reason_code:trace?.final_score===row.score&&target===epoch(row.sunset_time_utc)?'PARENT_EXECUTION_TARGET_AND_FINAL_SCORE_BOUND':'PARENT_TARGET_OR_SCORE_CONFLICT',
    prediction_time_utc:replay.identity?.prediction_time_utc??null,target_time_utc:replay.context?.sunset_time_utc??null,
    golden_window_active:trace?.golden_window_active??null,source_contract:contract.code_identity['tools/replay/replay-runner.mjs']??null});
  const gw=contract.inherited_time_config?.golden_window,lead=(target-prediction)/60000;
  if(gw&&Number.isFinite(lead)) {
    const active=!!(gw.enabled&&lead>=-gw.afterSunsetMinutes&&lead<=gw.beforeSunsetMinutes);
    add('GOLDEN_WINDOW_ACTIVATION','trace.golden_window_active',{status:trace?.golden_window_active===active?'PASS':'PROVEN_MISMATCH',
      reason_code:trace?.golden_window_active===active?'FROZEN_CONFIG_AND_EXECUTION_BRANCH_AGREE':'FROZEN_CONFIG_AND_EXECUTION_BRANCH_CONFLICT',
      expected_active:active,actual_active:trace?.golden_window_active??null,minutes_to_sunset:lead,
      sunset_evolution_horizon_note:'WITHIN_SUPPORTED_HORIZON_USE_FROZEN_EVOLUTION_BINS_OTHERWISE_NWP_SUNSET_NO_PROBABILITY_EXTENSION'});
  }
  add('SOURCE_DEGRADATION_FLAGS','engine_inputs.source_degradation_flags',{status:replay.engine_inputs?.source_degradation_flags?'PASS':'UNKNOWN',
    reason_code:replay.engine_inputs?.source_degradation_flags?'CAPTURED_SOURCE_STATUS_ONLY_NOT_AVAILABILITY_PROOF':'DEGRADATION_FLAGS_NOT_CAPTURED',
    flags:replay.engine_inputs?.source_degradation_flags??null});
  const date=localDate(target,row.timezone),targetOkay=date!==null&&date===row.event_date_local&&target===epoch(row.sunset_time_utc)&&replay.context?.timezone===row.timezone;
  const alignmentBase={rule_version:2,cohort:row.in_oof?'ALL_PRIMARY_AND_OOF':'ALL_PRIMARY',snapshot_id:row.snapshot_id,event_id:row.event_id,
    event_date_local:row.event_date_local,gt_ordinal:row.gt_ordinal,error_direction:row.error_direction,lead_time_bucket:row.lead_time_bucket};
  const alignment=[{...alignmentBase,
    field_path:'TRAIN.Event / Replay.context',status:targetOkay?'PASS':date===null?'UNKNOWN':'PROVEN_MISMATCH',
    reason_code:targetOkay?'IANA_LOCAL_SUNSET_DATE_AND_EVENT_TARGET_AGREE':date===null?'IANA_OR_TARGET_TIME_UNAVAILABLE':'EVENT_TIMEZONE_DATE_OR_TARGET_CONFLICT',
    event_date_local:row.event_date_local,timezone:row.timezone,replay_timezone:replay.context?.timezone??null,derived_target_local_date:date,
    coordinates_agree:row.latitude===replay.context?.latitude&&row.longitude===replay.context?.longitude,
    coordinate_note:'EXACT_EQUALITY_REPORTED_NO_UNJUSTIFIED_GEOGRAPHIC_TOLERANCE'},
    {...alignmentBase,
      field_path:'raw/schema.json/tables/sunset_observations',status:'UNKNOWN',reason_code:'ACTUAL_OBSERVATION_WINDOW_NOT_CAPTURED_SUBMISSION_IS_NOT_OBSERVATION',
      gt_basis:row.gt_basis,gt_status:row.gt_status,team_confirmation_retained:true,gt_modified:false,
      limitation:'EVENT_LEVEL_LABEL_APPLIED_TO_PREDICTIONS_AT_DIFFERENT_LEADS_NOT_PER_SNAPSHOT_OBSERVATION'}];
  return normalize({judgments,alignment,replay_sha256:digest(replay),degradation_flags:replay.engine_inputs?.source_degradation_flags??null});
}
export function summarizeTemporal(rows) {
  const summaries=[];
  for(const dimension of ['ALL','rule','error_direction','lead_time_bucket','gt_ordinal']) {
    const values=dimension==='ALL'?['ALL']:[...new Set(rows.map(r=>r[dimension]))].sort(compare);
    for(const value of values){const rs=dimension==='ALL'?rows:rows.filter(r=>r[dimension]===value),counts=Object.fromEntries(['PASS','PROVEN_MISMATCH','UNKNOWN','NOT_APPLICABLE'].map(status=>[status,rs.filter(r=>r.status===status).length]));
      const applicable=rs.length-counts.NOT_APPLICABLE;summaries.push({dimension,value,...support(rs),unique_snapshot_count:new Set(rs.map(r=>r.snapshot_id)).size,judgment_count:rs.length,status_counts:counts,
        auditable_coverage:applicable?(counts.PASS+counts.PROVEN_MISMATCH)/applicable:null,reason_code:applicable?null:'NO_APPLICABLE_JUDGMENTS'});}
  }
  return normalize(summaries);
}
