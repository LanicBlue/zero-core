# 跨进程类型契约

> Zero-Core 的跨进程通信有 3 个通道：HTTP、WS、IPC。每条通道都有**显式的类型定义**，并由 `shared/` 集中托管。

---

## 一、契约总览

| 通道 | 类型源 | 端点 |
|------|--------|------|
| IPC (renderer ↔ main) | `shared/ipc-api.ts` + `shared/preload-types.ts` | 49 个通道 |
| HTTP (main ↔ backend) | 复用 IPC 契约（自动推断） | 13 路由 + 多个 express 端点 |
| WS (backend → main → renderer) | `runtime/types.ts#StreamEvent` | `/ws` |

---

## 二、IPC 契约：49 个通道全类型化

`shared/ipc-api.ts` 是单一来源：

```typescript
export interface IpcChannelDefs {
  // Dialog
  "app:ready":              { params: [];                       result: boolean };
  "dialog:openDirectory":   { params: [];                       result: string | undefined };

  // Agents
  "agents:list":            { params: [];                       result: AgentRecord[] };
  "agents:create":          { params: [input: CreateAgentInput]; result: AgentRecord };
  // ...

  // Chat
  "chat:send":              { params: [text: string, agentId?: string, sessionId?: string]; result: Ok };
  "chat:abort":             { params: [agentId?: string];          result: Ok };

  // Tool executions
  "tool-executions:query":   { params: [filter: ToolExecutionFilter]; result: ToolExecutionRecord[] };
  // ...
}
```

**类型推导**：
```typescript
export type Params<C extends keyof IpcChannelDefs> = IpcChannelDefs[C]["params"];
export type Result<C extends keyof IpcChannelDefs> = IpcChannelDefs[C]["result"];
```

`preload-types.ts` 把这个映射到方法签名：

```typescript
export interface WindowApi {
  "agents:list":   ()                              => Promise<AgentRecord[]>;
  "agents:create": (input: CreateAgentInput)      => Promise<AgentRecord>;
  "chat:send":     (text: string, agentId?: string) => Promise<Ok>;
  // ...
}
```

**效果**：
- Renderer 调用 `window.api.agents.create({...})` → TS 立刻报错如果参数不匹配
- 渲染层 **完全不需要后端代码**；它的类型从 `shared/` 直接 import
- 改了 `IpcChannelDefs` → TS 在 main、preload、renderer 三处同时报错

---

## 三、HTTP 契约：从 IPC 自动映射

`main/ipc-proxy.ts` 维护一个 `R: Record<keyof IpcChannelDefs, RouteMapping>`：

```typescript
interface RouteMapping {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  buildReq: (...args: any[]) => { params?: Record<string, string>; body?: any; query?: Record<string, string> };
}
```

**类型技巧**：`ipc-proxy.ts` 没有手写 47 个通道的类型签名——它从 `IpcChannelDefs` 自动推断。但因为用了 `Record<string, RouteMapping>` + `(...args: any[])`，类型安全**在写入时**有，在**调用时**没有。

**手动维护的痛点**：每加一个 IPC 通道要改 3 处：
1. `shared/ipc-api.ts` —— 加 channel
2. `main/ipc-proxy.ts#R` —— 加路由映射
3. `main/ipc/*.ts` —— 加 handler（或经 `registerCrud` 自动）

→ 详见 `07-evolution/02-known-issues.md#3-IPC-三处同步`

---

## 四、WS 契约：28 个流式事件

`runtime/types.ts` 定义 `StreamEvent` 联合类型：

```typescript
export type StreamEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolStartEvent
  | ToolEndEvent
  | MessageEndEvent
  | AgentEndEvent
  | ErrorEvent
  | RetryAttemptEvent
  | TodosUpdateEvent
  | SubagentDispatchedEvent
  | SubagentProgressEvent
  | SubagentCompletedEvent
  | UsageEvent
  | SessionInitEvent
  | { type: "ask_user"; ... }
  | { type: string; [key: string]: unknown };  // 兜底
```

**约定**：
- `snake_case` 类型名（`text_delta` / `tool_start` / `message_end`）
- 每个事件都有 `agentId` 和可选 `sessionId`
- `error` 事件携带 `errorClass: ErrorClass` 枚举（"timeout" | "rate_limit" | "auth" | ...）
- 状态变更类事件（`message_end`、`agent_end`）携带终态元数据

**为什么用字符串联合类型**：
- 序列化友好（JSON 一字不差）
- 跨进程边界无歧义
- 用 TypeScript 联合 + 模式匹配，渲染层可以 `switch (event.type)` 完美收窄

**示例：事件生命周期**

```
agent_service.sendPrompt()
  └─ loop.run()
       ├─ emit({ type: "user_prompt_submit" })  [via hook]
       ├─ emit({ type: "session_start" })        [via hook]
       ├─ executeStream()
       │    ├─ streamText() 异步迭代
       │    │    ├─ emit({ type: "text_delta", text: "..." })
       │    │    ├─ emit({ type: "tool_start", toolName: "Read", args: {...} })
       │    │    ├─ emit({ type: "tool_end", toolName: "Read", result: "..." })
       │    │    └─ emit({ type: "text_delta", text: "more..." })
       │    └─ finalizeStream()
       │         └─ emit({ type: "message_end", contextUsage, contextWindow, ... })
       └─ emit({ type: "agent_end" })
```

Renderer 收到的事件序列看起来像：

```json
{"type":"session_init", "agentId":"zero", "sessionId":"abc", "messages":[...]}
{"type":"text_delta", "text":"I'll start by..."}
{"type":"tool_start", "toolName":"Read", "args":{"path":"src/foo.ts"}}
{"type":"tool_end", "toolName":"Read", "isError":false, "result":"..."}
{"type":"text_delta", "text":"Now I'll edit..."}
{"type":"message_end", "contextUsage":0.42}
{"type":"agent_end"}
```

