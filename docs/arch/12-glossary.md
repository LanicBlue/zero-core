# 12 · 术语表

> 核对基线：2026-07-16。术语描述当前代码；已退役名称集中放在末尾，避免和活跃概念混用。

## A–C

- **Agent**：数据库中的可配置执行身份，包含 prompt、模型和工具策略等配置。
- **AgentLoop**：一次会话的执行引擎，负责 turn/step、模型流、工具调用、中止与事件发射。见 [`agent-loop.ts`](../../src/runtime/agent-loop.ts)。
- **AgentService**：后端编排层，创建和监督 loop，连接 Store、Provider、MCP、恢复和事件广播。
- **AgentSession**：运行时上下文视图，组合历史 steps、滚动摘要与当前消息。实现位于 [`session.ts`](../../src/runtime/session.ts)。
- **Anchor**：注入模型 system section 的 Wiki 根或节点入口；用于限定 Agent 默认可见的知识子树。
- **Archive**：把会话导出为磁盘 JSON 后删除在线行的流程，不等于可直接恢复的备份产品。
- **AttachmentMeta**：附件的名称、类型、大小和磁盘位置等元数据；字节不进入普通聊天文本。
- **Backend**：独立 Node 子进程，承载 Express/WS、Agent runtime、SQLite 和业务服务。
- **buildTool**：声明工具 schema、元数据和执行函数的工厂，并提供 hook、格式化、遥测等统一包装。
- **CallerCtx / CallerScope**：工具宿主传入的调用身份、session、工作目录和外部 scope；不是 LLM 可自行声明的授权。
- **Capability handle**：AgentService 按工具策略注入给工具的后端服务能力。
- **Compression**：把较早历史压成滚动摘要并移动压缩游标，以控制模型上下文长度。
- **contextBridge**：Electron preload 向隔离 Renderer 暴露受控 API 的机制。
- **Cron**：持久化计划任务；触发后通过 AgentService 发起工作。

## D–H

- **data-change hub**：后端领域数据变更的合并广播通道，面向 Renderer collection 刷新；不同于模型流事件。
- **Delegated session**：内部子 Agent 使用的隐藏 session，拥有自己的 steps 和状态。
- **Delegated task**：父 Agent 观察子 Agent 的持久任务记录；启动恢复主要将未完成项标记为 interrupted。
- **Electron main**：窗口、dialog、webview 登录、backend 生命周期和 IPC 桥所在进程。
- **Extractor B**：保留代码和测试但当前没有生产装配的抽取服务，不应当作在线能力。
- **HookRegistry**：按事件名保存 handler 的注册表。当前每个 AgentLoop 使用独立实例。
- **HookEventName**：Hook 协议事件联合，包括 session、turn、step、LLM、tool 和观测/工作流事件；类型存在不保证生产触发。

## I–M

- **IPC proxy**：Electron main 中把多数 `ipcRenderer.invoke` 翻译为 backend HTTP 请求的映射层。
- **KV / KeyValueStore**：`kv_store` 表的键值门面，用于少量配置和迁移状态，不替代领域 Store。
- **main loop**：用户直接交互的 AgentLoop；与 delegated loop 的 Hook 装配和任务控制不同。
- **MCP**：Model Context Protocol。zero-core 作为 client 连接外部 server，把发现的工具动态注册进 ToolRegistry。
- **Memory turn**：压缩或归档前由模型执行的记忆整理 turn，把长期信息写入 per-agent Wiki memory subtree。
- **messages**：当前保存滚动摘要与压缩游标的 SQLite 表，不是完整聊天事实源。
- **Migration**：`runMigrations()` 按当前数据库状态补列、回填和清理旧对象的启动过程；当前没有版本台账。

## N–R

- **Persona**：面向用户的角色模板/提示配置，与数据库 Agent 记录不是同一个生命周期对象。
- **Provider**：LLM 服务配置与 adapter。当前生产类型包括 OpenAI、OpenAI-compatible、Ollama、Anthropic 和 Gemini。
- **Provider queue**：按 Provider 限制并发的优先级等待队列；用户、work/cron、background 分层。
- **Renderer**：React UI 进程，通过 `window.api` 调用 preload，不直接访问 Node/SQLite。
- **REST router**：backend 的 Express 业务边界；桌面调用通常还要经过 preload 与 IPC proxy。
- **Rolling summary**：较早会话历史的压缩文本，保存在 `messages`，与 `steps` 中未压缩尾部共同组成模型视图。

