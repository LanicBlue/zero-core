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
import { emitDataChange } from "./data-change-hub.js";

export type InputQueueMode = "queued" | "insert_now";

export interface InputQueueItem {
	id: string;
	sessionId: string;
	content: string;
	mode: InputQueueMode;
	createdAt: number;
	/**
	 * Step 2E: deferred-consume marker. Set when an insert_now item has been
	 * injected into a step (peekInsertNow) but NOT yet committed out of the
	 * queue. It stays in the array until that step succeeds (StepEnd), so a
	 * failed/retried attempt re-injects it. Cleared on commit/rollback.
	 */
	deliveredForStep?: number;
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
		// N1 (runtime-push-ui-sync): also feed the unified data-change-hub so
		// the input-queue strip receives the same coalesced, reconnect-safe
		// delivery as every other UI collection. The hub whitelists the
		// virtual collection name "runtime:input-queue"; items go as the
		// record so the renderer patches without a refetch.
		emitDataChange("runtime:input-queue", sessionId, "update", snap);
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
	 *
	 * @deprecated Step 2E: this drains immediately — a failed attempt would eat
	 * the injected user input. Use peekInsertNow + commitDeliveredForStep so the
	 * item only leaves the queue once the step it was injected into succeeds.
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
	 * Step 2E: peek + MARK delivered for insert_now items, returning their
	 * contents as messages to append for this step — WITHOUT removing them from
	 * the queue. Items stay in the array carrying `deliveredForStep = stepNumber`
	 * until commitDeliveredForStep(stepNumber) is called from a successful
	 * StepEnd.
	 *
	 * Re-injection on retry: a step that fails and is retried must re-inject the
	 * same items, because the prior attempt never committed (StepEnd only fires
	 * on success). The marker's sole purpose is to let commitDeliveredForStep
	 * locate the items to delete on success — it must NOT suppress re-peek.
	 * Therefore peek returns every insert_now item regardless of an existing
	 * deliveredForStep marker, and (re)stamps the marker to `stepNumber` so the
	 * matching commit finds them. A second peek within the same already-
	 * successful step is a no-op in practice (the items would have been
	 * committed out by StepEnd), but this method stays idempotent: calling it
	 * twice with the same stepNumber returns the same items both times without
	 * harm, since only commit actually removes them.
	 */
	peekInsertNow(sessionId: string, stepNumber: number): Array<{ role: string; content: string }> {
		const arr = this.itemsBySession.get(sessionId);
		if (!arr || arr.length === 0) return [];
		const taken: InputQueueItem[] = [];
		for (const item of arr) {
			if (item.mode !== "insert_now") continue;
			// Do NOT skip items already marked for this step — a retried step
			// (prior StepEnd never fired) MUST re-inject them. The marker is for
			// commit's benefit, not peek's. Re-stamp unconditionally so commit
			// for this stepNumber finds exactly these items.
			item.deliveredForStep = stepNumber;
			taken.push(item);
		}
		if (taken.length === 0) return [];
		this.emit(sessionId);
		return taken.map((i) => ({ role: "user", content: i.content }));
	}

	/**
	 * Step 2E: commit — actually remove from the queue all insert_now items that
	 * were marked delivered for `stepNumber`. Called from StepEnd on a successful
	 * step. Safe to call when nothing is marked (no-op).
	 */
	commitDeliveredForStep(sessionId: string, stepNumber: number): number {
		const arr = this.itemsBySession.get(sessionId);
		if (!arr || arr.length === 0) return 0;
		const remaining = arr.filter((i) => !(i.mode === "insert_now" && i.deliveredForStep === stepNumber));
		const removed = arr.length - remaining.length;
		if (removed === 0) return 0;
		// Clear the marker on any insert_now item that was marked for a DIFFERENT
		// step (e.g. an earlier failed attempt whose StepEnd never fired). Those
		// items re-enter the pool so the next peekInsertNow re-injects them.
		for (const item of remaining) {
			if (item.mode === "insert_now" && item.deliveredForStep !== undefined && item.deliveredForStep !== stepNumber) {
				item.deliveredForStep = undefined;
			}
		}
		if (remaining.length === 0) this.itemsBySession.delete(sessionId);
		else this.itemsBySession.set(sessionId, remaining);
		this.emit(sessionId);
		return removed;
	}

	/**
	 * Step 2E: rollback — clear the delivered marker on every insert_now item
	 * marked for `stepNumber` WITHOUT removing them, so the next step's
	 * peekInsertNow re-injects them. Kept for completeness; the success path
	 * uses commit, and a failed attempt simply never calls StepEnd (so the
	 * markers are auto-cleared by the next peek/commit cycle).
	 */
	rollbackDeliveredForStep(sessionId: string, stepNumber: number): number {
		const arr = this.itemsBySession.get(sessionId);
		if (!arr || arr.length === 0) return 0;
		let cleared = 0;
		for (const item of arr) {
			if (item.mode === "insert_now" && item.deliveredForStep === stepNumber) {
				item.deliveredForStep = undefined;
				cleared++;
			}
		}
		if (cleared > 0) this.emit(sessionId);
		return cleared;
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
