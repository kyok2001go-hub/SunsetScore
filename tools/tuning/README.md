# Parameter Sensitivity & Tuning Readiness 工具说明 (Phase 5)

本工具为 SunsetScore V2.5.2 的离线实现，在冻结的 Model Dataset、Baseline Evaluation 与历史 Replay 之上建立参数敏感度实验与调参就绪度判断能力。

纯本地运行：不联网、不执行生产采集、不写 D1 / R2、不修改评分代码与 `js/config.js`。

本版**不寻找最优参数、不发布 Candidate、不修改线上模型**。它回答的是"哪些参数值得调、数据够不够调"，并提供 V2.5.3 所需的候选点评估接口（见 §12）。

## Tuning V2（显式选择）

不带 `--tuning-version` 的命令继续使用历史 V1 契约和 `sensitivity_v1_*` 包。新方案须显式传 `--tuning-version 2`，且 `--baseline` 必须是 Evaluation V2：

```powershell
npm run tuning:readiness -- --tuning-version 2 --model <Model目录> --raw <Raw目录> --gt <GT目录> --baseline <Evaluation-V2目录> --validation-evidence <Evaluation-V1目录>
npm run tuning:plan -- --tuning-version 2 --model <Model目录> --raw <Raw目录> --gt <GT目录> --baseline <Evaluation-V2目录> --validation-evidence <Evaluation-V1目录>
npm run tuning:sensitivity -- --tuning-version 2 --model <Model目录> --raw <Raw目录> --gt <GT目录> --baseline <Evaluation-V2目录> --validation-evidence <Evaluation-V1目录>
npm run tuning:validate -- <sensitivity_v2目录>
npm run tuning:validate -- <sensitivity_v2目录> --model <Model目录> --raw <Raw目录> --gt <GT目录> --baseline <Evaluation-V2目录> --validation-evidence <Evaluation-V1目录>
npm run tuning:stats -- <sensitivity_v2目录>
```

`--validation-evidence` 是显式冻结的验证集披露证据。当前 Model 使用已评估 VALIDATION 的 Evaluation V1 包，输出 `DEVELOPMENT_EXPOSED` 及其 ID/manifest Hash；未提供可验收证据时记录 `NOT_ATTESTED`，绝不从 V2 的 `validation_evaluated=false` 推断为未暴露。完整来源校验使用与构建相同的证据路径。`validate` 不带源路径只做 `PACKAGE_INTERNAL`；仅带 Model 为 `TRAIN_LINKED`；四个来源路径齐全时执行 `SOURCE_LINKED` 与确定性重算。旧包仍按 V1 校验。

V2 构建先完成 Model/Raw/GT 来源验收，再对 Evaluation V2 做 `PACKAGE_INTERNAL` 和 `MODEL_LINKED` 核验，要求 Schema/Policy 2、TRAIN-only、Model 身份 Hash 一致、`PROVISIONAL / PROXY_ORDINAL_ONLY` 映射及完整 TRAIN 冻结的 no-skill ordinal。实验只消费 TRAIN。包内 `control_alignment.csv` 逐 Snapshot 比较历史 Model 分数与冻结配置重算 Control；两者不可直接混称。`sample_deltas.csv` 携带切片所需的 TRAIN 属性，以支持包内切片复核。

实验、Ablation 和 Slice 的代理 GT 指标在各自实际配对集合内重新按 Event 归一化；固定 no-skill ordinal 不重选，分别输出 `paired_no_skill_mae`、Control/Experiment 相对参照的 gap 和空值原因。分数响应指标继续可用于判断参数是否改变模型输出，参数级 `metric_usage=PROXY_EXPLORATORY`。全局就绪度拆分为工程、数据和映射三项；Evaluation V2 的映射仍为 PROVISIONAL，因此当前只发布 `EXPLORATORY_ONLY`，不据此定稿参数。V2 使用 Schema/Policy 2 和 `sensitivity_v2_*` 不可变身份，历史 V1 包字节不变。

---

## 1. 边界与隔离

### 1.1 两阶段访问

| 阶段 | 允许读取 | 禁止 |
| --- | --- | --- |
| A 上游来源验收 | Model / Raw / GT 完整包，含 VALIDATION 与 TEST 的结构与 Hash | 计算 VALIDATION / TEST 的任何指标 |
| B 计算与重算 | `manifest.json`、`schema.json`、`policy.json`、`splits/train.csv`、TRAIN 对应 Replay | 其余任何 Model 路径 |
| C 候选点评估 | 同 B，且在 `--split VALIDATION` 时额外允许 `splits/validation.csv` | `splits/test.csv`、`model_samples.csv`、上游 `reports/` 及阶段 B 未列出的任何路径 |

