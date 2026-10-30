# V2.5.5.4 地平线中心节点方位修正发布验收

当前 app/model/config.version 为 2.5.5.4，assetRevision=app2554，npm package 仍为 2.5.5。相对 V2.5.5.2 的评分改动只有一处：

- `spatialField.centerAzimuthOffset: 0`：走廊中心节点补齐方位偏移，horizon 的 ±30° 云幕区与中心点恢复生效，云幕对比度与空间梯度同步使用有效偏移（`js/engine.js` 的 `offsetFor`）。等级分数线与黄金窗口不变。

```powershell
npm run model:release -- prepare '../.tmp/<任务名>/release_out' --raw <DEV raw目录> --gt <DEV gt目录> --model <DEV model目录>
```

- **数据来源：** V6 Run 记录的是另一台机器上的绝对路径。本机不存在时，用 `--raw/--gt/--model` 指向本地的同一批包（三者须同时给出）；读入后仍须与 V6 的输入指纹逐字节一致，否则报 `RELEASE_INPUT_MISMATCH`。
- **配置核对：** 以 V6 selected 配置为来源，只允许十处差异：版本、三个已证明默认等价的字段、`skyState.factorRange`、V2.5.5.2 的四个键，以及 `spatialField.centerAzimuthOffset`。
- **前版本复现：** `v2552Scoring()` 从生产配置去掉修正键得到 2.5.5.2，再按 `previousReleaseScoring()` 得到 2.5.5.1。DEV 655 条上，2.5.5.1 签名须等于 SC-SKY-OFF 的 `c7c40b45…`；2.5.5.2 的签名、产品损失与相对 2.5.5.1 的变化数须等于 `V2552_REFERENCE`。
- **本期结果：** 2.5.5.4 按 22/47/66/90 判级，签名、产品损失与相对 2.5.5.2 的变化数须等于 `V2554_REFERENCE`（`e5102d75…`，损失 0.987673889961，323 条分数、28 条等级变化），该参照来自 Policy 10 的 DEV 评估。
- **重建一致性：** `holdout.mjs` 的 `releaseConfigs()` 用同样方式重建 2.5.5.0 / 2.5.5.1 / 2.5.5.2，并核对"2.5.5.2 加回修正键"与生产配置完全相同。
- **结论范围：** 只证明发布配置与已评估配置一致，属于复用开发数据，不是独立 TEST。

需求与发布 / 回退步骤见 [V2.5.5.4 PRD](../../../ref_docs/PRD/V2.5.5.4--地平线中心节点方位修正方案.md)。以下依次为 V2.5.5.2、V2.5.5.1 与 V2.5.5.0 的原说明，保留作历史记录。

## V2.5.5.2 黄金窗口与等级分数线发布验收（历史）

当时 app/model/config.version 为 2.5.5.2，assetRevision=app2552，npm package 仍为 2.5.5。相对 V2.5.5.1 的评分改动：

- 黄金窗口开放阈值 `evolution.openCoverageThreshold` 20→35，`evolution.satelliteOpenThreshold` 25→40；
- 黄金窗口因子以 1 为中心：`goldenWindow.reference` 为 0.826654，因子 = (floor + (1−floor)·P_open) / reference，限幅为 [floor, 1] / reference；
- 等级分数线 `levels` 改为 90/66/47/22/0。

```powershell
npm run model:release -- prepare '../ref_docs/Dev_version_record/V2.5.5.2发布证据'
```

- **配置核对：** 仍以 V6 selected 配置为来源，只允许九处差异：版本，三个已证明默认等价的字段，`skyState.factorRange`，以及本期的四个键。
- **前一版本复现：** 用发布配置撤回本期四处改动，重建 V2.5.5.1 配置；DEV 655 条按 20/40/60/90 判级，签名必须等于 SC-SKY-OFF 的 `c7c40b45…`，产品损失 1.034929907064。
- **本期结果：** 655 条按配置自身的分界（22/47/66/90）判级，签名、产品损失与相对 V2.5.5.1 的变化条数必须等于 `V2552_REFERENCE`（`2404453e…`，损失 0.990135853225，388 条分数、186 条等级变化）。该参照首次由本工具产生，并与黄金窗口离线诊断逐条交叉核对：只有 5 条因 GW 因子取三位小数相差 ±1 分。
- **等级分界：** 发布配置的 `levels` 必须与 `tools/evaluation/metrics.mjs` 中为 2.5.5.2 登记的分界一致。
- **结论范围：** 只证明发布配置与已测配置一致，属于复用开发数据，不是独立 TEST。

