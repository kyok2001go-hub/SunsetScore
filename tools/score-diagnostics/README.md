# 评分区分能力、校准与误差归因诊断（V2.5.4.6）

Schema 1 / Policy 1 永久为 `DEVELOPMENT_ONLY`。只消费 TRAIN，固定 V2.5.4.5 Control；不执行参数搜索，不拟合全 TRAIN 校准器，不修改生产配置，不输出正式 selected。Node.js 24，在应用根目录运行。

先完成源码修改和测试，再冻结新的诊断 Runtime。历史 Runtime、Diagnostic Plan/Result 保留原样。

```powershell
npm run experiment-runtime:freeze -- --protocol-version 1 --output dataset/experiment_runtime
```

在应用仓库外保存 sources.json。所有路径相对该 JSON 解析；发布产物仅保存身份与 Hash。

```json
{
  "sources_schema_version": 1,
  "raw": "../../SunsetScore-main/dataset/exports/raw_v1_20260909_20261012_ea82b68bfe49",
  "gt": "../../SunsetScore-main/dataset/ground_truth/exports/gt_v3_ea82b68bfe49_49c9adac6188",
  "model": "../../SunsetScore-main/dataset/model/exports/model_v2_ea82b68bfe49_49c9adac6188_f02dbabc357c",
  "baseline": "../../SunsetScore-main/dataset/evaluation/exports/baseline_v2_f02dbabc357c_996f7e5da2ec",
  "sensitivity": "../../SunsetScore-main/dataset/tuning/exports/sensitivity_v2_f02dbabc357c_6f05bd3cbce3",
  "diagnosticPlan": "../../SunsetScore-main/dataset/optimization_diagnostics/plans/exports/optimization_diagnostic_plan_v1_c5a25d693e5eefc0",
  "diagnosticResult": "../../SunsetScore-main/dataset/optimization_diagnostics/exports/optimization_diagnostic_v1_dcb01d5f2b530ac5",
  "sourceRuntime": "../../SunsetScore-main/dataset/experiment_runtime/exports/experiment_runtime_v1_dc118cbb86e0a8af",
  "runtimeBundle": "../../SunsetScore-main/dataset/experiment_runtime/exports/<新Runtime完整ID>",
  "historyLedgers": "../optimization-v45/history-ledgers.json",
  "accessLedger": "../../SunsetScore-main/dataset/validation/access-ledger"
}
```

历史账本注册表必须包含所有已知历史账本。Model 根账本自动合并，访问按实际 TRAIN 成员镜像登记；更换输出目录或删除结果不能恢复独立性。Baseline/Sensitivity 只为冻结 Control、输入完整性和身份关联提供来源，不重算旧敏感度搜索。

```powershell
npm run score:diagnose-plan -- --sources ../.tmp/score-v46/sources.json --output dataset/score_diagnostics
npm run score:diagnose-run -- --plan <上一步Plan目录> --sources ../.tmp/score-v46/sources.json --output dataset/score_diagnostics
npm run score:diagnose-validate -- --input <Result目录>
npm run score:diagnose-validate -- --input <Result目录> --sources ../.tmp/score-v46/sources.json
npm run score:diagnose-stats -- --input <Result目录>
```

不带 sources 的 validate 仅做 `PACKAGE_INTERNAL`，含内容 Hash、固定契约、折映射、成员和 OOF 指标一致性；带 sources 的 validate 执行完整 `SOURCE_LINKED_RECOMPUTED`，包括旧/新 Control Replay、trace 开关逐样本一致性、三次折内拟合和统计。stats 只读已发布包。

run 在新进程从归档 Runtime 完整重算并对比所有 payload Hash，最终复核来源，再原子发布。维护租约、Plan 活动锁、staging、目标锁及同内容去重沿用治理组件；中断残留锁不自动清理。

Plan 冻结完整 Control 配置及 Hash、成员与三折、算法、trace 契约、Bootstrap 种子规则和研究路由；run 不接受覆盖参数。源码改变后须冻结新 Runtime、建立新 Plan，不能重用旧 Runtime Hash。

