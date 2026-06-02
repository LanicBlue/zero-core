# 02 · 架构

> 最近重写：2026-06（IpcContext 类型化、双状态消除、dispatcher 重构、god 文件拆分后的当前状态）

## 主进程启动序列

`app.whenReady` → 模块全部加载完成的 13 步（[src/main/ipc/core.ts loadCoreModules](../src/main/ipc/core.ts)）：

1. `app.whenReady` 触发
2. `createWindow()` 创建 BrowserWindow
3. `registerIpc(mainWindow)` 注册所有 IPC handler（**handler 在模块加载前就注册**）
4. `setContextGetter()` 注入响应式 ctx
5. 14 个 handler 文件批量 `typedHandle` / `registerCrud`
6. `loadCoreModules()` 异步开始
7. Phase 0：17 个动态 import 并行
8. Phase 1：SessionDB + migrations
9. Phase 1b：durable hooks + 日志配置
10. Phase 2：8 个 store + workspaceConfig
11. Phase 3：ToolRegistry → Phase 3b：search-provider 初始化 → Phase 4：MCPManager → Phase 5：AgentService
12. Phase 5b：SessionManager + metrics hooks
13. Phase 6：recovery 扫描 + `moduleReadiness.resolveModule("recovery")`

启动完成后 `webContents.send("app:ready")`，renderer 才被认为可用。

### 启动期的注意点

- **MCP reconnect** 是 fire-and-forget，但失败已 `log.warn("mcp", ...)`（B4 已修）
- **测试模式 seed** 在 Phase 2b 运行（早于 Phase 5 的 setProviders）
- **search-provider 初始化** 在 Phase 3b — 从 workspaceConfig 读 searchProvider 配置，非默认 DuckDuckGo 时调 `setSearchProvider(createSearchProvider(config))`

## IPC Handler 组织

[src/main/ipc/](../src/main/ipc/) 20 个文件，14 个 register 文件：

| 文件 | 频道前缀 | 备注 |
|------|----------|------|
| `dialog-handlers.ts` | `dialog:*`, `app:*` | 无 ctx 依赖 |
| `config-handlers.ts` | `config:*`, `device-context:*`, `guidelines:*`, `theme:*` | workspaceConfig / sessionDb |
| `agent-handlers.ts` | `agents:*` | `registerCrud(agentStore)` |
| `agent-tool-handlers.ts` | `agent-tools:*` | `registerCrud(agentToolStore)` + 2 个 custom |
| `provider-handlers.ts` | `providers:*`, `models:*` | `registerCrud(providerStore)` + 5 custom |
| `tool-handlers.ts` | `tools:*`, `tool-config:*` | toolRegistry |
| `session-handlers.ts` | `sessions:*` | agentService / agentStore / 6 ops + metrics |
| `message-handlers.ts` | `messages:*` | 3 ops（拆自 session-handlers） |
| `file-handlers.ts` | `files:*` | 5 ops |
| `chat-handlers.ts` | `chat:send`, `chat:abort` | 2 ops |
| `template-handlers.ts` | `templates:*` | `registerCrud(templateStore)` + 2 ops |
| `github-template-handlers.ts` | `templates:github-*` | 2 ops（github preview + import） |
| `mcp-handlers.ts` | `mcp:*` | 12 ops |
| `kb-handlers.ts` | `kb:*` | 10 ops |
| `log-handlers.ts` | `logs:*` | 5 ops |
| `search-provider-handlers.ts` | `search-provider:*` | get + set（即时切换 + 持久化） |

**总频道数**：85（[src/shared/ipc-api.ts](../src/shared/ipc-api.ts) 中声明）

### `typedHandle` 与类型化 IpcContext

[src/main/ipc/typed-ipc.ts](../src/main/ipc/typed-ipc.ts) 包装 `ipcMain.handle`，自动 await 指定模块的 readiness，然后才执行 handler。

[src/main/ipc/types.ts](../src/main/ipc/types.ts) 的 IpcContext 接口已全部用真类型（SessionDB、AgentStore 等），不再是 `any`。`typedHandle` 同时保证 readiness 和类型安全。

**仍残留**：`registerCrud` 调用中 `store: () => ctx.agentStore as any` 这种强转 — 因为 CrudStore 接口的 `update(id, Update)` 与实际 store 的 `update(id, Partial<Omit<...>>)` 签名不兼容。需要后续重构 CrudStore 接口。

### handler modules 数组自动校验

[scripts/check-handler-modules.ts](../scripts/check-handler-modules.ts) 用 TypeScript compiler API 扫所有 `typedHandle` / `registerCrud` 调用，对比声明的 modules 数组和 handler 内 `ctx.*` 实际访问。`npm run check:handlers` 跑。

