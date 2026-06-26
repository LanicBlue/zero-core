# 项目文件结构

> 本文只记录项目结构事实(目录布局 / 文件归属规则 / 命名约定),不承载功能需求细节。
> 所有数字均按当前 `src/` 实际目录树核对(v0.8,2026-06);架构/模块边界的深度解读见
> [`../arch/02-module-structure.md`](../arch/02-module-structure.md),
> 本文是它的"扁平化、给新人看的"目录速查表。

## 项目定位

zero-core 是基于 Electron 的通用 Agent 工作流平台,采用 **main + preload + renderer + runtime + server** 五层
架构,外加跨层 `shared/`。v0.8 起 server 是 main 进程 fork 出来的 **子进程**(better-sqlite3 ABI 隔离,
见 [`../arch/08-cross-cutting.md`](../arch/08-cross-cutting.md) §12),所以运行时实际有 **main / server /
renderer / runtime 四个独立 JS 上下文**。

## 核心目录(src/ 顶层)

| 层 | 当前职责 | 关键内容 |
|----|---------|---------|
| [`src/core/`](../../src/core/) | 跨层共享核心 | config / constants / system-prompt / tool-registry / tool-policy / hook-registry / context-manager / logger / persona / model-registry / encoding / **test-seed**(测试种子,ZERO_CORE_TEST_FIXTURE 门控) |
| [`src/main/`](../../src/main/) | Electron 主进程 | 入口 `index.ts`、后端子进程拉起 `backend-spawn.ts`、IPC 桥 `ipc-proxy.ts`、`test-setup.ts`(测试模式预加载) |
| [`src/preload/`](../../src/preload/) | 预加载脚本 | 单文件 `index.ts`,通过 contextBridge 把 IPC API 暴露给渲染进程 |
| [`src/renderer/`](../../src/renderer/) | React 前端 | **13 个页面目录** / **15 个 Zustand store** / styles / types / App |
| [`src/runtime/`](../../src/runtime/) | Agent 运行时 | 核心循环、feature hooks、工具集、限速器、子任务委派、wiki anchor 注入、context message |
| [`src/server/`](../../src/server/) | 服务层(后端子进程) | Agent 服务、数据存储(30+ store)、REST 路由、MCP 管理、知识库、wiki 骨架 |
| [`src/shared/`](../../src/shared/) | 跨层契约 | `ipc-api.ts`(IPC 契约)、`types.ts`、`preload-types.ts`、`file-utils.ts`、`github-template-utils.ts` |
| `src/backend.ts` / `src/serve.ts` / `src/cli.ts` / `src/index.ts` | 进程入口分支 | Electron 主、后端 server、CLI、shared root re-export |

> **层名固定规则**:不再新增 `src/` 顶层目录,新功能必须归到既有层之下。

## runtime/ 详细结构

`src/runtime/` 是 AgentLoop 的运行域,不持有存储职责(存储全在 server)。

### 顶层文件

- `agent-loop.ts` — 核心循环(LLM→tool→loop,功能逻辑全在 hook 里,见 [`../arch/03-runtime-engine.md`](../arch/03-runtime-engine.md))
- `agent-roles.ts` — Agent 角色定义(PM/Lead/Analyst/Architect/... 见 v0.8 RFC)
- `agent-utils.ts` — 错误分类和重试逻辑
- `checkpoint-manager.ts` — 对话检查点
- `compression-engine.ts` — 上下文压缩(三层渐进,见 [`../arch/06-knowledge-subsystems.md`](../arch/06-knowledge-subsystems.md))
- `concurrency-queue.ts` — 并发队列
- `context-message.ts` — context message 组装(`<context>` 块)
- `pending-responses.ts` — 流式响应缓冲
- `prompt-sections.ts` — 系统提示词分节组装
- `provider-concurrency-manager.ts` — provider 级并发管理
- `provider-factory.ts` — 模型 provider 解析
- `proxy-manager.ts` — 代理管理
- `mock-language-model.ts` — 测试用 mock provider(MiniMax 等)
- `session.ts` / `session-store-interface.ts` — 会话消息、token 管理 / store 接口
- `subagent-delegator.ts` — **当前**的子任务委派实现(`SubagentDelegator` 类,被 `agent-loop.ts` import)
- `subagent-delegation.ts` — **死代码**(v0.8 重构遗留,零 importer,删除候选;勿与 `subagent-delegator.ts` 混淆,见 [`../arch/12-glossary.md`](../arch/12-glossary.md))
- `task-registry.ts` — 后台任务注册表(供 TaskStatus/TaskList/TaskStop 查询)
- `terminal-adapter.ts` — 终端适配
- `tool-rate-limiter.ts` — per-tool FIFO 限速
- `transcript-delta.ts` — transcript 增量
- `turn-recorder.ts` — 流式输出 / turn 持久化
- `types.ts` — runtime 类型
- `wiki-anchor-injection.ts` — wiki anchor → system/context 注入(记忆主线的运行时入口)

