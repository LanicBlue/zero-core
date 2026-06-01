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
	messagesBySession: Record<string, ChatMessage[]>;
	activeAgentId: string | null;
	activeSessionId: string | null;
	streamingSessionId: string | null;
	messages: ChatMessage[];
	isStreaming: boolean;
	sessionsByAgent: Record<string, SessionRecord[]>;

	addMessage: (sessionId: string, msg: ChatMessage) => void;
	updateAssistantText: (sessionId: string, text: string) => void;
	updateThinking: (sessionId: string, text: string) => void;
	addToolCall: (sessionId: string, name: string, args?: string) => void;
	updateToolCall: (sessionId: string, name: string, status: "done" | "error", result?: string) => void;
	setIsStreaming: (sessionId: string, v: boolean) => void;
	finishStreaming: (sessionId: string) => void;
	setActiveAgent: (id: string | null, sessionId?: string | null) => void;
	loadMessages: (sessionId: string, messages: ChatMessage[]) => void;
	clearMessages: (sessionId: string) => void;
	setSessions: (agentId: string, sessions: SessionRecord[]) => void;
	setActiveSessionId: (sessionId: string | null) => void;
	editMessage: (sessionId: string, msgId: string, newText: string) => void;
	deleteMessage: (sessionId: string, msgId: string) => void;
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
	messagesBySession: {},
	activeAgentId: null,
	activeSessionId: null,
	streamingSessionId: null,
	messages: [],
	isStreaming: false,
	sessionsByAgent: {},

	addMessage: (sessionId, msg) =>
		set((state) => {
			const sessionMsgs = [...(state.messagesBySession[sessionId] ?? []), msg];
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			const newStreamingId = msg.role === "assistant" ? sessionId : state.streamingSessionId;
			return {
				messagesBySession: newBySession,
				streamingSessionId: newStreamingId,
				messages: isActive ? sessionMsgs : state.messages,
				isStreaming: newStreamingId !== null && newStreamingId === state.activeSessionId,
			};
		}),

	updateAssistantText: (sessionId, text) =>
		set((state) => {
			const sessionMsgs = updateLastAssistantMsg(state.messagesBySession[sessionId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				const lastBlock = blocks[blocks.length - 1];
				if (lastBlock && lastBlock.type === "text") {
					blocks[blocks.length - 1] = { type: "text", text };
				} else {
					blocks.push({ type: "text", text });
				}
				return { ...msg, blocks, streaming: true };
			});
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? sessionMsgs : state.messages,
			};
		}),

	updateThinking: (sessionId, text) =>
		set((state) => {
			const sessionMsgs = updateLastAssistantMsg(state.messagesBySession[sessionId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				const lastBlock = blocks[blocks.length - 1];
				if (lastBlock && lastBlock.type === "thinking") {
					blocks[blocks.length - 1] = { type: "thinking", text };
				} else {
					blocks.push({ type: "thinking", text });
				}
				return { ...msg, blocks, streaming: true };
			});
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? sessionMsgs : state.messages,
			};
		}),

	addToolCall: (sessionId, name, args?) =>
		set((state) => {
			const sessionMsgs = updateLastAssistantMsg(state.messagesBySession[sessionId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				blocks.push({ type: "tool", name, status: "running", args });
				return { ...msg, blocks, streaming: true };
			});
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? sessionMsgs : state.messages,
			};
		}),

	updateToolCall: (sessionId, name, status, result?) =>
		set((state) => {
			const sessionMsgs = updateLastAssistantMsg(state.messagesBySession[sessionId] ?? [], (msg) => {
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
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? sessionMsgs : state.messages,
			};
		}),

	setIsStreaming: (sessionId, v) =>
		set((state) => {
			const newStreamingId = v ? sessionId : (state.streamingSessionId === sessionId ? null : state.streamingSessionId);
			return {
				streamingSessionId: newStreamingId,
				isStreaming: newStreamingId !== null && newStreamingId === state.activeSessionId,
			};
		}),

	finishStreaming: (sessionId) =>
		set((state) => {
			const sessionMsgs = (state.messagesBySession[sessionId] ?? []).map((m) =>
				m.streaming ? { ...m, streaming: false } : m,
			);
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			const newStreamingId = state.streamingSessionId === sessionId ? null : state.streamingSessionId;
			return {
				messagesBySession: newBySession,
				streamingSessionId: newStreamingId,
				messages: isActive ? sessionMsgs : state.messages,
				isStreaming: newStreamingId !== null && newStreamingId === state.activeSessionId,
			};
		}),

	setActiveAgent: (id, sessionId?) =>
		set((state) => {
			const newBySession = { ...state.messagesBySession };
			if (state.activeSessionId && state.activeAgentId && state.activeAgentId !== id) {
				// Save current messages for old session
				newBySession[state.activeSessionId] = state.messages;
			}
			const newActiveSessionId = sessionId ?? null;
			const newMessages = newActiveSessionId ? (newBySession[newActiveSessionId] ?? []) : [];
			return {
				activeAgentId: id,
				activeSessionId: newActiveSessionId,
				messagesBySession: newBySession,
				messages: newMessages,
				isStreaming: state.streamingSessionId !== null && state.streamingSessionId === newActiveSessionId,
			};
		}),

	loadMessages: (sessionId, msgs) =>
		set((state) => {
			const newBySession = { ...state.messagesBySession, [sessionId]: msgs };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? msgs : state.messages,
			};
		}),

	clearMessages: (sessionId) =>
		set((state) => {
			const newBySession = { ...state.messagesBySession, [sessionId]: [] };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? [] : state.messages,
			};
		}),

	setSessions: (agentId, sessions) =>
		set((state) => ({
			sessionsByAgent: { ...state.sessionsByAgent, [agentId]: sessions },
		})),

	setActiveSessionId: (sessionId) =>
		set((state) => {
			const newMessages = sessionId ? (state.messagesBySession[sessionId] ?? []) : [];
			return {
				activeSessionId: sessionId,
				messages: newMessages,
				isStreaming: state.streamingSessionId !== null && state.streamingSessionId === sessionId,
			};
		}),

	editMessage: (sessionId, msgId, newText) =>
		set((state) => {
			const sessionMsgs = (state.messagesBySession[sessionId] ?? []).map((m) =>
				m.id === msgId
					? { ...m, text: newText, blocks: [{ type: "text" as const, text: newText }] }
					: m,
			);
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? sessionMsgs : state.messages,
			};
		}),

	deleteMessage: (sessionId, msgId) =>
		set((state) => {
			const sessionMsgs = (state.messagesBySession[sessionId] ?? []).filter((m) => m.id !== msgId);
			const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? sessionMsgs : state.messages,
			};
		}),
}));
