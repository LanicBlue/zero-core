// 子 Agent 委派调度器
//
// # 文件说明书
//
// ## 核心功能
// 管理子 Agent 的创建、委派和结果收集，支持并行子任务执行
//
// ## 输入
// 子任务描述、Agent 配置、回调函数
//
// ## 输出
// 子 Agent 运行时实例和执行结果
//
// ## 定位
// src/runtime/ — 运行时层，为 agent-loop 提供子任务委派能力
//
// ## 依赖
// types.ts、task-registry.ts、core/logger.ts
//
// ## 维护规则
// 子 Agent 生命周期变更需确保资源正确释放
//
import type {
	StreamEvent,
	RuntimeProviderConfig,
	SessionConfig,
	TaskInfo,
	RuntimeCallbacks,
	AgentRuntime,
} from "./types.js";
import { TaskRegistry } from "./task-registry.js";
import { log } from "../core/logger.js";
import { EXEC_MAX_BUFFER_BYTES, OUTPUT_TRUNCATION_CHARS } from "../core/constants.js";

type LoopFactory = (
	config: SessionConfig,
	providers: RuntimeProviderConfig[],
	callbacks: RuntimeCallbacks,
) => AgentRuntime;

export interface SubagentDelegatorDeps {
	config: SessionConfig;
	providers: RuntimeProviderConfig[];
	emit: (event: StreamEvent) => void;
	createSubLoop: LoopFactory;
	getToolConfig: () => Record<string, Record<string, any>>;
}

export class SubagentDelegator {
	readonly taskRegistry = new TaskRegistry();
	private config: SessionConfig;
	private providers: RuntimeProviderConfig[];
	private emit: (event: StreamEvent) => void;
	private createSubLoop: LoopFactory;
	private getToolConfig: () => Record<string, Record<string, any>>;

	constructor(deps: SubagentDelegatorDeps) {
		this.config = deps.config;
		this.providers = deps.providers;
		this.emit = deps.emit;
		this.createSubLoop = deps.createSubLoop;
		this.getToolConfig = deps.getToolConfig;
	}

