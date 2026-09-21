# 离线 Raw Dataset 导出工具（Phase 1）

本模块从已授权的 Cloudflare D1 与私有 R2 读取 Snapshot、Event、Observation 及 Replay，生成本地不可变 Raw 数据包。导出只读取生产数据，不写 D1 / R2，不生成 Ground Truth，也不修改评分代码。请在 `SunsetScore-main/` 目录执行；导出需要 Node.js 22+、Wrangler 4 和已有的 Wrangler 登录。校验与统计只读本地包，无需登录或网络。

## 命令

```powershell
npm run dataset:export -- --from 2026-09-09 --to 2026-09-09 --city 深圳
npm run dataset:validate -- dataset/exports/<dataset_id>
npm run dataset:stats -- dataset/exports/<dataset_id>
```

`--from` / `--to` 是 Event 的当地日期，包含两端。导出成功后，以返回的 `directory` 替换后两条命令中的包目录。默认资源为 D1 `sunset-db`、R2 `sunsetscore-replay`、输出根目录 `dataset/`；可分别用 `--database`、`--bucket`、`--output` 覆盖，`--config` 指向已有的 Wrangler 配置文件。

可选的逗号分隔过滤器为 `--city`、`--model-version`、`--snapshot-source`、`--scheduled-slot`、`--observation-source`。城市按存储名称精确匹配；SLOT 保留四位文本及前导零。每个多值过滤器最多 100 项。默认不导出 Observation 原始留言，只有显式添加 `--include-comments` 才包含；IP 哈希、User-Agent 和管理员身份字段不会被查询。

## 截止时间与来源边界

可用 `--cutoff 2026-09-10T00:00:00.000Z` 固定截止时间。未提供时使用 D1 当前时间，精度为整秒；未来时间会被拒绝。导出先选取提交时间和 Replay READY 时间均不晚于截止时间的 READY Snapshot，再关联这些 Snapshot 所属 Event 与 Observation。Raw 包是这次选择范围的结果，并非 D1 全部历史的副本。

发布前会重新查询所选 Snapshot、Observation 和 Replay 元数据；若来源变化则以 `SOURCE_CHANGED_DURING_EXPORT` 失败。该复核不是数据库的历史事务快照。需要逐字节复用同一批数据时，应保留已发布的完整包，而不是日后重新查询生产环境。

## 输出、校验与查看

首次发布返回 `EXPORTED`，同内容已有正式包返回 `DEDUPLICATED`；响应包含 `dataset_id` 和 `directory`。默认结构为 `dataset/staging/`、`dataset/exports/<dataset_id>/`、`dataset/cache/replay/`。正式包内有 manifest、schema、`raw/*.csv`、`replay/*.json` 与 `reports/`。缓存每次使用前均复核，正式包持有独立文件；同 ID 冲突或已有损坏包不会被覆盖。失败会保留 staging 中的脱敏质量报告。

`dataset:validate` 和 `dataset:stats` 只读正式包，默认将结果输出到终端。可将独立报告写入包外新目录：

```powershell
npm run dataset:validate -- dataset/exports/<dataset_id> --report-dir dataset/rechecks/run-001
```

报告文件不会覆盖已有文件。复制或归档时保留完整 `<dataset_id>` 目录。CSV 用 Excel/WPS 查看时以文本导入，并把 ID、日期和 SLOT 当作文本；不要另存覆盖包内文件。程序读取应遵循 `schema.json` 和 `lib/csv.mjs` 的空值、空字符串编码契约。

## 运行限制与故障处理

- D1 分页每页最多 1,000 行；Observation 查询每批最多 100 个 Event ID。SQL 上限为 80 KB；超过 5,000 字符的 Wrangler 命令改用临时 SQL 文件。
- 单次 Wrangler 子进程超时为 120 秒，stdout/stderr 缓冲上限为 10 MiB；一次导出运行满一小时后不再发起新的远端来源操作。Replay 串行下载，仅已分类的暂时网络故障最多重试三次（延迟 1/2 秒），完整性错误不重试。
- 发布锁最多等待约 10 秒。遇到 `DATASET_LOCK_BUSY` 时先确认是否仍有导出进程；被强杀留下的锁不会自动判断为过期。大量数据仍可能占用较多内存，应缩小日期范围分批导出。
- `dataset:export` 默认向 stderr 输出中文阶段、累计耗时与交互式进度；追加 `--quiet` 可关闭。最终 JSON 在 stdout，npm 自身仍可能输出命令横幅。`dataset:validate` 与 `dataset:stats` 不接受 `--quiet`。
- Wrangler 应事先完成认证。受限环境可为 npm 缓存和 Wrangler 日志设置私有可写目录；不要把凭据放进命令参数、源码或 manifest。

## 与其他工具的关系

本模块产出 Phase 1 正式包。Phase 2 GT 只读取一个指定 Raw 包的 manifest、schema、Event 和 Observation CSV；Phase 3 Model 则会对完整 Raw 包做来源与 Replay 完整性校验。正式包依赖检测与授权清理使用 [数据维护工具](../maintenance/README.md) 的 `dataset:lineage` / `dataset:prune`；不要直接按目录名手工删除。

旧 `replay:download` / `replay:verify` / `replay:phase0` 仍使用根目录 `snapshots.json` 等独立布局，不能直接消费本模块生成的 Raw 包。详见 [Replay 工具](../replay/README.md) 与 [Raw 导出操作说明](../../../ref_docs/PRD/V2.4.8_数据离线导出操作说明.md)。
