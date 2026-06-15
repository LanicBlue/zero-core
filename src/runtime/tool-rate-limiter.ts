// 工具调用限速队列：每工具 maxConcurrent + minInterval 双维度门控。
//
// # 文件说明书
//
// ## 核心功能
// ToolRateLimiter 按工具名维护 slot；acquire 时同时校验并发数与最小时间间隔，不满足则进入
// FIFO waiter 队列，由 release 或定时器异步唤醒。两个维度可单独或组合使用；两者都为 0 时
// acquire 直接返回，零开销。
//
// ## 输入
// - acquire(toolName, { minInterval?, maxConcurrent? })：发起一次调用请求
// - release(toolName)：调用结束释放槽位
//
// ## 输出
// - 无显式返回；通过 Promise resolve 通知调用方何时可以真正执行工具
//
// ## 定位
// runtime 层通用基础设施，由工具执行路径在调用 execute 前后包裹，配合 provider-concurrency-manager
// 等机制共同限流。
//
// ## 依赖
// - 仅依赖 Node 内置 setTimeout / clearTimeout，无第三方或 DB 依赖
//
// ## 维护规则
// - 修改调度逻辑后必须验证 waiter 队列在并发释放、定时器取消、minInterval=0 等边界下不会泄漏或卡死。
// - 新增维度（如 token 限流）应作为独立模块，不要把职责塞进本类。

interface Waiter {
	resolve: () => void;
}

interface Slot {
	active: number;
	maxConcurrent: number;
	minInterval: number;
	lastRelease: number;
	waiters: Waiter[];
	timer: ReturnType<typeof setTimeout> | null;
}

export class ToolRateLimiter {
	private slots = new Map<string, Slot>();

	private getSlot(name: string): Slot {
		let slot = this.slots.get(name);
		if (!slot) {
			slot = { active: 0, maxConcurrent: 0, minInterval: 0, lastRelease: 0, waiters: [], timer: null };
			this.slots.set(name, slot);
		}
		return slot;
	}

	async acquire(toolName: string, config: { minInterval?: number; maxConcurrent?: number }): Promise<void> {
		const minInterval = config.minInterval ?? 0;
		const maxConcurrent = config.maxConcurrent ?? 0;

		// Zero-overhead path: no limits configured
		if (minInterval <= 0 && maxConcurrent <= 0) return;

		const slot = this.getSlot(toolName);
		slot.minInterval = minInterval;
		slot.maxConcurrent = maxConcurrent;

		// Fast path: slot available and interval satisfied
		if (this.canProceed(slot)) {
			slot.active++;
			return;
		}

		// Queue and wait
		return new Promise<void>((resolve) => {
			slot.waiters.push({ resolve });
			this.scheduleRelease(toolName);
		});
	}

	release(toolName: string): void {
		const slot = this.slots.get(toolName);
		if (!slot) return;

		slot.active--;
		slot.lastRelease = Date.now();
		this.scheduleRelease(toolName);
	}

	private canProceed(slot: Slot): boolean {
		const now = Date.now();
		const concurrentOk = slot.maxConcurrent <= 0 || slot.active < slot.maxConcurrent;
		const intervalOk = slot.minInterval <= 0 || (now - slot.lastRelease) >= slot.minInterval;
		return concurrentOk && intervalOk;
	}

	private scheduleRelease(toolName: string): void {
		const slot = this.slots.get(toolName);
		if (!slot || slot.waiters.length === 0) return;

		// Clear existing timer
		if (slot.timer) {
			clearTimeout(slot.timer);
			slot.timer = null;
		}

		const tryNext = () => {
			slot.timer = null;
			if (slot.waiters.length === 0) return;

			if (this.canProceed(slot)) {
				const next = slot.waiters.shift()!;
				slot.active++;
				next.resolve();

				// Try to release more if concurrent slots available
				if (slot.waiters.length > 0) {
					this.scheduleRelease(toolName);
				}
			} else {
				this.scheduleRelease(toolName);
			}
		};

		const now = Date.now();
		const waitMs = Math.max(0, slot.minInterval - (now - slot.lastRelease));

		if (waitMs > 0) {
			slot.timer = setTimeout(tryNext, waitMs);
		} else if (slot.maxConcurrent <= 0 || slot.active < slot.maxConcurrent) {
			// Concurrent slot available, release immediately
			const next = slot.waiters.shift()!;
			slot.active++;
			next.resolve();
			// Check if more can be released
			if (slot.waiters.length > 0) {
				this.scheduleRelease(toolName);
			}
		} else {
			// Waiting for a concurrent slot — no timer needed, release will trigger scheduleRelease
		}
	}
}
