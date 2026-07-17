# 09 · 扩展点与架构决策

> 核对基线：2026-07-16。本文只描述当前可见的扩展缝与仍然成立的架构决策。历史实施过程保留在 [`../archive/`](../archive/)，不再把已删除模块列为扩展点。

## 1. 扩展前先判断宿主

zero-core 的功能可能运行在 Agent loop、后端 REST、Electron main 或 Renderer。新增能力前先确定宿主，避免把 Electron 能力下放到后端，或把服务状态复制到 main。

| 能力 | 首选扩展点 | 注册或装配位置 |
| --- | --- | --- |
| Agent 可调用工具 | `buildTool` | [`src/tools/index.ts`](../../src/tools/index.ts) |
| 执行生命周期副作用 | per-loop Hook | [`src/runtime/hooks/index.ts`](../../src/runtime/hooks/index.ts) |
| 模型 Provider | Provider factory | [`src/runtime/provider-factory.ts`](../../src/runtime/provider-factory.ts) |
| Web 搜索后端 | `SearchProvider` | [`src/tools/web-search.ts`](../../src/tools/web-search.ts) |
| 外部工具协议 | MCP manager | [`src/server/mcp-manager.ts`](../../src/server/mcp-manager.ts) |
| Agent / Persona | Store 或模板 | [`src/server/agent-store.ts`](../../src/server/agent-store.ts)、[`src/core/persona.ts`](../../src/core/persona.ts) |
| 后端业务 API | Express router | [`src/server/index.ts`](../../src/server/index.ts) |
| 桌面端调用 | preload 契约 + IPC proxy | [`src/preload/index.ts`](../../src/preload/index.ts)、[`src/main/ipc-proxy.ts`](../../src/main/ipc-proxy.ts) |
| 持久化实体 | domain Store + migration | [`src/server/sqlite-store.ts`](../../src/server/sqlite-store.ts)、[`src/server/db-migration.ts`](../../src/server/db-migration.ts) |
| 可移植工作说明 | `SKILL.md` | [`src/server/skill-scanner.ts`](../../src/server/skill-scanner.ts) |

## 2. 当前扩展点

### 2.1 内置工具

内置工具位于 `src/tools/`，平台工具位于 `src/tools/mcp/`。一个常规工具需要：

1. 使用 [`buildTool`](../../src/tools/tool-factory.ts) 声明名称、描述、输入 schema、元数据和执行函数。
2. 把定义加入 [`TOOL_DEFS`](../../src/tools/index.ts)；名称由工具定义本身提供，不应再维护第二份字符串清单。
3. 如需服务能力，通过 `ToolExecutionContext` / capability handles 注入，不要从工具直接导入后端单例。
4. 补充策略、别名、宿主暴露和行为测试。

工具是否对某个 Agent 可见由 tool policy 决定；MCP 动态工具由 `MCPManager` 注册到同一个 `ToolRegistry`，不是 `ALL_TOOLS` 的静态成员。

### 2.2 Hook

[`HookEventName`](../../src/core/hook-types.ts) 包含 session、turn、step、LLM、tool 和观测/工作流事件。运行时使用每个 loop 自己的 [`HookRegistry`](../../src/core/hook-registry.ts)，由 [`registerHooksForLoop`](../../src/runtime/hooks/index.ts) 按 `main` / `delegated` 装配。

新增 Hook 行为时：

- 优先注册到现有事件，不要在 `AgentLoop` 内再加一条平行副作用路径。
- 明确 main、delegated 或 shared 范围。
- 说明错误是阻断执行、修改结果还是仅记录。
- 检查是否会与 global hook、data-change hub 或 StreamEvent 重复触发。

部分 `HookEventName` 只是协议面，未必有生产触发器；“类型存在”不等于“扩展点已接通”。实际触发位置见 [03](03-runtime-engine.md) 与 [08](08-cross-cutting.md)。

### 2.3 LLM Provider

[`provider-factory.ts`](../../src/runtime/provider-factory.ts) 当前处理 OpenAI、OpenAI-compatible、Ollama、Anthropic、Gemini 和测试用 mock。新增 Provider 至少涉及：

- 共享 Provider 类型与配置校验。
- SDK adapter、模型解析、上下文窗口和多模态能力。
- Provider 设置 UI 与模型拉取 API。
- usage、并发限制、错误归一化和测试。

不能只在 factory 增加一个 `case`：Provider 配置会跨 Store、Renderer 和运行时契约。

### 2.4 Web 搜索 Provider

[`SearchProvider`](../../src/tools/web-search.ts) 当前实现 DuckDuckGo、SearXNG、SerpAPI 和 Brave。新增实现应遵守统一的 `search()` 结果形状，并同步配置类型、设置 UI 和凭证处理。

这条扩展点只负责搜索结果；页面抓取由 WebFetch 处理，两者的代理、Cookie 和缓存语义不同。

### 2.5 MCP server 与 Skill

- 外部 MCP server 由 [`MCPManager`](../../src/server/mcp-manager.ts) 建连、发现工具并写入 `ToolRegistry`。
- MCP 工具通过 [`mcp-tool.ts`](../../src/tools/mcp-tool.ts) 把 JSON Schema 适配成 AI SDK 工具。
- Skill 由 [`skill-scanner.ts`](../../src/server/skill-scanner.ts) 从多个目录扫描；同名项按来源优先级覆盖。
- 应用只写 `~/.zero-core/skills`，外部生态目录视为只读来源。

Skill 是提示与资源包，不是隔离边界；其中脚本最终仍通过 Shell 权限执行。安全缺口见 [10](10-tech-debt-architect-view.md)。

