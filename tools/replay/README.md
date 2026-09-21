# Replay 离线工具

`tools/replay/` 提供单条 Replay 重算、旧 Phase 0 布局的生产 Replay 下载与批量验证，以及处理性能基准。请在 `SunsetScore-main/` 目录执行。除 `replay:download` 会通过已认证的 Wrangler 会话读取生产 D1 / 私有 R2 外，其余命令均使用本地文件；所有命令都不写生产 D1 / R2，也不部署应用。

本模块的 Phase 0 下载目录与 [Raw Dataset 正式包](../dataset/README.md) 是**两套文件布局**：`replay:verify` / `replay:phase0` 要求下载目录根部有 `snapshots.json`，不能直接把 `dataset/exports/<dataset_id>` 作为输入。

## 命令总览

| 命令 | 用途 | 输入 |
| --- | --- | --- |
| `npm run replay` | 单条 Replay 重算；可选与一条 Snapshot reference 比对 | `replay.json` 或 `replay.json.gz` |
| `npm run replay:download` | 从生产 D1/R2 下载全部 READY Replay 到独立本地目录 | 已认证 Wrangler 会话 |
| `npm run replay:verify` | 批量检查下载完整性、Engine Build 与 Reference Replay | Phase 0 下载目录 |
| `npm run replay:phase0` | 运行 `npm run check`、批量验证、场景门禁与处理基准，给出 GO / NO-GO | Phase 0 下载目录 |
| `npm run replay:benchmark` | 用本地生成的不同大小 fixture 测量处理耗时 | 无需生产数据 |

`replay-fixture.mjs` 是测试与基准共用的 fixture 代码，不是单独的 npm 命令。

## 1. 下载生产 Replay

```powershell
npm run replay:download -- --output dataset/phase0-production
```

默认参数为 `--database sunset-db`、`--bucket sunsetscore-replay`、`--output dataset`；可用 `--config <wrangler配置路径>` 指向已有配置。下载器读取 D1 中全部 `replay_status=READY` 的 Snapshot 元数据，再按其 R2 对象键逐条串行下载并校验 Replay 的压缩内容、身份、Hash、大小及 Schema。它不提供日期或城市过滤器。

输出目录包含 `snapshots.csv`、`snapshots.json`、`errors.json` 和 `replay/<snapshot_id>.json`。终端汇总 Snapshot 数、成功保存数与错误数；任一下载失败时退出码非零，逐条错误码写入 `errors.json`。此命令会写入所选输出目录，重复使用同一目录可能替换既有清单或同名 Replay 文件；为新一轮取证使用独立目录，并私下保存下载结果。Replay 输入和 Snapshot 可能包含敏感信息，不要放进公开站点、提交或日志。

下载需要事先完成 Wrangler 登录；密钥不作为命令参数传入。本命令不导出 GT，也不构建 Phase 1 Raw 正式包。需要确定性数据包与来源关联校验时使用 `dataset:export`。

## 2. 单条重算

```powershell
npm run replay -- dataset/phase0-production/replay/<snapshot_id>.json
npm run replay -- dataset/phase0-production/replay/<snapshot_id>.json --reference <单条snapshot.json>
```

输入可为 `.json` 或 gzip 压缩的 `.json.gz`。不传 `--reference` 时输出 `actual`，`pass=null`；传入一条对应的 Snapshot JSON 时，报告 `actual`、`reference`、数值差值和 `pass`，比对失败以非零退出。可选 `--config <candidate.json>` 覆盖部分配置以观察反事实结果，或 `--engine-root <目录>` 从显式的 Engine 代码根运行。单条 CLI 不从 `snapshots.json` 自动挑选 reference，需要提供单独的 JSON 文件。

`runReplay()` 也供 Tuning 等模块调用。Runner 在一次运行中临时设置全局 `SunsetScore.modelConfig`；批量验证按 Snapshot 串行执行，不应在同一进程里并行调用不同配置的 Replay。

## 3. 批量 Reference Replay 与 Phase 0

```powershell
npm run replay:verify -- dataset/phase0-production --engine-root <目标提交的工作树>
npm run replay:phase0 -- dataset/phase0-production --engine-root <目标提交的工作树>
```

`--engine-root` 可省略，默认使用当前应用仓库。验证器读取该目录的完整 Git HEAD，并要求 Replay 记录的 `engine_build_sha` 与之相同、运行时 JS 文件没有未提交改动；不自动 checkout、reset 或选择历史工作树。不同 Engine Build 的数据需使用相应代码根分别核对，不能把不匹配样本静默剔除。

`replay:verify` 对每条 Snapshot 校验对应 Replay，串行调用 Runner 做 Reference 比对，并在输入目录的 `verification/` 写出 `replay-report.json`、`scenario-coverage.json`、`failures.json`。覆盖场景包括普通天气、雨转晴、黄金窗口、雷达降级、卫星降级和双视觉源正常。真实样本若存在，其 Reference 必须通过；尚无真实样本的场景在 Phase 0 检查中可由通过的 fixture 标记为 `PASS_FIXTURE_PENDING_REAL`。下载不完整、Build 不符、重算失败或必需场景失败都会使 CLI 非零退出。

`replay:phase0` 不自动下载生产数据，不调用 Wrangler；它先运行本地 `npm run check`，再执行批量验证和处理基准，在 `verification/` 另写 `processing-benchmark.json`、`phase0-report.json`。终端打印 `GO` 或 `NO-GO`；仅满足测试、下载、Reference、场景和基准门禁才返回 `GO`。它会写本地报告，但不改变生产配置或定时采集开关。

## 4. 处理性能基准

```powershell
npm run replay:benchmark -- --output dataset/replay-benchmark.json
npm run replay:benchmark -- --baseline dataset/replay-benchmark.json --output dataset/replay-benchmark-next.json
```

基准使用本地生成的约 100、400、1536 KiB Replay fixture，不读取生产包。每个规模预热一次、正式运行至少五次，报告校验、规范化编码、SHA-256 和 gzip 的耗时、体积与压缩比。没有 `--baseline` 时状态为 `MEASURED`；提供先前报告后，当前总耗时中位数超过相应规模的两倍则为 `FAIL` 且退出码非零。`--output` 可选；不提供时仅把报告打印到 stdout。

## 边界与后续数据包

Replay Schema V1 保留捕获本次评分实际消费的输入，可重建离线评分，但不代表雷达或卫星原始像素级 L3 回放。Phase 0 目录是历史下载/验证布局；正式 Raw 包自带 `replay/`、manifest 和独立校验契约，其下游 GT / Model 处理见各模块 README。正式包依赖检测与级联清理使用 [数据维护工具](../maintenance/README.md)，不会把 `phase0-production/` 当作正式包。

设计与门禁背景见 [V2.4.7 Phase 0 技术方案](../../../ref_docs/PRD/V2.4.7迭代--Phase0--Replay%20链路收口技术方案.md)。
