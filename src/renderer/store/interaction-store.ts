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
