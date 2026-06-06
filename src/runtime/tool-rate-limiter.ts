// 工具限速队列
//
// FIFO 信号量 + 时间间隔门控，控制每个工具的调用速率。
// 两个独立维度可单独或组合使用：
// - maxConcurrent: 同一工具最多 N 个并行执行
// - minInterval: 两次调用之间最小间隔（ms）
//
// 当两个值都为 0 时完全跳过限速逻辑，零开销。

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
