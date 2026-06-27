# 09 · 扩展点与架构决策记录（ADR）

> 本文给出 Zero-Core 的显式扩展点 + 关键架构决策（ADR）。每个 ADR 都是从代码反向推导，包含 Context / Decision / Alternatives / Consequences 四要素。

## 1. 显式扩展点

### 1.1 Hook 系统（最丰富）

30 个 `HookEventName` 事件点（详见 `core/hook-types.ts`）。要扩展行为，最自然的方式是注册一个 hook handler：

```typescript
HookRegistry.getInstance().register("PreToolUse", async (ctx) => {
  if (ctx.toolName === "Shell" && ctx.args.command?.includes("rm -rf /")) {
    return { blocked: true, reason: "Destructive command blocked" };
  }
});
```

**当前活跃 hook 装载点**：

| 文件 | 装载时机 | 注册的事件 |
|------|----------|------------|
| `server/durable-hooks.ts` | `agent-service.ts` 构造时 | SessionStart / PostToolUse / Stop / StopFailure |
| `runtime/hooks/turn-hooks.ts` | `registerAllRuntimeHooks(db)` | SessionStart / PostStep / Stop / StopFailure |
| `runtime/hooks/compression-hooks.ts` | 同上 | PostTurnComplete |
| `runtime/hooks/rag-hooks.ts` | 同上 | PreLLMCall |
| `runtime/hooks/notification-hooks.ts` | 同上 | PreLLMCall |
| `runtime/hooks/provider-options-hooks.ts` | 同上 | PreLLMCall |
| `runtime/hooks/todo-cleanup-hooks.ts` | 同上 | PostTurnComplete |
| `runtime/hooks/extraction-hooks.ts` | 同上（注入 deps 时） | PostTurnComplete |

> v0.8 (P2 §11.6)：`runtime/hooks/memory-hooks.ts` 已删除。memory 合并进 per-agent wiki 子树，召回改由 `wiki-anchor-injection` 注入 + `Wiki(search)` 查询，不再走独立 recall hook。

### 1.2 工具（最直接）

新增一个工具 = 在 `runtime/tools/` 加一个 `.ts` 文件 + 在 `runtime/tools/index.ts` 的 `ALL_TOOLS` 中注册：

```typescript
export const myTool = buildTool({
  name: "MyTool",
  description: "...",
  prompt: "...",
  meta: { category: "assistant", isReadOnly: true },
  inputSchema: z.object({ ... }),
  execute: async (args, ctx) => { ... },
});

// 在 ALL_TOOLS 里加： MyTool: myTool,
```

前端自动从 `ToolRegistry` 拉取，无需改前端代码。

### 1.3 LLM Provider

`runtime/provider-factory.ts:120-160` `getOrCreateProvider()`：

```typescript
case "my-provider":
  const { createMyProvider } = await import("@my-provider/sdk");
  factory = createMyProvider({ apiKey: config.apiKey, baseURL: config.baseUrl });
  break;
```

加一个 case + 加一个依赖。

### 1.4 嵌入 Provider

`server/kb-embeddings.ts` `createEmbeddingProvider(provider, {baseUrl, apiKey, model})`。

### 1.5 搜索 Provider

`runtime/tools/web-search.ts:250-269` `createSearchProvider(config)`：
- DuckDuckGo（默认）
- SearXNG（自托管）
- SerpAPI（商业）
- BraveSearch

新增搜索后端 = 实现 `SearchProvider` 接口 + 注册。

### 1.6 IPC Channel

新增 IPC channel = 至少三处改动：
1. `src/shared/preload-types.ts` `WindowApi` 接口加方法
2. `src/main/ipc-proxy.ts` `R` 映射表加一行，除非该通道必须留在 main 本地
3. 后端 `src/server/<x>-router.ts` 加 Express 路由
4. 必要时更新 `src/shared/ipc-api.ts` 与 `tests/unit/rest-routers.test.ts` 的契约校验

当前 `preload/index.ts` 暴露 155 个 preload API（131 个 `invoke` + 7 个 `on` receive + 余下为同步属性/常量），`ipc-proxy.ts` 的 `R` 表代理 141 个通道；main 本地保留 6 个 `ipcMain.handle`（window/dialog/webfetch/app:ready，必须用 Electron 原生能力）。新增通道时应优先让测试捕获遗漏，而不是把例外加入白名单。

### 1.7 SQLite 表

`src/server/sqlite-store.ts` 通用 CRUD 已经支持任意表。新增表：
1. 定义 `COLUMNS: ColumnDef[]`
2. `new SqliteStore<T>(db, "table_name", COLUMNS)`
3. 包一层 domain-specific store（如 `agent-store.ts` 的模式）

### 1.8 Persona / 角色

`src/core/persona.ts:56-102` `PERSONA_TEMPLATES`：增删模板即可。

