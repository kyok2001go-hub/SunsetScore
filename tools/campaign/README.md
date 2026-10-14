# V2.5.4-B Campaign 冻结与准入

Campaign 绑定同一 Model 的 TRAIN / VALIDATION / TEST，合格语义证据、执行 Runtime 和每个实际 Engine build SHA 的代码证明。当前模板使用 Specification 2 / Campaign Policy 2，绑定 Model Schema 2 / Policy 4 和固定 55/30/15 日期块切分。旧 Specification 1 / Campaign Policy 1 的 70/15/15 规则继续按原版本读取和重算；两种版本都保留 GLOBAL_CORE_V1 搜索与 Validation Policy 3，不能在运行后修改冻结规则以获得入选。

`campaign.specification.json` 中的 `campaign_specification_version` 必须与比例配套：版本 2 使用 `[55,30,15]`，版本 1 使用 `[70,15,15]`；新版配错 Model 策略或仅改比例会明确拒绝。新旧 Campaign 的内容身份不同，不改写旧包。比例改变不恢复已经暴露的验证集独立性；冻结 Runtime 的工具也必须包含对应版本实现。

2026-10-13 起，当前已核对录入的数据默认使用 `metric:confirm` 生成的团队确认语义包（Semantic Schema 2 / Policy 2），无需重复试标或第二人盲标。它必须绑定 Campaign 相同的 Raw / GT 完整身份；既有标签的确认不计入额外量表开发样本，但全部真实预测效果使用历史继续检查。原双人复核语义包仍按 Policy 1 验证。

## 准备和冻结

复制 `templates/` 到独立工作目录，按实际情况填写。历史账本注册表与 build Runtime 注册表只保存本机路径配置，发布包仅保存身份和 Hash。默认必查主账本及 Model 所在数据根账本；其他已知历史账本必须明确列出，即使移过目录也应保留。

```powershell
npm run experiment-runtime:freeze -- --protocol-version 2
npm run campaign:plan -- --specification <Campaign定义JSON> --raw <Raw> --gt <GT> --model <Model> --metric-evidence <合格语义证据> --runtime-bundle <Runtime-v2> --build-runtimes <Build证明注册表JSON> --history-ledgers <历史账本注册表JSON> --access-ledger <主账本>
npm run campaign:freeze -- --specification <Campaign定义JSON> --raw <Raw> --gt <GT> --model <Model> --metric-evidence <合格语义证据> --runtime-bundle <Runtime-v2> --build-runtimes <Build证明注册表JSON> --history-ledgers <历史账本注册表JSON> --access-ledger <主账本>
```

计划检查完整 Raw / GT / Model 来源合法性，不计算 VALIDATION / TEST 效果。历史 Engine SHA 来自 Replay 索引；证明包必须实际归档对应提交的干净工作树、Engine、Registry 和 Evaluator。当前执行 Runtime 的源文件也必须与实验实现逐字节匹配。Protocol 1 仍可执行旧开发链，不能作为新正式证明。冻结一个脏工作树不会让历史 build 自动获得证明。

准备试标或复核不能与 VALIDATION / TEST 重合。历史搜索、人工效果查看、Validation Run/Verify 和语义使用都参与身份审计；同时检查 Event ID 和规范地点/日期。已经暴露的数据无法通过换根、重建包或声明“新 Campaign”恢复独立性。软件不能证明线下人工是否隐瞒历史，操作人必须如实声明适用范围与所有已知账本。

## 正式计算顺序

按同一 Campaign 和 Runtime 执行新组合：Evaluation Schema 3 / Policy 3，Sensitivity Schema 3 / Policy 4，Optimization Schema 2 / Policy 3。三个命令共用 `--campaign`、`--metric-evidence`、`--runtime-bundle`、`--access-ledger`、`--history-ledgers` 和原有来源参数；版本参数分别为 `--evaluation-version 3`、`--tuning-version 4`、`--optimization-policy-version 3`。

这些计算只使用 TRAIN 效果。Stage A 的全包来源验收不是 VALIDATION / TEST 效果评估。TRAIN 至少 100 Event、14 日期、至少三个充分支持等级；单地点/日期占比及非稀有等级支持要求不变。excellent 0 或 1–4 Event 仅软警告，完整保留样本，并持续声明能力未充分验证。缺候选时不会制造 Freeze。

真实 Candidate Freeze 后生成正式独立性披露，再冻结 Validation Plan：

```powershell
npm run campaign:disclosure -- --campaign <Campaign> --model <Model> --declaration <真实人工独立性声明JSON> --access-ledger <主账本> --history-ledgers <历史账本注册表JSON> --output dataset/validation
npm run validation:plan -- --validation-policy-version 3 --mode formal --disclosure-evidence <新披露证据包> <六源及Campaign参数>
npm run validation:run -- --plan <Plan目录> <六源及Campaign参数>
npm run validation:validate -- <结果目录> <六源及Campaign参数>
```

VALIDATION 至少 30 Event、7 日期，其他分布、等级支持、100% Reference、100% 双分母覆盖、固定 2000 次日期块 Bootstrap 和 TRAIN 冻结 no-skill 条件不变。首次效果访问必须先登记冻结 Plan 的授权。发布前使用全新进程独立重算全部结果文件和 manifest；全六源 Verify 再独立重算并追加访问审计。

`SELECTED`、`NO_ELIGIBLE_CANDIDATE`、`INCONCLUSIVE` 都是合法业务结论。只有真实 FORMAL 的 SELECTED 可以声明后续晋级资格；测试夹具永不晋级，TEST 效果始终禁止访问。本阶段不自动部署、改配置或执行 Phase 8。

采集质量的可填写模板位于 `templates/replay-quality.specification.template.json` 与 `templates/capture-inventory.template.json`。占位符不能直接验收，完整清单必须覆盖冻结 Plan 每一个应采格。尚未部署的 1720 调度不得写成已生效。