	async delegateTask(task: string, options?: { model?: string; systemPrompt?: string }): Promise<string> {
		const toolConfig = this.getToolConfig();
		const subConfig: SessionConfig = {
			...this.config,
			agentId: `${this.config.agentId}:sub-${Date.now()}`,
			systemPrompt: options?.systemPrompt ?? this.config.systemPrompt,
			modelId: options?.model ?? this.config.modelId,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
			timeoutSec: toolConfig?.Agent?.timeout,
		};
		const subLoop = this.createSubLoop(subConfig, this.providers, { onEvent: () => {} });

		const autoBgEnabled = toolConfig?.Agent?.auto_background === true;
		const autoBgSec = Number(toolConfig?.Agent?.auto_background_timeout) || 0;
		if (autoBgEnabled && autoBgSec > 0) {
			const taskId = `${subConfig.agentId}:bg-${Date.now()}`;
			const registry = this.taskRegistry;
			const parentEmit = (event: StreamEvent) => this.emit(event);

			let bgResult = "";
			let bgError = "";
			const done = new Promise<void>((resolve) => {
				subLoop.run(task).then(() => {
					bgResult = subLoop.getResult();
					resolve();
				}).catch((err: any) => {
					bgError = err.message || "Unknown error";
					resolve();
				});
			});

			const timeout = new Promise<string>((resolve) =>
				setTimeout(() => resolve("timeout"), autoBgSec * 1000),
			);

			const raceResult = await Promise.race([done.then(() => "done"), timeout]);

			if (raceResult === "done") {
				if (bgError) throw new Error(bgError);
				return bgResult || "(sub-agent returned no output)";
			}

			registry.create(taskId, "subagent", task);

			done.then(() => {
				if (bgError) {
					registry.fail(taskId, bgError);
					parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: bgError });
				} else {
					registry.complete(taskId, bgResult);
					parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "completed", result: bgResult });
				}
			});

			return `Sub-agent auto-backgrounded after ${autoBgSec}s (still running)." + NL + "task_id: ${taskId}" + NL + "Use task_status to check progress.`;
		}

		await subLoop.run(task);
		return subLoop.getResult();
	}

	delegateTaskBackground(task: string, options?: { model?: string; systemPrompt?: string }): string {
		const taskId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.emit({
			type: "subagent_dispatched",
			agentId: this.config.agentId,
			taskId,
			task,
		});

		const toolConfig = this.getToolConfig();
		const subConfig: SessionConfig = {
			...this.config,
			agentId: `${this.config.agentId}:${taskId}`,
			systemPrompt: options?.systemPrompt ?? this.config.systemPrompt,
			modelId: options?.model ?? this.config.modelId,
			timeoutSec: toolConfig?.Agent?.timeout,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
		};

		const registry = this.taskRegistry;
		const subAbort = new AbortController();
		registry.create(taskId, "subagent", task, subAbort);
		const parentEmit = (event: StreamEvent) => this.emit(event);

		setImmediate(async () => {
			let stepCount = 0;
			const subLoop = this.createSubLoop(subConfig, this.providers, {
				onEvent: (event) => {
					if (event.type === "tool_start") {
						stepCount++;
						registry.updateProgress(taskId, stepCount, event.toolName);
						parentEmit({
							type: "subagent_progress",
							agentId: this.config.agentId,
							taskId,
							step: stepCount,
							toolName: event.toolName,
						});
					}
				},
			});

			subAbort.signal.addEventListener("abort", () => subLoop.abort(), { once: true });

			try {
				await subLoop.run(task);
				const result = subLoop.getResult();
				registry.complete(taskId, result);
				parentEmit({
					type: "subagent_completed",
					agentId: this.config.agentId,
					taskId,
					status: "completed",
					result,
				});
			} catch (err: any) {
				registry.fail(taskId, err.message || "Unknown error");
				parentEmit({
					type: "subagent_completed",
					agentId: this.config.agentId,
					taskId,
					status: "failed",
					result: err.message,
				});
			}
		});

		return taskId;
	}

	getTaskResult(taskId: string): TaskInfo | null {
		return this.taskRegistry.get(taskId) ?? null;
	}

	listTasks(filter?: "running" | "completed"): TaskInfo[] {
		return this.taskRegistry.list(filter);
	}

	stopTask(taskId: string): boolean {
		return this.taskRegistry.kill(taskId);
	}

	suspendUntilWake(timeoutMs: number, taskId?: string): Promise<string> {
		return this.taskRegistry.suspendUntilWake(timeoutMs, taskId);
	}

	runBackground(command: string, timeoutSec?: number): string {
		const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		const shellArgs = isWin ? ["/c", "chcp 65001 >/dev/null && " + command] : ["-c", command];
		const registry = this.taskRegistry;
		const parentEmit = (event: StreamEvent) => this.emit(event);

		registry.create(taskId, "bash", command);

		const child = require("node:child_process").spawn(shell, shellArgs, {
			cwd: this.config.workspaceDir,
			maxBuffer: EXEC_MAX_BUFFER_BYTES,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

		child.on("close", (code: number) => {
			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += (result ? "\n" : "") + "[stderr] " + stderr;
			if (result.length > OUTPUT_TRUNCATION_CHARS) result = result.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)";
			if (code === 0) {
				registry.complete(taskId, result || "(no output)");
			} else {
				registry.fail(taskId, `Exit code ${code}: ${result}`);
			}
			parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: code === 0 ? "completed" : "failed", result });
		});

		child.on("error", (err: Error) => {
			registry.fail(taskId, err.message);
			parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: err.message });
		});

		return taskId;
	}

	cleanup(): void {
		this.taskRegistry.cleanup();
	}
}