### 2.6 REST、IPC 与 Renderer

新增普通业务调用通常需要同时更新：

1. 后端 router，并在 [`server/index.ts`](../../src/server/index.ts) 挂载。
2. [`shared/ipc-api.ts`](../../src/shared/ipc-api.ts) 与 [`shared/preload-types.ts`](../../src/shared/preload-types.ts) 契约。
3. [`preload/index.ts`](../../src/preload/index.ts) 暴露。
4. [`main/ipc-proxy.ts`](../../src/main/ipc-proxy.ts) 的 IPC → HTTP 映射。
5. Renderer store / component 和契约测试。

只有窗口、对话框、登录 webview 等 Electron 原生能力应留在 main 本地。当前已有 GitHub template invoke 未完整接线，新增白名单前应先判断是不是同类遗漏，见 [07](07-renderer-and-ipc.md)。

### 2.7 Store 与 migration

常规业务表使用 [`SqliteStore`](../../src/server/sqlite-store.ts) + domain Store；升级逻辑放在 [`runMigrations`](../../src/server/db-migration.ts)。需要同时核对：

- fresh DB 的建表定义。
- upgraded DB 的补列、回填和旧对象清理。
- 索引、唯一性和外键语义。
- data-change hub 是否应该广播该表。
- 跨数据库/文件写入是否需要补偿或恢复协议。

当前没有 migration version ledger，且部分 schema 同时出现在 `SessionDB` 与 migration 中；扩表时尤其容易只修一处。

## 3. 当前架构决策

这些 ADR 是对现有代码的反向记录，不代表永远不可改变。

### ADR-001：Electron、Renderer、Backend 分进程

- **背景**：模型流、工具和 SQLite 不应阻塞 UI。
- **决策**：Electron main 管窗口与桥接，React 在 Renderer，业务服务运行在独立 Node backend。
- **代价**：必须维护 IPC、HTTP、WebSocket 三层契约和进程恢复。

### ADR-002：请求走 IPC → HTTP，流事件走 WebSocket → IPC

- **背景**：业务 API 适合请求/响应，模型输出需要反向推送。
- **决策**：大多数 preload invoke 经 main 代理到后端 REST；运行时事件由 backend WebSocket 推给 main，再转发 Renderer。
- **代价**：契约会跨四处漂移；重连期间没有持久事件重放。

### ADR-003：`steps` 是会话历史事实源

- **背景**：需要保存每个 LLM step、工具块、usage 和恢复边界。
- **决策**：`steps` 保存可重建历史；`messages` 保存滚动摘要和压缩游标。
- **代价**：重建与摘要必须保持边界一致；当前启动时错误重建 `messages` 表会破坏摘要持久性。

### ADR-004：同步 SQLite + 文件 payload

- **背景**：本地桌面应用优先简单、可检查的持久化。
- **决策**：结构化状态进入单个 `sessions.db`；Wiki 正文、附件、归档和大工具输出落文件。
- **代价**：SQLite 写会阻塞事件循环，DB 与文件系统之间没有统一事务。

### ADR-005：工具统一通过 `buildTool`

- **背景**：不同工具曾重复实现 schema、hook、限流、格式化和审计。
- **决策**：工具定义集中声明，由 registry 和 factory 适配不同宿主。
- **代价**：包装层较深；绕过 factory 的调用会失去横切保障。

### ADR-006：每个 AgentLoop 独立 HookRegistry

- **背景**：全局 registry 容易让 main/delegated handler 串扰。
- **决策**：loop 创建时注入独立 registry，并按 loop kind 装配。
- **代价**：session 生命周期事件由服务层触发，Hook 的完整调用图跨 runtime/server。

### ADR-007：知识与长期记忆统一到 Wiki tree

- **背景**：旧 KB、向量检索和 Memory 图形成多套事实源。
- **决策**：当前在线知识路径为 Wiki 节点、磁盘正文、anchors 与 per-agent memory subtree。
- **代价**：搜索是线性/子串匹配；写入后的 live prompt 缓存失效不完整。

### ADR-008：Renderer 状态按 session 隔离

- **背景**：切换会话时，晚到的流事件可能污染当前聊天。
- **决策**：chat state 绑定 session，切换时拉取快照，并用事件时间防止旧快照覆盖新推送。
- **代价**：每个新增推送域都要设计 reconnect 后的重新拉取与幂等合并。

### ADR-009：恢复以持久状态为边界，内存队列不承诺恢复

- **背景**：应用和 backend 可能在任意 step 中断。
- **决策**：sessions/steps、delegated task、workflow 和 archive 各自提供不同恢复策略；输入队列与等待交互仍是内存态。
- **代价**：系统没有统一的 crash-consistency 模型，调用方必须知道各域保证到哪一层。

## 4. 不再成立的扩展叙事

- 不存在 `src/runtime/tools/`；当前工具目录是 `src/tools/`。
- 不存在可扩展的 KB embedding / `knowledge.db` 生产路径。
- 不存在 `turns` 或 `turn_state` 活跃表；状态已折入 `sessions`，历史在 `steps`。
- 不应把旧 `src/main/ipc/` handler 树当作接入点。
- 不应依赖全局 `HookRegistry.getInstance()` 作为新运行时装配方式。

## 5. 扩展检查表

- 新能力的宿主和事实源是否唯一？
- 是否更新了共享类型、运行时接线和 Renderer 契约？
- 是否同时覆盖 fresh DB 与 upgraded DB？
- 是否定义 abort、重试、恢复和幂等语义？
- 是否会泄露密钥、绝对路径或越过工具 scope？
- 是否有测试证明该路径真的被生产入口调用，而不只是类型存在？
