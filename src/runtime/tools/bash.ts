import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const bashTool = tool({
	description: "Execute a shell command in the workspace. Returns stdout and stderr.",
	inputSchema: z.object({
		command: z.string().describe("The shell command to execute"),
		timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
	}),
	execute: async (input, options) => {
		const { command, timeout } = input;
		const ctx = options.experimental_context as { workingDir?: string } | undefined;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		const shellArgs = isWin ? ["/c", command] : ["-c", command];

		try {
			const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
				cwd: ctx?.workingDir,
				timeout: timeout ?? 30000,
				maxBuffer: 10 * 1024 * 1024,
			});
			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += (result ? "\n" : "") + "[stderr] " + stderr;
			return result || "(no output)";
		} catch (err: any) {
			if (err.killed) {
				return `Error: Command timed out after ${timeout ?? 30000}ms`;
			}
			return `Error: ${err.message}\n${err.stdout || ""}${err.stderr ? "\n[stderr] " + err.stderr : ""}`;
		}
	},
});
