// Per-session input queue (Phase C2).
//
// # 文件说明书
//
// ## 核心功能
// 当一个 chat session 正在跑(loop.run 未返回)时,用户提交的输入不直接进
// session,而是进这个按 sessionId 的队列。两项操作:
//   - queued    :等待当前 run 结束后作为下一个 user turn 发送(drain)。
//   - insert_now:立即插入 —— 由 PrepareStep hook 在下一个 step 注入(不打断
//                 当前 step)。
// 期间用户可删除任意项,或把 queued 提升为 insert_now。
//
// 内存态(不落盘 —— 队列是即时操作意图,重启清空合理)。变更通过 emit 通知
// UI push。
//
// ## 定位
// src/server/ — 被 chat send 路径(忙时入队 + run 后 drain)、PrepareStep 注入
// hook、IPC router 使用。
//
export type InputQueueMode = "queued" | "insert_now";

export interface InputQueueItem {
	id: string;
	sessionId: string;
	content: string;
	mode: InputQueueMode;
	createdAt: number;
}

export interface InputQueueSnapshot {
	sessionId: string;
	items: InputQueueItem[];
}

type Listener = (snap: InputQueueSnapshot) => void;

export class InputQueueStore {
	private itemsBySession = new Map<string, InputQueueItem[]>();
	private listeners = new Set<Listener>();

	private emit(sessionId: string): void {
		const items = this.itemsBySession.get(sessionId) ?? [];
		const snap = { sessionId, items: [...items] };
		for (const l of this.listeners) {
			try { l(snap); } catch { /* listener errors are non-fatal */ }
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	list(sessionId: string): InputQueueItem[] {
		return [...(this.itemsBySession.get(sessionId) ?? [])];
	}

	enqueue(sessionId: string, content: string, mode: InputQueueMode = "queued"): InputQueueItem {
		const item: InputQueueItem = {
			id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			sessionId,
			content,
			mode,
			createdAt: Date.now(),
		};
		const arr = this.itemsBySession.get(sessionId) ?? [];
		arr.push(item);
		this.itemsBySession.set(sessionId, arr);
		this.emit(sessionId);
		return item;
	}

	remove(itemId: string): boolean {
		for (const [sid, arr] of this.itemsBySession) {
			const idx = arr.findIndex((i) => i.id === itemId);
			if (idx >= 0) {
				arr.splice(idx, 1);
				if (arr.length === 0) this.itemsBySession.delete(sid);
				this.emit(sid);
				return true;
			}
		}
		return false;
	}

	/** Promote a queued item to insert_now (inject at next step). */
	promoteInsertNow(itemId: string): boolean {
		for (const [sid, arr] of this.itemsBySession) {
			const item = arr.find((i) => i.id === itemId);
			if (item) {
				item.mode = "insert_now";
				this.emit(sid);
				return true;
			}
		}
		return false;
	}

	/**
	 * PrepareStep hook drain: consume all insert_now items for a session,
	 * returning their contents as messages to append for this step. FIFO.
	 */
	consumeInsertNow(sessionId: string): Array<{ role: string; content: string }> {
		const arr = this.itemsBySession.get(sessionId);
		if (!arr || arr.length === 0) return [];
		const taken = arr.filter((i) => i.mode === "insert_now");
		if (taken.length === 0) return [];
		const remaining = arr.filter((i) => i.mode !== "insert_now");
		if (remaining.length === 0) this.itemsBySession.delete(sessionId);
		else this.itemsBySession.set(sessionId, remaining);
		this.emit(sessionId);
		return taken.map((i) => ({ role: "user", content: i.content }));
	}

	/**
	 * Post-run drain: pop the first queued item (FIFO) for the next user turn.
	 * Returns its content, or undefined if the queue is empty.
	 */
	drainNextQueued(sessionId: string): string | undefined {
		const arr = this.itemsBySession.get(sessionId);
		if (!arr || arr.length === 0) return undefined;
		const idx = arr.findIndex((i) => i.mode === "queued");
		if (idx < 0) return undefined;
		const [item] = arr.splice(idx, 1);
		if (arr.length === 0) this.itemsBySession.delete(sessionId);
		this.emit(sessionId);
		return item.content;
	}

	hasQueued(sessionId: string): boolean {
		const arr = this.itemsBySession.get(sessionId);
		return !!arr && arr.some((i) => i.mode === "queued");
	}
}