## 模块就绪（module-readiness）模式

[src/main/ipc/module-readiness.ts](../src/main/ipc/module-readiness.ts) 维护一个 `Map<ModuleName, Promise>`，14 个 ModuleName：`sessionDb / agentStore / providerStore / templateStore / mcpStore / kbStore / kbDb / agentToolStore / workspaceConfig / registry / toolRegistry / agentService / mcpManager / recovery`。

handler 通过 `ctx.whenReady("agentService")` 等待 — 保证 `app:ready` 之前的 IPC 调用不会拿到 undefined。

## 响应式 ctx 模式

[src/main/ipc/core.ts:42-67](../src/main/ipc/core.ts)：用 getter 把模块级私有变量（`_agentStore`、`_sessionDb` 等）包装成单例 `_ctx` 对象。handler 在 `loadCoreModules` 之前就注册，但调用时拿到的是当时最新的模块引用。

## Renderer 架构

### 组件树

```
App
└── AppLayout                     (永远 mounted)
    ├── IconSidebar               (永远 mounted)
    ├── ResizableLayout           (永远 mounted，chat 页)
    │   ├── ChatPanel             (messages, input, sessions, TodosList)
    │   ├── FileTreePanel
    │   └── DocViewerPanel
    ├── page-overlay              (条件 mount)
    │   ├── AgentsPage            (AgentEditor 337 行 + 5 个 section 组件 + GithubImportModal)
    │   ├── SettingsPage          (119 行 orchestrator + 7 个 satellite)
    │   │   ├── ProviderCard / ProviderEditor
    │   │   ├── DeviceContextSettings / GuidelinesSettings
    │   │   ├── WorkspaceSettings / ThemeSettings / SearchSettings
    │   ├── McpSettingsPage
    │   ├── KnowledgeBasePage
    │   └── ToolsPage
    └── LogViewer                 (toggle)
```

页面切换通过 [page-store.ts](../src/renderer/store/page-store.ts) 的 `activePage` 状态，条件渲染 — 没用 router。

### AppLayout 中央事件 dispatcher

[src/renderer/components/layout/AppLayout.tsx](../src/renderer/components/layout/AppLayout.tsx) 用 `handlers: Record<string, (data, key) => void>` 处理 9 种事件：`session_init / text_delta / message_end / thinking_delta / tool_start / tool_end / agent_end / retry_attempt / todos_update / error`。

新增 event type 只动 dispatcher map，不动主体。stringify 抽成 helper 复用。

### Zustand stores（10 个）

| Store | 职责 |
|-------|------|
| `chat-store` | **chat messages 单源真理**（messagesBySession + streamingSessions Set + selectActiveMessages selector） |
| `agent-store` | agents 列表，订阅 `onToolsChanged` 自动 refresh |
| `agent-tool-store` | agent-as-tool 条目 |
| `provider-store` | providers / models |
| `template-store` | prompt templates |
| `mcp-store` | MCP servers 配置 |
| `kb-store` | knowledge bases |
| `page-store` | 当前页面 |
| `theme-store` | 主题 |
| `interaction-store` | AskUser 问题、todos（按 agentId 索引） |

### chat-store 单源真理（已修复）

`messagesBySession: Record<sessionId, Message[]>` 加上 `streamingSessions: Set<sessionId>` 是唯一状态。`messages` 和 `isStreaming` 通过 derived selector 暴露：

```ts
export const selectActiveMessages = (s) =>
  s.activeSessionId ? (s.messagesBySession[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
export const selectIsStreaming = (s) =>
  s.activeSessionId !== null && s.streamingSessions.has(s.activeSessionId);
```

`EMPTY_MESSAGES` 用模块级常量保证引用稳定，避免 React error #185（无限重渲染）。

### IPC 订阅模式

**集中式**（AppLayout）：`onAgentEvent`、`onSessionLifecycle`、`onAppReady`
**分布式**（store 模块）：`onToolsChanged` 等 refresh 事件

## Runtime 层（src/runtime/）

### Agent 单 turn 执行流程（[agent-loop.ts](../src/runtime/agent-loop.ts)）

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

[src/runtime/provider-factory.ts](../src/runtime/provider-factory.ts) 的 switch 支持：

| `type` 值 | 实际 SDK |
|-----------|----------|
| `openai` | `@ai-sdk/openai` |
| `openai-compatible` | `@ai-sdk/openai` + baseURL |
| `ollama` | `@ai-sdk/openai` + baseURL |
| `anthropic` | `@ai-sdk/anthropic` |
| `gemini` | `@ai-sdk/google` |
| `mock` | 自实现，回放 fixture（E2E 用） |

