# Phase 6 参数优化与候选冻结

V2.5.4.8 新增显式 `--optimization-version 5`（Schema 2 / Policy 5），通过冻结 Product Plan/Result 条件启动产品损失目标搜索，永久 `formal_capable=false / DEVELOPMENT_ONLY`。旧 Policy 1–4 默认、文件及门禁保留。先执行产品重评，再按冻结决策选择固定配置复核或一次三折搜索；beam/refinement 同用产品 4/2/2 选择器，总提议最多 400，无资格点不补足名单。命令、来源及停止规则见 [产品评价工具](../product-evaluation/README.md)。

V2.5.3 在 V2.5.2 Parameter Sensitivity 之上，对冻结的 Search Space 做受约束联合搜索，
输出可重算的 Optimization 包，并在门禁全部满足时生成不可变 Candidate Freeze。

本模块不修改生产 `js/config.js`，不写 `model_version`，不读取 VALIDATION / TEST 的效果数据。

Phase 7 治理新增 `--runtime-bundle <快照目录>`：plan / run / validate 由归档工具在独立 Node 进程执行，并返回包外执行收据；stats 不接收此参数。快照身份、环境要求与旧环境恢复边界见 [Experiment Runtime](../experiment-runtime/README.md)。

## 命令

### V2.5.4.1：显式 Policy 2

`--optimization-policy-version 2` 仅接受真实语义校验通过的 Tuning Schema 2 / Policy 3；不带参数继续使用 Policy 1。新策略采用 excellent 软门槛，仍要求至少 3 个充分支持等级及所有非稀有已出现等级 ≥5 Event，保留 TRAIN 总量、日期、Replay、城市/日期集中度及单 GT 等级 ≤60% 的门槛。分母包含所有 excellent Event，不使用成功子集计算支持度。

沿用 Phase 5 README 中声明的 `$TrainSources` 和新 `$Sensitivity`：

```powershell
$OptimizationSources = @($TrainSources) + @('--sensitivity', $Sensitivity)
npm run optimization:plan -- --optimization-policy-version 2 @OptimizationSources
npm run optimization:run -- --optimization-policy-version 2 @OptimizationSources
```

路径示例：`$Sensitivity = 'D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\tuning\exports\sensitivity_v2_<model_hash>_<new_hash>'`，须为 Policy 3 新包。`plan` 是只读预估，`run` 会按所选策略在包内冻结 `optimization_plan.json`，执行中不重新解释策略；两个命令须使用同一显式版本。

```powershell
$Optimization = '<run 返回的 directory>'
npm run optimization:validate -- $Optimization @OptimizationSources
npm run optimization:stats -- $Optimization
```

路径示例：`$Optimization = 'D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\optimization\exports\optimization_v1_<model_hash>_<new_hash>'`；`v1` 是 Schema，不是 Policy。校验/统计自动按包内版本分派。

Policy 2 新增 `gt_level_support.json` 及本轮 TRAIN/上游 TRAIN 支持度绑定，逐候选记录所有 rare Snapshot 成功对与未配对身份，单级指标保留 null 原因。候选排序、Slice、LODO、指标与权重不变。Tuning Policy 3 永久探索，不能因版本数字 ≥3 解锁 FORMAL：本版只生成 `EXPLORATORY_SEARCH`，不能 Freeze 或 Validation 晋级。旧 Tuning 2→Optimization 1 链与新 Tuning 3→Optimization 2 链不得混用。

```powershell
# 只做计划：模式、可用参数、搜索预算、冻结资格
npm run optimization:plan -- --model <model_dir> --raw <raw_dir> --gt <gt_dir> `
  --baseline <evaluation_dir> --sensitivity <sensitivity_dir>

# 执行搜索并发布 Optimization 包
npm run optimization:run -- --model <model_dir> --raw <raw_dir> --gt <gt_dir> `
  --baseline <evaluation_dir> --sensitivity <sensitivity_dir>

# 包内校验（可选完整来源重算）
npm run optimization:validate -- <optimization_dir>
npm run optimization:validate -- <optimization_dir> --model <model_dir> --raw <raw_dir> `
  --gt <gt_dir> --baseline <evaluation_dir> --sensitivity <sensitivity_dir>

