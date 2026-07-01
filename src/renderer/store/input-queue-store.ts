// Input queue renderer state (Phase C2).
//
// Per-session queue mirror for the chat queue strip. Pulls (polls) the server
// queue for the active session so the strip stays live while visible. The
// queue changes server-side on enqueue/promote/remove/drain — a 1s poll is
// cheap (small array, in-memory) and avoids a push channel.
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
	pollTimers: Record<string, ReturnType<typeof setInterval>>;
	pull: (sessionId: string) => Promise<void>;
	startPolling: (sessionId: string) => void;
	stopPolling: (sessionId: string) => void;
	enqueue: (sessionId: string, content: string, mode?: "queued" | "insert_now") => Promise<void>;
	promote: (itemId: string) => Promise<void>;
	remove: (itemId: string) => Promise<void>;
}

const POLL_MS = 1000;

export const useInputQueueStore = create<InputQueueState>((set, get) => ({
	itemsBySession: {},
	pollTimers: {},

	pull: async (sessionId: string) => {
		try {
			const items: InputQueueItemView[] = await api().inputQueueList(sessionId);
			set((s) => ({ itemsBySession: { ...s.itemsBySession, [sessionId]: items ?? [] } }));
		} catch { /* ignore */ }
	},

	startPolling: (sessionId: string) => {
		const { pollTimers } = get();
		if (pollTimers[sessionId]) return;
		void get().pull(sessionId);
		const timer = setInterval(() => { void get().pull(sessionId); }, POLL_MS);
		set((s) => ({ pollTimers: { ...s.pollTimers, [sessionId]: timer } }));
	},

	stopPolling: (sessionId: string) => {
		const timer = get().pollTimers[sessionId];
		if (timer) clearInterval(timer);
		set((s) => {
			const next = { ...s.pollTimers };
			delete next[sessionId];
			return { pollTimers: next };
		});
	},

	enqueue: async (sessionId, content, mode) => {
		await api().inputQueueEnqueue(sessionId, content, mode ?? "queued");
		await get().pull(sessionId);
	},

	promote: async (itemId) => {
		await api().inputQueuePromote(itemId);
		// pull happens via poll; no immediate target session known here.
	},

	remove: async (itemId) => {
		await api().inputQueueRemove(itemId);
	},
}));
