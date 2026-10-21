import { canonicalJson, hash, fail } from '../dataset/lib/common.mjs';
export const digest = value => hash(canonicalJson(value));
export const PRODUCT_LABELS = ['poor','fair','good','very_good','excellent'];
export const PRODUCT_NAMES = ['无霞','微霞','普通','很好','极佳'];
const freeze = value => { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; };
const policy = freeze({product_evaluation_schema_version:1,product_evaluation_policy_version:1,
  formal_capable:false,result_usage:'DEVELOPMENT_ONLY',ordinal_labels:PRODUCT_LABELS,ordinal_names:PRODUCT_NAMES,
  target:'LOCATION_LOCAL_DATE_EVENT_OVERALL_SUNSET_SAME_LABEL_FOR_ALL_LEADS',score_thresholds:[20,40,60,90],
  confirmed_product_contract:{four_to_three:'ACCEPTABLE',four_to_two:'BARELY_ACCEPTABLE_AVOID',four_to_one:'UNACCEPTABLE',
    balanced_goal:'REDUCE_CLEAR_OVERESTIMATION_WITHOUT_FREQUENTLY_MISSING_ORDINAL_3_4'},
  technical_defaults_not_user_confirmed_prices:true,loss_orientation:'PREDICTION_ROW_ACTUAL_COLUMN',
  loss_matrix:[[0,1,4,9,16],[1,0,1,4,9],[4,1,0,1,4],[9,4,1,0,1],[24,16,4,1,0]],
  loss_derivation:'SQUARED_ORDINAL_DISTANCE_WITH_EXTRA_COST_FOR_PREDICTED_4_ACTUAL_0_1',
  weighting:'EVENT_CONFIDENCE_DIVIDED_BY_SNAPSHOT_COUNT_WITHIN_EACH_COHORT_NO_CLASS_RESAMPLING',
  constant_baseline:'ENUMERATE_0_TO_4_ON_TRAIN_ONLY_MINIMUM_PRODUCT_LOSS_TIE_LOWER_ORDINAL',
  diagnostic_constants:[1,2],epsilon:1e-12,precision:12,
  qualification:{coverage:1,loss_strictly_below_control:true,loss_strictly_below_train_constant:true,
    critical_overprediction_observed_max:0,recall_absolute_tolerance:.05,target_ge3_events:10,target_ge3_dates:3,
    old_metrics_are_reported_not_new_vetoes:true},
  search:{optimization_schema_version:2,optimization_policy_version:5,units:['component_weights','atmosphere_quality_base','atmosphere_quality_scale','high_cloud_center','high_cloud_width'],
    proposals_per_fold:100,final_train_proposals:100,total_proposals_max:400,beam_seats:[4,2,2],finalists_max:5,
    pareto:['product_loss_MIN','critical_overprediction_rate_MIN','target_ge3_recall_MAX_NULL_LAST'],
    tie_breakers:['target_ge2_recall_DESC_NULL_LAST','mae_ASC','changed_unit_count_ASC','normalized_parameter_distance_ASC','candidate_id_ASC']},
  procedure:{fold_train_dates:[10,14,17],fold_held_dates:[4,3,3],valid_folds:3,improved_folds_min:2,combined_oof_qualification:true,delta_loss_ci_upper_strict:0},
  bootstrap:{replicates:2000,minimum_valid:1900,lower:.025,upper:.975,prng:'xorshift32-v1',algorithm:'DATE_BLOCK_PERCENTILE',refill:false,seed_source:'PLAN_PANEL_COHORT_IDENTITY_AND_PRODUCT_POLICY_SHA256'},
  slice_dimensions:['lead_time_bucket','scheduled_slot','gt_ordinal','location_key','regime_label'],slice_support:{events:5,dates:2},
  panels:['TRAIN_FIXED','OLD_VALIDATION_FIXED','PROCESS_OOF'],test_effect_access:false,phase8_allowed:false});
export function productPolicy(version=1){if(version!==1)fail('UNSUPPORTED_PRODUCT_POLICY');return structuredClone(policy);}
export const PRODUCT_PAYLOADS=['schema.json','product_policy.json','plan.json','source_manifest.json','mapping_audit.json','raw_lineage_audit.json',
  'test_access_audit.json','confusion_matrix.json','candidate_product_metrics.json','constant_baselines.json','risk_and_recall.json',
  'legacy_gate_comparison.json','cohort_identity.json','slice_metrics.json','bootstrap.json','decision.json','reports/summary.md'];
export function productSchema(version=1){if(version!==1)fail('UNSUPPORTED_PRODUCT_SCHEMA');return {product_evaluation_schema_version:1,
  product_evaluation_policy_version:1,plan_files:['schema.json','product_policy.json','plan.json','source_manifest.json','mapping_audit.json','raw_lineage_audit.json','test_access_audit.json'],
  result_files:PRODUCT_PAYLOADS,confusion_orientation:'PREDICTION_ROW_ACTUAL_COLUMN'};}
