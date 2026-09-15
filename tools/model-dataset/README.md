# Model Dataset Builder V2 (V2.5.0)

Local Node.js 22+ tools; project tests use Node.js 24. No network, Wrangler,
production writes, scoring changes, model fitting or accuracy evaluation.
Model Schema 2 and Policy 2 are independent of Raw/GT/model versions.

Run from the application root with one exact Raw package and its GT package:

```text
npm run model-dataset:plan -- --raw <raw_dir> --gt <gt_dir>
npm run model-dataset:build -- --raw <raw_dir> --gt <gt_dir>
npm run model-dataset:validate -- <model_dir> --raw <raw_dir> --gt <gt_dir>
npm run model-dataset:stats -- <model_dir>
```

Plan, build and source-linked validation perform full Raw validation (including
Replay integrity) and GT SOURCE_LINKED validation. Raw Schema 1, GT Schema 1/2 Policy 1 or GT Schema 3 Policy 2 are supported. No Replay engine is executed and GT is not rewritten.

Optional `--model-version a,b` on plan/build is an exact stored-value filter.
Trimmed values are deduplicated and sorted. Filtered-out snapshots remain in
excluded_samples.csv; every Raw snapshot belongs to exactly one output category.
STRONG/MEDIUM pre-sunset rows are Primary, WEAK and otherwise eligible post-sunset
rows Diagnostic, DISPUTED/UNLABELED rows Excluded. WEAK takes priority over post-sunset.

Primary Events are split by complete local date blocks, minimizing 70/15/15
deviation subject to TRAIN/VALIDATION/TEST minima of 15/5/5 Events and at least 30 PRIMARY Events in total. A split
requires at least three date blocks; having 30 Events alone is insufficient.
Plan exits 0 for both READY and INSUFFICIENT_SPLIT_DATA. Insufficient build exits
nonzero with a plan and creates no output package. More than 10,000 Primary date
blocks fails explicitly rather than approximating the exhaustive split search.

The default output root is dataset/model, with staging/ and exports/ children;
`--output <root>` changes it. Publication requires SOURCE_LINKED validation and
source rechecks, followed by a 10-second exclusive lock and atomic rename.
Matching packages deduplicate without replacing prior manifests/reports;
conflicts fail. Interrupted staging and existing locks are not silently removed.

Without `--raw` and `--gt`, validation is PACKAGE_INTERNAL only. Provide both
for SOURCE_LINKED. Internal validation cannot prove absence of omitted source
rows or existence of Replay payloads. Stats first performs internal validation.
Reports default to stdout; plan/validate/stats accept `--report-dir` outside all
known input packages and refuse existing report files.

Output: manifest/schema/policy; model_samples.csv (all Primary), event_splits.csv,
splits/train.csv, splits/validation.csv, splits/test.csv, diagnostic_samples.csv,
excluded_samples.csv; reports/statistics.json, split-balance.json and errors.csv.
Sample tables share 94 columns: 79 frozen Raw columns (id becomes snapshot_id)
and 15 metadata columns. Schema explicitly labels field roles and allows only
the 20 feature columns as default prediction inputs. CSV is UTF-8 BOM/CRLF;
JSON is canonical UTF-8 without BOM or trailing newline. Do not resave package
CSVs from a spreadsheet application; export a viewing copy instead.

**model_samples.csv includes TEST.** Future training must use train.csv;
candidate selection uses validation.csv and final evaluation uses test.csv.
Targets, weights and baseline outputs must not enter X. test_set_policy is
final_evaluation_only; this builder does not implement an optimizer access system.
Fix the same model_dataset_id for one candidate comparison campaign.

replay_path is relative to the explicitly supplied source Raw root, not the
Model package. No Replay payload is copied and no filesystem link is created.
Move/archive complete Raw, GT and Model packages together, preserving ID folder
names. Deleting one never cascades to another; without sources only internal
checks remain possible. See the Chinese V2.5.0 guide under ref_docs/PRD.

gt_basis follows gt_status in samples and Event rows; it is target metadata,
never an X feature. Statistics report basis per Event globally and per split.
Legacy GT Policy 1 values are never upgraded by Model Builder: their basis maps
to OBSERVATION_AGGREGATED and original status/confidence remain unchanged.
Model Schema 1 / Policy 1 packages remain fully readable under their frozen
contracts. New packages use model_v2 IDs. Only supported upstream combinations
are Raw1 + GT1/Policy1, GT2/Policy1, or GT3/Policy2.

## 终端进度提示（2026-09-15）

model-dataset:build、model-dataset:plan、model-dataset:validate 和 model-dataset:stats 默认输出中文阶段与累计耗时，支持追加 --quiet 关闭提示。进度写 stderr，最终 JSON 继续写 stdout；npm 自身可能输出命令横幅。

build / plan 显示 Raw 文件指纹、完整 Raw 校验（含 Replay）、GT 来源关联、Snapshot 关联处理数量、Event 资格与权重、日期边界搜索、计划统计。build 另显示样本门禁、写 staging、来源校验及锁内发布/去重。交互终端的计数提示节流约每秒一次，非交互环境保留阶段日志；异步等待约每 10 秒显示耗时，同步日期搜索使用边界计数反馈。

plan 样本不足仍正常返回 INSUFFICIENT_SPLIT_DATA（退出码 0），build 不足仍失败且不发布包。validate / stats 显示整体校验阶段和等待耗时。进度不影响数据选择、Schema/Policy、包 ID、Hash、统计、退出码及去重，不进入数据包或报告。仅更新本地工具即可生效，无需网站部署。

## 30 个 PRIMARY Event 构建门槛（2026-09-15）

当前默认 Model Policy 3，Model Schema 仍为 2。构建要求 PRIMARY Event 总量至少 30，TRAIN / VALIDATION / TEST 分别至少 15 / 5 / 5，至少三个可分离的完整日期块。总量达到 30 仍须满足按日期划分的每组下限；不能拆散同一天的数据来凑数。继续以 70% / 15% / 15% 为优化目标，保留原有同分边界选择、GT 资格、时间和权重规则。

日志中的日期数量 3、4、10、8、8（总计 33）可以按 17 / 8 / 8 构建。29 个及以下不能构建；只有一个日期块或验证/测试组不足也不能构建。

旧 Model Policy 1/2 包按原 30/10/10 规则校验；新包采用 Policy 3 并生成不同内容 ID。Raw 和 GT 不需要重新导出或构建，可直接用原来的 --raw / --gt 路径重跑 model-dataset:plan 与 model-dataset:build，再用 model-dataset:validate 做来源关联校验。放宽构建门槛不表示少量样本已足以证明模型效果。
