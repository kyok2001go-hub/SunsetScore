import {fail} from '../dataset/lib/common.mjs';
import {optimizationPolicy} from '../optimization/optimization-policy.mjs';
import {runBeamSearch} from '../optimization/lib/beam.mjs';
import {prepareCandidateRun,evaluateCandidateDetailed} from '../tuning/lib/candidate.mjs';
import {qualityRecord,estimateNoSkill} from '../optimization-diagnostics/engine.mjs';
import {cachedReplay} from '../optimization-diagnostics/workflow.mjs';
import {runReplay as engineReplay} from '../replay/replay-runner.mjs';
import {rankProduct,selectProductParents,productPareto} from './selection.mjs';
import {productMetrics,estimateConstant,qualification,productSlices,q} from './metrics.mjs';
import {digest,productPolicy} from './policy.mjs';
import {evaluateProductRows,normalize} from './workflow.mjs';
import {memberRows,loadProductReplays,candidateFromVector} from './sources.mjs';

export async function productEvaluator({cohort,searchSpace,runReplay,progress,referenceScores,constantReference,legacyReference}){
  const constant=constantReference??estimateConstant(cohort),legacyConstant=legacyReference??estimateNoSkill(cohort);
  for(const row of cohort){const reference=await runReplay(row.replay,{reference:row});if(reference.pass!==true)fail('PRODUCT_REFERENCE_CONTROL_INCOMPLETE');}
  const prepared=await prepareCandidateRun({cohort,config:searchSpace.base_config.config,units:Object.values(searchSpace.registry_units),runReplay,progress});
  if(prepared.controlFailures.length||prepared.control.length!==cohort.length)fail('PRODUCT_REFERENCE_CONTROL_INCOMPLETE');
  if(referenceScores)for(const r of prepared.control)if(referenceScores.get(r.snapshot_id)!==r.control_score)fail('PRODUCT_FROZEN_CONTROL_MISMATCH');
  const evaluate=async candidate=>{
    const detailed=await evaluateCandidateDetailed({prepared,vector:candidate.canonical_vector});
    if(detailed.status!=='EVALUABLE'||detailed.rows.length!==cohort.length||detailed.coverage.control_source_coverage_rate!==1||detailed.coverage.candidate_control_coverage_rate!==1)
      return {status:'UNEVALUABLE',metrics:null,rows:[],coverage:detailed.coverage,basic_guards_pass:false,train_all_guards_pass:false,quality:'PRODUCT_DIAGNOSTIC_ONLY',reason_codes:['PRODUCT_COVERAGE_INCOMPLETE'],gates:[],promotable:false};
    const rows=detailed.rows.map(r=>({...r,predicted_ordinal:r.experiment_ordinal})),metrics=productMetrics(rows),control=productMetrics(rows,'control_ordinal'),eligible=qualification(metrics,control,constant.product_loss,1),legacy=qualityRecord({...detailed,controlFailures:prepared.controlFailures},candidate,legacyConstant);
    return {status:'FEASIBLE',metrics,control,rows,coverage:detailed.coverage,constant,legacy_reference_ordinal:legacyConstant,
      basic_guards_pass:eligible.basic_guards_pass,train_all_guards_pass:eligible.development_qualified,
      quality:eligible.development_qualified?'PRODUCT_TRAIN_QUALIFIED':eligible.basic_guards_pass?'PRODUCT_BASIC_GUARDS_PASS':'PRODUCT_DIAGNOSTIC_ONLY',
      gates:eligible.gates,reason_codes:eligible.reason_codes,eligibility:eligible,promotable:false,
      legacy:{metrics:legacy.metrics,control:legacy.control,deltas:legacy.deltas,gates:legacy.gates,quality:legacy.quality,date_stats:legacy.date_stats,slices:legacy.slices,old_rules_unchanged:true}};
  };
  return {evaluate,constant,legacyConstant,prepared};
}
export async function searchProductCohort(options){
  const ev=await productEvaluator(options),scope=`product_scope_${digest({members:options.cohort.map(({replay,...r})=>r),policy:productPolicy(),base:options.searchSpace.base_config.sha256}).slice(0,16)}`;
  const search=await runBeamSearch({searchSpace:{...options.searchSpace,optimization_input_id:scope},policy:optimizationPolicy(5),mode:'EXPLORATORY_SEARCH',
    evaluate:ev.evaluate,rank:rankProduct,parentSelector:selectProductParents,onProgress:v=>options.progress?.update(v)});
  return {...search,constant:ev.constant,legacy_constant:ev.legacyConstant,input_members:memberRows(options.cohort),scope_id:scope};
}
const compactSearch=search=>({...search,records:search.records.map(({rows,candidate,...r})=>({...r,candidate})),
  pareto_front:(productPareto(search.records.filter(r=>r.status==='FEASIBLE'))[0]||[]).map(r=>r.candidate.candidate_id)});