阶段 B 通过 `lib/input.mjs` 的白名单读取器实现，读取 `splits/validation.csv`、`splits/test.csv`、`model_samples.csv`、`event_splits.csv`、上游 `reports/` 一律以 `TEST_ACCESS_FORBIDDEN` 失败。

准确说法是：上游验收可读取 VALIDATION / TEST 以保证包完整性；敏感度计算与结果重算只消费 TRAIN。

阶段 C 由调用方声明白名单（`candidateAllowFiles(split)`），只向 TRAIN / VALIDATION 敞开；`splits/test.csv` 在 `FORBIDDEN_FILES` 中单独硬拦，即使调用方把 TEST 加进白名单也无法读取。

### 1.2 Replay 身份绑定

TRAIN 每条 Snapshot 都必须找到对应 Replay，且 `snapshot_id`、`event_id`、`config_hash`、`engine_build_sha`、`prediction_time_utc` 五项必须与模型行一致，否则 `REPLAY_IDENTITY_MISMATCH`。

---

## 2. 命令

在 `SunsetScore-main/` 执行。三个计算命令都需要 `--model`、`--raw`、`--gt`、`--baseline`。

```bash
# 就绪度：全局门槛 + 每参数支持量
npm run tuning:readiness -- --model <dir> --raw <dir> --gt <dir> --baseline <dir>

# 计划：实验数量、分类、Replay 数量与预计执行次数（不执行实验）
npm run tuning:plan -- --model <dir> --raw <dir> --gt <dir> --baseline <dir>

# 全量敏感度：执行实验并发布不可变数据包
npm run tuning:sensitivity -- --model <dir> --raw <dir> --gt <dir> --baseline <dir>

# 校验：默认包内校验，附带四个来源路径时执行 TRAIN_LINKED 重算比对
npm run tuning:validate -- <sensitivity_dir> [--model <dir> --raw <dir> --gt <dir> --baseline <dir>]

# 统计摘要
npm run tuning:stats -- <sensitivity_dir>

# 候选点评估：按向量批量评估联合参数组合，输出目标值与排序（不发布数据包）
npm run tuning:candidate -- --model <dir> --raw <dir> --candidates <candidates.json>
    [--split TRAIN|VALIDATION] [--gt <dir>] [--report-dir <dir>]
```

通用选项：`--output <root>`（默认 `dataset/tuning`）、`--quiet`；`validate` / `stats` / `candidate` 支持 `--report-dir`。

---

## 3. 三层完整性门禁

三门禁都在实验开始前执行，任一失败即拒绝运行：

1. **Engine Runtime**：`tools/replay/replay-runner.mjs` 的 `REPLAY_RUNTIME_FILES`（15 个文件）按文件名+内容计算 `engine_runtime_sha256`；同时断言 Runtime 清单覆盖评分路径真正到达的全部命名空间。取数路径上的少量引用（`js/data.js → citySearch`、`js/nowcast.js → cache / cacheKeys / corridor`）在 Policy 中显式声明，出现未声明的引用即 `RUNTIME_IMPORT_GRAPH_DRIFT`。
2. **Parameter Registry 审计**：每个参数的 `canonical_path` 必须能在冻结基准中解析；每个接线锚点（文件+行号+token）必须命中；命名空间必须与该行实际读取的 `cfg` 绑定一致；`PARTIALLY_WIRED` 必须给出截断位置；声明了 `scan_token` 的参数，其全部引用点都必须在声明范围内。
3. **Composition Parity**：Replay runner 复制了生产 `applySunsetEvolution` 的组合步骤，因此逐项断言两侧一致（天空演化因子限幅、gwFactor 限幅与 floor 来源、乘法顺序与四舍五入、黄金窗口未激活分支、`base_score` 取值时点、config 恢复）。Reference Parity 只覆盖历史配置点，不能替代本项。

---

## 4. 基准配置语义

| 模式 | 基准 | 用途 |
| --- | --- | --- |
| `PARITY` | `replay.effective_config` | Replay Reference Parity，行为与 `replay:verify` 一致 |
| `TUNING_BASE` | `tuning_base_config.json` | 全部 Sensitivity 与 Ablation |

