// tool-decoupling sub-1: 中立工具层的共享类型。
//
// 这层类型是 design.md(决策 0/1/2/3 + G1/G2/G5)定义的"目标形态"约定。
// sub-1 **只声明类型**,不强制使用 —— 工具仍取旧 ToolExecutionContext,
// buildTool wrapper 行为不变。sub-2+ 才让 execute 签名逐步切到 (input, callerCtx)。
//
// 文件位于 src/tools/ 而非 src/runtime/types.ts:工具是中立纯函数层,
// 它的"调用者上下文"概念与 runtime 内部(loop 机制)解耦 ——
// server(MCP/REST host) 与 runtime(AgentLoop host) 都按这套约定填 callerCtx。
//
// # 文件说明书
// ## 核心功能
// 声明工具目标形态的共享类型:CallerCtx(host 注入的调用者身份 + per-session
// 访问器 + 流式 emit)、ToolStreamEvent(流式事件)、ToolResult<T>(结构化返值约定)。
// ## 输入
// 无(纯类型声明)。
// ## 输出
// - CallerCtx / ToolStreamEvent / ToolResult 类型 export。
// - TodoAccessor / TaskRegistryAccessor 宽松接口(per-session 状态访问器约定)。
// ## 定位
// src/tools/ —— 中立纯函数层共享类型,被未来 execute(input, callerCtx) 签名使用。
// ## 维护规则
// - 字段增删同步 design.md "callerCtx 最终形态"(L204-219)。
// - 本文件**只放类型**,不放运行时值。
// ## 依赖
// - ../../shared/types.js (Scope 等共享类型)。

// ---------------------------------------------------------------------------
// per-session 状态访问器(G1):loop 注入,工具经访问器读写本 loop 状态
// ---------------------------------------------------------------------------

/**
 * 单条 todo(与 todo-write.ts 的 TodoItem 形状一致 —— 这里独立声明而非 import,
 * 让本类型文件无运行时依赖,纯类型约定。todo-write.ts 的 TodoItem 满足此形状;
 * 任何一边改字段要同步另一边。)
 */
export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

/**
 * Loop 持有的 per-session todo 列表访问器(G1)。
 *
 * todos 的主人是 loop(每个 AgentLoop 一份);loop 调 tool 时把本 loop 的
 * 访问器放进 `callerCtx.todos`,tool 经此读写 —— 数据"过 tool 一圈"回 loop,
 * 工具碰不到别的 loop 的 todos。
 *
 * sub-1 只声明形状;具体方法签名随 session 作用域工具迁移(sub-3/4)逐步收敛。
 * 当前故意保持宽松(子集 of todo-write.ts 的 sessionTodos 操作),避免过早绑定。
 */
export interface TodoAccessor {
	/** 当前 session 的 todo 列表(只读快照;空时返 [])。 */
	list(): TodoItem[];
	/** 替换整张列表(原子写)。 */
	set(items: TodoItem[]): void;
}

/**
 * Loop 持有的 per-session TaskRegistry 访问器(G1)。
 *
 * 同 todos 的模式:TaskRegistry(delegated tasks)主人是 loop,访问器让 tool
 * 在本 loop 作用域内查/操作任务。sub-1 只占位,方法集随 Task 工具族迁移收敛。
 *
 * 故意最小:避免和 runtime/subagent-delegator.ts 的 SubagentTaskRegistry 完整
 * API 强耦合 —— 工具只需要"列出/查询/控制"的窄视图。
 */
export interface TaskRegistryAccessor {
	/** 列出本 loop 的 live delegated tasks(可选过滤)。 */
	list(filter?: "running" | "completed"): Array<{
		id: string;
		type: "subagent" | "bash";
		task: string;
		status: string;
		targetAgentId?: string;
	}>;
	/** 取一个 task 的详情(无则 null)。 */
	get(taskId: string): {
		id: string;
		type: "subagent" | "bash";
		task: string;
		status: string;
		targetAgentId?: string;
	} | null;
}

