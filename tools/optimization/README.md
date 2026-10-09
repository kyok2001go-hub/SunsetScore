# Phase 6 参数优化与候选冻结

V2.5.3 在 V2.5.2 Parameter Sensitivity 之上，对冻结的 Search Space 做受约束联合搜索，
输出可重算的 Optimization 包，并在门禁全部满足时生成不可变 Candidate Freeze。

本模块不修改生产 `js/config.js`，不写 `model_version`，不读取 VALIDATION / TEST 的效果数据。

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
