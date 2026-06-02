import { create } from "zustand";
import type { SessionRecord } from "../../shared/types.js";

type SessionLifecycleState = "created" | "idle" | "queued" | "streaming" | "executing_tools" | "error" | "disposed";

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
	streamingSessions: Set<string>;
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
	updateSessionLifecycle: (sessionId: string, state: SessionLifecycleState) => void;
	setActiveAgent: (id: string | null, sessionId?: string | null) => void;
	loadMessages: (sessionId: string, messages: ChatMessage[]) => void;
	initSession: (sessionId: string, payload: { messages: ChatMessage[]; activeAgentId?: string | null }) => void;
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

function calcIsStreaming(streamingSessions: Set<string>, activeSessionId: string | null): boolean {
	return activeSessionId !== null && streamingSessions.has(activeSessionId);
}

export const useChatStore = create<ChatState>((set) => ({
	messagesBySession: {},
	activeAgentId: null,
	activeSessionId: null,
	streamingSessions: new Set(),
	messages: [],
	isStreaming: false,
	sessionsByAgent: {},

		addMessage: (sessionId, msg) =>
			set((state) => {
				const sessionMsgs = [...(state.messagesBySession[sessionId] ?? []), msg];
				const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
				const isActive = sessionId === state.activeSessionId;
				return {
					messagesBySession: newBySession,
					messages: isActive ? sessionMsgs : state.messages,
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
			const newStreaming = new Set(state.streamingSessions);
			if (v) newStreaming.add(sessionId);
			else newStreaming.delete(sessionId);
			return {
				streamingSessions: newStreaming,
				isStreaming: calcIsStreaming(newStreaming, state.activeSessionId),
			};
		}),

		finishStreaming: (sessionId) =>
			set((state) => {
				const sessionMsgs = (state.messagesBySession[sessionId] ?? []).map((m) =>
					m.streaming ? { ...m, streaming: false } : m,
				);
				const newBySession = { ...state.messagesBySession, [sessionId]: sessionMsgs };
				const isActive = sessionId === state.activeSessionId;
				return {
					messagesBySession: newBySession,
					messages: isActive ? sessionMsgs : state.messages,
				};
			}),

		updateSessionLifecycle: (sessionId, lifecycleState) =>
			set((s) => {
				const newStreaming = new Set(s.streamingSessions);
				const active = lifecycleState === "streaming" || lifecycleState === "executing_tools" || lifecycleState === "queued";
				if (active) newStreaming.add(sessionId);
				else newStreaming.delete(sessionId);
				return {
					streamingSessions: newStreaming,
					isStreaming: calcIsStreaming(newStreaming, s.activeSessionId),
				};
			}),

	setActiveAgent: (id, sessionId?) =>
		set((state) => {
			const newBySession = { ...state.messagesBySession };
			if (state.activeSessionId && state.activeAgentId && state.activeAgentId !== id) {
				newBySession[state.activeSessionId] = state.messages;
			}
			const newActiveSessionId = sessionId ?? null;
			const newMessages = newActiveSessionId ? (newBySession[newActiveSessionId] ?? []) : [];
			return {
				activeAgentId: id,
				activeSessionId: newActiveSessionId,
				messagesBySession: newBySession,
				messages: newMessages,
				isStreaming: calcIsStreaming(state.streamingSessions, newActiveSessionId),
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

	initSession: (sessionId, payload) =>
		set((state) => {
			const newStreaming = new Set(state.streamingSessions);
			const hasStreaming = payload.messages.some((m) => m.streaming);
			if (hasStreaming) newStreaming.add(sessionId);
			else newStreaming.delete(sessionId);

			const newBySession = { ...state.messagesBySession, [sessionId]: payload.messages };
			const isActive = sessionId === state.activeSessionId;
			return {
				messagesBySession: newBySession,
				messages: isActive ? payload.messages : state.messages,
				streamingSessions: newStreaming,
				isStreaming: calcIsStreaming(newStreaming, isActive ? sessionId : state.activeSessionId),
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
				isStreaming: calcIsStreaming(state.streamingSessions, sessionId),
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
