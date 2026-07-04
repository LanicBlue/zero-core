// 动态构建每 turn 注入的 <context> 块：环境信息 + guidelines + current-task + memory 索引 + RAG。
//
// # 文件说明书
//
// ## 核心功能
// buildContextMessage 把环境（日期/时区/OS/CPU/工作目录）、guidelines、current-task、
// memory 索引(wiki per-agent 锚点)、RAG 知识库拼成一个 <context> 块。每 turn 重建，
// 不写 DB；动态内容插在最后一条 user 消息文本之前，使真正的 user 文本处于末尾、获得
// 最高注意力（参考 claude-code attachment 与 Aider reminder 模式）。
//
// v0.8 (P2 §11.6 / §11.7): memory 现在是 wiki per-agent 子树索引(经
// wikiAnchorsContext 注入);旧的独立 memoryContext 路径(FTS5 召回)已废,但参数
// 保留为前向兼容入口(无 hook 再写入它)。新增 currentTask 字段。
//
// ## 输入
// - workspaceDir：工作目录，用于提示工具默认路径与 cd 行为
// - guidelines：字符串数组，逐条列在 ## Guidelines 下
// - ragContext/memoryContext：(已废并移除)旧 FTS5 召回路
//
// ## 输出
// - 拼好的 <context>…</context> 字符串；无任何动态片段时返回 null（由调用方判断是否注入）
//
// ## 定位
// runtime 层纯函数模块，被 agent-loop 在每次 LLM 调用前组装临时上下文。
//
// ## 依赖
// - node:os（CPU/RAM/OS 信息）
//
// ## 维护规则
// - 新增上下文段落时统一在此函数追加 ## 子标题，不要在 agent-loop 里手拼。
// - 工作目录提示文案若调整，注意保持 Shell 不持久化 cd 的语义说明一致。
// - 环境字段变更需同步 docs 中关于 context 注入的说明。

import * as os from "os";

export function buildContextMessage(config: {
	workspaceDir?: string;
	guidelines?: string[];
	/**
	 * Per-agent toggle for the Environment section. undefined ⇒ on (the historic
	 * default — env was always injected before this toggle was wired). Set false
	 * to drop the Environment block from the context.
	 */
	useDeviceContext?: boolean;
	memoryContext?: string;
	/**
	 * v0.8 (P1 §10.6): pre-rendered wiki anchor block for the `context`
	 * channel (project anchor outline + memory anchor index). Computed per
	 * turn by renderContextAnchors in wiki-anchor-injection.ts; injected
	 * here so it lands inside <context> (every turn, NOT in message history).
	 *
	 * v0.8 (P2 §11.6): the memory anchor is now the agent's per-agent memory
	 * subtree index (memory/<agentId>/).
	 */
	wikiAnchorsContext?: string;
	/**
	 * v0.8 (P2 §11.7): the session's current task — the requirement the
	 * session is currently working on (derived from context.projectId +
	 * active requirement). Plain text; rendered under ## Current Task.
	 * Re-evaluated every turn (the active requirement may switch mid-session).
	 */
	currentTask?: string;
	/**
	 * The agent's current todo list (pre-rendered by renderTodosContext in
	 * todo-write.ts). Injected every turn so the agent knows its own task
	 * state — without this the agent could write todos but never read them.
	 */
	todosContext?: string;
}): string | null {
	const parts: string[] = [];

	// useDeviceContext defaults ON (undefined ⇒ !== false). Historic behavior
	// (env always injected) is preserved for every agent that never set the toggle.
	if (config.useDeviceContext !== false) {
		parts.push(buildEnvironmentBlock(config.workspaceDir));
	}

	if (config.guidelines?.length) {
		parts.push("## Guidelines\n" + config.guidelines.map(g => `- ${g}`).join("\n"));
	}

	// v0.8 (P2 §11.7): current-task goes ABOVE memory/wiki so the model sees
	// "what am I doing right now" right after the guidelines, before the
	// background knowledge.
	if (config.currentTask) {
		parts.push("## Current Task\n" + config.currentTask);
	}

	if (config.memoryContext) {
		parts.push("## Recalled Memories\n" + config.memoryContext);
	}

	if (config.wikiAnchorsContext) {
		parts.push("## Wiki Anchors (context)\n" + config.wikiAnchorsContext);
	}

	if (config.todosContext) {
		parts.push("## Task List (your todos)\n" + config.todosContext);
	}

	if (parts.length === 0) return null;
	return `<context>\n${parts.join("\n\n")}\n</context>\n`;
}

function buildEnvironmentBlock(workspaceDir?: string): string {
	const now = new Date();
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const lines = [
		"## Environment",
		`Date: ${now.toISOString().slice(0, 10)} (${now.toLocaleDateString("en-US", { weekday: "long" })})`,
		`Time: ${now.toLocaleTimeString("en-US", { hour12: false })} (${tz})`,
		`OS: ${os.type()} ${os.release()} (${os.arch()})`,
		`CPU: ${os.cpus()[0]?.model} (${os.cpus().length} cores) | RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`,
	];
	if (workspaceDir) {
		const cwd = workspaceDir.replace(/\\/g, "/");
		lines.push(`Working directory: ${cwd}`);
		lines.push("All tools (Shell, Read, Write, Edit, Glob, Grep) default to this directory. Shell `cd` does NOT persist across calls - always use absolute paths or chain `cd dir && command` in a single call.");
	}
	return lines.join("\n");
}
