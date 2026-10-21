# 0–4 等级产品评价与受约束开发优化（V2.5.4.8）

Product Evaluation Schema 1 / Policy 1 独立于历史 Evaluation/Validation。0 无霞、1 微霞、2 普通、3 很好、4 极佳；稳定枚举仍为 poor/fair/good/very_good/excellent。生产分数阈值 20/40/60/90、GT、UI 和采集均不改变。评价目标为地点及当地日期的整场晚霞，各提前量对比同一 Event 标签；不补造观测窗口，不将输入接收时间作为前置。

## 评价契约

损失矩阵的行是预测、列是实际，固定平方等级差，并将预测 4/实际 0、1 的代价分别设为 24、16。这些价格、召回 0.05 容忍带和支持阈值是 PRD 冻结的开发技术默认，不是用户逐格确认的定价或上线 SLA。

Event confidence 按当前 cohort 的 Snapshot 数归一化。所有全量及固定切片保留计数与加权 5×5 矩阵、product_loss、MAE、signed/absolute Bias、QWK、两方向差值至少 2 的错误、各等级指标、target_ge2（2/3/4）及 target_ge3（3/4）召回/精确率/漏报与预测分布。预测 4 为零时条件精确率=null、grade4_status=NOT_ASSESSED；零次风险事件不证明未来风险为零，必须保留日期/Event/Snapshot 支持。

最优常量枚举 0–4，仅由对应训练部分选定，损失并列选较低 ordinal。固定 1、固定 2 和旧 TRAIN 加权中位 ordinal 分开报告。OOF 使用逐折训练冻结的常量，不用保留标签重新估计。产品资格要求覆盖 100%、损失严格胜过 Control/训练常量、没有已观测到的严重预测 4 高估、两类目标召回相对 Control 下降不超过 0.05，以及目标 3/4 至少 10 Event/3 日期；总报 0/1 不能凭风险为零合格。

## 冻结来源

私有 sources JSON 使用 sources_schema_version=1，以下路径相对该 JSON 所在目录解析。未知字段/版本、路径替换、来源/配置/成员变化拒绝。

```json
{
  "sources_schema_version": 1,
  "raw": "<raw-package>",
  "gt": "<gt-package>",
  "model": "<model-package>",
  "baseline": "<baseline-package>",
  "sensitivity": "<sensitivity-package>",
  "diagnosticPlan": "<v2545-plan>",
  "diagnosticResult": "<v2545-result>",
  "scorePlan": "<v2546-plan>",
  "scoreResult": "<v2546-result>",
  "sourceRuntime": "<v2545-runtime>",
  "scoreRuntime": "<v2546-runtime>",
  "runtimeBundle": "<new-product-runtime>",
  "historyLedgers": "<declared-history-registry.json>",
  "accessLedger": "<primary-access-ledger>",
  "fixedOptimizations": ["<same-model-legacy-optimization>"],
  "fixedValidations": ["<same-model-frozen-legacy-validation>"],
  "rawParent": "<parent-raw-package>"
}
```

rawParent 可省略；未找到父清单时记 SOURCE_EVIDENCE_GAP，不能推断排除原因。提供父包时核对 Manifest Hash 以及父子 Snapshot ID 集之差与排除记录完全一致。不会仅为新评价再次派生 Raw。

新 Runtime 必须包含最终执行源码，评分 Runtime 与 V2.5.4.6 相同；源码改变后必须另冻 Runtime/Plan，不能用旧 Hash 继续发布。sources/日志放在应用 Git 根外的 ../.tmp/product-v48/，产物不写入本机绝对路径。

## 阶段 A：先重评冻结预测

```powershell
npm run product:plan -- --sources <sources.json> --policy-version 1 --output dataset/product_evaluation
npm run product:run -- --plan <product-plan-dir> --sources <sources.json> --output dataset/product_evaluation
npm run product:validate -- --input <product-result-dir> --sources <sources.json>
npm run product:stats -- --input <product-result-dir>
```

Plan 冻结完整 roster、Policy、成员、原三折、Control/配置、父包/五源/Runtime、统计及访问历史前缀。三面板 TRAIN_FIXED、OLD_VALIDATION_FIXED、PROCESS_OOF 分开；名单只能来自声明的历史包，不扫描所有 TRAIN 点寻找最佳旧验证效果。固定矩阵已有逐样本值直接汇总，旧搜索点无逐样本 TRAIN 预测记 PREDICTIONS_UNAVAILABLE，不从 MAE 推断产品损失，不隐式重跑 Replay。原 PAVA 只重应用验证逐样本值，无拟合；三折 PAVA/三折搜索均不能当作一个完整配置。

