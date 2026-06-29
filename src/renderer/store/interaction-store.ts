// 用户交互状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理 AskUser 问题和 TodoWrite 的前端状态,全部按 sessionId 隔离。
//
// ## 输入
// AskUserQuestion 数据、TodoWrite 项列表(均带 sessionId)
//
// ## 输出
// InteractionState(按 session 索引的待回答问题、待办列表)
//
// ## 定位
// src/renderer/store/ — 渲染进程状态层,桥接 agent 交互与 UI 显示
//
// ## 依赖
// zustand
//
// ## 维护规则
// - 一切按 sessionId 隔离:同一 agent 的 General / 各 project session 各自独立,
//   不再"Tasks / AskUser 在一个 agent 内跨 session 串显"。
// - 数据生命周期遵循"显示时 pull + active 时收 push + 切走断 push":
//   切到 session 时由 ChatPanel 用 sessionsGetInit 拉基线写入本 store;
//   active 期间 AppLayout 只把该 session 的 todos_update / ask_user 写入;
//   切走后不再收(留旧值,下次显示时 pull 覆盖)。
//
import { create } from "zustand";

// ---------------------------------------------------------------------------
// Interaction store — AskUser questions and TodoWrite state, keyed by sessionId
// ---------------------------------------------------------------------------

export interface AskUserQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

export interface PendingAskUser {
	requestId: string;
	agentId: string;
	questions: AskUserQuestion[];
}

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
}

interface InteractionState {
	/** 按 sessionId 索引的未决 AskUser(同一 agent 多 session 各自独立)。 */
	pendingBySession: Record<string, PendingAskUser>;
	/** 按 sessionId 索引的 todo 列表。 */
	todosBySession: Record<string, TodoItem[]>;

	setPending: (sessionId: string, q: PendingAskUser | null) => void;
	setTodos: (sessionId: string, todos: TodoItem[]) => void;
	clearTodos: (sessionId: string) => void;
}

export const useInteractionStore = create<InteractionState>((set) => ({
	pendingBySession: {},
	todosBySession: {},

	setPending: (sessionId, q) =>
		set((s) => {
			const next = { ...s.pendingBySession };
			if (q) next[sessionId] = q;
			else delete next[sessionId];
			return { pendingBySession: next };
		}),
	setTodos: (sessionId, todos) =>
		set((s) => ({ todosBySession: { ...s.todosBySession, [sessionId]: todos } })),
	clearTodos: (sessionId) =>
		set((s) => {
			const next = { ...s.todosBySession };
			delete next[sessionId];
			return { todosBySession: next };
		}),
}));