### 1.9 KB / RAG

注册 KB → KB 配置 Provider/Model → 启动 ingest → 通过 `/api/kb` 手动检索/管理。当前默认 Agent 会话不会自动接入 `getRagContext`；如需自动 RAG，应作为显式 KB binding 能力重新设计。

---

## 2. 架构决策记录（ADR）

### 2.0 21 个 ADR 总览（timeline + 分类）

> 实际 21 个 ADR（ADR-018 无独立章节，并入 ADR-012 / D-016 的契约漂移讨论）。

```mermaid
timeline
    title 21 个 ADR 的决策焦点分布
    进程模型 : ADR-001 Electron + 后端子进程
             : ADR-002 IPC → HTTP 桥
             : ADR-003 WebSocket 反向
             : ADR-004 dev spawn / prod fork
    架构哲学 : ADR-005 Hook 提取
             : ADR-006 单 SQLite + KV
             : ADR-007 turns 表为权威
             : ADR-009 config.ts 耦合
             : ADR-014 Zustand 单 Store
    工具与协议 : ADR-008 legacy KB RAG hook
                : ADR-010 buildTool 工厂
                : ADR-011 mcp-tools 改名
                : ADR-012 main/ipc 清理完成
                : ADR-013 双 Memory
                : ADR-018 IPC 契约漂移
    Provider : ADR-015 默认 6 工具
             : ADR-016 Ollama = OpenAI
    L18N    : ADR-017 中文注释
```

```mermaid
graph TB
    subgraph "进程模型（4）"
        A1[ADR-001 三进程]
        A2[ADR-002 IPC→HTTP]
        A3[ADR-003 WS 反向]
        A4[ADR-004 spawn/fork 切换]
    end
    subgraph "架构哲学（5）"
        B1[ADR-005 Hook 提取 ★]
        B2[ADR-006 单 SQLite+KV]
        B3[ADR-007 turns 权威]
        B4[ADR-009 config 耦合]
        B5[ADR-014 Zustand 单 store]
    end
    subgraph "工具与协议（6）"
        C1[ADR-008 legacy KB RAG]
        C2[ADR-010 buildTool]
        C3[ADR-011 mcp-tools 改名]
        C4[ADR-012 main/ipc 清理完成]
        C5[ADR-013 双 Memory]
        C6[ADR-018 IPC 契约漂移]
    end
    subgraph "Provider（2）"
        D1[ADR-015 默认 6 工具]
        D2[ADR-016 Ollama = OpenAI]
    end
    subgraph "本地化（1）"
        E1[ADR-017 中文注释]
    end

    style B1 fill:#34d399,color:#000
    style C1 fill:#f87171,color:#000
    style C3 fill:#fbbf24,color:#000
    style C4 fill:#34d399,color:#000
    style C5 fill:#fbbf24,color:#000
    style C6 fill:#f87171,color:#000
```

**关键标记**：
- 🟢 **ADR-005 Hook 提取** — 项目**最成功**的架构改进
- 🟡 **ADR-008 legacy KB RAG hook** — 默认运行路径未接通，建议退役或产品化重接
- 🟢 **ADR-012** — main/ipc 死代码已清理并由测试固化
- 🟠 **ADR-011/013** — 两个"清理债"决策待落地
- 🔴 **ADR-018** — 当前最实际的 IPC 契约漂移风险

### ADR-001 · 进程模型：Electron + 后端子进程

### ADR-001 · 进程模型：Electron + 后端子进程

**Context**：LLM 调用是长连接 + 流式；UI 需要快速响应；SQLite 是同步阻塞。

**Decision**：Electron 三进程（Main / Renderer / Backend），后端用独立 Node.js 子进程承载 LLM 与数据库。

**Alternatives**：
- 单一 Node.js 进程：UI 渲染阻塞数据库 IO。
- 单一 Electron Renderer 进程承担后端：chromium 进程崩溃 = 全部崩溃。
- Web service 后端：网络抖动、多机部署复杂度。

**Consequences**：
- ✅ 进程隔离：UI 崩溃不影响后端；后端崩溃可自动重启。
- ✅ 多 LLM 流式并行互不阻塞 UI。
- ❌ 进程间通信成本：IPC + HTTP + WebSocket 三层桥。
- ❌ 部署复杂：必须打包 electron-builder。

**Code evidence**：`main/index.ts:191-212`、`backend-spawn.ts:27-91`。

---

### ADR-002 · IPC 通道通过 HTTP 桥接到后端

**Context**：Electron 的 IPC 是同步请求-响应模式，与后端的 REST 风格一致。

**Decision**：绝大多数业务 IPC 通道通过 `ipc-proxy.ts` 的 `R` 表翻译为对 `http://localhost:<port>/api/...` 的 HTTP 请求。当前 `R` 表代理 141 个通道；main 本地保留 6 个 `ipcMain.handle`（必须使用 Electron 原生能力）。

