# 轻量 component_weights 调优（V2.5.4.9）

## P0 机制诊断与信号复核（V2.5.5.3，Schema/Policy 9）

```powershell
npm run tuning:practical -- --search-space p0-diagnostics --model <DEV model目录> --raw <DEV raw目录> --gt <DEV gt目录> --output dataset/practical_tuning
npm run tuning:practical-stats -- --input <本轮Run目录>
npm run tuning:practical-verify -- --input <本轮Run目录>
```

只读诊断，不搜索、不产生候选、不改配置。需求见 [V2.5.5.3 PRD](../../../ref_docs/PRD/V2.5.5.3--P0机制诊断与信号复核方案.md)。编号 7、8 已被未合并的 V2.5.6 / V2.5.7 分支 Run（practical_tuning_v7_* / v8_*）使用，本模式直接用 9。

- **输入约束：** 只接受 DEV 包（Raw ea82b68bfe49 / GT 49c9adac6188 / Model f02dbabc357c，655 条），任何当地日期 ≥ 2026-10-13 的行（H1）直接拒绝。
- **基准：** C = `releaseConfigs()['2.5.5.2']`（22/47/66/90），R = 2.5.5.1。运行前必须与 `release.mjs` 中固定的 V2.5.5.2 与 V2.5.5.1 预测签名逐条一致。
- **观察器：** `runReplay(..., { trace: true, diagnosticObserver: true })` 额外返回日落时刻 33 节点云场、引擎实际走廊样本、GW 输入与路径、暮光时长，只复制已消费的值、不改 `js/`；运行时证明观察器开/关分数一致，并逐行核对 GW 重建与 horizon 聚合。
- **冻结计划：** `P0_POLICY`（`p0-features.mjs`）含特征定义、主/两套备选阈值、分箱与形状规则、探针、逻辑回归参数、Bootstrap 种子和 §9 映射；其 Hash 进入 Run 身份，修改须升级 Policy。
- **内容：** D1 机制分组误差与丢分定位、D2 黄金窗口路径/云层组合/反事实探针（GWP-0–3，只作诊断）、D3 单变量筛查/分箱曲线/大气冗余与增量（L2 逻辑回归，留一日期 OOF），以及 `p0_decision.json` 的优先级建议。
- **复算：** 发布前新进程完整重算 payload，要求字节一致；`verify` 同样重算。

## Illumination评分拆解与定向优化（V2.5.4.14，Schema/Policy 6）

```powershell
npm run tuning:practical -- --search-space illumination-targeted --baseline-run <V5父Run目录> --model <model目录> --raw <raw目录> --gt <gt目录> --output dataset/practical_tuning
npm run tuning:practical-stats -- --input <本轮Run目录>
npm run tuning:practical-verify -- --input <本轮Run目录>
```

一条命令完成V5父selected为C、original_control为B0的默认复现，全池光照子过程Trace、活跃入口计划、真实初探/单参数细化、Phase7、新进程复算和四份配置导出。指定同池655 Snapshot/270 Event/33日期，保持GT、Event分权、权重、高云60/25、中云54/34、黄金窗口floor=0.507692307692、大气质量与天空演化系数、20/40/60/90阈值。数据仍为复用开发池；不新增数据或正式资格要求。

共享engine只增加illuminationModel.bankShare（默认0.5、范围[0,1]）与illuminationModel.twilightSaturationMinutes（默认35、范围[10,90]）。分别替换光照内部bank/spatial混合与太阳项除数，不改变共享bankScore、spatialCompat、高中云曲线、距离/可信度、30/70或dataFactor，也不把诊断distanceReliability乘入。旧字段缺失执行旧常数，合法bankShare=0保留。生产/Replay调用相同公式；新参数进入runtime_config_key，避免改参复用旧结果。资源修订illumination1不等于模型版本晋级或已部署。

illumination_traces.jsonl保存全部成员实际日落插值节点、距离/方位/有效性、high/mid评分与混合、半开距离带、可用值/均值、权重与真实分子/分母、中心/侧向原始云量、对比/封顶/归一化、bank可用项、回落、太阳输入/除数/截断、原始光照/夹限和动态贡献，以及P/Q、后续阶段、完整天空分支和F_gw。可选offlineTrace/illuminationTrace在实际执行点采集，正常返回与生产日志不增加字段。每条核对子项重建、贡献及最终守恒（1e-8），开关分数/等级完全相同。

