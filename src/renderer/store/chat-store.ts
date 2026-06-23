// 聊天状态管理
//
// # 文件说明书
//
// ## 核心功能
// 聊天相关的 Zustand 状态管理，包括消息、会话和流式状态。
//
// ## 输入
// - IPC 事件（session_init, text_delta, tool_start 等）
//
// ## 输出
// - 状态选择器
// - 状态更新函数
//
// ## 定位
// 渲染进程状态管理，被聊天组件使用。
//
// ## 依赖
// - zustand - 状态管理
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 新增状态字段时需更新类型
// - 保持状态更新幂等性
//
import { create } from "zustand";
import type { SessionRecord } from "../../shared/types.js";

type SessionLifecycleState = "created" | "idle" | "queued" | "streaming" | "executing_tools" | "error" | "disposed";

export interface ToolCallBlock {
	type: "tool";
	name: string;
	toolCallId?: string;
	status: "running" | "done" | "error";
	args?: string;
	result?: string;
	startedAt?: number;
	completedAt?: number;
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

export interface ContextInfo {
	usedTokens: number;
	contextWindow: number;
	usage: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

interface ChatState {
	messagesBySession: Record<string, ChatMessage[]>;
	activeAgentId: string | null;
	activeSessionId: string | null;
	streamingSessions: Set<string>;
	sessionsByAgent: Record<string, SessionRecord[]>;
	lastError: { sessionId: string; message: string } | null;
	contextInfoBySession: Record<string, ContextInfo>;

	addMessage: (sessionId: string, msg: ChatMessage) => void;
	updateAssistantText: (sessionId: string, text: string) => void;
	updateThinking: (sessionId: string, text: string) => void;
	addToolCall: (sessionId: string, name: string, args?: string, toolCallId?: string) => void;
	updateToolCall: (sessionId: string, name: string, status: "done" | "error", result?: string, toolCallId?: string) => void;
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
	setError: (sessionId: string, message: string) => void;
	clearError: () => void;
	updateContextInfo: (sessionId: string, info: ContextInfo) => void;
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

// ---------------------------------------------------------------------------
// Selectors — derived state, single source of truth lives in messagesBySession
// and streamingSessions. Consumers should use these instead of reading a
// duplicated `messages` / `isStreaming` field.
//
// IMPORTANT: selectors must return a stable reference for equal inputs —
// `?? []` would create a new array on every call and cause React to loop.
// ---------------------------------------------------------------------------

const EMPTY_MESSAGES: ChatMessage[] = [];

export const selectActiveMessages = (s: ChatState): ChatMessage[] =>
	s.activeSessionId ? (s.messagesBySession[s.activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;

export const selectIsStreaming = (s: ChatState): boolean =>
	s.activeSessionId !== null && s.streamingSessions.has(s.activeSessionId);

export const selectContextInfo = (s: ChatState): ContextInfo | null =>
	s.activeSessionId ? (s.contextInfoBySession[s.activeSessionId] ?? null) : null;

export const selectLastError = (s: ChatState): ChatState["lastError"] =>
	s.lastError && s.lastError.sessionId === s.activeSessionId ? s.lastError : null;

export const useChatStore = create<ChatState>((set) => ({
	messagesBySession: {},
	activeAgentId: null,
	activeSessionId: null,
	streamingSessions: new Set(),
	sessionsByAgent: {},
	lastError: null,
	contextInfoBySession: {},

	addMessage: (sessionId, msg) =>
		set((state) => ({
			messagesBySession: {
				...state.messagesBySession,
				[sessionId]: [...(state.messagesBySession[sessionId] ?? []), msg],
			},
		})),

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
			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: sessionMsgs },
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
			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: sessionMsgs },
			};
		}),

	addToolCall: (sessionId, name, args?, toolCallId?) =>
		set((state) => {
			const sessionMsgs = updateLastAssistantMsg(state.messagesBySession[sessionId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				blocks.push({ type: "tool", name, toolCallId, status: "running", args, startedAt: Date.now() });
				return { ...msg, blocks, streaming: true };
			});
			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: sessionMsgs },
			};
		}),