**Alternatives**：
- 直接在 main 进程跑后端逻辑：把 main 进程变成上帝对象。
- 用 MessagePort + JSON 序列化：不利于调试。

**Consequences**：
- ✅ 后端可以独立测试（用 curl 直接打）。
- ✅ 后端逻辑与 main 进程解耦，可单独部署。
- ✅ 大多数业务通道走统一路径，并由 `tests/unit/rest-routers.test.ts` 做契约校验。
- ❌ 进程间多一跳，约 2-10ms 延迟。
- ❌ 需要起 HTTP server + 端口管理。

**Code evidence**：`main/ipc-proxy.ts:11-153`、`main/index.ts:202-207`。

---

### ADR-003 · 后端用 WebSocket 反向推送流式事件

**Context**：LLM 流式输出需要长连接推送；HTTP 短轮询低效。

**Decision**：后端启动 WebSocketServer 在 `/ws`，main 通过 `ws://localhost:<port>/ws` 订阅，事件转发为 IPC 事件到 renderer。

**Alternatives**：
- SSE（Server-Sent Events）：单向，但浏览器侧可用。
- Long Polling：老式但可靠。
- 仅 IPC 主动拉：流式体验差。

**Consequences**：
- ✅ 双向 + 低延迟 + 自动重连。
- ✅ 事件类型复用 IPC envelope。
- ❌ 浏览器端不能用（Electron 不受限）。
- ❌ 重连期间事件丢失（无缓存）。

**Code evidence**：`main/ipc-proxy.ts:214-261`、`server/index.ts` (startServer)。

---

### ADR-004 · 子进程启动策略：dev spawn node / prod fork electron

**Context**：`better-sqlite3` 是 native binding，需要 ABI 匹配 Electron 的 Node.js。

**Decision**：
- **开发模式**：`spawn("node", ...)` 用系统 Node.js，避免 Electron ABI 与 better-sqlite3 不匹配。
- **打包模式**：`fork(...)` Electron 子进程；electron-builder `npmRebuild: true` 已重新编译 native modules。

**Alternatives**：
- 统一 fork Electron：dev 模式跑不通。
- 统一 spawn node：打包后用户机器可能没 Node.js。

**Consequences**：
- ✅ 两边都能跑。
- ⚠️ 双路径测试覆盖成本高。

**Code evidence**：`backend-spawn.ts:32-46`、`electron-builder.yml`。

---

### ADR-005 · Hook 系统从 AgentLoop 提取副作用

**Context**：AgentLoop 原本承担 turn 持久化、压缩、记忆召回、RAG 注入等多重职责，体积膨胀。

**Decision**：把上述副作用全部抽出到 `runtime/hooks/*-hooks.ts`，AgentLoop 仅触发 `triggerHooks(event, ctx)`。

**Alternatives**：
- 保留在 AgentLoop：违反单一职责。
- 用 AOP / decorator：TS 生态不成熟。

**Consequences**：
- ✅ Hook 提取仍然有效，但 AgentLoop 当前又增长到约 700 行，需要继续控制流式事件翻译和工具执行分支。
- ✅ 每个 hook 可独立测试。
- ✅ 扩展点明确。
- ❌ 23 个 hook 事件定义但未装载（幽灵 hook），其中 10 个连 `emit` 都没有（死定义，纯噪音）。
- ❌ 调用顺序依赖注册时机。

**Code evidence**：`runtime/hooks/index.ts`、`core/hook-registry.ts`。

---

### ADR-006 · 数据驻留：单 SQLite 文件 + KV store

**Context**：用户场景是单机本地，无分布式需求；但配置项多（主题 / 设备 / 工具配置 / 全局配置 / workspace）。

**Decision**：
- 业务实体表（agents / providers / mcp_servers / kb_entries / memory_nodes / ...）：SQLite 表。
- 软状态配置（workspace / theme / device / tool-config / global-config / ...）：KV 表 `kv_store`。
- 持久化文档 chunks：同库 `kb_chunks` 表（embedding 作为 BLOB）。

**Alternatives**：
- 每个对象一个 JSON 文件：早期版本的问题（`agents.json` / `providers.json` 等），查询 O(N)。
- PostgreSQL：单机过度。
- LevelDB / RocksDB：需要额外依赖。

**Consequences**：
- ✅ 单文件备份 / 迁移简单。
- ✅ KV 灵活补丁 + 业务表结构化并存。
- ❌ `session-db.ts` 类持有多个独立存储后端，类太大（当前约 960 行；v0.8 仅聚合 5 个内核 store，9 个工作流域 store 已在 `server/index.ts` 独立 `new`）。
- ❌ KB 向量搜索 O(M×D) 是性能瓶颈。

