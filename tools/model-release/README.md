# V2.5.5.1 关闭天空演化发布验收

当前 app/model/config.version 为 2.5.5.1，assetRevision=app2551，npm package 仍为 2.5.5。相对 V2.5.5.0 唯一的评分改动是 `skyState.factorRange` 由 [0.65, 1.15] 改为 [1, 1]，天空演化因子恒为 1；状态机照常判定，仅作描述。

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
