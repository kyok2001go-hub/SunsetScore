# Phase 5–7 开发诊断（V2.5.4.5）

Diagnostic Schema 1 / Policy 1 永久输出 `DEVELOPMENT_ONLY`。TRAIN 固定矩阵、三折向前日期块独立搜索、保留折评估与 OOF 判定都在同一冻结 Plan 中；仅 `PROCEDURE_SUPPORTED` 才运行全 TRAIN 最终搜索。VALIDATION 必须另行执行，TEST 效果文件不进入诊断计算。

从应用根目录使用 Node.js 24 执行。先保存当前工具的 Runtime，旧 Runtime 保留：

```powershell
npm run experiment-runtime:freeze -- --protocol-version 1 --output dataset/experiment_runtime
```

在仓库外创建 `../.tmp/optimization-v45/sources.json`。所有路径相对该 JSON 所在目录解析；填写已有完整包路径和刚返回的 Runtime 路径。路径仅用于本机解析，发布包只保存身份和 Hash。

```json
{
  "sources_schema_version": 1,
  "raw": "../../SunsetScore-main/dataset/exports/raw_v1_20260909_20261012_ea82b68bfe49",
  "gt": "../../SunsetScore-main/dataset/ground_truth/exports/gt_v3_ea82b68bfe49_49c9adac6188",
  "model": "../../SunsetScore-main/dataset/model/exports/model_v2_ea82b68bfe49_49c9adac6188_f02dbabc357c",
  "baseline": "../../SunsetScore-main/dataset/evaluation/exports/baseline_v2_f02dbabc357c_996f7e5da2ec",
  "sensitivity": "../../SunsetScore-main/dataset/tuning/exports/sensitivity_v2_f02dbabc357c_6f05bd3cbce3",
  "runtimeBundle": "../../SunsetScore-main/dataset/experiment_runtime/exports/<新Runtime完整ID>",
  "historyLedgers": "history-ledgers.json",
  "accessLedger": "../../SunsetScore-main/dataset/validation/access-ledger"
}
```

同目录 `history-ledgers.json` 必须列出全部其他已知历史账本。主账本和 Model 数据根账本自动加入；本项目已知另有以下历史账本，不能通过更换输出目录恢复独立性：

```json
{
  "history_ledgers_schema_version": 1,
  "ledgers": [
    { "key": "legacy_v2541", "path": "../v2541-chain/dataset/validation/access-ledger" }
  ]
}
```

冻结 Plan 后执行诊断。`<Plan完整ID>` 和 `<结果完整ID>` 使用命令返回值：

```powershell
npm run optimization:diagnose-plan -- --sources ../.tmp/optimization-v45/sources.json --output dataset/optimization_diagnostics
npm run optimization:diagnose-run -- --plan dataset/optimization_diagnostics/plans/exports/<Plan完整ID> --sources ../.tmp/optimization-v45/sources.json --output dataset/optimization_diagnostics
npm run optimization:diagnose-validate -- --input dataset/optimization_diagnostics/exports/<结果完整ID> --sources ../.tmp/optimization-v45/sources.json
```

`diagnose-run` 发布前在冻结 Runtime 的新进程独立重算全部结果并比较 Hash；其纯 Replay 缓存只在单次计算内共享，验收进程不复用。相同 Plan 重试会重新计算、去重发布，并补齐完成收据；活动锁或维护租约被强杀留下时不自动删除。源变化、重算差异和并发访问均明确失败，失败前的 TRAIN 访问记录保留。

结果位于 `dataset/optimization_diagnostics/exports/`：`matrix_metrics`、`sample_diagnostics`、`grade_metrics`、`prediction_distribution`、`slice_metrics`、`fold_assignments`、`fold_candidates`、`fold_metrics`、`oof_summary`、`searches`、`reference_parity`、`decision` 和 `reports/summary` 都使用规范化 JSON。逐样本保存分数、等级、误差差值和 Event 权重；五级矩阵固定 5×5，无真实等级支持的召回为 null。高等级合并召回固定使用真实/预测 ordinal≥2。组合对照仅表示总效应。

当前 20 日期对应 10→4、14→3、17→3；每折重新估计仅基于训练部分的 Event 加权中位 no-skill。保留折标签不参与空间、搜索排序或候选冻结；每折只评估一个基础门禁最优点。LODO 仍是固定候选删除日期的统计，不能冒称此次内层验证。OOF 表示三个不同候选的过程表现。

每次搜索最多 80 粗搜索/beam + 20 refinement 提议，非法提议计费，重复不计费；beam 每次选择最多 4 个全门禁点、2 个基础门禁 Pareto 点、2 个其他 Pareto 点，再按冻结顺序补席。固定矩阵最多 40 向量，总上限 440。预算耗尽为 `BUDGET_EXHAUSTED`，不宣称收敛。`mae_best`、`basic_guard_candidates`、`train_qualified_candidates` 分开输出；没有全门禁点不补足候选。

只有 `decision.auto_validation_allowed=true` 才继续 [Optimization Policy 4 和 Validation Policy 4](../optimization/README.md#v2545-开发策略4)。其余停止状态保留诊断结果，不追加同方向预算或自动访问 VALIDATION。所有开发结果不授权 Phase 8 或部署。

已接入 `dataset:lineage` / `dataset:prune`；跨数据根保存引用保护，账本不随结果删除。包内校验与来源重算的证据范围分开报告。