**Code evidence**：`server/sqlite-store.ts:43-273`、`server/key-value-store.ts:32-116`。

---

### ADR-007 · turns 表为 source of truth

**Context**：UI 需要渲染"原始块"（text / thinking / tool），而 streamText API 需要"标准 messages"。

**Decision**：`turns` 表存原始 blocks JSON（append-only），`messages` 表是 write-through 缓存，AgentSession 构造时从 turns **重建** messages。

**Alternatives**：
- 单一 messages 表，存完整 AI SDK 格式：失去 UI 的灵活性。
- 双写双源：可能不一致。

**Consequences**：
- ✅ UI 与运行时共享同一数据源。
- ✅ 添加新 block 类型只改 rebuildFromTurns()。
- ❌ 写入时双写（turns + messages），事务成本。
- ❌ rebuildFromTurns() 的 tc-id 重生成可能影响 provider 兼容性（已通过 `tc-N` 重映射规避）。

**Code evidence**：`runtime/session.ts:159-178`、`server/session-db.ts:251-275`。

---

### ADR-008 · KB RAG hook 保留但默认运行路径未接通

**Status**：accepted as legacy cleanup。

**Context**：`runtime/hooks/rag-hooks.ts` 仍注册在 PreLLMCall，但它只有在 `SessionConfig.getRagContext` 存在时才会工作。当前 `AgentService.createLoopForSession()` 构造普通 Agent 会话时没有注入 `getRagContext`，所以 KB 内容不会默认进入 `ctx.ragContext`。

**Decision**：把该路径视为 legacy optional hook，而不是当前主记忆/RAG 链路。当前长期记忆主线是 Wiki tree + wiki anchors；KB 仍保留导入、chunk、embedding、手动检索能力。

**Consequences**：
- ✅ 避免维护者误以为 KB 会自动参与每轮 Agent 上下文。
- ✅ Wiki memory 与 KB document search 的边界更清晰。
- ⚠️ 如果产品需要自动 RAG，需要重新设计 KB binding、query planner、上下文预算与 Wiki 去重策略。

**Code evidence**：`runtime/hooks/rag-hooks.ts:13-25`、`server/agent-service.ts:createLoopForSession()`、`runtime/wiki-anchor-injection.ts`。
### ADR-009 · config.ts 三件套耦合

**Context**：单一文件同时承担 schema、默认、加载逻辑。

**Decision**：保留现状（一个文件 324 行）。

**Alternatives**：
- 拆分为 `config-schema.ts` + `config-defaults.ts` + `config-loader.ts`：粒度过细。
- 把 schema 用 codegen 生成：从 schema 自动生成 TS 类型。

**Consequences**：
- ✅ 单文件易查找。
- ❌ schema 改动时需要在 DEFAULT_CONFIG 同步手动改。
- ❌ 不支持"运行时热更新 schema"。

**Code evidence**：`core/config.ts:38-178`。

---

### ADR-010 · Tool 抽象：buildTool 工厂 + meta 反射

**Context**：25 个工具（9 categories：fs / shell / web / db / mcp / task / agent / orchestration / project-management）异构，但需要统一的元数据（category / isReadOnly / configSchema / prompt）。

**Decision**：`buildTool()` 工厂接受 `{name, description, prompt, meta, configSchema, inputSchema, execute}`，把 `meta` / `configSchema` / `prompt` 挂在 AI SDK `tool()` 对象的私有符号上。

**Alternatives**：
- 每个工具手写 TS 接口：样板代码爆炸。
- 用 class 继承：与 AI SDK 的函数式风格不兼容。
- 装饰器：TS 装饰器语义弱。

**Consequences**：
- ✅ 工具声明 1 行起，schema 自动反射到前端表单。
- ✅ meta 字段驱动 UI（红/绿/灰按钮 + 工具分类树）。
- ✅ 工具配置值自动注入 prompt（prompt-as-config）。
- ❌ 元数据存在私有符号上，类型签名看不到，需要 `getToolMeta(def)` 等反射函数。

**Code evidence**：`runtime/tools/tool-factory.ts:92-211`、`core/tool-registry.ts:50-67`。

---

### ADR-011 · `runtime/mcp-tools/` 目录名误导

**Context**：目录名暗示"通过 MCP 接入的工具"，但实际是 5 个 built-in 高级工具（WebFetch / SequentialThinking / Platform / Cookie / BrowserRender）。原 6 个里的 `memory-tools.ts`(Memory) 本批清理僵尸已删(零 importer)。

**Decision**：保留目录名（**已建议改名**）。

**Alternatives**：
- 改名 `runtime/advanced-tools/`：破坏 import 路径。
- 拆为 `runtime/web-tools/` + `runtime/memory-tools/` + ...：粒度过细。

