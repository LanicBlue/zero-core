// 代码架构图生成器
//
// # 文件说明书
//
// ## 核心功能
// 静态分析后端 TS 源码，提取大纲、调用图和导入关系，生成可视化 HTML
//
// ## 输入
// src/ 下所有 TypeScript 源码
//
// ## 输出
// docs/visualization/code-graph.html 自包含可视化页面
//
// ## 定位
// scripts/ — 构建脚本，生成架构文档
//
// ## 依赖
// typescript（TS AST 解析）
//
// ## 维护规则
// 源码结构变更后需重新运行此脚本
//
// Static analyzer: extract outline + call graph from backend TypeScript source.
//
// Scans src/{main,preload,runtime,server,core,shared}, builds:
//   - file outline (functions + class methods + line ranges)
//   - function-level call edges (resolved across files via imports)
//   - file-level import edges
//   - descriptions from JSDoc + curated annotations
//
// Emits a self-contained HTML at docs/visualization/code-graph.html.
//
// Run: npm run build:codegraph

import ts from "typescript";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCAN_DIRS = ["src/main", "src/preload", "src/runtime", "src/server", "src/core", "src/shared"];

// ============================================================
// Annotations: curated descriptions for modules and key files
// ============================================================

const MODULE_DESC: Record<string, string> = {
	"src/main": "Electron 主进程：入口、BrowserWindow、IPC handler 注册（14 个领域文件）、模块就绪管理",
	"src/preload": "Context Bridge：85 个 IPC 桥接方法 + 4 个事件订阅，连接 renderer ↔ main",
	"src/runtime": "Agent 运行时：单 turn 编排（AgentLoop）、Provider 工厂、工具系统（bash/read/write/edit/grep/glob/web-search/todo）、MCP tool 桥接、sub-agent 委派",
	"src/server": "持久化层：SQLite stores（10 个）、AgentService 全局调度、SessionManager 生命周期、MCP 客户端、DatabaseManager（plan-00 单一 DB 生命周期）、recovery",
	"src/core": "共享基础设施：配置、常量、文件日志、context 管理、工具策略、hook 注册、默认 prompt",
	"src/shared": "跨进程类型契约：IPC API 类型（85 channel）、业务模型（Agent/Provider/Session）、文件树类型",
};

const FILE_DESC: Record<string, string> = {
	// main
	"src/main/index.ts": "Electron 入口：app.whenReady → createWindow → registerIpc → loadCoreModules，Phase 0-6 启动",
	"src/main/ipc.ts": "主进程 IPC 入口：调用所有 register*Handlers 注册 14 个领域 handler",
	"src/main/ipc/core.ts": "核心 IPC：模块加载（loadCoreModules）、响应式 ctx 注入、模块就绪 gate、MCP reconnect、search provider 初始化",
	"src/main/ipc/typed-ipc.ts": "typedHandle 封装：类型安全 IPC handler 注册 + modules readiness gate + toFileURL 辅助",
	"src/main/ipc/types.ts": "IpcContext 类型定义：15 个模块字段的完整类型声明",
	"src/main/ipc/module-readiness.ts": "模块就绪追踪：whenReady / isModuleReady，per-module Promise gating",
	"src/main/ipc/chat-handlers.ts": "chat:send / chat:abort handler → agentService.sendPrompt / abort",
	"src/main/ipc/session-handlers.ts": "sessions:list/new/switch/activate/current/delete/metrics handler",
	"src/main/ipc/message-handlers.ts": "messages:clear/edit/delete handler → core-database CRUD + agentService.recreateLoop",
	"src/main/ipc/agent-handlers.ts": "agent CRUD handler（registerCrud 封装）",
	"src/main/ipc/provider-handlers.ts": "provider CRUD + provider:test-connection handler",
	"src/main/ipc/template-handlers.ts": "template CRUD handler",
	"src/main/ipc/github-template-handlers.ts": "GitHub template 预览 + import handler",
	"src/main/ipc/mcp-handlers.ts": "MCP server CRUD + tool 列表 handler",
	"src/main/ipc/search-provider-handlers.ts": "search provider get/set handler，运行时切换搜索后端",
	"src/main/ipc/config-handlers.ts": "config get/set + theme handler",
	"src/main/ipc/logs-handlers.ts": "日志配置 handler",
	"src/main/ipc/agent-tool-handlers.ts": "per-agent 工具配置的增删改查 handler",
	"src/main/ipc/dialog-handlers.ts": "系统对话框 handler（打开/保存文件、选择目录）",
	"src/main/ipc/file-handlers.ts": "文件系统操作 handler：目录树构建、文件读写",
	"src/main/ipc/log-handlers.ts": "日志文件读取、解析、配置 handler",
	"src/main/ipc/tool-handlers.ts": "工具列表查询、工具配置 handler",
	"src/main/test-setup.ts": "E2E 测试环境初始化：seed 测试 agent + mock provider + fixture 数据",
	// preload
	"src/preload/index.ts": "contextBridge 暴露 85 个 IPC 方法和 4 个事件订阅给 renderer",
	// runtime
	"src/runtime/agent-loop.ts": "AgentLoop 类：单 turn 执行（run/resume/executeStream），retry + exp backoff，context-length prune + retry，streaming event emit",
	"src/runtime/agent-utils.ts": "工具函数：classifyError / isTransientError / userFriendlyMessage / parseThinkingTags",
	"src/runtime/provider-factory.ts": "Provider 工厂：openai / anthropic / gemini / ollama / openai-compatible / mock，getContextWindow，model 缓存",
	"src/tools/index.ts": "工具注册中心：registerBuiltInTools，导出所有内置工具（bash/read/write/edit/grep/glob/web-search/todo/agent/ask-user）",
	"src/tools/agent-tool.ts": "AgentTool 基类：output truncation，max result size，tool result 格式化",
	"src/tools/bash-tool.ts": "Bash 执行工具：子进程 + timeout + max buffer + 输出截断",
	"src/tools/read-tool.ts": "文件读取工具：读取文件内容，行号范围",
	"src/tools/write-tool.ts": "文件写入工具：创建或覆盖文件",
	"src/tools/edit-tool.ts": "文件编辑工具：精确字符串替换",
	"src/tools/grep-tool.ts": "内容搜索工具：ripgrep 封装",
	"src/tools/glob-tool.ts": "文件搜索工具：glob 模式匹配",
	"src/tools/web-search.ts": "Web 搜索：DuckDuckGo（默认）/SearXNG/SerpAPI/Brave 四个 provider，运行时可切换，结果带摘要行",
	"src/tools/todo-write-tool.ts": "Todo 列表管理工具：创建/更新任务列表",
	"src/tools/agent-delegation-tool.ts": "Sub-agent 委派：blocking + auto-background 模式",
	"src/tools/tool-registry.ts": "ToolRegistry：工具注册中心，按名称查找，执行调度",
	"src/tools/tool-policy.ts": "ToolPolicy：白/黑名单过滤，控制可用工具集",
	"src/tools/bash.ts": "Bash 执行工具实现：子进程 + timeout + 输出截断 + 编码处理 + 执行计时 + 超时/错误含命令",
	"src/tools/glob.ts": "文件搜索工具实现：glob 模式匹配",
	"src/tools/grep.ts": "内容搜索工具实现：ripgrep 封装",
	"src/tools/file-read.ts": "文件读取工具实现：支持多种文件类型（文本/图片/PDF/Jupyter）",
	"src/tools/file-write.ts": "文件写入工具实现",
	"src/tools/file-edit.ts": "文件编辑工具实现：精确字符串替换 + buildNotFoundMessage 诊断（行数、部分匹配、CRLF/LF、Tab/空格）",
	"src/tools/file-read-helpers.ts": "文件读取辅助：类型检测、编码、PDF 提取、Jupyter 解析、相似文件推荐",
	"src/tools/ask-user.ts": "AskUser 工具：向用户提问并等待回复",
	"src/tools/agent.ts": "Agent 委派工具实现",
	"src/tools/mcp-tool.ts": "MCP 工具桥接：将 MCP server 工具适配为内置工具接口",
	"src/tools/tool-factory.ts": "工具工厂：根据配置构建工具实例，参数校验，结果截断",
	"src/tools/todo-write.ts": "Todo 列表管理工具实现",
	"src/tools/task-list.ts": "任务列表格式化输出",
	"src/tools/task-status.ts": "任务状态查询与格式化",
	"src/tools/task-stop.ts": "后台任务停止工具",
	"src/tools/wait.ts": "统一等待工具：定时唤醒 / 等待外部事件",
	"src/tools/syntax-check.ts": "语法检查工具：检测未闭合字符串等常见语法问题",
	"src/runtime/concurrency-queue.ts": "FIFO 信号量：控制每个 provider 的并发 API 请求数",
	"src/runtime/index.ts": "运行时入口：导出核心类型、函数和 AgentLoop 主类",
	"src/runtime/mock-language-model.ts": "E2E 测试用 mock 语言模型：可重放 fixture 定义的事件序列",
	"src/runtime/pending-responses.ts": "异步响应管理器：连接工具执行和用户响应，超时控制",
	"src/runtime/prompt-sections.ts": "系统提示词片段组装器：静态片段 + 动态片段，带缓存",
	"src/runtime/provider-concurrency-manager.ts": "多 provider 并发队列管理：动态 reconfigure 并发限制",
	"src/runtime/session-store-interface.ts": "会话持久化接口定义：session / turn 存储规范",
	"src/runtime/session.ts": "AgentSession：会话状态管理，消息历史，上下文窗口，prune + rebuild",
	"src/runtime/subagent-delegation.ts": "子 agent 委派工厂：blocking / auto-background 模式创建和管理子任务",
	"src/runtime/task-registry.ts": "任务注册表：跟踪运行中任务状态、进度、完成/失败/kill",
	"src/runtime/terminal-adapter.ts": "终端适配器：ANSI 颜色支持、流式输出格式化、AskUser 队列",
	"src/runtime/turn-recorder.ts": "对话轮次记录器：收集流式 chunk 并持久化到 DB",
	"src/runtime/types.ts": "运行时核心类型定义：流事件、配置、回调接口",
	"src/tools/mcp/assistant-tools.ts": "辅助工具集：最新日志查看、文件搜索、敏感信息脱敏",
	"src/tools/mcp/fetch-tools.ts": "网络请求工具：URL 获取 + HTML 转 Markdown",
	"src/tools/mcp/memory-tools.ts": "知识图谱记忆工具：读取/写入实体和关系",
	"src/tools/mcp/sequential-thinking-tools.ts": "顺序思考工具：逐步推理和思考链跟踪",
	"src/tools/outline/index.ts": "Outline 工具入口：按文件扩展名选择提取器，支持 27 种语言",
	"src/tools/outline/renderer.ts": "Outline 渲染器：将 AST 节点转为格式化文本输出",
	"src/tools/outline/stripper.ts": "代码剥离器：移除注释和字符串内容，减少噪音",
	"src/tools/outline/types.ts": "Outline 类型定义：OutlineNode, SymbolKind, ExtractionResult 等",
	"src/tools/outline/extractors/c-family.ts": "C/C++/ObjC outline 提取器",
	"src/tools/outline/extractors/css.ts": "CSS/SCSS/LESS outline 提取器",
	"src/tools/outline/extractors/dart.ts": "Dart outline 提取器",
	"src/tools/outline/extractors/elixir.ts": "Elixir outline 提取器",
	"src/tools/outline/extractors/go.ts": "Go outline 提取器",
	"src/tools/outline/extractors/graphql.ts": "GraphQL outline 提取器",
	"src/tools/outline/extractors/html.ts": "HTML outline 提取器",
	"src/tools/outline/extractors/ini.ts": "INI/TOML/YAML 配置文件 outline 提取器",
	"src/tools/outline/extractors/java.ts": "Java outline 提取器",
	"src/tools/outline/extractors/json.ts": "JSON outline 提取器：对象/数组结构解析",
	"src/tools/outline/extractors/kotlin.ts": "Kotlin outline 提取器",
	"src/tools/outline/extractors/lua.ts": "Lua outline 提取器",
	"src/tools/outline/extractors/markdown.ts": "Markdown outline 提取器：标题层级解析",
	"src/tools/outline/extractors/nim.ts": "Nim outline 提取器",
	"src/tools/outline/extractors/php.ts": "PHP outline 提取器",
	"src/tools/outline/extractors/protobuf.ts": "Protobuf outline 提取器",
	"src/tools/outline/extractors/python.ts": "Python outline 提取器：class/function/def 缩进块解析",
	"src/tools/outline/extractors/r-lang.ts": "R 语言 outline 提取器",
	"src/tools/outline/extractors/ruby.ts": "Ruby outline 提取器",
	"src/tools/outline/extractors/rust.ts": "Rust outline 提取器",
	"src/tools/outline/extractors/scala.ts": "Scala outline 提取器",
	"src/tools/outline/extractors/shell.ts": "Shell/Bash outline 提取器",
	"src/tools/outline/extractors/sql.ts": "SQL outline 提取器",
	"src/tools/outline/extractors/svelte.ts": "Svelte outline 提取器",
	"src/tools/outline/extractors/swift.ts": "Swift outline 提取器",
	"src/tools/outline/extractors/toml.ts": "TOML outline 提取器",
	"src/tools/outline/extractors/typescript.ts": "TypeScript/JSX outline 提取器：声明解析 + 块匹配",
	"src/tools/outline/extractors/vue.ts": "Vue SFC outline 提取器",
	"src/tools/outline/extractors/yaml.ts": "YAML outline 提取器",
	"src/tools/outline/extractors/zig.ts": "Zig outline 提取器",
	// server
	"src/server/agent-service.ts": "AgentService 类：全局调度入口，sendPrompt → createLoop → loop.run，session 管理，事件分发，recovery",
	"src/server/session-manager.ts": "SessionManager：session 生命周期状态机（created→streaming→disposed），TTL 清理，metrics hooks",
	"src/server/core-database.ts": "CoreDatabase（plan-00 改名自 SessionDB）：承载 sessions/agents/projects 等核心状态的 SQLite 持久化；CRUD（sessions/messages/steps/tool_executions/delegated_tasks/provider_usage）+ KV store",
	"src/server/database-manager.ts": "DatabaseManager（plan-00 §3）：服务端唯一的 DB 生命周期所有者，负责 sessions.db→db/core.db 布局 bootstrap、knowledge.db 退役删除、open/close/health/checkpointCore",
	"src/server/wiki-database.ts": "WikiDatabase 占位类型（plan-00 §3）；Plan-01 起替换为真实 class",
	"src/server/sqlite-store.ts": "SqliteStore 基类：通用 SQLite 表管理，ensureTable + self-heal（ALTER ADD COLUMN if missing）",
	"src/server/db-migration.ts": "数据库迁移：schema 初始化 + KV migration（每个独立 try/catch）",
	"src/server/recovery.ts": "Recovery：cleanOldTurnState + resume incomplete sessions，启动时调用",
	"src/server/mcp-manager.ts": "MCP 客户端管理：stdio + SSE 传输，启动 reconnect，tool 注册到 ToolRegistry",
	"src/server/agent-store.ts": "AgentStore：agent 配置持久化（SQLite）",
	"src/server/provider-store.ts": "ProviderStore：provider 配置持久化（SQLite）",
	"src/server/template-store.ts": "TemplateStore：agent 模板持久化（SQLite）",
	"src/server/mcp-store.ts": "McpStore：MCP server 配置持久化（SQLite）",
	"src/server/agent-tool-store.ts": "AgentToolStore：per-agent 工具配置持久化（SQLite）",
	"src/server/memory-store.ts": "MemoryStore：agent 记忆持久化（SQLite）",
	"src/server/key-value-store.ts": "KeyValueStore：通用 KV 持久化（SQLite）",
	"src/server/workspace-config.ts": "WorkspaceConfig：工作区配置持久化（searchProvider + workspaceDir）",
	"src/server/session-metrics.ts": "SessionMetrics：Welford 在线统计算法，RunningStats，per-session 指标收集",
	"src/server/agent-router.ts": "Agent CRUD 路由：create/read/update/delete agent 配置",
	"src/server/agent-tool-router.ts": "Agent 工具管理路由：per-agent 工具配置的 CRUD",
	"src/server/config-router.ts": "全局配置管理路由：read/update workspace 级配置",
	"src/server/durable-hooks.ts": "会话状态持久化钩子：turn 完成时自动保存到 DB",
	"src/server/index.ts": "服务器入口：初始化所有 store/service/router，HTTP API 模式启动",
	"src/server/mcp-servers/index.ts": "MCP 工具的向后兼容导出",
	"src/server/message-store.ts": "消息持久化存储：JSON 文件读写 + 迁移",
	"src/server/metrics-events.ts": "运行时事件到指标的适配器：将 agent 事件转为结构化指标",
	"src/server/metrics-hooks.ts": "会话生命周期指标钩子：token 用量、延迟、tool 调用统计",
	"src/server/persona-store.ts": "Persona 配置持久化：AI 角色定义的 CRUD（SQLite）",
	"src/server/provider-router.ts": "AI 提供商管理路由：CRUD + 连接测试 + model 管理",
	"src/server/session-lifecycle.ts": "会话状态机转换逻辑：created→streaming→disposed",
	"src/server/template-router.ts": "提示词模板管理路由：CRUD + 导入/导出 + GitHub 同步",
	// core
	"src/core/config.ts": "全局配置：ZERO_CORE_DIR，默认值，环境变量读取，deep merge",
	"src/core/constants.ts": "常量定义：EXEC_MAX_BUFFER_BYTES, OUTPUT_TRUNCATION_CHARS, DEFAULT_URLS, DEV_SERVER_URL",
	"src/core/logger.ts": "文件日志：多 category 写入，rotation，level 控制",
	"src/core/context-manager.ts": "ContextManager：token 估算，消息窗口管理，prune 策略（tail/smart/turn-boundary）",
	"src/core/tool-policy.ts": "核心工具策略：evaluateToolCall（批准/拒绝/转换），requiresApproval 判断",
	"src/core/hook-registry.ts": "HookRegistry：工具执行前后 hook 注册与触发",
	"src/core/default-prompt.ts": "默认 system prompt 模板生成",
	"src/core/compaction.ts": "上下文压缩策略：shouldCompact 判断 + 自定义压缩指令构建",
	"src/core/custom-tools.ts": "自定义工具注册表接口：运行时动态注册用户定义的工具",
	"src/core/device-context.ts": "设备信息采集：主机名、CPU、内存、GPU、磁盘、网络，生成设备上下文",
	"src/core/file-log-sink.ts": "文件日志 sink：按日轮转，结构化日志写入文件系统",
	"src/core/hook-types.ts": "Hook 类型定义：27 个事件名 + 基础上下文接口",
	"src/core/input-handler.ts": "用户输入预处理：斜杠命令展开、模板替换",
	"src/core/kv-store-interface.ts": "KV 持久化最小接口定义",
	"src/core/persona.ts": "AI 角色定义：风格、专长、工具策略，buildPersonaPrompt",
	"src/core/project-context.ts": "项目上下文扫描：package.json、目录结构、技术栈检测",
	"src/core/provider-adapter.ts": "Provider 适配器：根据厂商调整请求参数（如去除思考标签）",
	"src/core/system-prompt.ts": "系统提示词汇编：汇总设备/指南/技能/工具描述等各模块",
	"src/core/tool-registry.ts": "工具元数据注册表：分类管理、配置化、prompt 构建",
	// shared
	"src/shared/types.ts": "核心业务类型：AgentRecord, Provider, SearchProviderConfig, WorkspaceConfig, SessionState 等",
	"src/shared/ipc-api.ts": "IPC API 类型契约：85 个 channel 的参数 + 返回值类型定义",
	"src/shared/file-utils.ts": "FileTreeNode 类型 + 文件树构建工具",
	"src/shared/github-template-utils.ts": "GitHub 模板工具：frontmatter 解析、标签提取、Markdown 过滤",
	"src/shared/preload-types.ts": "Preload 桥接类型定义：renderer ↔ main 通信接口",
};