`TUNING_BASE` 通过给 runner 传入预构建的 `modelConfig` 实现，并保持生产别名不变：`modelConfig.scoring === <config root>`，且 `goldenWindow` / `evolution` / `nowcast` / `skyState` / `cloudField` / `wind` / `network` / `sampling` / `api` / `cache` 等顶层命名空间与其 `scoring.<name>` 孪生指向同一对象。别名如果断裂即以 `ALIAS_IDENTITY_BROKEN` 失败。

Replay 自带的 `effective_config` 是裁剪后的子集（实测当前只有 9 个顶层命名空间，`api` / `cache` / `network` 不在其中），所以冻结基准必须是显式完整导出，不能沿用"历史 + 当前"的隐式混合。

---

## 5. 参数接线状态

`wired_status` 取值与含义：

| 取值 | 含义 | 是否进入正式结论 |
| --- | --- | --- |
| `WIRED` | 被评分路径读取且效果未被硬编码截断 | 是 |
| `PARTIALLY_WIRED` | 被读取但效果被硬编码截断 | 否，仅诊断 |
| `NOT_WIRED` | 未被评分路径读取 | 否，仅诊断 |
| `OPERATIONAL_ONLY` | 与评分链路无关 | 否，仅诊断 |

当前已登记的诊断项：

```text
skyState.factorRange          PARTIALLY_WIRED
  读取：js/sky_state.js:149    截断：js/prediction_service.js:278 与 tools/replay/replay-runner.mjs 的硬编码 [0.65, 1.15]
  结论：收窄区间有效，放宽无效

viewingWindow.peakOffsetMin   OPERATIONAL_ONLY
  仅被 SS.engine.bestViewing 用于展示，评分路径不读取
```

---

## 6. 约束

支持 `RANGE` / `INTEGER` / `ENUM` / `SIMPLEX` / `MONOTONIC` / `MIN_MAX` / `DEPENDENT`，在执行前校验，非法实验整批拒绝。

- SIMPLEX：4 组权重满足 Σ=1；改变一个成员时其余成员按原比例重新归一；`weatherRegime.weights` 是按 Regime 索引的乘数表，不适用归一化。
- ENUM：单元用 `enum_values` 声明取值域，越界取值以 `ENUM_CONSTRAINT_VIOLATION` 拒绝。当前登记的 35 个单元都不含离散取值域，因此该类型只被测试覆盖，暂不影响任何结论。
- MONOTONIC：`horizonGate` 的 `min` 与 `gate` 必须严格递减（engine 按数组顺序取第一条 `horizon >= min`）。
- MIN_MAX：`rainToClearGoldenWindow.min <= max`。
- DEPENDENT：`nowcast.*` 与 `nowcast.satellite.*` 依赖对应开关为 true。

组合语义提醒：`js/engine.js` 会用 Regime 乘数与 `minimumWeatherWeight` 二次处理配置权重，因此配置权重满足 Σ=1 不等于最终有效构成满足 Σ=1。包内 `experiment_metrics.effective_composition_json` 记录的是**安装后的配置构成**，最终影响力仍需结合引擎合成理解。

---

## 7. 实验与指标