---

## 五、数据模型契约：`shared/types.ts`

23 个数据模型 + 4 个输入/输出类型：

```typescript
export interface AgentRecord     { id, name, workspaceDir, model, provider, thinkingLevel, contextConfig, systemPrompt, toolPolicy, skillPolicy, knowledgeBaseIds, createdAt, updatedAt }
export interface Provider        { id, name, type, apiKey, baseUrl, models, enabled, isSystem, enableConcurrencyLimit, maxConcurrency, createdAt, updatedAt }
export interface ProviderModel    { id, name, group?, contextWindow?, maxTokens?, multimodal? }
export interface AgentToolEntry  { id, name, description, type: "internal" | "external", enabled, agentId, transport, command, argsTemplate, url, method, headers, bodyTemplate, responsePath, timeout, blocking, createdAt, updatedAt }
export interface McpServerConfig { id, name, transport, command, args, env, url, headers, enabled, agentIds, sourceApp, createdAt, updatedAt }
export interface PromptTemplate  { id, name, description, icon, systemPrompt, model, provider, thinkingLevel, toolPolicy, tags, sourceUrl, color, recommendedTools, isBuiltIn, createdAt, updatedAt }
export interface KnowledgeBase   { id, name, description, embeddingProvider, embeddingModel, agentIds, files: KbFileInfo[], createdAt, updatedAt }
export interface SessionRecord   { id, agentId, isMain, title, createdAt, updatedAt }
```

**Create / Update 输入类型**：

```typescript
export type CreateAgentInput  = Omit<AgentRecord, "id" | "createdAt" | "updatedAt">;
export type UpdateAgentInput  = Partial<Omit<AgentRecord, "id" | "createdAt">>;
```

**派生类型**：
- `Ok` / `Err` / `OkOrErr<T>`：handler 统一返回类型
- `WindowApi`：IPC 契约
- `FetchedModel`：从 LLM API 拉取的模型元数据
- `DiscoveredSkill`：从文件系统扫描的 skill

**注意**：`shared/types.ts` 的字段命名是 **camelCase**（前端风格），但 `server/sqlite-store.ts` 写库时**自动转 snake_case**。这是用 `camelToSnake` 函数实现的；列定义里用 `column: "snake_name"` 重命名。

---

## 六、SessionStore 接口（runtime ↔ server 边界）

`runtime/session-store-interface.ts` 定义**运行时**需要的全部数据访问操作：

```typescript
export interface ISessionStore {
  getMessages(sessionId): any[];
  saveTurn(sessionId, messages): void;
  getTurns(sessionId): Array<{seq, role, content, createdAt}>;
  appendTurn(sessionId, seq, role, content): void;
  getTurnCount(sessionId): number;
  getMainSession(agentId): { ... };
  createSession(agentId, title?): { ... };
  setMainSession(agentId, sessionId): void;
  // ... 20+ methods
  recordToolExecution(exec): void;  // 工具审计
  getKVStore(): IKVStore;
  getMemoryStore(): any;
  getMemoryNodeStore(): any;
}
```

**实现**：`server/session-db.ts` 的 `SessionDB` 类。**这正是 runtime 能在 server 之外独立工作的关键**。

**注意三处返回 `any`**：`getMemoryStore()` 和 `getMemoryNodeStore()` 返回 `any`（因为 memory store 不在 ISessionStore 的强类型里）。这是**有意的弱化**——避免在接口层暴露过多。

---

## 七、ToolExecutionContext 接口（runtime ↔ tool 边界）

`runtime/types.ts#ToolExecutionContext` 是工具执行的"全功能 context"——把 AgentLoop 持有的全部能力**以接口形式**暴露给工具：

```typescript
export interface ToolExecutionContext {
  workingDir: string;
  agentId: string;
  sessionId?: string;
  turnSeq?: number;
  emit: (event: StreamEvent) => void;
  toolConfig?: Record<string, Record<string, any>>;
  rateLimiter?: ToolRateLimiter;
  readScope: "filesystem" | "workspace";
  db: ISessionStore;
  // 子 agent 委派 API
  delegateTask?: (task, opts) => Promise<string>;
  delegateTaskBackground?: (task, opts) => string;
  getTaskResult?: (id) => TaskInfo | undefined;
  listTasks?: (filter?) => TaskInfo[];
  stopTask?: (id) => boolean;
  suspendUntilWake?: (timeoutMs, taskId?) => Promise<string>;
}
```

**设计模式**：
- AgentLoop 在创建 tool execute 函数时**注入
这个 context
- 工具通过 `ctx.delegateTask(...)` 等方法调用子能力
- 当 AgentLoop 不存在（比如 CLI 形态），context 是 partial 的，工具会做 capability check

→ 详见 `04-modules/02-runtime.md#tool-execution-context`

---

## 八、契约的版本演进策略

观察到的几个**无版本号**的设计选择：

| 选择 | 含义 |
|------|------|
| 没看到 `version` 字段在 IPC payload 里 | 前后端必须同步发布；不强兼容 |
| `IpcChannelDefs` 是 interface，删字段即破坏类型 | 接受破坏性变更，TS 编译器保证不会漏改 |
| DB 迁移用 `db-migration.ts` 拼接 SQL | 但 JSON 配置文件 + 双源（`zero-core.json`）保留向后兼容 |

**这意味着什么**：
- ✅ 强类型保证编译期不出错
- ⚠️ 运行时 schema 漂移（如 IPC 字段名拼错）只能等用户报 bug
- ❌ 没有 wire-format 演进（不能滚动升级前后端）

→ 这是桌面应用的合理选择。云端化时需要重新考虑。
