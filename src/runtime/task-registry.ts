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

	create(taskId: string, type: TaskType, task: string, abortController?: AbortController): void {
		this.tasks.set(taskId, {
			id: taskId,
			type,
			task,
			status: "running",
			step: 0,
			startedAt: Date.now(),
		});
		if (abortController) {
			this.abortControllers.set(taskId, abortController);
		}
	}

	updateProgress(taskId: string, step: number, toolName?: string): void {
		const info = this.tasks.get(taskId);
		if (!info || info.status !== "running") return;
		info.step = step;
		if (toolName) info.currentTool = toolName;
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
	}

	kill(taskId: string): boolean {
		const info = this.tasks.get(taskId);
		if (!info || info.status !== "running") return false;
		const ac = this.abortControllers.get(taskId);
		if (ac) {
			ac.abort();
			this.abortControllers.delete(taskId);
		}
		info.status = "killed";
		info.completedAt = Date.now();
		info.currentTool = undefined;
		this.tryWake();
		return true;
	}

	get(taskId: string): TaskInfo | undefined {
		return this.tasks.get(taskId);
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
			? this.tasks.get(taskId)?.status === "running"
			: [...this.tasks.values()].some((t) => t.status === "running");

		if (!hasRunning) return this.generateSummary(taskId);

		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.wakeCallback = null;
				resolve();
			}, timeoutMs);

			this.wakeCallback = () => {
				if (taskId) {
					const info = this.tasks.get(taskId);
					if (info && info.status !== "running") {
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

			if (info.status === "running") {
				const typeLabel = info.type === "bash" ? "bash" : "subagent";
				running.push(`[${info.id}] ${typeLabel} running${info.currentTool ? " (tool: " + info.currentTool + ")" : ""}`);
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
		for (const [id, info] of this.tasks) {
			if (info.completedAt && now - info.completedAt > maxAgeMs) {
				this.tasks.delete(id);
			}
		}
	}
}
