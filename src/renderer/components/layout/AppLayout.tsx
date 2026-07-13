// 应用主布局
//
// # 文件说明书
//
// ## 核心功能
// 应用主布局组件，管理页面切换和面板布局。
//
// ## 输入
// - 页面状态
// - 聊天状态
//
// ## 输出
// - 渲染的布局
// - 页面内容
//
// ## 定位
// 渲染进程主布局，被 App.tsx 使用。
//
// ## 依赖
// - react - React 框架
// - ../../store - 状态管理
//
// ## 维护规则
// - 新增页面时需更新
// - 保持布局响应性
//
import React, { useRef, useEffect } from "react";
import TitleBar from "./TitleBar.js";
import IconSidebar from "./IconSidebar.js";
import ChatPanel from "./ChatPanel.js";
import FileTreePanel from "./FileTreePanel.js";
import MiddlePanel from "./MiddlePanel.js";
import DocViewerPanel from "./DocViewerPanel.js";
import ResizableLayout from "./ResizableLayout.js";
import AgentsPage from "../agents/AgentsPage.js";
import CronDashboard from "../cron/CronDashboard.js";
import SettingsPage from "../settings/SettingsPage.js";
import McpSettingsPage from "../mcp/McpSettingsPage.js";
import SkillsPage from "../skills/SkillsPage.js";
import ToolsPage from "../tools/ToolsPage.js";
import DashboardPage from "../dashboard/DashboardPage.js";
// v0.8 (P5 §8.5): KanbanPage replaced by ProjectPage (project list + 3 tabs:
// dashboard+activity / project view / kanban). The kanban lives on as a tab.
import ProjectPage from "../requirements/ProjectPage.js";
import WikiPage from "../wiki/WikiPage.js";

import { usePageStore } from "../../store/page-store.js";
import { terminalTargetSession } from "../../store/event-attribution.js";
import { useInteractionStore } from "../../store/interaction-store.js";
import { useChatStore, nextMsgId } from "../../store/chat-store.js";
import { useNotificationStore } from "../../store/notification-store.js";
import { useRequirementStore } from "../../store/requirement-store.js";
import NotificationToast from "../common/NotificationToast.js";

const api = () => (window as any).api;

