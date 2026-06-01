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
		messages, activeAgentId, activeSessionId, isStreaming,
		addMessage, updateAssistantText, updateThinking, addToolCall, updateToolCall,
		finishStreaming, loadMessages, setSessions, setActiveSessionId,
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

	// ─── Central IPC event subscription (never unmounts) ──────────
	// This stays alive regardless of which page the user is on.
	useEffect(() => {
		const unsubscribe = api().onAgentEvent((data: any) => {
			const agentId = data.agentId;
			if (!agentId) return;

			const sessionId = data.sessionId;
			// Filter: only process events for the currently active session
			const currentSessionId = useChatStore.getState().activeSessionId;
			if (sessionId && currentSessionId && sessionId !== currentSessionId) {
				return;
			}

			// Use sessionId for store operations, fallback to agentId for legacy events
			const key = sessionId || currentSessionId || agentId;

			switch (data.type) {
				case "text_delta": {
					updateAssistantText(key, data.text);
					break;
				}
				case "message_end": {
					// text_delta already handled streaming text
					break;
				}
				case "thinking_delta": {
					updateThinking(key, data.text);
					break;
				}
				case "tool_start": {
					const args = data.args ? (typeof data.args === "string" ? data.args : JSON.stringify(data.args, null, 2)) : undefined;
					addToolCall(key, data.toolName, args);
					break;
				}
				case "tool_end": {
					const result = data.result ? (typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2)) : undefined;
					updateToolCall(key, data.toolName, data.isError ? "error" : "done", result);
					break;
				}
				case "agent_end": {
					finishStreaming(key);
					// Skip DB reload if an error was just shown — preserve error in UI
					if (lastErrorKey.current === key) {
						lastErrorKey.current = null;
						break;
					}
					// Reload from DB to get normalized blocks (thinking/tool/text)
					(async () => {
						try {
							const [sessions, msgs] = await Promise.all([
								api().sessionsList(agentId),
								api().messagesList(agentId),
							]);
							setSessions(agentId, sessions);
							const str = (v: any) => v == null ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2);
							const dbMsgs = msgs.map((m: any) => {
								const blocks: any[] = [];
								if (m.blocks && Array.isArray(m.blocks)) {
									for (const b of m.blocks) {
										if (b.type === "thinking") blocks.push({ type: "thinking", text: b.text });
										else if (b.type === "tool") blocks.push({ type: "tool", name: b.name, status: b.status || "done", args: str(b.args), result: str(b.result) });
										else if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
									}
								} else if (m.text) { blocks.push({ type: "text", text: m.text }); }
								return { id: m.id || String(Date.now() + Math.random()), role: m.role, text: m.text || "", timestamp: m.timestamp || Date.now(), streaming: false, blocks };
							});
							loadMessages(key, dbMsgs);
							const current = await api().sessionsCurrent(agentId);
							setActiveSessionId(current?.id ?? null);
						} catch {}
					})();
					break;
				}
				case "retry_attempt": {
					updateAssistantText(key, `Retrying (${data.attempt}/${data.maxAttempts})...`);
					break;
				}
				case "error": {
					lastErrorKey.current = key;
					updateAssistantText(key, `\nError: ${data.error}`);
					finishStreaming(key);
					break;
				}
			}
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
