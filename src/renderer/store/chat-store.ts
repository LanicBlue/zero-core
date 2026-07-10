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
import type { SessionRecord, AttachmentMeta, SessionVolumeInfo } from "../../shared/types.js";

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
	/**
	 * multimodal-input sub-4: attachment META carried on a user message (from
	 * turns.attachments via buildStepLevelMessages). Only meta flows here
	 * (principle A) — the renderer fetches bytes via the attachment-serving
	 * endpoint (sub-5) when it needs to render a thumbnail. Undefined for
	 * assistant messages and legacy user messages with no attachments.
	 * Rendered by sub-5/6 (not this sub).
	 */
	attachments?: AttachmentMeta[];
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
	/** Current model backing the session (set on session pull; preserved across
	 * streaming events since those don't carry it). Undefined until first pull. */
	model?: { providerName: string; modelId: string };
	/**
	 * multimodal-input sub-6: raw (tri-state) image capability of the current
	 * model, for the context-usage modality badge. `true` = supports image,
	 * `false` = does not, `undefined` = unknown (manually-configured /
	 * OpenRouter-uncovered) → UI renders "模态未知". Set on session pull (sourced
	 * from sessionsGetInit payload.modelMultimodal); preserved across streaming
	 * token refreshes by the merge semantics of updateContextInfo.
	 */
	modelMultimodal?: boolean;
}

interface ChatState {
	messagesBySession: Record<string, ChatMessage[]>;
	/**
	 * User picked an agent via the dropdown but no session has landed yet.
	 * Drives `selectActiveAgentId` until `sessionsByAgent` contains the active
	 * session record. NOT cleared on session land — it stays as a fallback for
	 * the lookup gap (a session activated before its list was refreshed) and is
	 * overwritten on the next `selectAgent`. activeAgentId is NOT stored — it
	 * is derived (see selectActiveAgentId) so agent/session can never drift.
	 */
	pendingAgentId: string | null;
	activeSessionId: string | null;
	/**
	 * M5: 当前 chat 的项目语境。null = General(非项目单例);非空 = 该 project 的
	 * (agentId, projectId) session。切 agent 时重置为 null(落 General,防误输入),
	 * 跳转 project 时设为该 project → 激活对应 session。
	 */
	activeProjectId: string | null;
	streamingSessions: Set<string>;
	sessionsByAgent: Record<string, SessionRecord[]>;
	lastError: { sessionId: string; message: string } | null;
	contextInfoBySession: Record<string, ContextInfo>;
	/**
	 * steps-overhaul sub-9: per-session content volume (steps/turns/token size).
	 * Sourced from the `steps` table via sessionsGetInit pull-on-display. Stored
	 * SEPARATELY from ContextInfo (which streaming token events refresh) — volume
	 * is step-count-based and only needs refreshing when steps change, so it has
	 * its own map + setter (not merged by updateContextInfo). Keyed by sessionId.
	 */
	volumeBySession: Record<string, SessionVolumeInfo>;
	/**
	 * sessionId → 最近一次"内容型"增量事件(text_delta / tool 调用 / thinking)到达的时间。
	 * pull-on-display 防回归用:pull 响应回来时若本 session 在 pull 发出后被 live
	 * 事件更新过,说明 live tail 更新,不能拿旧快照整覆盖(会回退流式内容、丢正在
	 * 进行的一轮)。见 ChatPanel 的 pull effect 合并逻辑。
	 */
	lastEventAt: Record<string, number>;