保留原始裁剪云层序列、时刻/偏移与实际插值结果，明确共享插值层会把缺云层回落0；这与真实0、引擎无分带回落不同，本轮不修正其行为。contrastBonusMax在正值正常路径先乘后除抵消，不列为有效调优入口；对比有效负/0表示中心不比两侧突出，不能冒称缺失。

illumination_summary.json覆盖全部、高等级漏报/命中、低等级0/1/2、漏报预测0/1/2与分数段、天气型/提前量；报告太阳/云幕/空间/差值/dataFactor/illumination的p10/p50/p90、组内均值/分母和全池贡献、回落与有效非正对比支持。加权两两排序一致率检验分布重叠，只属漏报vs全部低等级的关联指标，不是独立验证或因果。bank同时进入skyCanvas和illumination，共享输入不能单独证明重复扣分。

illumination_plan.json在初探前冻结：只有实际漏报在给定探测点能产生组件变化的入口活跃，两个有作用入口全部试验。bankShare初探0.25/0.375/0.5/0.625/0.75，饱和分钟25/30/35/40/45，默认点与C去重，最多9个配置。优先达累计底线且损失胜C的最佳点，否则正净找回量且损失最小的点；只在该点与默认之间取8个等距内点，仅细化一个参数。总≤17唯一配置（含C不含B0），无端点停止细化，无入口NO_ACTIONABLE_PARAMETER，均可KEEP_CONTROL完成；不联合或扩大搜索。

每点全池实际Replay和Trace，illumination_coupling_audit.json核对其他四组件/动态权重/Q、门控、真实天气扣分/结构与过渡加分、天空状态/F_sky/F_gw、共享云评分及原始输入不变；允许illumination、P及其后分数响应。候选失败整点ERROR，不删行。all_grade_changes.json保留所有等级变化，配对找回/丢失/新增及消除≥3误报仍用全池Event分权，误报按实际0/1/2，净找回/高等级支持等于召回变化。不以无≥3误报掩盖其他一级高估。

累计≥2/≥3召回底线保持B0−0.02/B0，epsilon=1e-12、null不通过，严格胜最新C才替换。high_grade_recognition_improved只由≥3召回实际增加决定；报告损失、MAE/Bias、≥2能力、高估/低估≥2级、4级支持和净找回最多点完整代价。没有预测4仍NOT_ASSESSED。

引擎源码Hash改变，engine-compatibility仅允许固定旧引擎/受限文件字节的默认兼容转换，并必须精确复现全部B0/C分数、等级和指标。旧V4冻结计划还绑定源码行号：仅对已知旧引擎+Registry Hash恢复原位置证据，再精确比较旧计划Hash；当前新建V4使用实时Registry。V1–V5保留原策略和历史包，不伪称原环境、不删除Hash检查。旧配置不补新字段，baseline/rollback=C，original=B0，selected为最终选择。

身份绑定父包/数据/成员/B0/C/代码/策略/计划/Trace/汇总与选择，同spec恢复复用冻结入口与细化。发布前新进程和独立verify只复算B0/C/N（相同配置去重）、C/N各全池光照Trace、还原/耦合/迁移/选择；其他候选从保存结果校核，不重搜。新增selected_illumination_traces.json等产物，输入和历史包不覆盖，使用记录一次。计划耗尽即停止，导出不自动上线；共享bank规则的改变不在本期暗中执行。

## 天空演化分支验证与单系数优化（V2.5.4.13，Schema/Policy 5）

```powershell
npm run tuning:practical -- --search-space sky-branch --baseline-run <V4父Run目录> --model <model目录> --raw <raw目录> --gt <gt目录> --output dataset/practical_tuning
npm run tuning:practical-stats -- --input <本轮Run目录>
npm run tuning:practical-verify -- --input <本轮Run目录>
```