需求与发布 / 回退步骤见 [V2.5.5.2 PRD](../../../ref_docs/PRD/V2.5.5.2--黄金窗口与等级划线校准方案.md)。以下为 V2.5.5.1 与 V2.5.5.0 的原说明，保留作历史记录。

## H1 前向留出核验（`holdout.mjs`）

Policy 3（2026-10-30 起：项目负责人在只看过标签数量、未计算任何预测的情况下，把 GT≥3 门槛从 10 降到 8；Policy 1、2 从未执行）比较 2.5.5.0 / 2.5.5.1 / 2.5.5.2 / 2.5.5.4。四个配置都由当前生产配置重建：2.5.5.1 撤回 V2.5.5.2 的四处改动，2.5.5.0 再恢复天空演化区间 [0.65, 1.15]，并核对它与 V6 selected 只差已证明默认等价的字段；2.5.5.4 为 2.5.5.2 加 `spatialField.centerAzimuthOffset: 0`（地平线中心节点方位修正，2026-10-28 起为生产配置；按上文从生产配置反向重建 2.5.5.2）。各版本按自身等级线判级。

```powershell
npm run model:holdout -- status --raw <Raw 包> --gt <GT 包> --model <Model 包> [--policy H2]
npm run model:holdout -- check  --raw <Raw 包> --gt <GT 包> --model <Model 包> --output <仓库外目录> [--policy H2]
```

- **`status`：** 只统计标签，不计算任何预测，可以反复运行。报告与 DEV 是否独立（日期须在 2026-10-13 及以后，Snapshot 与 Event 不得出现在 V6 开发池中），以及是否达到门槛：15 天、100 个 Event、GT≥2 Event 25、GT≥3 Event 8。
- **`check`：** 不独立或未达门槛时直接失败。通过后用当前引擎重算四个版本，输出：
  - `holdout_result.json`：各版本的产品损失、≥2 / ≥3 召回与精确、最近一条的 AUC≥2 / AUC≥3；三组比较的点差值、按日期整块抽样（2000 次）的 95% 区间与变好的概率；是否触发回退规则；
  - `holdout_predictions.csv`、`holdout_inputs.json`、`report.md`。
- **只能用一次：** 每个策略版本只允许一次 `check`，记录写入 `dataset/holdout/usage.jsonl`。
- **回退规则：**
  - 2.5.5.1 对 2.5.5.0：AUC≥3 不更高，或产品损失更高；
  - 2.5.5.2 对 2.5.5.1：产品损失更高，或 ≥2 召回下降超过 0.05；
  - 2.5.5.4 对 2.5.5.2：同上规则（不发布，或已发布则回退）。

  工具只给出"建议回退 / 不触发"，最终由项目负责人决定。

## H2 前向留出核验（`--policy H2`，V2.5.5.11）

确认等级分数线 19/49/66/90（V2.5.5.11）。比较 2.5.5.4 与 2.5.5.11，两者分数相同，只差分界。

- **数据：** Event 日期 2026-10-30 及以后；新线只用到 10-29 之前的数据，所以这批数据是独立的。门槛为 15 天、100 个 Event、GT≥2 Event 25、GT≥3 Event 8。
- **回退规则：** 2.5.5.11 对 2.5.5.4 的产品损失差值 95% 区间下限 > 0，或 2.5.5.11 的 ≥2 召回 < 0.60。工具只给建议，由项目负责人决定。
- **只能用一次：** 与 H1 分开记录在 `dataset/holdout/usage.jsonl`。

需求见 [V2.5.5.11 PRD](../../../ref_docs/PRD/V2.5.5.11--等级分数线重新校准方案.md)。

## V2.5.5.1 关闭天空演化发布验收（历史）

V2.5.5.1 的 app/model/config.version 为 2.5.5.1，assetRevision=app2551，npm package 仍为 2.5.5。相对 V2.5.5.0 唯一的评分改动是 `skyState.factorRange` 由 [0.65, 1.15] 改为 [1, 1]，天空演化因子恒为 1；状态机照常判定，仅作描述。