	addMessage: (sessionId: string, msg: ChatMessage) => void;
	updateAssistantText: (sessionId: string, text: string) => void;
	updateThinking: (sessionId: string, text: string) => void;
	addToolCall: (sessionId: string, name: string, args?: string, toolCallId?: string) => void;
	updateToolCall: (sessionId: string, name: string, status: "done" | "error", result?: string, toolCallId?: string) => void;
	setIsStreaming: (sessionId: string, v: boolean) => void;
	finishStreaming: (sessionId: string) => void;
	updateSessionLifecycle: (sessionId: string, state: SessionLifecycleState) => void;
	/**
	 * User picked an agent (dropdown). Sets pendingAgentId + resets
	 * activeSessionId/activeProjectId so selectActiveAgentId reflects the
	 * choice immediately; the agent-load effect then lands a session for it.
	 * Programmatic jumps to a KNOWN session should NOT call this — they call
	 * setActiveSessionId(sid, agentId) directly to avoid the load effect
	 * landing General and clobbering the target.
	 */
	selectAgent: (agentId: string | null) => void;
	/** M5: 切换项目语境(null = 回到 General)。调用方负责随后激活对应 session。 */
	setActiveProject: (id: string | null) => void;
	loadMessages: (sessionId: string, messages: ChatMessage[]) => void;
	initSession: (sessionId: string, payload: { messages: ChatMessage[]; isRunning?: boolean }) => void;
	clearMessages: (sessionId: string) => void;
	setSessions: (agentId: string, sessions: SessionRecord[]) => void;
	/**
	 * Activate a session. The optional agentIdHint populates pendingAgentId so
	 * selectActiveAgentId resolves before the session record is loaded into
	 * sessionsByAgent (e.g. a work-trigger jump that hasn't refreshed the list).
	 * An undefined/null hint preserves the existing pendingAgentId.
	 */
	setActiveSessionId: (sessionId: string | null, agentIdHint?: string | null) => void;
	editMessage: (sessionId: string, msgId: string, newText: string) => void;
	deleteMessage: (sessionId: string, msgId: string) => void;
	setError: (sessionId: string, message: string) => void;
	clearError: () => void;
	updateContextInfo: (sessionId: string, info: Partial<ContextInfo>) => void;
	/** steps-overhaul sub-9: set the active session's content volume (from pull-on-display). */
	setSessionVolume: (sessionId: string, volume: SessionVolumeInfo) => void;
}

