# Offline Dataset V1 (V2.4.8)

These Node.js tools read authorized D1/R2 data through your existing Wrangler login.
They do not modify production, change scoring, or generate ground truth.
Run commands from the repository root using Node.js 22+ and Wrangler 4.

```text
npm run dataset:export -- --from 2026-09-09 --to 2026-09-09 --city 深圳
npm run dataset:validate -- dataset/exports/<dataset_id>
npm run dataset:stats -- dataset/exports/<dataset_id>
```

Export defaults: `--database sunset-db`, `--bucket sunsetscore-replay`,
`--output dataset`. `--config` selects an existing Wrangler configuration file.
Date bounds refer to the event's local date, including both endpoints.

Optional comma-separated filters: `--city`, `--model-version`,
`--snapshot-source`, `--scheduled-slot`, `--observation-source`.
Cities match stored names exactly. SLOT remains four-character text.
`--include-comments` explicitly includes original observation comments.
IP hashes, user agents and administrative identities are never queried.

## Cutoff and reproducibility

Use `--cutoff 2026-09-10T00:00:00.000Z` to reuse a known boundary. Without it,
the exporter reads D1 time at whole-second precision. Future cutoffs are rejected.
Snapshots must be READY with both submission and readiness times at or before
the cutoff. Observations are selected by the resulting event scope.

Before publishing, the tool re-queries the selected records and replay metadata.
Changes fail with `SOURCE_CHANGED_DURING_EXPORT`. This detects changes but does
not create a historical database transaction snapshot. To reuse exactly the same
data, retain the published package instead of re-querying production later.

## Immutable packages

Success prints `EXPORTED` or `DEDUPLICATED`, a dataset ID and local directory.
Errors return a nonzero exit code and retain sanitized reports in staging.
Existing exports and cache objects are never overwritten to repair corruption.
Cache entries are verified on every use; packages contain independent copies.
Copy the entire `<dataset_id>` directory to another location to validate offline.

`dataset:validate` and `dataset:stats` are read-only and report to stdout.
For a separate report use, for example:

```text
npm run dataset:validate -- dataset/exports/<dataset_id> --report-dir dataset/rechecks/run-001
```

The report directory must be outside the package. Existing report files are not
overwritten. Do not resave the raw CSV in Excel: use text import for identifiers
and SLOT to preserve leading zeros. Machine consumers use `lib/csv.mjs` with
`schema.json`, which distinguishes null from quoted empty strings.

## Operational limits

- D1 pages: 1,000 rows, with 100 event IDs per observation query batch.
- Each multi-value filter: at most 100 entries. SQL: at most 80 KB; commands
  longer than 5,000 characters use a temporary SQL file.
- Wrangler subprocess: 120 seconds and 10 MiB stdout/stderr buffer. Remote
  source operations stop starting after a one-hour run deadline.
- Replay downloads are serial. Only classified transient network errors retry,
  at most three attempts with 1s/2s delays. Integrity errors never retry.
- A lock wait lasts at most 10 seconds. `DATASET_LOCK_BUSY` requires checking
  whether another exporter is active. After a killed process, remove only the
  confirmed abandoned `.lock` directory; the tool never guesses that it is stale.
- Replay payloads are processed one at a time. Flat metadata rows and CSV files
  are still held in memory; split very large date ranges. Existing indexes can
  require temporary sorting. No index migration is included.

Wrangler must already be authenticated. If your host restricts default npm or
Wrangler log directories, set `npm_config_cache` and `WRANGLER_LOG_PATH` to
appropriate private, writable directories before running the commands. Do not
place credentials in command arguments, source files or dataset manifests.

## Phase 0 compatibility

The original `replay:download`, `replay:verify` and `replay:phase0` commands retain
their existing layouts. The old verifier expects root-level `snapshots.json`;
it does not consume this package directly. This version provides the typed CSV
reader for a future adapter. Mixed engine builds are allowed in raw datasets;
actual reference replay still needs matching historical engine code.

## 终端进度反馈（2026-09-15）

原命令无需调整，默认向 stderr 显示中文阶段、累计耗时；交互终端还显示分页累计行数、Replay 完成数/总数及缓存命中/下载数，GT 显示 Event 聚合计数。非交互或重定向环境使用阶段日志，异步等待期间约每 10 秒显示当前阶段与累计耗时。不估算未知总量的全局百分比，不增加 COUNT 查询。

追加 --quiet 可关闭进度提示；失败的最终结果仍保留。最终 JSON 继续写 stdout，数据包内容、Schema/Policy、ID 和重复构建规则不变。要只保存工具的 JSON，可直接调用 Node 并将 stdout 重定向到包外文件（npm 自身仍可能输出命令横幅）。

Wrangler 查询/下载采用异步子进程，保持原有 120 秒单次超时、输出大小限制和脱敏错误码。同步计算期间按 Event 计数更新，定时提示不代表额外数据库访问。无需网站部署或数据库迁移，使用更新后的本地代码即可生效。