一条命令完成V4父selected为C、original_control为B0的默认复现，全池实际分支Trace、唯一分支/系数计划、有限真实试验、Phase7、新进程复算和四份配置导出。指定开发池仍为655 Snapshot/270 Event/33日期，保持GT、成员、Event内权重、基础权重、高云60/25、中云54/34、黄金窗口floor=0.507692307692和等级阈值。本入口不扩大数据或引入正式资格要求；没有改善正常KEEP_CONTROL并完成。

共享sky_state.determineState新增可选只读observer，实际执行时记录输入与时相、当前/m60节点总云量及可对应云层辅助值、扇区数量/加权/舍入、缺失和合法0、现有||默认行为、到达时间truthy、逐项TRUE/FALSE/NOT_EVALUATED、主/子分支、公式/分支下限/三位舍入/内部夹限，以及Replay融合的固定[0.65,1.15]外部夹限、应用因子、Score_engine、F_gw和最终分数。普通返回结构和生产日志保持原契约。缺summary的UNCERTAIN=1.0单独标记MISSING_SUMMARY；正常UNCERTAIN=0.95。窗口外NOT_EXECUTED，不能混入已执行且因子无影响；云层辅助值不参与分支条件。

sky_branch_summary.json按全部、高等级漏报/命中、全部低等级及实际0/1/2分组，保存各分支Snapshot/Event/日期、因子分布、条件均值、全池贡献、夹限/回落与跨60支持。条件均值除本分支组权重，全池贡献除全池权重；阶段跨线只是执行描述，不代表最终可找回量。

branch_plan.json先筛选漏报实际命中、应用F_sky<1且合法系数变化能影响最终因子的分支，再按漏报向下跨60的全池权重、漏报压分加权总量降序、低等级同分支权重升序、固定分支顺序排序。指定655条的胜出分支是CLOUD_ARRIVING，因此仅提取skyState.factorCoefficients.arrivalRiskSlope，缺省旧常数0.30、合法范围[0,1]、合法0保留；其余系数不接入。其他数据若选中不同分支将明确失败，不能自动套用arrival参数。

初探0.18/0.24/0.30/0.36/0.42，默认点与C去重。优先以达累计召回底线且损失胜C的最佳点为端点，否则选择净找回>0且损失最小的点，取默认值到端点之间8个等距内点；无端点即停止。唯一配置最多13个（含C，不含B0），只调整这一个系数。值规范12位、实际因子仍三位舍入；完全相同预测单列同效组，不宣称高精度物理常数。每点对全池实际Replay并检查观察器开关；非目标分支状态/因子/分数零变化，目标分支其他组件、Q、门控、扣分和F_gw必须相同，候选失败整点ERROR，不能删行。

累计底线仍以B0固定：≥2召回≥B0−0.02、≥3召回≥B0，epsilon=1e-12、null不通过；达标后须产品损失严格低于最新C才替换。配置选择与high_grade_recognition_improved分开，后者只有≥3召回实际增加才为true。全候选配对迁移沿用全池Event权重，列找回/丢失、新增/消除≥3误报、误报实际0/1/2及净找回/GT≥3支持与召回变化核对。报告同时给出净找回最多候选的完整代价、≥2召回、MAE/Bias、两级高估/低估和预测4支持。

提取系数与observer改变源码指纹。engine-compatibility.mjs只接受明确固定的旧/新引擎、sky_state.js/config.js字节Hash及其他引擎文件完全一致的默认兼容转换，随后逐样本/指标精确复现B0/C；不能删除Hash检查。旧冻结配置不补写字段，baseline/rollback均保留原始C，original为B0、selected为最终选择。旧V1–V4可依原策略兼容复算，证据明确当前实现与历史引擎的区别。

新增sky_branch_traces.jsonl、sky_branch_summary.json、branch_plan.json、selected_sky_branch_traces.json和sky_coupling_audit.json，保留逐点预测/指标/迁移、审计与报告。身份绑定代码、父包、B0/C、成员、计划/Trace/汇总Hash及最终选择；相同spec恢复复用既定目标/细化。发布前新进程和独立verify仅Replay B0/C/N（同配置去重）及C/N全池分支Trace，复核开关、耦合、迁移和选择，不重搜。输入和历史包不覆盖。本期计划耗尽即停止，无收益保留C；后续illumination核查只作为一个方向，不自动运行或部署。

