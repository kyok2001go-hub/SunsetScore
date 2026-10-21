import { fail } from '../../dataset/lib/common.mjs';
import { scorePolicy, scoreSchema } from '../policy.mjs';
import { closest } from '../statistics.mjs';
import { analyzeBoundaries } from './boundaries.mjs';
import { auditFrozenMappings } from './mapping.mjs';
import { leadTimeAnalysis } from './lead-time.mjs';
import { summarizeTemporal, leadValidity } from './temporal.mjs';
import { evidenceGaps, researchDecision } from './decision.mjs';
import { digest, memberRows, assertSame, normalize } from './common.mjs';

export function makeBoundaryPlan(loaded) {
  const {rows,parent,parentPlan,sourceManifest,contract,accessScope}=loaded;
  const core={score_diagnostic_schema_version:2,score_diagnostic_policy_version:2,result_usage:'DEVELOPMENT_ONLY',
    policy:scorePolicy(2),source_manifest_sha256:digest(sourceManifest),train_members:memberRows(rows),train_records_sha256:digest(rows),
    parent_score_diagnostic_id:parent.manifest.score_diagnostic_id,parent_score_diagnostic_manifest_sha256:digest(parent.manifest),
    parent_score_diagnostic_plan_id:parentPlan.manifest.score_diagnostic_plan_id,parent_score_diagnostic_plan_manifest_sha256:digest(parentPlan.manifest),
    inherited_control_config_sha256:parentPlan.files['plan.json'].control_config_sha256,
    inherited_mappings_sha256:digest(parent.files['fold_calibrators.json']),fold_assignments:parent.files['fold_assignments.json'],
    oof_members:memberRows(rows.filter(r=>r.in_oof)),temporal_contract_sha256:digest(contract),access_scope_sha256:digest(accessScope),
    computation_access_policy:'TRAIN_ONLY',validation_evaluated:false,test_evaluated:false};
  return {...core,plan_core_sha256:digest(core)};
}
export function computeBoundaryDiagnostics(loaded,plan,progress) {
  assertSame(makeBoundaryPlan(loaded),plan,'BOUNDARY_PLAN_SOURCE_CHANGED');
  const {rows,parent,temporal,alignment,contract,accessScope,parentBinding}=loaded;
  const mapped=auditFrozenMappings(rows,parent.files['fold_calibrators.json'],plan.fold_assignments,parent.files['oof_predictions.json']);
  const boundary={},contributions={},lead=[],paired=[];
  const blocked=mapped.reapplication.status!=='PASS';
  if(!blocked) {
    const cohorts={ALL_PRIMARY:rows,OOF:rows.filter(r=>r.in_oof),CLOSEST_PRE_SUNSET:closest(rows.filter(r=>leadValidity(r).status==='VALID'))};
    for(const [cohort,rs] of Object.entries(cohorts)) {
      progress?.stage(`等级边界与十组贡献：${cohort}`);
      const calculated=analyzeBoundaries(rs,cohort,plan.plan_core_sha256);
      boundary[cohort]=calculated.boundaries;contributions[cohort]=calculated.contributions;
      if(!calculated.contributions.reconstruction_pass)fail('BOUNDARY_ORDERED_CONSISTENCY_RECONSTRUCTION_FAILED');
      if(cohort==='OOF') {
        const original=parent.files['discrimination.json'].OOF.ordered_consistency.value;
        if(original!==null&&Math.abs(original-calculated.contributions.reconstructed_ordered_consistency)>scorePolicy(2).reconstruction_tolerance)
          fail('BOUNDARY_PARENT_ORDERED_CONSISTENCY_MISMATCH');
      }
      if(cohort!=='CLOSEST_PRE_SUNSET') {const analysis=leadTimeAnalysis(rs,cohort,plan.plan_core_sha256,temporal);
        lead.push({cohort,buckets:analysis.buckets,invalid_members:analysis.invalid_members,valid_snapshot_count:analysis.valid_snapshot_count,invalid_snapshot_count:analysis.invalid_snapshot_count});
        paired.push(...analysis.paired);}
    }
  }
  const gaps=blocked?[]:evidenceGaps(boundary.OOF,temporal,alignment,paired);
  const outcome=researchDecision({blocked,boundaries:boundary.OOF,mapping:mapped,temporal,alignment,gaps,parentStages:parent.files['stage_summary.json'].OOF});
  const temporalSummary=summarizeTemporal(temporal),targetSummary=summarizeTemporal(alignment);
  const poorFair=contributions.OOF?.poor_fair_credited_contribution_share;
  const fairGood=boundary.OOF?.adjacent.find(r=>r.boundary_id==='adjacent_1_2'),gte2=boundary.OOF?.cumulative.find(r=>r.boundary_id==='gte_2');
  const summary=`# V2.5.4.7 等级边界、校准失效与输入时相专项诊断\n\n`+
    `执行：${outcome.decision.execution_status}。主要行动：${outcome.decision.recommendation}。永久 DEVELOPMENT_ONLY。\n\n`+
    `## 1. 排序信息来自哪些等级\n\n`+
    `OOF 有序一致率=${contributions.OOF?.reconstructed_ordered_consistency??null}，poor/fair 占全部正确加半权并列贡献的比例=${poorFair??null}。`+
    `fair/good AUC=${fairGood?.auc??null}，状态=${fairGood?.status??'BLOCKED'}；>=2 AUC=${gte2?.auc??null}，状态=${gte2?.status??'BLOCKED'}。`+
    `全部四个相邻、四个累计边界及十组分解均保留；不足支持仍列点估计，不能把区间跨 0.5 解释为没有信号。详见 boundary_metrics.json / ordinal_pair_contributions.json。\n\n`+
    `## 2. PAVA 高等级召回失效的数值机制\n\n`+
    mapped.audits.map(f=>`- 折 ${f.fold}：映射范围 [${f.continuous_range.min}, ${f.continuous_range.max}]，可产生离散等级 ${f.possible_discrete_ordinals.join('/')}；`+
      `TP=${f.high_grade_counts.snapshot_counts.tp}、FP=${f.high_grade_counts.snapshot_counts.fp}、FN=${f.high_grade_counts.snapshot_counts.fn}；机制 ${f.labels.join('、')}。`).join('\n')+
    `\n\n原映射重应用=${mapped.reapplication.status}，没有重新拟合。范围、1.5/2.5/3.5 交点、平台、端点错误贡献及训练/保留组成见 fold_mapping_audit.json。标签仅解释数值，不证明类不平衡或日期迁移造成失效。\n\n`+
    `## 3. 较早与临近日落预测的差别\n\n`+
    paired.filter(r=>r.cohort==='OOF').map(p=>`- ${p.earlier_bucket} → T_0_30M：${p.event_count} Event/${p.date_count} 日期，`+
      `配对 MAE 差值（临近减较早）=${p.delta_mae_interval.point_delta_mae}，95% CI=[${p.delta_mae_interval.ci_lower}, ${p.delta_mae_interval.ci_upper}]，${p.support_status}。`).join('\n')+
    `\n\n全桶和 CLOSEST_PRE_SUNSET 统计见 lead_time_metrics.json；相同 Event 配对、未匹配数和独立高等级 AUC 支持见 paired_event_comparisons.json。非配对桶 Event 组成不同；不凭非配对差异宣布随时间改善。\n\n`+
    `## 4. 输入时相和观测目标能否证实错配\n\n`+
    `已证实违约判断 ${outcome.decision.evidence.proven_mismatch_count} 项，缺口 ${gaps.length} 类。未来预报有效时间正常，不等于未来泄漏；缺输入可获得时间为 UNKNOWN。`+
    `Event 地点/当地日落日期按 IANA 与 UTC 核对；缺实际观测窗口为 UNKNOWN，提交时间不替代观测时间，不追认历史 ±30 分钟限制。`+
    `规则、原始时间和判断逐条见 temporal_contract.json / temporal_audit.json / target_alignment.json。\n\n`+
    `## 本轮交付与停止边界\n\n`+
    outcome.decision.primary_actions.map((a,i)=>`${i+1}. ${a.action}：${a.gap_id??a.hypothesis_id??a.next_step}。证据 ${a.evidence}。`).join('\n')+
    `\n\n具体缺字段、用途、拟议存储/隐私范围与验收方法在 evidence_gaps.json；后续实验 ${outcome.experiments.length} 个，见 next_experiments.json。`+
    `本轮不扩大预算或继续微调，不改 GT/分档/切分/采集端，不部署；团队既有确认保留。当前 OOF 已暴露，不得用作下轮确认性验证。\n\n`+
    `父包 PACKAGE_INTERNAL 与显式来源绑定通过，已核验父 V1 发布前完整 payload 重算回执；未宣称存在另一次不可变 V1 来源 Verify 完成回执。`+
    `本期 SOURCE_LINKED_RECOMPUTED 范围仅本期映射应用与报表统计，没有重新执行 V1 引擎 Replay、PAVA 拟合或搜索。工程验收与真实执行证据另见开发记录。\n`;
  return {'schema.json':scoreSchema(2),'policy.json':scorePolicy(2),'plan.json':plan,'source_manifest.json':loaded.sourceManifest,
    'boundary_metrics.json':boundary,'ordinal_pair_contributions.json':contributions,
    'fold_mapping_audit.json':{audits:mapped.audits,reapplication:mapped.reapplication},'calibration_error_routes.json':mapped.routes,
    'lead_time_metrics.json':lead,'paired_event_comparisons.json':paired,'temporal_contract.json':contract,
    'temporal_audit.json':{rows:temporal,summaries:temporalSummary},'target_alignment.json':{rows:alignment,summaries:targetSummary},
    'evidence_gaps.json':gaps,'next_experiments.json':outcome.experiments,'decision.json':outcome.decision,
    'access_scope.json':accessScope,'parent_binding.json':parentBinding,'reports/summary.md':summary};
}
