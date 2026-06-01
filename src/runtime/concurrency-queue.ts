interface Waiter {
	resolve: () => void;
	reject: (reason: Error) => void;
	abortHandler: () => void;
}

/**
 * FIFO semaphore for controlling concurrent API requests per provider.
 */
export class ConcurrencyQueue {
	private active = 0;
	private max: number;
	private waiters: Waiter[] = [];

	constructor(max: number) {
		this.max = max;
	}

	acquire(signal?: AbortSignal): Promise<void> {
		if (this.active < this.max) {
			this.active++;
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			let cleaned = false;
			const waiter: Waiter = {
				resolve: () => {
					this.active++;
					cleaned = true;
					cleanup();
					resolve();
				},
				reject: (err: Error) => {
					cleaned = true;
					cleanup();
					reject(err);
				},
				abortHandler: () => {
					const idx = this.waiters.indexOf(waiter);
					if (idx >= 0) this.waiters.splice(idx, 1);
					cleaned = true;
					cleanup();
					reject(new DOMException("Aborted", "AbortError"));
				},
			};

			const cleanup = () => {
				if (signal) signal.removeEventListener("abort", waiter.abortHandler);
			};

			if (signal?.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}

			if (signal) signal.addEventListener("abort", waiter.abortHandler, { once: true });
			this.waiters.push(waiter);
		});
	}

	release(): void {
		if (this.active > 0) this.active--;
		if (this.waiters.length > 0) {
			const next = this.waiters.shift()!;
			next.resolve();
		}
	}

	setMax(n: number): void {
		this.max = n;
		while (this.active < this.max && this.waiters.length > 0) {
			const next = this.waiters.shift()!;
			next.resolve();
		}
	}

	getActiveCount(): number { return this.active; }
	getWaitingCount(): number { return this.waiters.length; }
}