**Consequences**：
- ⚠️ 当前新工程师会被"目录名 ≠ 内容"误导。
- ⚠️ IDE 搜索 `mcp-tools` 会混入 built-in。

**Code evidence**：`runtime/mcp-tools/{fetch,seq,platform,cookie,browser-render}.ts`(`memory` / `node` / `assistant` 已删/改名;`memory-tools.ts` 本批清理僵尸)。

---

### ADR-012 · `main/ipc*` 死代码已清理

**Context**：早期文档记录过 `src/main/ipc/` 下存在一组未装载 handler，生产路径实际由 `ipc-proxy.ts` 接管。

**Decision**：P9 已删除这组遗留路径。当前 `src/main/ipc.ts` 与 `src/main/ipc/` 均不存在。

**Consequences**：
- ✅ main 进程 IPC 入口更清晰：批量业务通道只走 `registerProxyHandlers()`，少量本地能力走 `registerLocalHandlers()`。
- ✅ `tests/unit/p9-dead-path-removal.test.ts` 固化了删除结果，避免死代码回流。
- ⚠️ 清理死代码不等于 IPC 契约完全一致；preload/proxy 的例外见 ADR-018。

**Code evidence**：`main/index.ts`、`main/ipc-proxy.ts`、`tests/unit/p9-dead-path-removal.test.ts`。

---

### ADR-013 · Legacy Memory 与 Wiki Tree 迁移残留

**Status**：accepted, cleanup needed。

**Context**：项目曾存在 `memory-store.ts`(MemoryStore)、`memory-node-store.ts` 和旧 `runtime/mcp-tools/memory-tools.ts`(memoryReadTool/memoryWriteTool)。本批清理僵尸:`memory-store.ts` 与 `memory-tools.ts` 已删除(零 importer / 零运行时写入者);`memory-node-store.ts`(MemoryNodeStore)保留(wiki 不可用时压缩流程回退)。当前 `runtime/tools/index.ts` 已移除 `MemoryRecall` / `MemoryNote`,普通 Agent 的记忆读写走 `Wiki` 工具与 Wiki anchors。(历史 ADR 曾引用 `runtime/memory-recall.ts`,该文件已不存在;记忆召回由 `wiki-anchor-injection` 取代。)

**Decision**：把旧 memory 代码标注为兼容/迁移残留。当前默认长期记忆路径是全局 Wiki tree：Extractor 与 compression 优先写入 Wiki，AgentLoop 通过 `wiki-anchor-injection.ts` 注入项目/Agent 锚点。

**Consequences**：
- ✅ 文档和运行路径一致，避免把旧 FTS5 recall 当成主路径。
- ⚠️ 仍需确认旧表中是否有用户数据，再决定迁移或删除。
- ⚠️ `SessionDB` 仍持有旧 store，会继续增加认知负担。

**Code evidence**：`runtime/tools/index.ts`、`runtime/wiki-anchor-injection.ts`、`runtime/hooks/extraction-hooks.ts`。`runtime/mcp-tools/memory-tools.ts`(memoryReadTool/memoryWriteTool)+ `server/memory-store.ts`(MemoryStore) 本批已删除(零 importer / 零运行时写入者,僵尸清理)。`memory-node-store.ts`(MemoryNodeStore) 保留。
### ADR-014 · Zustand 单 Store 单关注点

**Context**：渲染层有多个交互域（聊天 / Agent / MCP / KB / 设置 / 主题 / 页面 / 交互）。

**Decision**：每域一个 Zustand store，无中央 store。

**Alternatives**：
- Redux Toolkit：过度。
- React Context：性能差。
- MobX：违反 React 模式。

**Consequences**：
- ✅ 边界清晰，可独立卸载。
- ✅ 性能：选择器返回稳定引用。
- ❌ 跨域状态需要手动同步（activeAgentId 在 page-store 和 chat-store 各有一份）。

**Code evidence**：`renderer/store/*.ts` 共 14 个 store + `data-sync.ts`（DB→store 增量同步 helper，见 ADR-021）。

---

### ADR-015 · Ollama 走 OpenAI 兼容协议

**Context**：Ollama 提供 `/v1/chat/completions` 等 OpenAI 兼容端点。

**Decision**：`provider-factory.ts` 对 `type === "ollama"` 走 `createOpenAI(...)`，URL 指向 `localhost:11434`。

**Alternatives**：
- 单独写 Ollama SDK：依赖增加。
- 走 Anthropic SDK：不兼容。

**Consequences**：
- ✅ 零额外依赖。
- ❌ 如果 Ollama 改了兼容端点，需要改代码。

**Code evidence**：`provider-factory.ts:127-156`。

---

### ADR-016 · 默认开启 6 个核心工具（保守默认）

**Context**：LLM 工具有副作用，可能破坏数据。

