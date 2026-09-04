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
