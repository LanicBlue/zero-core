// Todo state — per-session in-memory todo store (leaf module).
//
// # 文件说明书
//
// ## 核心功能
// Per-session todo list (the TodoWrite tool 的底层存储)+ 读写它的 accessor
// 函数。抽成 **叶子模块**(不从 tools/runtime 图里 import 任何东西),让
// tool-factory 和 agent-loop 能 **静态 import** 它,而不与 todo-write 形成环
// (todo-write 要 import tool-factory 的 buildTool;抽出前 tool-factory 只能
// lazy-`require` todo-write,而 require 在 ESM 下未定义 —— 即本次修复的 bug)。
//
// ## 定位
// Leaf state module。被 import:todo-write(工具本体)、tool-factory +
// agent-loop(CallerCtx 的 todos 访问器)、workbench / todo-cleanup-hooks /
// agent-service(经 todo-write 的 re-export)。
//
// ## 维护规则
// - 保持本模块 **无 import**(除 type) —— 它必须是叶子,这是打破 tool-factory ↔
//   todo-write 环的全部意义。需要新依赖时,先想清楚是否破坏叶子属性。

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

// Per-session in-memory todo store。Keyed by sessionId(同一 agent 的 General /
// 各 project session 互不干扰);sessionId 缺失时退化为 agentId,保证旧路径不崩。
const sessionTodos = new Map<string, TodoItem[]>();

function todoKey(sessionId: string | undefined, agentId: string | undefined): string {
	return sessionId ?? agentId ?? "_default";
}

export function getSessionTodos(sessionId: string): TodoItem[] {
	return sessionTodos.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
	sessionTodos.delete(sessionId);
}

/**
 * Write the per-session todos under the ctx's key. Called by the TodoAccessor
 * built in tool-factory / agent-loop(so the tool 本体 stays decoupled from the
 * keying scheme —— it just calls callerCtx.todos.set(items))。
 */
export function setSessionTodosForCtx(
	sessionId: string | undefined,
	agentId: string | undefined,
	items: TodoItem[],
): void {
	sessionTodos.set(todoKey(sessionId, agentId), items);
}

/**
 * Render the session's current todo list as a context block(null if empty)。
 * Called by agent-loop each turn so the agent SEES its todo state(not just
 * writes blindly)。
 */
export function renderTodosContext(sessionId: string | undefined, agentId?: string): string | null {
	const todos = sessionTodos.get(todoKey(sessionId, agentId));
	if (!todos || todos.length === 0) return null;
	const lines = todos.map((t) => {
		const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
		return `- ${mark} ${t.content}`;
	});
	const completed = todos.filter((t) => t.status === "completed").length;
	return `${completed}/${todos.length} done\n` + lines.join("\n");
}
