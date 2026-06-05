// 用户交互状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理 AskUser 问题和 TodoWrite 的前端状态
//
// ## 输入
// AskUserQuestion 数据、TodoWrite 项列表
//
// ## 输出
// InteractionState（待回答问题、待办列表）
//
// ## 定位
// src/renderer/store/ — 渲染进程状态层，桥接 agent 交互与 UI 显示
//
// ## 依赖
// zustand
//
// ## 维护规则
// 新增交互类型需在此添加对应状态管理
//
import { create } from "zustand";

// ---------------------------------------------------------------------------
// Interaction store — manages AskUser questions and TodoWrite state
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
	pendingQuestions: PendingAskUser | null;
	todosByAgent: Record<string, TodoItem[]>;

	setPendingQuestions: (q: PendingAskUser | null) => void;
	setTodos: (agentId: string, todos: TodoItem[]) => void;
	clearTodos: (agentId: string) => void;
}

export const useInteractionStore = create<InteractionState>((set) => ({
	pendingQuestions: null,
	todosByAgent: {},

	setPendingQuestions: (q) => set({ pendingQuestions: q }),
	setTodos: (agentId, todos) =>
		set((s) => ({ todosByAgent: { ...s.todosByAgent, [agentId]: todos } })),
	clearTodos: (agentId) =>
		set((s) => {
			const next = { ...s.todosByAgent };
			delete next[agentId];
			return { todosByAgent: next };
		}),
}));