function updateLastAssistantMsg(
	msgs: ChatMessage[],
	updater: (msg: ChatMessage) => ChatMessage,
): ChatMessage[] {
	const result = [...msgs];
	// 有 assistant 消息 → 就地更新最后一条(chat send() 预建的 streaming 占位、
	// 或既有对话的尾部 assistant)。
	for (let i = result.length - 1; i >= 0; i--) {
		if (result[i].role === "assistant") {
			result[i] = updater(result[i]);
			return result;
		}
	}
	// 自愈:完全没有 assistant 消息(空 session / 仅 user 消息)→ 建一条 streaming
	// assistant。服务端触发的 run(cron/hook/work)没经 chat send() 预建占位,
	// text_delta/tool_start 来了找不到 assistant,旧逻辑 no-op 直接丢消息 ——
	// 这里保证"有 session 就一定能在 UI 看到消息",与触发路径解耦。
	const created: ChatMessage = {
		id: nextMsgId(),
		role: "assistant",
		text: "",
		timestamp: Date.now(),
		streaming: true,
		blocks: [],
	};
	result.push(updater(created));
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

/**
 * steps-overhaul sub-9: active session's content volume (steps/turns/token
 * size), sourced from the `steps` table via pull-on-display. Null until the
 * session's init payload has landed.
 */
export const selectActiveVolume = (s: ChatState): SessionVolumeInfo | null =>
	s.activeSessionId ? (s.volumeBySession[s.activeSessionId] ?? null) : null;

export const selectLastError = (s: ChatState): ChatState["lastError"] =>
	s.lastError && s.lastError.sessionId === s.activeSessionId ? s.lastError : null;

/**
 * Find a session record by id across all agent buckets. sessionsByAgent is the
 * only session store (no flat index), so this scans — fine at current scale
 * (few agents × tens of sessions). Returns undefined if not yet loaded.
 */
export function findSessionById(s: ChatState, sid: string | null | undefined): SessionRecord | undefined {
	if (!sid) return undefined;
	for (const list of Object.values(s.sessionsByAgent)) {
		const found = list.find((x) => x.id === sid);
		if (found) return found;
	}
	return undefined;
}

/**
 * Derived active agent id — the single source of truth is activeSessionId.
 * Resolves to the active session's agentId; falls back to pendingAgentId when
 * no session is active OR the session record isn't loaded yet (lookup gap on
 * a fresh jump). Returns a primitive so useChatStore(selectActiveAgentId) is
 * referentially stable.
 */
export const selectActiveAgentId = (s: ChatState): string | null =>
	s.activeSessionId
		? (findSessionById(s, s.activeSessionId)?.agentId ?? s.pendingAgentId)
		: s.pendingAgentId;

export const useChatStore = create<ChatState>((set) => ({
	messagesBySession: {},
	pendingAgentId: null,
	activeSessionId: null,
	activeProjectId: null,
	streamingSessions: new Set(),
	sessionsByAgent: {},
	lastError: null,
	contextInfoBySession: {},
		volumeBySession: {},
	lastEventAt: {},

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
				lastEventAt: { ...state.lastEventAt, [sessionId]: Date.now() },
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
				lastEventAt: { ...state.lastEventAt, [sessionId]: Date.now() },
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
				lastEventAt: { ...state.lastEventAt, [sessionId]: Date.now() },
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
				lastEventAt: { ...state.lastEventAt, [sessionId]: Date.now() },
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

	selectAgent: (agentId) =>
		// User picked an agent → record intent (pendingAgentId) and clear the
		// active session so selectActiveAgentId reflects the choice immediately
		// (otherwise the prior session's record would still win the derivation).
		// The agent-load effect (ChatPanel) then lands a session for this agent.
		// M5: reset activeProjectId too (→ General), preventing input into the
		// previous agent's project session.
		set(() => ({
			pendingAgentId: agentId,
			activeSessionId: null,
			activeProjectId: null,
		})),

	loadMessages: (sessionId, msgs) =>
		set((state) => ({
			messagesBySession: { ...state.messagesBySession, [sessionId]: msgs },
		})),

	initSession: (sessionId, payload) =>
		set((state) => {
			const newStreaming = new Set(state.streamingSessions);
			// Running state is the AUTHORITATIVE backend isRunning (carried in the
			// session_init payload), NOT per-message streaming flags. A session can
			// be running — between LLM steps, during tool execution, or just after
			// markRunning with no assistant message yet — with no message
			// mid-stream. Deriving from message.streaming wrongly cleared the Stop
			// button on initial display. Only sync when isRunning is explicitly
			// provided; otherwise leave the flag to the pull / live events.
			if (typeof payload.isRunning === "boolean") {
				if (payload.isRunning) newStreaming.add(sessionId);
				else newStreaming.delete(sessionId);
			}
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

	setActiveSessionId: (sessionId, agentIdHint?) =>
		set((s) => ({
			activeSessionId: sessionId,
			// Preserve a hint only when landing a session whose record isn't in
			// sessionsByAgent yet (work-trigger / discuss jump). Don't clobber an
			// existing pendingAgentId with null/undefined.
			pendingAgentId: agentIdHint ?? s.pendingAgentId,
		})),
	setActiveProject: (id) =>
		set(() => ({ activeProjectId: id })),

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
			// Merge (not replace): streaming events (message_end/usage) don't
			// carry `model`, so a replace would clobber the model set on session
			// pull. Merging preserves it across token refreshes.
			contextInfoBySession: { ...state.contextInfoBySession, [sessionId]: { ...state.contextInfoBySession[sessionId], ...info } },
		})),

	setSessionVolume: (sessionId, volume) =>
		set((state) => ({
			volumeBySession: { ...state.volumeBySession, [sessionId]: volume },
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