阶段 A 的固定配置选择仅看 TRAIN_FIXED 资格和日期损失区间，不从旧 VALIDATION 排名反馈。若存在稳定合格固定配置，冻结该配置进入一次开发复核；否则才允许新搜索。原 published classification/gates 保留，结果只为 DEVELOPMENT_REASSESSMENT。

## 阶段 B：显式 Optimization 2/5

```powershell
npm run optimization:plan -- --optimization-version 5 --sources <sources.json> --product-plan <product-plan-dir> --product-result <product-result-dir> --output dataset/optimization
npm run optimization:run -- --optimization-version 5 --plan <search-plan-dir> --sources <sources.json> --output dataset/optimization
npm run optimization:validate -- <optimization-dir> --sources <sources.json>
```

可用 product:search-plan / product:search-run 调用同一适配器。旧 Optimization Policy 1–4 默认及重算不变，Policy 5 永久 formal_capable=false；不能通过旧构建器绕过 Product 冻结 Plan。

仅原五单元，Registry 探针生成空间，不使用全 TRAIN 效果筛选小折空间。每折 80+20=100 提议，三折原日期 10→4、14→3、17→3；过程支持后全 TRAIN 最多 100，总预算不超过 400。无效计费、重复不计费。质量/Pareto 4/2/2 选择器在每次 beam/refinement 都应用，Pareto 为产品损失/严重高估率最小、目标≥3召回最大，null 不当成零或最佳；排序并列以目标≥2召回、MAE、改动数、距离及 ID 裁决。

各折只用过去训练标签选候选和两种常量，冻结后再评保留；OOF 合并计算支持及损失差值 2000 次日期块 Bootstrap，至少两折改善、合并资格通过且区间上界<0 才允许最终 TRAIN 搜索。弱支持不填最终名单。过程不支持合法停止，无新 VALIDATION 尝试；最多输出一项后续未检验假设，不自动加预算或新版本。

## 一次 Validation 2/5 开发复核

```powershell
npm run validation:plan -- --validation-version 5 --mode development --sources <sources.json> --product-plan <product-plan-dir> --product-result <product-result-dir> --optimization <optimization-dir> --output dataset/validation
npm run validation:run -- --plan <product-validation-plan-dir> --sources <sources.json> --output dataset/validation
npm run validation:validate -- <validation-dir> --sources <sources.json>
```

固定配置路线可省 optimization，名单来自阶段 A 冻结选择；搜索路线必须由过程支持后的全 TRAIN 合格点产生，最多 5 个。Plan 发布前在所有已知账本及 Model 根登记名单 Hash，同一 Product Plan 不能换名单或输出根重复尝试。相同 Plan 重算/恢复允许；删除产物不删除历史。计划位于 validation/product_plans/exports。

只读已暴露 VALIDATION，输出新指标、旧门禁及 Bootstrap。PRODUCT_DEVELOPMENT_SUPPORTED 不改写旧规则结果，也不构成独立最终验证、正式 selected 或 Phase 8。

## 读取、重算与维护

完整性读取与效果计算区分。统计 Model 白名单只允许 TRAIN/VALIDATION；TEST 通过独立结构投影器只保留 Snapshot/Event/地点/日期/切分，GT、分数及效果不进入计算。审计成员重叠、历史账本和已知工具读取范围，独立性不确定记 UNKNOWN；新 ID 不恢复盲性。

共享维护租约、活动锁、最终来源复核、staging、原子发布及去重沿用。指标保留 12 位规范化；冻结 Plan、来源、Policy、配置及候选变化量保持原始规范字节，不被指标舍入改写。阶段 A 新进程从冻结逐样本预测重新汇总，范围 FROZEN_PREDICTION_RESUMMARIZATION_NO_REPLAY；搜索/开发复核新进程完整 Replay，范围 FULL_PRODUCT_REPLAY_AND_STATISTICS。独立 validate 声明实际重算范围。stats 只读。

维护 Phase 24/25 为 Product Plan/Result，Phase 26 为 Product Validation Plan；Optimization/Validation 2/5 接入原节点及父 Product/Runtime/旧来源血缘。治理封装沿用 Governance Schema 1，ID 的 _v1_ 前缀与内层 Optimization/Validation Schema 2 分别表示不同契约。
