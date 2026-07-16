# 后端架构设计

## 适用范围

本文档覆盖 zero-core 后端全部代码：Electron 主进程（`src/main/`）、Agent 运行时（`src/runtime/`）、服务层（`src/server/`）、核心配置与工具注册（`src/core/`）以及 CLI 入口（`src/cli.ts`）。

具体边界：

- **主进程** `src/main/`：Electron 生命周期、窗口管理、IPC handler 注册；不直接持有业务逻辑，业务下沉到 `src/server/`。
- **运行时** `src/runtime/`：Agent 循环、工具执行、Hook、限速、检查点 —— 与传输层无关，既被 IPC 模式（主进程内）调用，也被 server 模式（HTTP/WS）调用。
- **服务层** `src/server/`：持久化 store、HTTP router、业务编排服务（AgentService / LeadService / AnalystService）、MCP 管理、知识库、recovery。
- **核心层** `src/core/`：跨层共享的配置（config / constants）、工具元数据（tool-registry）、Hook 注册表、系统提示词组装、日志。
- **CLI** `src/cli.ts`：终端入口，复用运行时和核心层，不依赖 Electron。
- **共享层** `src/shared/`：跨前后端的类型和 IPC 契约。

不适用：React 渲染层（`src/renderer/`），见 `frontend-guidelines.md`。

## CLI 接入面

CLI 入口在 `src/cli.ts`（构建产物 `dist/cli.js`，`package.json` 的 `bin.zero-core` 指向它），提供终端交互模式，不依赖 Electron、不依赖 HTTP server：