## 漏报评分拆解与定向优化（V2.5.4.12，Schema/Policy 4）

```powershell
npm run tuning:practical -- --search-space mechanism-targeted --baseline-run <V3中云父Run> --model <model-dir> --raw <raw-dir> --gt <gt-dir> --output dataset/practical_tuning
npm run tuning:practical-stats -- --input <本轮run-dir>
npm run tuning:practical-verify -- --input <本轮run-dir>
```

一次完成V3父包复现、全部成员Trace开关核对、评分分差守恒与分组、冻结target_plan、真实初探/单参数细化、Phase7和配置导出。C明确取父selected（当前中云54/34），B0取父original_control；父rollback不作为C或B0。baseline/rollback均为本轮C。固定同池成员、标签、Event内分权及等级阈值，不要求新数据或正式资格。

`trace_rows.jsonl`保存每条真实五组件、基础/动态权重、实际贡献、P/Q、阶段输入/输出/分差/原因、阈值差。五贡献和=P、P加全部后续分差=最终分，容差1e-8；负值截断、硬门控、核心与最终舍入均单列。窗口外为NOT_EXECUTED，天空演化及黄金窗口剩余内部仍为PARTIAL_TRACE。黄金窗口因全池证据成为优先对象，只新增其本次执行的日落概率/来源、实际返回/应用因子、floor和状态等只读字段；引擎文件不变，Replay工具字节指纹变化及B0/C原分数完全复现均明确记录。

`stage_summary.json`覆盖全部漏报、命中、全部低等级0/1/2对照，以及漏报预测0/1/2、50–59等分段。组件组内均值除组权重；阶段条件均值只除该阶段已执行且数值可用成员的权重，实际分母见该统计的 `full_pool_weighted_amount`，窗口外样本不混入“已执行且无影响”。全池贡献统一除全池权重；触发支持和阶段跨60单列。阶段跨线不等于删规则后的最终效果，组件距满分不等于应补回分数。

目标从已接线标量选择，按实际干预支持及漏报/低等级的局部阶段响应比排序，优先覆盖不同阶段、ID确定性打破并列；局部响应只用于安排试验，不改旧分数或冒称因果。最多3参数，每项默认c±0.05R/c±0.10R，或预先冻结最多4个Registry离散值；禁止重开权重/高云/中云/阈值或联合搜索。`target_plan.json`记录选中/未选理由、样本、范围和探测值。

初探后优先选择“累计召回达标且损失优于C”的最佳参数；没有时，从净找回权重>0的探测中按损失选一个参数，取C到最佳探测值之间12个等距内点。整数取整、合法去重。两类点都不存在则停止细化。C+初探+细化正常最多25个有效配置，硬预算32；失败点整点ERROR，不能删行。原累计底线仍锚定B0，最终严格优于最新C才替换，否则KEEP_CONTROL并完成。`high_grade_recognition_improved`只有≥3召回实际增加才为true。

迁移沿用全池Event分权，输出找回/丢失/新增及消除误报、新误报按实际0/1/2分列、净找回与召回变化核对。所有候选有逐样本结果、完整指标/矩阵及对低等级的真实得分影响。无可干预参数则正常保留C并给出NO_ACTIONABLE_PARAMETER、代码位置/触发样本/最小验证建议；不得仅交“建议下次试”。

准备阶段以数据/父包/代码/策略基身份锁定 `.work/practical_preparation_v4_<hash>`，逐样本Trace可恢复。完整Trace后冻结目标计划；最终Run身份绑定计划、Trace及阶段汇总Hash。`--resume`复用已确定计划，不凭未完成结果重新挑目标；初探后的单参数细化计划另行冻结。代码/数据/策略变化另建Run。发布前与单独verify仅在新进程Replay B0/C/最终选择及C全池Trace开关/守恒，同配置去重；其他候选指标/迁移从冻结逐点结果校核，不重复整场搜索。

报告区分配置改善与高等级识别改善，保留所有代价，并只给一个有证据的后续方向及最小区分实验。本轮停止后不自动追加试验或部署。V1/V2/V3按原策略读取和兼容复算，不篡改历史包身份。

