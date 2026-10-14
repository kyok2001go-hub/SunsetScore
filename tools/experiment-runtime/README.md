# 实验 Runtime 与执行恢复

协议 1 将 Engine Runtime、Evaluator Implementation、Node/平台/架构、依赖锁和源码库存分别绑定。快照保存原始字节，评分 Runtime Hash 沿用旧算法；Git 提交只作证据，脏工作区不会被标为 clean。当前用途固定为 DEVELOPMENT_ONLY。

在应用根目录执行：

```powershell
npm run experiment-runtime:freeze -- --output dataset/experiment_runtime
npm run experiment-runtime:freeze -- --source-root ../.tmp/restored-source --output dataset/experiment_runtime
npm run experiment-runtime:verify -- dataset/experiment_runtime/exports/<bundle-id>
```

源码白名单为 `js/` 顶层 JavaScript、`tools/` 和 `server/` 的 JS/MJS/CJS、package.json 与 package-lock.json。逐项绑定字节数和 SHA256，并检查静态本地导入及已声明外部依赖。不复制 node_modules、私密配置、数据包或日志。评分模块的动态加载清单继续由既有 Runtime import graph 门禁验证。

Phase 5–7 的 readiness/plan/run/validate/candidate 命令支持 `--runtime-bundle <bundle-dir>`；stats 不需要执行快照。示例：

```powershell
npm run validation:validate -- dataset/validation/exports/<result-id> --runtime-bundle dataset/experiment_runtime/exports/<bundle-id> --model <model> --raw <raw> --gt <gt> --baseline <baseline> --sensitivity <sensitivity> --optimization <optimization>
```

入口验证快照和精确 Node/平台/架构，转换调用者的相对输入路径，然后在独立 Node 进程执行归档工具。写命令默认输出显式绑定调用者的应用 dataset，禁止写入快照。子进程仅继承 PATH、系统和临时目录变量及本次 bundle 摘要，不继承密钥或 NODE_OPTIONS。这是逻辑隔离，不是操作系统沙箱。当前离线执行路径仅需要 Node 内置模块；不联网安装依赖，不在快照中安装依赖。引入实际需要外部包的计算路径时，须补充独立执行目录的锁定安装与验收。

执行收据位于 `experiment_runtime/executions/exports/`，绑定快照、六源 Manifest、结果身份与验证级别。Validation 的 PACKAGE_INTERNAL / MODEL_LINKED 使用快照时仍不产生收据或披露账本写入；完整六源 Verify 追加审计。归档的旧 Validation Run 若缺少预发布门禁，或完整 Verify 缺少审计协议，明确拒绝；可恢复匹配的 Engine/Registry 后使用治理工具重新冻结，但收据必须承认 Evaluator 已升级。

历史恢复不得改旧 Plan / Manifest / Hash。先核对实际源码字节是否符合已知 Engine 和 Registry 摘要；只有 Git 提交或看似相同的代码不够。无法恢复原始工具时记录缺失事实，不宣称恢复了完整原始执行环境。

快照、收据接入 dataset:lineage / dataset:prune。跨根执行在被引用根保存保守维护保护；单根扫描无法证明外部闭包时拒绝自动清理。保护记录不会按时间自动消失，账本不随计算包删除。

## Protocol 2

新增 `npm run experiment-runtime:freeze -- --protocol-version 2`。Protocol 1 的 DEVELOPMENT_ONLY 语义保持不变；Protocol 2 归档正式契约实现，标记 FORMAL_EXECUTION_CAPABLE，并支持 Evaluation、语义准备和 Campaign 命令。它不代替人工复核或干净提交的历史 build 证明。正式执行同时校验实际执行的 Evaluator 源库存，不能只证明 Engine。

所有写命令、正式 TRAIN 访问审计及计划命令的输出/账本显式指向宿主目录；命令不得在归档源码下创建 dataset。Validation Policy 3 的发布前重算从绑定的执行根启动新的归档 Worker 进程，返回全部文件 SHA256/bytes 和 manifest 做精确比较，避免内嵌证据字节造成 stdout 超限。旧 Policy 的重算和校验契约保持不变。
