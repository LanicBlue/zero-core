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
	"src/server": "持久化层：SQLite stores（10 个）、AgentService 全局调度、SessionManager 生命周期、MCP 客户端、知识库（向量 + embedding）、recovery",
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
	"src/main/ipc/message-handlers.ts": "messages:clear/edit/delete handler → session-db CRUD + agentService.recreateLoop",
	"src/main/ipc/agent-handlers.ts": "agent CRUD handler（registerCrud 封装）",
	"src/main/ipc/provider-handlers.ts": "provider CRUD + provider:test-connection handler",
	"src/main/ipc/template-handlers.ts": "template CRUD handler",
	"src/main/ipc/github-template-handlers.ts": "GitHub template 预览 + import handler",
	"src/main/ipc/mcp-handlers.ts": "MCP server CRUD + tool 列表 handler",
	"src/main/ipc/kb-handlers.ts": "知识库文件管理 + 搜索 + embedding handler",
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
	"src/runtime/tools/index.ts": "工具注册中心：registerBuiltInTools，导出所有内置工具（bash/read/write/edit/grep/glob/web-search/todo/agent/ask-user）",
	"src/runtime/tools/agent-tool.ts": "AgentTool 基类：output truncation，max result size，tool result 格式化",
	"src/runtime/tools/bash-tool.ts": "Bash 执行工具：子进程 + timeout + max buffer + 输出截断",
	"src/runtime/tools/read-tool.ts": "文件读取工具：读取文件内容，行号范围",
	"src/runtime/tools/write-tool.ts": "文件写入工具：创建或覆盖文件",
	"src/runtime/tools/edit-tool.ts": "文件编辑工具：精确字符串替换",
	"src/runtime/tools/grep-tool.ts": "内容搜索工具：ripgrep 封装",
	"src/runtime/tools/glob-tool.ts": "文件搜索工具：glob 模式匹配",
	"src/runtime/tools/web-search.ts": "Web 搜索：DuckDuckGo（默认）/SearXNG/SerpAPI/Brave 四个 provider，运行时可切换",
	"src/runtime/tools/todo-write-tool.ts": "Todo 列表管理工具：创建/更新任务列表",
	"src/runtime/tools/agent-delegation-tool.ts": "Sub-agent 委派：blocking + auto-background 模式",
	"src/runtime/tools/tool-registry.ts": "ToolRegistry：工具注册中心，按名称查找，执行调度",
	"src/runtime/tools/tool-policy.ts": "ToolPolicy：白/黑名单过滤，控制可用工具集",
	"src/runtime/tools/bash.ts": "Bash 执行工具实现：子进程 + timeout + 输出截断 + 编码处理",
	"src/runtime/tools/glob.ts": "文件搜索工具实现：glob 模式匹配",
	"src/runtime/tools/grep.ts": "内容搜索工具实现：ripgrep 封装",
	"src/runtime/tools/file-read.ts": "文件读取工具实现：支持多种文件类型（文本/图片/PDF/Jupyter）",
	"src/runtime/tools/file-write.ts": "文件写入工具实现",
	"src/runtime/tools/file-edit.ts": "文件编辑工具实现：精确字符串替换",
	"src/runtime/tools/file-read-helpers.ts": "文件读取辅助：类型检测、编码、PDF 提取、Jupyter 解析、相似文件推荐",
	"src/runtime/tools/ask-user.ts": "AskUser 工具：向用户提问并等待回复",
	"src/runtime/tools/agent.ts": "Agent 委派工具实现",
	"src/runtime/tools/mcp-tool.ts": "MCP 工具桥接：将 MCP server 工具适配为内置工具接口",
	"src/runtime/tools/tool-factory.ts": "工具工厂：根据配置构建工具实例，参数校验，结果截断",
	"src/runtime/tools/todo-write.ts": "Todo 列表管理工具实现",
	"src/runtime/tools/task-list.ts": "任务列表格式化输出",
	"src/runtime/tools/task-status.ts": "任务状态查询与格式化",
	"src/runtime/tools/task-stop.ts": "后台任务停止工具",
	"src/runtime/tools/wait.ts": "统一等待工具：定时唤醒 / 等待外部事件",
	"src/runtime/tools/syntax-check.ts": "语法检查工具：检测未闭合字符串等常见语法问题",
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
	"src/runtime/mcp-tools/assistant-tools.ts": "辅助工具集：最新日志查看、文件搜索、敏感信息脱敏",
	"src/runtime/mcp-tools/fetch-tools.ts": "网络请求工具：URL 获取 + HTML 转 Markdown",
	"src/runtime/mcp-tools/memory-tools.ts": "知识图谱记忆工具：读取/写入实体和关系",
	"src/runtime/mcp-tools/sequential-thinking-tools.ts": "顺序思考工具：逐步推理和思考链跟踪",
	"src/runtime/tools/outline/index.ts": "Outline 工具入口：按文件扩展名选择提取器，支持 27 种语言",
	"src/runtime/tools/outline/renderer.ts": "Outline 渲染器：将 AST 节点转为格式化文本输出",
	"src/runtime/tools/outline/stripper.ts": "代码剥离器：移除注释和字符串内容，减少噪音",
	"src/runtime/tools/outline/types.ts": "Outline 类型定义：OutlineNode, SymbolKind, ExtractionResult 等",
	"src/runtime/tools/outline/extractors/c-family.ts": "C/C++/ObjC outline 提取器",
	"src/runtime/tools/outline/extractors/css.ts": "CSS/SCSS/LESS outline 提取器",
	"src/runtime/tools/outline/extractors/dart.ts": "Dart outline 提取器",
	"src/runtime/tools/outline/extractors/elixir.ts": "Elixir outline 提取器",
	"src/runtime/tools/outline/extractors/go.ts": "Go outline 提取器",
	"src/runtime/tools/outline/extractors/graphql.ts": "GraphQL outline 提取器",
	"src/runtime/tools/outline/extractors/html.ts": "HTML outline 提取器",
	"src/runtime/tools/outline/extractors/ini.ts": "INI/TOML/YAML 配置文件 outline 提取器",
	"src/runtime/tools/outline/extractors/java.ts": "Java outline 提取器",
	"src/runtime/tools/outline/extractors/json.ts": "JSON outline 提取器：对象/数组结构解析",
	"src/runtime/tools/outline/extractors/kotlin.ts": "Kotlin outline 提取器",
	"src/runtime/tools/outline/extractors/lua.ts": "Lua outline 提取器",
	"src/runtime/tools/outline/extractors/markdown.ts": "Markdown outline 提取器：标题层级解析",
	"src/runtime/tools/outline/extractors/nim.ts": "Nim outline 提取器",
	"src/runtime/tools/outline/extractors/php.ts": "PHP outline 提取器",
	"src/runtime/tools/outline/extractors/protobuf.ts": "Protobuf outline 提取器",
	"src/runtime/tools/outline/extractors/python.ts": "Python outline 提取器：class/function/def 缩进块解析",
	"src/runtime/tools/outline/extractors/r-lang.ts": "R 语言 outline 提取器",
	"src/runtime/tools/outline/extractors/ruby.ts": "Ruby outline 提取器",
	"src/runtime/tools/outline/extractors/rust.ts": "Rust outline 提取器",
	"src/runtime/tools/outline/extractors/scala.ts": "Scala outline 提取器",
	"src/runtime/tools/outline/extractors/shell.ts": "Shell/Bash outline 提取器",
	"src/runtime/tools/outline/extractors/sql.ts": "SQL outline 提取器",
	"src/runtime/tools/outline/extractors/svelte.ts": "Svelte outline 提取器",
	"src/runtime/tools/outline/extractors/swift.ts": "Swift outline 提取器",
	"src/runtime/tools/outline/extractors/toml.ts": "TOML outline 提取器",
	"src/runtime/tools/outline/extractors/typescript.ts": "TypeScript/JSX outline 提取器：声明解析 + 块匹配",
	"src/runtime/tools/outline/extractors/vue.ts": "Vue SFC outline 提取器",
	"src/runtime/tools/outline/extractors/yaml.ts": "YAML outline 提取器",
	"src/runtime/tools/outline/extractors/zig.ts": "Zig outline 提取器",
	// server
	"src/server/agent-service.ts": "AgentService 类：全局调度入口，sendPrompt → createLoop → loop.run，session 管理，事件分发，recovery",
	"src/server/session-manager.ts": "SessionManager：session 生命周期状态机（created→streaming→disposed），TTL 清理，metrics hooks",
	"src/server/session-db.ts": "SessionDB：SQLite CRUD（sessions/messages/turns/turn_state），cleanOldTurnState 24h 清理",
	"src/server/sqlite-store.ts": "SqliteStore 基类：通用 SQLite 表管理，ensureTable + self-heal（ALTER ADD COLUMN if missing）",
	"src/server/db-migration.ts": "数据库迁移：schema 初始化 + KV migration（每个独立 try/catch）",
	"src/server/recovery.ts": "Recovery：cleanOldTurnState + resume incomplete sessions，启动时调用",
	"src/server/mcp-manager.ts": "MCP 客户端管理：stdio + SSE 传输，启动 reconnect，tool 注册到 ToolRegistry",
	"src/server/kb-store.ts": "KbStore：知识库元数据管理（文件列表、chunk 元数据）",
	"src/server/kb-db.ts": "KbDB：知识库向量存储（独立 knowledge.db），cosine similarity + top-K",
	"src/server/kb-search.ts": "KbSearch：知识库检索（embedding → 向量搜索 → 排序）",
	"src/server/kb-embeddings.ts": "KbEmbeddings：embedding 生成（OpenAI/Ollama），20 chunk 一批，失败 graceful",
	"src/server/kb-router.ts": "KbRouter：知识库 CRUD 路由，协调 KbStore/KbDB/KbSearch/KbEmbeddings",
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
	"src/server/kb-ingest.ts": "知识库文件摄取管道：读取 → 分块 → embedding → 写入向量 DB",
	"src/server/mcp-router.ts": "MCP 服务器管理路由：CRUD + 连接测试 + tool 同步",
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
			exported: f.exported, signature: f.signature, description: f.description,
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
writeFileSync(outPath, html, "utf-8");
console.log(
	`✓ Wrote ${outPath}\n` +
	`  ${files.length} files · ${allFunctions.length} functions (${exportedCount} exported)\n` +
	`  ${fileEdges.length} import edges · ${functionEdges.length} call edges`,
);

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
</script>
</body>
</html>`;
}