## S–Z

- **Session**：一次持久对话/执行上下文；状态、source、恢复检查点等当前字段集中在 `sessions` 表。
- **SessionDB**：持有 SQLite 连接并实现 session、message、step、tool execution、delegated task 和 usage 等核心访问方法的门面。
- **Skill**：以 `SKILL.md` 为入口的可扫描说明/资源包。Skill 脚本没有独立操作系统沙箱。
- **SqliteStore**：基于列定义提供通用 CRUD、camelCase/snake_case 映射和数据变更发射的 Store 基类。
- **Step**：一次 LLM 调用及其文本、推理、工具块和 usage 的持久边界。多个 step 可属于同一逻辑 turn。
- **StreamEvent**：Agent runtime 的高频执行事件，如 text delta、tool start/end、usage、waiting；经 WS/IPC 推给 Renderer。
- **Tool policy**：Agent 配置中决定工具是否可见/可用的策略；不是操作系统权限沙箱。
- **ToolRateLimiter**：工具执行前的等待/限流器；当前等待不支持 AbortSignal。
- **ToolRegistry**：统一保存内置和动态 MCP 工具元信息的注册表。
- **tool-outputs**：大工具结果外置目录；模型看到的是 `[tool-outputs]/...` 虚拟路径。
- **Turn**：一次用户输入驱动的完整循环，可能包含多个 step，直到模型不再调用工具或进入等待/错误。
- **WAL**：SQLite Write-Ahead Logging。生产数据库连接启用 WAL；测试配置使用内存 journal。
- **WebSocket bridge**：backend 向 Electron main 推送 Agent/runtime 和 data-change 事件的通道。
- **Wiki**：当前在线知识与长期记忆主线；元数据在 `project_wiki`，正文位于 `ZERO_CORE_DIR/wiki`。
- **Wiki anchor injection**：读取授权/默认 Wiki 根并编译进 system section 的运行时路径。
- **Wiki memory subtree**：每个 Agent 的长期记忆子树，由 Wiki 工具和 memory turn 写入。
- **Work / Project Work**：项目级持久工作项与运行器，不等同于 delegated task。
- **ZERO_CORE_DIR**：zero-core 数据根，默认 `~/.zero-core`，可由同名环境变量覆盖；少数旧路径仍未完全遵守它。
- **Zustand Store**：Renderer 中按领域维护远端快照、loading/error 和订阅动作的状态容器。

## 退役与易混淆名称

| 名称 | 当前状态 | 替代/说明 |
| --- | --- | --- |
| `turns` 表 | 已删除 | 完整历史使用 `steps` |
| `turn_state` 表 | 已删除 | phase、source、error、检查点等折入 `sessions` |
| `MemoryStore` | 已删除/迁移清理 | 长期记忆使用 Wiki memory subtree |
| `MemoryNodeStore` / `memory_nodes_fts` | 已删除/迁移清理 | 不存在活跃 FTS 记忆后端 |
| `knowledge.db` / KB chunks | 已退役 | 当前没有向量 KB/RAG 生产路径 |
| `rag-hooks.ts` | 不存在 | 不应设计成可直接恢复的旧扩展点 |
| `src/runtime/tools` | 旧路径 | 当前为 `src/tools` |
| `src/runtime/mcp-tools` | 旧路径 | 当前为 `src/tools/mcp` |
| `src/main/ipc/` | 已删除 | 当前批量接线在 `src/main/ipc-proxy.ts` |
| `PostTurnComplete` | 已删除的 Hook 名 | 相关副作用拆到 step/turn 生命周期 |
| 全局 `HookRegistry` | 兼容概念 | 运行时装配使用 per-loop registry |
| Agent tool | 易混淆旧称 | `Subagent` 负责委派；`AgentRegistry` 管理 Agent 记录 |

## 关系速记

```text
一次用户输入 = 一个 Turn
一个 Turn = 一个或多个 Step
完整历史 = steps
压缩历史 = messages 中的 rolling summary + cursor

内置工具 = ALL_TOOLS → ToolRegistry
外部工具 = MCPManager → ToolRegistry

知识元数据 = project_wiki
知识正文 = ZERO_CORE_DIR/wiki
长期记忆 = per-agent Wiki memory subtree
```