trace 默认关闭，`runReplay(replay, { modelConfig, trace: true })` 才返回独立 trace，不写 Snapshot。原始数值与最终分数在实际执行边界记录，最后结果须等于原 Control；分数标记 rounded_score。天空演化和黄金窗口只记录已存在的因子及融合边界，其内部贡献标记 PARTIAL_TRACE，不能凭此分摊或作模块因果结论。独立 nowcast 修正未在该 Replay 路径执行，明确列出原因。

Event 权重为 confidence / cohort 内 Snapshot 数，Slice 和 Benchmark 重新归一化。Bootstrap 重复日期乘以原权重，不能抵消重复次数。2000 次固定抽样，有效不足 1900 时区间为 NOT_ESTIMABLE，不补抽。分项 AUC 沿数值自然递增方向计算，反向结果不翻转。

主要路由使用后 10 天相同 OOF cohort。三折 PAVA 和 no-skill 均独立只拟合此前日期；映射 Hash 冻结后才评估保留折。只给 CALIBRATION_RESEARCH / MODULE_RESEARCH / COLLECT_MORE_EVIDENCE / INCONCLUSIVE 建议；一致性错误输出 BLOCKED，禁止静默排除错误样本。MODULE_RESEARCH 还要求支持足够的受影响 fair/高等级、具体 stage 路径、排名或压缩证据、固定规则选例及混杂说明，最多两个假设，不能仅凭分项 AUC 排名决定。

产物位于 dataset/score_diagnostics，报告为 reports/summary.md。`dataset:lineage` / `dataset:prune` 纳入 Phase 22 Plan、Phase 23 Result、历史诊断和双 Runtime 依赖，清理不删除访问历史。

## V2.5.4.7：等级边界、映射与输入时间专项诊断

显式 `--diagnostic-version 2` 选择 Score Diagnostic Schema 2 / Policy 2；省略时仍为 V1。目录及 Governance Schema 1 不变，因此包 ID 仍使用 `score_diagnostic_v1_...` / `score_diagnostic_plan_v1_...` 的治理封装前缀；实际分析版本以 Manifest 的 score_diagnostic_schema_version / score_diagnostic_policy_version 为准。

V2 只读 V2.5.4.6 父包的冻结 Control、OOF、三折映射和 trace。补充证据仅从 Model TRAIN 白名单及对应 Replay 读取；原五源完整文件仅做身份指纹核对，不扫描混合样本表计算效果。不调用 Replay 引擎、不拟合 PAVA、不搜索参数、不改生产采集。父包包内校验、五源/父 Plan/双 Runtime 绑定，以及历史发布前完整重算回执必须通过；不把本期报表复算冒称重新做过 V1 引擎回放。

完成源码和测试后冻结独立的新统计 Runtime。仓库外的 sources.json 使用版本 2，在 V1 全部来源基础上新增 parentPlan / parentResult / parentRuntime；runtimeBundle 改为新的统计 Runtime。示例中的路径均相对 sources.json：

