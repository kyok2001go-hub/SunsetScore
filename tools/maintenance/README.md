# 数据检测与清理自动化（V2.5.2.2）

本工具只处理 Phase 1–5 的正式离线发布包，提供两项能力：

1. `dataset:lineage`：只读枚举五阶段发布包，按每个包的完整主 ID 生成依赖图。
2. `dataset:prune`：按阶段与完整主 ID 计算下游闭包，先生成冻结计划，再整包级联清理。

纯本地运行：不联网、不写 D1 / R2、不修改包内字节、不修改评分代码或模型配置。

在 `SunsetScore-main/` 执行。

## 1. 扫描范围

| 阶段 | 发布根目录 | manifest 主 ID | 支持的 Schema / Policy |
| --- | --- | --- | --- |
| Phase 1 Raw Dataset | `dataset/exports/` | `dataset_id` | schema 1 |
| Phase 2 Ground Truth | `dataset/ground_truth/exports/` | `ground_truth_id` | schema 1/2 + policy 1，schema 3 + policy 2 |
| Phase 3 Model Dataset | `dataset/model/exports/` | `model_dataset_id` | schema 1 + policy 1，schema 2 + policy 2/3 |
| Phase 4 Baseline Evaluation | `dataset/evaluation/exports/` | `evaluation_id` | schema 1 + policy 1，schema 2 + policy 2 |
| Phase 5 Parameter Sensitivity | `dataset/tuning/exports/` | `sensitivity_id` | schema 1 + policy 1，schema 2 + policy 2 |

`dataset/staging/`、各阶段 `staging/`、`ground_truth/rechecks/`、`cache/`、`phase0-production/` 不是正式发布包，永远不会进入检测节点或清理列表；它们只能通过诊断码出现。Raw 包自身的 `replay/` 目录属于该 Raw 包。

自定义 `--output` 构建的包只有在该根目录被显式登记后才会被扫描；默认契约只覆盖上表五个根目录。

## 2. 检测

```powershell
# 默认：五阶段包数、每个包的完整主 ID、诊断与 Mermaid 图
npm run dataset:lineage

# 聚焦某个包的上游与下游
npm run dataset:lineage -- --focus baseline_v1_7e48bb52a4b9_626d7073a563

# 只要图 / 机器可读清单
npm run dataset:lineage -- --format mermaid
# 需要 Phase 分栏方框（部分内嵌渲染器会丢掉跨 subgraph 的连线）
npm run dataset:lineage -- --format mermaid --group
npm run dataset:lineage -- --format json --out dataset/maintenance/plans/lineage.json

# 额外做一次各阶段 PACKAGE_INTERNAL 重算（较慢，不读 Replay 输入包）
npm run dataset:lineage -- --verify --format json
```

选项：`--dataset <目录>`（默认 `<cwd>/dataset`）、`--focus <完整主 ID>`、`--format text|mermaid|json`、`--group`、`--out <文件>`、`--verify`、`--quiet`。报告文件禁止写入任何发布根目录，已存在的报告不会被覆盖。

Mermaid 默认输出**扁平图**：只有节点声明与连线，不使用 `subgraph`。分栏方框更好看，但跨 subgraph 的连线是部分内嵌渲染器会静默丢弃的写法，因此需要时再传 `--group`。两种写法都已用真实 Mermaid 11 渲染验证，均输出 7 条连线；节点的 Phase 前缀（`raw_` / `gt_` / `model_` / `baseline_` / `sensitivity_`）本身就能区分阶段。

图节点只写完整主 ID；路径、Hash、文件数与字节数放在清单与 JSON 里。边分三类，全部参与级联闭包：

```text
SOURCE     上游是计算结果输入（Raw→GT、Raw/GT→Model、Model→Evaluation、Model/Evaluation→Sensitivity）
REFERENCE  Tuning 重复声明但没有直接 Hash 的 Raw / GT 引用，会与 Model 声明交叉核对
EVIDENCE   Tuning V2 绑定的验证集披露证据（当前指向 Evaluation V1）
```

`EVIDENCE` 是当前最容易漏掉的边：删除 Evaluation V1 时，Sensitivity V2 也必须一起清理，而 Evaluation V2 不受影响。

绘图只保留包之间的**直接关系**。Phase 1–5 本身按顺序推进，因此凡是目标已经能通过其他包到达的边，都属于重复表述，不画在图上：Tuning 重复声明的 Raw / GT（`REFERENCE`）、以及已被 Model 边隐含的 `SOURCE` 边。规则是对当前边集做传递归约，逐个检查“删掉这条边后目标是否仍可达”，因此**可达性完全不变**，压缩后的图仍然能回答“删一个包会带走谁”。

当前真实数据由 14 条声明边压缩为 7 条绘制边，被省略的 7 条在文本输出的 `Transitive edges left out of the drawing` 下列出。JSON 的 `edges` 始终是完整集合，另附 `display_edges` 与 `drawing` 计数；清理计划同样使用完整集合，级联范围不受绘图影响。

