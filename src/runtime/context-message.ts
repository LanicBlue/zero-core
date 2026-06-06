// 动态上下文消息构建
//
// 每 turn 重建，注入到当前 user message 之前，不存 DB。
// 参考 claude-code 的 attachment 模式和 Aider 的 reminder 模式：
// 动态内容放在最后一条 user message 的文本之前，user text 在末尾获得更高注意力。

import * as os from "os";

export function buildContextMessage(config: {
	workspaceDir?: string;
	guidelines?: string[];
	ragContext?: string;
}): string | null {
	const parts: string[] = [];

	const env = buildEnvironmentBlock(config.workspaceDir);
	parts.push(env);

	if (config.guidelines?.length) {
		parts.push("## Guidelines\n" + config.guidelines.map(g => `- ${g}`).join("\n"));
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
		lines.push(`Working directory: ${workspaceDir}`);
	}
	return lines.join("\n");
}