### hooks/(7 个 feature hook handler)

> 注册中心是 `hooks/index.ts` 的 `registerAllRuntimeHooks()`(由 `agent-service.ts` 在启动时调用),
> **所有功能必须通过 hook 注册**,禁止内联到 `agent-loop.ts`(见项目 memory feedback-agent-loop-hooks-only)。

| hook handler | 触发点 | 作用 |
|------|------|------|
| `turn-hooks.ts` | PreLLMCall / PostTurnComplete | turn 持久化、turn_state 更新 |
| `notification-hooks.ts` | 多处 | agent:notification / step_failure / verification_failure 通知分发 |
| `rag-hooks.ts` | PreLLMCall | **legacy 可选** RAG 注入(默认不生效,需 ctx.getRagContext,见 [`../arch/06-knowledge-subsystems.md`](../arch/06-knowledge-subsystems.md) §3.2) |
| `provider-options-hooks.ts` | PreLLMCall | 按 provider 注入 options |
| `compression-hooks.ts` | PostTurnComplete | 触发上下文压缩,提取 memory 写 wiki |
| `todo-cleanup-hooks.ts` | PostTurnComplete | TodoWrite 残留清理 |
| `extraction-hooks.ts` | PostTurnComplete | ExtractorA/B 后台提取结构化记忆 → wiki |

> **v0.8 (P2 §11.6) 已删除** `memory-hooks.ts`(memory 合并到 wiki per-agent 子树),`registerMemoryHooks()` 不再调用。

### tools/(25 个内置工具 + 工具基础设施)

`tools/index.ts` 的 `ALL_TOOLS` 是唯一注册表(25 entries / 9 categories,见 [`../arch/04-tools-subsystem.md`](../arch/04-tools-subsystem.md) §3 矩阵)。**不是 17 个**,旧文档过时。

- 基础设施:`index.ts`(ALL_TOOLS + registerRuntimeTools + CONDITIONAL_TOOLS 门控)、`tool-factory.ts`(`buildTool` 包装层:PreToolUse 阻断 / rateLimiter / execute / PostToolUse+Failure hook / recordToolUsage 遥测 / truncateResult)、`file-read-helpers.ts`、`wiki-path-guard.ts`(反向拒绝 agent FS 工具碰 wiki 磁盘镜像根)
- 文件域:`bash.ts`(Shell)、`file-read.ts`(Read)、`file-write.ts`(Write)、`file-edit.ts`(Edit)、`glob.ts`(Glob)、`grep.ts`(Grep)、`syntax-check.ts`
- 任务域:`task-list.ts`(TaskList)、`task-status.ts`(TaskStatus)、`task-stop.ts`(TaskStop)、`wait.ts`(Wait)、`todo-write.ts`(TodoWrite)
- 交互/网络域:`ask-user.ts`(AskUser)、`web-search.ts`(WebSearch)、`fetch-tools.ts`(WebFetch,与 `mcp-tools/fetch-tools.ts` 共享)
- 子 Agent 委派域:`agent.ts`(Agent,action=list/delegate,v0.8 sessionId=undefined 隔离)
- 工作流域(v0.8):`orchestrate-tool.ts`(Orchestrate)、`requirement-tools.ts`(CreateRequirement + CreateRequirementWithDoc,PM-only)、`project-tool.ts`(Project,zero-only)、`agent-tool.ts`(AgentRegistry,zero-only,**注意与 `agent.ts` 的 `Agent` 同名陷阱**)、`cron-tool.ts`(Cron,zero-only)、`wiki-tool.ts`(Wiki)、`verify-tool.ts`(verify,lead-only)
- MCP/Platform 工具:`mcp-tool.ts`(动态 MCP 工具适配);Platform 工具由 `mcp-tools/platform-tools.ts` 的 `getPlatformTools()` 注入(内部 Assistant 等)
- `outline/` — 代码大纲系统:`extractors/`(27 种语言提取器)、`renderer.ts`、`stripper.ts`、`types.ts`

### mcp-tools/(6 个内置 MCP/Platform 工具文件)

