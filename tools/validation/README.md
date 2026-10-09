# Phase 7 · V2.5.4 验证说明

本实现严格区分两种运行模式。`development`（开发模式）允许在模型数据集（Model Dataset）的 `VALIDATION` 划分上，评估最多 5 个来自 Phase 6 的探索性 `TOP_SEARCH_POINT` 候选。所有输出均永久标记为 `DEVELOPMENT_ONLY`，不能用于选择生产候选，也不能授予正式晋级资格。`formal`（正式模式）采用前置条件不满足即拒绝运行的机制；只有具备真实正式语义及独立映射证据的新版上游、正式优化冻结（Optimization Freeze）、独立披露证据及运行时（Runtime）证明均已实现且可用，才允许执行。V2.5.4.1 的 Tuning Policy 3 仍是代理探索策略，不是正式能力证明。

## V2.5.4.1：Validation Policy 2 开发链

旧命令默认 Policy 1，新 Plan 显式选择 `--validation-policy-version 2`，只接受 Optimization Policy 2，适配器为 `OPTIMIZATION_V2_TO_VALIDATION_V2`。VALIDATION 仍要求 ≥30 Event、≥7 日期、城市 ≤50%、日期 ≤35%；至少 3 个等级各 ≥5 Event，非稀有已出现等级仍各 ≥5 Event。excellent 为 0 或 1–4 时只提示警告和单级结论限制，不阻断整体支持度；不减少 rare 样本或改变五级指标。

沿用 Phase 5/6 README 的 PowerShell 变量（来源必须是本轮新链）：

```powershell
$ValidationSources = @($OptimizationSources) + @('--optimization', $Optimization)
npm run validation:plan -- --validation-policy-version 2 --mode development --acknowledge-exposed-validation @ValidationSources
```

路径示例：`$Optimization = 'D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\optimization\exports\optimization_v1_<model_hash>_<new_hash>'`，此包应声明 Policy 2。Plan 返回 `plan_dir`，如 `dataset\validation\plans\validation_plan_v1_<new_hash>`。

```powershell
$ValidationPlan = '<plan 返回的 plan_dir>'
npm run validation:run -- --plan $ValidationPlan @ValidationSources
```

路径示例：`$ValidationPlan = 'D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\validation\plans\validation_plan_v1_<new_hash>'`。run 自动继承 Plan 的策略，**不能再传 `--validation-policy-version`**，也不能替换六源。自定义 `--output` 时，plan/run 必须指向同一个 Validation 根目录以保留 Evidence 和访问账本。

```powershell
$Validation = '<run 返回的 directory>'
npm run validation:validate -- $Validation @ValidationSources
npm run validation:stats -- $Validation
```

路径示例：`$Validation = 'D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\validation\exports\validation_v1_<new_hash>'`。validate/stats 自动分派。新包保存完整 VALIDATION 支持度 cohort 与 rare 审计，分别传播 TRAIN/VALIDATION 限制，支持度摘要及内容进入包身份；重新计算外层 Hash 不能跳过内部语义重算。

不带参数的旧 Plan/结果仍按 Policy 1 检查所有已出现等级最小数量。已有包不改写，复用已查看的开发数据不会恢复盲验证资格。本版 `formal` 仍 BLOCKED；新包只能作为开发诊断。

在 `SunsetScore-main` 目录下运行，并提供 6 个不可变的源数据包目录：

```powershell
npm run validation:plan -- --mode development --acknowledge-exposed-validation --raw <raw-export> --gt <gt-export> --model <model-export> --baseline <evaluation-export> --sensitivity <sensitivity-export> --optimization <optimization-export>
npm run validation:run -- --plan <validation-plan-directory> --raw <raw-export> --gt <gt-export> --model <model-export> --baseline <evaluation-export> --sensitivity <sensitivity-export> --optimization <optimization-export>
npm run validation:validate -- <validation-export-directory>
npm run validation:stats -- <validation-export-directory>
```

路径示例（Windows）：以上命令从 `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main` 运行。下表中的 `<…_id>` 是占位符，需替换为实际生成的数据包或计划 ID；示例不表示这些目录已经存在。

