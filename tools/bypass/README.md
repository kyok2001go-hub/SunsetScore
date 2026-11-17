# 旁路对象导出与质量巡检（V2.5.5.9，V2.5.5.15 修订）

把 R2 中的旁路对象（`<Replay 键>.bypass.json.gz`，V2.5.5.7 旁路采集与 V2.5.5.8 卫星影子）按 Snapshot 导出到本地，生成不可变的旁路包和不读标签的质量周报。方案见 [V2.5.5.9 PRD](../../../ref_docs/PRD/V2.5.5.9--旁路对象导出与质量巡检方案.md)；质量报告 v2、单层云量对照与导出修正见 [V2.5.5.15 PRD](../../../ref_docs/PRD/V2.5.5.15--旁路质量报告修正与气压层云量核查方案.md)。

- 只读：D1 只查询 `prediction_snapshots`，**不查询 Observation**，因此 H1 核验之前也可以运行；R2 只读，不写 D1 / R2。
- 需要 Node.js 22+、Wrangler 4 和已有的 Wrangler 登录；凭据不经命令行传递。校验只读本地包，无需登录或网络。

## 命令

```powershell
npm run bypass:export
npm run bypass:export -- --from 2026-10-28 --to 2026-11-04 --city 深圳,广州
npm run bypass:validate -- dataset/bypass/exports/<bypass_dataset_id>
npm run bypass:validate -- dataset/bypass/exports/<bypass_dataset_id> --raw dataset/exports/<Raw 包>
npm run bypass:validate -- dataset/bypass/exports/<bypass_dataset_id> --raw dataset/exports/<Raw 包> --report-dir ../.tmp/<任务名>
```

- `--from` / `--to`：Event 当地日期，含两端；默认 2026-10-28（V2.5.5.7 上线日）至今天（北京时间）。
- 其他过滤：`--city`、`--snapshot-source`、`--scheduled-slot`（逗号分隔）；`--cutoff` 固定截止时间。
- `--refresh` 忽略缓存重新下载；`--max-minutes`（默认 50）为单次运行的下载时限，超时以 `BYPASS_EXPORT_TIMEOUT` 失败，已下载的对象留在缓存，下次续传。
- 读 D1 遇到 `NETWORK_TRANSIENT` 会在 5 / 15 / 30 秒后重试，最多 3 次；其他错误不重试。失败时如果临时目录里没有文件就删除，有文件就保留并在输出的 `staging` 中给出路径。
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
- **报告版本：** `quality.json` 的 `quality_version`。V2.5.5.15 起导出 v2；没有这个字段的是 v1（V2.5.5.9 导出的包）。`bypass:validate` 按报告自身的版本重新计算并比较，旧包不受影响。v2 相对 v1：
  - 增加帧级统计（`satellite_shadow.frames`：各帧位置状态、三帧全部 OK 比例、按时段 / 城市、失败帧的瓦片数），三帧全部 OK < 80% 时警告 `SHADOW_ALL_FRAMES_OK_BELOW_80`；
  - 增加远点上气压层云量与单层中高云的一致性（`requests.pressure_level_cloud_consistency`），单层 ≥ 50% 而气压层 < 10% 的比例 > 30% 时警告 `PRESSURE_LEVEL_CLOUD_INCONSISTENT`。**气压层云量不能当作云量使用**（V2.5.5.13）；
  - 去掉 v1 的 `spearman_frac_cloud_vs_nwp_mid_high`（它用的是气压层云量），卫星与模型云量的对照改由 `bypass:validate --raw` 输出。
- 旁路包不登记进维护图；需要时可整体删除 `dataset/bypass/`。

## 程序读取

```js
import { openBypassPackage } from './tools/bypass/lib/read-bypass.mjs';
const pkg = await openBypassPackage('dataset/bypass/exports/<id>');
const payload = await pkg.read('<snapshot_id>');   // 校验后的旁路对象；无有效对象时为 null
```

与 Raw 包对齐时以 `snapshot_id` 匹配，并核对 `replay_sha256`。`bypass:validate --raw` 读 Raw 包的 `raw/replay_index.csv` 与对应的 Replay 文件（不读 Observation），输出：

- `raw_join`：按 `snapshot_id` 与 `replay_sha256` 的对齐结果；
- `nwp_single_level_contrast`：卫星判云（最新一个 OK 帧）与 Replay 单层 max(中云, 高云)（插值到帧时刻）的对照，近区 0–100 km、远区 100–250 km，口径同 V2.5.5.13 诊断第 2.3 节。Replay 缺失或 Hash 不符的行只计数（`replay_missing` / `replay_hash_mismatch`），不使校验失败。

`--report-dir` 把校验结果另存到包外的目录（包不可变，不能写在包里）。