| 文件 | 作用 |
|------|------|
| `browser-render.ts` | BrowserRender(headless 浏览器渲染) |
| `fetch-tools.ts` | WebFetch + cookie 处理(与 `tools/fetch-tools.ts` 路径关系见源码) |
| `cookie-jar.ts` | fetch 共享 cookie jar |
| `memory-tools.ts` | **legacy 未注册**(`MemoryRead`/`MemoryWrite`,v0.8 已退役,未进 ALL_TOOLS) |
| `platform-tools.ts` | `getPlatformTools()` → Platform 工具(redactSensitive 输出层) |
| `sequential-thinking-tools.ts` | SequentialThinking 工具 |

## server/ 详细结构

`src/server/` 是后端子进程的全部代码,30+ store + REST 路由 + 服务编排。**这是 v0.8 后变化最大的层**
(新增 9 张工作流域表 + 2 张 v0.8 M5 lazy store,见 [`../arch/05-persistence.md`](../arch/05-persistence.md))。

### 数据存储(按域分组)

**会话核心(SessionDB 自持,5 张表 + 6 个聚合 store)**:

- `session-db.ts` — SessionDB,会话核心聚合根(960 行,**不**聚合工作流域 store,见 05 §4.0.3)
- `message-store.ts` / `turn-recorder`(runtime) — messages / turns / turn_state / tool_executions
- `sqlite-store.ts` — SqliteStore 通用 CRUD 基类(列补齐 + JSON 序列化)
- `key-value-store.ts` — KeyValueStore(KV,SessionDB eager 聚合)
- `memory-node-store.ts` — MemoryNodeStore(legacy back-compat,wiki 不可用时压缩流程回退)
- `extraction-cursor-store.ts` — ExtractionCursorStore(**v0.8 M5 lazy**,不进 db-migration)
- `telemetry-store.ts` — TelemetryStore(**v0.8 M5 lazy**,tool_usage + tool_telemetry)

**旧业务实体(Agent/Provider/Template/MCP/KB)**:

- `agent-store.ts`、`provider-store.ts`、`template-store.ts`、`mcp-store.ts`、`persona-store.ts`
- KB:`kb-store.ts`、`kb-db.ts`、`kb-embeddings.ts`、`kb-ingest.ts`、`kb-search.ts`(本地文档 + chunk + embedding + cosine 检索,见 06 §3)
- `memory-store.ts` — legacy 实体-关系图谱 memory

**v0.8 工作流域(9 张表 + 对应 store,在 `server/index.ts` 独立 new,不挂 SessionDB)**:

- 项目域:`project-store.ts`(projects)、`project-job-store.ts`(project_jobs)、`project-wiki-store.ts`(project_wiki 兼容包装,内部委托 `wiki-node-store.ts`)
- 需求域:`requirement-store.ts`(requirements 主表)、`requirement-doc-store.ts`(需求文档)、`requirement-state-machine.ts`、`requirement-hooks.ts`(需求状态机 + 通知)
- 任务编排:`task-step-store.ts`(task_steps + history + messages)、`orchestrate-store.ts`(orchestrate_plans + manifests)
- 定时:`cron-store.ts`(crons + cron_runs)、`cron-analysis.ts`
- Wiki 镜像:`wiki-node-store.ts`(project_wiki 表 + **磁盘镜像树**,见 06 §2.5)、`wiki-scan-cursor-store.ts`(wiki_scan_cursors)、`wiki-skeleton-service.ts`(无 LLM 静态扫描器,建骨架,见 06 §2.6)、`archivist-git.ts`(git diff 增量)
- 工具遥测:`tool-usage-store.ts`(tool_usage)、`tool-execution-hooks.ts`、`tool-execution-router.ts`

> **`tool_usage` vs `tool_executions` 语义重叠**(都是工具调用日志,字段集不同)—— 见 TRACKER open question,待用户拍板是否合并。

### 路由层(`*-router.ts`,REST,挂载在 `server/index.ts`)

`agent-router.ts`、`chat-router.ts`、`config-router.ts`、`cron-router.ts`、`file-router.ts`、`kb-router.ts`、
`log-router.ts`、`mcp-router.ts`、`memory-node-router.ts`、`orchestrate-router.ts`、`project-router.ts`、
`project-wiki-router.ts`、`provider-router.ts`、`requirement-router.ts`、`session-router.ts`、
`session-context-router.ts`、`skill-router.ts`、`template-router.ts`、`tool-execution-router.ts`、`wiki-router.ts`。

> 渲染进程通过 `ipc-proxy.ts` 把这些 REST 路由派生为 IPC 通道(ROUTE_MAP,见 07 §2.5),不是手写 1:1 映射。

### 服务编排(`*-service.ts`,业务逻辑层)

