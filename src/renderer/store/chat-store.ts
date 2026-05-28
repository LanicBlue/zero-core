import { create } from "zustand";
import type { SessionRecord } from "../../shared/types.js";

export interface ToolCallBlock {
	type: "tool";
	name: string;
	status: "running" | "done" | "error";
	args?: string;
	result?: string;
}

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	text: string;
}

export type MessageBlock = TextBlock | ToolCallBlock | ThinkingBlock;

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	blocks?: MessageBlock[];
	timestamp: number;
	streaming?: boolean;
}

let _nextId = Date.now();
export const nextMsgId = () => String(_nextId++);

interface ChatState {
	messagesByAgent: Record<string, ChatMessage[]>;
	activeAgentId: string | null;
	streamingAgentId: string | null;
	messages: ChatMessage[];
	isStreaming: boolean;
	sessionsByAgent: Record<string, SessionRecord[]>;
	currentSessionId: string | null;

	addMessage: (agentId: string, msg: ChatMessage) => void;
	updateAssistantText: (agentId: string, text: string) => void;
	updateThinking: (agentId: string, text: string) => void;
	addToolCall: (agentId: string, name: string, args?: string) => void;
	updateToolCall: (agentId: string, name: string, status: "done" | "error", result?: string) => void;
	setIsStreaming: (agentId: string, v: boolean) => void;
	finishStreaming: (agentId: string) => void;
	setActiveAgent: (id: string | null) => void;
	loadMessages: (agentId: string, messages: ChatMessage[]) => void;
	clearMessages: (agentId: string) => void;
	setSessions: (agentId: string, sessions: SessionRecord[]) => void;
	setCurrentSessionId: (sessionId: string | null) => void;
	editMessage: (agentId: string, msgId: string, newText: string) => void;
	deleteMessage: (agentId: string, msgId: string) => void;
}

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
	messagesByAgent: {},
	activeAgentId: null,
	streamingAgentId: null,
	messages: [],
	isStreaming: false,
	sessionsByAgent: {},
	currentSessionId: null,

	addMessage: (agentId, msg) =>
		set((state) => {
			const agentMsgs = [...(state.messagesByAgent[agentId] ?? []), msg];
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			const newStreamingId = msg.role === "assistant" ? agentId : state.streamingAgentId;
			return {
				messagesByAgent: newByAgent,
				streamingAgentId: newStreamingId,
				messages: isActive ? agentMsgs : state.messages,
				isStreaming: newStreamingId !== null && newStreamingId === state.activeAgentId,
			};
		}),

	updateAssistantText: (agentId, text) =>
		set((state) => {
			const agentMsgs = updateLastAssistantMsg(state.messagesByAgent[agentId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				const lastBlock = blocks[blocks.length - 1];
				if (lastBlock && lastBlock.type === "text") {
					blocks[blocks.length - 1] = { type: "text", text };
				} else {
					blocks.push({ type: "text", text });
				}
				return { ...msg, blocks, streaming: true };
			});
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? agentMsgs : state.messages,
			};
		}),

	updateThinking: (agentId, text) =>
		set((state) => {
			const agentMsgs = updateLastAssistantMsg(state.messagesByAgent[agentId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				const lastBlock = blocks[blocks.length - 1];
				if (lastBlock && lastBlock.type === "thinking") {
					blocks[blocks.length - 1] = { type: "thinking", text };
				} else {
					blocks.push({ type: "thinking", text });
				}
				return { ...msg, blocks, streaming: true };
			});
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? agentMsgs : state.messages,
			};
		}),

	addToolCall: (agentId, name, args?) =>
		set((state) => {
			const agentMsgs = updateLastAssistantMsg(state.messagesByAgent[agentId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				blocks.push({ type: "tool", name, status: "running", args });
				return { ...msg, blocks, streaming: true };
			});
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? agentMsgs : state.messages,
			};
		}),

	updateToolCall: (agentId, name, status, result?) =>
		set((state) => {
			const agentMsgs = updateLastAssistantMsg(state.messagesByAgent[agentId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				for (let i = blocks.length - 1; i >= 0; i--) {
					if (blocks[i].type === "tool") {
						const tb = blocks[i] as ToolCallBlock;
						if (tb.name === name && tb.status === "running") {
							blocks[i] = { ...tb, status, result };
							break;
						}
					}
				}
				return { ...msg, blocks, streaming: true };
			});
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? agentMsgs : state.messages,
			};
		}),

	setIsStreaming: (agentId, v) =>
		set((state) => {
			const newStreamingId = v ? agentId : (state.streamingAgentId === agentId ? null : state.streamingAgentId);
			return {
				streamingAgentId: newStreamingId,
				isStreaming: newStreamingId !== null && newStreamingId === state.activeAgentId,
			};
		}),

	finishStreaming: (agentId) =>
		set((state) => {
			const agentMsgs = (state.messagesByAgent[agentId] ?? []).map((m) =>
				m.streaming ? { ...m, streaming: false } : m,
			);
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			const newStreamingId = state.streamingAgentId === agentId ? null : state.streamingAgentId;
			return {
				messagesByAgent: newByAgent,
				streamingAgentId: newStreamingId,
				messages: isActive ? agentMsgs : state.messages,
				isStreaming: newStreamingId !== null && newStreamingId === state.activeAgentId,
			};
		}),

	setActiveAgent: (id) =>
		set((state) => {
			const newByAgent = { ...state.messagesByAgent };
			if (state.activeAgentId && state.activeAgentId !== id) {
				newByAgent[state.activeAgentId] = state.messages;
			}
			const newMessages = newByAgent[id] ?? [];
			return {
				activeAgentId: id,
				messagesByAgent: newByAgent,
				messages: newMessages,
				isStreaming: state.streamingAgentId !== null && state.streamingAgentId === id,
			};
		}),

	loadMessages: (agentId, msgs) =>
		set((state) => {
			const newByAgent = { ...state.messagesByAgent, [agentId]: msgs };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? msgs : state.messages,
			};
		}),

	clearMessages: (agentId) =>
		set((state) => {
			const newByAgent = { ...state.messagesByAgent, [agentId]: [] };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? [] : state.messages,
			};
		}),

	setSessions: (agentId, sessions) =>
		set((state) => ({
			sessionsByAgent: { ...state.sessionsByAgent, [agentId]: sessions },
		})),

	setCurrentSessionId: (sessionId) =>
		set({ currentSessionId: sessionId }),

	editMessage: (agentId, msgId, newText) =>
		set((state) => {
			const agentMsgs = (state.messagesByAgent[agentId] ?? []).map((m) =>
				m.id === msgId
					? { ...m, text: newText, blocks: [{ type: "text" as const, text: newText }] }
					: m,
			);
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? agentMsgs : state.messages,
			};
		}),

	deleteMessage: (agentId, msgId) =>
		set((state) => {
			const agentMsgs = (state.messagesByAgent[agentId] ?? []).filter((m) => m.id !== msgId);
			const newByAgent = { ...state.messagesByAgent, [agentId]: agentMsgs };
			const isActive = agentId === state.activeAgentId;
			return {
				messagesByAgent: newByAgent,
				messages: isActive ? agentMsgs : state.messages,
			};
		}),
}));