| 命令中的占位符 | 对应目录 | 绝对路径示例 |
| --- | --- | --- |
| `<raw-export>` | 原始数据包 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\exports\<raw_id>` |
| `<gt-export>` | 真值数据包 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\ground_truth\exports\<gt_id>` |
| `<model-export>` | 模型数据包 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\model\exports\<model_id>` |
| `<evaluation-export>` | 基准评估包 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\evaluation\exports\<evaluation_id>` |
| `<sensitivity-export>` | 敏感性分析包 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\tuning\exports\<sensitivity_id>` |
| `<optimization-export>` | 优化实验包 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\optimization\exports\<optimization_id>` |
| `<validation-plan-directory>` | 验证计划目录 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\validation\plans\<validation_plan_id>` |
| `<validation-export-directory>` | 验证结果包 | `D:\Codex_Project\Sunsetscore_Project\SunsetScore-main\dataset\validation\exports\<validation_id>` |

也可使用相对于当前工作目录的路径，例如 `--raw "dataset\exports\<raw_id>"`。参数必须指向具体数据包目录，而不是 `exports` 父目录或包内的 `manifest.json` 文件；路径包含空格时须用双引号包裹。6 个源数据包必须属于同一条上游数据链，且计划生成与执行时须使用相同的源数据包，不能任意混用不同批次。

`validation:plan` 成功后，用输出中的 `plan_dir` 替换 `<validation-plan-directory>`；`validation:run` 成功后，用输出中的 `directory` 替换 `<validation-export-directory>`。如果上游命令使用了自定义输出目录，应以其实际返回的包目录为准，不要直接套用默认路径。

未提供源数据包时，`validation:validate` 仅执行包内校验。添加 `--model` 和 `--optimization` 可进行有限的身份一致性校验；提供全部 6 个源数据包则可进行关联源数据的重新计算与校验。默认输出目录为 `dataset/validation/{plans,evidence/exports,exports,access-ledger}`。访问账本采用仅追加方式，必须保留；不得通过删除账本，将已经暴露的验证样本群伪装成未暴露样本群。Phase 7 的效果计算不读取 `splits/test.csv`。

验证计划固定源数据包清单、源文件指纹、候选 ID 与规范化参数向量、`VALIDATION` 样本群成员、策略、选择规则、Bootstrap 随机种子及账本前缀。执行时会重新校验身份一致性，并生成按内容寻址的结果包，其中包含逐样本预测、加权核心指标、完整覆盖情况、分组/日期稳健性、确定性的日期分块 Bootstrap 及审计报告。全源校验可能耗时较长，因为 Phase 6 上游校验会重放搜索过程；上游校验失败属于阻断条件，不能因此降级为仅包内审计。

计划生成、执行及全源校验期间，会按规范化路径顺序，为每个源数据根目录和输出根目录持有维护租约。外部访问账本仅允许追加，不会随已发布数据包一起被清理。如果当前评分运行时与优化包冻结的运行时不一致，计划生成会在 `VALIDATION` 效果评估前以 `RUNTIME_MISMATCH` 停止；不得修改已冻结的数据包或绕过此校验，应基于一致的运行时重新构建上游实验批次。

新版结果清单会在顶层及描述对象中同时声明 `result_usage`。已有本地开发包即使缺少顶层字段，仍可按旧版清单格式读取，且不会被原地重写。

`test/validation-fixture.cjs` 是仅供测试使用、在内存中构造正式流程数据的测试夹具。它可生成 `TEST_FIXTURE_ONLY` 数据包，用于覆盖已选出候选、结论不确定及无合格候选这三类结果。任何命令行入口都不能创建此类数据包；这些数据包不能通过 `MODEL_LINKED` / `SOURCE_LINKED` 校验，不能使候选晋级，也不能作为 Phase 8 的输入。真实的 `formal` 命令行调用仍会在前置条件不满足时拒绝运行，直到具备真实正式语义的独立新策略、冻结、披露及运行时条件全部满足；本版 Policy 3 不满足此条件。