# 校验并输出统计摘要
npm run optimization:stats -- <optimization_dir>
```

可选 `--output <dir>` 覆盖默认输出根目录 `dataset/optimization`，`--quiet` 关闭进度输出。

## 运行模式

| 模式 | 条件 | 产物 |
| --- | --- | --- |
| `EXPLORATORY_SEARCH` | 工程就绪，但数据或指标语义未 Ready | 完整探索包，`candidate_freeze_allowed=false` |
| `FORMAL_OPTIMIZATION` | `engineering/data/metric = READY`、Sensitivity `result_usage=FORMAL`、标签集中度通过 | 同上，且通过全部门禁时生成 `candidate_freeze.json` |

Sensitivity Schema 2 的 Policy 2/3 均固定输出 `PROVISIONAL_PROXY / EXPLORATORY_ONLY`，因此当前真实数据
只能进入探索模式；正式模式要求具备真实正式语义及独立映射证据的新 Tuning/Evaluation 策略，
不能只按版本数字判断，也不能用 CLI 参数、修改 manifest 或伪造 readiness 绕过。

## 搜索算法

`DETERMINISTIC_CONSTRAINED_BEAM_COORDINATE_SEARCH`：

| 阶段 | 内容 | 预算 |
| --- | --- | --- |
| Stage A | Control 加 Phase 5 冻结的单参数 coarse probe | 与 Stage B 合计 400 |
| Stage B | 对 beam 中每个父代逐个 Unit 做 Coordinate Expansion，旋转 4 轮 | 同上 |
| Stage C | 对最优候选做两轮局部细化，步长每次减半 | 100 |

所有候选先量化到 12 位小数；SIMPLEX 展开后把舍入余量确定性地放到声明顺序的最后成员，
再按最终生效配置生成 `candidate_id`，相同生效配置在 Replay 前即去重。
遍历顺序固定为 `unit_order` → probe 顺序，预算耗尽时按同一顺序截断。

## Coverage 与门禁

同时记录两个覆盖率：

```text
control_source_coverage_rate     = control 成功数 / 原始 cohort
candidate_control_coverage_rate  = candidate 成功数 / control 成功集
```

探索模式要求两者均不低于 `0.95`；达到门槛但低于 `1.0` 时标记 `PARTIAL_COVERAGE`，
仍可进入探索性 Leaderboard，但不能晋级。正式模式要求两者均为 `1.0`。

探索模式的 `finalists.json` 只表示 Top Search Points，`promotable=false`，结果为
`EXPLORATORY_POINTS_GENERATED`。正式 `PROMOTABLE` 需通过 MAE、severe error、within-1、bias、QWK 门禁，并另加固定
no-skill 比较、逐日期与 LODO 稳健性、Slice 回归门禁（`event_count >= 5` 且
`date_count >= 2` 的 Slice 才算正式支持）。

Phase A 会完整校验 Raw、GT、Model、Evaluation、Sensitivity；Phase B 才切换到 TRAIN-only
白名单。搜索结束、原子发布前会重新指纹五个来源包，构建期间任一来源变化都会拒绝发布。

## 产物

```text
dataset/optimization/exports/<optimization_id>/
├─ manifest.json
├─ schema.json / policy.json
├─ optimization_plan.json / search_space.json
├─ objective_policy.json / guardrail_policy.json
├─ verified_source_identities.json
├─ readiness.json
├─ candidate_trace.csv / candidate_metrics.csv / candidate_guardrails.csv
├─ candidate_date_stability.csv / candidate_slice_regressions.csv
├─ leaderboard.csv / search_points.json / finalists.json
├─ candidate_freeze.json   （仅正式模式且有可晋级候选）
└─ reports/summary.json / reports/warnings.csv
```

身份链无环：`optimization_input_id` → `candidate_id` → `search_result_id` →
`candidate_set_id` → `candidate_freeze.json` → descriptor → `optimization_id`。
`candidate_freeze.json` 不写最终 `optimization_id`，也不写自身 Hash。

## 与维护链路的关系

Phase 6 已在 `tools/maintenance` 中登记，`dataset:lineage` 与 `dataset:prune` 会把它纳入
依赖图，并传播可用的 Validation disclosure evidence 边。删除 Model、Evaluation 或 Sensitivity 包时，Optimization 包进入下游闭包，
构建期间持有共享维护租约。

## V2.5.4-B 正式链

新增 Optimization Schema 2 / Policy 3（--optimization-policy-version 3），须绑定通过独立人工复核的语义证据、冻结 Campaign 和 Protocol 2 Runtime。原有版本沿用原 Policy，不因样本增多而自动升为正式。详见 [Campaign 冻结与准入](../campaign/README.md) 和 [语义准备与独立复核](../metric-semantics/README.md)。
# Model Policy 4 来源兼容（2026-10-14）

支持 Model Schema 2 / Policy 4 的 55/30/15 切分，沿用既有开发/正式 Optimization 策略和预算。Phase 5 的来源关联验收与 TRAIN-only 读取器均须来自新 Model 的同一链；正式链使用匹配的 Campaign Policy 2。新切分不改变参数搜索、Candidate Freeze、Replay 或正式独立性门槛；旧包仍按冻结 Policy 校验，旧 Runtime 不自动升级。
# V2.5.4.5 开发策略4

显式 `--optimization-version 4` 使用 Schema 2 / Policy 4，仅接受 `EXPLORATORY_SEARCH`，永久 `DEVELOPMENT_ONLY`。旧 Policy 1–3 默认行为和读取/重算不变。先完成 [诊断 Plan/Run](../optimization-diagnostics/README.md)，必须过程稳定且存在全 TRAIN 全门禁候选。此适配器复用诊断最终搜索，不把 MAE Top 5 改称合格候选。

以下 PowerShell 命令在应用根目录执行，绑定同一个 sources 文件；将返回的完整 ID 填入对应变量：

```powershell
$sources = (Resolve-Path '../.tmp/optimization-v45/sources.json').Path
$doc = Get-Content -LiteralPath $sources -Raw | ConvertFrom-Json
$s = @{}
foreach ($key in @('raw','gt','model','baseline','sensitivity','runtimeBundle')) {
  $s[$key] = [IO.Path]::GetFullPath((Join-Path (Split-Path $sources) $doc.$key))
}
$diagPlan = 'dataset/optimization_diagnostics/plans/exports/<DiagnosticPlan完整ID>'
$diagResult = 'dataset/optimization_diagnostics/exports/<Diagnostic结果完整ID>'
$common = @('--raw',$s.raw,'--gt',$s.gt,'--model',$s.model,'--baseline',$s.baseline,'--sensitivity',$s.sensitivity,
  '--sources',$sources,'--diagnostic-plan',$diagPlan,'--diagnostic-result',$diagResult)
