# V2.5.5.0 已选参数发布验收

在应用根目录执行：

```powershell
npm run model:release -- prepare '../ref_docs/Dev_version_record/V2.5.5.0发布证据'
```

该命令只在本地核验并准备制品，不提交、推送、部署、访问气象服务或写入云端数据。固定读取 V6 `practical_tuning_v6_7afed8a39cb7ddfc8d4c`，重新校验 selected 原始字节 SHA-256；加载真正的 `config.js` / `model_config.js`，核对别名和严格列举的四处版本／默认等价字段差异。然后使用原有 655 个成员与输入执行共享 Replay，以逐条整数分数、等级和原指标完全相等为通过条件，不重新搜索、不改 Raw/GT/Model。

输出分开保存 selected 文件 Hash、运行 scoring 配置 Hash、实际 Replay capture 序列化的完整 effective_config Hash；三者范围不同。`release_predictions.csv`、`release_comparison.json`、`source_provenance.json`、`release_code_identity.json` 提供追溯。命令返回的局部通过状态仍待全量测试、历史复算和真实回退材料，不能单凭该返回值宣称 READY 或已部署。

`release_artifact/` 仅复制 `index.html`、`_headers`、`package.json`、`package-lock.json` 及 `admin/css/js/functions/server` 五个运行目录，并检查 Functions/server 本地导入及 `jose` 依赖；逐文件 Hash 在 `release_artifact_manifest.json`。输出拒绝与应用源码树重叠，已有制品目录出现白名单外文件也拒绝。不把整个工作树、旧源码归档、dataset 或证据目录用作静态上传目录。Cloudflare 安装依赖时使用制品中的 package/lock；制品清单不含安装后生成的 node_modules。

完整本期结论与部署／回退步骤见 [实施记录](../../../ref_docs/Dev_version_record/2026-10-21_V2.5.5.0已选参数发布与一致性验收.md) 和 [PRD](../../../ref_docs/PRD/V2.5.5.0--已选模型参数发布与一致性验收方案.md)。生产提交／推送／部署须按 PRD 获得明确授权；本地验收不能替代线上查询、正常采集或独立 TEST。

Git→Pages 构建独立使用 `node scripts/stage-pages.mjs`，仅需 Node 内置模块，固定写入被 Git 忽略的 `artifacts/pages`，拒绝输出中存在白名单外文件；不读取 dataset、不调用本页的 655 条验收、不部署。已验证该输出 68 文件逐字节等于已审阅制品。实际云端当前仍为根目录输出；拟授权修改为构建命令 `npm ci --omit=dev && node scripts/stage-pages.mjs`、输出 `artifacts/pages`，root 与绑定保持。精确差异和执行顺序保存于 `pages_build_plan.json`，当前未应用。
