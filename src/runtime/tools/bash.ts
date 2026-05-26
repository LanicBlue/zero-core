import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildTool } from "./tool-factory.js";

const execFileAsync = promisify(execFile);

export const bashTool = buildTool({
	name: "bash",
	description: "Execute a shell command in the workspace. Returns stdout and stderr.",
	userDescription: "在工作目录中执行 shell 命令（cmd.exe / bash），返回 stdout 和 stderr。命令受工作目录限制，超时后自动终止。",
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	configSchema: [
		{ key: "timeout", type: "number", label: "默认超时 (s)", description: "命令执行超时时间（秒，留空则不限制）" },
	],
	inputSchema: z.object({
		command: z.string().describe("The shell command to execute"),
		timeout: z.number().optional().describe("Timeout in seconds"),
	}),
	execute: async (input, ctx) => {
		const { command, timeout: inputTimeout } = input;
		const config = ctx.toolConfig?.bash ?? {};
		const timeoutSec = inputTimeout ?? config.timeout;
		const timeout = timeoutSec ? timeoutSec * 1000 : undefined;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		const shellArgs = isWin ? ["/c", command] : ["-c", command];

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
