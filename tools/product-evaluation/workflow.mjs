import {compare,fail} from '../dataset/lib/common.mjs';
import {scoreToOrdinal} from '../evaluation/metrics.mjs';
import {dateFolds,estimateNoSkill} from '../optimization-diagnostics/engine.mjs';
import {predictPava} from '../score-diagnostics/statistics.mjs';
import {digest,productPolicy,productSchema} from './policy.mjs';
import {productMetrics,estimateConstant,qualification,deltaLossInterval,productSlices,productSupportSufficient,q} from './metrics.mjs';
import {memberRows,frozenRoster,legacyValidationRows,readProductModel} from './sources.mjs';
import {rankProduct} from './selection.mjs';
const IMMUTABLE_KEYS=new Set(['plan.json','source_manifest.json','product_policy.json','policy.json','schema.json','mapping_audit.json','raw_lineage_audit.json','test_access_audit.json','candidate','effective_config']);
export function normalize(value,key=''){
  if(IMMUTABLE_KEYS.has(key))return value;
  return value==null?value:typeof value==='number'?q(value):Array.isArray(value)?value.map(v=>normalize(v)):typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,k)])):value;
}
export async function makeProductPlan(loaded,sourceManifest=loaded.sourceManifest){
  const roster=await frozenRoster(loaded),policy=productPolicy();
  const core={product_evaluation_schema_version:1,product_evaluation_policy_version:1,policy,product_policy_sha256:digest(policy),
    source_manifest_sha256:digest(sourceManifest),result_usage:'DEVELOPMENT_ONLY',formal_capable:false,test_effect_evaluated:false,
    target:policy.target,roster,roster_sha256:digest(roster),train_members:memberRows(loaded.train),train_rows_sha256:digest(loaded.train),
    validation_members:loaded.structural.VALIDATION,test_members_sha256:digest(loaded.structural.TEST),
    mapping_audit_sha256:digest(loaded.mapping),raw_lineage_sha256:digest(loaded.rawLineage),test_access_audit_sha256:digest(loaded.testAudit),
    train_constant:estimateConstant(loaded.train),old_no_skill_ordinal:estimateNoSkill(loaded.train),
    fold_assignments:loaded.scorePlan.files['plan.json'].fold_assignments,
    allowed_next_steps:{fixed_candidate_then_one_validation:true,conditional_single_search_plan:true,total_search_proposals_max:400,phase8:false},
    evaluation_read_allowlist:['PARENT_TRAIN_PREDICTIONS','DECLARED_FROZEN_OLD_VALIDATION_CANDIDATES_ONLY'],
    observation_window_required:false,input_receipt_time_required:false,scheduled_slots_preserved:['1213','1613','1755','1720']};
  if(digest(dateFolds(loaded.train))!==digest(core.fold_assignments))fail('PRODUCT_ORIGINAL_FOLDS_CHANGED');
  return {...core,plan_core_sha256:digest(core)};
}
export function bindPredictions(base,predictions,{predicted='experiment_ordinal',score='experiment_score',allowSubset=false}={}){
  const source=new Map(base.map(r=>[r.snapshot_id,r])),seen=new Set();
  const rows=predictions.map(p=>{const r=source.get(p.snapshot_id);if(!r||seen.has(p.snapshot_id)||['event_id','event_date_local','location_key','gt_ordinal'].some(k=>p[k]!==undefined&&p[k]!==r[k])||p.gt_confidence!==undefined&&Math.abs(p.gt_confidence-r.gt_confidence)>1e-12)fail('PRODUCT_PREDICTION_MEMBER_OR_GT_MISMATCH');
    seen.add(p.snapshot_id);if(p[score]!=null&&scoreToOrdinal(p[score])!==p[predicted])fail('PRODUCT_PREDICTION_SCORE_ORDINAL_MISMATCH');
    return {...r,predicted_ordinal:p[predicted],control_ordinal:p.control_ordinal??scoreToOrdinal(p.control_score),fold:p.fold??null};});
  if(!allowSubset&&seen.size!==base.length)fail('PRODUCT_PREDICTION_COVERAGE_INCOMPLETE');return rows.sort((a,b)=>compare(a.snapshot_id,b.snapshot_id));
}
export function evaluateProductRows(rows,{constantOrdinal,constantByFold,oldNoSkillOrdinal,identity,coverage=1}={}){
  const metrics=productMetrics(rows),control=productMetrics(rows,'control_ordinal');
  const baselines=[{id:'TRAIN_OPTIMAL_PRODUCT_CONSTANT',rows:rows.map(r=>({...r,constant:constantByFold?constantByFold[r.fold]:constantOrdinal}))},
    ...[1,2].map(ordinal=>({id:`FIXED_ORDINAL_${ordinal}`,rows:rows.map(r=>({...r,constant:ordinal}))})),
    {id:'LEGACY_TRAIN_WEIGHTED_MEDIAN_ORDINAL',rows:rows.map(r=>({...r,constant:typeof oldNoSkillOrdinal==='object'?oldNoSkillOrdinal[r.fold]:oldNoSkillOrdinal}))}]
    .map(b=>({id:b.id,metrics:productMetrics(b.rows,'constant')}));
  const eligibility=qualification(metrics,control,baselines[0].metrics.product_loss,coverage),interval=deltaLossInterval(rows,identity);
  return normalize({metrics,control,baselines,eligibility,interval,delta_product_loss:metrics.product_loss===null?null:metrics.product_loss-control.product_loss,
    low_reporting_only_risk:{underprediction_ge2_change:metrics.underprediction_ge2-control.underprediction_ge2,target_ge2_recall_change:metrics.target_ge2.recall===null?null:metrics.target_ge2.recall-control.target_ge2.recall,
      target_ge3_recall_change:metrics.target_ge3.recall===null?null:metrics.target_ge3.recall-control.target_ge3.recall,
      recall_preserved:eligibility.gates.filter(g=>g.gate.includes('RECALL')).every(g=>g.status==='PASS')},
    grade4_evidence:metrics.grade4_status,scope:'DEVELOPMENT_REASSESSMENT',formal_capable:false});
}
export async function computeReassessment(loaded,plan,progress){
  if(loaded.mapping.status!=='PASS')return blockedReassessment(loaded,plan);
  const metrics=[],unavailable=[],slices=[],bootstrap=[],cohorts=[],legacy=[];
  const train=loaded.train;
  const matrix=loaded.diagnostic.files['sample_diagnostics.json'];
  const validationBases=new Map(),validationSamples=new Map();
  // This function is entered only after a TRAIN+VALIDATION access record; the roster is frozen already.
  if(plan.roster.some(r=>r.panel==='OLD_VALIDATION_FIXED')){
    const base=await readProductModel(loaded.paths.model,'VALIDATION',{progress});
    for(const r of plan.roster.filter(r=>r.panel==='OLD_VALIDATION_FIXED'))validationBases.set(r.source_id,base);
    for(const id of validationBases.keys())validationSamples.set(id,await legacyValidationRows(loaded,id));
  }
  const foldConstants={},oldFoldConstants={};for(const f of plan.fold_assignments.folds){const ids=new Set(f.train_members.map(r=>r.snapshot_id)),part=train.filter(r=>ids.has(r.snapshot_id));foldConstants[f.fold]=estimateConstant(part);oldFoldConstants[f.fold]=estimateNoSkill(part);}
  for(const item of plan.roster){
    if(item.availability==='PREDICTIONS_UNAVAILABLE'){unavailable.push({...item,reason_code:'NO_FROZEN_TRAIN_SAMPLE_PREDICTIONS_AGGREGATE_METRICS_NOT_RECONSTRUCTED'});continue;}
    let rows;
    if(item.panel==='TRAIN_FIXED')rows=bindPredictions(train,matrix.filter(r=>r.candidate_id===item.candidate_id));
    else if(item.panel==='OLD_VALIDATION_FIXED')rows=bindPredictions(validationBases.get(item.source_id),validationSamples.get(item.source_id).rows.filter(r=>r.candidate_id===item.candidate_id),{predicted:'candidate_ordinal',score:'candidate_score'});
    else if(item.candidate_id==='V2546_PAVA_PROCESS'){
      const parent=loaded.score.files['oof_predictions.json'],mappings=new Map(loaded.score.files['fold_calibrators.json'].map(m=>[m.fold,m]));
      for(const r of parent){const reapplied=predictPava(mappings.get(r.fold),r.score);if(reapplied.ordinal!==r.calibrated_ordinal||reapplied.ordinal_estimate!==r.calibrated_estimate)fail('PRODUCT_ORIGINAL_PAVA_APPLICATION_CHANGED');}
      rows=bindPredictions(train,parent,{predicted:'calibrated_ordinal',score:'<PAVA_IS_NOT_RAW_SCORE>',allowSubset:true});
    }else rows=bindPredictions(train,loaded.diagnostic.files['oof_summary.json'].samples,{allowSubset:true});
    if(item.panel==='PROCESS_OOF'){
      const held=new Map(plan.fold_assignments.folds.flatMap(f=>f.held_members.map(r=>[r.snapshot_id,f.fold])));
      if(rows.length!==held.size||rows.some(r=>held.get(r.snapshot_id)!==r.fold))fail('PRODUCT_OOF_COHORT_CHANGED');
    }
    if(item.panel==='TRAIN_FIXED')for(const r of rows){const parent=loaded.score.files['reference_parity.json'].rows.find(p=>p.snapshot_id===r.snapshot_id);if(r.control_ordinal!==scoreToOrdinal(parent.control_score))fail('PRODUCT_CONTROL_SUBSTITUTION');}
    const panelKey=`${item.panel}/${item.source_id}/${item.candidate_id}`,cohortHash=digest(memberRows(rows));
    const referenceRows=item.panel==='OLD_VALIDATION_FIXED'?validationSamples.get(item.source_id).reference:loaded.score.files['reference_parity.json'].rows;
    const referenceById=new Map(referenceRows.map(r=>[r.snapshot_id,r])),coverage=rows.length?rows.filter(r=>referenceById.get(r.snapshot_id)?.pass===true).length/rows.length:0;
    const evaluated=evaluateProductRows(rows,{constantOrdinal:plan.train_constant.ordinal,
      ...(item.panel==='PROCESS_OOF'?{constantByFold:Object.fromEntries(Object.entries(foldConstants).map(([k,v])=>[k,v.ordinal])),oldNoSkillOrdinal:oldFoldConstants}:{oldNoSkillOrdinal:plan.old_no_skill_ordinal}),
      coverage,identity:{plan:plan.plan_core_sha256,panel:panelKey,cohort:cohortHash}});
    const result={panel_key:panelKey,panel:item.panel,source_id:item.source_id,candidate_id:item.candidate_id,label:item.label,
      candidate:item.candidate??null,cohort_sha256:cohortHash,reference_source_coverage:coverage,comparison_scope:item.panel==='PROCESS_OOF'?'PROCESS_OOF_NOT_A_FIXED_CONFIGURATION':'SAME_COHORT_FIXED_CONFIGURATION',...evaluated};
    metrics.push(result);slices.push({panel_key:panelKey,slices:productSlices(rows)});bootstrap.push({panel_key:panelKey,...evaluated.interval});
    cohorts.push({panel_key:panelKey,members:memberRows(rows),cohort_sha256:cohortHash,runtime_identity:item.panel==='OLD_VALIDATION_FIXED'?loaded.legacy[item.source_id].manifest.engine_runtime_sha256??'LEGACY_FROZEN_RUNTIME':loaded.sourceManifest.runtimes.sourceRuntime.id});
    const oldMatrix=item.panel==='TRAIN_FIXED'?loaded.diagnostic.files['matrix_metrics.json'].find(r=>r.candidate.candidate_id===item.candidate_id):null;
    const oldValidation=item.panel==='OLD_VALIDATION_FIXED'?validationSamples.get(item.source_id).gates.find(g=>g.candidate_id===item.candidate_id):null;
    if(item.panel==='OLD_VALIDATION_FIXED'&&!oldValidation)fail('PRODUCT_LEGACY_CLASSIFICATION_MISSING');
    legacy.push({panel_key:panelKey,legacy_classification:oldValidation?.classification??item.legacy_classification??'PROCESS_OOF',
      legacy_gates:oldValidation?{policy_version:validationSamples.get(item.source_id).policy_version,reason_codes:JSON.parse(oldValidation.reason_codes_json)}:oldMatrix?.gates??null,
      legacy_process_decision:item.panel==='PROCESS_OOF'?(item.candidate_id==='V2546_PAVA_PROCESS'?loaded.score.files['decision.json']??null:loaded.diagnostic.files['decision.json']??null):null,
      old_classification_rewritten:false,new_classification:evaluated.eligibility.classification});
    progress?.update(`产品重评 ${metrics.length}/${plan.roster.length} · ${item.panel}`);
  }
  const qualified=rankProduct(metrics.filter(m=>m.panel==='TRAIN_FIXED'&&m.eligibility.development_qualified&&m.interval.status==='COMPUTED'&&m.interval.ci_upper<0).map(m=>({...m,status:'FEASIBLE'})));
  const chosen=qualified[0]||null;
  const decision={execution_status:'COMPLETED',recommendation:chosen?'VALIDATE_FIXED_CONFIGURATION':'RUN_ONE_CONSTRAINED_TRAIN_SEARCH',
    fixed_configuration:chosen?.candidate??null,selection_uses:'TRAIN_FIXED_ONLY_NO_VALIDATION_RANK_FEEDBACK',selected:null,formal_promotion_allowed:false,phase8_ready:false,
    product_support_sufficient:productSupportSufficient(productMetrics(train.map(r=>({...r,predicted_ordinal:0}))).target_ge3.support),
    comparison_panel_count:3,unavailable_prediction_sets:unavailable.length,result_usage:'DEVELOPMENT_ONLY',old_classifications_unchanged:true,
    next_search_budget_max:chosen?0:400,observation_window_required:false,input_receipt_time_required:false};
  const summary=`# V2.5.4.8 0–4 等级产品重评\n\n执行 COMPLETED；下一步 ${decision.recommendation}。全部结论为 DEVELOPMENT_REASSESSMENT / DEVELOPMENT_ONLY。\n\n损失矩阵为预测行、实际列；0/1/2/3/4 分别为无霞/微霞/普通/很好/极佳，target_ge2=2/3/4、target_ge3=3/4。数值代价和 0.05 召回容忍带是本方案冻结的技术默认，不是上线 SLA。\n\n${metrics.map(m=>`- ${m.panel} / ${m.candidate_id}：产品损失 ${m.metrics.product_loss}（Control ${m.control.product_loss}），目标≥2/≥3召回 ${m.metrics.target_ge2.recall}/${m.metrics.target_ge3.recall}；预测4 ${m.metrics.predicted4_support.snapshot_count} 条/${m.metrics.predicted4_support.event_count} Event/${m.metrics.predicted4_support.date_count} 日期，${m.metrics.grade4_status}；${m.eligibility.classification}。`).join('\n')}\n\n缺逐样本预测 ${unavailable.length} 组，保留 PREDICTIONS_UNAVAILABLE；未从聚合 MAE 猜算损失，也未重复 Replay。PROCESS_OOF 是逐折不同映射/配置，不能当一个固定候选；不同 cohort/Runtime 不排总榜。\n\n输入/观测时间不是本期前置；Event 当日晚霞整体表现作为各提前量共同标签。1755/1720 与提前量分开保留。TEST 只投影成员与访问结构，不计算效果，独立性未被证明；旧标签、旧失败、旧门禁和包均保留。工程和开发支持不等于最终独立验证或上线授权。\n`;
  return normalize({'schema.json':productSchema(),'product_policy.json':productPolicy(),'plan.json':plan,'source_manifest.json':loaded.sourceManifest,
    'mapping_audit.json':loaded.mapping,'raw_lineage_audit.json':loaded.rawLineage,'test_access_audit.json':loaded.testAudit,
    'candidate_product_metrics.json':{panels:metrics,predictions_unavailable:unavailable,no_global_cross_cohort_ranking:true},
    'constant_baselines.json':{global_train:plan.train_constant,fold_train:foldConstants,legacy_train_ordinal:plan.old_no_skill_ordinal,comparisons:metrics.map(m=>({panel_key:m.panel_key,baselines:m.baselines}))},
    'confusion_matrix.json':metrics.map(m=>({panel_key:m.panel_key,candidate:m.metrics.confusion_matrix,control:m.control.confusion_matrix})),
    'risk_and_recall.json':metrics.map(m=>({panel_key:m.panel_key,candidate:m.metrics,control:m.control,low_reporting_only_risk:m.low_reporting_only_risk})),
    'legacy_gate_comparison.json':legacy,'cohort_identity.json':cohorts,'slice_metrics.json':slices,'bootstrap.json':bootstrap,'decision.json':decision,'reports/summary.md':summary});
}
function blockedReassessment(loaded,plan){
  const p=Object.fromEntries(productSchema().result_files.map(file=>[file,[]]));return {...p,'schema.json':productSchema(),'product_policy.json':productPolicy(),'plan.json':plan,
    'source_manifest.json':loaded.sourceManifest,'mapping_audit.json':loaded.mapping,'raw_lineage_audit.json':loaded.rawLineage,'test_access_audit.json':loaded.testAudit,
    'decision.json':{execution_status:'BLOCKED',recommendation:'REPAIR_ORDINAL_MAPPING_BEFORE_CANDIDATE_COMPARISON',result_usage:'DEVELOPMENT_ONLY',formal_promotion_allowed:false,selected:null,phase8_ready:false},
    'reports/summary.md':'# 0–4 映射审计阻断\n\n停止候选比较；保留不可变来源，另立修复计划。\n'};
}
