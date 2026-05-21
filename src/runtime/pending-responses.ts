// ---------------------------------------------------------------------------
// PendingResponseManager — bridges tool execution and user responses
// ---------------------------------------------------------------------------

interface PendingEntry {
	resolve: (value: Record<string, string>) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class PendingResponseManager {
	private pending = new Map<string, PendingEntry>();
	private static TIMEOUT_MS = 300000; // 5 minutes

	createRequest(id: string): Promise<Record<string, string>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error("User response timed out (5 minutes)"));
				}
			}, PendingResponseManager.TIMEOUT_MS);

			this.pending.set(id, { resolve, reject, timer });
		});
	}

	resolveRequest(id: string, value: Record<string, string>): void {
		const entry = this.pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			entry.resolve(value);
			this.pending.delete(id);
		}
	}

	rejectRequest(id: string, error: string): void {
		const entry = this.pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			entry.reject(new Error(error));
			this.pending.delete(id);
		}
	}

	has(id: string): boolean {
		return this.pending.has(id);
	}

	get size(): number {
		return this.pending.size;
	}
}

export const pendingResponses = new PendingResponseManager();
