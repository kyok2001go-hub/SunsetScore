# 五级晚霞审美语义准备与独立复核

## 默认采用团队录入前确认

2026-10-13 项目负责人确认：现有数据由本人和团队核对后才录入。现有批次接受该既有审核，不再重复试标、补例图或组织第二人盲标。新增 Semantic Schema 2 / Policy 2，仅绑定具体 Raw / GT 的 ID、Manifest SHA、实际标签与范围；不制造盲标一致率，不改变 GT 对 UNLABELED / WEAK / DISPUTED 的处理。

```powershell
npm run metric:confirm -- --raw <Raw包目录> --gt <GT包目录> --declaration <团队确认JSON>
npm run metric:validate -- <团队确认包目录> --raw <Raw包目录> --gt <GT包目录>
```

确认 JSON 的格式见 `templates/team-confirmation.template.json`。本次当前主批次的确认已根据用户原话归档，不需要重复填写。确认包只覆盖具体来源；换批次重新绑定，不能自动宣称未包含的新数据已审核。分档继续沿用 20/40/60/90 产品决定，分界最优性和独立盲标一致性未实测；excellent 软警告仍保留。

确认日志为 `TEAM_LABEL_CONFIRMATION_REGISTERED`，不算重复量表开发或预测效果读取。Campaign 仍检查样本门槛、真实历史暴露和 Runtime/build，要求来源完全匹配。旧 Rubric/试标/独立复核包继续按原 Policy 1 验证；以下为可选的独立复核流程。

本工具只处理离线 JSON 和具备使用许可的证据文件。固定产品分档为整数 0–100，边界 20/40/60/90；任务是实际晚霞观感的五级审美质量。`UNASSESSABLE` 表示不能可靠判断，不转换为 poor，也不进入 ordinal。

## 人工准备

复制 `templates/` 中的 JSON 到独立工作目录，填写实际材料、真实人工 ID、实际 UTC 时间和声明。模板中的占位符、false 和空例图不是合格证据；不要机械替换为 true。Rubric 的 ±30 分钟观察窗口只是可修订草案，需要人工明确确认。

```powershell
npm run metric:rubric -- --specification tools/metric-semantics/templates/rubric.specification.json
npm run metric:template -- --rubric <Rubric包目录> --index <证据索引JSON> --output <新人工工作目录> --access-ledger <统一访问账本目录>
npm run metric:pilot -- --rubric <Rubric包目录> --index <试标索引JSON> --annotations <第一人标注JSON> --access-ledger <统一访问账本目录>
```

索引中的 `asset_paths` 相对索引文件所在目录解析，不允许越界。每份证据的 SHA256 必须与实际文件字节一致，且许可声明必须为真。发布包归档证据字节和来源元数据，保留选择规则、地点、日期范围、渠道、局限、日落时间和观察时间。`metric:template` 输出去除 Event、预测值和既有标注的工作材料，并登记所用 Event，避免这些样本以后被误认作独立 VALIDATION / TEST。

第一人完成试标后可以修订 Rubric。每个非稀有等级必须有可审计例图，引用试标或独立复核材料中的实际 SHA。excellent 仍为稀有等级软门槛；缺少样本时保留能力未充分验证的声明。

## 独立复核

另选未用于修订 Rubric、未按候选误差筛选的复核样本。它们不能与试标具有相同 Event、相同地点/日期或相同证据字节。第一人完成标注，再冻结复核计划和判据，然后向第二名独立人工提供包内 `blind_template.json` 和 `blind_evidence.json`。

```powershell
npm run metric:review-plan -- --rubric <修订Rubric> --pilot <试标包> --index <独立复核索引JSON> --annotations <第一人复核标注JSON> --specification <冻结复核判据JSON> --access-ledger <统一访问账本目录>
npm run metric:review -- --plan <冻结复核计划包> --annotations <第二人标注JSON> --conclusion <复核结论JSON> --access-ledger <统一访问账本目录>
npm run metric:validate -- <语义证据包> --plan <冻结复核计划包>
```

`review-conclusion.template.json` 区分实际观察范围与声明适用范围。后者可以覆盖未来 Campaign，但必须由人工说明依据和局限。所有分歧都须逐条裁定，并说明是否解决重大歧义。不同人工 ID、盲标声明、提交顺序和冻结定性判据均为硬要求；AI 不能充当第二名人工。数值一致率上限可以为 null，定性判据和依据仍必须冻结。全部不可判断不能获得 READY。

单人试标及冻结计划仅为准备状态。只有独立复核通过且范围匹配的语义证据才能解锁新正式 Policy。检查会重新推导整个包及嵌入来源，不能通过改摘要或 Hash 升格。公开 CLI 拒绝 `TEST_FIXTURE_ONLY`；该标记仅供源码测试 API 验证，不允许正式晋级。

## 数据保护

发布过程持有维护租约，校验来源、登记语义使用、验证 staging 后原子发布。来源和输出跨根时保留保护记录；无法证明完整依赖闭包时禁止自动 prune。准备素材应使用未来实验之外的独立样本。换文件夹、重建包和换 Event ID 均不会消除已经登记的地点/日期暴露历史。
