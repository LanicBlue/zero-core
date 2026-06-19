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
import DocViewerPanel from "./DocViewerPanel.js";
import ResizableLayout from "./ResizableLayout.js";
import AgentsPage from "../agents/AgentsPage.js";
import CronDashboard from "../cron/CronDashboard.js";
import SettingsPage from "../settings/SettingsPage.js";
import McpSettingsPage from "../mcp/McpSettingsPage.js";
import SkillsPage from "../skills/SkillsPage.js";
import KnowledgeBasePage from "../kb/KnowledgeBasePage.js";
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
		activeAgentId, activeSessionId,
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
					// Don't overwrite a session that is actively streaming.
					// Real-time events have already been keeping the store up to date.
					const state = useChatStore.getState();
					if (state.streamingSessions.has(sid)) return;
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
				updateContextInfo(key, {
					usedTokens: prev?.inputTokens ?? d.estimatedTokens ?? 0,
					contextWindow: d.contextWindow,
					usage: prev ? d.usage.inputTokens / prev.contextWindow : 0,
					inputTokens: prev?.inputTokens ?? 0,
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
			retry_attempt: (d, key) => updateAssistantText(key, `Retrying (${d.attempt}/${d.maxAttempts})...`),
			todos_update: (d) => {
				useInteractionStore.getState().setTodos(d.agentId, d.todos);
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

		const unsubscribe = api().onAgentEvent((data: any) => {
			if (!data.agentId) return;
			const currentSessionId = useChatStore.getState().activeSessionId;
			const key = data.sessionId || currentSessionId || data.agentId;
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
						<FileTreePanel />
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
						{activePage === "knowledge" && <KnowledgeBasePage />}
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
