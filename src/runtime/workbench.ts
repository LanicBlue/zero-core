// Workbench 通道 —— per-step 注入的活状态块。
//
// # 文件说明书
//
// ## 核心功能
// renderWorkbench 拼一个 `<workbench>` 块,包含当前 step 的活状态(todos /
// Steps Progress / 后续 task 状态 / wait 状态)。每 step 由 agent-loop 调用,
// 作为非持久 user 消息追加到该 step 的输入末尾(走 appendMessages 语义)。
//
// ## 与三通道的关系
// - system:稳定(按需)—— role/guidelines/wiki anchors/project/requirement
// - context:每 turn 持久 —— recalled memories
// - workbench:每 step 非持久 —— todos / Steps Progress / task 状态 / wait 状态(本文件)
//
// ## 为什么是 append 而非 prepend
// turn 内 step 2+ 的最新消息常是 tool result(数组结构),prepend 字符串会
// 破坏格式。追加成 user 消息(与 task-control `[control]` 同机制)format-safe。
//
// ## 定位
// src/runtime/ —— 运行时层,被 agent-loop 在每 step 调用。
//
// ## 依赖
// - todo-write.ts(renderTodosContext)
//
// ## 维护规则
// - 新增活状态段(task 状态/wait 状态)在此函数追加 ## 子标题。
// - 各段为空则不出现;全空返回 null(调用方跳过注入)。

import { renderTodosContext } from "./tools/todo-write.js";

/**
 * Options for the per-step workbench render. `stepsProgress` is the server-
 * built closure output (config.stepsProgressSection, see SessionConfig) —
 * passed as a pre-rendered string so this module stays free of server-store
 * imports (DI invariant).
 */
export interface RenderWorkbenchOptions {
	sessionId?: string;
	agentId?: string;
	/** sub-7: pre-rendered Steps Progress text (per-step live). Empty → omit. */
	stepsProgress?: string;
}

/**
 * Render the per-step `<workbench>` block (live state: todos, Steps Progress,
 * later task/wait). Returns null when empty so the caller skips injection.
 *
 * sub-1: todos. sub-7: Steps Progress (per-step, from a SessionConfig closure).
 * task status / wait state added in later subs.
 */
export function renderWorkbench(opts: RenderWorkbenchOptions | string, agentId?: string): string | null {
	// Back-compat: legacy callers passed (sessionId, agentId). Normalize.
	const normalized: RenderWorkbenchOptions = typeof opts === "string"
		? { sessionId: opts, agentId }
		: opts;

	const parts: string[] = [];

	const todos = renderTodosContext(normalized.sessionId, normalized.agentId);
	if (todos) parts.push("## Task List (your todos)\n" + todos);

	if (normalized.stepsProgress) {
		parts.push("## Steps Progress\n" + normalized.stepsProgress);
	}

	if (parts.length === 0) return null;
	return `<workbench>\n${parts.join("\n\n")}\n</workbench>`;
}