export default function AppLayout() {
	const { activePage } = usePageStore();
	const lastErrorKey = useRef<string | null>(null);

	const {
		addMessage, updateAssistantText, updateThinking, addToolCall, updateToolCall,
		finishStreaming, initSession, updateSessionLifecycle, setError, updateContextInfo,
	} = useChatStore();

	// Track app readiness
	useEffect(() => {
		const t0 = Date.now();
		console.log(`[renderer] App mounted (+0ms)`);

		const unsub = api().onAppReady(() => {
			console.log(`[renderer] IPC ready (+${Date.now() - t0}ms)`);
		});

		return unsub;
	}, []);

	// ─── N2 reconnect resync ─────────────────────────────────────────
	// The main↔backend WS auto-reconnects on drop, but the renderer can't see
	// it. ipc-proxy sends `ws:reconnected` AFTER a close→reconnect (never on the
	// first connect — that goes through app:ready). On that signal we re-pull the
	// currently-visible collections: every push-driven store does pull-on-display,
	// so re-triggering the same pulls recovers anything missed during the drop.
	// We read live state inside the handler (not from deps) so this effect mounts
	// once and always acts on the CURRENT page/session.
	useEffect(() => {
		const unsub = api().onWsReconnected?.(() => {
			console.log("[renderer] ws reconnected — re-pulling visible collections");
			const chat = useChatStore.getState();
			const sid = chat.activeSessionId;
			// Active chat session: re-pull its init baseline (messages/todos/pending).
			if (sid) {
				void api().sessionsGetInit(sid).then((payload: any) => {
					if (!payload) return;
					if (useChatStore.getState().activeSessionId !== sid) return;
					initSession(sid, { messages: payload.messages ?? [], isRunning: !!payload.isRunning });
					if (payload.contextWindow) {
						updateContextInfo(sid, {
							usedTokens: payload.inputTokens ?? 0,
							contextWindow: payload.contextWindow,
							usage: payload.contextUsage ?? 0,
							inputTokens: payload.inputTokens ?? 0,
							outputTokens: payload.outputTokens ?? 0,
							totalTokens: payload.totalTokens ?? 0,
							model: payload.model,
						});
					}
				}).catch(() => { /* ignore — next ping/nav refetches */ });
			}
			// Task tree + input queue for the active session (re-trigger pull; the
			// stores are push-driven and filter by their watched set, so this is
			// safe even if the session isn't watched — pull is a no-op guard).
			void import("../../store/task-store.js").then(({ useTaskStore }) => {
				const ts = useTaskStore.getState();
				if (sid && ts.watched.has(sid)) void ts.pull(sid);
			}).catch(() => {});
			void import("../../store/input-queue-store.js").then(({ useInputQueueStore }) => {
				const qs = useInputQueueStore.getState();
				if (sid && qs.watched.has(sid)) void qs.pull(sid);
			}).catch(() => {});
			// Config stores (subscribed, but a refetch recovers any missed patch).
			void import("../../store/agent-store.js").then(({ useAgentStore }) => useAgentStore.getState().fetchAgents()).catch(() => {});
			void import("../../store/requirement-store.js").then(({ useRequirementStore }) => useRequirementStore.getState().fetchRequirements()).catch(() => {});
			void import("../../store/project-store.js").then(({ useProjectStore }) => useProjectStore.getState().fetchProjects()).catch(() => {});
			void import("../../store/cron-store.js").then(({ useCronStore }) => useCronStore.getState().fetchCrons?.()).catch(() => {});
			// Page-scoped runtime pings: only refresh the page currently visible.
			const page = usePageStore.getState().activePage;
			if (page === "dashboard") {
				void api().sessionsMetrics?.().then((m: any) => { /* DashboardPage holds its own state; the next ping or remount refetches */ }).catch(() => {});
			}
			if (page === "mcp") {
				void api().mcpStatus?.().then(() => {}).catch(() => {});
			}
		});
		return () => { if (typeof unsub === "function") unsub(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ─── Session lifecycle events ──────────────────────────────────
	useEffect(() => {
		const unsub = api().onSessionLifecycle((data: any) => {
			updateSessionLifecycle(data.sessionId, data.to);
		});
		return unsub;
	}, []);

	// ─── Central IPC event subscription (never unmounts) ──────────
	// This stays alive regardless of which page the user is on.
	useEffect(() => {
		const stringify = (v: unknown) =>
			typeof v === "string" ? v : JSON.stringify(v, null, 2);

		const handlers: Record<string, (data: any, key: string) => void> = {
			session_init: (d, key) => {
					const sid = d.sessionId || key;
					// pull-on-display 后 session_init 的 push 只作 fallback:本 session
					// 已经有消息(ChatPanel pull 或 live 事件填的)就别再用 push 覆盖,
					// 否则可能与正在流式的 live 内容竞态、回退。store 为空(pull 还没
					// 回或失败)时才用 push 兜底加载。
					const state = useChatStore.getState();
					const hasMsgs = (state.messagesBySession[sid]?.length ?? 0) > 0;
					if (hasMsgs) return;
					// Sync running state from the authoritative backend isRunning
					// (carried in the session_init payload) — see chat-store.initSession.
					initSession(sid, { messages: d.messages || [], isRunning: !!d.isRunning });
						// Restore context window and token usage from backend
						updateContextInfo(d.sessionId || key, {
							usedTokens: d.inputTokens ?? 0,
							contextWindow: d.contextWindow ?? 128000,
							usage: d.contextUsage ?? 0,
							inputTokens: d.inputTokens ?? 0,
							outputTokens: d.outputTokens ?? 0,
							totalTokens: d.totalTokens ?? 0,
						});
				},
			text_delta: (d, key) => updateAssistantText(key, d.text),
			message_end: (d, key) => {
				if (!d.contextWindow) return;
				const prev = useChatStore.getState().contextInfoBySession[key];
				// MessageEndEvent does NOT carry a `usage` field (see
				// runtime/types.ts). The previous code read `d.usage.inputTokens`
				// here, which threw "Cannot read properties of undefined
				// (reading 'inputTokens')" and crashed the React tree on every
				// turn. Use the prior usage record's inputTokens if available,
				// else fall back to the estimator. The authoritative usage
				// update arrives via the separate "usage" event below.
				const prevInput = prev?.inputTokens ?? 0;
				updateContextInfo(key, {
					usedTokens: prevInput || d.estimatedTokens || 0,
					contextWindow: d.contextWindow,
					usage: prev ? prevInput / prev.contextWindow : 0,
					inputTokens: prevInput,
					outputTokens: prev?.outputTokens ?? 0,
					totalTokens: prev?.totalTokens ?? 0,
				});
			},
			usage: (d, key) => {
				const prev = useChatStore.getState().contextInfoBySession[key];
				updateContextInfo(key, {
					usedTokens: d.usage.inputTokens ?? prev?.usedTokens ?? 0,
					contextWindow: prev?.contextWindow ?? 128000,
					usage: prev ? d.usage.inputTokens / prev.contextWindow : 0,
					inputTokens: d.usage.inputTokens ?? 0,
					outputTokens: d.usage.outputTokens ?? 0,
					totalTokens: d.usage.totalTokens ?? 0,
				});
			},
			thinking_delta: (d, key) => updateThinking(key, d.text),
			tool_start: (d, key) => addToolCall(key, d.toolName, d.args ? stringify(d.args) : undefined, d.toolCallId),
			tool_end: (d, key) => updateToolCall(key, d.toolName, d.isError ? "error" : "done", d.result ? stringify(d.result) : undefined, d.toolCallId),
			// Terminal events (agent_end / error) only clear streaming for the
			// session they EXPLICITLY name. A terminal event without sessionId
			// (e.g. a legacy/raw emit, or a future regression) must NOT fall back
			// to the active session — otherwise a background run ending/erroring
			// would flip the viewed session's Stop button to Send mid-run.
			agent_end: (d, _key) => {
				const sid = terminalTargetSession(d, useChatStore.getState().activeSessionId);
				if (sid) finishStreaming(sid);
			},
			// sub-5 (Wait): a Wait tool suspended mid-run. The session is NOT
			// running anymore (loop released busy) — flip the button back to Send
			// so the user can type. The wake (user input / task finish / timeout)
			// re-emits session_running → setIsStreaming(true) to resume the Stop
			// state. Same target-session semantics as agent_end.
			session_waiting: (d, _key) => {
				const sid = terminalTargetSession(d, useChatStore.getState().activeSessionId);
				if (sid) finishStreaming(sid);
			},
			// Authoritative "turn started" signal from the server (agent-service
			// markRunning). The streaming flag follows the server's isBusy, not an
			// optimistic UI flag — so chat / cron / work-trigger / recovery all flip
			// the button to Stop uniformly. Global (not in PER_SESSION_PUSH) so a
			// background session's running state is tracked even when not active.
			session_running: (d) => {
				// Global (background sessions too). Requires explicit sessionId —
				// never fall back to the active session.
				if (d.sessionId) useChatStore.getState().setIsStreaming(d.sessionId, true);
			},
			queued_turn_started: (d, key) => {
				// C2 drain: a queued input is starting a real turn server-side.
				// Mirror the manual send path (ChatPanel.send) — insert the user
				// message + an empty streaming assistant placeholder so this turn
				// streams into its OWN bubble. Without the placeholder the drained
				// assistant output merges into the previous turn's bubble
				// (updateLastAssistantMsg reuses the last assistant), and the user
				// message never appears live (only after pull / restart).
				addMessage(key, { id: nextMsgId(), role: "user", text: d.text ?? "", timestamp: Date.now() });
				addMessage(key, { id: nextMsgId(), role: "assistant", text: "", timestamp: Date.now(), streaming: true, blocks: [] });
			},
			retry_attempt: (d, key) => updateAssistantText(key, `Retrying (${d.attempt}/${d.maxAttempts})...`),
			todos_update: (d) => {
				// 按 sessionId 路由(同 agent 多 session 不串显)。
				if (!d.sessionId) return;
				useInteractionStore.getState().setTodos(d.sessionId, d.todos);
			},
			ask_user: (d) => {
				// AskUser tool emitted a question — 按 sessionId 路由成 pending 卡片,
				// ChatPanel 渲染 <AskUserCard>。工具在 pendingResponses 上阻塞到用户
				// 经卡片(askUserRespond IPC)回复。非 active session 的事件在下方
				// dispatcher 统一丢弃,切到该 session 时由 pull 拉回。
				if (!d.sessionId) return;
				useInteractionStore.getState().setPending(d.sessionId, {
					requestId: d.requestId,
					agentId: d.agentId,
					questions: d.questions,
				});
			},
			error: (d, _key) => {
				const sid = terminalTargetSession(d, useChatStore.getState().activeSessionId);
				if (!sid) return; // can't safely attribute — don't clobber the viewed session
				setError(sid, d.error);
				lastErrorKey.current = sid;
				updateAssistantText(sid, `\nError: ${d.error}`);
				finishStreaming(sid);
			},
			requirement_notification: (d) => {
				useNotificationStore.getState().addNotification({
					type: d.type || "requirement",
					priority: d.priority || "info",
					title: d.title || "Requirement Update",
					message: d.message || "",
					actionUrl: d.actionUrl,
				});
				useRequirementStore.getState().fetchRequirements();
			},
			step_failure: (d) => {
				useNotificationStore.getState().addNotification({
					type: "step_failure",
					priority: "warning",
					title: d.title || "Step Failed",
					message: d.message || d.error || "A step has failed",
					actionUrl: d.actionUrl,
				});
			},
			verification_failure: (d) => {
				useNotificationStore.getState().addNotification({
					type: "verification_failure",
					priority: "critical",
					title: d.title || "Verification Failed",
					message: d.message || d.error || "Verification check failed",
					actionUrl: d.actionUrl,
				});
			},
		};

		// Session attribution is STRICT: an event targets ONLY its explicit
		// sessionId, never a fallback to activeSessionId/agentId. The old
		// `data.sessionId || activeSessionId || data.agentId` fallback was the
		// cross-session bleed bug — an event from a background run that lacked
		// sessionId landed on whatever session the user was viewing.
		//
		// Two classes:
		//  - INCREMENTAL CONTENT (text_delta / tool_* / todos_update / ask_user /
		//    session_init / usage / retry_attempt): only applied to the ACTIVE
		//    session; switch away = stop pushing. Baseline is re-fetched by
		//    ChatPanel's pull-on-display when switching back.
		//  - TERMINAL / STATE (agent_end / error / session_running): GLOBAL —
		//    they manage streamingSessions, which must track EVERY session so a
		//    background session's stop/error is reflected when the user later
		//    views it. These carry sessionId and are scoped via
		//    terminalTargetSession (agent_end/error) or an explicit guard
		//    (session_running), never by the active session.
		const PER_SESSION_PUSH = new Set([
			"text_delta", "thinking_delta", "tool_start", "tool_end",
			"message_end", "usage", "retry_attempt",
			"session_init", "todos_update", "ask_user", "queued_turn_started",
		]);

		const unsubscribe = api().onAgentEvent((data: any) => {
			if (!data.agentId) return;
			const activeSessionId = useChatStore.getState().activeSessionId;
			// Strict sessionId attribution — no fallback. null = unattributable.
			const sid = typeof data.sessionId === "string" && data.sessionId ? data.sessionId : null;
			// disconnect-on-leave: incremental content only for the active session.
			if (PER_SESSION_PUSH.has(data.type)) {
				if (!sid || sid !== activeSessionId) return;
			}
			const handler = handlers[data.type];
			if (handler) handler(data, sid);
		});

		return unsubscribe;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="app-layout">
			<TitleBar />
			<div className="app-body">
				<IconSidebar />
				<div className={"page-chat" + (activePage === "chat" ? " page-active" : "")}>
					<ResizableLayout
						defaults={[4, 2, 4]}
						mins={[280, 160, 200]}
					>
						<ChatPanel />
						<MiddlePanel />
						<DocViewerPanel />
					</ResizableLayout>
				</div>
				{activePage !== "chat" && (
					<div className="page-overlay">
						{activePage === "dashboard" && <DashboardPage />}
						{activePage === "cron" && <CronDashboard />}
						{activePage === "settings" && <SettingsPage />}
						{activePage === "mcp" && <McpSettingsPage />}
						{activePage === "skills" && <SkillsPage />}
						{activePage === "tools" && <ToolsPage />}
						{activePage === "agents" && <AgentsPage />}
						{activePage === "requirements" && <ProjectPage />}
						{activePage === "wiki" && <WikiPage />}
					</div>
				)}
			</div>
			<NotificationToast />
		</div>
	);
}
