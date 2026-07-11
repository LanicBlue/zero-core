// Input queue renderer state.
//
// # 文件说明书
//
// ## 核心功能
// Per-session queue mirror for the chat queue strip. The queue changes server-
// side on enqueue/promote/remove/drain — InputQueueStore (server layer) emits
// those via the unified hub under the virtual collection `runtime:input-queue`
// (changes carry the sessionId as `id`). We subscribe ONCE at module load and
// pull the watched session when its queue changes. There is NO setInterval
// fallback — gaps are covered by pull-on-display and the `ws:reconnected`
// resync signal.
//
// ## 输入
// IPC: inputQueueList; data:changed `runtime:input-queue`.
//
// ## 输出
// - itemsBySession(sessionId → InputQueueItemView[])
// - pull / startWatching / stopWatching / enqueue / promote / remove
//

import { create } from "zustand";

const api = () => (window as any).api;

export interface InputQueueItemView {
	id: string;
	sessionId: string;
	content: string;
	mode: "queued" | "insert_now";
	createdAt: number;
}

interface InputQueueState {
	itemsBySession: Record<string, InputQueueItemView[]>;
	// Set of sessionIds a visible panel is currently watching.
	watched: Set<string>;
	pull: (sessionId: string) => Promise<void>;
	startWatching: (sessionId: string) => void;
	stopWatching: (sessionId: string) => void;
	enqueue: (sessionId: string, content: string, mode?: "queued" | "insert_now") => Promise<void>;
	promote: (itemId: string) => Promise<void>;
	remove: (itemId: string) => Promise<void>;
}

export const useInputQueueStore = create<InputQueueState>((set, get) => ({
	itemsBySession: {},
	watched: new Set(),

	pull: async (sessionId: string) => {
		try {
			const items: InputQueueItemView[] = await api().inputQueueList(sessionId);
			set((s) => ({ itemsBySession: { ...s.itemsBySession, [sessionId]: items ?? [] } }));
		} catch { /* ignore */ }
	},

	startWatching: (sessionId: string) => {
		const { watched } = get();
		if (watched.has(sessionId)) {
			void get().pull(sessionId);
			return;
		}
		const next = new Set(watched);
		next.add(sessionId);
		set({ watched: next });
		void get().pull(sessionId);
	},

	stopWatching: (sessionId: string) => {
		const { watched } = get();
		if (!watched.has(sessionId)) return;
		const next = new Set(watched);
		next.delete(sessionId);
		set({ watched: next });
	},

	enqueue: async (sessionId, content, mode) => {
		const m = mode ?? "queued";
		// Optimistic: insert a LOCAL item the instant the user submits so the
		// queue strip renders immediately — even mid-turn, when the backend
		// round-trip (IPC→main→fetch→backend) and the runtime:input-queue WS ping
		// can lag behind the streaming flood and only land at turn end. The temp
		// item (id prefixed `local-`) is reconciled to the authoritative item when
		// the IPC resolves, and rolled back on failure so the strip never lies.
		// promote/remove are disabled on `local-` items (server doesn't know the
		// temp id yet) — see InputQueueStrip.
		const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const createdAt = Date.now();
		set((s) => ({
			itemsBySession: {
				...s.itemsBySession,
				[sessionId]: [...(s.itemsBySession[sessionId] ?? []), { id: tempId, sessionId, content, mode: m, createdAt }],
			},
		}));
		try {
			const item: InputQueueItemView = await api().inputQueueEnqueue(sessionId, content, m);
			set((s) => ({
				itemsBySession: {
					...s.itemsBySession,
					[sessionId]: (s.itemsBySession[sessionId] ?? []).map((it) => (it.id === tempId ? item : it)),
				},
			}));
		} catch {
			set((s) => ({
				itemsBySession: {
					...s.itemsBySession,
					[sessionId]: (s.itemsBySession[sessionId] ?? []).filter((it) => it.id !== tempId),
				},
			}));
		}
	},

	promote: async (itemId) => {
		await api().inputQueuePromote(itemId);
		// Refresh arrives via the runtime:input-queue ping for the watched
		// session; no target session is known at this call site.
	},

	remove: async (itemId) => {
		await api().inputQueueRemove(itemId);
		// Refresh arrives via the runtime:input-queue ping for the watched
		// session; no target session is known at this call site.
	},
}));

// ─── Module-load subscription: runtime:input-queue ping → pull (watched only) ───
// InputQueueStore (server layer) emits through the unified data-change hub with
// collection="runtime:input-queue" and changes[].id = sessionId. Pull only the
// watched session; pings for unwatched sessions are dropped.
if (typeof window !== "undefined") {
	api().onDataChanged((e: { collection?: string; changes?: Array<{ id?: string }> }) => {
		if (e?.collection !== "runtime:input-queue") return;
		const state = useInputQueueStore.getState();
		for (const c of e.changes ?? []) {
			const sid = c?.id;
			if (!sid) continue;
			if (!state.watched.has(sid)) continue;
			void state.pull(sid);
		}
	});
}
