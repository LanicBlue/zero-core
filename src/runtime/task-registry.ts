// 任务注册与状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理运行时任务的注册、查询、取消和生命周期状态追踪
//
// ## 输入
// TaskInfo（任务 ID、类型、描述）、AbortController
//
// ## 输出
// 任务列表、任务状态、取消操作
//
// ## 定位
// src/runtime/ — 运行时层，为 agent-loop 和 UI 提供任务管理
//
// ## 依赖
// types.ts
//
// ## 维护规则
// 新增任务类型时需更新 TaskType 联合类型
//
import type { TaskInfo, TaskType } from "./types.js";

export class TaskRegistry {
	private tasks = new Map<string, TaskInfo>();
	private abortControllers = new Map<string, AbortController>();
	private wakeCallback: (() => void) | null = null;

	// N1 (runtime-push-ui-sync): coalesced change notification. The registry
	// stays sessionId-agnostic — AgentLoop subscribes and translates the ping
	// into a runtime:tasks:changed agent:event carrying its own sessionId.
	// Mirrors the data-change-hub coalesce: many writes in one tick → one
	// callback, so updateProgress / addUsage bursts during a turn don't ping
	// the UI per call.
	private changeListeners = new Set<() => void>();
	private changeScheduled = false;

	/** Subscribe to coalesced change pings. Returns an unsubscribe fn. */
	subscribe(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => { this.changeListeners.delete(cb); };
	}

	/** Test helper: drain any pending coalesced flush synchronously. */
	_flushChangeForTest(): void {
		if (!this.changeScheduled) return;
		this.changeScheduled = false;
		this.fireChange();
	}

	private fireChange(): void {
		for (const cb of this.changeListeners) {
			try { cb(); } catch { /* listener errors are non-fatal */ }
		}
	}

	private scheduleChange(): void {
		if (this.changeScheduled) return;
		this.changeScheduled = true;
		setTimeout(() => {
			this.changeScheduled = false;
			this.fireChange();
		}, 0);
	}

	create(taskId: string, type: TaskType, task: string, abortController?: AbortController, parentTaskId?: string): void {
		this.tasks.set(taskId, {
			id: taskId,
			type,
			task,
			status: "running",
			parentTaskId,
			step: 0,
			turns: 0,
			tokens: 0,
			startedAt: Date.now(),
		});
		if (abortController) {
			this.abortControllers.set(taskId, abortController);
		}
		this.scheduleChange();
	}

	updateProgress(taskId: string, step: number, toolName?: string): void {
		const info = this.tasks.get(taskId);
		if (!info || (info.status !== "running" && info.status !== "finishing")) return;
		info.step = step;
		if (toolName) info.currentTool = toolName;
		this.scheduleChange();
	}

	/** Add accumulated tokens + one completed agent-loop turn to a task. */
	addUsage(taskId: string, tokensDelta: number, turnCompleted: boolean): void {
		const info = this.tasks.get(taskId);
		if (!info) return;
		info.tokens += tokensDelta;
		if (turnCompleted) info.turns += 1;
		this.scheduleChange();
	}

	/**
	 * Advisory finish: mark a running task "finishing" and stage a control
	 * message. Does NOT abort — the sub-agent is expected to wrap up. The
	 * delegator enforces any turn budget separately. Returns false if the
	 * task is not running (already terminal or finishing).
	 */
	requestFinish(taskId: string, message?: string): boolean {
		const info = this.tasks.get(taskId);
		if (!info || info.status !== "running") return false;
		info.status = "finishing";
		if (message) info.result = message;
		this.tryWake();
		this.scheduleChange();
		return true;
	}

	complete(taskId: string, result: string): void {
		const info = this.tasks.get(taskId);
		if (!info) return;
		info.status = "completed";
		info.result = result;
		info.completedAt = Date.now();
		info.currentTool = undefined;
		this.abortControllers.delete(taskId);
		this.tryWake();
		this.scheduleChange();
	}

	fail(taskId: string, error: string): void {
		const info = this.tasks.get(taskId);
		if (!info) return;
		info.status = "failed";
		info.error = error;
		info.completedAt = Date.now();
		info.currentTool = undefined;
		this.abortControllers.delete(taskId);
		this.tryWake();
		this.scheduleChange();
	}

	kill(taskId: string): boolean {
		const info = this.tasks.get(taskId);
		if (!info || (info.status !== "running" && info.status !== "finishing")) return false;
		const ac = this.abortControllers.get(taskId);
		if (ac) {
			ac.abort();
			this.abortControllers.delete(taskId);
		}
		info.status = "killed";
		info.completedAt = Date.now();
		info.currentTool = undefined;
		this.tryWake();
		this.scheduleChange();
		return true;
	}