npm run optimization:plan -- --optimization-version 4 @common --output dataset/optimization
$optPlan = 'dataset/optimization/plans/exports/<OptimizationPlan完整ID>'
npm run optimization:run -- --plan $optPlan @common --output dataset/optimization
$opt = 'dataset/optimization/exports/<Optimization完整ID>'
npm run optimization:validate -- $opt @common --optimization-plan $optPlan
```

`--diagnostic-result` 可省略，此时在该 Diagnostic Plan 数据根中查找唯一对应结果；零个或多个均拒绝。变更参数、预算、策略、来源或候选须生成新 Plan。输出增加 `candidate_quality.json`、`search_selection_trace.json`、`pareto_front.json`、`diagnostic_source.json`，无正式 Freeze。发布在新进程重算完整证据和 Optimization 字节，源复核后原子发布。

结果 Manifest 和 Descriptor 同时绑定冻结 Optimization Plan 的 ID/Hash，进入维护血缘。跨根输出时显式提供 `--optimization-plan`；开发验证也会复核该 Plan、Diagnostic Plan/Run 与 Runtime 的完整指纹。

只在上述阶段通过后执行一次开发 VALIDATION：

```powershell
npm run validation:plan -- --validation-version 4 --mode development --acknowledge-exposed-validation @common --optimization $opt --optimization-plan $optPlan --access-ledger dataset/validation/access-ledger --history-ledgers ../.tmp/optimization-v45/history-ledgers.json --output dataset/validation
$valPlan = 'dataset/validation/plans/<ValidationPlan完整ID>'
npm run validation:run -- --plan $valPlan @common --optimization $opt --optimization-plan $optPlan --access-ledger dataset/validation/access-ledger --history-ledgers ../.tmp/optimization-v45/history-ledgers.json --output dataset/validation
```

失败/中断可用同一 Validation Plan 重试；同一 Diagnostic Plan 换输出目录或另建 Validation Plan 不能重复开启开发复核。访问同步登记到主、Model 根和声明的历史账本，包含 Event 与规范地点/日期身份。Policy 4 复用三层 Replay、Bootstrap 和既有门禁，永久标记已暴露开发用途，不生成 selected 文件。正式准入需未来具备正式契约的新策略与独立 Campaign。
