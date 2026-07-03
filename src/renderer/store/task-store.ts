// Delegated task tree state (TaskTree UI).
//
// # 文件说明书
//
// ## 核心功能
// Per-session LIVE task list, pull-on-display: the TaskTreePanel pulls from the
// agent's IN-MEMORY task registry (same source the agent's TaskList tool reads)
// so the UI and the agent agree on count/status and bash background tasks are
// visible. Returned as a flat list with parentTaskId — the panel rebuilds the
// delegation tree (sub-agent of sub-agent).
//
// ## Push-driven (N2)
// TaskRegistry lives in the runtime layer (src/runtime/) and cannot import the
// server hub, so its change ping is broadcast over `agent:event` as
// `runtime:tasks:changed` (carrying sessionId). We subscribe ONCE at module
// load: on each ping, if the pinged sessionId is currently WATCHED (i.e. some
// visible panel is showing it), we pull that session once. There is NO
// setInterval fallback — gaps are covered by pull-on-display and the
// `ws:reconnected` resync signal.
//
// ## Why in-memory (not the delegated_tasks DB)
// The DB view (delegatedTasksBySession) diverged from the agent's view: it
// missed bash background tasks (only in memory), filtered by parent_session_id
// (only depth-1), and persisted across restart while the agent's registry did
// not. Reading the same in-memory Map the agent reads eliminates the mismatch.
// The DB channel is retained elsewhere for restart-aware inspection/history.
//
// ## 输入
// IPC: runtimeTasks:bySession; agent:event `runtime:tasks:changed`.
//
// ## 输出
// - tasksBySession(sessionId → RuntimeTaskInfo[])
// - loadingBySession
// - pull(sessionId), startWatching(sessionId), stopWatching(sessionId)
// - selectTask(taskId?)
//

import { create } from "zustand";
import type { RuntimeTaskInfo } from "../../shared/types.js";

const api = () => (window as any).api;

interface TaskState {
	tasksBySession: Record<string, RuntimeTaskInfo[]>;
	loadingBySession: Record<string, boolean>;
	selectedTaskId?: string;
	// Set of sessionIds a visible panel is currently watching. Ping→pull fires
	// only for these; switching away removes the id (disconnect-on-leave).
	watched: Set<string>;
	pull: (sessionId: string) => Promise<void>;
	startWatching: (sessionId: string) => void;
	stopWatching: (sessionId: string) => void;
	selectTask: (taskId?: string) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
	tasksBySession: {},
	loadingBySession: {},
	watched: new Set(),

	pull: async (sessionId: string) => {
		set((s) => ({ loadingBySession: { ...s.loadingBySession, [sessionId]: true } }));
		try {
			const tasks: RuntimeTaskInfo[] = await api().runtimeTasksBySession(sessionId);
			set((s) => ({ tasksBySession: { ...s.tasksBySession, [sessionId]: tasks ?? [] }, loadingBySession: { ...s.loadingBySession, [sessionId]: false } }));
		} catch {
			set((s) => ({ loadingBySession: { ...s.loadingBySession, [sessionId]: false } }));
		}
	},

	startWatching: (sessionId: string) => {
		const { watched } = get();
		if (watched.has(sessionId)) {
			// Already watching — still refresh once on (re)mount so a tab that was
			// hidden and is shown again gets a fresh pull-on-display.
			void get().pull(sessionId);
			return;
		}
		const next = new Set(watched);
		next.add(sessionId);
		set({ watched: next });
		// Pull immediately on first watch; subsequent updates arrive via the
		// runtime:tasks:changed agent:event ping.
		void get().pull(sessionId);
	},

	stopWatching: (sessionId: string) => {
		const { watched } = get();
		if (!watched.has(sessionId)) return;
		const next = new Set(watched);
		next.delete(sessionId);
		set({ watched: next });
	},

	selectTask: (taskId?: string) => set({ selectedTaskId: taskId }),
}));

// ─── Module-load subscription: runtime:tasks:changed ping → pull (watched only) ───
// TaskRegistry (runtime layer) cannot use the server hub, so its coalesced
// change ping is re-broadcast as an agent:event of this type, stamped with the
// sessionId by AgentLoop. We pull only sessions a visible panel is watching;
// pings for unwatched/background sessions are dropped (over-pull guard).
if (typeof window !== "undefined") {
	api().onAgentEvent((e: { type?: string; sessionId?: string }) => {
		if (e?.type !== "runtime:tasks:changed") return;
		const sid = e.sessionId;
		if (!sid) return;
		const state = useTaskStore.getState();
		if (!state.watched.has(sid)) return;
		void state.pull(sid);
	});
}