- 计划固定顺序：OAT → SIMPLEX → Ablation。OAT 用相对基线 ±15%/±30% 的 5 个探针（含基线值），整数参数四舍五入；基线值探针是**一致性自检**，必须零变化。
- SIMPLEX 对每个成员取 ×0.8 / ×1.2 两个探针并重新归一化。
- 单一变更强制校验：OAT 必须只改 `canonical_path` 一条路径；SIMPLEX 只能改本组成员。
- Tuning Control 每条 Snapshot 重算一次，所有实验与之按 `snapshot_id` 严格成对；对照组与实验组使用完全相同权重。
- 失败隔离：某条 Replay 在某个实验里失败时，只把该 Snapshot 从**这个实验**的配对集合中剔除，其余实验照常使用它；控制阶段失败的 Snapshot 则从所有实验中剔除。剔除明细写入 `experiment_failures.csv`，不静默丢失。
- 覆盖率门禁：每个实验输出 `cohort_sample_count` / `paired_sample_count` / `paired_event_count` / `coverage_rate` / `failure_count` / `control_failure_count` / `experiment_failure_count`，其中 `coverage_rate = paired_sample_count / cohort_sample_count`。任一实验覆盖率低于 Policy 的 `min_coverage_rate`（当前 0.95）即整轮失败（`TUNING_COVERAGE_BELOW_MINIMUM`），不发布低覆盖率的包。
- Model Response：`changed_score_rate`、`changed_ordinal_rate`、`mean/median score_delta`、`mean_abs_score_delta`、`p95_abs_score_delta`。
- GT 指标沿用 V2.5.1 定义（weighted MAE / Bias / Exact / Within-1 / Severe / Over / Under / QWK）并输出相对 Control 的 delta。
- Slice 沿用 V2.5.1 单维维度（11 个），并在 Slice 内按 Event 重新归一化权重。
- Date Stability 使用 Leave-One-Date-Out：逐个剔除一个当地日期，检查实验是否仍改善。每个实验在 `experiment_metrics.csv` 输出自己的折数：`lodo_fold_count`（实际评估的折数）、`lodo_improved_count`、`lodo_degraded_count`、`lodo_stability_ratio`、`lodo_reason_code`、`limited_date_coverage`。
- 参数级稳定性取自**最有影响力的那个探针**（`|delta_mae|` 最大，同值取 `experiment_id` 升序），该探针写入 `parameter_summary.stability_representative_experiment_id`。这样 `improved_date_count` / `degraded_date_count` / `direction_stability_ratio` 永远描述同一组折数。
- `direction_stability_ratio = max(improved, degraded) / (improved + degraded)`；中性折（该折 MAE 无变化）计入 `lodo_fold_count` 但不进入方向比率，因此 `improved + degraded` 可能小于 `lodo_fold_count`。无法评估时比率为 `null` 并给出 `lodo_reason_code`（`INSUFFICIENT_DATES_FOR_LODO` 或 `NO_DIRECTIONAL_FOLDS`）。日期数 < 5 标记 `LIMITED_DATE_COVERAGE`。

不要把不同探针的 `improved` / `degraded` 折数合并后再相比：那会把从未同时出现的折数混在一起，让方向完全稳定的参数看起来不稳定。需要跨探针比较时，直接读 `experiment_metrics.csv` 的逐实验折数。

---

## 8. 就绪度

全局（TRAIN cohort）：

| 门槛 | 要求 | 说明 |
| --- | --- | --- |
| PRIMARY Event | ≥ 100 | |
| unique dates | ≥ 14 | |
| Replay 可用率 | = 100% | 以 Reference Parity 为准 |
| GT 等级 | ≥ 3 且每级 ≥ 5 Event | 单纯"覆盖 3 级"不足以支撑优化 |
| 单日期集中度 | ≤ 50% Event | |
| 单城市集中度 | ≤ 50% Event | |

`NOT_READY`（任一完整性门禁失败）禁止运行；`EXPLORATORY` 允许运行但结果只能作探索；`TUNING_READY` 才可进入正式优化。

参数级：`READY` / `EXPLORATORY` / `INSUFFICIENT_SUPPORT` / `NOT_OBSERVABLE` / `EXCLUDED`。`INSUFFICIENT_SUPPORT` 由激活条件对应的支持 Event / 日期数决定；`NOT_OBSERVABLE` 由实测 `changed_score_rate == 0` 决定，不能由配置是否存在推断。

---

## 9. 输出包

```text
dataset/tuning/
├─ staging/<run_id>/
└─ exports/<sensitivity_id>/
   ├─ manifest.json  schema.json  policy.json
   ├─ engine_runtime.json  tuning_base_config.json  parameter_registry.json  readiness.json
   ├─ replay_parity.csv  experiment_plan.csv  experiment_metrics.csv
   ├─ sample_deltas.csv  slice_deltas.csv  ablation_metrics.csv  parameter_summary.csv
   └─ reports/summary.json  reports/warnings.csv
```

发布沿用既有治理：staging → 包内校验 → 排他锁 → 来源复查 → 原子 rename。相同输入与实验定义产生逐字节一致的文件与相同 `sensitivity_id`；重复构建返回 `DEDUPLICATED`，同 ID 不同内容返回 `SENSITIVITY_ID_CONFLICT`。

`ablation_metrics.affected_sample_count` 表示该消融实际改变了分数的样本数。

`experiment_failures.csv` 逐条记录被剔除的样本与阶段：`stage=CONTROL` 的行使 `experiment_id` / `parameter_id` / `probe_value` 为空（它影响所有实验），`stage=EXPERIMENT` 的行标明所属实验与探针，并只记 `error_code`，不写原始异常文本。校验器会核对每行、每个实验的 `failure_count` 与该表的行数完全一致。

