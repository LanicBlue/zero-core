# 02 · 架构

## 主进程启动序列

`app.whenReady` → 模块全部加载完成的 13 步（[src/main/index.ts:79](../src/main/index.ts#L79) 起）：

1. `app.whenReady` 触发
2. `createWindow()` 创建 BrowserWindow
3. `registerIpc(mainWindow)` 注册所有 IPC handler（**handler 在模块加载前就注册**）
4. `setContextGetter()` 注入响应式 ctx
5. 13 个 handler 文件批量 `typedHandle`
6. `loadCoreModules()` 异步开始
7. Phase 0：17 个动态 import 并行
8. Phase 1：SessionDB + migrations
9. Phase 1b：durable hooks + 日志配置
10. Phase 2：8 个 store + workspaceConfig
11. Phase 3-5：ToolRegistry → MCPManager → AgentService
12. Phase 5b：SessionManager + metrics hooks
13. Phase 6：recovery 扫描 + `moduleReadiness.resolveModule("recovery")`

启动完成后 `webContents.send("app:ready")`，renderer 才被认为可用。

### 启动期的潜在 race

- **MCP reconnect**：[src/main/ipc/core.ts:248](../src/main/ipc/core.ts#L248) `_mcpManager.reconnectEnabled(_mcpStore.list()).catch(() => {})` 不 await、错误吞噬
- **测试模式 seed**：在 Phase 2b 才运行，但 Phase 5 setProviders 是同步从 providerStore 读 — 如果 seed 异常，Phase 5 仍会跑（不阻塞）

## IPC Handler 组织

[src/main/ipc/](../src/main/ipc/) 13 个文件，按领域分：

| 文件 | 频道前缀 | 依赖的 ctx 模块 |
|------|----------|-----------------|
| `dialog-handlers.ts` | `dialog:*`, `app:*` | 无 |
| `config-handlers.ts` | `config:*`, `device-context:*`, `guidelines:*` | `workspaceConfig`, `sessionDb`, `agentService` |
| `agent-handlers.ts` | `agents:*` | `agentStore` |
| `agent-tool-handlers.ts` | `agent-tools:*` | `agentToolStore` |
| `provider-handlers.ts` | `providers:*`, `models:*` | `providerStore` |
| `tool-handlers.ts` | `tools:*`, `tool-config:*` | `toolRegistry` |
| `session-handlers.ts` | `messages:*`, `sessions:*` | `agentService`, `agentStore` |
| `file-handlers.ts` | `files:*` | `workspaceConfig` |
| `chat-handlers.ts` | `chat:*` | `agentService`, `workspaceConfig` |
| `template-handlers.ts` | `templates:*` | `templateStore`, `sessionDb` |
| `mcp-handlers.ts` | `mcp:*` | `mcpStore`, `mcpManager` |
| `kb-handlers.ts` | `kb:*` | `kbStore`, `kbDb`, `providerStore` |
| `log-handlers.ts` | `logs:*` | `sessionDb` |

### `typedHandle` 的设计

[src/main/ipc/typed-ipc.ts](../src/main/ipc/typed-ipc.ts) 包装 `ipcMain.handle`，自动 await 指定模块的 readiness，然后才执行 handler。

**问题**：[IpcContext 接口](../src/main/ipc/types.ts) 里所有字段都是 `any`，所以"类型安全"是表象。`typedHandle` 实际只保证 readiness，不保证类型。

## 模块就绪（module-readiness）模式

[src/main/ipc/module-readiness.ts](../src/main/ipc/module-readiness.ts) 维护一个 `Map<ModuleName, Promise>`，每个模块在 `loadCoreModules` 完成对应阶段时 `resolveModule(name)`。

handler 通过 `ctx.whenReady("agentService")` 等待 — 保证 `app:ready` 之前的 IPC 调用不会拿到 undefined。

**陷阱**：少数 handler 的 modules 数组**不准确**：
- `chat:send` 声明依赖 `["agentService", "workspaceConfig"]`，但实际还读了 `providerStore`、`agentStore`（[chat-handlers.ts:17](../src/main/ipc/chat-handlers.ts#L17)）
- `chat:abort` modules 是 `[]` 但实际访问 `_ctx.agentService`（[chat-handlers.ts:46](../src/main/ipc/chat-handlers.ts#L46)）

## 响应式 ctx 模式

[src/main/ipc/core.ts:42-67](../src/main/ipc/core.ts#L42-L67)：用 getter 把模块级私有变量（`_agentStore`、`_sessionDb` 等）包装成单例 `_ctx` 对象。

好处：handler 在 `loadCoreModules` 之前就注册，但调用时拿到的是当时最新的模块引用。

替代方案考虑：直接 export 模块变量会更直白，但需要重新设计 import 关系。

## Renderer 架构

### 组件树

```
App
└── AppLayout                     (永远 mounted)
    ├── IconSidebar               (永远 mounted)
    ├── ResizableLayout           (永远 mounted，chat 页)
    │   ├── ChatPanel             (messages, input, sessions)
    │   ├── FileTreePanel
    │   └── DocViewerPanel
    ├── page-overlay              (条件 mount)
    │   ├── AgentsPage
    │   ├── SettingsPage
    │   ├── McpSettingsPage
    │   ├── KnowledgeBasePage
    │   └── ToolsPage
    └── LogViewer                 (toggle)
```

页面切换通过 [page-store.ts](../src/renderer/store/page-store.ts) 的 `activePage` 状态，条件渲染 — 没用 router。

### Zustand stores（10 个）

| Store | 职责 |
|-------|------|
| `chat-store` | **chat messages 单源真理**，sessions per agent，streaming 状态 |
| `agent-store` | agents 列表，订阅 `onToolsChanged` 自动 refresh |
| `agent-tool-store` | agent-as-tool 条目 |
| `provider-store` | providers / models |
| `template-store` | prompt templates |
| `mcp-store` | MCP servers 配置 |
| `kb-store` | knowledge bases |
| `page-store` | 当前页面 |
| `theme-store` | 主题 |
| `interaction-store` | AskUser 问题、todos |

### chat-store 双状态

`messagesBySession: Map<sessionId, Message[]>` 加上 `messages: Message[]`（仅 active session）。设计是为了渲染性能，但**带来了同步成本** —— 之前 activeSessionId 没设置时 `messages` 永远是 `[]` 的 bug 就是因此而来。

### IPC 订阅模式

**集中式**（AppLayout）：`onAgentEvent`、`onSessionLifecycle`、`onAppReady`
**分布式**（store 模块）：`onToolsChanged` 等 refresh 事件

集中式好，问题是 AppLayout 里 `onAgentEvent` 一个 switch 处理 8+ event type — 难维护。可以拆成 dispatcher + 各自 handler。

## Runtime 层（src/runtime/）

### Agent 单 turn 执行流程（[agent-loop.ts:284-388](../src/runtime/agent-loop.ts#L284)）

```
1. setBusy, init checkpoint tracking
2. append user msg → session, save to DB
3. fire SessionStart + UserPromptSubmit hooks
4. retry loop (max 3, exponential backoff):
   a. executeStream() — consume AI SDK fullStream
   b. text-delta / reasoning-delta / tool-call / tool-result / finish
   c. on context-length error: prune + retry
5. fire Stop / StopFailure / SessionEnd hooks
6. emit agent_end
```

### Provider 工厂

[src/runtime/provider-factory.ts:105-134](../src/runtime/provider-factory.ts#L105) 的 switch 只支持：

| `type` 值 | 实际 SDK |
|-----------|----------|
| `openai` | `@ai-sdk/openai` |
| `openai-compatible` | `@ai-sdk/openai` + baseURL |
| `ollama` | `@ai-sdk/openai` + baseURL |
| `anthropic` | `@ai-sdk/anthropic` |
| `gemini` | `@ai-sdk/google` |
| `mock` | 自实现，回放 fixture |

**关键事实**：**没有原生 MiniMax 或 GLM 支持**。用户实际使用的 MiniMax 和 GLM 必须以 `openai-compatible` 配置 + 自定义 baseURL 接入。这意味着：
- UI 上选 provider 类型时，"MiniMax" / "GLM" 不在选项里
- reasoning / thinking 字段在 `openai-compatible` 路径下不会自动启用（Anthropic 路径才有专门的 `thinking.budgetTokens` 处理）
- 用户实际跑 MiniMax/GLM 时遇到 thinking 相关问题，多半是这里没有适配

### Tools 系统

注册方式：[src/runtime/tools/index.ts](../src/runtime/tools/index.ts) 静态 `ALL_TOOLS` + `registerRuntimeTools(registry)`。

三类工具共存：
- **runtime 工具**：内置（Bash、Read、Write、Edit、Grep、Glob、WebSearch、AskUser、TodoWrite、Wait、Task* 等）
- **agent 工具**：内部 subagent 或外部 CLI/HTTP agent（通过 [agent-tool.ts](../src/runtime/tools/agent-tool.ts)）
- **MCP 工具**：动态从 MCP server 加载，命名空间 `mcp__server__tool`

工具命名都带前缀，policy 由 [src/core/tool-policy.ts](../src/core/tool-policy.ts) 控制（白名单/黑名单/ask）。

### MCP 集成

**实际是完整实现的**，不是 stub：
- [src/server/mcp-manager.ts](../src/server/mcp-manager.ts) — 完整 client
- 支持 stdio + SSE，streamable-http 复用 SSE 路径
- 启动时自动 reconnect 已配置的 server（虽然是 fire-and-forget）
- tools 注入到 ToolRegistry 的 `mcp` category

用户提到"MCP server 还没有加载"是指**还没配置任何 server**，不是代码缺失。后续想做"本地 MCP 发现"是产品功能（自动扫本地 stdio MCP server），代码层面已经准备好接收。

## Server 层（src/server/）

### SQLite stores 矩阵

| Store | 表 | 内容 |
|-------|----|----|
| `SessionDB` | sessions, messages, turns, turn_state, kv | 核心 session 持久化 |
| `AgentStore` | agents | Agent 配置 |
| `AgentToolStore` | agent_tools | Agent-as-tool 条目 |
| `ProviderStore` | providers | Provider 凭据 |
| `TemplateStore` | templates | Prompt 模板 |
| `McpStore` | mcp_servers | MCP server 配置 |
| `KbStore` | kb_entries | KB 元数据 |
| `MemoryStore` | memory | Agent memory graph |
| `PersonaStore` | personas | Persona（旧） |
| `KeyValueStore` | kv | 通用 KV |

**注意**：[KbDB](../src/server/kb-db.ts) 是**独立的 SQLite 文件**（`knowledge.db`），存 chunk + embedding。

### SessionManager

[src/server/session-manager.ts](../src/server/session-manager.ts) — 不负责 create/list（那是 SessionDB 的事），主要做：
- 生命周期状态机：`created → idle → queued → streaming → executing_tools → disposed`
- TTL 清理（idle 超时自动 dispose）
- Metrics 收集（turn latency、tool duration、token usage）

### Recovery

[src/server/recovery.ts](../src/server/recovery.ts) — 启动时扫 `turn_state` 表里 status='pending' 的记录，调用 `AgentService.recoverIncompleteSessions()`：
- 重新加载消息和 turn
- 重建 AgentLoop
- 调用 `loop.resume(turnSeq)`

**已知风险**：recovery 是 fire-and-forget，错误只 log 不阻塞启动（[agent-service.ts:391-398](../src/server/agent-service.ts#L391)）。stuck 的 pending turn（不是 failed 也不是 completed）不会被清理。

### Durable hooks

[src/server/durable-hooks.ts](../src/server/durable-hooks.ts) 把 agent 生命周期事件落到 `turn_state` 表，配合 recovery 实现中断恢复。
- `SessionStart` → 插入 turn_state
- `PostToolUse` → 更新 phase
- `Stop` / `StopFailure` → 标记完成 / 失败

## 知识库（KB）

| 组件 | 文件 | 角色 |
|------|------|------|
| KbStore | [kb-store.ts](../src/server/kb-store.ts) | 元数据（名称、文件列表、关联 agent） |
| KbDB | [kb-db.ts](../src/server/kb-db.ts) | 独立 DB，存 chunks + embeddings |
| kb-embeddings | （未读到完整路径） | 生成 embedding，20 chunk 一批 |
| kb-search | [kb-search.ts](../src/server/kb-search.ts) | 余弦相似度，top-K |

完整实现，embedding 失败时 graceful degrade（保留 chunk 不报错）。

## 跨层耦合关系

```
renderer ──(IPC)──→ main
                     │
                     ├─→ runtime ─→ server ─→ SQLite
                     │             │
                     │             ├─→ mcp-manager ─→ MCP servers
                     │             │
                     │             └─→ agent-loop ─→ provider ─→ LLM
                     │
                     └─→ core (config / types / logger) ← 跨进程共享
```

**好**：runtime 不直接 import server，全靠构造函数注入依赖（SessionDB、ToolRegistry、MCPManager）。
**坏**：main/ipc/types.ts 的 IpcContext 全 `any`，等于 main 层完全无类型保护。