	updateToolCall: (sessionId, name, status, result?, toolCallId?) =>
		set((state) => {
			const sessionMsgs = updateLastAssistantMsg(state.messagesBySession[sessionId] ?? [], (msg) => {
				const blocks = [...(msg.blocks ?? [])];
				for (let i = blocks.length - 1; i >= 0; i--) {
					if (blocks[i].type === "tool") {
						const tb = blocks[i] as ToolCallBlock;
						// Match by toolCallId if available, fall back to name
						const match = toolCallId
							? tb.toolCallId === toolCallId
							: (tb.name === name && tb.status === "running");
						if (match) {
							blocks[i] = { ...tb, status, result, completedAt: Date.now() };
							break;
						}
					}
				}
				return { ...msg, blocks, streaming: true };
			});
			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: sessionMsgs },
			};
		}),

	setIsStreaming: (sessionId, v) =>
		set((state) => {
			const newStreaming = new Set(state.streamingSessions);
			if (v) newStreaming.add(sessionId);
			else newStreaming.delete(sessionId);
			return { streamingSessions: newStreaming };
		}),

	finishStreaming: (sessionId) =>
		set((state) => {
			const sessionMsgs = (state.messagesBySession[sessionId] ?? []).map((m) =>
				m.streaming ? { ...m, streaming: false } : m,
			);
			const newStreaming = new Set(state.streamingSessions);
			newStreaming.delete(sessionId);
			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: sessionMsgs },
				streamingSessions: newStreaming,
			};
		}),

	updateSessionLifecycle: (sessionId, lifecycleState) =>
		set((s) => {
			const newStreaming = new Set(s.streamingSessions);
			const active = lifecycleState === "streaming" || lifecycleState === "executing_tools" || lifecycleState === "queued";
			if (active) newStreaming.add(sessionId);
			else newStreaming.delete(sessionId);
			return { streamingSessions: newStreaming };
		}),

	setActiveAgent: (_id, sessionId?) =>
		set(() => ({
			activeAgentId: _id,
			activeSessionId: sessionId ?? null,
		})),

	loadMessages: (sessionId, msgs) =>
		set((state) => ({
			messagesBySession: { ...state.messagesBySession, [sessionId]: msgs },
		})),

	initSession: (sessionId, payload) =>
		set((state) => {
			const newStreaming = new Set(state.streamingSessions);
			const hasStreaming = payload.messages.some((m) => m.streaming);
			if (hasStreaming) newStreaming.add(sessionId);
			else newStreaming.delete(sessionId);

			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: payload.messages },
				streamingSessions: newStreaming,
			};
		}),

	clearMessages: (sessionId) =>
		set((state) => ({
			messagesBySession: { ...state.messagesBySession, [sessionId]: [] },
		})),

	setSessions: (agentId, sessions) =>
		set((state) => ({
			sessionsByAgent: { ...state.sessionsByAgent, [agentId]: sessions },
		})),

	setActiveSessionId: (sessionId) =>
		set(() => ({ activeSessionId: sessionId })),

	editMessage: (sessionId, msgId, newText) =>
		set((state) => {
			const sessionMsgs = (state.messagesBySession[sessionId] ?? []).map((m) =>
				m.id === msgId
					? { ...m, text: newText, blocks: [{ type: "text" as const, text: newText }] }
					: m,
			);
			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: sessionMsgs },
			};
		}),

	deleteMessage: (sessionId, msgId) =>
		set((state) => {
			const sessionMsgs = (state.messagesBySession[sessionId] ?? []).filter((m) => m.id !== msgId);
			return {
				messagesBySession: { ...state.messagesBySession, [sessionId]: sessionMsgs },
			};
		}),

	setError: (sessionId, message) =>
		set(() => ({ lastError: { sessionId, message } })),

	updateContextInfo: (sessionId, info) =>
		set((state) => ({
			contextInfoBySession: { ...state.contextInfoBySession, [sessionId]: info },
		})),

	clearError: () =>
		set(() => ({ lastError: null })),
}));

// Test-only hook: expose the store so E2E tests (Playwright) can read message
// state directly — guarded by __ZC_TEST__ which the preload sets only when
// ZERO_CORE_TEST_FIXTURE is present (i.e. never in a normal production run).
if (typeof window !== "undefined" && (window as any).__ZC_TEST__) {
	(window as any).__chatStore = useChatStore;
}
