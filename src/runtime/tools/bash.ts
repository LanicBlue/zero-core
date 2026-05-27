import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { buildTool } from "./tool-factory.js";

const execFileAsync = promisify(execFile);

const MAX_BG_RESULT = 50000;

export const bashTool = buildTool({
	name: "bash",
	description:
		"Execute a shell command in the workspace. Returns stdout and stderr. " +
		"Set background=true for long-running commands (downloads, installs) — returns a task_id immediately.",
	userDescription: "在工作目录中执行 shell 命令。支持后台模式：长任务（下载、安装等）设为后台执行，立即返回 task_id，可通过 wait 或 task_status 查询结果。",
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	configSchema: [
		{ key: "timeout", type: "number", label: "默认超时 (s)", description: "命令执行超时时间（秒，留空则不限制）" },
	],
	inputSchema: z.object({
		command: z.string().describe("The shell command to execute"),
		timeout: z.number().optional().describe("Timeout in seconds (foreground only)"),
		background: z.boolean().optional().describe("Run in background and return task_id immediately"),
	}),
	execute: async (input, ctx) => {
		const { command, timeout: inputTimeout, background } = input;
		const config = ctx.toolConfig?.bash ?? {};
		const timeoutSec = inputTimeout ?? config.timeout;
		const timeout = timeoutSec ? timeoutSec * 1000 : undefined;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		const shellArgs = isWin ? ["/c", command] : ["-c", command];

		// Background mode
		if (background) {
			if (!ctx.runBackground) {
				return "Error: Background execution is not available in this context.";
			}
			const taskId = ctx.runBackground(command, timeoutSec);
			return `Command running in background.\ntask_id: ${taskId}\nUse wait or task_status to check progress and retrieve the result.`;
		}

		// Foreground mode
		try {
			const execOpts: any = { cwd: ctx.workingDir, maxBuffer: 10 * 1024 * 1024 };
			if (timeout) execOpts.timeout = timeout;
			const { stdout, stderr } = await execFileAsync(shell, shellArgs, execOpts);
			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += (result ? "\n" : "") + "[stderr] " + stderr;
			return result || "(no output)";
		} catch (err: any) {
			if (err.killed) {
				return `Error: Command timed out after ${timeoutSec}s`;
			}
			return `Error: ${err.message}\n${err.stdout || ""}${err.stderr ? "\n[stderr] " + err.stderr : ""}`;
		}
	},
});
