# zero-core — 文件夹说明书

> 根级 README（OpenPrd doctor 要求）。本仓库的 6 段结构说明书。

## 核心功能

zero-core 是一个本地优先的多 agent AI 工作台，基于 Electron + Express 构建。它提供一个完整的 Agent 运行时，让 AI Agent 能在用户真实环境（文件系统、终端、浏览器）中自主执行任务。

核心能力：

- **Agent 执行引擎**：流式输出 + 工具调用循环（最大 200 步）、并行工具调用、瞬态错误自动重试、对话检查点 + 中断恢复、子任务委派（前台同步 / 后台异步）、思维链（thinking）支持。
- **工具系统**：17 个内置工具（Bash、Read、Write、Edit、Grep、Glob、WebSearch、WebFetch、AskUser、TodoWrite、Agent、Task*、Memory*、SequentialThinking）、per-tool FIFO 限速、工具策略（agent 级 tools map / autoApprove / readScope）、MCP 工具集成、Agent-as-Tool、Outline 代码大纲（27 种语言）。
- **多模型支持**：通过 Vercel AI SDK 统一接入 Anthropic / OpenAI / Google，配置后聚合到 `/api/models`。
- **多 agent 工作流**：项目维度组织 Agent（PM / Lead / Archivist 三类项目 agent），需求状态机驱动 found → discuss → ready → plan → build → verify → closed 流转，wiki 记忆节点沉淀知识，cron 定时分析与恢复。
- **Web 能力**：Brave Search 搜索、WebFetch 抓取 + Markdown 转换（SPA 自动切换 BrowserWindow 渲染）、cookie 管理、磁盘缓存、大结果存盘。
- **三种部署形态**：Electron 桌面应用、HTTP/WS 服务器模式、CLI 终端模式。

## 输入

- **用户输入**：聊天消息（来自 renderer / HTTP `/api/chat` / WS `send` / CLI stdin），由 AgentService 路由到对应 Agent 的 AgentLoop。
- **配置输入**：Provider 配置（API key、baseUrl、模型列表）、Agent 配置（模型、prompt、toolPolicy）、模板（12 个内置 + 用户模板）、MCP 服务器配置、工作区配置（`workspaceDir`、`readScope`、`defaultModel`）。
- **环境变量**：`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`（CLI 自动补全 Provider）、`ZERO_CORE_TEST_FIXTURE`（测试模式注入 mock provider）、`PORT`（server 模式端口，默认 3210）、`RENDERER_DIR`（renderer 静态资源路径）。
- **外部数据**：外部工具的 MCP 配置（Claude Code / Cursor 等，由 `mcp-scanner.ts` 自动发现导入）、文件系统（工作区目录，由 `readScope` 控制可访问范围）。

## 输出

- **流式事件**：通过 IPC（桌面）或 WebSocket `/ws`（服务）推送 `text_delta` / `thinking_delta` / `tool_start` / `tool_end` / `session_init` / `agent_end` 等事件给前端或外部客户端。
- **REST 响应**：`/api/*` 路由返回 Agent / Provider / Template / Session / Tool / MCP / KB / Project / Requirement / Wiki 等 CRUD 与查询结果。
- **持久化数据**：SQLite 数据库存储会话、消息、turn_state（检查点）、tool_executions（审计）、agents、agent-tools、providers、templates、mcp、kb、projects、requirements、wiki、memory_nodes。
- **文件系统副作用**：工具执行可能读写工作区文件、生成代码大纲、抓取网页存盘、写入知识库索引。
- **桌面 UI**：三栏可调布局（聊天 + 文件树 + 文档查看器）、Agents / Tools / Dashboard / Settings / MCP / KB 等管理页面、图标侧边栏导航。

## 定位