**Decision**：`buildToolsSet()` 在未配置时仅暴露 Shell / Read / Write / Edit / Grep / Glob，其他工具必须显式 `policy.tools[name] = {enabled: true}`。

**Alternatives**：
- 默认全开：风险大。
- 默认全关：用户体验差。

**Consequences**：
- ✅ "默认安全"。
- ⚠️ 用户首次使用 WebSearch / AskUser 等需要去 Settings 启用。

**Code evidence**：`runtime/tools/index.ts:148-164`。

---

### ADR-017 · 中文注释 + 中文文件名说明书

**Context**：所有源码文件顶部有中文"文件说明书"块（功能 / 输入 / 输出 / 定位 / 依赖 / 维护规则）。

**Decision**：保留中文注释规范。

**Alternatives**：
- 全英文：国际化友好。
- 双语：冗余。

**Consequences**：
- ✅ 新工程师快速理解模块职责。
- ❌ 国际化时需要翻译所有注释。

**Code evidence**：每个 `src/<file>.ts` 第 1-25 行。

---

### ADR-019 · 模板与工作流角色分离(模板按能力取向)

**Context**:历史上存在两套并行、互不感知的「模板」系统:
- **role template**(`runtime/role-templates.ts` `ROLE_TEMPLATES`,15 条硬编码 lead/pm/...):带 `toolPolicy` + `whitelistedRoleTags`(委派图),被 `AgentRegistry` 工具 + REST `/api/role-templates` + IPC `role-templates:*` 消费。**（`runtime/role-templates.ts` 已删除，见 ADR-020；本段为历史背景描述。）**
- **prompt template**(`server/template-store.ts`,DB `templates` 表,`PromptTemplate`):12 条内置 + 用户自建/GitHub 导入,被 UI Templates 页面消费(REST `/api/templates` + IPC `templates:*`)。

两者都用作 agent 身份种子,只是入口不同 → `AgentRegistry.listTemplates` 列出的模板与 UI Templates 页面**对不上**。

**Decision 演进**:先尝试「完全合并为一套」(把 role 塞进 PromptTemplate 画廊,27 条),但很快发现违背一条更根本的原则——**模板按能力/知识领域取向,与工作流角色无关**。最终改为**两个概念彻底分离**:

- **能力模板**(PromptTemplate 画廊,TemplateStore):按能力/领域专长取向,用户面向。**16 条** = 12 通用(Coder/Writer/Translator/Reviewer/Analyst/Tutor/Creative/Researcher/Collector/DevOps/Product Manager/Architect)+ 4 领域专家(Security/UI-UX/Performance Expert + QA Engineer,由原 analyzer lens / qa 重构为「懂什么」的领域专家,能分析也能设计,不绑死动作)。UI 画廊 + `AgentRegistry.listTemplates` 共看 → 对齐。
- **工作流角色注册表**(`server/builtin-role-templates.ts` `BUILTIN_WORKFLOW_ROLES`):交付工作流的位置,**与模板无关,不进画廊**。当时保留 `zero/lead/archivist` 3 个无能力等价物的纯工作流位置。`developer/reviewer/pm/qa` 不再单独定义——工作流里直接用同名能力模板建 agent(Coder/Reviewer/Product Manager/QA Engineer),其工作流专属工具(如 PM 的 CreateRequirementWithDoc)由 zero 在 setup 时配 toolPolicy。（后续 ADR-020 进一步精简：**代码角色注册表只剩 `zero`**，lead/archivist/pm/developer 改为 software-dev playbook 的 wiki 知识，由 zero 读出后实例化。）

**丢弃**:`whitelistedRoleTags` 委派自动装配(依赖失效的 `role_tag` 物理列,fresh DB 上是 no-op);`analyzer×4`(→ 3 领域专家 + 架构并入通用 Architect);`planner×4`(Feature/Bugfix/Refactor/Research 是工作类型,不是能力/领域,丢弃)。

**入口拆分**:`management.instantiateTemplate(id)`(能力画廊,AgentRegistry `create template=` 用)/ `instantiateRole(id)`(角色注册表,fresh-db seed 的 zero 用)。

**移除的并行通道**:`role-template-router.ts`、IPC `role-templates:list/get/instantiate`、preload `roleTemplatesList/Get/Instantiate`(renderer 从未使用)。

**Alternatives**:
- 完全合并为一套(27 条):违背「模板与角色无关」,画廊混入工作流角色。
- 角色也当模板留在画廊:同上,概念混乱。

**Consequences**:
- ✅ 画廊纯能力取向(16 条),UI 与 LLM 工具天然一致。
- ✅ 工作流角色与模板解耦,各自演进。
- ⚠️ 工作流专属工具(如 CreateRequirementWithDoc)不再由 role 模板声明,改由 zero setup 时配 toolPolicy(声明式 → 配置式)。
- ⚠️ lead 委派对象从 role 名(developer/reviewer/qa)改为能力模板名(Coder/Reviewer/QA Engineer)。