// Curated descriptions for functions without JSDoc.
// Keys match FunctionInfo.id format: "canonical-path/ClassName.methodName:line"
const FUNC_DESC: Record<string, string> = {
	// ── runtime/agent-loop.ts ──
	"src/runtime/agent-loop.ts/AgentLoop.constructor:54": "初始化会话、工具上下文、任务注册表和系统提示词分段",
	"src/runtime/agent-loop.ts/AgentLoop.run:285": "执行一次完整的用户消息到响应的循环，含重试和错误处理",
	"src/runtime/agent-loop.ts/AgentLoop.resume:392": "从中断点恢复执行，复用已有消息和录音器状态",
	"src/runtime/agent-loop.ts/AgentLoop.executeStream:478": "调用模型流式接口，处理文本/思考/工具事件并存盘",
	"src/runtime/agent-loop.ts/AgentLoop.abort:685": "中止当前正在运行的流式请求",
	"src/runtime/agent-loop.ts/AgentLoop.getState:689": "返回当前运行状态和工具调用信息",
	"src/runtime/agent-loop.ts/AgentLoop.getLoopState:697": "返回忙碌状态和录音器块快照",
	"src/runtime/agent-loop.ts/AgentLoop.getResult:704": "获取最近一次运行的结果文本",
	"src/runtime/agent-loop.ts/AgentLoop.resetSession:708": "清空会话消息并刷新提示词缓存",
	"src/runtime/agent-loop.ts/AgentLoop.sealStep:713": "封装当前步骤的文本和思考到录音器块",
	"src/runtime/agent-loop.ts/AgentLoop.saveUserTurn:715": "将用户消息持久化到 turns 表",
	"src/runtime/agent-loop.ts/AgentLoop.saveAssistantTurn:717": "将助手轮次持久化到 turns 表，增量更新或新增",
	"src/runtime/agent-loop.ts/AgentLoop.saveIncrementalCheckpoint:736": "每次工具结果后保存检查点消息和轮次以支持断点恢复",
	"src/runtime/agent-loop.ts/AgentLoop.emit:775": "向回调层发送事件并注入 sessionId",
	// ── runtime/agent-utils.ts ──
	"src/runtime/agent-utils.ts/classifyError:14": "根据错误信息将异常分类为超时、限流、认证等类型",
	"src/runtime/agent-utils.ts/isTransientError:28": "判断错误类型是否为可重试的瞬态错误",
	"src/runtime/agent-utils.ts/userFriendlyMessage:32": "将错误类型转换为用户友好的中文提示消息",
	"src/runtime/agent-utils.ts/parseThinkingTags:52": "从原始文本中解析 <think/> 标签，拆分为文本块和思考块",
	// ── runtime/provider-factory.ts ──
	"src/runtime/provider-factory.ts/normalizeName:14": "将名称转为小写并替换非字母数字为短横线",
	"src/runtime/provider-factory.ts/setConcurrencyManager:18": "设置全局并发管理器实例",
	"src/runtime/provider-factory.ts/resolveModel:20": "根据配置解析模型实例，可选包装并发队列",
	"src/runtime/provider-factory.ts/getContextWindow:86": "获取指定提供商模型的上下文窗口大小",
	"src/runtime/provider-factory.ts/getOrCreateProvider:98": "按类型创建或复用缓存的 AI 提供商工厂",
	"src/runtime/provider-factory.ts/clearProviderCache:140": "清空所有缓存的提供商实例",
	// ── runtime/concurrency-queue.ts ──
	"src/runtime/concurrency-queue.ts/ConcurrencyQueue.constructor:15": "初始化 FIFO 信号量并设置最大并发数",
	"src/runtime/concurrency-queue.ts/ConcurrencyQueue.acquire:19": "获取一个并发槽位，满则排队等待",
	"src/runtime/concurrency-queue.ts/ConcurrencyQueue.release:62": "释放一个并发槽位并唤醒下一个等待者",
	"src/runtime/concurrency-queue.ts/ConcurrencyQueue.setMax:70": "动态调整最大并发数并立即释放多余的排队者",
	"src/runtime/concurrency-queue.ts/ConcurrencyQueue.getActiveCount:78": "返回当前活跃的并发数",
	"src/runtime/concurrency-queue.ts/ConcurrencyQueue.getWaitingCount:79": "返回当前排队等待的数量",
	// ── runtime/mock-language-model.ts ──
	"src/runtime/mock-language-model.ts/loadFixture:23": "从 JSON 文件加载模拟响应的 fixture 数据",
	"src/runtime/mock-language-model.ts/toStreamPart:30": "将 fixture chunk 转换为 AI SDK 流式事件列表",
	"src/runtime/mock-language-model.ts/createMockLanguageModel:62": "创建一个按 fixture 回放响应的模拟语言模型",
	// ── runtime/pending-responses.ts ──
	"src/runtime/pending-responses.ts/PendingResponseManager.createRequest:15": "创建一个带超时的等待用户响应的 Promise",
	"src/runtime/pending-responses.ts/PendingResponseManager.resolveRequest:28": "用用户的回答来 resolve 指定请求",
	"src/runtime/pending-responses.ts/PendingResponseManager.rejectRequest:37": "以错误原因 reject 指定请求",
	"src/runtime/pending-responses.ts/PendingResponseManager.has:46": "检查指定请求是否仍在等待中",
	"src/runtime/pending-responses.ts/PendingResponseManager.size:50": "返回当前等待中的请求数量",
	// ── runtime/prompt-sections.ts ──
	"src/runtime/prompt-sections.ts/SystemPromptAssembler.constructor:25": "初始化分段列表和缓存",
	"src/runtime/prompt-sections.ts/SystemPromptAssembler.assemble:27": "按分段组装系统提示词，缓存稳定部分",
	"src/runtime/prompt-sections.ts/SystemPromptAssembler.invalidate:42": "清除指定或全部分段的缓存",
	// ── runtime/provider-concurrency-manager.ts ──
	"src/runtime/provider-concurrency-manager.ts/ProviderConcurrencyManager.getQueue:12": "获取指定提供商的并发队列",
	"src/runtime/provider-concurrency-manager.ts/ProviderConcurrencyManager.reconfigure:16": "根据新配置重建或调整各提供商的并发队列",
	"src/runtime/provider-concurrency-manager.ts/ProviderConcurrencyManager.clear:41": "清除所有并发队列",
	// ── runtime/session.ts ──
	"src/runtime/session.ts/AgentSession.constructor:15": "初始化会话消息列表，从数据库恢复历史消息",
	"src/runtime/session.ts/AgentSession.getSessionId:34": "返回当前会话 ID",
	"src/runtime/session.ts/AgentSession.getSystemPrompt:38": "返回系统提示词",
	"src/runtime/session.ts/AgentSession.getMessages:42": "返回当前消息列表",
	"src/runtime/session.ts/AgentSession.addMessage:46": "追加一条消息到列表",
	"src/runtime/session.ts/AgentSession.saveToDb:50": "将当前消息持久化到数据库",
	"src/runtime/session.ts/AgentSession.pruneIfNeeded:56": "超出上下文窗口时从旧消息开始裁剪",
	"src/runtime/session.ts/AgentSession.aggressivePrune:79": "按给定比例激进裁剪消息以释放上下文空间",
	"src/runtime/session.ts/AgentSession.rebuildFromTurns:92": "从 turns 表重建消息列表，用于消息缓存丢失时恢复",
	"src/runtime/session.ts/AgentSession.appendAssistantMessages:113": "将助手轮次的工具调用和文本块转为 AI SDK 消息格式",
	"src/runtime/session.ts/AgentSession.reset:153": "清空所有消息",
	"src/runtime/session.ts/AgentSession.estimateTokens:157": "估算当前所有消息的 token 总数",
	"src/runtime/session.ts/AgentSession.estimateMessageTokens:165": "按 JSON 长度粗略估算单条消息的 token 数",
	"src/runtime/session.ts/AgentSession.normalizeMessages:175": "将消息中的 args/input/output 格式统一为 AI SDK v6 标准",
	// ── runtime/subagent-delegation.ts ──
	"src/runtime/subagent-delegation.ts/createSubagentDelegation:34": "创建子代理委派函数集合，注入所有依赖",
	"src/runtime/subagent-delegation.ts/delegateTask:41": "阻塞式执行子代理任务，支持超时后自动转后台",
	"src/runtime/subagent-delegation.ts/delegateTaskBackground:135": "非阻塞式派发子代理任务并立即返回任务 ID",
	"src/runtime/subagent-delegation.ts/getTaskResult:215": "查询指定任务的执行信息",
	"src/runtime/subagent-delegation.ts/listTasks:219": "按状态过滤列出所有任务",
	"src/runtime/subagent-delegation.ts/stopTask:223": "终止指定任务的执行",
	"src/runtime/subagent-delegation.ts/suspendUntilWake:227": "挂起当前执行直到任务完成或超时",
	"src/runtime/subagent-delegation.ts/runBackground:235": "后台启动一个 shell 命令并注册为任务",
	// ── runtime/task-registry.ts ──
	"src/runtime/task-registry.ts/TaskRegistry.create:8": "创建一个新的后台任务记录",
	"src/runtime/task-registry.ts/TaskRegistry.updateProgress:22": "更新运行中任务的步骤进度和当前工具名",
	"src/runtime/task-registry.ts/TaskRegistry.complete:29": "标记任务为已完成并记录结果",
	"src/runtime/task-registry.ts/TaskRegistry.fail:40": "标记任务为失败并记录错误信息",
	"src/runtime/task-registry.ts/TaskRegistry.kill:51": "强制中止运行中的任务",
	"src/runtime/task-registry.ts/TaskRegistry.get:66": "按 ID 查询任务信息",
	"src/runtime/task-registry.ts/TaskRegistry.list:70": "按状态过滤返回任务列表",
	"src/runtime/task-registry.ts/TaskRegistry.getCompletedUnnotified:77": "获取所有已完成但尚未通知的任务",
	"src/runtime/task-registry.ts/TaskRegistry.markNotified:87": "将指定任务标记为已通知",
	"src/runtime/task-registry.ts/TaskRegistry.suspendUntilWake:92": "挂起调用者直到指定任务完成或超时，返回摘要",
	"src/runtime/task-registry.ts/TaskRegistry.generateSummary:124": "生成运行中和已完成任务的文本摘要",
	"src/runtime/task-registry.ts/TaskRegistry.tryWake:148": "如果存在等待回调则立即触发",
	"src/runtime/task-registry.ts/TaskRegistry.cleanup:155": "清理超过最大保留时间的已完成任务",
	// ── runtime/terminal-adapter.ts ──
	"src/runtime/terminal-adapter.ts/truncate:18": "将文本截断到指定最大长度并加省略号",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.constructor:34": "初始化终端适配器并绑定 readline 接口",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.handleEvent:38": "将流式事件翻译为终端输出（工具状态、文本、错误等）",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.flushText:128": "将缓存的流式文本刷新到终端输出",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.handleAskUser:135": "将用户提问事件加入队列逐个处理",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.processAskQueue:147": "串行处理用户提问队列",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.doAskUser:160": "在终端显示问题并收集用户的选择或文本回答",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.readlineQuestion:198": "通过 readline 异步获取用户输入",
	"src/runtime/terminal-adapter.ts/TerminalAdapter.close:206": "关闭前刷新剩余文本",
	// ── runtime/turn-recorder.ts ──
	"src/runtime/turn-recorder.ts/TurnRecorder.addTextDelta:25": "记录一段文本增量",
	"src/runtime/turn-recorder.ts/TurnRecorder.addThinkingDelta:30": "记录一段思考增量",
	"src/runtime/turn-recorder.ts/TurnRecorder.addToolStart:35": "记录工具调用开始并封装之前的文本/思考",
	"src/runtime/turn-recorder.ts/TurnRecorder.addToolResult:41": "记录工具调用的成功结果",
	"src/runtime/turn-recorder.ts/TurnRecorder.addToolError:50": "记录工具调用的错误结果",
	"src/runtime/turn-recorder.ts/TurnRecorder.sealStep:59": "将当前步骤累积的文本和思考刷新为块记录",
	"src/runtime/turn-recorder.ts/TurnRecorder.saveUserTurn:77": "将用户轮次追加到数据库 turns 表",
	"src/runtime/turn-recorder.ts/TurnRecorder.reset:88": "重置录音器状态以开始新一轮",
	"src/runtime/turn-recorder.ts/TurnRecorder.getToolCalls:95": "返回所有工具调用块的快照列表",
	"src/runtime/turn-recorder.ts/TurnRecorder.findRunningTool:106": "从后往前查找最近一个指定名称的运行中工具块",
	// ── tools/index.ts ──
	"src/tools/index.ts/getAssistantTools:29": "懒加载并缓存 Assistant 工具实例",
	"src/tools/index.ts/registerRuntimeTools:76": "将所有内置工具注册到全局 ToolRegistry",
	"src/tools/index.ts/buildToolsSet:99": "根据策略构建当前请求可用的工具集",
	"src/tools/index.ts/getToolCategories:185": "返回按类别分组的工具名映射表",
	"src/tools/index.ts/getAllToolInfo:198": "返回所有工具的元信息摘要列表",
	"src/tools/index.ts/buildToolPolicyDescription:216": "生成描述当前工具启用/禁用/读写权限的文本",
	// ── tools/agent-tool.ts ──
	"src/tools/agent-tool.ts/kebabCase:18": "将字符串转为 kebab-case 格式",
	"src/tools/agent-tool.ts/resolveTemplate:25": "替换模板中的 {{task}} 占位符",
	"src/tools/agent-tool.ts/resolveArgsTemplate:29": "解析模板并按引号规则拆分为参数数组",
	"src/tools/agent-tool.ts/truncateResult:47": "将过长的结果文本截断并附加截断提示",
	"src/tools/agent-tool.ts/buildAgentTools:52": "根据配置条目构建内部/CLI/HTTP 三类代理工具",
	// ── tools/bash.ts ──
	"src/tools/bash.ts/decodeOutput:9": "解码命令输出，尝试 GBK 到 UTF-8 转换以兼容 Windows",
	"src/tools/bash.ts/bashTool.execute:58": "执行 shell 命令：测量耗时追加 [Completed in Xs]，超时/错误含命令信息",
	// ── tools/file-read.ts ──
	"src/tools/file-read.ts/resolvePath:18": "将文件路径解析为绝对路径并可选限制在工作区内",
	// ── tools/grep.ts ──
	"src/tools/grep.ts/grepTool.execute:40": "使用 ripgrep 执行文件内容搜索，支持多种输出模式和过滤",
	"src/tools/file-edit.ts/buildNotFoundMessage:67": "构建 'text not found' 诊断消息：行数统计、部分匹配上下文、CRLF/LF 和 Tab/空格检测",
	// ── tools/web-search.ts ──
	"src/tools/web-search.ts/DuckDuckGoProvider.search:29": "通过 DuckDuckGo Lite HTML 页面执行搜索并解析结果",
	"src/tools/web-search.ts/SearXNGProvider.constructor:85": "初始化 SearXNG 自托管搜索引擎客户端",
	"src/tools/web-search.ts/SearXNGProvider.search:89": "调用 SearXNG JSON API 执行搜索",
	"src/tools/web-search.ts/SerpAPIProvider.constructor:120": "初始化 SerpAPI 搜索客户端",
	"src/tools/web-search.ts/SerpAPIProvider.search:124": "调用 SerpAPI Google 引擎执行搜索",
	"src/tools/web-search.ts/BraveSearchProvider.constructor:149": "初始化 Brave Search 搜索客户端",
	"src/tools/web-search.ts/BraveSearchProvider.search:157": "调用 Brave Search API 执行搜索",
	"src/tools/web-search.ts/createSearchProvider:187": "按配置类型创建对应的搜索引擎提供者实例",
	"src/tools/web-search.ts/setSearchProvider:211": "替换当前全局搜索引擎实例",
	"src/tools/web-search.ts/getSearchProvider:215": "返回当前全局搜索引擎实例",
	"src/tools/web-search.ts/webSearchTool.execute:248": "执行搜索并以 Found N results for: query 格式输出结果摘要",
	"src/tools/web-search.ts/decodeHTMLEntities:276": "将 HTML 实体和标签解码为纯文本",
	// ── tools/todo-write.ts ──
	"src/tools/todo-write.ts/getSessionTodos:40": "获取指定 session 的任务列表(按 sessionId 隔离)",
	"src/tools/todo-write.ts/clearSessionTodos:44": "清除指定 session 的任务列表",
	// ── tools/agent.ts ──
	"src/tools/agent.ts/delegateTool.execute:20": "根据模式选择阻塞或非阻塞方式委派子代理任务",
	// ── tools/mcp-tool.ts ──
	"src/tools/mcp-tool.ts/createMcpTool:8": "从 MCP 工具定义创建 AI SDK 兼容的工具实例",
	"src/tools/mcp-tool.ts/inputSchemaToZod:40": "将 MCP JSON Schema 转换为 Zod schema",
	"src/tools/mcp-tool.ts/propToZod:62": "将单个 JSON Schema 属性映射为对应的 Zod 类型",
	"src/tools/mcp-tool.ts/buildMcpTools:84": "批量构建 MCP 工具映射表",
	// ── tools/tool-factory.ts ──
	"src/tools/tool-factory.ts/truncateResult:43": "超过最大长度时截断结果并附加截断说明",
	"src/tools/tool-factory.ts/buildTool:63": "包装 AI SDK tool() 添加元数据、钩子和结果截断",
	"src/tools/tool-factory.ts/getToolMeta:154": "从工具对象读取元数据",
	"src/tools/tool-factory.ts/getToolName:158": "从工具对象读取工具名称",
	"src/tools/tool-factory.ts/getToolDescription:162": "从工具对象读取短描述",
	"src/tools/tool-factory.ts/getToolPrompt:166": "从工具对象读取完整提示词",
	"src/tools/tool-factory.ts/getToolConfigSchema:170": "从工具对象读取配置 schema",
	// ── tools/task-list.ts ──
	"src/tools/task-list.ts/formatTask:5": "将任务信息格式化为可读的单行文本",
	// ── tools/task-status.ts ──
	"src/tools/task-status.ts/formatTurn:5": "将单条 turn 格式化为截断后的可读文本",
	"src/tools/task-status.ts/taskStatusTool.execute:48": "查询任务状态并展示最近的会话活动记录",
	// ── tools/task-stop.ts ──
	"src/tools/task-stop.ts/taskStopTool.execute:13": "验证任务存在且运行中后执行停止操作",
	// ── tools/wait.ts ──
	"src/tools/wait.ts/waitTool.execute:16": "挂起执行等待后台任务完成或超时",
	// ── tools/syntax-check.ts ──
	"src/tools/syntax-check.ts/checkSyntax:33": "检查源代码的括号匹配和未闭合字符串问题",
	"src/tools/syntax-check.ts/checkUnterminatedStrings:79": "检查 C 风格语言中未闭合的引号字符串",
	"src/tools/syntax-check.ts/formatDiagnostics:117": "将语法诊断信息格式化为可读的警告文本",
	// ── tools/file-read-helpers.ts ──
	"src/tools/file-read-helpers.ts/detectFileType:34": "根据文件扩展名判断文件类型（二进制/图片/PDF/笔记本/文本）",
	"src/tools/file-read-helpers.ts/decodeBuffer:47": "自动检测编码并解码文件内容为 UTF-8 字符串",
	"src/tools/file-read-helpers.ts/normalizeLineEndings:66": "将 CRLF 统一为 LF 换行",
	"src/tools/file-read-helpers.ts/formatImageInfo:74": "生成图片文件的基本信息描述",
	"src/tools/file-read-helpers.ts/extractPdfText:85": "从 PDF 文件中提取可读文本内容",
	"src/tools/file-read-helpers.ts/parseJupyterNotebook:111": "解析 Jupyter 笔记本文件并格式化输出代码和结果",
	"src/tools/file-read-helpers.ts/parsePageRange:160": "解析页码范围字符串为起止索引",
	"src/tools/file-read-helpers.ts/suggestSimilarFiles:172": "当文件不存在时推荐名称相似的候选文件",
	"src/tools/file-read-helpers.ts/similarity:192": "计算两个字符串的字符级相似度分数",
	"src/tools/file-read-helpers.ts/formatBytes:207": "将字节数格式化为人类可读的大小字符串",
	// ── tools/outline/ ──
	"src/tools/outline/index.ts/extractOutline:176": "根据文件扩展名选择提取器并生成代码大纲",
	"src/tools/outline/index.ts/getExtension:191": "从文件路径中提取扩展名，处理 .env 特殊情况",
	"src/tools/outline/index.ts/fallbackExtract:200": "无专用提取器时按空行分段生成基本大纲",
	"src/tools/outline/renderer.ts/renderOutline:15": "将大纲树渲染为带行号和缩进的文本，按预算控制展开深度",
	"src/tools/outline/renderer.ts/countAllNodes:96": "递归统计大纲树中所有节点数",
	"src/tools/outline/renderer.ts/expandChildren:105": "将子节点展开为渲染条目列表",
	"src/tools/outline/renderer.ts/expandPriority:115": "根据节点类型返回展开优先级分数",
	"src/tools/outline/renderer.ts/mergeImports:125": "合并连续的 import 节点以减少输出行数",
	"src/tools/outline/renderer.ts/fmtLine:159": "格式化单个大纲节点为一行带缩进的文本",
	"src/tools/outline/renderer.ts/shortKind:171": "将节点类型缩写为短标签",
	"src/tools/outline/renderer.ts/formatDetail:189": "生成节点的补充详情文本",
	"src/tools/outline/stripper.ts/stripComments:25": "去除源代码中的注释和字符串内容，保留行号结构",
	// ── tools/mcp/ ──
	"src/tools/mcp/assistant-tools.ts/getLatestLogFile:16": "查找日志目录中最新的日志文件",
	"src/tools/mcp/assistant-tools.ts/redactSensitive:30": "递归遮蔽对象中的 API key、密码等敏感字段",
	"src/tools/mcp/assistant-tools.ts/createAssistantTools:41": "创建应用诊断工具，支持版本/日志/配置/源码/提供商/文件查询",
	"src/tools/mcp/fetch-tools.ts/fetchUrl:11": "使用模拟浏览器 UA 获取指定 URL 的响应",
	"src/tools/mcp/fetch-tools.ts/htmlToText:19": "去除 HTML 中的 script/style 标签并提取纯文本",
	"src/tools/mcp/memory-tools.ts/getMemoryStore:4": "从数据库上下文中获取记忆存储实例",
	"src/tools/mcp/sequential-thinking-tools.ts/sequentialThinkingTool.execute:22": "追加一条思考到链中并返回推理进度",
	// ── server/agent-service.ts ──
	"src/server/agent-service.ts/AgentService.constructor:76": "初始化 AgentService 并创建数据库和工具注册表",
	"src/server/agent-service.ts/AgentService.getDB:86": "获取底层数据库实例",
	"src/server/agent-service.ts/AgentService.setWorkspaceDir:90": "更新工作区目录并清除旧的运行循环",
	"src/server/agent-service.ts/AgentService.setProviders:97": "设置 AI 提供商配置并重建并发管理器",
	"src/server/agent-service.ts/AgentService.setAgentStore:107": "注入 Agent 存储实例",
	"src/server/agent-service.ts/AgentService.setAgentToolStore:111": "注入 Agent 工具存储实例",
	"src/server/agent-service.ts/AgentService.setSessionManager:115": "注入会话管理器并创建指标适配器",
	"src/server/agent-service.ts/AgentService.getSessionManager:120": "获取当前会话管理器实例",
	"src/server/agent-service.ts/AgentService.getActiveSessionsMap:124": "获取 agentId 到 sessionId 的活跃会话映射",
	"src/server/agent-service.ts/AgentService.evictSessionFromMemory:128": "从内存中驱逐指定会话的运行循环",
	"src/server/agent-service.ts/AgentService.subscribe:137": "订阅流式事件并返回取消订阅函数",
	"src/server/agent-service.ts/AgentService.getState:144": "获取指定 agent 或首个繁忙 agent 的运行状态",
	"src/server/agent-service.ts/AgentService.getAllStates:160": "获取所有 agent 的运行状态快照",
	"src/server/agent-service.ts/AgentService.isAnyBusy:168": "检查是否有任何 agent 正在执行",
	"src/server/agent-service.ts/AgentService.recreateLoop:196": "为指定会话重建或复用 AgentLoop 实例",
	"src/server/agent-service.ts/AgentService.sendPrompt:296": "向指定 agent 发送用户提示并执行对话",
	"src/server/agent-service.ts/AgentService.abort:328": "中止指定 agent 或所有繁忙 agent 的运行",
	"src/server/agent-service.ts/AgentService.recoverIncompleteSessions:341": "恢复上次中断的会话轮次",
	"src/server/agent-service.ts/AgentService.activateSession:408": "激活指定 agent 的会话并推送初始消息",
	"src/server/agent-service.ts/AgentService.dispose:503": "释放所有资源并关闭数据库连接",
	"src/server/agent-service.ts/createAgentService:582": "工厂函数创建 AgentService 实例",
	"src/server/agent-service.ts/registerAgentToolEntries:586": "将 agent 工具条目注册到工具注册表",
	// ── server/session-manager.ts ──
	"src/server/session-manager.ts/SessionManager.constructor:61": "初始化会话管理器并设置配置和回调",
	"src/server/session-manager.ts/SessionManager.setSessionDb:67": "注入会话数据库实例",
	"src/server/session-manager.ts/SessionManager.trackSessionCreated:71": "追踪会话创建事件",
	"src/server/session-manager.ts/SessionManager.trackSessionActivated:79": "追踪会话激活事件并切换到 idle 状态",
	"src/server/session-manager.ts/SessionManager.trackSessionIdle:111": "追踪会话轮次完成并记录延迟指标",
	"src/server/session-manager.ts/SessionManager.trackSessionDisposed:171": "追踪会话销毁事件并清理计时状态",
	"src/server/session-manager.ts/SessionManager.getSessionState:181": "获取指定会话的生命周期状态",
	"src/server/session-manager.ts/SessionManager.isSessionActive:185": "检查指定会话是否仍然活跃",
	"src/server/session-manager.ts/SessionManager.getActiveSessionCount:190": "获取未销毁的活跃会话总数",
	"src/server/session-manager.ts/SessionManager.getBusySessionCount:198": "获取当前正在执行任务的会话数",
	"src/server/session-manager.ts/SessionManager.recordFirstTokenLatency:208": "记录首次 token 延迟指标",
	"src/server/session-manager.ts/SessionManager.recordToolCall:220": "记录工具调用的执行指标",
	"src/server/session-manager.ts/SessionManager.recordRetry:231": "记录重试次数",
	"src/server/session-manager.ts/SessionManager.recordTokenEstimate:236": "记录估算的 token 用量",
	"src/server/session-manager.ts/SessionManager.recordTokenUsage:243": "记录精确的 token 用量",
	"src/server/session-manager.ts/SessionManager.getSessionMetrics:250": "获取指定会话的指标快照",
	"src/server/session-manager.ts/SessionManager.getAllSessionMetrics:254": "获取所有会话的指标快照映射",
	"src/server/session-manager.ts/SessionManager.getAggregateMetrics:262": "获取全局聚合指标",
	"src/server/session-manager.ts/SessionManager.startTtlCleanup:310": "启动会话 TTL 定时清理任务",
	"src/server/session-manager.ts/SessionManager.stopTtlCleanup:316": "停止会话 TTL 定时清理任务",
	"src/server/session-manager.ts/SessionManager.dispose:369": "释放所有资源并清理状态",
	// ── server/db-migration.ts ──
	"src/server/db-migration.ts/runMigrations:67": "执行启动时的数据库列迁移和 JSON 文件迁移",
	// ── server/recovery.ts ──
	"src/server/recovery.ts/scanIncompleteTurns:10": "扫描中断的轮次并清理过期状态记录",
	// ── server/mcp-manager.ts ──
	"src/server/mcp-manager.ts/MCPManager.constructor:36": "初始化 MCP 管理器",
	"src/server/mcp-manager.ts/MCPManager.connect:40": "连接到 MCP 服务器并注册其工具",
	"src/server/mcp-manager.ts/MCPManager.disconnect:121": "断开 MCP 服务器连接并注销工具",
	"src/server/mcp-manager.ts/MCPManager.disconnectAll:145": "断开所有 MCP 服务器连接",
	"src/server/mcp-manager.ts/MCPManager.callTool:150": "通过 MCP 协议调用远程工具",
	"src/server/mcp-manager.ts/MCPManager.getToolsForAgent:164": "获取指定 agent 可用的 MCP 工具列表",
	"src/server/mcp-manager.ts/MCPManager.getConnectedServers:181": "获取所有已连接服务器的状态列表",
	"src/server/mcp-manager.ts/MCPManager.isConnected:194": "检查指定服务器是否已连接",
	"src/server/mcp-manager.ts/MCPManager.testConnection:198": "测试 MCP 服务器连接后自动断开",
	"src/server/mcp-manager.ts/MCPManager.reconnectEnabled:209": "重连所有已启用的 MCP 服务器",
	// ── server/stores ──
	"src/server/agent-store.ts/AgentStore.constructor:53": "初始化 Agent 存储并确保默认 agent 存在",
	"src/server/agent-store.ts/AgentStore.list:64": "列出所有 agent",
	"src/server/agent-store.ts/AgentStore.get:68": "按 ID 获取 agent",
	"src/server/agent-store.ts/AgentStore.create:72": "创建新 agent 并规范化工作区路径",
	"src/server/agent-store.ts/AgentStore.update:78": "更新 agent 配置",
	"src/server/agent-store.ts/AgentStore.delete:86": "删除 agent",
	"src/server/provider-store.ts/ProviderStore.constructor:91": "初始化提供者存储并合并系统内置提供者",
	"src/server/provider-store.ts/ProviderStore.list:125": "列出所有 AI 提供者",
	"src/server/provider-store.ts/ProviderStore.get:129": "按 ID 获取 AI 提供者",
	"src/server/provider-store.ts/ProviderStore.create:133": "创建新的 AI 提供者",
	"src/server/provider-store.ts/ProviderStore.update:137": "更新 AI 提供者配置",
	"src/server/provider-store.ts/ProviderStore.delete:141": "删除 AI 提供者",
	"src/server/provider-store.ts/ProviderStore.addModel:145": "为提供者添加新模型",
	"src/server/provider-store.ts/ProviderStore.removeModel:155": "从提供者中移除指定模型",
	"src/server/template-store.ts/TemplateStore.constructor:121": "初始化模板存储并合并内置模板",
	"src/server/template-store.ts/TemplateStore.list:140": "列出所有提示词模板",
	"src/server/template-store.ts/TemplateStore.get:144": "按 ID 获取模板",
	"src/server/template-store.ts/TemplateStore.create:148": "创建用户自定义模板",
	"src/server/template-store.ts/TemplateStore.update:152": "更新模板配置",
	"src/server/template-store.ts/TemplateStore.delete:156": "删除非内置模板",
	"src/server/template-store.ts/TemplateStore.exportTemplate:162": "导出模板为 JSON 字符串",
	"src/server/template-store.ts/TemplateStore.importTemplate:168": "从 JSON 字符串导入模板",
	"src/server/template-store.ts/TemplateStore.findByNameAndSource:188": "按名称和来源 URL 查找模板",
	"src/server/mcp-store.ts/McpStore.constructor:30": "初始化 MCP 服务器配置存储",
	"src/server/mcp-store.ts/McpStore.list:34": "列出所有 MCP 服务器配置",
	"src/server/mcp-store.ts/McpStore.get:38": "按 ID 获取 MCP 服务器配置",
	"src/server/mcp-store.ts/McpStore.create:42": "创建新的 MCP 服务器配置",
	"src/server/mcp-store.ts/McpStore.update:46": "更新 MCP 服务器配置",
	"src/server/mcp-store.ts/McpStore.delete:50": "删除 MCP 服务器配置",
	"src/server/agent-tool-store.ts/AgentToolStore.constructor:37": "初始化 Agent 工具存储",
	"src/server/agent-tool-store.ts/AgentToolStore.list:41": "列出所有 agent 工具条目",
	"src/server/agent-tool-store.ts/AgentToolStore.get:45": "按 ID 获取 agent 工具条目",
	"src/server/agent-tool-store.ts/AgentToolStore.getByAgentId:49": "按关联 agentId 获取内部工具条目",
	"src/server/agent-tool-store.ts/AgentToolStore.create:53": "创建新的 agent 工具条目",
	"src/server/agent-tool-store.ts/AgentToolStore.update:57": "更新 agent 工具条目配置",
	"src/server/agent-tool-store.ts/AgentToolStore.delete:61": "删除 agent 工具条目",
	"src/server/agent-tool-store.ts/AgentToolStore.deleteByAgentId:65": "删除指定 agent 的所有内部工具条目",
	"src/server/memory-store.ts/MemoryStore.constructor:44": "初始化记忆图谱存储并预编译 SQL 语句",
	"src/server/memory-store.ts/MemoryStore.loadGraph:97": "加载完整的知识图谱",
	"src/server/memory-store.ts/MemoryStore.listEntities:105": "列出所有知识图谱实体",
	"src/server/memory-store.ts/MemoryStore.getEntity:114": "按名称获取实体",
	"src/server/memory-store.ts/MemoryStore.upsertEntity:120": "插入或更新实体",
	"src/server/memory-store.ts/MemoryStore.createEntities:125": "批量创建不重复的实体",
	"src/server/memory-store.ts/MemoryStore.deleteEntities:138": "批量删除实体及其关联关系",
	"src/server/memory-store.ts/MemoryStore.addObservations:148": "为实体批量添加新观察记录",
	"src/server/memory-store.ts/MemoryStore.searchEntities:164": "按关键词模糊搜索实体",
	"src/server/memory-store.ts/MemoryStore.listRelations:176": "列出所有实体关系",
	"src/server/memory-store.ts/MemoryStore.createRelations:181": "批量创建去重的实体关系",
	"src/server/memory-store.ts/MemoryStore.deleteRelations:199": "批量删除指定的实体关系",
	"src/server/memory-store.ts/MemoryStore.migrateFromJson:210": "从 JSON 文件迁移知识图谱数据",
	"src/server/key-value-store.ts/KeyValueStore.constructor:17": "初始化键值存储并预编译 SQL 语句",
	"src/server/key-value-store.ts/KeyValueStore.get:39": "按 key 获取字符串值",
	"src/server/key-value-store.ts/KeyValueStore.getJson:44": "按 key 获取并解析 JSON 值",
	"src/server/key-value-store.ts/KeyValueStore.set:54": "设置键值对",
	"src/server/key-value-store.ts/KeyValueStore.setJson:59": "将对象序列化为 JSON 后存储",
	"src/server/key-value-store.ts/KeyValueStore.delete:63": "按 key 删除键值对",
	"src/server/key-value-store.ts/KeyValueStore.list:67": "列出所有键值对",
	// ── server/infra ──
	"src/server/workspace-config.ts/loadWorkspaceConfig:18": "从数据库加载工作区配置",
	"src/server/workspace-config.ts/saveWorkspaceConfig:26": "合并更新并持久化工作区配置",
	"src/server/session-metrics.ts/RunningStats.add:12": "添加一个新样本到在线统计",
	"src/server/session-metrics.ts/RunningStats.getMean:20": "获取当前均值",
	"src/server/session-metrics.ts/RunningStats.getVariance:24": "获取当前方差",
	"src/server/session-metrics.ts/RunningStats.getCount:28": "获取样本数量",
	"src/server/session-metrics.ts/SessionMetricsHolder.constructor:133": "初始化会话指标持有者",
	"src/server/session-metrics.ts/SessionMetricsHolder.recordTokenUsage:143": "累加精确的 token 用量",
	"src/server/session-metrics.ts/SessionMetricsHolder.toSessionMetrics:151": "转换为不可变的指标快照",
	"src/server/sqlite-store.ts/SqliteStore.constructor:34": "初始化通用 SQLite 存储并确保表和列存在",
	"src/server/sqlite-store.ts/SqliteStore.ensureColumn:101": "安全地为表添加新列",
	"src/server/sqlite-store.ts/SqliteStore.list:133": "列出表中的所有记录",
	"src/server/sqlite-store.ts/SqliteStore.get:137": "按 ID 获取单条记录",
	"src/server/sqlite-store.ts/SqliteStore.create:142": "创建新记录并生成 ID 和时间戳",
	"src/server/sqlite-store.ts/SqliteStore.update:149": "合并更新现有记录",
	"src/server/sqlite-store.ts/SqliteStore.delete:163": "按 ID 删除记录",
	"src/server/sqlite-store.ts/SqliteStore.migrateFromJson:171": "从 JSON 文件批量导入记录",
	// ── server/routers ──
	"src/server/agent-router.ts/createAgentRouter:6": "创建 Agent 管理 API 路由",
	"src/server/agent-tool-router.ts/createAgentToolRouter:4": "创建 Agent 工具管理 API 路由",
	"src/server/config-router.ts/createConfigRouter:17": "创建系统配置 API 路由",
	"src/server/durable-hooks.ts/setSessionTurnSeq:13": "设置指定会话的轮次序号",
	"src/server/durable-hooks.ts/registerDurableHooks:17": "注册会话轮次的持久化检查点钩子",
	"src/server/index.ts/startServer:47": "启动 HTTP/WebSocket 服务器并初始化所有服务和路由",
	"src/server/message-store.ts/createMessageStore:37": "创建基于文件的消息存储对象",
	"src/server/metrics-events.ts/createEventMetricsAdapter:12": "创建流事件到会话管理器的指标桥接适配器",
	"src/server/metrics-hooks.ts/registerMetricsHooks:8": "将会话生命周期事件桥接到指标管理器",
	"src/server/persona-store.ts/PersonaStore.constructor:34": "初始化 Persona 存储并加载或创建默认数据",
	"src/server/persona-store.ts/PersonaStore.list:67": "列出所有 persona",
	"src/server/persona-store.ts/PersonaStore.get:71": "按 ID 获取 persona",
	"src/server/persona-store.ts/PersonaStore.create:75": "创建新 persona",
	"src/server/persona-store.ts/PersonaStore.update:82": "更新 persona 配置",
	"src/server/persona-store.ts/PersonaStore.delete:94": "删除 persona",
	"src/server/provider-router.ts/createProviderRouter:4": "创建 AI 提供者管理 API 路由",
	"src/server/session-lifecycle.ts/isValidTransition:20": "校验会话生命周期状态转换是否合法",
	"src/server/template-router.ts/createTemplateRouter:4": "创建模板管理 API 路由",
	// ── core/ ──
	"src/core/config.ts/deepMerge:191": "递归合并两个配置对象，override 覆盖 base 中的同名属性",
	"src/core/config.ts/readJsonFile:219": "读取 JSON 文件并解析，文件不存在或解析失败返回 null",
	"src/core/config.ts/loadConfig:228": "加载全局、项目级和运行时覆盖配置并深度合并",
	"src/core/config.ts/resolveEffective:265": "返回配置值或 Pi 默认值，用于运行时降级",
	"src/core/config.ts/saveGlobalConfig:269": "将全局配置序列化并持久化到 KV 存储",
	"src/core/config.ts/getGlobalConfigPath:183": "返回全局配置文件的绝对路径",
	"src/core/logger.ts/emit:67": "根据日志级别和调试模式过滤后输出到控制台和文件",
	"src/core/logger.ts/configureLogging:96": "运行时更新文件日志的配置参数",
	"src/core/context-manager.ts/estimateTokens:8": "按字符数四分之一估算消息总 token 数",
	"src/core/context-manager.ts/messageTokens:24": "估算单条消息的 token 数量",
	"src/core/context-manager.ts/shouldPrune:32": "判断消息是否超过上下文窗口需要裁剪",
	"src/core/context-manager.ts/pruneMessages:42": "根据配置策略裁剪消息并返回保留的部分",
	"src/core/context-manager.ts/pruneTail:61": "从尾部保留最近 token 预算内的消息",
	"src/core/context-manager.ts/pruneTurnBoundary:79": "保留最近 token 预算内完整对话轮次的消息",
	"src/core/context-manager.ts/scoreMessage:131": "为消息计算重要性分数，考虑角色和位置等因素",
	"src/core/context-manager.ts/pruneSmart:158": "按重要性评分保留高价值消息并保留近期上下文",
	"src/core/context-manager.ts/collectToolCallIds:211": "从 assistant 消息中收集所有工具调用 ID",
	"src/core/context-manager.ts/collectToolResultIds:218": "从 tool 消息中收集所有工具结果 ID",
	"src/core/context-manager.ts/applyPreserveToolResults:225": "补回被裁剪掉的工具结果消息以保持调用配对完整",
	"src/core/tool-policy.ts/evaluateToolCall:13": "根据策略判断工具调用是否应被阻止或自动批准",
	"src/core/tool-policy.ts/requiresApproval:50": "检查工具是否需要用户审批才能执行",
	"src/core/tool-policy.ts/transformToolResult:78": "按配置截断超长的工具输出文本",
	"src/core/tool-policy.ts/extractText:107": "从字符串或内容块数组中提取纯文本",
	"src/core/hook-registry.ts/HookRegistry.getInstance:13": "获取 HookRegistry 单例，首次调用时创建",
	"src/core/hook-registry.ts/HookRegistry.register:19": "注册事件处理器并返回取消订阅函数",
	"src/core/hook-registry.ts/HookRegistry.trigger:36": "按序触发事件处理器，首个非空结果即返回",
	"src/core/hook-registry.ts/HookRegistry.clear:50": "清除所有已注册的处理器",
	"src/core/hook-registry.ts/HookRegistry.hasHandlers:55": "检查指定事件是否注册了处理器",
	"src/core/hook-registry.ts/triggerHooks:65": "便捷函数，在单例注册表中触发事件并附加时间戳",
	"src/core/default-prompt.ts/buildDefaultPrompt:1": "根据名称生成默认编码助手系统提示词",
	"src/core/compaction.ts/shouldCompact:3": "判断是否需要触发上下文压缩",
	"src/core/compaction.ts/buildCompactionInstructions:16": "返回自定义压缩指令或 undefined",
	"src/core/custom-tools.ts/registerCustomTool:19": "注册一个可在运行时调用的自定义工具",
	"src/core/custom-tools.ts/getCustomTools:26": "返回所有已注册的自定义工具列表",
	"src/core/custom-tools.ts/executeCustomTool:33": "按名称执行自定义工具并返回结果",
	"src/core/device-context.ts/formatBytes:30": "将字节数格式化为人类可读的 GB 字符串",
	"src/core/device-context.ts/detectGpu:35": "检测系统 GPU 型号，支持 Windows、Linux、macOS",
	"src/core/device-context.ts/detectDisks:70": "检测系统磁盘信息，包括挂载点和容量",
	"src/core/device-context.ts/collectDeviceInfo:114": "收集完整的设备硬件与系统信息",
	"src/core/device-context.ts/formatDeviceContext:150": "将设备信息格式化为 Markdown 文本",
	"src/core/device-context.ts/loadDeviceContext:186": "从 KV 存储加载设备上下文，不存在则重新生成",
	"src/core/device-context.ts/saveDeviceContext:197": "将设备上下文内容持久化到 KV 存储",
	"src/core/device-context.ts/generateAndSaveDeviceContext:201": "采集设备信息并格式化后存入 KV 存储",
	"src/core/file-log-sink.ts/createFileLogSink:45": "创建文件日志写入器，包含日志轮转和配置更新",
	"src/core/file-log-sink.ts/createFileLogSink.getLogDir:53": "懒初始化并返回日志目录路径",
	"src/core/file-log-sink.ts/createFileLogSink.formatLine:63": "将日志负载格式化为单行文本",
	"src/core/file-log-sink.ts/createFileLogSink.rotateIfNeeded:73": "检查并删除超过保留天数的旧日志文件",
	"src/core/file-log-sink.ts/createFileLogSink.sink:90": "写入一条日志到当日文件，受级别和开关控制",
	"src/core/file-log-sink.ts/createFileLogSink.updateConfig:105": "运行时更新文件日志配置",
	"src/core/input-handler.ts/processInput:17": "将用户输入中的自定义命令前缀展开为模板文本",
	"src/core/persona.ts/buildPersonaPrompt:86": "根据人设定义生成系统提示词文本",
	"src/core/persona.ts/applyPersonaToConfig:127": "将人设的覆盖项合并到全局配置的深拷贝中",
	"src/core/project-context.ts/loadContextFiles:34": "从当前目录向上遍历加载上下文文件",
	"src/core/project-context.ts/detectProjectInfo:66": "检测项目的语言、框架和包管理器信息",
	"src/core/project-context.ts/generateDirectorySummary:121": "生成目录结构的缩进文本摘要",
	"src/core/project-context.ts/generateDirectorySummary.walk:129": "递归遍历目录并收集文件树文本",
	"src/core/project-context.ts/loadProjectContext:169": "加载完整的项目上下文，包括文件、信息和目录",
	"src/core/project-context.ts/formatProjectContext:193": "将项目上下文格式化为 Markdown 文本",
	"src/core/system-prompt.ts/buildSystemPrompt:19": "组装包含设备、指导原则、工具引用的完整系统提示词",
	"src/core/tool-registry.ts/ToolRegistry.constructor:72": "初始化工具注册表并从 KV 存储加载配置",
	"src/core/tool-registry.ts/ToolRegistry.register:79": "注册一个工具描述符",
	"src/core/tool-registry.ts/ToolRegistry.unregister:83": "按来源和可选 MCP 服务器 ID 注销工具",
	"src/core/tool-registry.ts/ToolRegistry.getAll:94": "返回所有已注册工具，附带生效后的提示词",
	"src/core/tool-registry.ts/ToolRegistry.getByCategory:103": "按类别分组返回所有工具",
	"src/core/tool-registry.ts/ToolRegistry.getByName:111": "按名称查找工具描述符",
	"src/core/tool-registry.ts/ToolRegistry.getToolConfig:117": "合并默认配置和用户存储配置并返回",
	"src/core/tool-registry.ts/ToolRegistry.getToolConfigFor:140": "返回指定工具的合并后配置",
	"src/core/tool-registry.ts/ToolRegistry.saveToolConfig:144": "保存工具配置到 KV 存储并更新内存",
	"src/core/tool-registry.ts/ToolRegistry.loadConfig:151": "从 KV 存储读取工具配置到内存",
	"src/core/tool-registry.ts/ToolRegistry.onChange:160": "注册配置变更监听器并返回取消函数",
	"src/core/tool-registry.ts/ToolRegistry.buildEffectivePrompt:167": "将工具描述与用户配置拼接为最终提示词",
	"src/core/tool-registry.ts/ToolRegistry.notifyChange:179": "通知所有变更监听器",
	// ── main/ ──
	"src/main/index.ts/log:12": "输出带时间戳的主进程日志",
	"src/main/index.ts/createWindow:36": "创建 Electron 主窗口并加载开发服务器或构建产物",
	"src/main/ipc.ts/registerIpc:23": "初始化所有 IPC 处理器并在后台加载核心模块",
	"src/main/ipc/core.ts/getModuleState:69": "返回全局 IPC 上下文对象",
	"src/main/ipc/core.ts/setMainWindow:73": "保存 Electron 主窗口引用",
	"src/main/ipc/core.ts/getMainWindow:77": "获取 Electron 主窗口实例",
	"src/main/ipc/core.ts/refreshAgentTools:83": "重新注册代理工具并通知前端刷新",
	"src/main/ipc/core.ts/ensureAgentService:93": "确保 AgentService 已初始化，否则创建并订阅事件",
	"src/main/ipc/core.ts/loadCoreModules:107": "分阶段动态加载所有核心模块并初始化各子系统",
	"src/main/ipc/typed-ipc.ts/typedHandle:17": "注册类型安全的 IPC 处理器，自动等待模块就绪",
	"src/main/ipc/typed-ipc.ts/registerCrud:46": "自动注册五个标准 CRUD IPC 通道",
	"src/main/ipc/typed-ipc.ts/setContextGetter:102": "设置懒加载的 IPC 上下文获取函数",
	"src/main/ipc/typed-ipc.ts/getCtx:106": "获取 IPC 上下文，未初始化时抛出异常",
	"src/main/ipc/module-readiness.ts/createSlot:30": "为指定模块创建就绪状态的 Promise 槽位",
	"src/main/ipc/module-readiness.ts/moduleReadiness.initAllSlots:37": "批量初始化所有模块的就绪槽位",
	"src/main/ipc/module-readiness.ts/moduleReadiness.resolveModule:41": "标记单个模块为已就绪",
	"src/main/ipc/module-readiness.ts/moduleReadiness.resolveModules:49": "批量标记多个模块为已就绪",
	"src/main/ipc/module-readiness.ts/moduleReadiness.whenReady:53": "等待指定模块就绪",
	"src/main/ipc/module-readiness.ts/moduleReadiness.isReady:59": "检查指定模块是否已就绪",
	"src/main/ipc/module-readiness.ts/moduleReadiness.whenAllReady:63": "等待所有模块全部就绪",
	"src/main/ipc/chat-handlers.ts/registerChatHandlers:8": "注册聊天发送和中止的 IPC 处理器",
	"src/main/ipc/session-handlers.ts/registerSessionHandlers:4": "注册会话列表、创建、切换、删除等 IPC 处理器",
	"src/main/ipc/message-handlers.ts/registerMessageHandlers:4": "注册消息清空、编辑、删除的 IPC 处理器",
	"src/main/ipc/agent-handlers.ts/registerAgentHandlers:6": "注册代理 CRUD 的 IPC 处理器",
	"src/main/ipc/provider-handlers.ts/registerProviderHandlers:5": "注册供应方 CRUD 和模型操作的 IPC 处理器",
	"src/main/ipc/template-handlers.ts/registerTemplateHandlers:4": "注册模板 CRUD 和导入导出的 IPC 处理器",
	"src/main/ipc/github-template-handlers.ts/loadGithubCache:16": "从 KV 存储加载 GitHub 模板缓存",
	"src/main/ipc/github-template-handlers.ts/saveGithubCache:20": "将 GitHub 模板缓存持久化到 KV 存储",
	"src/main/ipc/github-template-handlers.ts/registerGithubTemplateHandlers:25": "注册 GitHub 模板预览和导入的 IPC 处理器",
	"src/main/ipc/mcp-handlers.ts/registerMcpHandlers:5": "注册 MCP 服务器增删改查和连接管理的 IPC 处理器",
	"src/main/ipc/search-provider-handlers.ts/registerSearchProviderHandlers:6": "注册搜索引擎配置的获取和设置 IPC 处理器",
	"src/main/ipc/config-handlers.ts/registerConfigHandlers:6": "注册工作区配置、主题和设备上下文的 IPC 处理器",
	"src/main/ipc/agent-tool-handlers.ts/registerAgentToolHandlers:6": "注册代理工具 CRUD 的 IPC 处理器",
	"src/main/ipc/dialog-handlers.ts/registerDialogHandlers:5": "注册应用就绪状态和目录选择对话框的 IPC 处理器",
	"src/main/ipc/file-handlers.ts/registerFileHandlers:10": "注册文件树浏览、内容读取和保存的 IPC 处理器",
	"src/main/ipc/log-handlers.ts/parseLogLine:15": "将单行日志文本解析为结构化日志条目",
	"src/main/ipc/log-handlers.ts/registerLogHandlers:26": "注册日志文件列表、读取和配置的 IPC 处理器",
	"src/main/ipc/tool-handlers.ts/registerToolHandlers:4": "注册工具列表和工具配置的 IPC 处理器",
	"src/main/test-setup.ts/isTestMode:25": "检查是否处于 E2E 测试模式",
	"src/main/test-setup.ts/seedTestEnvironment:29": "在测试模式下创建模拟供应方和测试代理",
	// ── preload/ ──
	"src/preload/index.ts/contextBridge.exposeInMainWorld:157": "将 IPC 代理 API 暴露给渲染进程的 window 对象",
	// ── shared/ ──
	"src/shared/file-utils.ts/buildTree:19": "递归构建目录树的嵌套节点数组",
	"src/shared/github-template-utils.ts/parseFrontmatter:1": "解析 Markdown 文件的 YAML frontmatter 为键值对象",
	"src/shared/github-template-utils.ts/extractTag:17": "从文件路径提取分类标签字符串",
	"src/shared/github-template-utils.ts/shouldSkipMd:24": "判断 Markdown 文件是否应被模板扫描跳过",
		"src/main/ipc/chat-handlers.ts/expandHome:6": "将 ~ 展开为用户主目录的绝对路径",
		"src/main/ipc/core.ts/toFileURL:11": "将文件路径转换为 file:// URL 格式",
		"src/main/ipc/file-handlers.ts/expandHome:8": "将 ~ 展开为用户主目录的绝对路径",
		"src/main/ipc/log-handlers.ts/LOG_DIR:8": "日志目录常量路径",
		"src/main/ipc/typed-ipc.ts/ready:58": "检查指定模块是否已就绪的辅助函数",
		"src/preload/index.ts/handler:60": "IPC invoke 代理：调用主进程方法并返回 Promise",
		"src/preload/index.ts/handler:65": "IPC invoke 代理：调用主进程方法并返回 Promise",
		"src/preload/index.ts/handler:70": "IPC invoke 代理：调用主进程方法并返回 Promise",
		"src/preload/index.ts/handler:75": "IPC invoke 代理：调用主进程方法并返回 Promise",
		"src/preload/index.ts/handler:81": "IPC invoke 代理：调用主进程方法并返回 Promise",
		"src/preload/index.ts/handler:86": "IPC invoke 代理：调用主进程方法并返回 Promise",
		"src/runtime/agent-loop.ts/AgentLoop.parentEmit:114": "向上层转发流式事件并附加元数据",
		"src/runtime/agent-loop.ts/AgentLoop.parentEmit:183": "向上层转发流式事件并附加元数据",
		"src/runtime/agent-loop.ts/AgentLoop.parentEmit:249": "向上层转发流式事件并附加元数据",
		"src/runtime/concurrency-queue.ts/ConcurrencyQueue.cleanup:48": "清理已完成等待者的内部状态",
		"src/runtime/mock-language-model.ts/nextId:28": "生成递增的唯一请求 ID",
		"src/runtime/provider-concurrency-manager.ts/normalize:46": "将提供商名称规范化为标准格式",
		"src/runtime/provider-concurrency-manager.ts/clampConcurrency:50": "将并发数限制在有效范围内",
		"src/tools/index.ts/isEnabled:128": "检查指定工具在当前配置下是否启用",
		"src/tools/outline/extractors/json.ts/JsonExtractor.extract:4": "解析 JSON 文件结构并提取大纲节点",
		"src/tools/outline/extractors/json.ts/JsonExtractor.extractValue:15": "提取 JSON 值的内容摘要",
		"src/tools/outline/extractors/json.ts/JsonExtractor.extractObject:25": "递归提取 JSON 对象的键值对大纲",
		"src/tools/outline/extractors/json.ts/JsonExtractor.extractArray:66": "提取 JSON 数组的元素概览",
		"src/tools/outline/extractors/json.ts/JsonExtractor.findKeyLocation:113": "在文本中定位 JSON 键的位置",
		"src/tools/outline/extractors/json.ts/JsonExtractor.findValueEnd:122": "找到 JSON 值的结束位置",
		"src/tools/outline/extractors/json.ts/JsonExtractor.findArrayItemLocation:141": "定位数组中指定索引的元素位置",
		"src/tools/outline/extractors/json.ts/JsonExtractor.fallbackExtract:156": "无法解析时按行生成基本大纲",
		"src/tools/outline/extractors/markdown.ts/MarkdownExtractor.extract:4": "解析 Markdown 文件提取标题层级",
		"src/tools/outline/extractors/markdown.ts/MarkdownExtractor.parseHeadings:9": "逐行扫描 Markdown 标题并构建节点树",
		"src/tools/outline/extractors/python.ts/PythonExtractor.extract:4": "解析 Python 文件提取类和函数定义",
		"src/tools/outline/extractors/python.ts/PythonExtractor.parseBlock:9": "解析单个缩进块的子节点",
		"src/tools/outline/extractors/python.ts/PythonExtractor.findBlockEnd:105": "根据缩进级别确定块的结束行",
		"src/tools/outline/extractors/python.ts/PythonExtractor.getIndent:115": "计算行的前导空格数",
		"src/tools/outline/extractors/typescript.ts/TypeScriptExtractor.extract:5": "解析 TypeScript 文件提取声明和结构",
		"src/tools/outline/extractors/typescript.ts/TypeScriptExtractor.tryParseDecl:41": "尝试解析单行声明语句",
		"src/tools/outline/extractors/typescript.ts/TypeScriptExtractor.findBlock:86": "根据花括号匹配查找代码块范围",
		"src/tools/outline/extractors/typescript.ts/TypeScriptExtractor.isKeyword:212": "判断标识符是否为 TypeScript 关键字",
		"src/tools/outline/extractors/typescript.ts/TypeScriptExtractor.summary:216": "生成文件级别的摘要信息",
		"src/tools/outline/index.ts/C_EXT:33": "C 语言文件扩展名常量列表",
		"src/tools/outline/index.ts/CPP_EXT:34": "C++ 文件扩展名常量列表",
		"src/tools/task-status.ts/clip:6": "将文本截断到指定最大长度",
		"src/server/agent-service.ts/AgentService.getOrCreateLoop:177": "获取或创建指定会话的 AgentLoop 实例",
		"src/server/agent-service.ts/AgentService.createLoopForSession:206": "为新会话创建 AgentLoop 并注入依赖",
		"src/server/agent-service.ts/AgentService.buildSessionInitMessages:449": "构建会话激活时的初始消息列表",
		"src/server/agent-service.ts/AgentService.invalidateLoops:517": "使所有缓存的 AgentLoop 实例失效",
		"src/server/agent-service.ts/AgentService.handleRuntimeEvent:530": "处理运行时事件并转发到前端",
		"src/server/agent-service.ts/AgentService.findStateByAgentId:568": "按 agentId 查找对应的运行状态",
		"src/server/agent-service.ts/AgentService.emit:575": "向前端发送 IPC 事件",
		"src/server/agent-store.ts/normalizeWorkspaceDir:37": "将工作区路径规范化为绝对路径",
		"src/server/config-router.ts/kv:20": "获取键值存储的辅助闭包",
		"src/server/db-migration.ts/safeAddColumn:58": "安全地为表添加列，已存在则跳过",
		"src/server/db-migration.ts/normalizeWorkspaceDir:193": "规范化工作区目录路径",
		"src/server/db-migration.ts/migratePersonas:201": "从旧格式迁移 persona 数据到新存储",
		"src/server/index.ts/expandHome:33": "将 ~ 展开为用户主目录的绝对路径",
		"src/server/key-value-store.ts/KeyValueStore.init:29": "初始化键值存储的表和索引",
		"src/server/mcp-router.ts/createMcpRouter:5": "创建 MCP 服务器管理 API 路由",
		"src/server/memory-store.ts/MemoryStore.init:73": "初始化记忆图谱存储的表和索引",
		"src/server/message-store.ts/filePath:17": "生成消息存储文件的路径",
		"src/server/message-store.ts/readFile:21": "从 JSON 文件读取消息列表",
		"src/server/message-store.ts/writeFile:31": "将消息列表写入 JSON 文件",
		"src/server/metrics-hooks.ts/handler:23": "事件处理闭包：桥接 agent 事件到指标管理器",
		"src/server/metrics-hooks.ts/wrapped:69": "包装回调函数以自动记录指标",
		"src/server/persona-store.ts/PersonaStore.load:39": "从数据库加载 persona 列表",
		"src/server/persona-store.ts/PersonaStore.save:54": "将 persona 列表持久化到数据库",
		"src/server/persona-store.ts/PersonaStore.createRecord:60": "创建带默认值的新 persona 记录",
		"src/server/provider-store.ts/ProviderStore.mergeSystemProviders:99": "合并系统内置提供者到用户列表",
		"src/server/session-manager.ts/SessionManager.runCleanup:323": "执行一次 TTL 过期的会话清理",
		"src/server/session-manager.ts/SessionManager.evictSession:356": "驱逐指定会话并释放资源",
		"src/server/session-manager.ts/SessionManager.transition:380": "校验并执行会话状态转换",
		"src/server/session-manager.ts/SessionManager.touchActivity:393": "更新会话的最后活跃时间戳",
		"src/server/sqlite-store.ts/camelToSnake:269": "将 camelCase 标识符转换为 snake_case",
		"src/server/template-store.ts/TemplateStore.mergeBuiltInTemplates:128": "合并内置模板到用户模板列表",
		"src/core/file-log-sink.ts/getLogDir:53": "懒初始化并返回日志目录路径",
		"src/core/file-log-sink.ts/formatLine:63": "将日志负载格式化为单行文本",
		"src/core/file-log-sink.ts/rotateIfNeeded:73": "检查并删除超过保留天数的旧日志文件",
		"src/core/file-log-sink.ts/sink:90": "写入一条日志到当日文件，受级别和开关控制",
		"src/core/file-log-sink.ts/updateConfig:105": "运行时更新文件日志配置",
		"src/core/logger.ts/consoleSink:41": "控制台日志输出处理器",
		"src/core/logger.ts/logSink:62": "文件日志写入处理器",
		"src/core/project-context.ts/walk:129": "递归遍历目录并收集文件树文本",
};

