import { create } from "zustand";

export interface ToolCallBlock {
	type: "tool";
	name: string;
	status: "running" | "done" | "error";
}

export interface TextBlock {
	type: "text";
	text: string;
}

export type MessageBlock = TextBlock | ToolCallBlock;

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	blocks?: MessageBlock[];
	timestamp: number;
	streaming?: boolean;
}

interface ChatState {
	messages: ChatMessage[];
	activePersonaId: string | null;
	isStreaming: boolean;
	addMessage: (msg: ChatMessage) => void;
	updateAssistantText: (text: string) => void;
	addToolCall: (name: string) => void;
	updateToolCall: (name: string, status: "done" | "error") => void;
	setIsStreaming: (v: boolean) => void;
	finishStreaming: () => void;
	setActivePersona: (id: string | null) => void;
	loadMessages: (messages: ChatMessage[]) => void;
	clearMessages: () => void;
}

let msgCounter = 0;

function updateLastAssistantMsg(
	msgs: ChatMessage[],
	updater: (msg: ChatMessage) => ChatMessage,
): ChatMessage[] {
	const result = [...msgs];
	for (let i = result.length - 1; i >= 0; i--) {
		if (result[i].role === "assistant") {
			result[i] = updater(result[i]);
			break;
		}
	}
	return result;
}

export const useChatStore = create<ChatState>((set) => ({
	messages: [],
	activePersonaId: null,
	isStreaming: false,

	addMessage: (msg) =>
		set((state) => ({
			messages: [...state.messages, msg],
			isStreaming: msg.role === "assistant" ? true : state.isStreaming,
		})),

	updateAssistantText: (text) =>
		set((state) => ({
			messages: updateLastAssistantMsg(state.messages, (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				const lastBlock = blocks[blocks.length - 1];
				if (lastBlock && lastBlock.type === "text") {
					blocks[blocks.length - 1] = { type: "text", text };
				} else {
					blocks.push({ type: "text", text });
				}
				return { ...msg, blocks, streaming: true };
			}),
		})),

	addToolCall: (name) =>
		set((state) => ({
			messages: updateLastAssistantMsg(state.messages, (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				blocks.push({ type: "tool", name, status: "running" });
				return { ...msg, blocks, streaming: true };
			}),
		})),

	updateToolCall: (name, status) =>
		set((state) => ({
			messages: updateLastAssistantMsg(state.messages, (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				for (let i = blocks.length - 1; i >= 0; i--) {
					if (blocks[i].type === "tool") {
						const tb = blocks[i] as ToolCallBlock;
						if (tb.name === name && tb.status === "running") {
							blocks[i] = { ...tb, status };
							break;
						}
					}
				}
				return { ...msg, blocks, streaming: true };
			}),
		})),

	setIsStreaming: (v) => set({ isStreaming: v }),

	finishStreaming: () =>
		set((state) => {
			const msgs = state.messages.map((m) =>
				m.streaming ? { ...m, streaming: false } : m,
			);
			return { messages: msgs, isStreaming: false };
		}),

	setActivePersona: (id) => set({ activePersonaId: id }),

	loadMessages: (messages) => set({ messages, isStreaming: false }),

	clearMessages: () => set({ messages: [] }),
}));

export function nextMsgId(): string {
	return `msg-${++msgCounter}`;
}