```powershell
npm run model:release -- prepare '../ref_docs/Dev_version_record/V2.5.5.1发布证据'
```

- **配置核对：** 仍以 V6 `practical_tuning_v6_7afed8a39cb7ddfc8d4c` 的 selected 配置为来源。运行配置相对它只允许五处差异：版本，三个已证明默认等价的字段，以及 `skyState.factorRange`。
- **结果核对：** DEV 655 条共享 Replay 要求每条的天空演化因子为 1，且整体预测签名等于 V2.5.6 对同一配置（AB-SKY / SC-SKY-OFF）记录的签名 `c7c40b45…`。同时核对相对 V2.5.5.0 有 600 条分数、147 条等级变化，产品损失 1.034929907064。
- **结论范围：** 只证明发布配置与已测配置一致，属于复用开发数据，不是独立 TEST。

需求与发布 / 回退步骤见 [V2.5.5.1 PRD](../../../ref_docs/PRD/V2.5.5.1--关闭天空演化发布方案.md)。以下为 V2.5.5.0 的原说明，保留作历史记录。

## V2.5.5.0 已选参数发布验收（历史）

当前 app/model/config.version 均为 2.5.5.0，assetRevision=app2550；npm package/lock 使用合法 SemVer 2.5.5。评分参数不变。原 V2.5.5.0发布证据/ 对应已部署的 app 2.4.6／model 2.5.5.0，请保留原制品、线上与回退记录，新一轮验证使用单独目录。

在应用根目录执行：

```powershell
npm run model:release -- prepare '../ref_docs/Dev_version_record/V2.5.5.0版本统一证据'
```

该命令只在本地核验并准备制品，不提交、推送、部署、访问气象服务或写入云端数据。固定读取 V6 `practical_tuning_v6_7afed8a39cb7ddfc8d4c`，重新校验 selected 原始字节 SHA-256；加载真正的 `config.js` / `model_config.js`，核对别名和严格列举的四处版本／默认等价字段差异。然后使用原有 655 个成员与输入执行共享 Replay，以逐条整数分数、等级和原指标完全相等为通过条件，不重新搜索、不改 Raw/GT/Model。

输出分开保存 selected 文件 Hash、运行 scoring 配置 Hash、实际 Replay capture 序列化的完整 effective_config Hash；三者范围不同。`release_predictions.csv`、`release_comparison.json`、`source_provenance.json`、`release_code_identity.json` 提供追溯。命令返回的局部通过状态仍待全量测试、历史复算和真实回退材料，不能单凭该返回值宣称 READY 或已部署。

`release_artifact/` 仅复制 `index.html`、`_headers`、`package.json`、`package-lock.json` 及 `admin/css/js/functions/server` 五个运行目录，并检查 Functions/server 本地导入及 `jose` 依赖；逐文件 Hash 在 `release_artifact_manifest.json`。输出拒绝与应用源码树重叠，已有制品目录出现白名单外文件也拒绝。不把整个工作树、旧源码归档、dataset 或证据目录用作静态上传目录。Cloudflare 安装依赖时使用制品中的 package/lock；制品清单不含安装后生成的 node_modules。

完整本期结论与部署／回退步骤见 [实施记录](../../../ref_docs/Dev_version_record/2026-10-21_V2.5.5.0已选参数发布与一致性验收.md) 和 [PRD](../../../ref_docs/PRD/V2.5.5.0--已选模型参数发布与一致性验收方案.md)。生产提交／推送／部署须按 PRD 获得明确授权；本地验收不能替代线上查询、正常采集或独立 TEST。

Git→Pages 构建独立使用 `node scripts/stage-pages.mjs`，仅需 Node 内置模块，固定写入被 Git 忽略的 `artifacts/pages`，拒绝输出中存在白名单外文件；不读取 dataset、不调用本页的 655 条验收、不部署。已验证该输出 68 文件逐字节等于已审阅制品。首次发布准备时核对云端为根目录输出；当时计划使用构建命令 `npm ci --omit=dev && node scripts/stage-pages.mjs`、输出 `artifacts/pages`，root 与绑定保持。精确差异和执行顺序保存于 `pages_build_plan.json`，该记录保留首次准备时状态。用户后续已自行部署，本轮未读取或调整 Cloudflare 构建设置；版本统一沿用现有发布流程。
