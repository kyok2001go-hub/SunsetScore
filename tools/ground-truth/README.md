# Ground Truth Builder (GT Schema 3 / Policy 2)

Local Node.js 22+ tools. No Wrangler, network access, production writes or model changes.
Run from the application root:

```text
npm run gt:build -- dataset/exports/<raw_id>
npm run gt:validate -- dataset/ground_truth/exports/<gt_id> --source dataset/exports/<raw_id>
npm run gt:stats -- dataset/ground_truth/exports/<gt_id>
```

Build reads only Raw manifest.json, schema.json, raw/events.csv and
raw/sunset_observations.csv. Invalid data fails; observations are never silently
excluded. New builds use Ground Truth Schema 3 and Policy 2, frozen separately from Raw;
Schema 1/2 Policy 1 packages remain supported for validation and statistics.

PACKAGE_INTERNAL validation proves package self-consistency. SOURCE_LINKED also
checks all source events and observation contributions against the exact Raw
manifest and CSV hashes. Build requires SOURCE_LINKED before atomic publication.

Output defaults to dataset/ground_truth; --output chooses another output root.
Identical exact source packages deduplicate. Existing corrupted packages are
never overwritten. A 10-second lock wait does not delete abandoned locks.
Interrupted/failed staging is retained; successful duplicate staging is removed.

Validate/stats are read-only. --report-dir must be outside the packages and
existing report files are never overwritten. Copy entire GT folders retaining
their ID names. Provide the moved Raw path via --source for linked validation.

Use text import for CSV in spreadsheets and do not resave into the package.
Confidence is a policy consistency score, not calibrated label correctness.
No prediction metrics, train/test split, model fitting or Replay adaptation is
included. See the Chinese operation guide under ref_docs/PRD in the workspace.

Contribution columns remain compatible with GT Schema V2: contributions begin with event_id, event_date_local,
city, observation_id. Display fields come from the Event and do not affect Policy V1.
V1 packages remain readable and verifiable. Rebuild from the same Raw package to
produce a new gt_v3 package; existing exports are never rewritten.

One build consumes one Raw package, never all exports. Raw V1 selects only
READY Replay Events and their observations, not a complete historical database.
Retain the Raw package referenced by source_dataset_id for SOURCE_LINKED checks.
Deleting Raw does not delete GT; no package directory is automatically merged.

Policy 2 treats one rednote_manual observation as an administrator adjudication.
Its rating is the final label; spread >= 3 or agreement < 0.5 still makes the
Event DISPUTED. Otherwise the existing STRONG thresholds apply, with a MEDIUM
minimum and a 0.6 MEDIUM confidence floor (cap 0.75). This is a policy weight,
not calibrated accuracy. Multiple manual observations for one Event fail.
evidence_count does not multiply votes. Other sources retain Policy 1 behavior.

event_ground_truth.csv adds gt_basis immediately after gt_status:
ADMIN_ADJUDICATED or OBSERVATION_AGGREGATED. Old packages are validated under
their original schema/policy; build a new GT from Raw to apply the new rule.

## 终端进度反馈（2026-09-15）

原命令无需调整，默认向 stderr 显示中文阶段、累计耗时；交互终端还显示分页累计行数、Replay 完成数/总数及缓存命中/下载数，GT 显示 Event 聚合计数。非交互或重定向环境使用阶段日志，异步等待期间约每 10 秒显示当前阶段与累计耗时。不估算未知总量的全局百分比，不增加 COUNT 查询。

追加 --quiet 可关闭进度提示；失败的最终结果仍保留。最终 JSON 继续写 stdout，数据包内容、Schema/Policy、ID 和重复构建规则不变。要只保存工具的 JSON，可直接调用 Node 并将 stdout 重定向到包外文件（npm 自身仍可能输出命令横幅）。

Wrangler 查询/下载采用异步子进程，保持原有 120 秒单次超时、输出大小限制和脱敏错误码。同步计算期间按 Event 计数更新，定时提示不代表额外数据库访问。无需网站部署或数据库迁移，使用更新后的本地代码即可生效。
