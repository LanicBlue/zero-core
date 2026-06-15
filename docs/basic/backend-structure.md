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

- **启动流程**：解析 argv → 初始化 `SessionDB` + 迁移 → 构建 `ToolRegistry` → 加载 config → 从 `ProviderStore` 读 Provider（缺 apiKey 时尝试用 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` 自动补全）→ 构建 systemPrompt → 起 `AgentLoop` + `TerminalAdapter` → 进入 readline REPL。
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
| `/api/agents` | `agent-router.ts` | Agent CRUD、会话创建 |
| `/api/agent-tools` | `agent-tool-router.ts` | Agent-as-Tool 映射 |
| `/api/providers` | `provider-router.ts` | AI Provider 配置 |
| `/api/templates` | `template-router.ts` | 12 内置 + 用户模板 |
| `/api/chat` | `chat-router.ts` | 发起 Agent 会话 / 发消息 |
| `/api/sessions` | `session-router.ts` | 会话历史、消息 |
| `/api/logs` | `log-router.ts` | 运行日志查询 |
| `/api/files` | `file-router.ts` | 工作区文件树读写 |
| `/api/tool-executions` | `tool-execution-router.ts` | 工具调用记录与统计 |
| `/api/mcp` | `mcp-router.ts` | MCP 服务器管理 |
| `/api/kb` | `kb-router.ts` | 知识库管理 |
| `/api/skills` | `skill-router.ts` | Skill 扫描与元数据 |
| `/api/memory-nodes` | `memory-node-router.ts` | 记忆节点查询 |
| `/api/projects` | `project-router.ts` | 项目 + 分析间隔 / 暂停 / 恢复 + cron 注册 |
| `/api/requirements` | `requirement-router.ts` | 需求 CRUD + verify / archive / report + Lead pickup / progress |
| `/api/project-wiki` | `project-wiki-router.ts` | 项目 wiki 节点 |
| `/api/tool-execute` | （内联于 index.ts） | 单工具测试执行 |
| `/api/models` | （内联于 index.ts） | 聚合所有 Provider 的模型列表 |
| `/api/webfetch/cookies` | （内联于 index.ts） | WebFetch cookie 查询 / 清理 |
| `/api/ready` | （内联于 index.ts） | 健康检查 |

- **IPC 接入面**（Electron 模式独有）：通过 `src/main/` 的 `typed-ipc.ts` + `registerCrud` 注册 IPC 通道（agents、agent-tools、providers、templates、chat、sessions、tools、tool-config、webfetch、config、mcp、kb、messages、log、dialog、files、github-templates），主进程内直接调用 `src/server/` 的 store 与 service，不走 HTTP。
- **WebSocket**：`/ws` 端点用于实时 Agent 事件流（`text_delta` / `tool_start` / `tool_end` 等），server 在 `wss.on("connection")` 里接收 `send` / `abort` 消息并把 AgentService 订阅的事件转发给所有已连接 client；client 重连时若 server busy 会回送 `reconnect` 消息带当前 streamingText 和 toolCalls。
- **静态资源**：`serveStatic=true` 时挂载 renderer 产物（`out/renderer/`），非 API 请求 fallback 到 `index.html`，支持单端口同时提供前后端。

## 数据流

zero-core 有两种数据流模式，对应两种部署，但运行时（AgentLoop / 工具 / Hook）是共享的：

### IPC 模式（桌面 Electron）

```
用户操作 → renderer component → store action
  → preload 暴露的 IPC API（ipcRenderer.invoke）
  → main process IPC handler（typed-ipc / *-handlers.ts）
  → server store / AgentService（直接函数调用，同进程）
  → AgentLoop.run() / tools / hooks
  → 事件通过 ipcMain → renderer 推送（onAgentEvent）
  → store dispatcher 更新 block
```

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
AgentLoop 每个 tool-result → CheckpointManager → SessionDB.updateTurnState（写 turn_state.checkpoint）
  → 异常退出后启动 → recovery.scanIncompleteTurns
  → AgentLoop.resume(interruptedTurnSeq) 从 checkpoint 续跑

AgentLoop PostToolUse hook → tool-execution-hooks → tool_executions 表（审计 + 统计）
AgentLoop PostTurnComplete hook → memory-hooks → memory_nodes 表
RequirementStore 更新前 → requirement-state-machine.isValidTransition 校验 → requirements 表
```

关键不变量：运行时（`src/runtime/`）不直接读写数据库，所有持久化通过 server 层 store 或 hook 回调完成；service 层是编排者，运行时是执行者，两者解耦使得 CLI / IPC / HTTP 三种接入面能复用同一套运行时。

## 服务边界

| 模块 | 文件 | 职责 |
|------|------|------|
| 主进程入口 | `src/main/index.ts` | Electron 生命周期、窗口管理 |
| Agent 服务 | `src/server/agent-service.ts` | Agent 会话创建、消息调度、事件转发 |
| Agent 循环 | `src/runtime/agent-loop.ts` | 核心循环（LLM→tool→loop），不含功能逻辑 |
| Feature Hooks | `src/runtime/hooks/` | 4 个 hook handler 模块（compression、memory、RAG、index） |
| 会话管理 | `src/runtime/session.ts` | 消息历史、token 计数、上下文裁剪 |
| 子任务委派 | `src/runtime/subagent-delegator.ts` | 前台/后台子任务、任务注册表 |
| 检查点 | `src/runtime/checkpoint-manager.ts` | 对话检查点持久化和中断恢复 |
| 限速器 | `src/runtime/tool-rate-limiter.ts` | per-tool FIFO 队列 + 时间间隔门控 |
| 工具工厂 | `src/runtime/tools/tool-factory.ts` | 工具注册、元数据、execute 包装（hook + 限速 + 截断） |
| 工具注册中心 | `src/core/tool-registry.ts` | 工具元数据、配置 schema、运行时描述 |
| MCP 管理 | `src/server/mcp-manager.ts` | MCP 服务器生命周期和工具调用 |
| Hook 系统 | `src/core/hook-registry.ts` | 单例注册表，29 个生命周期事件 |
| 模板管理 | `src/server/template-store.ts` | 12 个内置模板 + 用户模板，自动合并更新 |

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

通过 `typed-ipc.ts` 的 `registerCrud` 统一注册 CRUD 通道，支持 `afterDelete` 回调。

**通道列表**：agents、agent-tools、providers、templates、chat、sessions、tools、tool-config、webfetch、config、mcp、kb、messages、log、dialog、files、github-templates

## 数据存储

| 存储类 | 数据 |
|--------|------|
| `SessionDB` | 会话、消息、turn_state、tool_executions、KV store |
| `AgentStore` | Agent 配置（模型、prompt、toolPolicy） |
| `AgentToolStore` | Agent-as-Tool 映射，含级联删除和孤儿清理 |
| `ProviderStore` | AI Provider 配置和模型列表 |
| `TemplateStore` | 12 内置 + 用户模板，自动合并 |
| `McpStore` | MCP 服务器配置 |
| `KbStore` | 知识库元数据 |
| `SqliteStore` | 基础 CRUD store（所有 store 的父类） |

## 维护规则

- 每次服务边界、IPC 契约、数据流或存储变化后，必须检查并更新本文件