// ============================================================
// Types
// ============================================================

interface FunctionInfo {
	id: string;
	name: string;
	kind: "function" | "method" | "arrow";
	className?: string;
	file: string;
	line: number;
	endLine: number;
	statementCount: number;
	exported: boolean;
	signature: string;
	description: string;
	callees: string[];
}

interface FileInfo {
	path: string;
	lines: number;
	dir: string;
	exports: string[];
	imports: string[];
	functions: string[];
	description: string;
}

// ============================================================
// File collection
// ============================================================

function toCanonical(absPath: string): string {
	return relative(ROOT, absPath).split(sep).join(posix.sep);
}

function collectTsFiles(): string[] {
	const out: string[] = [];
	for (const dir of SCAN_DIRS) {
		const absDir = join(ROOT, dir);
		try { if (!statSync(absDir).isDirectory()) continue; } catch { continue; }
		const walk = (d: string) => {
			for (const entry of readdirSync(d, { withFileTypes: true })) {
				const full = join(d, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts"))
					out.push(full);
			}
		};
		walk(absDir);
	}
	return out;
}

// ============================================================
// Analysis state
// ============================================================

const filePaths = collectTsFiles();
const fileSet = new Set(filePaths.map(toCanonical));
const sources = new Map<string, ts.SourceFile>();
const fileImports = new Map<string, Map<string, { resolvedFile: string; importedName: string }>>();
const symbolTable = new Map<string, Map<string, { line: number; exported: boolean; kind: string; className?: string }>>();

for (const abs of filePaths) {
	const canonical = toCanonical(abs);
	sources.set(canonical, ts.createSourceFile(abs, readFileSync(abs, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

// ============================================================
// Phase 1: Extract functions + descriptions
// ============================================================

function isExported(modifiers?: ts.ModifiersArray): boolean {
	return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function countStatements(node: ts.Node): number {
	let count = 0;
	const visit = (n: ts.Node) => {
		if (ts.isStatement(n) && !ts.isBlock(n)) count++;
		ts.forEachChild(n, visit);
	};
	visit(node);
	return count;
}

function getSignature(node: ts.SignatureDeclaration): string {
	const name = node.name ? (ts.isIdentifier(node.name) ? node.name.text : node.name.getText()) : "";
	const params = node.parameters.map((p) => p.getText()).join(", ");
	return `${ts.isMethodDeclaration(node) ? "method" : ts.isArrowFunction(node) ? "fn" : "function"} ${name}(${params})`;
}

function getJSDoc(node: ts.Node): string {
	const ranges = (ts as any).getJSDocCommentsAndTags?.(node) as any[] | undefined;
	if (!ranges || ranges.length === 0) return "";
	const first = ranges[0];
	if (typeof first.comment === "string") return first.comment.trim().split("\n")[0];
	return "";
}

interface RawFunc {
	name: string;
	kind: "function" | "method" | "arrow";
	className?: string;
	line: number;
	endLine: number;
	statementCount: number;
	exported: boolean;
	signature: string;
	description: string;
	body?: ts.Node;
	enclosingClass?: string;
}

function extractFunctions(sf: ts.SourceFile): RawFunc[] {
	const out: RawFunc[] = [];
	const classStack: string[] = [];

	const visit = (node: ts.Node, parent: ts.Node | undefined) => {
		let pushedClass = false;
		if (ts.isFunctionDeclaration(node) && node.name) {
			const { line: s } = sf.getLineAndCharacterOfPosition(node.getStart());
			const { line: e } = sf.getLineAndCharacterOfPosition(node.getEnd());
			out.push({
				name: node.name.text, kind: "function",
				className: classStack.at(-1), enclosingClass: classStack.at(-1),
				line: s + 1, endLine: e + 1,
				statementCount: node.body ? countStatements(node.body) : 0,
				exported: isExported(node.modifiers),
				signature: getSignature(node),
				description: getJSDoc(node),
				body: node.body,
			});
		}
		if (ts.isClassDeclaration(node) && node.name) {
			const className = node.name.text;
			classStack.push(className);
			pushedClass = true;
			const classExported = isExported(node.modifiers);
			const classDesc = getJSDoc(node);
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name) {
					const { line: s } = sf.getLineAndCharacterOfPosition(member.getStart());
					const { line: e } = sf.getLineAndCharacterOfPosition(member.getEnd());
					out.push({
						name: ts.isIdentifier(member.name) ? member.name.text : member.name.getText(),
						kind: "method", className, enclosingClass: className,
						line: s + 1, endLine: e + 1,
						statementCount: member.body ? countStatements(member.body) : 0,
						exported: classExported || isExported(member.modifiers),
						signature: getSignature(member),
						description: getJSDoc(member) || classDesc,
						body: member.body,
					});
				}
			}
		}
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const init = node.initializer;
			if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
				const exportFlag = parent && ts.isVariableStatement(parent) ? isExported(parent.modifiers) : false;
				const { line: s } = sf.getLineAndCharacterOfPosition(node.getStart());
				const { line: e } = sf.getLineAndCharacterOfPosition(node.getEnd());
				out.push({
					name: node.name.text, kind: "arrow",
					className: classStack.at(-1), enclosingClass: classStack.at(-1),
					line: s + 1, endLine: e + 1,
					statementCount: countStatements(init),
					exported: exportFlag,
					signature: getSignature(init as ts.SignatureDeclaration),
					description: getJSDoc(node) || getJSDoc(init),
					body: init.body,
				});
			}
		}
		ts.forEachChild(node, (child) => visit(child, node));
		if (pushedClass) classStack.pop();
	};

	visit(sf, undefined);
	return out;
}

// Build symbol table
for (const [canonical, sf] of sources) {
	const funcs = extractFunctions(sf);
	const local = new Map<string, { line: number; exported: boolean; kind: string; className?: string }>();
	for (const f of funcs) {
		const key = f.className ? `${f.className}.${f.name}` : f.name;
		local.set(key, { line: f.line, exported: f.exported, kind: f.kind, className: f.className });
	}
	symbolTable.set(canonical, local);
	fileImports.set(canonical, new Map());
}

// ============================================================
// Phase 2: Resolve imports
// ============================================================

function resolveModuleSpecifier(spec: string, fromFile: string): string | null {
	if (!spec.startsWith(".")) return null;
	let target = spec.endsWith(".js") ? spec.slice(0, -3) + ".ts" : spec.endsWith(".ts") ? spec : spec + ".ts";
	const resolved = resolve(dirname(join(ROOT, fromFile)), target);
	const canonical = toCanonical(resolved);
	if (fileSet.has(canonical)) return canonical;
	const idx = toCanonical(join(resolved, "index.ts"));
	return fileSet.has(idx) ? idx : null;
}

for (const [canonical, sf] of sources) {
	const imports = new Map<string, { resolvedFile: string; importedName: string }>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
		const resolvedFile = resolveModuleSpecifier(stmt.moduleSpecifier.text, canonical);
		if (!resolvedFile) continue;
		const ic = stmt.importClause;
		if (!ic) continue;
		if (ic.name) imports.set(ic.name.text, { resolvedFile, importedName: "default" });
		if (ic.namedBindings) {
			const nb = ic.namedBindings;
			if (ts.isNamedImports(nb)) {
				for (const el of nb.elements) {
					imports.set(el.name.text, { resolvedFile, importedName: el.propertyName?.text ?? el.name.text });
				}
			} else if (ts.isNamespaceImport(nb)) {
				imports.set(nb.name.text, { resolvedFile, importedName: "*" });
			}
		}
	}
	fileImports.set(canonical, imports);
}

// ============================================================
// Phase 3: Resolve calls
// ============================================================

const allFunctions: FunctionInfo[] = [];
const functionById = new Map<string, FunctionInfo>();

function resolveCallTarget(expr: ts.Expression, fromFile: string, enclosingClass?: string): { file: string; name: string } | null {
	const imports = fileImports.get(fromFile);
	if (!imports) return null;
	const localSyms = symbolTable.get(fromFile);

	if (ts.isIdentifier(expr)) {
		const name = expr.text;
		if (localSyms?.has(name)) return { file: fromFile, name };
		const imp = imports.get(name);
		if (imp) return { file: imp.resolvedFile, name: imp.importedName === "*" ? "*" : imp.importedName };
		return null;
	}

	if (ts.isPropertyAccessExpression(expr)) {
		let root: ts.Expression = expr;
		while (ts.isPropertyAccessExpression(root)) root = root.expression;
		const methodName = expr.name.text;

		if ((root.kind === ts.SyntaxKind.ThisKeyword || root.kind === ts.SyntaxKind.SuperKeyword) && enclosingClass) {
			const symName = `${enclosingClass}.${methodName}`;
			if (localSyms?.has(symName)) return { file: fromFile, name: symName };
			return null;
		}

		if (ts.isIdentifier(root)) {
			const rootName = root.text;
			const imp = imports.get(rootName);
			if (imp) {
				const targetSyms = symbolTable.get(imp.resolvedFile);
				if (targetSyms) {
					for (const [symName] of targetSyms) {
						if (symName.endsWith("." + methodName)) return { file: imp.resolvedFile, name: symName };
					}
					if (targetSyms.has(methodName)) return { file: imp.resolvedFile, name: methodName };
				}
				return null;
			}
			if (localSyms) {
				for (const [symName] of localSyms) {
					if (symName.endsWith("." + methodName)) return { file: fromFile, name: symName };
				}
				if (localSyms.has(methodName)) return { file: fromFile, name: methodName };
			}
		}
	}
	return null;
}

for (const [canonical, sf] of sources) {
	for (const f of extractFunctions(sf)) {
		const id = `${canonical}/${f.className ? f.className + "." : ""}${f.name}:${f.line}`;
		const callees: string[] = [];
		if (f.body) {
			const seen = new Set<string>();
			const visit = (n: ts.Node) => {
				if (ts.isCallExpression(n)) {
					const target = resolveCallTarget(n.expression, canonical, f.enclosingClass);
					if (target) {
						const targetSyms = symbolTable.get(target.file);
						const sym = targetSyms?.get(target.name);
						if (sym) {
							const tid = `${target.file}/${target.name}:${sym.line}`;
							if (!seen.has(tid)) { seen.add(tid); callees.push(tid); }
						}
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(f.body);
		}
		const info: FunctionInfo = {
			id, name: f.className ? `${f.className}.${f.name}` : f.name,
			kind: f.kind, className: f.className, file: canonical,
			line: f.line, endLine: f.endLine, statementCount: f.statementCount,
			exported: f.exported, signature: f.signature,
			description: f.description || FUNC_DESC[id] || "",
			callees,
		};
		allFunctions.push(info);
		functionById.set(id, info);
	}
}

// ============================================================
// Phase 4: File-level info
// ============================================================

const files: FileInfo[] = [];
const fileEdges: { from: string; to: string }[] = [];

for (const [canonical, sf] of sources) {
	const imports = fileImports.get(canonical)!;
	const functions = allFunctions.filter((f) => f.file === canonical).map((f) => f.id);
	const exports = allFunctions.filter((f) => f.file === canonical && f.exported).map((f) => f.name);
	const importPaths = [...new Set([...imports.values()].map((v) => v.resolvedFile))];
	files.push({
		path: canonical, lines: sf.text.split("\n").length,
		dir: posix.dirname(canonical), exports, imports: importPaths, functions,
		description: FILE_DESC[canonical] || "",
	});
	for (const imp of imports.values()) fileEdges.push({ from: canonical, to: imp.resolvedFile });
}

const functionEdges: { from: string; to: string }[] = [];
for (const f of allFunctions) {
	for (const callee of f.callees) {
		if (functionById.has(callee)) functionEdges.push({ from: f.id, to: callee });
	}
}

// Reverse indexes
const callersByFunction = new Map<string, string[]>();
for (const f of allFunctions) {
	for (const callee of f.callees) {
		if (!functionById.has(callee)) continue;
		const arr = callersByFunction.get(callee) ?? [];
		arr.push(f.id);
		callersByFunction.set(callee, arr);
	}
}

const callersByFile = new Map<string, string[]>();
for (const fi of files) {
	for (const imp of fi.imports) {
		const arr = callersByFile.get(imp) ?? [];
		arr.push(fi.path);
		callersByFile.set(imp, arr);
	}
}

// ============================================================
// Phase 5: Build HTML
// ============================================================

const payload = {
	moduleDesc: MODULE_DESC,
	files,
	functions: allFunctions.map((f) => ({
		id: f.id, name: f.name, kind: f.kind, file: f.file,
		line: f.line, endLine: f.endLine, statementCount: f.statementCount,
		exported: f.exported, signature: f.signature, description: f.description,
		callees: f.callees.filter((c) => functionById.has(c)),
	})),
	callers: Object.fromEntries(callersByFunction),
	fileCallers: Object.fromEntries(callersByFile),
};

const totalEdges = fileEdges.length + functionEdges.length;
const exportedCount = allFunctions.filter((f) => f.exported).length;
const html = buildHtml(payload, { fileCount: files.length, functionCount: allFunctions.length, exportedCount, edgeCount: totalEdges });

const outPath = join(ROOT, "docs", "visualization", "code-graph.html");
const dataPath = join(ROOT, "docs", "visualization", "code-graph-data.json");
writeFileSync(outPath, html, "utf-8");
writeFileSync(dataPath, JSON.stringify(payload, null, "\t"), "utf-8");
const withDesc = allFunctions.filter((f) => f.description.trim().length > 0).length;
const missingDesc = allFunctions.filter((f) => !f.description.trim());
console.log(
	`✓ Wrote ${outPath}\n` +
	`  ${files.length} files · ${allFunctions.length} functions (${exportedCount} exported)\n` +
	`  ${fileEdges.length} import edges · ${functionEdges.length} call edges\n` +
	`  ${withDesc}/${allFunctions.length} functions have descriptions (${missingDesc.length} missing)`,
);
if (missingDesc.length > 0 && missingDesc.length <= 200) {
	console.log("  Missing:");
	for (const f of missingDesc) console.log(`    ${f.id}`);
}

// ============================================================
// HTML template
// ============================================================

function buildHtml(data: object, stats: { fileCount: number; functionCount: number; exportedCount: number; edgeCount: number }): string {
	const dataJson = JSON.stringify(data);
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Zero-Core · 代码大纲与调用关系</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:16px;background:#0d1117;color:#c9d1d9;font-size:13px}
h1{margin:0 0 4px;color:#f0f6fc;font-size:18px}
.subtitle{color:#8b949e;margin-bottom:12px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:6px 12px;font-size:11px}
.stat .num{color:#f0f6fc;font-weight:600;font-size:14px}
.stat .label{color:#8b949e;margin-left:4px}
.tabs{display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid #30363d;padding-bottom:8px}
.tab-btn{background:transparent;color:#8b949e;border:1px solid transparent;padding:6px 14px;cursor:pointer;border-radius:4px;font-size:13px}
.tab-btn:hover{color:#c9d1d9}
.tab-btn.active{background:#21262d;color:#f0f6fc;border-color:#30363d}
.panel{display:none}
.panel.active{display:flex;gap:12px}
.col{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:8px;overflow:auto}
.col-outline{width:40%;max-height:80vh}
.col-detail{width:60%;max-height:80vh}
input[type="search"]{width:100%;padding:6px 10px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:13px;margin-bottom:8px}
input[type="search"]:focus{outline:none;border-color:#58a6ff}
.tree{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}
.tree ul{list-style:none;padding-left:14px;margin:0}
.tree>ul{padding-left:0}
.tree li{padding:1px 0;cursor:default}
.tree li.dir,.tree li.file{cursor:pointer}
.tree li.dir::before{content:"\\25b8 ";color:#8b949e}
.tree li.dir.open::before{content:"\\25be ";color:#8b949e}
.tree li.file::before{content:"\\1f4c4 ";opacity:0.5}
.tree li.fn::before{content:"  "}
.tree li .name{color:#c9d1d9}
.tree li.dir>.name{color:#79c0ff;font-weight:500}
.tree li.file>.name{color:#d2a8ff}
.tree li.fn .name{color:#c9d1d9}
.tree li.fn .meta{color:#8b949e;font-size:11px;margin-left:8px}
.tree li.fn.exported>.name{color:#7ee787}
.tree li.match-hidden{display:none}
.tree li.selected>.name{background:#1f6feb33;border-radius:2px}
.tree .desc{color:#8b949e;font-size:11px;font-family:-apple-system,"Segoe UI",sans-serif;margin-left:6px;font-style:italic}
.detail h3{margin:8px 0 4px;color:#f0f6fc;font-size:13px}
.detail .sig{font-family:monospace;background:#0d1117;padding:8px;border-radius:3px;border:1px solid #30363d;color:#d2a8ff;font-size:12px;margin-bottom:8px;word-break:break-word}
.detail .loc{color:#8b949e;font-size:11px;margin-bottom:4px}
.detail .desc-text{color:#79c0ff;font-size:12px;margin-bottom:12px;line-height:1.5}
.edge-list{list-style:none;padding:0;margin:0}
.edge-list li{padding:4px 6px;cursor:pointer;border-radius:3px;font-family:monospace;font-size:12px;border-bottom:1px solid #21262d}
.edge-list li:hover{background:#21262d}
.edge-list .file{color:#8b949e;font-size:11px}
.edge-list .name{color:#79c0ff}
.edge-list .desc-inline{color:#8b949e;font-size:11px;font-style:italic;margin-left:8px}
.edge-list .empty{color:#8b949e;font-style:italic;padding:8px}
.toggle{display:inline-flex;gap:0;margin-bottom:8px;border:1px solid #30363d;border-radius:4px;overflow:hidden}
.toggle button{background:transparent;color:#8b949e;border:0;padding:4px 12px;cursor:pointer;font-size:12px}
.toggle button.active{background:#21262d;color:#f0f6fc}
.header-bar{display:flex;gap:8px;align-items:center}
.header-bar h3{flex:1;margin:0}
.footer{margin-top:16px;color:#8b949e;font-size:11px;border-top:1px solid #30363d;padding-top:8px}
code{background:#21262d;padding:1px 4px;border-radius:2px;font-size:11px}
/* Calls panel */
.panel-calls-inner{display:flex;gap:12px;width:100%}
.col-browse{width:30%;max-height:80vh}
.col-call-detail{width:70%;max-height:80vh;display:flex;gap:12px}
.col-call-half{width:50%;max-height:72vh}
.fn-list{list-style:none;padding:0;margin:0}
.fn-list li{padding:4px 6px;cursor:pointer;border-radius:3px;font-size:12px;border-bottom:1px solid #21262d}
.fn-list li:hover{background:#21262d}
.fn-list li.active{background:#1f6feb33}
.fn-list .file-label{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;padding:4px 6px 2px;margin-top:4px}
.fn-list .fn-name{color:#79c0ff;font-family:monospace}
.fn-list .fn-meta{color:#8b949e;font-size:11px;margin-left:6px}
.fn-list .fn-desc{color:#8b949e;font-size:11px;display:block;padding-left:12px;font-style:italic}
.overview{padding:8px}
.overview h4{color:#f0f6fc;margin:8px 0 4px;font-size:12px}
.overview ul{list-style:none;padding:0;margin:0}
.overview li{font-family:monospace;font-size:12px;color:#79c0ff;padding:2px 4px;cursor:pointer;border-radius:2px}
.overview li:hover{background:#21262d}
.overview li .cnt{color:#8b949e;font-size:11px;margin-left:4px}
</style>
</head>
<body>
<h1>Zero-Core · 代码大纲与调用关系</h1>
<div class="subtitle">基于静态分析 · 后端 src/{main,preload,runtime,server,core,shared}</div>
<div class="stats">
  <div class="stat"><span class="num">${stats.fileCount}</span><span class="label">files</span></div>
  <div class="stat"><span class="num">${stats.functionCount}</span><span class="label">functions</span></div>
  <div class="stat"><span class="num">${stats.exportedCount}</span><span class="label">exported</span></div>
  <div class="stat"><span class="num">${stats.edgeCount}</span><span class="label">edges</span></div>
</div>
<div class="tabs">
  <button class="tab-btn active" data-tab="outline">Outline</button>
  <button class="tab-btn" data-tab="calls">Calls</button>
</div>
<div id="panel-outline" class="panel active">
  <div class="col col-outline">
    <input type="search" id="outline-search" placeholder="filter (e.g. sendPrompt, agent-loop, kb-)">
    <div class="tree" id="outline-tree"></div>
  </div>
  <div class="col col-detail detail" id="outline-detail">
    <div style="color:#8b949e;padding:8px;">点击左侧模块/文件/函数查看详情</div>
  </div>
</div>
<div id="panel-calls" class="panel">
  <div class="panel-calls-inner">
    <div class="col col-browse">
      <input type="search" id="calls-search" placeholder="搜索函数或文件...">
      <div class="toggle">
        <button class="active" data-mode="function">Function</button>
        <button data-mode="file">File</button>
      </div>
      <div id="calls-browse"></div>
    </div>
    <div class="col col-call-detail">
      <div class="col col-call-half">
        <div class="header-bar"><h3>调用了 (callees)</h3></div>
        <ul class="edge-list" id="calls-callees"><li class="empty">先选一个目标</li></ul>
      </div>
      <div class="col col-call-half">
        <div class="header-bar"><h3>被调用 by (callers)</h3></div>
        <ul class="edge-list" id="calls-callers"><li class="empty">先选一个目标</li></ul>
      </div>
    </div>
  </div>
</div>
<div class="footer">生成命令: <code>npm run build:codegraph</code> · 数据来自静态分析，可能因动态 import / 高阶函数遗漏部分调用</div>
<script>
const DATA=${dataJson};
async function init(){
  const funcById=new Map(DATA.functions.map(f=>[f.id,f]));
const fileByPath=new Map(DATA.files.map(f=>[f.path,f]));
const fnCallers=DATA.callers;
const fileCallers=DATA.fileCallers;
const moduleDesc=DATA.moduleDesc;
function shortFile(p){return p.replace(/^src\\//,'')}
function esc(s){const d=document.createElement('span');d.textContent=s;return d.innerHTML;}

// ========== Outline tree ==========
const tree=document.getElementById('outline-tree');
function buildTree(files){
  const root={name:'',children:{},files:[]};
  for(const f of files){
    const parts=f.path.split('/');
    let node=root;
    for(let i=0;i<parts.length-1;i++){
      if(!node.children[parts[i]])node.children[parts[i]]={name:parts[i],children:{},files:[]};
      node=node.children[parts[i]];
    }
    node.files.push(f);
  }
  return root;
}
function renderDir(d,parent){
  const li=document.createElement('li');
  li.className='dir';
  const span=document.createElement('span');
  span.className='name';
  span.textContent=d.name+'/';
  li.appendChild(span);
  const ul=document.createElement('ul');
  ul.style.display='none';
  for(const sd of Object.values(d.children).sort((a,b)=>a.name.localeCompare(b.name)))renderDir(sd,ul);
  for(const fi of d.files.sort((a,b)=>a.path.localeCompare(b.path)))renderFile(fi,ul);
  li.appendChild(ul);
  span.onclick=e=>{e.stopPropagation();li.classList.toggle('open');ul.style.display=li.classList.contains('open')?'block':'none';showDirDetail(d);};
  parent.appendChild(li);
}
function renderFile(fi,parent){
  const li=document.createElement('li');
  li.className='file';
  li.dataset.path=fi.path;
  li.dataset.name=' '+fi.path;
  const span=document.createElement('span');
  span.className='name';
  span.textContent=shortFile(fi.path).split('/').pop()+'  ';
  li.appendChild(span);
  const meta=document.createElement('span');
  meta.className='meta';
  meta.textContent=fi.lines+' lines · '+fi.functions.length+' fns';
  li.appendChild(meta);
  const ul=document.createElement('ul');
  ul.style.display='none';
  for(const fid of fi.functions){
    const f=funcById.get(fid);
    if(!f)continue;
    const fli=document.createElement('li');
    fli.className='fn'+(f.exported?' exported':'');
    fli.dataset.id=f.id;
    fli.dataset.name=' '+f.path+' '+f.name;
    const name=document.createElement('span');
    name.className='name';
    name.textContent=f.name;
    fli.appendChild(name);
    const fm=document.createElement('span');
    fm.className='meta';
    fm.textContent=':'+f.line+(f.statementCount>0?' · '+f.statementCount+' stmts':'');
    fli.appendChild(fm);
    fli.onclick=e=>{e.stopPropagation();document.querySelectorAll('.tree li.selected').forEach(n=>n.classList.remove('selected'));fli.classList.add('selected');showDetail(f);};
    ul.appendChild(fli);
  }
  li.appendChild(ul);
  span.onclick=e=>{e.stopPropagation();li.classList.toggle('open');ul.style.display=li.classList.contains('open')?'block':'none';showFileDetail(fi);};
  parent.appendChild(li);
}
const root=buildTree(DATA.files);
const rootUl=document.createElement('ul');
for(const d of Object.values(root.children).sort((a,b)=>a.name.localeCompare(b.name)))renderDir(d,rootUl);
tree.appendChild(rootUl);

// ========== Filter ==========
document.getElementById('outline-search').addEventListener('input',function(){
  const q=this.value.trim().toLowerCase();
  document.querySelectorAll('.tree li').forEach(li=>{
    const name=(li.dataset.name||'').toLowerCase();
    const match=!q||name.includes(q);
    li.classList.toggle('match-hidden',!match&&q!=='');
    if(q&&match){let p=li.parentElement;while(p&&p.tagName==='UL'){p.style.display='block';if(p.parentElement)p.parentElement.classList.add('open');p=p.parentElement?.parentElement;}}
  });
});

// ========== Detail panel ==========
function showDirDetail(d){
  const detail=document.getElementById('outline-detail');
  detail.innerHTML='';
  const h=document.createElement('h3');h.textContent=d.name+'/';detail.appendChild(h);
  const modKey='src/'+d.name;
  if(moduleDesc[modKey]){const desc=document.createElement('div');desc.className='desc-text';desc.textContent=moduleDesc[modKey];detail.appendChild(desc);}
  // Stats
  const allDirs=[d];
  const collectDirs=(node)=>{for(const sd of Object.values(node.children)){allDirs.push(sd);collectDirs(sd);}};
  collectDirs(d);
  let fileCount=0,fnCount=0;
  const fileInfos=[];
  for(const dd of allDirs){fileCount+=dd.files.length;for(const fi of dd.files){fnCount+=fi.functions.length;fileInfos.push(fi);}}
  const stats=document.createElement('div');stats.className='loc';
  stats.textContent=fileCount+' files · '+fnCount+' functions';
  detail.appendChild(stats);
  // File list
  const fl=document.createElement('h3');fl.textContent='包含文件 ('+fileCount+')';detail.appendChild(fl);
  const ul=document.createElement('ul');ul.className='edge-list';
  for(const fi of fileInfos.sort((a,b)=>a.path.localeCompare(b.path))){
    const li=document.createElement('li');
    const nm=document.createElement('div');nm.className='name';nm.textContent=shortFile(fi.path);
    const mt=document.createElement('div');mt.className='file';mt.textContent=fi.functions.length+' fns · '+fi.lines+' lines';
    li.appendChild(nm);li.appendChild(mt);
    if(fi.description){const ds=document.createElement('span');ds.className='desc-inline';ds.textContent=fi.description.slice(0,80);li.appendChild(ds);}
    li.onclick=()=>showFileDetail(fi);
    ul.appendChild(li);
  }
  detail.appendChild(ul);
}

function showFileDetail(fi){
  const detail=document.getElementById('outline-detail');
  detail.innerHTML='';
  const h=document.createElement('h3');h.textContent=shortFile(fi.path);detail.appendChild(h);
  if(fi.description){const desc=document.createElement('div');desc.className='desc-text';desc.textContent=fi.description;detail.appendChild(desc);}
  const stats=document.createElement('div');stats.className='loc';
  stats.textContent=fi.lines+' lines · '+fi.functions.length+' functions · '+fi.exports.length+' exported · '+fi.imports.length+' imports';
  detail.appendChild(stats);
  // Functions
  const fh=document.createElement('h3');fh.textContent='函数列表 ('+fi.functions.length+')';detail.appendChild(fh);
  const ul=document.createElement('ul');ul.className='edge-list';
  for(const fid of fi.functions){
    const f=funcById.get(fid);
    if(!f)continue;
    ul.appendChild(makeEdgeItem(f,()=>showDetail(f)));
  }
  if(fi.functions.length===0)ul.appendChild(makeEmpty('无可识别的命名函数'));
  detail.appendChild(ul);
  // Imports
  if(fi.imports.length>0){
    const ih=document.createElement('h3');ih.textContent='依赖文件 ('+fi.imports.length+')';detail.appendChild(ih);
    const iul=document.createElement('ul');iul.className='edge-list';
    for(const imp of fi.imports){
      const tf=fileByPath.get(imp);
      const li=document.createElement('li');
      const nm=document.createElement('div');nm.className='name';nm.textContent=shortFile(imp);
      li.appendChild(nm);
      if(tf){
        const mt=document.createElement('div');mt.className='file';mt.textContent=tf.functions.length+' fns';
        li.appendChild(mt);
        if(tf.description){const ds=document.createElement('span');ds.className='desc-inline';ds.textContent=tf.description.slice(0,60);li.appendChild(ds);}
        li.onclick=()=>showFileDetail(tf);
      }
      iul.appendChild(li);
    }
    detail.appendChild(iul);
  }
  // Imported by
  const callers=fileCallers[fi.path]||[];
  if(callers.length>0){
    const ch=document.createElement('h3');ch.textContent='被依赖 by ('+callers.length+')';detail.appendChild(ch);
    const cul=document.createElement('ul');cul.className='edge-list';
    for(const cp of callers){
      const tf=fileByPath.get(cp);
      const li=document.createElement('li');
      const nm=document.createElement('div');nm.className='name';nm.textContent=shortFile(cp);
      li.appendChild(nm);
      if(tf){
        const mt=document.createElement('div');mt.className='file';mt.textContent=tf.functions.length+' fns';
        li.appendChild(mt);
        li.onclick=()=>showFileDetail(tf);
      }
      cul.appendChild(li);
    }
    detail.appendChild(cul);
  }
}

function showDetail(f){
  const detail=document.getElementById('outline-detail');
  detail.innerHTML='';
  const h=document.createElement('h3');h.textContent=f.name;detail.appendChild(h);
  if(f.description){const d=document.createElement('div');d.className='desc-text';d.textContent=f.description;detail.appendChild(d);}
  const sig=document.createElement('div');sig.className='sig';sig.textContent=f.signature;detail.appendChild(sig);
  const loc=document.createElement('div');loc.className='loc';
  loc.textContent=shortFile(f.file)+':'+f.line+'-'+f.endLine+' · '+f.statementCount+' statements · '+(f.exported?'exported':'private');
  detail.appendChild(loc);
  const c1=document.createElement('h3');c1.textContent='调用了 ('+f.callees.length+')';detail.appendChild(c1);
  const ul1=document.createElement('ul');ul1.className='edge-list';
  if(f.callees.length===0)ul1.appendChild(makeEmpty('无（或仅外部/动态调用）'));
  else{const seen=new Set();for(const cid of f.callees){if(seen.has(cid))continue;seen.add(cid);const cf=funcById.get(cid);if(cf)ul1.appendChild(makeEdgeItem(cf,()=>showDetail(cf)));}}
  detail.appendChild(ul1);
  const callers=fnCallers[f.id]||[];
  const c2=document.createElement('h3');c2.textContent='被调用 by ('+callers.length+')';detail.appendChild(c2);
  const ul2=document.createElement('ul');ul2.className='edge-list';
  if(callers.length===0)ul2.appendChild(makeEmpty('无 (entry point)'));
  else for(const cid of callers){const cf=funcById.get(cid);if(cf)ul2.appendChild(makeEdgeItem(cf,()=>showDetail(cf)));}
  detail.appendChild(ul2);
}
function makeEdgeItem(f,onClick){
  const li=document.createElement('li');
  const file=document.createElement('div');file.className='file';file.textContent=shortFile(f.file)+':'+f.line;
  const name=document.createElement('div');name.className='name';name.textContent=f.name;
  li.appendChild(file);li.appendChild(name);
  if(f.description){const d=document.createElement('span');d.className='desc-inline';d.textContent=f.description.slice(0,60)+(f.description.length>60?'...':'');li.appendChild(d);}
  li.onclick=onClick;return li;
}
function makeEmpty(text){const li=document.createElement('li');li.className='empty';li.textContent=text;return li;}

// ========== Tabs ==========
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    document.getElementById('panel-'+btn.dataset.tab).classList.add('active');
  };
});

// ========== Calls panel ==========
let callsMode='function';
let callsTarget=null;
document.querySelectorAll('.toggle button').forEach(btn=>{
  btn.onclick=()=>{document.querySelectorAll('.toggle button').forEach(b=>b.classList.remove('active'));btn.classList.add('active');callsMode=btn.dataset.mode;renderBrowse();};
});

const callsSearch=document.getElementById('calls-search');
callsSearch.addEventListener('input',()=>{
  const q=callsSearch.value.trim().toLowerCase();
  if(!q){callsTarget=null;renderBrowse();return;}
  if(callsMode==='function'){
    const pick=DATA.functions.find(f=>f.name.toLowerCase()===q)||DATA.functions.find(f=>f.name.toLowerCase().includes(q));
    if(pick){callsTarget={mode:'function',id:pick.id};selectCallsTarget();}
  }else{
    const pick=DATA.files.find(f=>f.path.toLowerCase().includes(q));
    if(pick){callsTarget={mode:'file',id:pick.path};selectCallsTarget();}
  }
});

function renderBrowse(){
  const el=document.getElementById('calls-browse');
  el.innerHTML='';
  if(callsMode==='function')renderFunctionBrowse(el);
  else renderFileBrowse(el);
}

function renderFunctionBrowse(el){
  // Group by top-level module
  const groups=new Map();
  for(const f of DATA.functions){
    const mod=f.file.split('/').slice(0,2).join('/');
    if(!groups.has(mod))groups.set(mod,[]);
    groups.get(mod).push(f);
  }
  const list=document.createElement('div');
  list.className='fn-list';
  list.style.maxHeight='68vh';
  list.style.overflowY='auto';
  for(const [mod,fns] of [...groups.entries()].sort()){
    const label=document.createElement('div');
    label.className='file-label';
    label.textContent=mod.replace('src/','')+(moduleDesc[mod]?' - '+moduleDesc[mod].slice(0,40)+'...':'');
    list.appendChild(label);
    for(const f of fns){
      const li=document.createElement('li');
      if(callsTarget&&callsTarget.id===f.id)li.classList.add('active');
      const name=document.createElement('span');
      name.className='fn-name';
      name.textContent=f.name;
      li.appendChild(name);
      const meta=document.createElement('span');
      meta.className='fn-meta';
      meta.textContent=':'+f.line;
      li.appendChild(meta);
      if(f.description){
        const d=document.createElement('span');d.className='fn-desc';d.textContent=f.description.slice(0,60)+(f.description.length>60?'...':'');
        li.appendChild(d);
      }
      li.onclick=()=>{callsTarget={mode:'function',id:f.id};selectCallsTarget();};
      list.appendChild(li);
    }
  }
  el.appendChild(list);
}

function renderFileBrowse(el){
  const groups=new Map();
  for(const f of DATA.files){
    const mod=f.path.split('/').slice(0,2).join('/');
    if(!groups.has(mod))groups.set(mod,[]);
    groups.get(mod).push(f);
  }
  const list=document.createElement('div');
  list.className='fn-list';
  list.style.maxHeight='68vh';
  list.style.overflowY='auto';
  for(const [mod,fs] of [...groups.entries()].sort()){
    const label=document.createElement('div');label.className='file-label';
    label.textContent=mod.replace('src/','');
    list.appendChild(label);
    for(const f of fs){
      const li=document.createElement('li');
      if(callsTarget&&callsTarget.id===f.path)li.classList.add('active');
      const name=document.createElement('span');name.className='fn-name';
      name.textContent=shortFile(f.path).split('/').pop();
      li.appendChild(name);
      const meta=document.createElement('span');meta.className='fn-meta';
      meta.textContent=f.functions.length+' fns';
      li.appendChild(meta);
      if(f.description){const d=document.createElement('span');d.className='fn-desc';d.textContent=f.description.slice(0,60);li.appendChild(d);}
      li.onclick=()=>{callsTarget={mode:'file',id:f.path};selectCallsTarget();};
      list.appendChild(li);
    }
  }
  el.appendChild(list);
}

function selectCallsTarget(){
  renderBrowse();
  const calleesEl=document.getElementById('calls-callees');
  const callersEl=document.getElementById('calls-callers');
  calleesEl.innerHTML='';callersEl.innerHTML='';
  if(!callsTarget)return;
  if(callsTarget.mode==='function'){
    const f=funcById.get(callsTarget.id);
    if(!f)return;
    calleesEl.appendChild(makeLabelRow(f.name+' · '+shortFile(f.file)+':'+f.line));
    if(f.description){const d=document.createElement('li');d.style.cssText='color:#79c0ff;font-size:11px;font-style:italic;padding:4px 6px';d.textContent=f.description;calleesEl.appendChild(d);}
    const seen=new Set();
    for(const cid of f.callees){if(seen.has(cid))continue;seen.add(cid);const cf=funcById.get(cid);if(cf)calleesEl.appendChild(makeEdgeItem(cf,()=>{callsTarget={mode:'function',id:cf.id};callsSearch.value=cf.name;selectCallsTarget();}));}
    if(f.callees.length===0)calleesEl.appendChild(makeEmpty('无外部调用'));
    const callers=fnCallers[f.id]||[];
    for(const cid of callers){const cf=funcById.get(cid);if(cf)callersEl.appendChild(makeEdgeItem(cf,()=>{callsTarget={mode:'function',id:cf.id};callsSearch.value=cf.name;selectCallsTarget();}));}
    if(callers.length===0)callersEl.appendChild(makeEmpty('无 (entry point)'));
  }else{
    const fi=fileByPath.get(callsTarget.id);
    if(!fi)return;
    calleesEl.appendChild(makeLabelRow(shortFile(fi.path)));
    if(fi.description){const d=document.createElement('li');d.style.cssText='color:#79c0ff;font-size:11px;font-style:italic;padding:4px 6px';d.textContent=fi.description;calleesEl.appendChild(d);}
    for(const imp of fi.imports){const tf=fileByPath.get(imp);if(tf)calleesEl.appendChild(makeFileEdge(tf,()=>{callsTarget={mode:'file',id:imp};callsSearch.value=shortFile(imp);selectCallsTarget();}));}
    if(fi.imports.length===0)calleesEl.appendChild(makeEmpty('不依赖其他文件'));
    const callers=fileCallers[fi.path]||[];
    for(const cp of callers){const ff=fileByPath.get(cp);if(ff)callersEl.appendChild(makeFileEdge(ff,()=>{callsTarget={mode:'file',id:cp};callsSearch.value=shortFile(cp);selectCallsTarget();}));}
    if(callers.length===0)callersEl.appendChild(makeEmpty('无被导入'));
  }
}

function makeLabelRow(text){const li=document.createElement('li');li.style.cssText='background:#21262d;color:#f0f6fc;font-weight:600;font-family:monospace';li.textContent=text;return li;}
function makeFileEdge(f,onClick){
  const li=document.createElement('li');
  const file=document.createElement('div');file.className='file';file.textContent=f.path;
  const name=document.createElement('div');name.className='name';name.textContent=f.functions.length+' fns · '+f.lines+' lines';
  li.appendChild(file);li.appendChild(name);
  if(f.description){const d=document.createElement('span');d.className='desc-inline';d.textContent=f.description.slice(0,60);li.appendChild(d);}
  li.onclick=onClick;return li;
}

renderBrowse();
} // end init()
init();
</script>
</body>
</html>`;
}
