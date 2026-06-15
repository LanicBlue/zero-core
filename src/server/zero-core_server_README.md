# src/server

zero-core 的后端进程层。在 Electron 主进程或独立 backend 模式下启动一个 Express HTTP 服务 + WebSocket 服务,把渲染进程、外部脚本和运行时(agent / tool / hook)连接起来,统一对外暴露 REST API 与实时事件流。

## 核心功能

- **HTTP/WS 入口**:由 `index.ts` 的 `startServer` 装配 express + ws,挂载所有路由并启动监听(默认 `PORT=3210`),可选托管渲染进程静态文件。
- **路由集合**:把各领域 store 包装成 REST 路由,统一以 `/api/<resource>` 暴露:
  - `/api/chat` — 发送消息、中止任务(chat-router)
  - `/api/sessions`、`/api/agents`、`/api/agent-tools` — 会话、agent、agent 工具绑定(session-router、agent-router、agent-tool-router)
  - `/api/providers`、`/api/models` — LLM provider 与模型清单,含远端拉模型(provider-router)
  - `/api/tool-executions`、`/api/tool-execute` — 工具执行历史查询、单工具试跑(tool-execution-router、index.ts 内联)
  - `/api/memory-nodes` — 全局记忆 wiki 检索与删除(memory-node-router)
  - `/api/project-wiki`、`/api/projects`、`/api/requirements` — 多 agent 工作流的项目/需求/wiki(project-wiki-router、project-router、requirement-router)
  - `/api/skills` — 本机 skill 扫描(skill-router、skill-scanner)
  - `/api/mcp`、外部 MCP 自动发现 — MCP 服务器管理与跨工具导入(mcp-router、mcp-scanner、mcp-presets)
  - `/api/files`、`/api/logs`、`/api/config`、`/api/kb`、`/api/templates` — 文件浏览、日志、配置、知识库、模板
  - `/api/webfetch/cookies` — WebFetch cookie 计数与清理
- **数据层**:大量 `*-store.ts` / `session-db.ts` / `sqlite-store.ts` 基于 better-sqlite3 持久化会话、消息、agent、provider、mcp、记忆节点、项目/需求/wiki 等。
- **服务层**:`agent-service`、`analyst-service`、`lead-service`、`notification-service`、`git-integration`、`cron-analysis`、`recovery` 等组合 store 与运行时,实现多 agent 工作流、定时分析、崩溃恢复与通知。
- **运行时集成**:在 `startServer` 中注册 durable-hooks、tool-execution-hooks、requirement-hooks、workflow-context-hook 以及 runtime hooks,把 HTTP 层与 LLM/工具循环解耦地接在一起。
- **WebSocket**:agent 事件被订阅后转发给所有 `/ws` 客户端,连接时若处于 busy 状态会回放 `reconnect` 帧;前端也可通过 `send` / `abort` 消息驱动对话。

## 输入

- 来自渲染进程 / 外部客户端的 HTTP 请求与 WebSocket 消息。
- 环境变量:`PORT`(监听端口)、`RENDERER_DIR`(静态渲染目录)、`ZERO_CORE_TEST_FIXTURE`(测试种子)。
- 本机文件系统:工作区目录、`~/.claude`、`~/.cursor`、`~/.zero-core` 等用于扫描 skill / MCP 配置。
- 数据库文件与外部 LLM provider(通过 provider 配置中的 apiKey 访问)。

## 输出

- 监听中的 HTTP server 与 WebSocket server,由 `startServer` 返回 `{ server, agentService }`。
- 一组 `/api/*` REST 端点和一个 `/ws` 实时事件流,驱动前端 UI 与外部集成。
- 持久化到 SQLite 的会话/消息/记忆/项目/需求/wiki 等数据。

## 定位

`src/server` 是整个产品的"服务进程"层:对上提供 HTTP/WS 契约(供渲染进程与外部脚本调用),对下持有所有 store、服务与运行时钩子。它和 `src/runtime`(LLM/工具循环、hook 系统)、`src/core`(配置、日志、tool registry 等基础设施)、`src/shared`(类型与纯工具)协作,本身不直接渲染 UI。同一份代码既可在 Electron 主进程内启动,也可作为独立 backend 进程启动。

## 依赖

- 框架:`express`、`ws`、`better-sqlite3`、`uuid`,动态按需加载 `ai`(generateText)。
- 内部:`src/runtime`(provider-factory、tools、hooks、types)、`src/core`(logger、config、tool-registry、model-registry、file-log-sink、kv-store-interface、default-prompt)、`src/shared`(types、file-utils)。
- 外部资源:工作区目录、LLM provider、本机 IDE 的 MCP/skill 配置文件。

## 维护规则

- 新增 REST 资源时遵循现有约定:实现 `createXxxRouter` 工厂 + 独立 `xxx-store.ts`,在 `index.ts` 的 "Mount API routers" 区块挂载,并为新文件补上 `// 文件说明书` header。
- 固定路径(如 `/metrics`、`/models`)必须注册在带路径参数的路由之前,避免被参数捕获。
- 任何会改变 provider / 工作区 / 上下文的写入接口,都要保证 `agentService` 在下次发请求前拿到最新状态(setProviders、setWorkspaceDir、recreateLoop)。
- SQLite schema 变更(新增列/表)必须同时更新 `db-migration.ts` 的列清单与对应 store 的 `init()`,FTS5 表无法 ALTER 时复用 DROP+CREATE 模式。
- 服务启动顺序敏感(stores → hooks → services → restore → recovery → cron);调整装配流程时优先延后依赖外部资源的步骤。
- 不要在路由里直接做流式输出,事件统一通过 WebSocket 由 AgentService 转发。
