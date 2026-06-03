import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildTool } from "./tool-factory.js";
import { EXEC_MAX_BUFFER_BYTES } from "../../core/constants.js";

const execFileAsync = promisify(execFile);

function decodeOutput(buf: Buffer | string): string {
	if (typeof buf === "string") return buf;
	if (!buf || buf.length === 0) return "";
	const utf8 = buf.toString("utf-8");
	if (!utf8.includes("�")) return utf8;
	try {
		const { TextDecoder } = globalThis as any;
		if (TextDecoder) {
			return new TextDecoder("gbk").decode(buf);
		}
	} catch { /* no GBK decoder available */ }
	return utf8;
}

export const bashTool = buildTool({
	name: "Bash",
	description: "Executes a given bash command and returns its output.",
	prompt:
		"Executes a given bash command and returns its output.\n\n" +
		"The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile.\n\n" +
		"IMPORTANT: Avoid using this tool to run `find`, `ls`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, " +
		"unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. " +
		"Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\n" +
		"- File search and directory listing: Use `Glob` tool (NOT find, ls, or dir)\n" +
		"- Content search: Use `Grep` tool (NOT shell grep or rg)\n" +
		"- Read files: Use `Read` tool (NOT cat, head, tail)\n" +
		"- Edit files: Use `Edit` tool (NOT sed, awk)\n" +
		"- Write files: Use `Write` tool (NOT echo >, cat <<EOF)\n\n" +
		"While the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience.\n\n" +
		"# Instructions\n" +
		"- If your command will create new directories or files, first run `ls` to verify the parent directory exists.\n" +
		"- Always quote file paths that contain spaces with double quotes.\n" +
		"- Try to maintain your current working directory by using absolute paths. You may use `cd` if the User explicitly requests it.\n" +
		"- You may specify an optional timeout in seconds. By default, commands have no timeout unless configured.\n" +
		"- Use background=true for long-running commands (downloads, installs) - returns a task_id immediately. Use Wait or TaskStatus to check progress.\n" +
		"- When issuing multiple commands: if independent, make multiple Bash calls in parallel; if dependent, chain with `&&`. Use `;` only when you don't care if earlier commands fail.\n" +
		"- DO NOT use newlines to separate commands.\n" +
		"- For git commands: prefer creating new commits over amending. Never skip hooks (--no-verify) unless explicitly asked.\n" +
		"- Avoid unnecessary `sleep` commands. Do not retry failing commands in a sleep loop - diagnose the root cause.\n" +
		"- Communication: Output text directly (NOT echo/printf).",
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
		const config = ctx.toolConfig?.Bash ?? {};
		const timeoutSec = inputTimeout ?? config.timeout;
		const timeout = timeoutSec ? timeoutSec * 1000 : undefined;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		const shellArgs = isWin ? ["/c", "chcp 65001 >nul && " + command] : ["-c", command];

		// Background mode
		if (background) {
			if (!ctx.runBackground) {
				return "Error: Background execution is not available in this context.";
			}
			const taskId = ctx.runBackground(command, timeoutSec);
			return `Command running in background.\ntask_id: ${taskId}\nUse Wait or TaskStatus to check progress and retrieve the result.`;
		}

		// Foreground mode — use buffer encoding to decode GBK→UTF-8 on Windows
		try {
			const execOpts: any = { cwd: ctx.workingDir, maxBuffer: EXEC_MAX_BUFFER_BYTES, encoding: "buffer" };
			if (timeout) execOpts.timeout = timeout;
			const t0 = Date.now();
			const result = await execFileAsync(shell, shellArgs, execOpts) as { stdout: Buffer; stderr: Buffer };
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const stdout = decodeOutput(result.stdout);
			const stderr = decodeOutput(result.stderr);
			let out = "";
			if (stdout) out += stdout;
			if (stderr) out += (out ? "\n" : "") + "[stderr] " + stderr;
			if (!out) out = "(no output)";
			out += `\n[Completed in ${elapsed}s]`;
			return out;
		} catch (err: any) {
			if (err.killed) {
				return `Error: Command timed out after ${timeoutSec}s\nCommand: ${command}`;
			}
			const stdout = decodeOutput(err.stdout as Buffer);
			const stderr = decodeOutput(err.stderr as Buffer);
			const exitCode = err.status ?? err.code ?? 1;
			let out = `Error: Exit code ${exitCode}`;
			if (command.length <= 200) out += `\nCommand: ${command}`;
			if (stdout) out += "\n" + stdout;
			if (stderr) out += "\n[stderr] " + stderr;
			return out;
		}
	},
});