- `agent-service.ts` — Agent / AgentLoop 生命周期 + 注册到主进程
- `analyst-service.ts`、`lead-service.ts`、`pm-service.ts`、`management-service.ts`、`notification-service.ts`、`extractor-a-service.ts`、`extractor-b-service.ts`、`enrichment-runner.ts`
- `mcp-manager.ts` — MCP server 生命周期 + 工具发现
- `mcp-scanner.ts`、`mcp-presets.ts`、`skill-scanner.ts`

### 基础设施

- `db-migration.ts` — 5 阶段迁移(列补齐 / v0.8 表 DDL / SqliteStore 构造 / JSON→SQLite / KV+Memory,见 05 §4.2)
- `recovery.ts` — 启动恢复
- `workspace-config.ts` — workspace 配置
- `session-lifecycle.ts`、`session-manager.ts`、`session-metrics.ts` — 会话生命周期 / 管理 / 指标
- `git-integration.ts` — git 集成
- `data-change-hub.ts` — renderer↔backend 数据变更推送 hub(见 07 §2.3.1)
- `durable-hooks.ts`、`metrics-hooks.ts`、`metrics-events.ts`、`workflow-context-hook.ts` — hook 集成
- `builtin-role-templates.ts` — v0.8 内置角色模板
- `fresh-db-seed.ts` — fresh DB 种子(含 `ensureWikiSkeleton()` + `migrateWikiDiskLayout()` 启动一次性迁移)
- `index.ts` — server 入口,**手动编排 12+ store 的 new 序列**(无 registry,见 05 §4.0.3 边界讨论)

## main/ 详细结构

v0.8 后 main 进程 **只有 4 个文件**(旧的"16 个 handler 模块"叙事已废,handler 全部下沉到 server REST + ipc-proxy 派生):

- `index.ts` — Electron 主进程入口(创建 BrowserWindow、注册 window:*/dialog:*/webfetch:login 等少数本地 ipcMain.handle、拉起后端子进程)
- `backend-spawn.ts` — 后端子进程拉起 + 自愈 + 优雅关闭(见 08 §12)
- `ipc-proxy.ts` — IPC 桥:维护 `IPC 通道 → REST 路由` 映射表 R(派生自源码正则),统一 `ipcMain.handle`,non-2xx reject(v0.8,见 07 §2.6)
- `test-setup.ts` — 测试模式(ZERO_CORE_TEST_FIXTURE)预加载,re-export `test-seed.ts` 的 `isTestMode` / `seedTestEnvironment` / `TestSeedResult`

## renderer/ 详细结构

### components/(13 个页面/领域目录)

`agents/`、`chat/`、`common/`(跨页共享)、`cron/`(v0.8)、`dashboard/`、`kb/`、`layout/`、`mcp/`、
`requirements/`(v0.8)、`settings/`、`skills/`(v0.8)、`tools/`、`wiki/`(v0.8)。

> v0.8 新增 4 个领域目录:cron / requirements / skills / wiki。旧文档的"10 个"已过时。

### store/(15 个 Zustand store)

`agent-store.ts`、`chat-store.ts`、`cron-store.ts`(v0.8)、`interaction-store.ts`、`kb-store.ts`、
`mcp-store.ts`、`notification-store.ts`(v0.8)、`page-store.ts`、`project-store.ts`(v0.8)、
`provider-store.ts`、`requirement-store.ts`(v0.8)、`template-store.ts`、`theme-store.ts`、
`wiki-store.ts`(v0.8)、`data-sync.ts`(v0.8 helper,非 store,见 07 §2.3.1)。

> 旧文档的"10 个 Zustand store"已过时(实际 14 store + 1 helper)。**一文件一 store** 规则继续生效。

### 其他

- `styles/` — 全局样式 + 主题
- `types/` — 前端类型定义
- `App.tsx` / `main.tsx` — React 根

## 文件组织规则

### 目录命名约定

- **层名固定**:`src/` 下只用 `core / main / preload / renderer / runtime / server / shared` 这些层名(+ 进程入口分支文件 `backend.ts` / `serve.ts` / `cli.ts` / `index.ts`),不再新增并列层;新功能必须归到既有层之下,不要在 `src/` 根开新顶层目录。
- **层内子目录按职责命名**:用业务或功能名(如 `agents/`、`tools/`、`hooks/`、`kb/`、`workflow/`),名称一律小写 + 连字符(kebab-case),如 `agent-loop.ts`、`tool-rate-limiter.ts`、`mcp-manager.ts`。
- **组件目录按页面/领域分**:`src/renderer/components/` 下每个目录对应一个页面或领域(见上方 13 个),跨页面的共享组件放 `common/`。
- **Store 一文件一 store**:`src/renderer/store/` 下每个 Zustand store 一个文件,文件名 = store 名(如 `chat-store.ts`、`agent-store.ts`)。helper 类(如 `data-sync.ts`)不算 store。
- **服务层文件按 `<entity>-<role>.ts` 命名**:`<entity>-store.ts`(持久化)、`<entity>-router.ts`(HTTP 路由)、`<entity>-service.ts`(业务编排)、`<entity>-hooks.ts`(hook 集成),便于从名字直接判断职责。

