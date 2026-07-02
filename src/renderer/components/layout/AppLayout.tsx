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
import { useInteractionStore } from "../../store/interaction-store.js";
import { useChatStore } from "../../store/chat-store.js";
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
					initSession(sid, { messages: d.messages || [] });
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
			agent_end: (_d, key) => finishStreaming(key),
			// Authoritative "turn started" signal from the server (agent-service
			// markRunning). The streaming flag follows the server's isBusy, not an
			// optimistic UI flag — so chat / cron / work-trigger / recovery all flip
			// the button to Stop uniformly. Global (not in PER_SESSION_PUSH) so a
			// background session's running state is tracked even when not active.
			session_running: (_d, key) => useChatStore.getState().setIsStreaming(key, true),
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
			error: (d, key) => {
				setError(key, d.error);
				lastErrorKey.current = key;
				updateAssistantText(key, `\nError: ${d.error}`);
				finishStreaming(key);
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

		// per-session push 事件:只对 active session 应用,切走即"断 push"。
		// 这些事件都带 sessionId;text_delta/tool_*/todos_update/ask_user 等若来自
		// 别的 session 一律丢弃 —— 切回时由 ChatPanel 的 pull(sessionsGetInit)拉基线。
		// 没带 sessionId 的事件(理论残留)按 key fallback 落到 active。
		// 注意:`agent_end` 是**终态事件**(只清 streaming 状态),必须全局生效 ——
		// 否则后台 session 报错停止时 agent_end 被丢 → streamingSessions 卡住 →
		// 切回该 session 时 Send 一直禁用,"无法继续"。terminal state ≠ 增量内容。
		const PER_SESSION_PUSH = new Set([
			"text_delta", "thinking_delta", "tool_start", "tool_end",
			"message_end", "usage", "retry_attempt", "error",
			"session_init", "todos_update", "ask_user",
		]);

		const unsubscribe = api().onAgentEvent((data: any) => {
			if (!data.agentId) return;
			const activeSessionId = useChatStore.getState().activeSessionId;
			// disconnect-on-leave:带 sessionId 且不是当前 active session → 丢弃。
			if (PER_SESSION_PUSH.has(data.type) && data.sessionId && data.sessionId !== activeSessionId) {
				return;
			}
			const key = data.sessionId || activeSessionId || data.agentId;
			const handler = handlers[data.type];
			if (handler) handler(data, key);
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