`sample_count` / `event_count` / `date_count` 就是配对后的口径，因此分别等于 `paired_sample_count` / `paired_event_count` 与配对子集的日期数；保留两套写法是为了兼容既有读取方式，校验器会强制两者一致。

`slice_deltas.csv` 每行都带 `experiment_id`、`parameter_id`、`parameter_value`，因此切片结果可以直接归因到具体参数与探针，不需要再回表关联；消融行没有参数与探针值，这两列为空。包内校验会逐行核对这三列与 `experiment_metrics.csv` 是否一致。

常用读取方式：

```powershell
Import-Csv -LiteralPath (Join-Path $sensitivityPath 'parameter_summary.csv') |
    Sort-Object max_mean_abs_score_delta -Descending |
    Select-Object parameter_id, wired_status, observability_status, max_changed_score_rate, best_delta_mae
```

---

## 10. 当前真实结果（2026-09-17）

```text
dataset/tuning/exports/sensitivity_v1_7e48bb52a4b9_7d95554c8588
cohort: TRAIN 31 Snapshot / 17 Event / 3 日期
Global Readiness: EXPLORATORY   result_usage: EXPLORATORY_ONLY
Replay Reference Parity: 31 / 31
experiments: 192（OAT 135 / SIMPLEX 52 / ABLATION 5）
```

就绪度缺口：`TRAIN_PRIMARY_EVENTS_BELOW_MINIMUM`、`TRAIN_UNIQUE_DATES_BELOW_MINIMUM`、`GT_LEVEL_EVENT_COUNT_BELOW_MINIMUM`、`SINGLE_DATE_EVENT_SHARE_ABOVE_MAXIMUM`。

方向稳定性：192 个实验中 46 个至少评估出一折有效方向；14 个参数有可定义的比率，全部为 `1`（每个探针的每一折方向一致）。此前的包因跨探针混折把这 14 个中的 10 个报成 `0.5` / `0.6`。

配对覆盖：192 个实验的 `coverage_rate` 全为 `1`，`failure_count` 全为 `0`，`experiment_failures.csv` 为空表（仅表头）。失败降级与门禁路径无法由现有数据触发，只由注入失败的离线 fixture 覆盖。

参数分布：24 EXPLORATORY、5 NOT_OBSERVABLE、4 INSUFFICIENT_SUPPORT、2 EXCLUDED；可观测性为 14 OBSERVABLE、10 PARTIALLY_OBSERVABLE、5 NOT_OBSERVABLE、6 NOT_EVALUATED。

模块消融（weighted，对照 MAE 0.879674）：

| 消融 | 层 | 影响样本 | changed_score_rate | mean_score_delta | delta_mae |
| --- | --- | ---: | ---: | ---: | ---: |
| NO_GOLDEN_WINDOW | RUNNER | 17 | 0.548387 | +6.483871 | +0.178737 |
| NO_SKY_EVOLUTION | RUNNER | 30 | 0.967742 | −0.064516 | −0.058411 |
| NO_STRUCTURE_BONUS | ENGINE | 2 | 0.064516 | −0.290323 | 0 |
| NO_TRANSITION_BONUS | ENGINE | 16 | 0.516129 | −0.354839 | 0 |
| NO_DYNAMIC_REGIME_WEIGHT | ENGINE | 14 | 0.451613 | +0.419355 | 0 |

读法：`delta_mae` 为正表示移除该模块后误差变大（模块有帮助），为负表示移除后误差变小。三个 ENGINE 消融改变了分数但没有改变 ordinal 级误差，因此 `delta_mae = 0`，这本身就是结论：在当前 31 条 TRAIN 样本上，这些模块的效果落在等级边界之内。

---

## 11. 局限

- 结论只覆盖当前 TRAIN cohort（17 Event / 3 日期 / 单一 GT 等级分布），属于探索性结论，不能作为参数定稿依据，也不能外推到 VALIDATION / TEST。
- 无降雨 Regime、无 STRONG GT、近临样本仅 1 条，`RAIN_TO_CLEAR` 系列与部分近日落参数为 `INSUFFICIENT_SUPPORT`。
- `PARTIALLY_WIRED` 参数（如 `skyState.factorRange`）被排除在正式结论之外，直到硬编码截断被清理。
- 组合逻辑由 runner 复刻生产语义，靠 Composition Parity 断言维持一致；对齐方式属前置决策项，见方案 §22。
- 本工具不产生推荐值，不修改 `js/config.js`、`model_version` 或任何线上模型。

