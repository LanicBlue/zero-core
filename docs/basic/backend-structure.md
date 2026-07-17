# 后端结构

> 本文描述当前已接线的后端，而不是 `docs/plan/` 中的目标架构。

## 桌面模式进程拓扑

```text
React renderer
    │ window.api / Electron IPC
    ▼
Electron main ── HTTP ──► Node backend (Express)
      ▲                       │
      └──── IPC events ◄─ WS ─┘
```

1. `src/main/index.ts` 在 `app.whenReady()` 后调用 `spawnBackend()`。
2. 开发模式由系统 `node dist/backend.js --port=0` 启动后端；打包模式由 Electron `fork()`。
3. `src/backend.ts` 调用 `startServer({ port: 0, serveStatic: false })`，再用 stdout JSON 行报告实际端口。
4. 主进程注册 IPC 代理并连接后端 `/ws`，最后把事件送给 renderer。
5. 后端异常退出时主进程指数退避重启；超过窗口内上限后停止自动重启并显示错误。

主进程不持有 SQLite Store 或 AgentService。除窗口、目录选择、登录窗口等本地能力外，桌面业务请求都应经过本地后端。

## 后端入口

| 入口 | 接线情况 |
| --- | --- |
| `src/backend.ts` | Electron 后端子进程的正式入口，支持随机端口和 stdin 优雅关闭协议 |
| `src/server/index.ts` | `startServer()` 的服务组合根 |
| `src/serve.ts` | 独立服务入口，默认端口由 `PORT`/配置决定；当前没有 npm `serve` script |
| `src/cli.ts` | 终端 Agent 入口；只初始化会话数据库等必要依赖，不等价于完整桌面后端 |

`npm run build:lib` 会把这些入口编译到 `dist/`。README 中不应使用不存在的 `npm start` 或 `npm run serve`。

## `startServer()` 负责什么

`src/server/index.ts` 是当前组合根，主要职责包括：

- 创建 Express、HTTP server 和 `/ws` WebSocket server。
- 创建 `SessionDB`，运行数据库迁移。
- 清理崩溃后残留的 delegated task、归档状态和旧 Memory 磁盘目录。
- 构造 Agent、Provider、Template、Project、Requirement、Cron、Wiki、输入队列等 Store/Service。
- seed 内置 Skill 和默认工作流数据。
- 扫描未完成会话并调度恢复。
- 挂载 `/api/*` 路由和健康检查。
- 可选托管 `out/renderer/` 静态资源。

具体路由清单以 `src/server/index.ts` 中的 `app.use()` 为准。文档不维护容易漂移的“总路由数”或“总 IPC 数”。

## 请求与事件

### 桌面请求

```text
component/store
  → window.api
  → preload ipcRenderer.invoke
  → main ipc-proxy
  → backend /api/*
  → router → service/store
  → JSON response 原路返回
```

### 实时事件

```text
AgentLoop / server data change
  → AgentService / DataChangeHub
  → backend WebSocket
  → main event bridge
  → webContents.send
  → preload subscription
  → AppLayout 或领域 store/component
```

事件不是全部集中在 `AppLayout`：会话级 Agent 事件主要在那里分发，但数据同步、任务、Wiki、Dashboard 和部分领域页面也有各自的订阅。新增订阅必须返回并调用 unsubscribe。

## Agent 运行时接线

- `AgentService` 负责构造主会话的 `SessionConfig`、Provider、工具能力句柄和 HookRegistry。
- `AgentLoop` 负责模型 step、流式事件、工具调用和 turn 收尾。
- `src/tools/index.ts` 根据 Agent 的 tool policy 构建有效工具集，并合并外部 MCP 工具。
- `registerHooksForLoop()` 区分 main 与 delegated loop：持久化/Provider/压缩等 Hook 共享，输入队列与指标只用于 main，task-control 只用于 delegated。
- 当前压缩核心在 `src/server/compression-core.ts`，触发器在 `src/runtime/hooks/compression-trigger-hooks.ts`；旧 extraction/compression Hook 文档不再适用。

## 持久化边界

默认数据根为 `~/.zero-core`：

- `sessions.db`：主 SQLite 数据库。
- `wiki/`：Wiki 文档镜像。
- `attachments/`：会话附件。
- `archives/`：会话归档 JSON。
- `tool-outputs/`：超过阈值的大工具结果。
- `skills/`：zero-core 可写 Skill。
- `projects/`：需求/工作流 worktree。
- `logs/`：运行日志。

Store 并非全部挂在 `SessionDB` 对象上；大量领域 Store 在 `startServer()` 中独立构造，但共享数据库句柄。修改 schema 时应同时检查 `session-db.ts`、`db-migration.ts` 和对应 `*-store.ts`。

## 边界规则

- renderer 不直接 import `src/server`、`src/runtime` 或 `better-sqlite3`。
- main 不重新实现后端业务逻辑；能走 REST 的能力通过代理接入。
- runtime 通过接口、SessionConfig 闭包或注入句柄访问持久化/领域能力，不自行打开数据库。
- 新领域端点需要同时考虑 REST、IPC/preload、实时变更事件和测试契约。