## 识别优先中云调优（V2.5.4.11，Schema/Policy 3）

```powershell
npm run tuning:practical -- --search-space mid-cloud --baseline-run <V2高云父Run> --model <model-dir> --raw <raw-dir> --gt <gt-dir> --output dataset/practical_tuning
npm run tuning:practical-stats -- --input <本轮run-dir>
npm run tuning:practical-verify -- --input <本轮run-dir>
```

默认且强制累计识别优先，兼容显式 `--recognition-first`。直接父包为指定V2高云结果；原始B0从父 `original_control_config.json` 读取，B1从父 `selected_effective_config.json` 读取。V2父 `rollback_config.json` 是B1，不能当B0。当前B1固定权重与高云60/25，中云40/25；同引擎精确复现父成员、分数、等级和指标后执行，不新增数据、等级支持或资格条件。

只修改评分根 `midCloudCenter/midCloudWidth`，其余全部保留B1。Registry整数范围0–100/1–60；粗搜中心25/30/35/40/45/50/55、宽度15/20/25/30/35/40共42点，再按累计识别优先前两父节点执行±2、重新排序后±1两轮邻域。固定提议顺序、去重、默认80唯一预算，完整计划至多74点；B1计入、B0只作对照。`--max-candidates`只降低预算，不自动扩搜。

累计召回沿用B0：≥2最多下降0.02、≥3不下降，epsilon=1e-12，null不通过；达标且损失严格低于B1才替换。否则KEEP_CONTROL并完成Phase7。距离为abs(center−40)/100+abs(width−25)/59。最低损失点、≥2达底线的最高≥3召回点继续作为对照，不自动改选。

每个有效候选保存B1→候选配对迁移：从预测2找回GT≥3、从预测0/1找回GT≥3、原已识别高等级丢失、新增≥3误报、原有≥3误报消除。每项提供Snapshot数、去重Event数和全池Event归一化加权量；不在迁移子集重新归一化，Event可跨行而不可简单相加。新增误报按实际0/1/2分列。净找回加权量除全池GT≥3支持与≥3召回变化一致。保存于 `paired_migrations.json`、逐点记录和 `candidate_metrics.csv`，最终报告展示最终/最低损失/最高≥3召回三点。统计只作解释，不改变门禁或损失。

`selected_effective_config.json`为最终试用配置，`baseline_config.json/rollback_config.json`均为B1，`original_control_config.json`单独保留B0。无预测4继续PREDICTION_4_NOT_ASSESSED。发布前及独立verify仅Replay B0/B1/最终选择、相同配置去重；全候选保存的逐样本分数支持指标和迁移复核，不重搜。stats校验产物后只读。旧V1权重/V2高云策略保持，当前兼容工具须同引擎、旧策略及原分数/指标/选择精确一致，并披露原/当前工具Hash；新发布仍要求当前工具Hash完全匹配。

身份绑定模式、父Run、B0/B1、固定池、代码/引擎和计划；`--resume`只恢复同spec，变化另建Run。源包与父Run不覆写。计划/预算结束即停止，无改善保留B1；不自动扩大中云范围、联调高云、重开权重或上线。现有分区均属复用开发数据，不称独立TEST；检查具体压分机制属于后续决策。

## 识别优先高云调优（V2.5.4.10，Schema/Policy 2）

```powershell
npm run tuning:practical -- --search-space high-cloud --baseline-run <识别优先权重父Run> --recognition-first --model <model-dir> --raw <raw-dir> --gt <gt-dir> --output dataset/practical_tuning
```

高云模式默认强制识别优先，省略 `--recognition-first` 也不回落到最低损失选参。父 Run 必须为 Schema/Policy 1 识别优先权重结果：显式以其 `rollback_config.json` 为原始 B0、`selected_effective_config.json` 为本轮 B1。不读取在线配置替代 B1，不使用第一轮召回坍缩的最低损失权重。预检必须在同一引擎精确复现父 Run 成员、B0/B1 分数、等级及原指标，不能通过删样本解决差异。