---

## 12. 候选点评估（V2.5.3 就绪接口）

敏感度路径强制"一个实验只改一个注册单元"，这样探针的效果才能归因到具体参数。联合搜索需要的是相反的能力：一次改多个参数，并返回一个可以排序的目标值。两者并存，互不干扰——候选点评估走独立模块与独立策略，因此已发布的 `sensitivity_v1_*` 数据包逐字节不变。

| 关注点 | 敏感度（V2.5.2） | 候选点评估（V2.5.3 就绪） |
| --- | --- | --- |
| 变更约束 | `assertExperimentDiff`：OAT 只允许 1 条路径变化，SIMPLEX 只允许组内成员 | 向量可同时改多个单元，唯一约束是注册表与声明约束 |
| 策略来源 | `tuning-policy.mjs` `POLICY_V1` | `candidate-policy.mjs` `CANDIDATE_POLICY_V1`（独立版本号，不改动 POL2 字节） |
| 读取范围 | TRAIN | TRAIN 或 VALIDATION（TEST 硬拦） |
| 输出 | 不可变数据包 | 一条 JSON 报告，不发布、不落任何包目录 |

候选文件接受三种形状：向量数组、`{ label, vector }` 数组，或 `{ "candidates": [...] }` 包裹任一种。向量键是 `parameter_id`；SIMPLEX 单元取 `{ 成员: 值 }` 对象，其余单元取标量。

```json
{
  "candidates": [
    { "label": "cloud-move", "vector": { "high_cloud_center": 55, "high_cloud_width": 20 } },
    { "label": "canvas-shift", "vector": { "canvas_weights": { "high": 0.34 } } }
  ]
}
```

目标函数与门禁（`CANDIDATE_POLICY_V1`）：

| 项 | 定义 |
| --- | --- |
| 主目标 | weighted `mae`，`MINIMIZE` |
| 平局项 1 | weighted `severe_error_rate`，`MINIMIZE` |
| 平局项 2 | weighted `qwk`，`MAXIMIZE` |
| 约束违反 | `status = INFEASIBLE`，带 `reason_code`，**不执行任何 Replay** |
| 覆盖率低于 0.95 | `status = UNEVALUABLE`（沿用 `coverage_policy.min_coverage_rate`） |
| 其余 | `status = FEASIBLE`，`objective_value` = 主目标加权 MAE |

排序先看状态（FEASIBLE → INFEASIBLE → UNEVALUABLE），再看主目标与平局项；`null` / 非有限值排在最后，完全并列时按 `candidate_id` 决定，因此同一批候选以任何顺序提交都得到同一排名。空向量是合法输入，其目标值等于 Tuning Control 的目标值，可用作控制自检。

SIMPLEX 只给部分成员时，未给出的成员按基准比例缩放并保持组内和为 1；装配完成后统一跑一遍 `validateBaseConfig`，所以 RANGE / INTEGER / ENUM / SIMPLEX / MONOTONIC / MIN_MAX / DEPENDENT 全部生效。

报告字段：

```text
status · candidate_policy_version · split · model_dataset_id
cohort_sample_count · control_failure_count · control_metrics
evaluated_count · status_counts · best_candidate_id · best_objective_value · upstream
results[]: rank · candidate_id · candidate_label · status · reason_code · vector · changes ·
           composition · control_metrics · coverage · metrics{weighted,unweighted} · deltas · objective · objective_value
```

`--gt` 是可选参数：给了就额外跑一次阶段 A 的 `SOURCE_LINKED` 上游验收（结果写入 `upstream`），不给则只做候选 cohort 的 Header + 行契约 + Hash 校验。

常用读取方式：

```powershell
node tools/tuning/evaluate-candidate.mjs --model <dir> --raw <dir> --candidates <json> --quiet |
    ConvertFrom-Json |
    Select-Object -ExpandProperty results |
    Select-Object rank, candidate_label, status, objective_value, @{n='coverage';e={$_.coverage.coverage_rate}}
```

边界：候选点评估只回答"这个向量在当前 cohort 上得分如何"。它不是优化器，不做搜索、不收敛、不生成推荐值，也不把结果写进任何数据包；搜索循环与候选生成属于 V2.5.3。
