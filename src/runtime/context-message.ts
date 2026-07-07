// 动态构建每 turn 注入的 <context> 块：环境信息 + guidelines + recalled memories。
//
// # 文件说明书
//
// ## 核心功能
// buildContextMessage 把环境(日期/时区/OS/CPU/工作目录)、guidelines、
// Recalled Memories 拼成一个 <context> 块。每 turn 重建,不写 DB;动态内容
// 插在最后一条 user 消息文本之前,使真正的 user 文本处于末尾、获得最高
// 注意力(参考 claude-code attachment 与 Aider reminder 模式)。
//
// sub-7 (work-context 拆解到三通道):本块现在是 **Recalled Memories 专用通道**
// —— Project / Wiki Baseline / Requirement 移到 system 段(按需),Steps
// Progress 移到 workbench 段(per-step),Wiki Anchors(根 + 一层)合并进缓存的
// `wiki-system-anchors` system 段。设计 §1.2 / acceptance-7。
//
// acceptance-7 补遗:`## Recalled Memories` 段**始终出现**(即使 recall 未接入、
// memoryContext 为空) —— 通道常在,recall 接入后自然填,不因空 skip。
//
// ## 输入
// - workspaceDir:工作目录,用于提示工具默认路径与 cd 行为
// - guidelines:字符串数组,逐条列在 ## Guidelines 下
// - memoryContext:Recalled Memories 内容(recall 接入前为 undefined / 空)
//
// ## 输出
// - 拼好的 <context>…</context> 字符串;无任何动态片段时返回 null(由调用方判断是否注入)
//
// ## 定位
// runtime 层纯函数模块,被 agent-loop 在每次 LLM 调用前组装临时上下文。
//
// ## 依赖
// - node:os(CPU/RAM/OS 信息)
//
// ## 维护规则
// - 新增上下文段落时统一在此函数追加 ## 子标题,不要在 agent-loop 里手拼。
// - 工作目录提示文案若调整,注意保持 Shell 不持久化 cd 的语义说明一致。
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
	/**
	 * sub-7: Recalled Memories payload. Reserved for the future recall wiring
	 * (recall source = wiki per-agent memory subtree; not connected in this sub).
	 * The `## Recalled Memories` section is ALWAYS emitted per acceptance-7
	 * 补遗 — content is empty when undefined / falsy, but the section header
	 * stays so the channel is structurally present.
	 */
	memoryContext?: string;
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

	// sub-7: Recalled Memories section is ALWAYS emitted (acceptance-7 补遗 —
	// channel stays even when recall is not wired / payload is empty). Content
	// is the memoryContext payload when present, otherwise a placeholder line.
	parts.push(
		"## Recalled Memories\n"
		+ (config.memoryContext?.trim() ? config.memoryContext.trim() : "(none yet)"),
	);

	// (sub-1) todos moved to the per-step workbench channel (renderWorkbench).
	// (sub-7) wiki anchors moved into the cached `wiki-system-anchors` system
	// section; Project / Wiki Baseline / Requirement / Steps Progress moved to
	// the system + workbench channels via SessionConfig closures.

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