固定 B1 权重与其余参数，只调评分根 `highCloudCenter`、`highCloudWidth`，合法整数范围分别 0–100、1–60；不会修改走廊模块同名字段。中心为 45/50/55/60/65/70/75、宽度为 15/20/25/30/35/40，42 点粗网格含 B1 60/25；再按识别优先前两父节点执行 ±2、±1 两轮笛卡尔邻域。全程去重，默认预算 80、正常至多 74 唯一组合；B0 只作锚点，不计搜索预算。`--max-candidates` 可降低成本，不扩大搜索空间。

底线固定参照 B0：≥2 召回最多累计下降 0.02、≥3 不下降，null 不视为满足；不是每轮再放宽 0.02。达标后按产品损失、4→0/1、≥3/≥2 召回、MAE、归一参数距离和 ID 排序，epsilon=1e-12。父节点优先达标，不足两点可补有效未达标点探索，但最终只有达标且损失严格低于 B1 才替换；否则 KEEP_CONTROL，Control 明确指 B1，仍完成 Phase 7。

新 Run 使用 `practical_tuning_v2_` 身份，绑定父 Run/候选/Manifest、B0/B1 Hash、固定成员、代码/引擎、搜索计划及累计召回策略。已有权重模式、Schema/Policy 1 产物均保持读取。旧 V1 verify 在相同引擎和策略下可用当前兼容工具重算原逐样本及汇总，明确记录旧/当前工具 Hash；不会冒称归档旧工具环境。引擎或旧指标不一致仍报错。新 Run 发布前继续要求当前代码指纹一致。

V2 报告和 `comparison.json` 给出 B0/B1/B2、混淆矩阵、实际/预测支持、4→0/1 与 4→2 及其他原指标；`slices.json` 给出日期/城市/提前量/天气型/采集时段三方对照，只诊断、不增资格门槛。所有候选保留完整同样本结果，失败整点 ERROR。额外展示未选中最低损失点及“≥2 达底线、≥3 召回最高”的折中点，不自动改选。

`baseline_config.json` 和 `rollback_config.json` 均为 B1（回退本轮）；B0 独立保存在 `original_control_config.json`。`selected_effective_config.json` 为最终完整配置，KEEP_CONTROL 也导出。任何配置都不自动声称是当前线上配置，不自动部署。

发布前及显式 verify 都只在新进程复算 B0、B1、最终选择，相同配置去重；不重复全部搜索。源数据及父 Run 不覆写；沿用同 spec 恢复、变更创建新 Run、原子完成和一条轻量使用记录。开发池已复用原所有分区，不称独立 Final TEST；不要求新观测时间字段、额外数据或旧 Phase 8 才完成。

## 识别优先局部调优

在原 run 命令添加 `--recognition-first`：保留原默认模式，另建含识别策略身份的新 run。新模式要求 ≥2 召回相对 Control 最多下降 0.02、≥3 召回不下降，然后在满足者中最小化产品损失；未知召回不视为通过。无符合目标的改善则 KEEP_CONTROL，仍完成 Phase 7。

最多100个唯一向量，只评估Control、已发现的平衡/识别种子、与Control各取一半的全非零对照，然后按识别优先的前三个父节点执行0.05/0.025权重转移。没有126点全网格；`--max-candidates`可以再降低预算。天气型乘数、强度、weather下限和评分公式保持原样。`phase7_result.json`包含 `selection_mode=RECOGNITION_FIRST` 与冻结 `recognition_policy`，`run_spec.json`身份绑定此规则；旧结果不覆写。

```powershell
npm run tuning:practical -- --recognition-first --model <model-dir> --raw <raw-dir> --gt <gt-dir> --output dataset/practical_tuning
```

最终只独立复算Control与选中配置；完整记录其他点的成绩和严重高估，自动导出不等于上线。

目标是完成一次个人项目调优和 Phase 7：对比新旧配置、明确选择、交付可试用配置。无需 Campaign、旧 Phase 5 READY、Runtime Bundle、独立盲集、最低等级支持或 Bootstrap 显著性。旧正式工具及其规则保持原样，本入口使用独立 Practical Tuning Schema/Policy 1。

