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
import type { SessionContextBundle } from "../shared/types.js";
import { spawn } from "node:child_process";
import { TaskRegistry } from "./task-registry.js";
import { log } from "../core/logger.js";
import { triggerHooks } from "../core/hook-registry.js";
import { EXEC_MAX_BUFFER_BYTES, OUTPUT_TRUNCATION_CHARS } from "../core/constants.js";
import { decodeShellBuffer } from "../core/encoding.js";

type LoopFactory = (
	config: SessionConfig,
	providers: RuntimeProviderConfig[],
	callbacks: RuntimeCallbacks,
) => AgentRuntime;

/**
 * v0.8 (M0) — extended delegateTask options (RFC §2.11 / decision 16).
 *
 * Synchronous sub-agent calls inherit the CALLER session's context bundle
 * (workspaceDir / wikiRootNodeId / projectId); the caller may override
 * pieces per-call (e.g. narrow workspace to a subdirectory). Identity,
 * toolPolicy and history come from the target agent itself — passed via
 * `targetAgentId` / `toolPolicy` / `systemPrompt` here so the runtime can
 * build the sub-loop against the target agent's config rather than the
 * caller's.
 */
export interface DelegateTaskOptions {
	/** Target agent id (the role/preset agent being delegated to). */
	targetAgentId?: string;
	/** Target agent's full system prompt (overrides caller's prompt). */
	systemPrompt?: string;
	/** Target agent's model id. */
	model?: string;
	/** Target agent's toolPolicy (overrides caller's policy). */
	toolPolicy?: SessionConfig["toolPolicy"];
	/** Caller-provided context bundle override (per-call). */
	contextOverride?: Partial<SessionContextBundle>;
	/**
	 * Per-call workspace override. Falls back to caller bundle's workspaceDir,
	 * then to the caller SessionConfig.workspaceDir.
	 */
	workspaceDir?: string;
}

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

	async delegateTask(task: string, options?: DelegateTaskOptions): Promise<string> {
		const toolConfig = this.getToolConfig();

		// v0.8 (M0): inherit caller's context bundle, apply per-call override.
		// targetAgentId drives the sub-agent's identity (the agent we delegate to);
		// toolPolicy comes from the target agent unless the caller overrides.
		const targetAgentId = options?.targetAgentId ?? `${this.config.agentId}:sub`;
		const callerBundle = this.config.contextBundle;
		const inheritedBundle: SessionContextBundle | undefined = callerBundle
			? { ...callerBundle, ...options?.contextOverride }
			: undefined;

		// workspaceDir resolution: per-call override → inherited bundle → caller config.
		const resolvedWorkspaceDir =
			options?.workspaceDir
			?? inheritedBundle?.workspaceDir
			?? this.config.workspaceDir;

		const subConfig: SessionConfig = {
			...this.config,
			agentId: `${targetAgentId}-${Date.now()}`,
			// v0.8: sub-agents run in an ISOLATED, ephemeral context. Do NOT
			// inherit the parent's sessionId — AgentSession would otherwise
			// rebuildFromTurns() the parent's full history (leak + token cost).
			// undefined sessionId → no DB load, no persist (all DB ops are gated
			// on `db && sessionId`). The sub-task's result is held by the
			// TaskRegistry, so TaskStatus/Wait still return it.
			sessionId: undefined,
			// Identity / prompt / model / toolPolicy all come from the target
			// agent (passed via options). Fall back to caller config when not
			// supplied (legacy 2-arg call shape).
			systemPrompt: options?.systemPrompt ?? this.config.systemPrompt,
			modelId: options?.model ?? this.config.modelId,
			toolPolicy: options?.toolPolicy ?? this.config.toolPolicy,
			workspaceDir: resolvedWorkspaceDir,
			contextBundle: inheritedBundle,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
			timeoutSec: toolConfig?.Agent?.timeout,
		};

		// [Batch 2] SubagentStart hook
		await triggerHooks("SubagentStart", {
			agentId: this.config.agentId,
			sessionId: this.config.sessionId,
			taskId: subConfig.agentId,
			task,
		});

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
				if (bgError) {
					// [Batch 2] SubagentStop hook (inline failure)
					await triggerHooks("SubagentStop", {
						agentId: this.config.agentId,
						sessionId: this.config.sessionId,
						taskId: subConfig.agentId,
						status: "failed",
						result: bgError,
					});
					throw new Error(bgError);
				}
				// [Batch 2] SubagentStop hook (inline success)
				await triggerHooks("SubagentStop", {
					agentId: this.config.agentId,
					sessionId: this.config.sessionId,
					taskId: subConfig.agentId,
					status: "completed",
					result: bgResult,
				});
				return bgResult || "(sub-agent returned no output)";
			}

			registry.create(taskId, "subagent", task);
			// [Batch 2] TaskCreated hook
			await triggerHooks("TaskCreated", {
				agentId: this.config.agentId,
				sessionId: this.config.sessionId,
				taskId,
				task,
			});

			done.then(async () => {
				if (bgError) {
					registry.fail(taskId, bgError);
					parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: bgError });
					// [Batch 2] SubagentStop + TaskCompleted hooks
					await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: bgError });
					await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: bgError });
				} else {
					registry.complete(taskId, bgResult);
					parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "completed", result: bgResult });
					// [Batch 2] SubagentStop + TaskCompleted hooks
					await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result: bgResult });
					await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result: bgResult });
				}
			});

			return `Sub-agent auto-backgrounded after ${autoBgSec}s (still running)." + NL + "task_id: ${taskId}" + NL + "Use task_status to check progress.`;
		}

		await subLoop.run(task);
		const result = subLoop.getResult();
		// [Batch 2] SubagentStop hook (synchronous completion)
		await triggerHooks("SubagentStop", {
			agentId: this.config.agentId,
			sessionId: this.config.sessionId,
			taskId: subConfig.agentId,
			status: "completed",
			result,
		});
		return result;
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
			// v0.8: ISOLATED ephemeral context — see delegateTask() for rationale.
			// Without this, non_blocking sub-agents (deferred via setImmediate)
			// inherit the parent sessionId and rebuildFromTurns() the parent's
			// full history, producing main-conversation output instead of the
			// assigned task.
			sessionId: undefined,
			systemPrompt: options?.systemPrompt ?? this.config.systemPrompt,
			modelId: options?.model ?? this.config.modelId,
			timeoutSec: toolConfig?.Agent?.timeout,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
		};

		const registry = this.taskRegistry;
		const subAbort = new AbortController();
		registry.create(taskId, "subagent", task, subAbort);

		// [Batch 2] TaskCreated + SubagentStart hooks
		triggerHooks("TaskCreated", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task }).catch(() => {});
		triggerHooks("SubagentStart", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task }).catch(() => {});

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
				// [Batch 2] SubagentStop + TaskCompleted hooks
				await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
				await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
			} catch (err: any) {
				registry.fail(taskId, err.message || "Unknown error");
				parentEmit({
					type: "subagent_completed",
					agentId: this.config.agentId,
					taskId,
					status: "failed",
					result: err.message,
				});
				// [Batch 2] SubagentStop + TaskCompleted hooks
				await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: err.message });
				await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: err.message });
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
		const killed = this.taskRegistry.kill(taskId);
		if (killed) {
			// [Batch 2] SubagentStop + TaskCompleted hooks for killed tasks
			triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed" }).catch(() => {});
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed" }).catch(() => {});
		}
		return killed;
	}

	suspendUntilWake(timeoutMs: number, taskId?: string): Promise<string> {
		return this.taskRegistry.suspendUntilWake(timeoutMs, taskId);
	}

	runBackground(command: string, timeoutSec?: number): string {
		const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		// 不再用 chcp 65001 强转(/dev/null 在 cmd 无效,且不覆盖所有原生 exe);
		// 改为拿到原始 Buffer,close 时由 decodeShellBuffer 做 UTF-8/GBK 自动解码。
		const shellArgs = isWin ? ["/c", command] : ["-c", command];
		const registry = this.taskRegistry;
		const parentEmit = (event: StreamEvent) => this.emit(event);

		registry.create(taskId, "bash", command);
		// [Batch 2] TaskCreated hook
		triggerHooks("TaskCreated", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task: command }).catch(() => {});

		// v0.8 (S3): wrap spawn so a synchronous launch failure (bad shell path,
		// missing binary, etc.) is recorded against the task and the task_id is
		// still returned — so the caller can关联 + TaskStatus sees status=failed
		// instead of getting a raw error with no task_id and a stuck "running" task.
		let child: any;
		try {
			child = spawn(shell, shellArgs, { cwd: this.config.workspaceDir });
		} catch (err: any) {
			const msg = `Launch failed: ${(err as Error).message}`;
			registry.fail(taskId, msg);
			parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: msg });
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: msg }).catch(() => {});
			return taskId;
		}
		// 累积原始 Buffer chunk,close 时一次性解码 —— 避免多字节字符(UTF-8/GBK)
		// 被 chunk 边界切断,并在含非法 UTF-8 序列时回退 GBK(Windows 原生命令)。
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (d: Buffer) => { stdoutChunks.push(d); });
		child.stderr.on("data", (d: Buffer) => { stderrChunks.push(d); });

		child.on("close", (code: number) => {
			const stdout = decodeShellBuffer(Buffer.concat(stdoutChunks));
			const stderr = decodeShellBuffer(Buffer.concat(stderrChunks));
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
			// [Batch 2] TaskCompleted hook
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: code === 0 ? "completed" : "failed", result }).catch(() => {});
		});

		child.on("error", (err: Error) => {
			registry.fail(taskId, err.message);
			parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: err.message });
			// [Batch 2] TaskCompleted hook
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: err.message }).catch(() => {});
		});

		return taskId;
	}

	cleanup(): void {
		this.taskRegistry.cleanup();
	}
}