**Code evidence**:`server/builtin-role-templates.ts`(BUILTIN_WORKFLOW_ROLES)、`server/template-store.ts:mergeBuiltInTemplates`(只合并能力 builtin)、`server/management-service.ts:instantiateTemplate/instantiateRole`、`runtime/tools/agent-tool.ts`、`server/fresh-db-seed.ts:instantiateRole("zero")`。

---

### ADR-020 · 工作流知识只在 wiki,代码是通用工作流平台

**Context**:ADR-019 把模板与工作流角色分离后,代码里(`builtin-role-templates.ts`)仍硬编码了 lead/archivist/zero 的**工作流程序性 prompt**——lead 的交付管线(pickup→plan→build→verify)、archivist 的 wiki/git 程序、verify 门、角色清单、subagents 图。这些都是「软件开发」这个**具体工作流**的知识,混在通用平台代码里,违背定位。

**Decision**:**项目代码是通用工作流平台,只提供机制**(agents / tools / cron / wiki 知识树 / Orchestrate / 委派)。具体工作流的**知识**——角色清单、各角色身份与程序、管线、门、合作图——**只在 wiki `knowledge/workflow/` 里**。软件开发是**默认自带的示例工作流**,其知识 seed 进 `knowledge/workflow/software-dev` playbook;要别的工作流照此另写一份 playbook。

- **代码角色注册表只剩 `zero`**(平台管家 / 用户入口,通用基础设施,不属于任何具体工作流)。lead/archivist/pm/developer/... 是 software-dev 工作流的角色,**不在代码**,在 playbook 里。
- **zero 通过读 wiki 知道怎么搭某个工作流**:用户要搭 software-dev 时,zero 读 `knowledge/workflow/software-dev` playbook,按其中描述的角色身份/程序/图,用 AgentRegistry 建成 agent(systemPrompt 由 zero 基于 playbook 撰写,能力底座优先用能力画廊模板 Coder/Reviewer/QA Engineer/Product Manager)。
- **SOFTWARE_DEV_PLAYBOOK**(`fresh-db-seed.ts`)是该工作流的**唯一知识源**:已迁入 lead 的四步管线、archivist 的渐进扫描+合并程序、PM 的发现/建需求/覆盖判断、角色清单(含能力底座映射)、subagents 图、cron 建议、两道门、状态机。
- **机制(非知识)仍在代码**:Orchestrate 引擎、verify/requirement 工具、cron、wiki、委派——这些是任何工作流都用的通用机制。

**Alternatives**:
- 代码里保留各工作流的角色 prompt:违背「通用平台」定位,每加一个工作流都要改代码。
- zero 不读 wiki、工作流知识硬编码在 zero prompt:同上,且 zero 无法支持多工作流。

**Consequences**:
- ✅ 平台通用,新工作流=新 playbook(wiki 内容),不改代码。
- ✅ 工作流知识单一源(playbook),用户/zero 可在 wiki 里 refine。
- ⚠️ zero 搭工作流的质量依赖 playbook 写得多详细(以及 zero 的综合能力)——playbook 越完整,zero 建的角色越准。
- ⚠️ lead/archivist 等不再有代码里的固定 systemPrompt;同一工作流不同安装可能产出略有差异的 agent prompt(zero 综合),失去「逐字一致」的可重现性。

**Code evidence**:`server/builtin-role-templates.ts`(只剩 zero)、`server/fresh-db-seed.ts:SOFTWARE_DEV_PLAYBOOK`(software-dev 工作流唯一知识源)、`server/management-service.ts:instantiateRole`(仅 zero)。

---

### ADR-021 · UI 数据同步:SqliteStore 写出口统一捕获 + 推全对象

**Context**:四个突变面会改同一份持久数据——UI(REST router)、agent 工具(ManagementService)、后台服务(archivist/提取者/cron)、启动恢复。早期每个域(agent/project/cron/requirement/wiki)各自手写 `onChange/notifyChanged` + 各自一条事件通道(`agents:changed`/`projects:changed`...)+ 各自 renderer 订阅,**逐模块改、易漏入口**(writeNodeDetail / transitionStatus / upsertProjectNode 等非标准突变)。且 agent 工具改的数据 UI 不刷新(要重启)。

**Decision**:**DB 是唯一真源,所有突变面收敛到 `SqliteStore` 三个写原语(`insertRow`/`updateRow`/`delete`);在这唯一的写出口统一发 `data:changed` 事件,renderer 增量订阅。**

