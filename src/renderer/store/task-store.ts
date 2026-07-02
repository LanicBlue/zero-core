// Delegated task tree state (TaskTree UI).
//
// # 文件说明书
//
// ## 核心功能
// Per-session LIVE task list, pull-on-display: the TaskTreePanel pulls from the
// agent's IN-MEMORY task registry (same source the agent's TaskList tool reads)
// so the UI and the agent agree on count/status and bash background tasks are
// visible. Slow-polls while visible so live progress (turns/tokens/currentTool/
// status) refreshes. Returned as a flat list with parentTaskId — the panel
// rebuilds the delegation tree (sub-agent of sub-agent).
//
// ## Why in-memory (not the delegated_tasks DB)
// The DB view (delegatedTasksBySession) diverged from the agent's view: it
// missed bash background tasks (only in memory), filtered by parent_session_id
// (only depth-1), and persisted across restart while the agent's registry did
// not. Reading the same in-memory Map the agent reads eliminates the mismatch.
// The DB channel is retained elsewhere for restart-aware inspection/history.
//
// ## 输入
// IPC: runtimeTasks:bySession.
//
// ## 输出
// - tasksBySession(sessionId → RuntimeTaskInfo[])
// - loadingBySession
// - pull(sessionId), stop(sessionId)
//
import { create } from "zustand";
import type { RuntimeTaskInfo } from "../../shared/types.js";

const api = () => (window as any).api;

const POLL_MS = 2500;

interface TaskState {
	tasksBySession: Record<string, RuntimeTaskInfo[]>;
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
			const tasks: RuntimeTaskInfo[] = await api().runtimeTasksBySession(sessionId);
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