	/**
	 * Acknowledge a FINISHED task (completed/failed/killed/interrupted) and drop
	 * it from the live registry so it leaves the UI TaskTree and the agent's
	 * TaskList. Running/finishing tasks are refused (stop them first). This is
	 * the parent-agent "confirm completion" step: a finished task stays visible
	 * until the parent explicitly acknowledges it. tryWake() so any Wait blocked
	 * on this task resolves. Returns false if the task isn't terminal (or absent).
	 */
	acknowledge(taskId: string): boolean {
		const info = this.tasks.get(taskId);
		if (!info) return false;
		if (info.status === "running" || info.status === "finishing") return false;
		this.tasks.delete(taskId);
		this.abortControllers.delete(taskId);
		this.tryWake();
		this.scheduleChange();
		return true;
	}

	get(taskId: string): TaskInfo | undefined {
		return this.tasks.get(taskId);
	}

	/**
	 * Restore a persisted task as-is into the live registry (startup / activate
	 * history reload from delegated_tasks). No abortController — restored tasks
	 * are historical, not actively running. Keeps the memory-only read path
	 * (getRuntimeTaskTree) reflecting history after restart without changing
	 * how live tasks are created/updated.
	 */
	seed(info: TaskInfo): void {
		this.tasks.set(info.id, info);
		this.scheduleChange();
	}

	list(filter?: "running" | "completed"): TaskInfo[] {
		const all = [...this.tasks.values()];
		if (!filter) return all;
		if (filter === "running") return all.filter((t) => t.status === "running");
		return all.filter((t) => t.status !== "running");
	}

	getCompletedUnnotified(): TaskInfo[] {
		const result: TaskInfo[] = [];
		for (const info of this.tasks.values()) {
			if ((info.status === "completed" || info.status === "failed" || info.status === "killed") && !info.notified) {
				result.push(info);
			}
		}
		return result;
	}

	markNotified(taskId: string): void {
		const info = this.tasks.get(taskId);
		if (info) info.notified = true;
	}

	async suspendUntilWake(timeoutMs: number, taskId?: string): Promise<string> {
		const hasRunning = taskId
			? (this.tasks.get(taskId)?.status === "running" || this.tasks.get(taskId)?.status === "finishing")
			: [...this.tasks.values()].some((t) => t.status === "running" || t.status === "finishing");

		if (!hasRunning) return this.generateSummary(taskId);

		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.wakeCallback = null;
				resolve();
			}, timeoutMs);

			this.wakeCallback = () => {
				if (taskId) {
					const info = this.tasks.get(taskId);
					if (info && info.status !== "running" && info.status !== "finishing") {
						clearTimeout(timer);
						this.wakeCallback = null;
						resolve();
					}
				} else {
					clearTimeout(timer);
					this.wakeCallback = null;
					resolve();
				}
			};
		});

		return this.generateSummary(taskId);
	}

	private generateSummary(filterTaskId?: string): string {
		const running: string[] = [];
		const completed: string[] = [];
		for (const info of this.tasks.values()) {
			if (filterTaskId && info.id !== filterTaskId) continue;

			if (info.status === "running" || info.status === "finishing") {
				const typeLabel = info.type === "bash" ? "bash" : "subagent";
				running.push(`[${info.id}] ${typeLabel} ${info.status} (turns:${info.turns} tokens:${info.tokens})${info.currentTool ? " tool:" + info.currentTool : ""}`);
			} else if (info.status === "completed") {
				const r = info.result && info.result.length > 500 ? info.result.slice(0, 500) + "..." : info.result;
				completed.push(`[${info.id}] completed. Result: ${r}`);
			} else if (info.status === "failed") {
				completed.push(`[${info.id}] failed. Error: ${info.error}`);
			} else if (info.status === "killed") {
				completed.push(`[${info.id}] killed.`);
			}
		}
		const parts: string[] = [];
		if (completed.length) parts.push("Completed:\n" + completed.join("\n"));
		if (running.length) parts.push("Still running:\n" + running.join("\n"));
		return parts.join("\n\n") || "No tasks.";
	}

	private tryWake(): void {
		if (this.wakeCallback) {
			const cb = this.wakeCallback;
			cb();
		}
	}

	cleanup(maxAgeMs: number = 3600_000): void {
		const now = Date.now();
		let changed = false;
		for (const [id, info] of this.tasks) {
			if (info.completedAt && now - info.completedAt > maxAgeMs) {
				this.tasks.delete(id);
				changed = true;
			}
		}
		if (changed) this.scheduleChange();
	}
}