// ---------------------------------------------------------------------------
// 流式事件(G2):可选副作用通道,不影响"返 JSON"模型
// ---------------------------------------------------------------------------

/**
 * 工具流式事件(G2)。流式工具(Bash / Subagent / Wait)执行中通过
 * `callerCtx.emit(event)` 边跑边吐;最终返 JSON(完整结果)。非流式工具无视 emit。
 *
 * - `progress`: 进度提示(粗粒度,如 "正在编译…")。
 * - `partial` : 部分输出(增量文本,如 Bash 边输出边推)。
 * - `step`    : 步骤标记(子任务边界,如 Subagent 的子步骤)。
 *
 * `text` 是人类可读文本;`data` 是任意结构化附加(各 host 自行解读)。
 * emit 可选:测试/合成调用不提供 emit → 工具不流式,只返 JSON。
 */
export interface ToolStreamEvent {
	type: "progress" | "partial" | "step";
	text?: string;
	data?: unknown;
}

// ---------------------------------------------------------------------------
// 结构化返值约定(决策 3):工具 execute 返 JSON,host 决定是否 format
// ---------------------------------------------------------------------------

/**
 * 工具结构化返值的统一壳(决策 3 + G6)。
 *
 * 工具 `execute` 永远返 JSON;每个工具自带 `format(result): string`。
 * - UI/REST → execute → JSON 直渲染(不调 format)。
 * - agent loop → execute → format(JSON) → 文本喂 LLM。
 * - MCP server → execute → format(JSON) → 文本(或 JSON 给外部 client 自决)。
 *
 * `data` 是工具特定的结构化 payload(泛型 T);`error` 缺省时 `ok=true`。
 * 文本工具(G6):JSON = `{text:"..."}`(+ 少量元数据),`format(r) = r.text`。
 *
 * sub-1 只约定形状;旧返 string 的工具在 sub-2+ 增量迁。当前大多数工具仍返
 * 原始 string —— host 把 string 当"已格式化文本"兼容(agent 路径可用)。
 */
export interface ToolResult<T = unknown> {
	ok: boolean;
	data?: T;
	error?: string;
}

// ---------------------------------------------------------------------------
// 调用者上下文(决策 2 + G1/G5):host 注入,LLM 不可见
// ---------------------------------------------------------------------------

/**
 * 外部调用者(MCP server)的 scope —— host 按 token 解析后注入,工具不自查(G5)。
 * 内部 agent / UI 通常不设 scope(sessionId + workingDir 即够);MCP 必设。
 */
export interface CallerScope {
	projectId: string;
	readOnly?: boolean;
	allowedTools?: string[];
}

/**
 * **调用者上下文** —— execute 的第二参,host 在调用点按调用位置自动填入,
 * LLM 看不见、填不了(安全靠结构,不靠约定;决策 2)。
 *
 * 身份(sessionId/agentId/scope) + host 解析后注入项(workingDir) + per-session
 * 状态访问器(todos/taskRegistry) + 流式 emit。
 *
 * 三 host 各填各的字段:
 * - loop 调: `{sessionId, agentId, caller:"internal", toolCallId, turnSeq, workingDir, todos, taskRegistry, emit}`。
 * - MCP server 调: `{scope, caller:"external:mcp", workingDir}`(无 loop 状态 → session 工具不暴露)。
 * - REST/UI 调: `{caller:"ui", scope?, workingDir}`(无真实 loop 状态 → session 工具返示例值)。
 *
 * LLM-visible schema **只**描述 input(做什么);身份(我是谁/能看哪)在结构上与
 * input 分离 —— session 作用域工具只从 callerCtx 取 sessionId,**绝不**从 LLM input 取。
 *
 * sub-1 只声明类型;字段大多可选(渐进迁移,旧工具未用 callerCtx 时不强制)。
 */
