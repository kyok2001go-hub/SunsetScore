# Ground Truth 构建工具（Phase 2）

本模块从一个指定的 Raw 包聚合 Event 级 Ground Truth（GT）。工具只使用本地文件，不联网、不调用 Wrangler、不写生产数据库，也不训练模型或改动评分。请在 `SunsetScore-main/` 目录执行；Node.js 22+ 可运行，本项目测试环境为 Node.js 24。

## 命令与输入

```powershell
npm run gt:build -- dataset/exports/<raw_id>
npm run gt:validate -- dataset/ground_truth/exports/<gt_id> --source dataset/exports/<raw_id>
npm run gt:stats -- dataset/ground_truth/exports/<gt_id>
```

构建只读取该 Raw 包的 `manifest.json`、`schema.json`、`raw/events.csv` 和 `raw/sunset_observations.csv`。不读取预测、Replay 或其他 Raw 包来决定标签；无效 Observation 会明确失败，不会静默丢弃。一个构建仅消费一个 Raw 包，不自动合并多个导出。Raw V1 本身只包含符合导出契约的 READY Replay Event 及其 Observation，不是 D1 全部历史。

默认输出根目录为 `dataset/ground_truth`，可用 `--output <目录>` 指定。新构建使用独立的 GT Schema 3 / Policy 2，旧 Schema 1/2 + Policy 1 包仍按原契约读取、校验和统计；升级规则时须从相同 Raw 包重新构建，不改写旧包。

## 校验与输出

`gt:validate` 不带 `--source` 时为 `PACKAGE_INTERNAL`：检查 GT 包自身的文件、版本、Hash、字段和聚合关系。带同源 Raw 包路径时为 `SOURCE_LINKED`：进一步核对来源 manifest、Event 和 Observation 贡献。正式构建在原子发布前必须通过来源关联校验；仅包内通过不能证明来源正确。

首次发布返回 `EXPORTED`，相同输入和契约返回 `DEDUPLICATED`。默认路径为 `dataset/ground_truth/exports/<gt_id>/`，包含 `manifest.json`、`schema.json`、`policy.json`、`event_ground_truth.csv`、`observation_contributions.csv` 与 `reports/`。输出根还包含 `staging/`。同 ID 不同内容或已有损坏包不会被覆盖；构建中断留下的 staging 需在确认进程结束后处理。发布锁最多等待约 10 秒，不自动清理疑似残留锁。

`gt:validate` 和 `gt:stats` 只读包。可用 `--report-dir` 把 `validation.json` 或 `statistics.json` 写到输入包外的新目录，已有报告不会覆盖。复制 GT 包时保留完整 ID 目录；要再次做 `SOURCE_LINKED`，还需保留并显式提供对应 Raw 包。CSV 请以文本方式导入表格软件，不要另存覆盖包内文件。

## GT Policy 2 口径

- 只有来源为 `rednote_manual` 的单条 Observation 被视为管理员裁定；其 rating 成为该 Event 的标签。同一 Event 出现多条管理员人工记录会失败。
- 若等级跨度 ≥3 或一致性 <0.5，仍优先标记 `DISPUTED`；否则沿用既有 `STRONG` 门槛，并至少为 `MEDIUM`。管理员裁定的 MEDIUM confidence 下限为 0.6、上限为 0.75。该 confidence 是规则权重，不是校准后的标签正确概率。
- `evidence_count` 只作审计，不按数量增加投票权；其他来源保持 Policy 1 的聚合规则。
- Schema 3 在 `event_ground_truth.csv` 的 `gt_status` 后增加 `gt_basis`，值为 `ADMIN_ADJUDICATED` 或 `OBSERVATION_AGGREGATED`。`observation_contributions.csv` 前四列为 `event_id`、`event_date_local`、`city`、`observation_id`；日期和城市来自 Event，仅供查看，不改变旧 Policy 的权重。

本模块不计算预测准确率、不划分 TRAIN/VALIDATION/TEST、不执行 Replay。构建支持 `--quiet` 关闭 stderr 的中文阶段和耗时提示；`gt:validate` / `gt:stats` 当前不接受该参数，结果输出到 stdout。

Phase 1–5 正式包的依赖检测与授权级联清理使用 [数据维护工具](../maintenance/README.md)；直接删除 Raw 不会让 GT 目录自动消失，但会失去来源复核能力。另见 [GT 中文操作说明](../../../ref_docs/PRD/V2.4.9_Ground_Truth_Builder操作说明.md)。
