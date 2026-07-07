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
import type { TaskInfo, TaskType, WakeReason, WaitSuspendOptions, WaitWakeResult } from "./types.js";

export class TaskRegistry {
	private tasks = new Map<string, TaskInfo>();
	private abortControllers = new Map<string, AbortController>();
	/**
	 * sub-5 (Wait rewrite): the active Wait suspension. Set by suspendUntilWake,
	 * cleared on wake. The registry itself is session-agnostic — exactly one
	 * Wait can be active per registry (one parent session waits on its own
	 * registry). tryWake() fires it on any task terminal transition;
	 * interruptWaitForUserInput() fires it for the user-input wake source.
	 */
	private waitResolver: ((reason: WakeReason) => void) | null = null;

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

	create(taskId: string, type: TaskType, task: string, abortController?: AbortController, parentTaskId?: string, targetAgentId?: string): void {
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
			targetAgentId: type === "subagent" ? targetAgentId : undefined,
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

	/**
	 * sub-6 (force-Wait hook): true when ANY task is still active (running OR
	 * finishing). The parent turn must not end while this is true — the
	 * force-Wait hook gates its nudge on this. Matches the in-suspendUntilWake
	 * definition so "should I keep waiting?" and "should the turn keep going?"
	 * agree on what "active" means.
	 */
	hasRunning(): boolean {
		for (const t of this.tasks.values()) {
			if (t.status === "running" || t.status === "finishing") return true;
		}
		return false;
	}

	/**
	 * sub-5 (Wait rewrite): suspend the calling Wait tool until one of three
	 * wake sources fires. Returns the wake reason + wall-clock elapsed.
	 *
	 * Wake sources (deterministic priority when multiple fire in the same tick):
	 *   1. user-input   — interruptWaitForUserInput() called (highest priority)
	 *   2. task finished — any background task reaches a terminal state
	 *                      (complete/fail/kill/acknowledge fires tryWake())
	 *   3. timeout      — the `until` absolute point or `timeout` relative
	 *                     duration elapses (lowest priority)
	 *
	 * If NO background task is running at suspend time AND no time source was
	 * given, the wait resolves immediately as "timeout" (nothing to wait for).
	 * If a time source is given, the timer is honored even with no running
	 * tasks (lets a caller Wait until a wall-clock point).
	 *
	 * Replaces the old task_id-scoped suspendUntilWake + generateSummary. Wait
	 * now returns ONLY the wake reason + elapsed; task details go via TaskGet.
	 *
	 * NOTE on system clock: absolute `until` is compared via Date.now(); a
	 * large clock jump (e.g. system sleep/wake) may cause a premature or
	 * delayed timeout wake. Accepted — durability of `until` across a real
	 * restart is the primary use case; in-process clock skew is best-effort.
	 */
	async suspendUntilWake(opts: WaitSuspendOptions): Promise<WaitWakeResult> {
		const start = Date.now();
		const untilMs = opts.until ? Date.parse(opts.until) : NaN;
		const hasAbsolute = !Number.isNaN(untilMs);
		const timeoutSec = opts.timeoutSec;
		const hasRelative = typeof timeoutSec === "number" && timeoutSec > 0;

		// Compute the timer delay (absolute point → relative delay). If neither
		// source is given, delay is undefined (timer not armed).
		let delayMs: number | undefined;
		if (hasAbsolute) {
			delayMs = Math.max(0, untilMs - start);
		} else if (hasRelative) {
			delayMs = Math.max(0, Math.min(timeoutSec!, 3600)) * 1000;
		}

		// Nothing to wait for (no time source AND no running task) → wake now.
		const hasRunning = () => [...this.tasks.values()].some((t) => t.status === "running" || t.status === "finishing");
		if (delayMs === undefined && !hasRunning()) {
			return { reason: "timeout", elapsedMs: 0 };
		}

		const reason = await new Promise<WakeReason>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (r: WakeReason) => {
				if (timer) clearTimeout(timer);
				if (this.waitResolver === finish) this.waitResolver = null;
				resolve(r);
			};
			// Register as the active resolver. tryWake() / interruptWaitForUserInput
			// call it. If a second Wait suspends while one is active (shouldn't
			// happen — a loop runs one Wait at a time), the new one supersedes.
			this.waitResolver = finish;

			if (delayMs !== undefined) {
				timer = setTimeout(() => finish("timeout"), delayMs);
			}
		});

		return { reason, elapsedMs: Date.now() - start };
	}

	/**
	 * sub-5: fire the user-input wake source. Called by the loop when a user
	 * message arrives while a Wait is suspended. No-op when no Wait is active.
	 * Has the highest wake priority (see suspendUntilWake).
	 */
	interruptWaitForUserInput(): void {
		if (this.waitResolver) this.waitResolver("user input");
	}

	private tryWake(): void {
		// sub-5: any task terminal transition wakes an active Wait with the
		// "task finished" reason. (Was: the old task-scoped wakeCallback.)
		if (this.waitResolver) this.waitResolver("task finished");
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