**没有原生 MiniMax / GLM / DeepSeek**。这些走 `openai-compatible` + 自定义 baseURL 接入。UI 也没加 preset（R7 主动跳过 — 用户判定不值得做）。

### Subagent delegation

[src/runtime/subagent-delegation.ts](../src/runtime/subagent-delegation.ts) 提供 blocking 和 non-blocking 两种 sub-agent 调用。auto-background 配置（超时后自动转后台）在 SessionConfig 里。

### Tools 系统

注册方式：[src/runtime/tools/index.ts](../src/runtime/tools/index.ts) `registerRuntimeTools(registry)`。

三类工具共存：
- **runtime 工具**：bash、read、write、edit、grep、glob、web-search、ask-user、todo-write、wait、task-{list,status,stop}、agent-tool、outline、syntax-check 等
- **agent 工具**：内部 subagent 或外部 CLI/HTTP agent（通过 [agent-tool.ts](../src/runtime/tools/agent-tool.ts)）
- **MCP 工具**：动态从 MCP server 加载，命名空间 `mcp__server__tool`

工具命名都带前缀，policy 由 [src/core/tool-policy.ts](../src/core/tool-policy.ts) 控制（白名单/黑名单/ask）。

### MCP 集成

**完整实现**，不是 stub：
- [src/server/mcp-manager.ts](../src/server/mcp-manager.ts) — 完整 client
- 支持 stdio + SSE，streamable-http 复用 SSE 路径
- 启动时自动 reconnect 已配置的 server（fire-and-forget，错误已 log.warn）
- tools 注入到 ToolRegistry 的 `mcp` category

### Web Search

[src/runtime/tools/web-search.ts](../src/runtime/tools/web-search.ts) — 4 个 provider：
- **DuckDuckGo**（默认，免费无 key）
- **SearXNG**（自托管，需 URL）
- **SerpAPI**（付费，需 key）
- **Brave Search**（2000/月免费，需 key）

切换：Settings > Search 页面 → `search-provider:set` IPC → 写 workspaceConfig + 立即调 `setSearchProvider`。启动时 Phase 3b 自动从持久化 config 初始化非默认 provider。

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

**self-heal**：[SqliteStore.ensureTable](../src/server/sqlite-store.ts) 在 CREATE TABLE 后读 table_info，对每个声明的列做 ALTER ADD COLUMN if missing。即使 db-migration 的 `*_COLUMNS` 漏写，store 自己补齐。

### SessionManager

[src/server/session-manager.ts](../src/server/session-manager.ts) — 不负责 create/list（那是 SessionDB 的事），主要做：
- 生命周期状态机：`created → idle → queued → streaming → executing_tools → disposed`
- TTL 清理（idle 超时自动 dispose）
- Metrics 收集（turn latency、tool duration、token usage）

### Recovery

[src/server/recovery.ts](../src/server/recovery.ts) — 启动时：
1. `cleanOldTurnState(24h)` 删除所有 24h 前的行（**包括 pending**，B3 已修）
2. 扫剩余 status NOT IN ('completed','failed') 的 turn
3. 调 `AgentService.recoverIncompleteSessions()` — 重新加载消息、重建 AgentLoop、`loop.resume(turnSeq)`

recovery 是 fire-and-forget，错误只 log 不阻塞启动。

### Durable hooks

[src/server/durable-hooks.ts](../src/server/durable-hooks.ts) 把 agent 生命周期事件落到 `turn_state` 表，配合 recovery 实现中断恢复。
- `SessionStart` → 插入 turn_state（phase=pending）
- `PostToolUse` → 更新 phase=tools_executing
- `Stop` / `StopFailure` → 标记完成 / 失败

## 知识库（KB）

| 组件 | 文件 | 角色 |
|------|------|------|
| KbStore | [kb-store.ts](../src/server/kb-store.ts) | 元数据（名称、文件列表、关联 agent） |
| KbDB | [kb-db.ts](../src/server/kb-db.ts) | 独立 DB，存 chunks + embeddings |
| kb-embeddings | [kb-embeddings.ts](../src/server/kb-embeddings.ts) | OpenAI / Ollama embedding，20 chunk 一批 |
| kb-ingest | [kb-ingest.ts](../src/server/kb-ingest.ts) | 文件 → chunks → 入库 |
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
                     └─→ core (config / types / logger / constants) ← 跨进程共享
```

**好**：runtime 不直接 import server，全靠构造函数注入依赖（SessionDB、ToolRegistry、MCPManager）。
**好**：跨进程共享类型集中在 [src/shared/types.ts](../src/shared/types.ts) + [src/shared/ipc-api.ts](../src/shared/ipc-api.ts)，IpcContext 已类型化。
**仍残留**：`registerCrud` 调用处有 `as any` 强转（接口签名不兼容）。