export interface CallerCtx {
	// ─── 身份(host 注入,LLM 不可见)──────────────────────────────────
	/** 内部 agent 的 session id(loop 注入;MCP/UI 通常无)。 */
	sessionId?: string;
	/** 内部 agent 的 agent id(loop 注入)。 */
	agentId?: string;
	/** 调用来源:内部 agent loop / UI dispatcher / 外部 MCP server。 */
	caller: "internal" | "ui" | "external:mcp";
	/** 本次工具调用的 id(loop 注入,delegation 工具用它关联 delegated task)。 */
	toolCallId?: string;
	/** 当前 turn 序号(loop 注入,hook 日志用)。 */
	turnSeq?: number;

	// ─── host 解析后注入(工具不自查;G5)──────────────────────────────
	/** 工作目录。loop: session cwd;MCP: scope 推导。 */
	workingDir?: string;
	/** 外部 MCP server 的 scope(token 解析);内部/UI 通常无。 */
	scope?: CallerScope;

	// ─── per-session 状态访问器(loop 注入;G1)────────────────────────
	// MCP/UI 无真实 loop 状态时这些字段缺失 → session 作用域工具不暴露
	// (或返默认/示例值供 Tool 页预览)。
	/** 本 loop 的 todo 访问器。 */
	todos?: TodoAccessor;
	/** 本 loop 的 delegated task registry 访问器。 */
	taskRegistry?: TaskRegistryAccessor;

	// ─── 流式(G2):可选副作用通道 ────────────────────────────────────
	/** 流式事件回调。可选:测试/合成调用不提供 → 工具不流式,只返 JSON。 */
	emit?: (event: ToolStreamEvent) => void;

	// ─── 过渡字段(sub-3,sub-4/5 收敛后删)──────────────────────────────
	// 这些字段在最终设计里要么并入 scope(决策 G5)、要么 loop 侧消化掉。
	// sub-3 让工具读 callerCtx 而非 ToolExecutionContext,但 ctxToCallerCtx
	// 仍从旧 ctx 把它们桥过来;sub-4/5 把 scope/workspaceDir/toolConfig 改成
	// 由 host 在调用点显式填(或并入 scope)。
	/**
	 * sub-3 过渡:per-tool 配置默认值(Read.max_lines / Grep.head_limit / Shell.timeout …)。
	 * loop 从 toolPolicy 解出后注入;工具用它取"未传参时的默认"。sub-4/5 收敛为
	 * host 解析后直接传 input 字段(或并入 scope)。
	 */
	toolConfig?: Record<string, Record<string, any>>;
	/**
	 * sub-3 过渡:文件访问范围(workspace = 限制在 workspaceDir 内 / filesystem = 不限)。
	 * loop 从 session 配置注入;OS 工具(Read/Grep/Glob/Edit/Write)用它做 workspace
	 * 边界检查。sub-4/5 并入 scope.readOnly / 路径白名单。
	 */
	readScope?: "filesystem" | "workspace";
	/**
	 * sub-3 过渡(Wiki scope 回退):本 session 解析出的 wiki anchor node id 集。
	 * G5 说 scope 应是 host 解析的 `{projectId, readOnly}`,但 AgentLoop 侧还没填
	 * scope(那是 sendProjectPrompt 的事,sub-4/5 接)。过渡期 Wiki 工具从
	 * callerCtx.scope 取;scope 为空时回退到这组 anchor id(保持现有 wiki-anchor
	 * 注入逻辑不回归)。sub-4/5 把它换成 scope 后删此字段。
	 */
	wikiAnchorNodeIds?: string[];
	/**
	 * sub-3 过渡:session context bundle({projectId, workspaceDir, wikiRootNodeId} 等)。
	 * loop 从 config.contextBundle 注入;部分工具(Flow 用 workspaceDir 写 requirement
	 * 文档)读它。sub-4/5 收敛为 host 显式填 workingDir + scope。
	 */
	contextBundle?: { projectId?: string; workspaceDir?: string; wikiRootNodeId?: string; [k: string]: unknown };
	/**
	 * sub-3 过渡:本 session 的 project id(loop 从 projectContext 注入)。Wiki scope
	 * 回退 + 工具按 project 取数据时用。sub-4/5 并入 scope.projectId。
	 */
	projectId?: string;
}
