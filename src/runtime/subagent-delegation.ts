// 子 Agent 委派工厂
//
// # 文件说明书
//
// ## 核心功能
// 创建子 Agent 委派函数集（阻塞/非阻塞执行、后台 shell、任务查询控制），构成 ToolExecutionContext 的委派 API
//
// ## 输入
// SubagentDelegationConfig（父会话配置、Provider 列表、任务注册表、事件发射器、工具配置获取器）
//
// ## 输出
// delegateTask、delegateTaskBackground、getTaskResult、listTasks、stopTask、suspendUntilWake、runBackground 七个函数
//
// ## 定位
// src/runtime/ — Agent 运行时子任务调度层，被 agent-loop 和 agent-tool 调用
//
// ## 依赖
// ./types、./task-registry、./agent-loop、../core/hook-registry、../core/constants
//
// ## 维护规则
// 子 Agent 超时和自动后台策略由工具配置 subagent 字段控制
// 新增委派模式需同步更新 ToolExecutionContext 类型
//
import type {
	StreamEvent,
	RuntimeProviderConfig,
	SessionConfig,
	TaskInfo,
} from "./types.js";
import { TaskRegistry } from "./task-registry.js";
import { AgentLoop } from "./agent-loop.js";
import { spawn } from "node:child_process";
import { triggerHooks } from "../core/hook-registry.js";
import { EXEC_MAX_BUFFER_BYTES, OUTPUT_TRUNCATION_CHARS } from "../core/constants.js";

// ---------------------------------------------------------------------------
// Subagent / task delegation factory
// ---------------------------------------------------------------------------

export interface SubagentDelegationConfig {
	/** Parent agent's SessionConfig — used as template for sub-agents. */
	config: SessionConfig;
	/** Available providers. */
	providers: RuntimeProviderConfig[];
	/** The task registry to track background work. */
	taskRegistry: TaskRegistry;
	/** Emit an event from the parent's perspective. */
	emit: (event: StreamEvent) => void;
	/** Resolve subagent timeout from the current tool config. */
	getToolConfig: () => Record<string, Record<string, any>> | undefined;
}

/**
 * Creates the subagent delegation functions that form part of the
 * ToolExecutionContext.  All dependencies are passed explicitly rather than
 * closing over AgentLoop instance state.
 */
