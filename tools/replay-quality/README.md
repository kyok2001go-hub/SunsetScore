# 新采集 Replay 质量治理

工具仅验收采集与 Reference 可复现性，不生成 GT、不比较候选效果，也不打开 TEST 效果。生产部署与获取私有采集清单另需相应授权；本地计划文件不能证明云端部署事实。

先取得 Pages 与 Scheduler 的实际 deployment_id、40 位提交与生效时间，再冻结未来连续至少三个上海采集日期。地点记录明确 IANA 时区；每个计划采集时刻同时保存上海日期和地点当地日期。SLOT 固定为 1213 / 1613 / 1720，历史 1755 不改写。计划冻结必须早于计划首个采集时刻。

规格示例（Deployment 字段必须换成真实证据）：

```json
{
  "quality_plan_schema_version": 1,
  "deployments": {
    "pages": {"deployment_id": "<实际ID>", "commit": "<实际40位SHA>", "effective_at_utc": "<实际UTC时间>"},
    "scheduler": {"deployment_id": "<实际ID>", "commit": "<实际40位SHA>", "effective_at_utc": "<实际UTC时间>"}
  },
  "capture_dates_shanghai": ["2026-10-20", "2026-10-21", "2026-10-22"],
  "locations": [{"location_key": "<实际地点键>", "timezone": "Asia/Hong_Kong"}],
  "slots": ["1213", "1613", "1720"],
  "cutoff_utc": "2026-10-23T00:00:00Z"
}
```

```powershell
npm run replay-quality:plan -- --specification <specification.json> --runtime-bundle <bundle> --output dataset/replay_quality
npm run replay-quality:run -- --raw <raw-package> --plan dataset/replay_quality/plans/exports/<plan-id> --runtime-bundle <bundle> --capture-inventory <captures.json> --output dataset/replay_quality
npm run replay-quality:verify -- dataset/replay_quality/exports/<report-id>
```

采集清单独立于 Raw 的 READY 导出，由真实调度/上传证据生成，不能仅列导出中存在的行。文件格式：

```json
{
  "capture_inventory_schema_version": 1,
  "captures": [
    {"location_key": "<实际地点键>", "capture_date_shanghai": "2026-10-20", "scheduled_slot": "1213", "status": "READY", "snapshot_ids": ["<实际snapshot-id>"]}
  ]
}
```

必须逐格覆盖冻结计划的地点 × 日期 × SLOT，不能省略缺采。状态支持 READY、MISSING、UPLOAD_FAILED、REPLAY_MISSING、FAILED、UNKNOWN；无可信证据应使用 UNKNOWN。READY 清单中未被导出的 Snapshot 单独形成缺口，不被静默丢弃；任何范围内导出 Snapshot 都须在清单中登记。

Raw 先完成包内验收；计算范围为预先声明采集格内全部已导出的 github_schedule Snapshot。每条 Replay 检查身份/Schema/内容 Hash，并要求 Snapshot 与 Replay 的 engine_build_sha 等于计划的 Pages 提交；不同构建即使 Reference 偶然相同也失败。计算快照须支持质量工具契约修订 1，较早的开发快照明确拒绝。随后使用冻结快照中的 Runner 独立执行两次，Reference 容忍沿用既有契约。执行异常与 Reference 失配明确记录，瞬态内存/磁盘/超时故障中止整次报告。报告包含完整计划、清单、逐 Snapshot 结果、缺口与摘要。

有缺采/失败/Reference 失配为 FAIL；缺真实分钟降水 available、跨时区 NWP 节点或香港行政元数据场景为 COVERAGE_PENDING。跨时区场景要求节点与中心的 UTC offset 实际不同，仅 IANA 名称不同而 offset 相同不算覆盖。只有无缺口、Reference 全通过、关键场景齐全且两次结果相同才 PASS。PASS 只证明所声明范围的工程质量。离线 fixture 不能成为真实生产验收证据。

计划、报告和 Runtime 的来源接入维护血缘；跨根闭包不可证明时阻断单根自动清理。已有八条 VALIDATION 历史失配仍留在历史报告中，不纳入新部署采集范围，也不按候选误差排除样本。