```json
{
  "sources_schema_version": 2,
  "raw": "../../SunsetScore-main/dataset/exports/raw_v1_20260909_20261012_ea82b68bfe49",
  "gt": "../../SunsetScore-main/dataset/ground_truth/exports/gt_v3_ea82b68bfe49_49c9adac6188",
  "model": "../../SunsetScore-main/dataset/model/exports/model_v2_ea82b68bfe49_49c9adac6188_f02dbabc357c",
  "baseline": "../../SunsetScore-main/dataset/evaluation/exports/baseline_v2_f02dbabc357c_996f7e5da2ec",
  "sensitivity": "../../SunsetScore-main/dataset/tuning/exports/sensitivity_v2_f02dbabc357c_6f05bd3cbce3",
  "diagnosticPlan": "../../SunsetScore-main/dataset/optimization_diagnostics/plans/exports/optimization_diagnostic_plan_v1_c5a25d693e5eefc0",
  "diagnosticResult": "../../SunsetScore-main/dataset/optimization_diagnostics/exports/optimization_diagnostic_v1_dcb01d5f2b530ac5",
  "sourceRuntime": "../../SunsetScore-main/dataset/experiment_runtime/exports/experiment_runtime_v1_dc118cbb86e0a8af",
  "parentPlan": "../../SunsetScore-main/dataset/score_diagnostics/plans/exports/score_diagnostic_plan_v1_2cdae03384e06136",
  "parentResult": "../../SunsetScore-main/dataset/score_diagnostics/exports/score_diagnostic_v1_c67c6a7aa15852f4",
  "parentRuntime": "../../SunsetScore-main/dataset/experiment_runtime/exports/experiment_runtime_v1_5804b72a1b6aa63f",
  "runtimeBundle": "../../SunsetScore-main/dataset/experiment_runtime/exports/<新统计Runtime完整ID>",
  "historyLedgers": "../optimization-v45/history-ledgers.json",
  "accessLedger": "../../SunsetScore-main/dataset/validation/access-ledger"
}
```

```powershell
npm run score:diagnose-plan -- --diagnostic-version 2 --parent <上述parentResult目录> --sources ../.tmp/score-v47/sources.json --output dataset/score_diagnostics
npm run score:diagnose-run -- --plan <新Plan目录> --sources ../.tmp/score-v47/sources.json --output dataset/score_diagnostics
npm run score:diagnose-validate -- --input <新Result目录>
npm run score:diagnose-validate -- --input <新Result目录> --sources ../.tmp/score-v47/sources.json
npm run score:diagnose-stats -- --input <新Result目录>
```

Plan 冻结父包、父映射、Control、三套 Runtime、成员、边界、日期折、支持度、时间字段规则和算法。run 不接受版本或算法覆盖。边界包括四组相邻等级、四个累计边界及十组有序贡献，OOF 为主诊断，全部 TRAIN 和最近日落为描述；跨 Event 乘积权重、并列计半、2000 次日期块 Bootstrap，每项种子由 Plan core / 指标 / 切片唯一身份派生，不试种子或补抽。

映射原样重应用，逐样本核对父 OOF。报告连续范围、平台、离散可达等级、1.5/2.5/3.5 交点、端点回退、训练/保留组成与 TP/FP/FN，区分“召回为 0”和“从不预测高等级”。配对固定近端 0–30 分钟和三个较早桶，每 Event 每桶取最近合法时刻，时间并列按 Snapshot ID，≤0/缺时刻/契约冲突单列。非配对差异不宣称时间改善。

时间规则只核对实际记录：未来预报有效时间正常；起报/可获得时间缺失为 UNKNOWN，提交/上传/导出时间不冒充可获得或实际观测时间。IANA 和 UTC epoch 独立核对，保留冲突；来源降级与真实违约分开。采集建议限定字段、用途、拟议位置/隐私及未来验收，不补历史值、不重做团队标签确认。

产物新增 boundary_metrics、ordinal_pair_contributions、fold_mapping_audit、calibration_error_routes、lead_time_metrics、paired_event_comparisons、temporal_contract/audit、target_alignment、evidence_gaps、next_experiments、decision，以及只读范围和父绑定证据。summary.md 回答四个问题，主要行动和后续实验均最多两个，合法 UNRESOLVED / EVIDENCE_COLLECTION 可完成本轮，BLOCKED 则未完成真实验收。

发布前独立进程完整重算本期统计与映射应用。带 sources 的 validate 返回 SOURCE_LINKED_RECOMPUTED，recompute_scope=V2_BOUNDARY_MAPPING_TEMPORAL_STATISTICS_ONLY，明确 engine_replayed=false / pava_refitted=false。历史 V1 默认、产物和归档 Runtime 保留；需要重算 V1 时仍使用其匹配的归档环境。