- **`data-change-hub`**(`server/data-change-hub.ts`):
  - **白名单** `UI_COLLECTIONS`(agents/projects/crons/requirements/project_wiki)——`messages`/`turns`/`tool_usage` 等高频表(流式每 chunk 写)不广播,避免刷屏。
  - **coalesce**——同 tick 内按 `(collection,id)` 去重(保留最新 op+record),批量写(archivist 扫数百节点)只触发一次 flush。
  - **推全对象**——create/update emit 时带 `record`(store 本就返回记录),renderer 收到直接 patch,**免 `GET /:id` 那一跳**;delete 只带 id。
- **`SqliteStore`**:`insertRow/updateRow/delete` 调 `emitDataChange(table, id, op, record?)`;`update` 做 **no-op 检测**(patch 字段全等于现值 → 跳过写+不发通知,标量按数值比以兼容"数字存 TEXT 读回 `'2.0'`"的 round-trip 怪癖)。
- **单通道** `data:changed`:server WS broadcast → `main/ipc-proxy` 桥接到 IPC → `preload.onDataChanged`。取代原每域一条通道。
- **renderer `data-sync.ts`**:
  - `subscribeDataChange(collection, refetchAll)`——树形 store(wiki)用,任意变更全量 refetch。
  - `subscribeListDataChange(collection, {patch, refetchAll})`——列表 store 用。`patch(id, record|null): boolean` 原地替换/移除;非过滤 store(agents/projects/crons)新 id 直接 append;过滤 store(requirements)仅替换已存在、不在则返回 false→helper 回退一次 `refetchAll` 重新套用 filter。delete 在就移除、不在 no-op。

**运行时执行态 vs 持久数据(两条通道,职责分离)**:
- `data:changed` = 持久域数据变更(低频、按记录),消费方 = list/tree stores。
- `agent:event` = 运行时执行事件(text_delta / tool_start / session_init / ask_user / todos / error / usage,高频流式),消费方 = chat-store。messages/turns **故意不在** `data:changed` 白名单——流式每 chunk 都写,会刷屏;改走 `agent:event` 实时推 + 切 session 时 `session_init` 批量灌。

**Alternatives**:
- 运行时内存数据权威 + DB 落盘/恢复(`{ui,工具} ↔ 内存 → DB`):对**单写者 + 无后台**的应用更简单;但本应用有自主 agent + 后台服务和并发写,内存权威要自管持久化/恢复/并发冲突,等于重造 SQLite 的事务,DB 权威更稳。且服务端 store 不缓存(每次 read DB,better-sqlite3 自带页缓存),DB 权威没额外对账成本。Electron 双进程逼出 renderer 缓存 + 同步通道,这部分复杂度两边都逃不掉。
- 每 store 手写 onChange + 每域一条通道:逐模块改、易漏入口,已被取代(见 Context)。
- refetch 模式(发 `{id,op}` → renderer 再 `GET /:id`):多一跳,已改成推全对象。

**Consequences**:
- ✅ 新增 UI 同步域 = hub 白名单加表名 + store 调一次 `subscribeDataChange/subscribeListDataChange`,两处各一行,四个突变面自动覆盖。
- ✅ agent 工具改数据 → UI 实时刷新(与 UI 自改同一条回流);单条更新零额外请求(no-op 不发,create/update 推全对象)。
- ✅ 多写者并发收敛(谁先提交谁赢,SQLite 事务保证);崩溃/重启 DB 始终一致。
- ⚠️ renderer 缓存(DB 之外第二份副本)是 Electron 双进程的必然,需 hub 同步——这是固有成本,非 DB 权威选择带来。
- ⚠️ wiki 树全量刷新(结构变更需重算);archivist 后台批量扫描由 coalesce 合并成每 tick 一次刷新,但跨 tick 的长扫描仍会多次刷新(可接受)。

**Code evidence**:`server/data-change-hub.ts`(白名单+coalesce+推全对象)、`server/sqlite-store.ts`(写出口 emit + no-op 检测)、`server/index.ts`(`onDataChange→broadcast`)、`main/ipc-proxy.ts`(WS→IPC 桥)、`preload/index.ts:onDataChanged`、`renderer/store/data-sync.ts`(订阅 helper)、各 renderer store 的 `subscribeListDataChange`。

---

## 3. 总结

- 21 个 ADR，集中在数据驻留、并发控制、扩展点、UI 同步。
- 当前建议优先处理：018 (IPC 契约漂移)、011 (mcp-tools 改名)、013 (legacy memory 清理)、008 (legacy KB RAG hook 标注/退役)。ADR-012 已解决。
- 整个架构遵循"interfaces up, implementations down" 的依赖倒置；`ISessionStore` / `IKVStore` 是教科书级示范。
- "Hook 提取"是**最大的**架构改进（ADR-005），把 AgentLoop 从膨胀中拯救出来。
- 单 SQLite 文件 + KV store 的双重存储（ADR-006）是项目**最勇敢**的决定。
