import {fail} from '../dataset/lib/common.mjs';
import {runReplay as engineReplay} from '../replay/replay-runner.mjs';
import {validationPolicy} from '../validation/validation-policy.mjs';
import {classifyCandidate} from '../validation/lib/selection.mjs';
import {dateBlockBootstrap,bootstrapSeed} from '../validation/lib/stability.mjs';
import {productPolicy,digest} from './policy.mjs';
import {loadProductReplays,readProductModel,memberRows} from './sources.mjs';
import {productEvaluator} from './search.mjs';
import {productSlices} from './metrics.mjs';
import {normalize,evaluateProductRows} from './workflow.mjs';
export async function computeProductValidation(loaded,plan,{runReplay,progress,cohort:injectedCohort}={}){
  const base=injectedCohort||await readProductModel(loaded.paths.model,'VALIDATION',{progress});
  if(digest(memberRows(base))!==digest(plan.validation_members))fail('PRODUCT_VALIDATION_MEMBERS_CHANGED');
  const cohort=injectedCohort||await loadProductReplays(loaded,base),runner=runReplay||((replay,config)=>engineReplay(replay,{...config,engineRoot:loaded.runtime.source}));
  const ev=await productEvaluator({cohort,searchSpace:loaded.searchSpace,runReplay:runner,progress,constantReference:plan.train_constant,legacyReference:plan.old_no_skill_ordinal});
  const metrics=[],predictions=[],legacy=[],slices=[],intervals=[];
  for(const candidate of plan.candidates){
    const evaluated=await ev.evaluate(candidate);
    if(evaluated.status!=='FEASIBLE')fail('PRODUCT_VALIDATION_COVERAGE_INCOMPLETE');
    const rows=evaluated.rows,result=evaluateProductRows(rows,{constantOrdinal:plan.train_constant.ordinal,oldNoSkillOrdinal:plan.old_no_skill_ordinal,identity:{plan:plan.plan_core_sha256,candidate:candidate.candidate_id}});
    const supported=result.eligibility.development_qualified&&result.interval.status==='COMPUTED'&&result.interval.ci_upper<0;
    metrics.push({candidate_id:candidate.candidate_id,candidate,...result,new_classification:supported?'PRODUCT_DEVELOPMENT_SUPPORTED':result.eligibility.classification});
    predictions.push(...rows.map(r=>({...r,candidate_id:candidate.candidate_id})));
    const oldBootstrap=dateBlockBootstrap(rows,bootstrapSeed(plan.plan_core_sha256)),old=evaluated.legacy;
    const oldClassification=classifyCandidate({coverage:evaluated.coverage,control:old.control,candidate:old.metrics,
      noSkill:result.baselines.find(b=>b.id==='LEGACY_TRAIN_WEIGHTED_MEDIAN_ORDINAL').metrics.mae,slices:old.slices,bootstrap:oldBootstrap});
    legacy.push({candidate_id:candidate.candidate_id,legacy_rule_version:2,...old,legacy_classification:oldClassification,old_classification_rewritten:false,old_bootstrap:oldBootstrap});
    slices.push({candidate_id:candidate.candidate_id,slices:productSlices(rows)});intervals.push({candidate_id:candidate.candidate_id,...result.interval});
  }
  const supported=metrics.filter(m=>m.new_classification==='PRODUCT_DEVELOPMENT_SUPPORTED');
  const decision={execution_status:'COMPLETED',recommendation:supported.length?'PRODUCT_DEVELOPMENT_SUPPORTED':'NO_PRODUCT_DEVELOPMENT_SUPPORTED_POINT',
    supported_candidate_ids:supported.map(m=>m.candidate_id),selected:null,result_usage:'DEVELOPMENT_ONLY',formal_capable:false,formal_promotion_allowed:false,phase8_ready:false,
    validation_exposure:'PREVIOUSLY_EXPOSED_DEVELOPMENT_ONLY_NOT_INDEPENDENT_CONFIRMATION',test_effect_evaluated:false,frozen_list_only:true};
  return normalize({'schema.json':{validation_schema_version:2,validation_policy_version:5,files:validationPolicy(5).result_files},'policy.json':validationPolicy(5),
    'product_policy.json':productPolicy(),'plan.json':plan,'source_manifest.json':loaded.sourceManifest,'candidate_sample_predictions.json':predictions,
    'candidate_product_metrics.json':metrics,'legacy_gate_comparison.json':legacy,'slice_metrics.json':slices,'bootstrap.json':intervals,'decision.json':decision,
    'reports/summary.md':`# V2.5.4.8 已暴露 VALIDATION 开发复核\n\n${decision.recommendation}。只复核事前冻结 ${plan.candidates.length} 个配置，原损失、召回、预测4风险、旧门禁和退化均保留。\n\nPRODUCT_DEVELOPMENT_SUPPORTED 只表示新产品开发契约的支持，不改写旧规则 classification；无正式 selected / Phase 8，也不构成独立最终验证。\n`});
}
