# Model Dataset 构建工具（Phase 3）

本模块把一个冻结 Raw 包及其对应 GT 包关联为 Snapshot 粒度的 Model Dataset，并按完整当地日期块划分 TRAIN / VALIDATION / TEST。工具只读本地包，不联网、不调用 Wrangler、不训练模型、不调整评分参数，也不评估预测准确率。请在 `SunsetScore-main/` 目录执行；工具支持 Node.js 22+，项目测试使用 Node.js 24。

## 命令

```powershell
npm run model-dataset:plan -- --raw <raw_dir> --gt <gt_dir>
npm run model-dataset:build -- --raw <raw_dir> --gt <gt_dir>
npm run model-dataset:validate -- <model_dir> --raw <raw_dir> --gt <gt_dir>
npm run model-dataset:stats -- <model_dir>
```

`plan` 预检数据量与日期切分，`build` 发布不可变包。两者必须显式提供配套 Raw / GT 路径，可用 `--model-version a,b` 按源字段精确筛选模型版本；筛掉的 Snapshot 仍会进入 `excluded_samples.csv`，每条源 Snapshot 只属于一个输出类别。默认输出根为 `dataset/model`，`build` 可用 `--output <目录>` 指定。构建成功响应中的 `directory` 是后续校验和统计所需的 `<model_dir>`。

`plan`、`build` 和带 `--raw` / `--gt` 的来源校验会完整校验 Raw（含 Replay 完整性）及 GT `SOURCE_LINKED`。这只检查文件与来源，不执行 Replay Engine，也不重写 GT。支持 Raw Schema 1；GT Schema 1/2 + Policy 1 或 Schema 3 + Policy 2。旧 Model Schema 1 / Policy 1 包仍按原策略校验；当前新包使用 Model Schema 2 / Policy 3，Schema 与 Policy 分别版本化。

## 入选和切分

- `STRONG` / `MEDIUM` 且日落前的 Snapshot 为 Primary；`WEAK` 与其他符合条件的日落后 Snapshot 为 Diagnostic；`DISPUTED` / `UNLABELED` 等为 Excluded。`WEAK` 判定先于日落后诊断。
- Policy 3 要求至少 30 个 Primary Event、至少三个可切分的完整当地日期块；TRAIN / VALIDATION / TEST 分别至少 15 / 5 / 5 个 Event。目标比例为 70% / 15% / 15%，不拆散同一当地日期。仅总量达到 30 仍不保证可切分；日期块超过 10,000 个会明确失败，不用近似搜索。
- `plan` 对 `READY` 和 `INSUFFICIENT_SPLIT_DATA` 都以退出码 0 返回；不足时 `build` 非零退出且不发布包。旧 Policy 1/2 包继续按原 30/10/10 分组门槛校验，不套用 Policy 3。

## 包结构与读取边界

默认正式包位于 `dataset/model/exports/<model_dataset_id>/`；输出根还包含 `staging/`。包内主要文件为：

```text
manifest.json、schema.json、policy.json
model_samples.csv、event_splits.csv
splits/train.csv、splits/validation.csv、splits/test.csv
diagnostic_samples.csv、excluded_samples.csv
reports/statistics.json、reports/split-balance.json、reports/errors.csv
```

样本表有 94 列：79 列冻结 Raw 字段（源 `id` 在这里成为 `snapshot_id`）及 15 列元数据。Schema 标记字段角色，默认只有 20 个 feature 可进入预测输入 X；`gt_basis` 是目标审计元数据，不进入 X。旧 GT Policy 1 的 basis 仅在 Model 视图映射为 `OBSERVATION_AGGREGATED`，原状态与 confidence 不被提升。

`model_samples.csv` **包含 TEST**，不得把它作为训练输入；训练只读 `splits/train.csv`，候选选择读取 VALIDATION，TEST 留给最终冻结候选评估。目标、权重和内部 baseline 输出也不能进入 X。`replay_path` 相对显式提供的 Raw 根目录，Model 包不复制 Replay Payload 或建立文件系统链接。

CSV 使用 UTF-8 BOM + CRLF，JSON 为规范化 UTF-8、无 BOM 和末尾换行。表格软件应导入查看副本，不要覆盖正式包文件。

## 验证、发布与维护

`model-dataset:validate -- <model_dir>` 只做 `PACKAGE_INTERNAL`；同时提供匹配的 `--raw` 与 `--gt` 才做 `SOURCE_LINKED`。包内校验不能证明源行没有遗漏，也不能证明 Replay Payload 仍可取得。`stats` 先做包内校验。`plan` / `validate` / `stats` 可用 `--report-dir` 写入包外新目录，分别生成 `plan.json` / `validation.json` / `statistics.json`；已有报告不覆盖。

发布前重新校验来源，在排他锁内复核后原子发布；同内容去重，同 ID 内容冲突失败。中断留下的 staging、疑似残留锁不自动猜测清理。命令支持 `--quiet` 关闭 stderr 的中文进度；最终 JSON 在 stdout，npm 可能另有命令横幅。

保留完整 Raw、GT、Model 包及各自 ID 目录，才能长期执行 `SOURCE_LINKED` 复核。Phase 1–5 正式包的血缘查看和授权级联清理走 [数据维护工具](../maintenance/README.md)；不要单独手删上游包。另见 [Model Dataset 中文操作说明](../../../ref_docs/PRD/V2.5.0_Model_Dataset_Builder操作说明.md)。