- **启动流程**：解析 argv → 初始化 `CoreDatabase` + 迁移 → 构建 `ToolRegistry` → 加载 config → 从 `ProviderStore` 读 Provider（缺 apiKey 时尝试用 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` 自动补全）→ 构建 systemPrompt → 起 `AgentLoop` + `TerminalAdapter` → 进入 readline REPL。
- **支持的参数**：`--model <id>`、`--provider <name>`、`--workspace <dir>`、`--thinking <none|low|medium|high>`、`--help`。
- **会话内命令**：`/reset` 清空历史、`/exit` `/quit` 退出、`/help` 查看命令。
- **中断处理**：SIGINT 在 busy 时中止当前任务（第二次 SIGINT 强制退出），idle 时直接退出。
- **Provider 解析**：`resolveProviderAndModel` 优先级 = CLI 参数 > config.defaults > 第一个 enabled 且有 apiKey 的 Provider；无可用 Provider 时报错退出。
- **工具策略**：从 `config.toolPolicy` 读 `autoApprove` / `blockedTools` / `executionMode` / `resultMaxTokens`，`readScope` 固定为 `filesystem`。

CLI 不暴露 HTTP 端口，所有交互走 stdin/stdout；如需远程访问请用 `npm run serve` 起服务模式。

## API 接入面

HTTP/WS 服务由 `src/server/index.ts` 的 `startServer()` 创建（`npm run serve`），挂载 Express REST 路由和 WebSocket 服务：

- **REST 路由前缀**：所有业务路由统一在 `/api/*` 下，按 `<entity>-router.ts` 模块组织。

| 路由前缀 | Router 文件 | 职责 |
|---------|------------|------|
| `/api/config` | `config-router.ts` | 应用配置、默认 prompt、工具配置 schema |
| `/api/agents` | `agent-router.ts` | Agent CRUD、会话创建（v0.8 §11.5：原 `/api/agent-tools` 已退役，Agent-as-Tool 映射不再独立路由） |
| `/api/providers` | `provider-router.ts` | AI Provider 配置 |
| `/api/templates` | `template-router.ts` | **16 内置**（12 基础角色 + 4 v0.8 领域专家：Security/UI-UX/Performance/QA）+ 用户模板；另有 1 个工作流角色 `zero` 在 `builtin-role-templates.ts` 单独管理（不进模板画廊） |
| `/api/chat` | `chat-router.ts` | 发起 Agent 会话 / 发消息 |
| `/api/sessions` | `session-router.ts` | 会话历史、消息 |
| `/api/logs` | `log-router.ts` | 运行日志查询 |
| `/api/files` | `file-router.ts` | 工作区文件树读写 |
| `/api/tool-executions` | `tool-execution-router.ts` | 工具调用记录与统计 |
| `/api/mcp` | `mcp-router.ts` | MCP 服务器管理 |
| `/api/kb` | `kb-router.ts` | 知识库管理 |
| `/api/skills` | `skill-router.ts` | Skill 扫描与元数据 |
| `/api/memory-nodes` | `memory-node-router.ts` | 记忆节点查询 |
| `/api/projects` | `project-router.ts` | 项目 + 分析间隔 / 暂停 / 恢复 |
| `/api/crons` | `cron-router.ts` | **v0.8**：cron 定时任务（agent-scoped，非 project-scoped） |
| `/api/requirements` | `requirement-router.ts` | 需求 CRUD + verify / archive / report + Lead pickup / progress |
| `/api/orchestrate` | `orchestrate-router.ts` | **v0.8**：多步编排计划（plans + manifests） |
| `/api/pm` | `pm-handlers.ts` | **v0.8**：PM 子流程 handler（主进程单例 `PmService`，REST 暴露） |
| `/api/project-wiki` | `project-wiki-router.ts` | 项目 wiki 节点（CRUD，磁盘镜像树见 06 §2.5） |
| `/api/wiki` | `wiki-router.ts` | **v0.8**：wiki 浏览路径（archivist scope） |
| `/api/archivist` | `archivist-router.ts` | **v0.8**：archivist 增量扫描与摘要懒加载（见 06 §2.6） |
| `/api/tool-execute` | （内联于 index.ts） | 单工具测试执行 |
| `/api/models` | （内联于 index.ts） | 聚合所有 Provider 的模型列表 |
| `/api/webfetch/cookies` | （内联于 index.ts） | WebFetch cookie 查询 / 清理 |
| `/api/ready` | （内联于 index.ts） | 健康检查 |

- **IPC 接入面**（Electron 桌面模式独有）：v0.8 起由 `src/main/ipc-proxy.ts` 的 `registerProxyHandlers(port)` 统一注册 `ipcMain.handle`，主进程通过 `fetch` 调本地 backend 的 HTTP 端口（**不是**直接调用 store / service）。preload 侧的 `WindowApi` 暴露 **155 个 API 方法**，按通道类型显式分为三类（口径与 07 §2.5 / 11 §6 对齐）：
  - **141 个 HTTP 代理通道**（invoke→fetch）：对应 `ipc-proxy.ts` 的 `R` 表（`RouteMapping`），每项映射一条 REST 路由（method / path / buildReq）。
  - **7 个 LOCAL invoke 通道**（不走 HTTP，主进程内 `ipcMain.handle` 直接处理）：`window:minimize` / `window:maximize` / `window:close` + `dialog:openDirectory` + `webfetch:login` + `templates:github-preview` + `templates:import-github`。
  - **7 个 receive-only event 通道**（main → renderer 单向 `webContents.send`，preload 用 `ipcRenderer.on` 订阅）：`agent:event` / `data:changed` / `app:ready` / `tools:changed` / `session:lifecycle` + `templates:github-preview-progress` + `templates:import-github-progress`（两条 GitHub 进度事件）。
  - 155 = 131 invoke（141 代理 + 7 LOCAL − 因 `app:ready` 既是 invoke 轮询又是 receive 推送，去重后计入 invoke 侧）+ 7 on receive + 其余工具/订阅 helper。
  - **`app:ready` 双重身份**：renderer `invoke('app:ready')` 触发 main 内部 `fetch('/api/ready')` 轮询（INVOKE_BUT_NOT_PROXIED），就绪后又经 WS→IPC 反向推 `app:ready` event 给所有窗口（receive-only），同通道名两种语义。
  - 三组例外集合（详见 07-renderer-and-ipc.md §2.5）：① `LOCAL_CHANNELS` 7 项在主进程内直接处理；② `INVOKE_BUT_NOT_PROXIED` 3 项（`app:ready` 健康检查 + `templates:github-preview/import-github` WS 流式）；③ v0.8 §11.5 退役的 `agent-as-tool` 系列（测试反向断言不得出现）。`ROUTE_MAP` 不是手写常量，而是测试 `rest-routers.test.ts` 从 `ipc-proxy.ts` 源码正则派生。旧版 `typed-ipc.ts` + `registerCrud` 已不存在。
- **WebSocket**：`/ws` 端点用于实时 Agent 事件流（`text_delta` / `tool_start` / `tool_end` 等），server 在 `wss.on("connection")` 里接收 `send` / `abort` 消息并把 AgentService 订阅的事件转发给所有已连接 client；client 重连时若 server busy 会回送 `reconnect` 消息带当前 streamingText 和 toolCalls。
- **静态资源**：`serveStatic=true` 时挂载 renderer 产物（`out/renderer/`），非 API 请求 fallback 到 `index.html`，支持单端口同时提供前后端。

## 数据流

zero-core 有两种数据流模式，对应两种部署，但运行时（AgentLoop / 工具 / Hook）是共享的：

### IPC 模式（桌面 Electron，v0.8 两跳架构）

v0.7 的 "typed-ipc + 直接调 store" 单跳路径已退役。v0.8 走**两跳**：第一跳是 Electron IPC（renderer → main），第二跳是 HTTP（main → backend）—— main 进程不再持有业务逻辑，仅做 `ipcRenderer.invoke` → `fetch` 翻译。

```
请求路径（invoke→response）：
用户操作 → renderer component → store action
  → preload 暴露的 IPC API（ipcRenderer.invoke("chat:send", ...)）
  → [第一跳：Electron IPC]
  → main: ipc-proxy.ts registerProxyHandlers 注册的 ipcMain.handle
       └ 查 R 表（RouteMapping）→ fetch("http://localhost:<port>/api/chat/send", {...})
  → [第二跳：HTTP loopback]
  → backend Express REST router（chat-router.ts）
  → server store / AgentService → AgentLoop.run() / tools / hooks
  → 返回 JSON 沿原路回：router → fetch resp → ipcMain.handle resolve → store action

事件路径（main → renderer，receive-only，不经 invoke）：
AgentService.subscribe → backend WS broadcast {type:'text_delta'|'data:changed'|...}
  → main: connectEventBridge WS client 收到事件
       └ 按 eventType 分流：'agent:event' / 'data:changed' / 'app:ready' / 'tools:changed' /
         'session:lifecycle' / 'templates:*-progress' 各自 webContents.send
  → [Electron IPC event]
  → renderer preload: api.onAgentEvent / onDataChanged / ... → 对应 zustand store 更新
```

141 个 HTTP 代理通道走请求路径；7 个 LOCAL invoke 通道在第一跳后直接由 main 处理（不走第二跳）；7 个 receive-only event 通道只走事件路径。

### HTTP/WS 模式（远程 / server）

```
HTTP 客户端 → REST POST /api/chat
  → chat-router → AgentService.sendPrompt
  → AgentLoop.run() / tools / hooks
  → AgentService.subscribe 把事件序列化为 JSON
  → 通过 WebSocket (/ws) 推送给所有已连接 client

WS 客户端 → ws.send({ type: "send" | "abort" })
  → wss.on("message") → AgentService.sendPrompt / abort
```

### 持久化数据流（两种模式共享）

```
AgentLoop 每个 tool-result → CheckpointManager → CoreDatabase.updateTurnState（写 turn_state.checkpoint）
  → 异常退出后启动 → recovery.scanIncompleteTurns
  → AgentLoop.resume(interruptedTurnSeq) 从 checkpoint 续跑

AgentLoop PostToolUse hook → tool-execution-hooks → tool_executions 表（审计 + 统计）
AgentLoop PostTurnComplete hook → extraction-hooks → 内容记忆 / 工具遥测双提取者（v0.8 M5）
  注：v0.7 的 memory-hooks（PostTurnComplete → memory_nodes 表）已在 v0.8 P2 §11.6 删除，
  memory 现并入 per-agent wiki 子树（见 06 §2）。memory_nodes 表仍存在但仅由压缩回退路径写入。
RequirementStore 更新前 → requirement-state-machine.isValidTransition 校验 → requirements 表
```

关键不变量：运行时（`src/runtime/`）不直接读写数据库，所有持久化通过 server 层 store 或 hook 回调完成；service 层是编排者，运行时是执行者，两者解耦使得 CLI / IPC / HTTP 三种接入面能复用同一套运行时。

## 服务边界

| 模块 | 文件 | 职责 |
|------|------|------|
| 主进程入口 | `src/main/index.ts` | Electron 生命周期、窗口管理 |
| Agent 服务 | `src/server/agent-service.ts` | Agent 会话创建、消息调度、事件转发 |
| Agent 循环 | `src/runtime/agent-loop.ts` | 核心循环（LLM→tool→loop），不含功能逻辑 |
| Feature Hooks | `src/runtime/hooks/` | **7 个 hook handler 模块**（turn、notification、rag、provider-options、compression、todo-cleanup、extraction），由 `hooks/index.ts` 的 `registerAllRuntimeHooks` 按固定顺序注册；v0.7 的 `memory-hooks` 已在 v0.8 P2 §11.6 删除 |
| 会话管理 | `src/runtime/session.ts` | 消息历史、token 计数、上下文裁剪 |
| 子任务委派 | `src/runtime/subagent-delegator.ts` | 前台/后台子任务、任务注册表 |
| 检查点 | `src/runtime/checkpoint-manager.ts` | 对话检查点持久化和中断恢复 |
| 限速器 | `src/runtime/tool-rate-limiter.ts` | per-tool FIFO 队列 + 时间间隔门控 |
| 工具工厂 | `src/runtime/tools/tool-factory.ts` | 工具注册、元数据、execute 包装（hook + 限速 + 截断） |
| 工具注册中心 | `src/core/tool-registry.ts` | 工具元数据、配置 schema、运行时描述 |
| MCP 管理 | `src/server/mcp-manager.ts` | MCP 服务器生命周期和工具调用 |
| Hook 系统 | `src/core/hook-registry.ts` | 单例注册表，**30 个生命周期事件**（类型定义见 `core/hook-types.ts:29-39`，其中 20 个实际触发、10 个仅定义零触发，详见 08 §2.4） |
| 模板管理 | `src/server/template-store.ts` | **16 个内置模板**（12 基础角色 + 4 v0.8 领域专家）+ 用户模板，`mergeBuiltInTemplates` 自动合并并对 stale built-in 行 reconcile；另有 1 个工作流角色 `zero` 在 `builtin-role-templates.ts` 单独管理（不进画廊） |

## 工具执行管线

```
tool-call 事件
  → PreToolUse hook（可阻断）
  → ToolRateLimiter.acquire()（FIFO 排队）
  → 实际 execute()
  → ToolRateLimiter.release()
  → PostToolUse / PostToolUseFailure hook
  → 结果截断（truncateResult）
```

## 工具策略层级

1. `toolPolicy.tools` map（UI 开关状态，精确控制每个工具）
2. `toolPolicy.autoApprove`（template 默认值，兜底）
3. `DEFAULT_ENABLED`（Bash, Read, Write, Edit, Grep, Glob）

运行时优先级：`tools` map > `autoApprove` > `DEFAULT_ENABLED`。`tools` map 通过 `agent-service.ts` 传入 `SessionConfig.toolPolicy`。

## IPC 接入面

> 本节与上文「API 接入面」里的 IPC 段是同一事实，此处仅放维护入口。完整契约（通道分类、
> ROUTE_MAP 派生、非 2xx reject、LOCAL/INVOKE 例外集合）见
> [`07-renderer-and-ipc.md`](../arch/07-renderer-and-ipc.md) §2.5 / §2.6。

- 注册入口：`src/main/ipc-proxy.ts` 的 `registerProxyHandlers(port)`，遍历 `R` 表（`RouteMapping`）对每个通道 `ipcMain.handle(channel, fetch→backend)`。
- 通道总数：preload `WindowApi` 暴露 155 个 API 方法，分类见上文「API 接入面」—— 141 HTTP 代理 + 7 LOCAL invoke + 7 receive-only event（+ 其余工具/订阅 helper）；3 个 `INVOKE_BUT_NOT_PROXIED`（`app:ready` 轮询 + `templates:github-preview/import-github` WS 流式）。
- **已退役**：v0.7 的 `typed-ipc.ts` + `registerCrud` + `afterDelete` 回调机制已不存在；v0.8 §11.5 退役的 `agent-as-tool` 系列通道由测试反向断言不得出现。
- 级联删除：旧 `AgentToolStore` 通过 `afterDelete` 做的 Agent→agent-tool 级联已随 store 退役（`agent-router.ts:70` 注释明示「no AgentToolStore rows to cascade」）。

## 数据存储

> v0.8 后 store 总数从 v0.7 的 ~10 个扩到 **18+ 个**（会话核心 5 + 旧业务 6 + v0.8 工作流域 9+）。
> CoreDatabase **不**聚合工作流域 store —— 它们在 `server/index.ts:148-171` 独立 `new`，把
> CoreDatabase 当 `getDb()` 提供者。详见 [`05-persistence.md`](../arch/05-persistence.md) §4.0.3、
> [`02-module-structure.md`](../arch/02-module-structure.md) §4.1.1。本表只列与后端接入面最相关的几个。

| 存储类 | 数据 |
|--------|------|
| `CoreDatabase` | 会话、消息、turn_state、tool_executions、KV store（会话核心 5 表；聚合 5 个内核 store eager/lazy） |
| `AgentStore` | Agent 配置（模型、prompt、toolPolicy、knowledgeBaseIds） |
| `ProviderStore` | AI Provider 配置和模型列表 |
| `TemplateStore` | **16 内置** + 用户模板，自动合并 |
| `McpStore` | MCP 服务器配置 |
| ~~`KbStore`~~ | **RETIRED (plan-00 §5)**：知识库向量 RAG 子系统已整体退役，`KbStore` / `KbDB` 服务端代码删除，`kb_entries` / `kb_chunks` 表由 `runMigrations` `DROP IF EXISTS`，`knowledge.db` 文件由 `DatabaseManager.open()` 在布局 bootstrap 前**删除**（plan-00 §5 精确白名单）。知识/记忆统一以 `project_wiki` 磁盘镜像树承载（见 06 §2）。本行保留为历史说明，**不再是活动 store**。 |
| `SqliteStore` | 基础 CRUD store（所有 store 的父类） |
| ~~`AgentToolStore`~~ | **v0.8 §11.5 已退役**：Agent-as-Tool 映射机制删除，文件 `agent-tool-store.ts` 已不存在，router 与 `afterDelete` 级联回调同步下线 |
| v0.8 工作流域 store | `ProjectStore` / `RequirementStore` / `CronStore` / `WikiStore` / `OrchestrateStore` / `ProjectJobStore` / `TaskStepStore` / `WikiScanCursorStore` / `ToolConfigStore` / `ToolUsageStore` 等（在 `server/index.ts` 独立 new，不挂 CoreDatabase；详见 05 §2.2b 矩阵） |

## 维护规则

- 每次服务边界、IPC 契约、数据流或存储变化后，必须检查并更新本文件
