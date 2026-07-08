// Todo 任务管理工具
//
// # 文件说明书
//
// ## 核心功能
// 提供任务列表管理能力,跟踪当前会话的任务进度。
//
// ## 输入
// - 任务列表(经 LLM input —— 这是工具的实际负载,非身份)
//
// ## 输出
// - 更新后的任务列表(ToolResult JSON + format 文本)
//
// ## 定位
// 中立工具层(src/tools/),被 agent loop / UI dispatcher 调。
//
// ## 依赖
// - zod - 数据验证
// - ./types.js - CallerCtx / TodoAccessor / ToolResult
// - ./tool-factory.js - buildTool
//
// ## 维护规则
// - 保持任务状态准确
// - 处理并发更新
// - 按 sessionId 隔离(同一 agent 的不同 project session 各自独立 todo 列表,
//   避免"Tasks 在一个 agent 内跨 session 串显")
// - tool-decoupling sub-4(G1 per-session 访问器 + 决策 2/3):
//   · 身份(sessionId/agentId)只从 callerCtx 取,**绝不**从 LLM input 取。
//   · todos 经 `callerCtx.todos.set(...)` 写(访问器形态,G1);本 loop 的真状态
//     过 tool 一圈回 loop。UI/外部 host 无 loop 状态时,访问器把 todos 装在
//     ephemeral key(UI 预览不崩)。
//   · execute 返 ToolResult{data:{text, count, inProgress}}(G6 文本壳);
//     format(r) = r.data.text。文本形态与 sub-4 前完全一致(agent 行为不回归)。
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// TodoWrite — per-session task list management
// ---------------------------------------------------------------------------

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

// Per-session in-memory todo store. Keyed by sessionId(同一 agent 的 General /
// 各 project session 互不干扰)。sessionId 缺失时退化为 agentId,保证旧路径不崩。
//
// G1 说"todos 的主人是 loop",但实际现状是 module-level Map(sub-4 收敛前)。
// sub-4 的迁移语义:callerCtx.todos 访问器 read/write 这张 Map(经
// setSessionTodosForCtx / getSessionTodos 导出);loop 侧(ctxToCallerCtx)建访问器
// 时把 ctx.sessionId 闭包进去 —— 数据仍 per-session keyed,只是读写路径走访问器。
// sub-5+ 真正把这张 Map 挪到 loop / 单例后,访问器形态不变,只换底层。
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
 * sub-4 bridge:write the per-session todos under the ctx's key. Called by the
 * TodoAccessor built in tool-factory's ctxToCallerCtx (so the tool itself stays
 * decoupled from the keying scheme — it just calls callerCtx.todos.set(items)).
 *
 * Exported (not just used internally) so the accessor in tool-factory can reach
 * it without re-implementing the key logic.
 */
export function setSessionTodosForCtx(
	sessionId: string | undefined,
	agentId: string | undefined,
	items: TodoItem[],
): void {
	sessionTodos.set(todoKey(sessionId, agentId), items);
}

/**
 * Render the session's current todo list as a context block (null if empty).
 * Called by agent-loop each turn so the agent SEES its todo state (not just
 * writes blindly). Rendering lives here (the todo module); agent-loop only
 * wires the result into buildContextMessage — keeps tool/loop concerns separate.
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

/** ToolResult data shape (decision 3: JSON). UI dispatcher consumes this directly. */
export interface TodoWriteData {
	/** LLM-facing text: full rendered list (same as pre-sub-4 agent output). */
	text: string;
	/** Total items after the write. */
	count: number;
	/** Items in in_progress state after the write. */
	inProgress: number;
}

export const todoWriteTool = buildTool({
	name: "TodoWrite",
	description: "Update the task list to track progress on multi-step work.",
	prompt:
		"Create and update a task list for tracking progress on multi-step work.\n\nWhen to update todos:\n- Starting a complex task with 3+ distinct steps\n- After completing a step — mark it done immediately\n- When discovering new work during implementation\n\nTask format: each item has content (imperative, e.g. 'Fix auth bug') and status (pending/in_progress/completed).\nKeep exactly one task in_progress at a time. Complete current tasks before starting new ones.",
	meta: { category: "interaction", isReadOnly: false, isConcurrencySafe: false, exposable: true },
	inputSchema: z.object({
		todos: z.array(z.object({
			content: z.string().min(1).describe("Task description (imperative form, e.g. 'Run tests')"),
			status: z.enum(["pending", "in_progress", "completed"]).describe("Current status"),
			activeForm: z.string().min(1).describe("Present continuous form (e.g. 'Running tests')"),
		})).describe("Complete task list — replaces the previous list entirely"),
	}),
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<TodoWriteData>> => {
		const todos: TodoItem[] = input.todos ?? [];

		// G1:write through the per-session accessor. The accessor (built by
		// ctxToCallerCtx) closures this ctx's sessionId/agentId and writes the
		// module-level sessionTodos Map under the right key. When callerCtx.todos
		// is missing (UI/external host without a real loop), we degrade to an
		// ephemeral in-memory write under this caller's key — UI preview still
		// reflects the just-written list.
		if (callerCtx.todos) {
			callerCtx.todos.set(todos);
		} else {
			// UI/external host without a loop: write directly under the caller's
			// identity key (sessionId ?? agentId ?? "_default") so a follow-up
			// read (renderTodosContext) sees it. Best-effort preview path.
			setSessionTodosForCtx(callerCtx.sessionId, callerCtx.agentId, todos);
		}

		// Emit the loop-facing todos_update event (renderer pulls the new list).
		// Same shape as pre-sub-4 (event carries agentId/sessionId so the renderer
		// routes per-session; pendingResponses / runtime:tasks:changed are also
		// loop-level events that share the emit channel).
		callerCtx.emit?.({
			type: "todos_update",
			agentId: callerCtx.agentId,
			sessionId: callerCtx.sessionId,
			todos,
		} as any);

		// Render the full list so the agent SEES what it just committed (not just
		// a count). renderTodosContext reads the same Map the accessor just wrote,
		// so this is consistent with the loop's view.
		const rendered = renderTodosContext(callerCtx.sessionId, callerCtx.agentId) ?? "(empty list)";
		const inProgress = todos.filter((t) => t.status === "in_progress").length;
		const text = `Task list updated (${inProgress} in progress).\n${rendered}`;
		return {
			ok: true,
			data: {
				text,
				count: todos.length,
				inProgress,
			},
		};
	},
	// format(): pure function. Returns the LLM-facing text (the rendered list
	// post-write). Mirrors the pre-sub-4 string output so agent behavior is
	// unchanged; the JSON shape (above) is what the UI dispatcher will consume.
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "TodoWrite failed.";
		}
		return (result.data as TodoWriteData)?.text ?? "(empty list)";
	},
});