### 文件归属规则

| 文件类型 | 必须放在 | 不允许放 |
|---------|---------|---------|
| 与 Electron 主进程 / 窗口相关 | `src/main/` | `src/runtime/`、`src/server/` |
| IPC 通道派生(走 ipc-proxy 的 ROUTE_MAP) | `src/main/ipc-proxy.ts` 中的映射表 + 对应 `src/server/*-router.ts` | 手写 1:1 ipcMain.handle(派生方式见 07 §2.5) |
| Agent 循环、工具、hook、限速器等运行时逻辑 | `src/runtime/` | `src/main/`、`src/server/` |
| 持久化 store、HTTP router、服务编排 | `src/server/` | `src/runtime/`(运行时不持有存储职责) |
| 跨层共享的 types、IPC 契约、工具函数 | `src/shared/` | 各层内部 |
| React 组件、Zustand store、前端样式 | `src/renderer/` | `src/main/`、`src/server/` |
| 工具元数据、工具 schema、配置常量 | `src/core/`(`tool-registry.ts`、`config.ts`、`constants.ts`) | 散落在各层 |
| Feature hook handler | `src/runtime/hooks/` + `hooks/index.ts` 注册 | 内联到 `agent-loop.ts`(强制) |

### 新增模块该放哪

- **新增内置工具**:实现在 `src/runtime/tools/<tool-name>.ts`(目录式工具用 `tools/<name>/`),元数据注册在 `src/runtime/tools/index.ts` 的 `ALL_TOOLS`,`buildTool` 包装在 `tools/tool-factory.ts`(PreToolUse / rateLimiter / PostToolUse / 遥测自动接好);若需要 ctx 能力门控,补 `CONDITIONAL_TOOLS` 条件。
- **新增 feature hook**:放 `src/runtime/hooks/`,在 `src/runtime/hooks/index.ts` 的 `registerAllRuntimeHooks` 中按注册顺序敏感性注册;**不要内联到 `agent-loop.ts`**。
- **新增持久化实体**:`<entity>-store.ts`(继承 `SqliteStore`)+ 在 `db-migration.ts` 的 `*_COLUMNS` 数组和建表语句里加列(5 阶段迁移的"阶段 2"或"阶段 1 列补齐",取决于表是否 v0.8 工作流域);新增 HTTP 端点同时建 `<entity>-router.ts` 并在 `src/server/index.ts` 挂载 + (可选)在 `ipc-proxy.ts` 加 ROUTE_MAP 派生条目。**注意**:新 store 默认在 `server/index.ts` 独立 new(不挂 SessionDB),除非它属于会话核心 5 张表。
- **新增 IPC 通道**:优先复用 REST 派生(在 server 建 router + 在 ipc-proxy.ts 加映射);真正本地的(window:*/dialog:* 类)才在 `src/main/index.ts` 直接 `ipcMain.handle`,契约类型放 `src/shared/ipc-api.ts`,在 `src/preload/index.ts` 暴露给渲染进程。
- **新增前端页面**:`src/renderer/components/<page>/` 建组件目录 + `src/renderer/store/<page>-store.ts`,在 `page-store.ts` 注册路由,在 `layout/IconSidebar.tsx` 加导航图标。
- **新增 MCP 工具**:`src/runtime/mcp-tools/`,内置 Platform 工具(Platform / Assistant / BrowserRender / WebFetch / SequentialThinking)放在此处,外部 MCP 由 `MCPManager` 动态加载;若要进 ALL_TOOLS,在 `platform-tools.ts` 的 `getPlatformTools()` 里登记。

## 维护规则

- 每次新增、删除、移动目录或核心文件后,必须检查并更新本文件(尤其是计数:工具数、store 数、组件目录数、hook 数)。
- 本文档只记录项目结构事实,不承载功能需求细节 —— 功能/边界/动机看 `../arch/` 系列。
- 计数会随 v0.x 演进漂移,改之前用 `ls src/runtime/tools/*.ts | wc -l` 之类核对一遍,不要照抄本文。