```powershell
npm run tuning:practical -- --model <model-dir> --raw <raw-dir> --gt <gt-dir> --output dataset/practical_tuning
npm run tuning:practical-stats -- --input <run-dir>
npm run tuning:practical-verify -- --input <run-dir>
```

默认合并匹配 Model 的 TRAIN、VALIDATION、TEST 有标签 PRIMARY 样本。TEST 使用后即属于开发使用，记录为 REUSED_DEVELOPMENT_DATA，不能再称独立盲验。只追加输出根下的一条 `usage_history.jsonl` 记录，不要求全历史资格证明。输入包不修改、不重导出。逻辑开发池按 snapshot_id 去重，内容或 Event 标签冲突报输入错误；GT 状态和 confidence 不重标。Control 预检形成固定可用 cohort，Event confidence 按实际纳入 Snapshot 数重分。历史 Reference 分数不同只报告，不自动剔除。

只修改五个成员 `skyCanvas/horizon/illumination/atmosphere/weather`，基础权重非负且和为 1，规范化至 12 位；范围遵守当前 Registry。天气型乘数、weather 动态下限、其余配置、评分公式和 20/40/60/90 阈值均保持 Control。`wiring_audit.json` 保存实际动态权重和 P 的 trace。先执行空向量复现与合法扰动检查；完全无效果时输出 WEIGHTS_NOT_EFFECTIVE，保留 Control 并完成解释报告。

默认最多 500 个唯一向量（接线探针、Control 均计入），执行全部 126 个步长 0.20 粗网格，再按当前前 5 组分别做 0.10/0.05/0.025 成员间转移各一轮。非法、重复、失败、预算均留痕。`--max-candidates N` 可降低成本（1–500）；预算结束不等于业务失败，不声称穷尽连续空间。候选失败整点 ERROR，其他候选继续；不按候选失败删行。

排序使用冻结的 V2.5.4.8 产品损失、4→0/1 风险、≥3 召回、≥2 召回、MAE、相对 Control 距离、ID；epsilon=1e-12，null 最后。常量、支持度、QWK/Bias/Slice 退化都是对照信息，没有新增资格硬门禁。无预测 4 时条件比例/精确率为 null、NOT_ASSESSED。

Phase 7 总是明确选择：有改善且无报告退化/缺证据为 SELECTED_IMPROVED；有改善但有取舍为 SELECTED_WITH_TRADEOFFS；无严格损失改善为 KEEP_CONTROL。三者均 phase7_completed=true 并导出完整配置；数据不可用、非法配置或最终复算不一致才 EXECUTION_ERROR。可选“保留等级识别的折中点”只从已评估点中选，不阻断最优损失点。严重 4→0/1 风险在报告首屏显示。

产物包含 `run_spec.json / pool_manifest.json / exclusions.json / control_config.json / candidate_metrics.csv / top_candidates.json / selected_candidate.json / selected_effective_config.json / rollback_config.json / selected_predictions.csv / phase7_result.json / report.md`；另有完整逐点指标/矩阵、搜索审计、日期/城市/提前量/时段配对切片、接线 trace、历史分数差异、最终复算和缓存统计。完整试用配置为 scoring 根对象（含 `weights`），Replay 调用时使用现有 `buildModelConfig` 恢复生产别名；不会自动写入生产配置或部署。

搜索结束后仅在新 Node 进程复算 Control 和选中配置，逐 Snapshot 分数/等级/汇总比对；不重复全部搜索。显式 verify 也只执行这两个配置。代码、输入、策略、完整配置指纹绑定 run_spec 和纯 Replay 缓存；工作区可 dirty，但代码/输入变化创建新 run，不复用旧预测。stats 只校验和读取输出，不重算、不追加历史。

中断状态保留在 `<output>/.work/<run-id>`；以原参数加 `--resume` 恢复相同 spec，已完成候选直接复用。活动 PID 不抢锁；被强杀进程确认已退出后可由 resume 恢复它的锁，不按时间猜测。目录原子完成后进入 `<output>/<run-id>`，相同 spec 已完成则返回原结果。输出不与任何输入包重叠。轻量根独立于旧 Optimization/Validation 的正式产物目录，不借旧 FORMAL_VALIDATION 或 Phase 8 字段声明通过。
