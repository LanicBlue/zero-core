// Delegated task tree state (TaskTree UI).
//
// # 文件说明书
//
// ## 核心功能
// Per-session delegated task list, pull-on-display: the TaskTreePanel pulls
// when shown / when the active session switches, and slow-polls while visible
// so live progress (turns/tokens/currentTool/status) refreshes. No push
// channel — updateDelegatedTask fires on every tool_start/usage, too hot for
// the data-change hub.
//
// ## 输入
// IPC: delegatedTasks:bySession.
//
// ## 输出
// - tasksBySession(sessionId → DelegatedTaskRecord[])
// - loadingBySession
// - pull(sessionId), stop(sessionId)
//
import { create } from "zustand";
import type { DelegatedTaskRecord } from "../../shared/types.js";

const api = () => (window as any).api;

const POLL_MS = 2500;

interface TaskState {
	tasksBySession: Record<string, DelegatedTaskRecord[]>;
	loadingBySession: Record<string, boolean>;
	selectedTaskId?: string;
	pollTimers: Record<string, ReturnType<typeof setInterval>>;
	pull: (sessionId: string) => Promise<void>;
	startPolling: (sessionId: string) => void;
	stopPolling: (sessionId: string) => void;
	selectTask: (taskId?: string) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
	tasksBySession: {},
	loadingBySession: {},
	pollTimers: {},

	pull: async (sessionId: string) => {
		set((s) => ({ loadingBySession: { ...s.loadingBySession, [sessionId]: true } }));
		try {
			const tasks: DelegatedTaskRecord[] = await api().delegatedTasksBySession(sessionId);
			set((s) => ({ tasksBySession: { ...s.tasksBySession, [sessionId]: tasks ?? [] }, loadingBySession: { ...s.loadingBySession, [sessionId]: false } }));
		} catch {
			set((s) => ({ loadingBySession: { ...s.loadingBySession, [sessionId]: false } }));
		}
	},

	startPolling: (sessionId: string) => {
		const { pollTimers } = get();
		if (pollTimers[sessionId]) return;
		// Pull immediately, then on the interval. Clear on stop().
		void get().pull(sessionId);
		const timer = setInterval(() => { void get().pull(sessionId); }, POLL_MS);
		set((s) => ({ pollTimers: { ...s.pollTimers, [sessionId]: timer } }));
	},

	stopPolling: (sessionId: string) => {
		const timer = get().pollTimers[sessionId];
		if (timer) { clearInterval(timer); }
		set((s) => {
			const next = { ...s.pollTimers };
			delete next[sessionId];
			return { pollTimers: next };
		});
	},

	selectTask: (taskId?: string) => set({ selectedTaskId: taskId }),
}));