export function productProcedure(folds,rows,identity){
  if(folds.length!==3||folds.some(f=>f.status!=='EVALUATED')||!rows.length)return {status:'PROCEDURE_NOT_SUPPORTED',reason_codes:['THREE_COMPLETE_FOLDS_REQUIRED'],result_usage:'DEVELOPMENT_ONLY'};
  const evaluated=evaluateProductRows(rows,{constantByFold:Object.fromEntries(folds.map(f=>[f.fold,f.train_constant.ordinal])),oldNoSkillOrdinal:Object.fromEntries(folds.map(f=>[f.fold,f.legacy_constant])),identity});
  const improved=folds.filter(f=>f.held.delta_product_loss<-1e-12).length;
  const supported=improved>=2&&evaluated.eligibility.development_qualified&&evaluated.interval.status==='COMPUTED'&&evaluated.interval.ci_upper<0;
  return {status:supported?'PROCEDURE_SUPPORTED':'PROCEDURE_NOT_SUPPORTED',improved_fold_count:improved,...evaluated,
    reason_codes:supported?[]:[...evaluated.eligibility.reason_codes,...(improved<2?['FEWER_THAN_TWO_IMPROVED_FOLDS']:[]),...(evaluated.interval.status!=='COMPUTED'||evaluated.interval.ci_upper>=0?['LOSS_DELTA_INTERVAL_NOT_STRICTLY_NEGATIVE']:[])],
    interpretation:'PROCESS_OOF_DIFFERENT_FOLD_CONFIGURATIONS_NOT_ONE_FIXED_CANDIDATE',result_usage:'DEVELOPMENT_ONLY'};
}
export function oneFollowupHypothesis(procedure){return {hypothesis_id:'PRESERVE_ORDINAL_3_4_UNDER_PRODUCT_LOSS',implemented:false,
  hypothesis:'ONE_GLOBAL_MONOTONE_SCORE_MAPPING_WITH_FIXED_PRODUCT_LOSS_AND_TARGET_GE3_RECALL_CONSTRAINT_MAY_REDUCE_LOW_REPORTING_TRADEOFF',
  evidence:{oof_product_loss:procedure.metrics?.product_loss??null,oof_control_loss:procedure.control?.product_loss??null,
    target_ge3_recall:procedure.metrics?.target_ge3.recall??null,control_target_ge3_recall:procedure.control?.target_ge3.recall??null,
    target_ge3_support:procedure.metrics?.target_ge3.support??null,source:'oof_metrics.json',existing_unconstrained_pava:'V2546_FROZEN_PROCESS_REASSESSED_IN_PRODUCT_RESULT'},
  alternatives:['SPARSE_ORDINAL_3_4_EVENT_SUPPORT','SCORE_ORDER_HAS_WEAK_ORDINAL_2_3_BOUNDARY_SIGNAL'],
  single_change:'ONLY_GLOBAL_MONOTONE_MAPPING_OBJECTIVE_NO_CITY_GT_TIME_SPECIFIC_RULES',
  comparison:'SAME_CONTROL_SCORE_THRESHOLDS_AND_FROZEN_PRODUCT_POLICY',
  stop_conditions:['PRODUCT_LOSS_NOT_BELOW_CONTROL_AND_TRAIN_CONSTANT','TARGET_GE2_OR_GE3_RECALL_DROP_EXCEEDS_0_05','ANY_OBSERVED_CRITICAL_OVERPREDICTION','TARGET_GE3_SUPPORT_BELOW_10_EVENTS_3_DATES'],
  limitation:'UNTESTED_HYPOTHESIS_NOT_SUPPORTED_IMPROVEMENT_NO_AUTOMATIC_NEW_VERSION_OR_BUDGET'};}

