# 项目文件结构

## 项目定位

zero-core 是基于 Electron 的 AI Agent 运行时，采用 main + preload + renderer + runtime + server 五层架构。

## 核心目录

- `src/core/` — 核心逻辑：配置（config, constants）、上下文管理、工具策略、系统提示词、Hook 注册表、日志、工具注册中心
- `src/main/` — Electron 主进程：入口、IPC 处理器（typed-ipc, 16 个 handler 模块）
- `src/preload/` — 预加载脚本：IPC API 暴露给渲染进程
- `src/renderer/` — React 前端：组件（10 个页面目录）、10 个 Zustand store、样式
- `src/runtime/` — Agent 运行时：核心循环、feature hooks、工具集、限速器、子任务委派、检查点
- `src/server/` — 服务层：Agent 服务、数据存储、REST 路由、MCP 管理、知识库
- `src/shared/` — 共享类型、IPC 契约、工具函数

## runtime/ 详细结构

- `agent-loop.ts` — 核心循环（LLM→tool→loop，不含功能逻辑）
- `hooks/` — 4 个 feature hook handler：compression-hooks、memory-hooks、rag-hooks、index
- `session.ts` — 会话消息和 token 管理
- `subagent-delegator.ts` — 子任务委派
- `checkpoint-manager.ts` — 对话检查点
- `tool-rate-limiter.ts` — per-tool FIFO 限速
- `turn-recorder.ts` — 流式输出记录
- `prompt-sections.ts` — 系统提示词组装
- `provider-factory.ts` — 模型解析
- `agent-utils.ts` — 错误分类和重试逻辑
- `tools/` — 17 个内置工具 + tool-factory + index
  - `outline/` — 代码大纲系统（27 种语言提取器 + renderer）
- `mcp-tools/` — 5 个内置 MCP 工具（assistant, browser-render, fetch, memory, sequential-thinking）

## server/ 详细结构

- 数据存储：AgentStore、AgentToolStore、ProviderStore、TemplateStore、McpStore、KbStore、SessionDB
- 基础设施：SqliteStore、db-migration、recovery、workspace-config、session-lifecycle
- 路由层：agent、agent-tool、config、mcp、provider、template、kb router
- 服务：agent-service、mcp-manager
- Hook 集成：tool-execution-hooks、durable-hooks、metrics-hooks
- 知识库：kb-db、kb-embeddings、kb-ingest、kb-search

## renderer/ 详细结构

- `components/` — 10 个页面目录：agents、chat、common、dashboard、kb、layout、mcp、settings、tools、workspace
- `store/` — 10 个 Zustand store：agent、agent-tool、chat、interaction、kb、mcp、page、provider、template、theme
- `styles/` — 全局样式 + 主题
- `types/` — 前端类型定义

## 文件组织规则

### 目录命名约定

- **层名固定**：`src/` 下只用 `core / main / preload / renderer / runtime / server / shared / cli` 这些层名，不再新增并列层；新功能必须归到既有层之下，不要在 `src/` 根开新顶层目录。
- **层内子目录按职责命名**：用业务或功能名（如 `agents/`、`tools/`、`hooks/`、`kb/`、`workflow/`），名称一律小写 + 连字符（kebab-case），如 `agent-loop.ts`、`tool-rate-limiter.ts`、`mcp-manager.ts`。
- **组件目录按页面/领域分**：`src/renderer/components/` 下每个目录对应一个页面或领域（agents、chat、dashboard、kb、layout、mcp、settings、tools、workspace、common），跨页面的共享组件放 `common/`。
- **Store 一文件一 store**：`src/renderer/store/` 下每个 Zustand store 一个文件，文件名 = store 名（如 `chat-store.ts`、`agent-store.ts`）。
- **服务层文件按 `<entity>-<role>.ts` 命名**：`<entity>-store.ts`（持久化）、`<entity>-router.ts`（HTTP 路由）、`<entity>-service.ts`（业务编排），便于从名字直接判断职责。

### 文件归属规则

| 文件类型 | 必须放在 | 不允许放 |
|---------|---------|---------|
| 与 Electron 主进程 / 窗口相关 | `src/main/` | `src/runtime/`、`src/server/` |
| IPC handler（`registerCrud`、`typed-ipc`） | `src/main/` 下对应 `*-handlers.ts` | `src/server/`（server 走 HTTP/WS，不走 IPC） |
| Agent 循环、工具、hook、限速器等运行时逻辑 | `src/runtime/` | `src/main/`、`src/server/` |
| 持久化 store、HTTP router、服务编排 | `src/server/` | `src/runtime/`（运行时不持有存储职责） |
| 跨层共享的 types、IPC 契约、工具函数 | `src/shared/` | 各层内部 |
| React 组件、Zustand store、前端样式 | `src/renderer/` | `src/main/`、`src/server/` |
| 工具元数据、工具 schema、配置常量 | `src/core/`（`tool-registry.ts`、`config.ts`、`constants.ts`） | 散落在各层 |

### 新增模块该放哪

- **新增内置工具**：实现在 `src/runtime/tools/<tool-name>/`（目录内含提取器、renderer），元数据注册在 `src/runtime/tools/index.ts` 的 `ALL_TOOLS`，并补 `src/runtime/tools/tool-factory.ts` 的 execute 包装。
- **新增 feature hook**：放 `src/runtime/hooks/`，在 `src/runtime/hooks/index.ts` 的 `registerAllRuntimeHooks` 中注册；不要内联到 `agent-loop.ts`。
- **新增持久化实体**：`<entity>-store.ts`（继承 `SqliteStore`）+ 在 `db-migration.ts` 的 `*_COLUMNS` 数组和建表语句里加列；新增 HTTP 端点同时建 `<entity>-router.ts` 并在 `src/server/index.ts` 挂载。
- **新增 IPC 通道**：在 `src/main/` 下对应 `*-handlers.ts` 用 `registerCrud` 注册，并在 `src/preload/` 暴露给渲染进程，契约类型放 `src/shared/`。
- **新增前端页面**：`src/renderer/components/<page>/` 建组件目录 + `src/renderer/store/<page>-store.ts`，在 `page-store.ts` 注册路由，在 `layout/IconSidebar.tsx` 加导航图标。
- **新增 MCP 工具**：`src/runtime/mcp-tools/`，内置 5 个 MCP 工具（assistant、browser-render、fetch、memory、sequential-thinking）放在此处，外部 MCP 由 `MCPManager` 动态加载。

## 维护规则

- 每次新增、删除、移动目录或核心文件后，必须检查并更新本文件
- 本文档只记录项目结构事实，不承载功能需求细节
