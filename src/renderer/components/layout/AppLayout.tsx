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
import React, { useState, useRef, useEffect } from "react";
import IconSidebar from "./IconSidebar.js";
import ChatPanel from "./ChatPanel.js";
import FileTreePanel from "./FileTreePanel.js";
import DocViewerPanel from "./DocViewerPanel.js";
import ResizableLayout from "./ResizableLayout.js";
import AgentsPage from "../agents/AgentsPage.js";
import SettingsPage from "../settings/SettingsPage.js";
import McpSettingsPage from "../mcp/McpSettingsPage.js";
import KnowledgeBasePage from "../kb/KnowledgeBasePage.js";
import ToolsPage from "../tools/ToolsPage.js";
import DashboardPage from "../dashboard/DashboardPage.js";
import LogViewer from "../common/LogViewer.js";
import { usePageStore } from "../../store/page-store.js";
import { useInteractionStore } from "../../store/interaction-store.js";
import { useChatStore } from "../../store/chat-store.js";

const api = () => (window as any).api;

export default function AppLayout() {
	const { activePage } = usePageStore();
	const [showLog, setShowLog] = useState(false);
	const lastErrorKey = useRef<string | null>(null);

	const {
		activeAgentId, activeSessionId,
		addMessage, updateAssistantText, updateThinking, addToolCall, updateToolCall,
		finishStreaming, initSession, updateSessionLifecycle, setError,
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
			session_init: (d, key) => initSession(d.sessionId || key, { messages: d.messages || [] }),
			text_delta: (d, key) => updateAssistantText(key, d.text),
			message_end: () => { /* text_delta already handled streaming text */ },
			thinking_delta: (d, key) => updateThinking(key, d.text),
			tool_start: (d, key) => addToolCall(key, d.toolName, d.args ? stringify(d.args) : undefined),
			tool_end: (d, key) => updateToolCall(key, d.toolName, d.isError ? "error" : "done", d.result ? stringify(d.result) : undefined),
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
					{activePage === "settings" && <SettingsPage />}
					{activePage === "mcp" && <McpSettingsPage />}
					{activePage === "tools" && <ToolsPage />}
					{activePage === "knowledge" && <KnowledgeBasePage />}
					{activePage === "agents" && <AgentsPage />}
				</div>
			)}

			{/* Log toggle button */}
			<button
				type="button"
				className="log-toggle-btn"
				onClick={() => setShowLog(!showLog)}
				title="Toggle Log Panel"
			>
				{showLog ? "×" : "⟁"}
			</button>

			{/* Log panel */}
			{showLog && (
				<div className="log-panel">
					<LogViewer />
				</div>
			)}
		</div>
	);
}
