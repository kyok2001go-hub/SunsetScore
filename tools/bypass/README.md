# 旁路对象导出与质量巡检（V2.5.5.9）

把 R2 中的旁路对象（`<Replay 键>.bypass.json.gz`，V2.5.5.7 旁路采集与 V2.5.5.8 卫星影子）按 Snapshot 导出到本地，生成不可变的旁路包和不读标签的质量周报。方案见 [V2.5.5.9 PRD](../../../ref_docs/PRD/V2.5.5.9--旁路对象导出与质量巡检方案.md)。

- 只读：D1 只查询 `prediction_snapshots`，**不查询 Observation**，因此 H1 核验之前也可以运行；R2 只读，不写 D1 / R2。
- 需要 Node.js 22+、Wrangler 4 和已有的 Wrangler 登录；凭据不经命令行传递。校验只读本地包，无需登录或网络。

## 命令

```powershell
npm run bypass:export
npm run bypass:export -- --from 2026-10-28 --to 2026-11-04 --city 深圳,广州
npm run bypass:validate -- dataset/bypass/exports/<bypass_dataset_id>
npm run bypass:validate -- dataset/bypass/exports/<bypass_dataset_id> --raw dataset/exports/<Raw 包>
```

- `--from` / `--to`：Event 当地日期，含两端；默认 2026-10-28（V2.5.5.7 上线日）至今天（北京时间）。
- 其他过滤：`--city`、`--snapshot-source`、`--scheduled-slot`（逗号分隔）；`--cutoff` 固定截止时间。
- `--refresh` 忽略缓存重新下载；`--max-minutes`（默认 50）为单次运行的下载时限，超时以 `BYPASS_EXPORT_TIMEOUT` 失败，已下载的对象留在缓存，下次续传。
- 资源默认 D1 `sunset-db`、R2 `sunsetscore-replay`、输出根目录 `dataset/`，可用 `--database`、`--bucket`、`--output`、`--config` 覆盖；`--quiet` 关闭进度输出。

## 判定

| 字段 | 含义 |
| --- | --- |
| `expected` | `EXPECTED`：`github_schedule` / `github_manual` 且应用版本 ≥ 2.5.5.7；其余为 `NOT_EXPECTED`，不下载 |
| `object_status` | `VALID`、`INVALID`（`error_code` 给出原因，如 `BYPASS_BINDING_MISMATCH`）、`MISSING`（键不存在）、`DOWNLOAD_FAILED`、`NOT_CHECKED`（`NOT_EXPECTED` 的行） |

校验内容：解压后不超过 512 KB、规范化 JSON、`snapshot_id` 等于 D1 的 Snapshot ID，并用服务端同一个校验器（`server/bypass-schema.js`）核对字段和绑定（预测时刻、日落时刻、经纬度）。

## 输出

```
dataset/bypass/cache/                       # 下载缓存，每次使用前重新校验
dataset/bypass/exports/<bypass_dataset_id>/
  manifest.json  index.csv  objects/<snapshot_id>.json.gz
  reports/quality.json  reports/quality.md  reports/errors.json
```

- `bypass_dataset_id` 由选择条件、截止时间与 `index.csv` 的 Hash 决定，同内容重复导出返回 `DEDUPLICATED`。
- `objects/` 保存 R2 原始压缩字节；端点不会覆盖已有对象（重复提交返回 `EXISTS` / `CONFLICT`），所以缓存视为不可变。
- `quality.md` 是给人看的周报：覆盖、请求 A / B、变量缺测率、卫星影子状态与帧龄、冷云个例、Worldview 目视对照候选。阈值（请求 OK ≥ 95%、卫星影子 OK ≥ 90%、帧龄 P90 ≤ 120 分钟、体积 P90 ≤ 150 KB、应有对象全部有效）未达标时标 `WARN`，工具不失败。
- 旁路包不登记进维护图；需要时可整体删除 `dataset/bypass/`。

## 程序读取

```js
import { openBypassPackage } from './tools/bypass/lib/read-bypass.mjs';
const pkg = await openBypassPackage('dataset/bypass/exports/<id>');
const payload = await pkg.read('<snapshot_id>');   // 校验后的旁路对象；无有效对象时为 null
```

与 Raw 包对齐时以 `snapshot_id` 匹配，并核对 `replay_sha256`；`bypass:validate --raw` 只读 Raw 包的 `raw/replay_index.csv`。
