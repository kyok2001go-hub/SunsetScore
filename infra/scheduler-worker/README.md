# SunsetScore Scheduler Worker

Cloudflare Worker 定时调度器（V2.4.2），用于替代 GitHub Actions 原生 `schedule`，提供高可靠、准时的定时触发能力。

---

## 架构职责

```text
Cloudflare Cron (UTC)
    ↓ triggers (13 4 * * *, 13 8 * * *)
sunsetscore-scheduler (Worker)
    ↓ 计算 scheduledTime -> Asia/Shanghai HHMM (e.g. 1213, 1613)
    ↓ POST /repos/kyok2001go-hub/SunsetScore/actions/workflows/pre-sunset-metadata.yml/dispatches
GitHub Actions (workflow_dispatch)
    ↓ inputs: { submit: true, cities: "", run_type: "scheduled", slot: "1213" }
Playwright 采集并提交
    ↓ POST /api/snapshot
D1: prediction_snapshots
```

- **Cloudflare 负责准时调度**：通过 Cloudflare Cron Triggers 触发 Worker。
- **Worker 负责时段计算**：通过 `scheduledTime` 精确换算为上海时间 4 位槽位（HHMM），作为 `slot` 传给 GitHub。
- **GitHub Actions 负责执行采集**：接收 Worker 传入的明确 `slot` 和 `run_type: scheduled`，执行采集并上报。
- **唯一生产定时来源**：任务计划时间仅在 `infra/scheduler-worker/wrangler.jsonc` 维护，后续调整定时仅需修改该文件。

---

## 目录结构

```text
infra/scheduler-worker/
├── src/
│   └── index.js        # Worker 入口与 dispatch 逻辑
├── wrangler.jsonc      # 生产 Cron 触发配置与 Worker 配置
└── README.md           # 部署与配置文档
```

---

## 定时配置 (`wrangler.jsonc`)

当前生产 Cron 配置（UTC 时间）：
- `13 4 * * *` -> 对应北京时间 12:13（SLOT: `1213`）
- `13 8 * * *` -> 对应北京时间 16:13（SLOT: `1613`）

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "sunsetscore-scheduler",
  "main": "src/index.js",
  "compatibility_date": "2026-09-04",
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },
  "triggers": {
    "crons": [
      "13 4 * * *",
      "13 8 * * *"
    ]
  }
}
```

---

## 部署与环境变量配置

### 1. 创建 GitHub Fine-grained PAT
1. 进入 GitHub -> Settings -> Developer Settings -> Personal Access Tokens -> Fine-grained tokens。
2. 目标仓库选择：`kyok2001go-hub/SunsetScore`。
3. 权限配置：`Repository permissions` -> `Actions` 设置为 **Read and write**。
4. 生成并复制 Token。

### 2. 在 Cloudflare 中配置 Secret
1. 在 Cloudflare Dashboard 中创建或打开 Worker `sunsetscore-scheduler`。
2. 进入 **Settings** -> **Variables and Secrets**。
3. 新增 Secret 变量名为 `GITHUB_TOKEN`，值为上述 Token。
4. **安全警告**：切勿将真实 Token 提交到 Git 仓库、`wrangler.jsonc`、日志或文档中！

### 3. 连接 Git 自动部署
- Repository: `kyok2001go-hub/SunsetScore`
- Root directory: `infra/scheduler-worker`
- Build command: 留空
- Deploy command: `npx wrangler deploy`

> Root directory 必须指向 `infra/scheduler-worker`。如果错误设置为仓库根目录 `/`，Wrangler 可能把整个仓库及 `node_modules` 识别为静态资源并因超大文件导致部署失败。

---

## 日常运维

### 修改正式执行时间

Cloudflare Cron 使用 UTC。正式时间只修改 `wrangler.jsonc` 的 `triggers.crons`，然后提交并推送 GitHub，由 Cloudflare 自动重新部署。例如北京时间 18:00 对应 UTC 10:00，表达式为 `0 10 * * *`。

不要把 Dashboard 中手工添加的 Cron 作为长期配置；下一次 `wrangler deploy` 会以 `wrangler.jsonc` 为准。Cron 新增、修改或删除后最多可能需要约 15 分钟传播。

### 本地打包检查

在本目录运行：

```powershell
npx --yes wrangler@latest deploy --dry-run
```

当前Worker没有KV、D1、R2或Queue绑定，因此输出`No bindings found`是正常现象；`GITHUB_TOKEN`是部署后在Cloudflare设置的Secret，不会作为普通资源绑定出现在dry-run结果中。

### 查看生产日志

进入Worker的`Observability`页面，点击右上角`实时`（英文界面为`Live`），等待Cron事件后检查：

- `scheduler_dispatch_started`：应包含计划SLOT和命中的Cron；
- `scheduler_dispatch_succeeded`：应包含GitHub返回的2xx状态。

本Worker只导出`scheduled()`，没有公开`fetch()`。点击Dashboard中的“访问”会产生`Handler does not export a fetch() function`，这是预期行为，不代表Cron失败。

### 临时触发验证

可以在Dashboard临时增加测试Cron，但必须按UTC填写，并预留至少15分钟传播时间。该路径会固定以`submit=true`运行，属于真实生产提交；验证后立即删除临时Cron，并根据数据治理需要决定是否保留测试SLOT生成的Snapshot。最终生产触发器应始终与`wrangler.jsonc`一致。

---

## 生产验收记录

2026-09-04已完成一次北京时间17:20（UTC 09:20）的临时Cron端到端验证：Worker成功触发GitHub `workflow_dispatch`，`run_type=scheduled`、业务SLOT=`1720`；GitHub任务实际于`2026-09-04T09:22:37.444Z`开始，耗时165秒，14个默认城市全部`SUBMITTED`。计划SLOT未受实际启动延迟影响。
