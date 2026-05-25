import React, { useState, useEffect } from "react";
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
import { usePageStore } from "../../store/page-store.js";
import { useInteractionStore } from "../../store/interaction-store.js";
import { useChatStore, nextMsgId, type MessageBlock } from "../../store/chat-store.js";

const api = () => (window as any).api;

// Capture console logs for the log panel
const logEntries: { time: number; level: string; msg: string }[] = [];
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

function captureLog(level: string, ...args: any[]) {
	const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
	logEntries.push({ time: Date.now(), level, msg });
	if (logEntries.length > 200) logEntries.shift();
}

console.log = (...args: any[]) => { captureLog("info", ...args); origLog(...args); };
console.error = (...args: any[]) => { captureLog("error", ...args); origError(...args); };
console.warn = (...args: any[]) => { captureLog("warn", ...args); origWarn(...args); };

if (typeof window !== "undefined") {
	window.addEventListener("error", (e) => {
		captureLog("error", `Uncaught: ${e.message} at ${e.filename}:${e.lineno}`);
	});
	window.addEventListener("unhandledrejection", (e) => {
		captureLog("error", `Unhandled rejection: ${e.reason}`);
	});
}

export default function AppLayout() {
	const { activePage } = usePageStore();
	const [showLog, setShowLog] = useState(false);
	const [, forceUpdate] = useState(0);

	const {
		messages, activeAgentId, isStreaming,
		addMessage, updateAssistantText, updateThinking, addToolCall, updateToolCall,
		finishStreaming, setIsStreaming, loadMessages, setSessions, setCurrentSessionId,
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

			switch (data.type) {
				case "text_delta": {
					updateAssistantText(agentId, data.text);
					break;
				}
				case "message_end": {
					// text_delta already handled streaming text
					break;
				}
				case "thinking_delta": {
					updateThinking(agentId, data.text);
					break;
				}
				case "tool_start": {
					const args = data.args ? (typeof data.args === "string" ? data.args : JSON.stringify(data.args, null, 2)) : undefined;
					addToolCall(agentId, data.toolName, args);
					break;
				}
				case "tool_end": {
					const result = data.result ? (typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2)) : undefined;
					updateToolCall(agentId, data.toolName, data.isError ? "error" : "done", result);
					break;
				}
				case "agent_end": {
					finishStreaming(agentId);
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
							loadMessages(agentId, dbMsgs);
							const current = await api().sessionsCurrent(agentId);
							setCurrentSessionId(current?.id ?? null);
						} catch {}
					})();
					break;
				}
				case "retry_attempt": {
					updateAssistantText(agentId, `Retrying (${data.attempt}/${data.maxAttempts})...`);
					break;
				}
				case "error": {
					updateAssistantText(agentId, `\nError: ${data.error}`);
					finishStreaming(agentId);
					break;
				}
			}
		});

		// Check for in-progress agent on mount (e.g. page refresh)
		api().chatState().then((state: { isBusy: boolean; streamingText: string; toolCalls: any[]; agentId?: string }) => {
			if (state.isBusy && state.agentId) {
				const blocks: MessageBlock[] = [];
				if (state.toolCalls) {
					for (const tc of state.toolCalls) {
						blocks.push({ type: "tool", name: tc.name, status: tc.status as "running" | "done" | "error" });
					}
				}
				if (state.streamingText) {
					blocks.push({ type: "text", text: state.streamingText });
				}
				addMessage(state.agentId, {
					id: nextMsgId(),
					role: "assistant",
					text: state.streamingText ?? "",
					timestamp: Date.now(),
					streaming: true,
					blocks,
				});
				setIsStreaming(state.agentId, true);
			}
		}).catch(() => {});

		return unsubscribe;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Refresh log panel
	useEffect(() => {
		if (!showLog) return;
		const interval = setInterval(() => forceUpdate((n) => n + 1), 500);
		return () => clearInterval(interval);
	}, [showLog]);

	return (
		<div className="app-layout">
			<IconSidebar />
			{activePage === "chat" ? (
				<ResizableLayout
					defaults={[4, 2, 4]}
					mins={[280, 160, 200]}
				>
					<ChatPanel />
					<FileTreePanel />
					<DocViewerPanel />
				</ResizableLayout>
			) : activePage === "settings" ? (
				<SettingsPage />
			) : activePage === "mcp" ? (
				<McpSettingsPage />
			) : activePage === "tools" ? (
				<ToolsPage />
			) : activePage === "knowledge" ? (
				<KnowledgeBasePage />
			) : (
				<AgentsPage />
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
					<div className="log-panel-header">
						<span>Runtime Log</span>
						<button type="button" onClick={() => setShowLog(false)}>Close</button>
					</div>
					<div className="log-panel-body">
						{logEntries.map((entry, i) => (
							<div key={i} className={`log-entry log-${entry.level}`}>
								<span className="log-time">{new Date(entry.time).toLocaleTimeString()}</span>
								<span className="log-msg">{entry.msg}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