## 3. 清理

日常只需要给出完整主 ID，阶段自动从 manifest 识别：

```powershell
# 预览：只列出会删除哪些包，不删任何东西
npm run dataset:prune -- baseline_v1_7e48bb52a4b9_626d7073a563 --dry-run

# 执行：解析闭包 → 写计划 → 按 Phase 5→1 删除
npm run dataset:prune -- baseline_v1_7e48bb52a4b9_626d7073a563
```

不接受前缀、通配符、日期区间或“整阶段删除”，也不接受一次多个 ID。计划文件自动写到 `dataset/maintenance/plans/<完整主ID>.json`，作为这次删除的持久记录；重复执行同一 ID 会覆盖这份记录。可选加 `--phase <1-5>` 作为断言，阶段不符时报 `PHASE_MISMATCH`。

从目标沿全部反向依赖求可达闭包，按 Phase 5→1、同阶段主 ID 字符码排序执行。输出包含每个目标的 manifest SHA-256、路径、文件数、字节数、入选原因与依赖边，并醒目列出证据边。

计划冻结扫描根目录、完整节点/边指纹 `graph_sha256`、目标集合与每个目标的 manifest Hash，以及 `plan_sha256`。计划文件禁止写入发布根目录。

## 4. 显式两步与恢复

需要人工复核计划、或中途要接着跑时：

```powershell
# 只写计划，不删除；文件路径由你指定
npm run dataset:prune -- --plan dataset/maintenance/plans/eval-v1.json baseline_v1_7e48bb52a4b9_626d7073a563

# 按已冻结的计划执行
npm run dataset:prune -- --apply dataset/maintenance/plans/eval-v1.json

# 中断后续跑
npm run dataset:prune -- --resume dataset/maintenance/plans/eval-v1.json
```

无论走哪条路径，执行前都会先取维护独占窗口，再重新扫描并与 `graph_sha256`、目标 manifest Hash 逐项比对；有任何新增、删除或改写即 `MAINTENANCE_PLAN_STALE` 并要求重新做计划。`--resume` 用于中断后的续跑，只复核每个目标自身状态，不要求整图指纹仍等于计划值。

逐包处理顺序为 Phase 5→1、同阶段按主 ID 字符码。每个包先原子重命名到 `dataset/maintenance/quarantine/<plan_sha256>/phase<N>/<主ID>`，写 `operations.log.jsonl` 的 `MOVED`，再删除隔离目录并写 `DELETED`。发布根目录只会看到包“完整存在”或“不存在”。中断恢复不承诺跨包整体原子性，但始终下游先行。

## 5. 维护门禁

五个构建器（Raw / GT / Model / Evaluation / Tuning）在整个构建期间持有共享租约 `dataset/maintenance/leases/<uuid>/`：

```text
构建：先建共享租约，再确认维护窗口未开启；否则 DATASET_MAINTENANCE_ACTIVE
清理：先取独占窗口，再确认没有活跃租约；否则 DATASET_BUILD_ACTIVE
```

两侧都用原子 `mkdir`，因此先建租约或先开窗口都能被对方观察到。租约位置由该次构建的输出根目录推导：Phase 1 用输出目录本身，其余阶段用输出目录的父目录，所以临时或自定义输出不会与默认 `dataset/` 门禁互相阻塞。

进程被强杀留下的租约或 `gate.lock` 不会被自动清理，必须确认进程已结束后人工处理。`dataset:lineage` 会列出活跃租约的 id、阶段、pid 与开始时间。

## 6. 拒绝条件

以下情况使计划为 `BLOCKED`，`--apply` 直接拒绝：

```text
父包缺失 / 父 manifest Hash 不符 / 阶段顺序反常
目录名与 manifest 主 ID 不一致
manifest 不可读、非规范 JSON 或依赖字段非法
Schema / Policy 版本未登记
descriptor_sha256 缺失或与 descriptor 不符
重复主 ID、发布根目录出现符号链接或非目录条目
目标包存在 <主ID>.lock（可能仍在发布）
目标不在闭包允许的阶段范围内，或清理闭包出现向前依赖
报告/计划写入发布根目录
```

没有 `--force`：来源歧义必须先修正或人工核对，不能跳过。

## 7. 当前数据

2026-09-20 本地五阶段共 7 个正式包（`1/1/1/2/2`）：Raw、GT、Model 各 1 个，Evaluation V1/V2 与 Sensitivity V1/V2 各 1 个，依赖图 14 条声明边、0 条诊断，绘图压缩为 7 条。对 `baseline_v1_7e48bb52a4b9_626d7073a563` 的 dry-run 得到 3 个目标：Evaluation V1、Sensitivity V1（`SOURCE`）与 Sensitivity V2（`EVIDENCE`）。

本工具不预授权清理任何现有数据；真实删除需要用户明确给出阶段、完整主 ID 并复核计划。