export async function computeProductSearch(loaded,plan,{runReplay,progress,cohort:injectedCohort}={}){
  const cohort=injectedCohort||await loadProductReplays(loaded,loaded.train),policy=productPolicy(),space=loaded.searchSpace;
  const runner=cachedReplay(runReplay||((replay,config)=>engineReplay(replay,{...config,engineRoot:loaded.runtime.source})),loaded.runtime.manifest_sha256);
  const referenceScores=new Map(loaded.score.files['reference_parity.json'].rows.map(r=>[r.snapshot_id,r.control_score]));
  const folds=[],searches=[],oof=[];let budget=0;
  for(const assignment of plan.fold_assignments.folds){
    const trainingIds=new Set(assignment.train_members.map(r=>r.snapshot_id)),heldIds=new Set(assignment.held_members.map(r=>r.snapshot_id)),training=cohort.filter(r=>trainingIds.has(r.snapshot_id)),held=cohort.filter(r=>heldIds.has(r.snapshot_id));
    if(assignment.status!=='READY'||training.length!==trainingIds.size||held.length!==heldIds.size)fail('PRODUCT_FOLD_MEMBER_MISMATCH');
    progress?.stage(`产品搜索折 ${assignment.fold}：仅过去 ${assignment.train_dates.length} 日期`);
    const search=await searchProductCohort({cohort:training,searchSpace:space,runReplay:runner,progress,referenceScores});budget+=search.budget.unique_candidates;
    const pool=search.records.filter(r=>r.status==='FEASIBLE'),chosen=rankProduct(pool.filter(r=>r.train_all_guards_pass))[0]||rankProduct(pool.filter(r=>r.basic_guards_pass))[0]||rankProduct(pool)[0];
    if(!chosen){folds.push({fold:assignment.fold,status:'NO_EVALUABLE_FROZEN_CANDIDATE'});searches.push({fold:assignment.fold,...compactSearch(search)});continue;}
    // Candidate and both constant baselines are frozen using training only, before held effects.
    const frozen={...chosen.candidate,frozen_before_holdout:true,training_members_sha256:digest(memberRows(training)),train_constant:search.constant};
    const evaluator=await productEvaluator({cohort:held,searchSpace:space,runReplay:runner,progress,referenceScores,constantReference:search.constant,legacyReference:search.legacy_constant});
    const evaluated=await evaluator.evaluate(frozen);
    if(evaluated.status!=='FEASIBLE'){folds.push({fold:assignment.fold,status:'HELD_COVERAGE_INCOMPLETE',candidate:frozen});searches.push({fold:assignment.fold,...compactSearch(search)});continue;}
    const rows=evaluated.rows.map(r=>({...r,fold:assignment.fold}));
    const heldMetrics=evaluateProductRows(rows,{constantOrdinal:search.constant.ordinal,oldNoSkillOrdinal:search.legacy_constant,identity:{plan:plan.plan_core_sha256,fold:assignment.fold}});
    folds.push({fold:assignment.fold,status:'EVALUATED',candidate:frozen,train_constant:search.constant,legacy_constant:search.legacy_constant,
      train_members:memberRows(training),held_members:memberRows(held),held:heldMetrics,held_legacy:evaluated.legacy,held_slices:productSlices(rows),
      held_support_limit:heldMetrics.eligibility.classification});oof.push(...rows);searches.push({fold:assignment.fold,...compactSearch(search)});
  }
  const procedure=productProcedure(folds,oof,{plan:plan.plan_core_sha256,metric:'COMBINED_PROCESS_OOF'});
  let finalists=[];
  if(procedure.status==='PROCEDURE_SUPPORTED'){
    progress?.stage('产品过程支持：全 TRAIN 最多 100 提议');
    const search=await searchProductCohort({cohort,searchSpace:space,runReplay:runner,progress,referenceScores});budget+=search.budget.unique_candidates;
    finalists=rankProduct(search.records.filter(r=>r.status==='FEASIBLE'&&r.train_all_guards_pass)).slice(0,5).map(r=>({candidate:r.candidate,metrics:r.metrics,control:r.control,
      eligibility:r.eligibility,legacy:r.legacy,constant:search.constant,slices:productSlices(r.rows)}));searches.push({fold:'FINAL_TRAIN',...compactSearch(search)});
  }
  if(budget>policy.search.total_proposals_max)fail('PRODUCT_BUDGET_EXCEEDED');
  const decision={execution_status:'COMPLETED',recommendation:finalists.length?'FREEZE_ONE_DEVELOPMENT_VALIDATION_LIST':procedure.status==='PROCEDURE_SUPPORTED'?'NO_QUALIFIED_TRAIN_CANDIDATE':'STOP_PROCEDURE_NOT_SUPPORTED',
    procedure_status:procedure.status,final_candidate_count:finalists.length,total_proposals:budget,validation_allowed:finalists.length>0,
    result_usage:'DEVELOPMENT_ONLY',formal_capable:false,formal_promotion_allowed:false,selected:null,phase8_ready:false,
    business_conclusion:procedure.reason_codes?.includes('INSUFFICIENT_PRODUCT_SUPPORT')?'INSUFFICIENT_PRODUCT_SUPPORT':finalists.length?'TRAIN_PRODUCT_DEVELOPMENT_QUALIFIED':'NO_QUALIFIED_POINT',
    followup_hypotheses:finalists.length?[]:[oneFollowupHypothesis(procedure)],no_automatic_extra_budget:true};
  const summary=`# V2.5.4.8 受约束产品参数搜索\n\n执行 COMPLETED；${decision.recommendation}，${decision.business_conclusion}。\n\n三折过程 ${procedure.status}，改善折数 ${procedure.improved_fold_count??0}/3，总提议 ${budget}/400；全 TRAIN 最终候选 ${finalists.length}，VALIDATION 许可=${decision.validation_allowed}。\n\nOOF 产品损失 ${procedure.metrics?.product_loss??null}，Control ${procedure.control?.product_loss??null}，最优训练常量 ${procedure.baselines?.[0]?.metrics.product_loss??null}；差值95%CI [${procedure.interval?.ci_lower??null}, ${procedure.interval?.ci_upper??null}]。目标≥2/≥3召回 ${procedure.metrics?.target_ge2.recall??null}/${procedure.metrics?.target_ge3.recall??null}，Control ${procedure.control?.target_ge2.recall??null}/${procedure.control?.target_ge3.recall??null}。\n\n旧 MAE/Bias/QWK/严重错误及支持切片退化完整保留，旧门禁不改写。低报降低损失仍须满足两个召回约束；预测4为零仅为 NOT_ASSESSED，不证明预测4风险。阶段A与过程OOF不能合成固定模型的独立成绩。\n\n过程不支持时合法停止，没有新增 VALIDATION 尝试或同方向预算。最多一项后续改造假设只作未检验建议，不自动运行。全部 DEVELOPMENT_ONLY，无正式 selected 或 Phase 8；TEST 效果未读取。\n`;
  return normalize({'schema.json':{optimization_schema_version:2,optimization_policy_version:5,files:optimizationPolicy(5).package.export_files},'policy.json':optimizationPolicy(5),
    'product_policy.json':productPolicy(),'plan.json':plan,'source_manifest.json':loaded.sourceManifest,'fold_assignments.json':plan.fold_assignments,
    'fold_candidates.json':folds.map(({held,held_legacy,held_slices,...f})=>f),'fold_metrics.json':folds,'oof_predictions.json':oof,'oof_metrics.json':procedure,
    'searches.json':searches,'final_candidates.json':finalists,'decision.json':decision,'reports/summary.md':summary});
}
