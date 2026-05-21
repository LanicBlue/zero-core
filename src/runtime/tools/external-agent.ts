import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildTool } from "./tool-factory.js";

const execFileAsync = promisify(execFile);

export const externalAgentTool = buildTool({
	name: "external_agent",
	description:
		"Invoke an external agent CLI (Claude Code or Codex) to perform a task. The agent runs in the workspace directory and returns its output.",
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false, maxResultSize: 50000 },
	inputSchema: z.object({
		agent: z.enum(["claude-code", "codex"]).describe("Which external agent to invoke"),
		prompt: z.string().describe("The task prompt for the external agent"),
		workingDir: z.string().optional().describe("Working directory override"),
	}),
	execute: async (input, ctx) => {
		const { agent, prompt, workingDir } = input;
		const cwd = workingDir || ctx.workingDir || ".";

		try {
			let command: string;
			let args: string[];

			if (agent === "claude-code") {
				command = "claude";
				args = ["--print", "--dangerously-skip-permissions", prompt];
			} else {
				command = "codex";
				args = ["--quiet", prompt];
			}

			const { stdout, stderr } = await execFileAsync(command, args, {
				cwd,
				timeout: 300000,
				maxBuffer: 10 * 1024 * 1024,
			});

			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += (result ? "\n" : "") + "[stderr] " + stderr;
			return result || "(no output)";
		} catch (err: any) {
			if (err.code === "ENOENT") {
				return `Error: ${agent === "claude-code" ? "claude" : "codex"} CLI not found. Please install it first.`;
			}
			if (err.killed) {
				return `Error: ${agent} timed out after 300s`;
			}
			return `Error: ${err.message}\n${err.stdout || ""}${err.stderr ? "\n[stderr] " + err.stderr : ""}`;
		}
	},
});
