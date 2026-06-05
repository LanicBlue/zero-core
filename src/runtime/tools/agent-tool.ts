// Agent 委托工具
//
// # 文件说明书
//
// ## 核心功能
// 提供 Agent 委托能力，允许一个 Agent 调用另一个 Agent。
//
// ## 输入
// - Agent ID
// - 输入数据
//
// ## 输出
// - 子 Agent 的执行结果
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - node:child_process - 进程执行
//
// ## 维护规则
// - 保持委托逻辑正确
// - 处理嵌套调用限制
//
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildTool } from "./tool-factory.js";
import { EXEC_MAX_BUFFER_BYTES, OUTPUT_TRUNCATION_CHARS } from "../../core/constants.js";
import type { ToolExecutionContext } from "../types.js";
import type { AgentToolEntry } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

interface AgentRecordLite {
	id: string;
	name: string;
	systemPrompt?: string;
	model?: string;
}

function kebabCase(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
}

function resolveTemplate(template: string, task: string): string {
	return template.replace(/\{\{task\}\}/g, task);
}

function resolveArgsTemplate(template: string, task: string): string[] {
	const resolved = resolveTemplate(template, task);
	// Split by whitespace but preserve quoted segments
	const args: string[] = [];
	let current = "";
	let inQuote = false;
	for (const ch of resolved) {
		if (ch === '"') { inQuote = !inQuote; continue; }
		if (ch === " " && !inQuote) {
			if (current) { args.push(current); current = ""; }
		} else {
			current += ch;
		}
	}
	if (current) args.push(current);
	return args;
}

function truncateResult(text: string): string {
	if (text.length <= OUTPUT_TRUNCATION_CHARS) return text;
	return text.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)";
}

export function buildAgentTools(
	entries: AgentToolEntry[],
	agents: Map<string, AgentRecordLite>,
	context: ToolExecutionContext,
): Record<string, any> {
	const tools: Record<string, any> = {};

	for (const entry of entries) {
		if (!entry.enabled) continue;

		const toolName = entry.name || "agent_tool";
		const desc = entry.description || `Run the "${entry.name}" agent`;

		if (entry.type === "internal") {
			// Internal agent tool — use delegateTask / delegateTaskBackground
			const agent = agents.get(entry.agentId ?? "");
			if (!agent) continue;

			const capturedEntry = entry;
			const capturedAgent = agent;

			const isBlocking = capturedEntry.blocking !== false;

			tools[toolName] = buildTool({
				name: toolName,
				description: desc,
				meta: {
					category: "agent",
					isReadOnly: true,
					isConcurrencySafe: false,
					isDestructive: false,
				},
				inputSchema: z.object({
					task: z.string().describe("Task for the agent to perform"),
				}),
				execute: async (input) => {
					if (isBlocking) {
						if (!context.delegateTask) return "Error: Agent delegation is not available.";
						try {
							const result = await context.delegateTask(input.task, {
								systemPrompt: capturedAgent.systemPrompt,
								model: capturedAgent.model,
							});
							return truncateResult(result || "(agent returned no output)");
						} catch (err: any) {
							return `Agent error: ${err.message}`;
						}
					} else {
						if (!context.delegateTaskBackground) return "Error: Non-blocking agent delegation is not available.";
						const taskId = context.delegateTaskBackground(input.task, {
							systemPrompt: capturedAgent.systemPrompt,
							model: capturedAgent.model,
						});
						return `Agent task dispatched in non-blocking mode.\ntask_id: ${taskId}\nUse task_status to check progress.`;
					}
				},
			});
		} else if (entry.type === "external" && entry.transport === "cli") {
			// External CLI agent tool
			if (!entry.command) continue;

			const capturedEntry = entry;

			tools[toolName] = buildTool({
				name: toolName,
				description: desc,
				meta: {
					category: "agent",
					isReadOnly: false,
					isConcurrencySafe: false,
					isDestructive: true,
					maxResultSize: OUTPUT_TRUNCATION_CHARS,
				},
				inputSchema: z.object({
					task: z.string().describe("Task for the external agent to perform"),
				}),
				execute: async (input, ctx) => {
					try {
						const args = capturedEntry.argsTemplate
							? resolveArgsTemplate(capturedEntry.argsTemplate, input.task)
							: [input.task];
						const timeout = capturedEntry.timeout ?? 300000;

						const { stdout, stderr } = await execFileAsync(capturedEntry.command!, args, {
							cwd: ctx.workingDir || ".",
							timeout,
							maxBuffer: EXEC_MAX_BUFFER_BYTES,
						});

						let result = "";
						if (stdout) result += stdout;
						if (stderr) result += (result ? "\n" : "") + "[stderr] " + stderr;
						return truncateResult(result || "(no output)");
					} catch (err: any) {
						if (err.code === "ENOENT") {
							return `Error: command "${capturedEntry.command}" not found.`;
						}
						if (err.killed) {
							return `Error: agent timed out after ${capturedEntry.timeout ?? 300}s`;
						}
						return `Error: ${err.message}\n${err.stdout || ""}${err.stderr ? "\n[stderr] " + err.stderr : ""}`;
					}
				},
			});
		} else if (entry.type === "external" && entry.transport === "http") {
			// External HTTP agent tool
			if (!entry.url) continue;

			const capturedEntry = entry;

			tools[toolName] = buildTool({
				name: toolName,
				description: desc,
				meta: {
					category: "agent",
					isReadOnly: true,
					isConcurrencySafe: false,
					isDestructive: false,
				},
				inputSchema: z.object({
					task: z.string().describe("Task for the external agent to perform"),
				}),
				execute: async (input) => {
					try {
						const method = capturedEntry.method ?? "POST";
						const headers: Record<string, string> = {
							"Content-Type": "application/json",
							...capturedEntry.headers,
						};
						const timeout = capturedEntry.timeout ?? 300000;

						let body: string | undefined;
						if (capturedEntry.bodyTemplate) {
							body = resolveTemplate(capturedEntry.bodyTemplate, input.task);
						} else {
							body = JSON.stringify({ task: input.task });
						}

						const controller = new AbortController();
						const timer = setTimeout(() => controller.abort(), timeout);

						const resp = await fetch(capturedEntry.url!, {
							method,
							headers,
							body: method !== "GET" ? body : undefined,
							signal: controller.signal,
						});
						clearTimeout(timer);

						if (!resp.ok) {
							return `Error: HTTP ${resp.status} ${resp.statusText}`;
						}

						const text = await resp.text();

						// Extract from response path if specified
						if (capturedEntry.responsePath) {
							try {
								const json = JSON.parse(text);
								const parts = capturedEntry.responsePath.split(".");
								let val: any = json;
								for (const p of parts) {
									val = val?.[p];
								}
								return truncateResult(typeof val === "string" ? val : JSON.stringify(val));
							} catch {
								// Return raw text if path extraction fails
							}
						}

						return truncateResult(text);
					} catch (err: any) {
						if (err.name === "AbortError") {
							return `Error: agent timed out after ${capturedEntry.timeout ?? 300}s`;
						}
						return `Error: ${err.message}`;
					}
				},
			});
		}
	}

	return tools;
}
