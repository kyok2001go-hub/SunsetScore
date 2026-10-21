import { compare } from '../../dataset/lib/common.mjs';
import { support } from '../statistics.mjs';
import { scorePolicy } from '../policy.mjs';
import { normalize } from './common.mjs';

export function evidenceGaps(boundaries,temporal,alignment,paired) {
  const gaps=[];
  const missing=temporal.filter(r=>r.rule==='SOURCE_AVAILABILITY'&&r.status==='UNKNOWN');
  if(missing.length)gaps.push({gap_id:'INPUT_AVAILABILITY_TIMES',type:'MISSING_HISTORICAL_FIELDS',...support(missing),
    field_paths:[...new Set(missing.map(r=>r.field_path))].sort(compare),judgment_count:missing.length,
    evidence:'temporal_audit.json/rows',reason_code:'VALID_TIME_DOES_NOT_ESTABLISH_AVAILABILITY',
    collection:{purpose:'PROVE_INPUT_WAS_AVAILABLE_AT_PREDICTION',proposed_path:'future_replay.<source>.temporal_provenance',
      minimum_fields:['response_received_at_utc','provider_issue_time_utc_WHEN_PROVIDER_SEMANTICS_DOCUMENTED'],
      privacy_scope:'SOURCE_TIMESTAMPS_ONLY_NO_HEADERS_TOKENS_OR_IDENTIFIERS',
      acceptance:'FUTURE_CAPTURE_ROUNDTRIP_PROVES_RESPONSE_RECEIPT_NOT_AFTER_COMPUTATION_AND_PROVIDER_TIME_SEMANTICS',implementation_authorized:false}});
  const window=alignment.filter(r=>r.status==='UNKNOWN'&&r.reason_code==='ACTUAL_OBSERVATION_WINDOW_NOT_CAPTURED_SUBMISSION_IS_NOT_OBSERVATION');
  if(window.length)gaps.push({gap_id:'OBSERVATION_ACTUAL_WINDOW',type:'MISSING_OBSERVATION_TARGET',...support(window),
    field_paths:['Observation.actual_observation_start_utc','Observation.actual_observation_end_utc'],
    evidence:'target_alignment.json/rows',reason_code:'EVENT_LABEL_NOT_TIMESTAMPED_PER_SNAPSHOT_OBSERVATION',
    collection:{purpose:'BOUND_EVENT_LABEL_TARGET_WITHOUT_RETROACTIVE_RELABELING',proposed_path:'future_Observation.actual_observation_window',
      minimum_fields:['start_utc','end_utc','timezone','window_basis'],privacy_scope:'EVENT_TIME_WINDOW_NO_NEW_PERSONAL_DATA',
      acceptance:'DISTINGUISH_ACTUAL_WINDOW_FROM_SUBMISSION_TIME_AND_PRESERVE_UNKNOWN_HISTORICAL_VALUES',implementation_authorized:false}});
  for(const metric of [...(boundaries?.adjacent||[]),...(boundaries?.cumulative||[])])if(metric.status==='INSUFFICIENT_SUPPORT')
    gaps.push({gap_id:`BOUNDARY_SUPPORT_${metric.boundary_id}`,type:'GRADE_DATE_SUPPORT',cohort:'OOF',field_paths:['TRAIN.gt_ordinal','TRAIN.event_date_local'],
      boundary_id:metric.boundary_id,low:metric.low,high:metric.high,required_per_class:{events:10,dates:3},
      evidence:`boundary_metrics.json/OOF/${metric.boundary_id}`,reason_code:'MINIMUM_PER_CLASS_SUPPORT_NOT_MET',
      collection:{purpose:'NATURAL_GRADE_AND_INDEPENDENT_DATE_COVERAGE',minimum_fields:[],proposed_path:'FUTURE_EXISTING_EVENT_OBSERVATION_PIPELINE',
        privacy_scope:'EXISTING_LEGAL_INPUTS_ONLY',acceptance:'AT_LEAST_10_DISTINCT_EVENTS_AND_3_DATES_PER_CLASS_NO_ARTIFICIAL_MERGING',implementation_authorized:false}});
  for(const pair of paired.filter(p=>p.cohort==='OOF'&&p.support_status==='INSUFFICIENT_SUPPORT'))gaps.push({gap_id:`PAIRED_SUPPORT_${pair.earlier_bucket}`,
    type:'PAIRED_EVENT_COVERAGE',cohort:'OOF',field_paths:['TRAIN.lead_time_bucket'],event_count:pair.event_count,date_count:pair.date_count,
    required:{events:10,dates:3},evidence:`paired_event_comparisons.json/${pair.earlier_bucket}`,reason_code:'PAIRED_EARLY_NEAR_SUPPORT_INSUFFICIENT',
    collection:{purpose:'SAME_EVENT_EARLY_NEAR_DATE_COVERAGE',minimum_fields:[],proposed_path:'EXISTING_FUTURE_SNAPSHOT_COLLECTION',privacy_scope:'EXISTING_EVENT_SNAPSHOT_ONLY',
      acceptance:'PAIRED_EVENTS_WITH_BOTH_FROZEN_BUCKETS_ON_INDEPENDENT_DATES',implementation_authorized:false}});
  return normalize(gaps);
}
export function researchDecision({blocked,boundaries,mapping,temporal,alignment,gaps,parentStages}) {
  const proven=[...temporal,...alignment].filter(r=>r.status==='PROVEN_MISMATCH');
  const primary=(boundaries?.adjacent||[]).find(r=>r.boundary_id==='adjacent_1_2'),high=(boundaries?.cumulative||[]).find(r=>r.boundary_id==='gte_2');
  const signal=[primary,high].some(r=>r?.status==='SIGNAL_SUPPORTED');
  const mechanisms=mapping.audits.filter(f=>f.labels.some(l=>['MAPPING_RANGE_LIMIT','HOLDOUT_SCORE_PLACEMENT','PLATEAU_COMPRESSION'].includes(l)));
  const completeModules=(parentStages?.module_hypotheses||[]).filter(h=>h.causal_claim===false&&h.supported&&h.case_snapshot_ids?.length&&
    h.rank_before?.value!=null&&h.rank_after?.value!=null&&h.rank_after.value<h.rank_before.value-scorePolicy(2).epsilon);
  const experiments=[],actions=[];let recommendation;
  if(blocked)recommendation='BLOCKED';
  else if(proven.length) {
    recommendation='INPUT_CONTRACT_REPAIR';actions.push({action:recommendation,evidence:'temporal_audit.json; target_alignment.json',
      affected_snapshot_ids:[...new Set(proven.map(r=>r.snapshot_id))].sort(compare),field_paths:[...new Set(proven.map(r=>r.field_path))].sort(compare),
      next_step:'SEPARATE_REPAIR_PLAN_AND_PROSPECTIVE_CAPTURE_ACCEPTANCE_NO_EXPECTED_SCORE_GAIN_CLAIM'});
  } else {
    if(signal&&mechanisms.length) {
      const experiment={hypothesis_id:'PRESERVE_HIGH_GRADE_DURING_CALIBRATION',action:'CALIBRATION_HYPOTHESIS',
        mechanism:'FROZEN_SCORE_ORDER_HAS_BOUNDARY_SIGNAL_BUT_PARENT_MAPPING_LOSES_HIGH_GRADE_RECOGNITION',
        evidence:{boundaries:[primary,high].filter(r=>r?.status==='SIGNAL_SUPPORTED').map(r=>`boundary_metrics.json/OOF/${r.boundary_id}`),
          folds:mechanisms.map(f=>({fold:f.fold,labels:f.labels,evidence:'fold_mapping_audit.json'}))},
        alternatives:['CLASS_COMPOSITION','DATE_SHIFT','EVENT_LEVEL_GT_WINDOW_UNCERTAINTY'],
        single_change:'ONE_GLOBAL_MONOTONE_MAPPING_OBJECTIVE_WITH_FIXED_DOUBLE_COST_FOR_GT_GTE2_TO_PRED_LT2_FALSE_NEGATIVES_NO_OTHER_WEIGHT_OR_THRESHOLD_CHANGE',
        control:'SAME_FROZEN_CONTROL_RAW_SCORES_AND_ORIGINAL_MAPPING',
        preregistered_metrics:['MAE_VS_CONTROL_AND_FOLD_NO_SKILL','QWK','HIGH_GRADE_RECALL_AND_PRECISION','DATE_BLOCK_DELTA_MAE_CI'],
        stop_conditions:['MAE_NOT_STRICTLY_BELOW_CONTROL_AND_FOLD_NO_SKILL_BY_1E_MINUS12','HIGH_GRADE_RECALL_OR_QWK_LOWER_THAN_CONTROL_BY_MORE_THAN_1E_MINUS12',
          'DATE_BLOCK_DELTA_MAE_CI_UPPER_NOT_BELOW_MINUS_1E_MINUS12','FEWER_THAN_10_EVENTS_OR_3_DATES_PER_HIGH_LOW_CLASS'],
        independent_data:'NEW_UNEXPOSED_EVENTS_AND_DATES_CURRENT_OOF_NOT_CONFIRMATORY',implemented:false};
      experiments.push(experiment);actions.push({action:experiment.action,hypothesis_id:experiment.hypothesis_id,evidence:'next_experiments.json'});
    }
    if(completeModules.length&&actions.length<2) {
      const module=completeModules[0],experiment={hypothesis_id:`SINGLE_MODULE_${module.stage}`,action:'MODULE_HYPOTHESIS',
        mechanism:'PARENT_TRACE_STAGE_HAS_SUPPORTED_RANK_LOSS',evidence:module,alternatives:module.confounders,
        single_change:`ONLY_${module.stage}_UNDER_A_NEW_FROZEN_PLAN`,control:'SAME_CONTROL_CONFIG_EXCEPT_ONE_STAGE',
        preregistered_metrics:['FAIR_GOOD_AND_GTE2_AUC','QWK','HIGH_GRADE_RECALL','MAE','DATE_INTERVALS'],
        stop_conditions:['NO_PREDECLARED_BOUNDARY_IMPROVEMENT','BASIC_METRIC_DEGRADATION','INSUFFICIENT_INDEPENDENT_SUPPORT'],
        independent_data:'NEW_UNEXPOSED_EVENTS_AND_DATES_CURRENT_OOF_NOT_CONFIRMATORY',implemented:false};
      experiments.push(experiment);actions.push({action:experiment.action,hypothesis_id:experiment.hypothesis_id,evidence:'next_experiments.json'});
    }
    if(actions.length)recommendation=actions[0].action;
    else if(gaps.length){recommendation='EVIDENCE_COLLECTION';
      for(const gap of gaps.slice(0,2))actions.push({action:'EVIDENCE_COLLECTION',gap_id:gap.gap_id,collection:gap.collection,evidence:'evidence_gaps.json'});
    }else recommendation='UNRESOLVED';
  }
  return {decision:{execution_status:blocked?'BLOCKED':'COMPLETED',recommendation,primary_actions:actions.slice(0,2),
    reason_codes:blocked?['SOURCE_MAPPING_OR_MEMBER_INCONSISTENCY']:proven.length?['PROVEN_TEMPORAL_OR_TARGET_CONTRACT_MISMATCH']:
      actions.length?[recommendation]:['NO_STABLE_BOUNDARY_SIGNAL_OR_LOCALIZABLE_MECHANISM'],
    evidence:{primary_fair_good:primary?.status??'NOT_AVAILABLE',primary_gte2:high?.status??'NOT_AVAILABLE',mapping_reapplication:mapping.reapplication.status,
      proven_mismatch_count:proven.length,evidence_gap_count:gaps.length},
    result_usage:'DEVELOPMENT_ONLY',formal_promotion_allowed:false,selected:null,validation_evaluated:false,test_evaluated:false,
    causal_claim:false,phase8_ready:false,limitations:['CURRENT_OOF_IS_EXPOSED_DEVELOPMENT_EVIDENCE','NO_REFIT_NO_SEARCH_NO_ENGINE_REPLAY','NOT_SIGNIFICANT_IS_NOT_NO_SIGNAL']},
    experiments:experiments.slice(0,2)};
}