export function createSubagentDelegation(deps: SubagentDelegationConfig) {
	const { config, providers, taskRegistry, emit, getToolConfig } = deps;

	// -----------------------------------------------------------------------
	// delegateTask — blocking sub-agent execution
	// -----------------------------------------------------------------------

	async function delegateTask(
		task: string,
		options?: { model?: string; systemPrompt?: string },
	): Promise<string> {
		const subConfig: SessionConfig = {
			...config,
			agentId: `${config.agentId}:sub-${Date.now()}`,
			systemPrompt: options?.systemPrompt ?? config.systemPrompt,
			modelId: options?.model ?? config.modelId,
			timeoutSec: getToolConfig()?.subagent?.timeout,
		};

		const subLoop = new AgentLoop(subConfig, providers, {
			onEvent: () => {},
		});

		// Auto-background: if configured, transition to non-blocking after timeout
		const toolCfg = getToolConfig();
		const autoBgEnabled = toolCfg?.subagent?.auto_background === true;
		const autoBgSec = Number(toolCfg?.subagent?.auto_background_timeout) || 0;

		if (autoBgEnabled && autoBgSec > 0) {
			const taskId = `${subConfig.agentId}:bg-${Date.now()}`;

			// Fire-and-forget: subLoop.run() continues in background
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

			// Timeout: register as background task, parent continues
			taskRegistry.create(taskId, "subagent", task);

			// When subagent eventually finishes, update registry
			done.then(() => {
				if (bgError) {
					taskRegistry.fail(taskId, bgError);
					emit({
						type: "subagent_completed",
						agentId: config.agentId,
						taskId,
						status: "failed",
						result: bgError,
					});

			triggerHooks("SubagentStop", { agentId: config.agentId, taskId, status: "failed" });
				} else {
					taskRegistry.complete(taskId, bgResult);
					emit({
						type: "subagent_completed",
						agentId: config.agentId,
						taskId,
						status: "completed",
						result: bgResult,
					});

			triggerHooks("SubagentStop", { agentId: config.agentId, taskId, status: "completed" });
				}
			});

			return (
				`Sub-agent auto-backgrounded after ${autoBgSec}s (still running).` +
				`\ntask_id: ${taskId}` +
				"\nUse task_status to check progress."
			);
		}

		// No auto-background: simple blocking execution
		await subLoop.run(task);
		return subLoop.getResult();
	}

	// -----------------------------------------------------------------------
	// delegateTaskBackground — non-blocking sub-agent execution
	// -----------------------------------------------------------------------

	function delegateTaskBackground(
		task: string,
		options?: { model?: string; systemPrompt?: string },
	): string {
		const taskId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		emit({
			type: "subagent_dispatched",
			agentId: config.agentId,
			taskId,
			task,
		});

			triggerHooks("SubagentStart", { agentId: config.agentId, taskId, task });

		const subConfig: SessionConfig = {
			...config,
			agentId: `${config.agentId}:${taskId}`,
			systemPrompt: options?.systemPrompt ?? config.systemPrompt,
			modelId: options?.model ?? config.modelId,
			timeoutSec: getToolConfig()?.subagent?.timeout,
		};

		const subAbort = new AbortController();
		taskRegistry.create(taskId, "subagent", task, subAbort);

		setImmediate(async () => {
			let stepCount = 0;
			const subLoop = new AgentLoop(subConfig, providers, {
				onEvent: (event) => {
					if (event.type === "tool_start") {
						stepCount++;
						taskRegistry.updateProgress(taskId, stepCount, event.toolName);
						emit({
							type: "subagent_progress",
							agentId: config.agentId,
							taskId,
							step: stepCount,
							toolName: event.toolName,
						});
					}
				},
			});

			// Link external abort to subLoop
			subAbort.signal.addEventListener("abort", () => subLoop.abort(), { once: true });

			try {
				await subLoop.run(task);
				const result = subLoop.getResult();
				taskRegistry.complete(taskId, result);
				emit({
					type: "subagent_completed",
					agentId: config.agentId,
					taskId,
					status: "completed",
					result,
				});

			triggerHooks("SubagentStop", { agentId: config.agentId, taskId, status: "completed" });
			} catch (err: any) {
				taskRegistry.fail(taskId, err.message || "Unknown error");
				emit({
					type: "subagent_completed",
					agentId: config.agentId,
					taskId,
					status: "failed",
					result: err.message,
				});

			triggerHooks("SubagentStop", { agentId: config.agentId, taskId, status: "failed" });
			}
		});

		return taskId;
	}

	// -----------------------------------------------------------------------
	// Task query / control
	// -----------------------------------------------------------------------

	function getTaskResult(taskId: string): TaskInfo | null {
		return taskRegistry.get(taskId) ?? null;
	}

	function listTasks(filter?: "running" | "completed"): TaskInfo[] {
		return taskRegistry.list(filter);
	}

	function stopTask(taskId: string): boolean {
		return taskRegistry.kill(taskId);
	}

	function suspendUntilWake(timeoutMs: number, taskId?: string): Promise<string> {
		return taskRegistry.suspendUntilWake(timeoutMs);
	}

	// -----------------------------------------------------------------------
	// runBackground — spawn a background shell process
	// -----------------------------------------------------------------------

	function runBackground(command: string, timeoutSec?: number): string {
		const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		const shellArgs = isWin ? ["/c", command] : ["-c", command];

		taskRegistry.create(taskId, "bash", command);

		const child: any = spawn(shell, shellArgs, {
			cwd: config.workspaceDir,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

		child.on("close", (code: number) => {
			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += (result ? "\n" : "") + "[stderr] " + stderr;
			if (result.length > OUTPUT_TRUNCATION_CHARS) result = result.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)";
			if (code === 0) {
				taskRegistry.complete(taskId, result || "(no output)");
			} else {
				taskRegistry.fail(taskId, `Exit code ${code}: ${result}`);
			}
			emit({
				type: "subagent_completed",
				agentId: config.agentId,
				taskId,
				status: code === 0 ? "completed" : "failed",
				result,
			});

			triggerHooks("SubagentStop", { agentId: config.agentId, taskId, status: code === 0 ? "completed" : "failed" });
		});

		child.on("error", (err: Error) => {
			taskRegistry.fail(taskId, err.message);
			emit({
				type: "subagent_completed",
				agentId: config.agentId,
				taskId,
				status: "failed",
				result: err.message,
			});

			triggerHooks("SubagentStop", { agentId: config.agentId, taskId, status: "failed" });
		});

		return taskId;
	}

	// -----------------------------------------------------------------------
	// Return the delegation API
	// -----------------------------------------------------------------------

	return {
		delegateTask,
		delegateTaskBackground,
		getTaskResult,
		listTasks,
		stopTask,
		suspendUntilWake,
		runBackground,
	};
}