- **本地优先**：所有数据存储在本地 SQLite，无需云服务、不做多租户、不做权限隔离（单用户）。
- **Agent 运行时，不是 IDE**：目标是让 Agent 在真实环境自主执行，不替代代码编辑器。
- **多接入面共享运行时**：`src/runtime/` 与传输层解耦，CLI / IPC / HTTP 三种接入面复用同一套 AgentLoop、工具、Hook、限速器、检查点。
- **multi-agent 工作流一等公民**：PM / Lead / Archivist 项目 agent、需求状态机、wiki 记忆节点是运行时原生能力，不靠 prompt 硬塞。
- **OpenPrd 管控**：仓库由 OpenPrd harness 管理，`docs/basic/` 是唯一基线文档路径，开发流程强约束通过 openprd 命令执行而非手动改文档。

## 依赖

**外部技术依赖**：

- **运行时**：Node.js >= 20.6.0、Electron 41.6.0。
- **AI 集成**：Vercel AI SDK（`ai`）、`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@ai-sdk/google`、`@modelcontextprotocol/sdk`。
- **存储**：`better-sqlite3`（原生模块，需 node-gyp 针对 Electron 版本编译）。
- **前端**：React 19、`react-dom`、`zustand`、`react-markdown` + `remark-gfm` + `rehype-raw`、`shiki`。
- **工具与协议**：`zod`、`typebox`、`jsdom`、`turndown`、`pdf-parse`、`uuid`、`undici`、`express`、`ws`、`mermaid`。

**仓库内依赖（分层）**：

- `src/renderer/` 依赖 `src/preload/`（IPC API）与 `src/shared/`（类型契约）。
- `src/main/` 依赖 `src/server/`（业务）与 `src/shared/`。
- `src/server/` 依赖 `src/runtime/`（运行时）、`src/core/`（配置与工具元数据）、`src/shared/`。
- `src/runtime/` 依赖 `src/core/`（工具注册、Hook 注册表、系统提示词），不依赖 `src/server/`（持久化通过 hook 回调注入）。
- `src/cli.ts` 依赖 `src/runtime/` + `src/core/` + `src/server/session-db.ts` + `src/server/provider-store.ts`，不依赖 Electron。

**工具链依赖**：`electron-vite`、`typescript`、`vite`、`electron-builder`、`tsx`、`vitest`、`playwright`、`node-gyp`、OpenPrd CLI（`openprd` 命令）。

## 维护规则

- **文档基线**：`docs/basic/` 是 OpenPrd 唯一认可的基线文档路径；新增 / 删除核心目录或文件后必须同步更新对应 `docs/basic/*.md`，章节标题需与 doctor 字面匹配。
- **OpenPrd 门禁**：freeze / handoff / commit / push / release / publish 前必须确保 `openprd standards . --verify`、`openprd quality . --verify`、`openprd run . --verify`、`openprd doctor .` 全部健康；`productionReady=false` 时不得宣称就绪。所有 OpenPrd 文档变更必须通过 openprd 命令完成，禁止手动编辑 `openprd/` 下的文档。
- **构建验证**：`electron-vite build` 不做 TS 类型检查，宣称完成前必须额外跑 `npm run build:lib`（tsc）确认无类型错误。
- **原生模块**：better-sqlite3 必须用 node-gyp 针对 Electron 41.6.0 重新编译；新增 `SqliteStore` 列时必须同步更新 `db-migration.ts` 的 `*_COLUMNS` 数组与建表语句，否则 fresh DB 会缺列。
- **运行时纪律**：所有功能必须通过 Hook 注册（PreLLMCall / PostTurnComplete 等），放 `src/runtime/hooks/` 下，禁止把功能代码内联进 `AgentLoop`。
- **不动他人代码**：不删除或 git checkout 恢复不是自己改动的代码；不相关文件被越权改动时告知用户处理，绝不自行 git checkout。
- **提交前**：每次提交前更新 `docs/` 文档（特别是 `code-graph.html`），并跑 `npm run check:handlers` 检查 IPC handler 模块依赖。
