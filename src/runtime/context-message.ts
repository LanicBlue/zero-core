// 动态构建每 turn 注入的 <context> 块：环境信息 + guidelines + 记忆 + RAG。
//
// # 文件说明书
//
// ## 核心功能
// buildContextMessage 把环境（日期/时区/OS/CPU/工作目录）、guidelines、recalled memory、
// RAG 知识库拼成一个 <context> 块。每 turn 重建，不写 DB；动态内容插在最后一条 user 消息
// 文本之前，使真正的 user 文本处于末尾、获得最高注意力（参考 claude-code attachment 与
// Aider reminder 模式）。
//
// ## 输入
// - workspaceDir：工作目录，用于提示工具默认路径与 cd 行为
// - guidelines：字符串数组，逐条列在 ## Guidelines 下
// - ragContext：知识库召回文本，写入 ## Knowledge Base
// - memoryContext：记忆召回文本，写入 ## Recalled Memories
//
// ## 输出
// - 拼好的 <context>…</context> 字符串；无任何动态片段时返回 null（由调用方判断是否注入）
//
// ## 定位
// runtime 层纯函数模块，被 agent-loop 在每次 LLM 调用前组装临时上下文。
//
// ## 依赖
// - node:os（CPU/RAM/OS 信息）
// - 上游 hooks（memory-hooks、rag-hooks）产出的 memoryContext/ragContext 文本
//
// ## 维护规则
// - 新增上下文段落时统一在此函数追加 ## 子标题，不要在 agent-loop 里手拼。
// - 工作目录提示文案若调整，注意保持 Shell 不持久化 cd 的语义说明一致。
// - 环境字段变更需同步 docs 中关于 context 注入的说明。

import * as os from "os";

export function buildContextMessage(config: {
	workspaceDir?: string;
	guidelines?: string[];
	ragContext?: string;
	memoryContext?: string;
}): string | null {
	const parts: string[] = [];

	const env = buildEnvironmentBlock(config.workspaceDir);
	parts.push(env);

	if (config.guidelines?.length) {
		parts.push("## Guidelines\n" + config.guidelines.map(g => `- ${g}`).join("\n"));
	}

	if (config.memoryContext) {
		parts.push("## Recalled Memories\n" + config.memoryContext);
	}

	if (config.ragContext) {
		parts.push("## Knowledge Base\n" + config.ragContext);
	}

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
