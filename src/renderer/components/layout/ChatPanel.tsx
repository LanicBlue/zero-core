import React, { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useChatStore, selectActiveMessages, selectIsStreaming, selectLastError, nextMsgId, type MessageBlock, type ToolCallBlock, type ThinkingBlock } from "../../store/chat-store.js";
import { useAgentStore } from "../../store/agent-store.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";
import AskUserCard from "../chat/AskUserCard.js";
import TodosList from "../chat/TodosList.js";
import { useInteractionStore } from "../../store/interaction-store.js";

const api = () => (window as any).api;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse 3+ consecutive newlines to 2, then trim. Preserves markdown paragraph breaks and tables. */
function collapseNewlines(s: string): string {
	return s.replace(/\n{3,}/g, "\n\n").trim();
}

function stripLeadingNL(s: string): string {
	return s.charCodeAt(0) === 10 ? s.substring(1) : s;
}

function stripTrailingNL(s: string): string {
	return s.charCodeAt(s.length - 1) === 10 ? s.substring(0, s.length - 1) : s;
}

/**
 * Parse <think...>...</think...> tags from text into structured segments.
 * Collapses consecutive blank lines in text segments.
 */
function parseThinkingSegments(text: string): { type: "thinking" | "text"; text: string }[] {
	if (!text) return [];
	const segs: { type: "thinking" | "text"; text: string }[] = [];
	let remaining = text;
	while (remaining) {
		const openIdx = remaining.indexOf("<think");
		if (openIdx === -1) {
			const t = collapseNewlines(remaining);
			if (t) segs.push({ type: "text", text: t });
			break;
		}
		if (openIdx > 0) {
			const before = collapseNewlines(remaining.substring(0, openIdx));
			if (before) segs.push({ type: "text", text: before });
		}
		const tagEnd = remaining.indexOf(">", openIdx);
		if (tagEnd === -1) {
			const t = collapseNewlines(remaining);
			if (t) segs.push({ type: "text", text: t });
			break;
		}
		const closeIdx = remaining.indexOf("</think", tagEnd);
		if (closeIdx === -1) {
			let t = stripLeadingNL(remaining.substring(tagEnd + 1));
			if (t) segs.push({ type: "thinking", text: t });
			break;
		}
		let t = stripTrailingNL(stripLeadingNL(remaining.substring(tagEnd + 1, closeIdx)));
		if (t) segs.push({ type: "thinking", text: t });
		const closeEnd = remaining.indexOf(">", closeIdx);
		let after = closeEnd !== -1 ? remaining.substring(closeEnd + 1) : "";
		after = stripLeadingNL(after);
		remaining = after;
	}
	return segs;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ThinkingBlockComponent({ text, streaming }: { text: string; streaming: boolean }) {
	const [expanded, setExpanded] = useState(true);

	return (
		<div className="thinking-block">
			<div className="thinking-block-header" onClick={() => setExpanded(!expanded)}>
				<span className="thinking-block-chevron">{expanded ? "▾" : "▸"}</span>
				<span className="thinking-block-title">Thinking</span>
				{streaming && <span className="thinking-block-spinner">…</span>}
			</div>
			{expanded && (
				<div className="thinking-block-details">
					<pre className="thinking-block-code">{text}</pre>
				</div>
			)}
		</div>
	);
}

// Tool display names and summary key maps
	const TOOL_DISPLAY_NAMES: Record<string, string> = {
		bash: "Bash", read: "Read", write: "Write", edit: "Edit",
		grep: "Grep", glob: "Glob",
		webSearch: "Web Search", web_search: "Web Search",
		webFetch: "Web Fetch", web_fetch: "Web Fetch",
		agent: "Agent", wait: "Wait",
		taskStatus: "Task Status", taskList: "Task List", taskStop: "Task Stop",
		askUser: "Ask User", todoWrite: "Todo Write",
		memoryRead: "Memory Read", memoryWrite: "Memory Write",
	};
	const TOOL_SUMMARY_KEY: Record<string, string[]> = {
		bash: ["command", "description"],
		read: ["file_path", "path"], write: ["file_path", "path"], edit: ["file_path", "path"],
		grep: ["pattern"], glob: ["pattern"],
		webSearch: ["query"], web_search: ["query"],
		webFetch: ["url"], web_fetch: ["url"],
		agent: ["description", "prompt"], wait: ["timeout"],
		taskStatus: ["task_id"], taskList: [], taskStop: ["task_id"], askUser: [],
	};

	function ToolBlock({ block, streaming }: { block: ToolCallBlock; streaming: boolean }) {
		const [expanded, setExpanded] = useState(false);
		const statusClass = block.status === "running" ? "tool-running" : block.status === "error" ? "tool-error" : "tool-done";

		const summary = useMemo(() => {
			if (!block.args) return "";
			try {
				const a = JSON.parse(block.args);
				const keys = TOOL_SUMMARY_KEY[block.name];
				if (keys) {
					for (const k of keys) { if (a[k]) return String(a[k]); }
					return "";
				}
				const vals = Object.values(a).filter((v: any) => typeof v === "string" && v.length < 120);
				return (vals as string[])[0] || "";
			} catch { return ""; }
		}, [block.name, block.args]);

		const displaySummary = summary.length > 100 ? summary.slice(0, 100) + "…" : summary;
		const displayName = TOOL_DISPLAY_NAMES[block.name] ?? block.name;

		const elapsed = useMemo(() => {
			if (!block.startedAt) return null;
			const end = block.completedAt ?? Date.now();
			return ((end - block.startedAt) / 1000).toFixed(1) + "s";
		}, [block.startedAt, block.completedAt, block.status]);

		const formattedArgs = useMemo(() => {
			if (!block.args) return null;
			try {
				const a = JSON.parse(block.args);
				return Object.entries(a)
					.filter(([, v]) => v !== undefined && v !== "")
					.map(([k, v]) => {
						const s = typeof v === "string" ? v : JSON.stringify(v);
						return { key: k, value: s.length > 200 ? s.slice(0, 200) + "…" : s };
					});
			} catch { return null; }
		}, [block.args]);

		return (
			<div className={`tool-block ${statusClass}`}>
				<div className="tool-block-header" onClick={() => setExpanded(!expanded)}>
					<span className="tool-block-chevron">{expanded ? "▾" : "▸"}</span>
					<span className="tool-block-name">{displayName}</span>
					{!expanded && displaySummary && <span className="tool-block-summary">{displaySummary}</span>}
					<span className={`tool-block-status ${statusClass}`}>
						{block.status === "running" ? "Running…" : block.status === "error" ? "Error" : `Done${elapsed ? ` (${elapsed})` : ""}`}
					</span>
				</div>
				{expanded && (
					<div className="tool-block-details">
						{formattedArgs && (
							<div className="tool-block-args">
								<div className="tool-block-section-label">Args</div>
								{formattedArgs.map(({ key, value }) => (
									<div key={key} className="tool-block-arg-row">
										<span className="tool-block-arg-key">{key}:</span>
										<span className="tool-block-arg-value">{value}</span>
									</div>
								))}
							</div>
						)}
						{block.result && (
							<div className="tool-block-result">
								<div className="tool-block-section-label">Result</div>
								<MarkdownRenderer content={block.result} />
							</div>
						)}
					</div>
				)}
			</div>
		);
	}

function renderBlocks(blocks: MessageBlock[], streaming: boolean) {
	const elements: React.ReactNode[] = [];
	let ti = 0, ki = 0, xi = 0;

	for (const block of blocks) {
		if (block.type === "thinking") {
			elements.push(<ThinkingBlockComponent key={"t" + (ti++)} text={(block as ThinkingBlock).text} streaming={streaming} />);
		} else if (block.type === "tool") {
			elements.push(<ToolBlock key={"k" + (ki++)} block={block as ToolCallBlock} streaming={streaming} />);
		} else if (block.type === "text") {
			const text = (block as { text: string }).text;
			if (!text) continue;
			// Parse <think...> tags that may be embedded in text (non-Anthropic models)
			const segs = parseThinkingSegments(text);
			for (const seg of segs) {
				if (seg.type === "thinking") {
					elements.push(<ThinkingBlockComponent key={"t" + (ti++)} text={seg.text} streaming={streaming} />);
				} else if (seg.text) {
					elements.push(<MarkdownRenderer key={"x" + (xi++)} content={seg.text} streaming={streaming} />);
				}
			}
		}
	}

	return elements;
}

// ---------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------


function ErrorBanner() {
	const lastError = useChatStore(selectLastError);
	const clearErr = useChatStore.getState().clearError;

	useEffect(() => {
		if (!lastError) return;
		const timer = setTimeout(clearErr, 5000);
		return () => clearTimeout(timer);
	}, [lastError]);

	if (!lastError) return null;

	return (
		<div className="error-banner">
			<span className="error-banner-text">{lastError.message}</span>
			<button type="button" className="error-banner-close" onClick={clearErr}>x</button>
		</div>
	);
}

export default function ChatPanel() {
	const {
				activeAgentId, activeSessionId, sessionsByAgent,
				addMessage, finishStreaming, setActiveAgent,
				setSessions, setActiveSessionId, clearMessages,
				editMessage, deleteMessage, setIsStreaming,
			} = useChatStore();
	const messages = useChatStore(selectActiveMessages);
	const isStreaming = useChatStore(selectIsStreaming);
	const { agents } = useAgentStore();
	const { pendingQuestions, todosByAgent } = useInteractionStore();
	const todos = activeAgentId ? (todosByAgent[activeAgentId] ?? []) : [];
	const [input, setInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const loadedAgentRef = useRef<string | null>(null);
	const [showSessions, setShowSessions] = useState(false);
	const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");

	const refreshSessionData = useCallback(async (agentId: string) => {
		const result = await api().sessionsActivate(agentId);
		if (result?.sessionId) setActiveSessionId(result.sessionId);
		const sessions = await api().sessionsList(agentId);
		setSessions(agentId, sessions);
	}, []);

	// Load message history + sessions when agent changes
	useEffect(() => {
		if (!activeAgentId) return;
		if (loadedAgentRef.current === activeAgentId) return;
		loadedAgentRef.current = activeAgentId;

		refreshSessionData(activeAgentId).catch(() => {
			// session_init event may still arrive later
		});
	}, [activeAgentId]);

	// Sync scroll to bottom — no animation, before paint
	useLayoutEffect(() => {
		const el = messagesContainerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	const send = async () => {
		const text = input.trim();
		if (!text || !activeAgentId || isStreaming) return;

		const sid = activeSessionId ?? activeAgentId;
		addMessage(sid, { id: nextMsgId(), role: "user", text, timestamp: Date.now() });
		setInput("");
		setIsStreaming(sid, true);

		addMessage(sid, {
			id: nextMsgId(),
			role: "assistant",
			text: "",
			timestamp: Date.now(),
			streaming: true,
			blocks: [],
		});

		await api().chatSend(text, activeAgentId, activeSessionId ?? undefined);
	};

	const abort = () => {
		if (activeSessionId) finishStreaming(activeSessionId);
		api().chatAbort();
	};

	const handleNewSession = async () => {
		if (!activeAgentId) return;
		const session = await api().sessionsNew(activeAgentId);
		setActiveSessionId(session.id);
		clearMessages(session.id);
		setShowSessions(false);
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
	};

	const handleSwitchSession = async (sessionId: string) => {
		if (!activeAgentId) return;
		await api().sessionsSwitch(activeAgentId, sessionId);
		setActiveSessionId(sessionId);
		setShowSessions(false);
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
	};

	const handleDeleteSession = async (sessionId: string) => {
		if (!activeAgentId) return;
		const result = await api().sessionsDelete(activeAgentId, sessionId);
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
		if (result.newSessionId) {
			const activateResult = await api().sessionsActivate(activeAgentId, result.newSessionId);
			if (activateResult?.sessionId) setActiveSessionId(activateResult.sessionId);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	const parseMsgSeq = (id: string) => parseInt(id.slice(1), 10);

	const activeAgent = agents.find((a) => a.id === activeAgentId);
	const sessions = activeAgentId ? (sessionsByAgent[activeAgentId] ?? []) : [];

	const startEdit = (msg: typeof messages[number]) => {
		setEditingMsgId(msg.id);
		setEditText(msg.text);
	};

	const cancelEdit = () => {
		setEditingMsgId(null);
		setEditText("");
	};

	const saveEdit = async (msg: typeof messages[number]) => {
		if (!activeAgentId || !editText.trim()) return;
		const seq = parseMsgSeq(msg.id);
		await api().messagesEdit(activeAgentId, seq, editText.trim());
		editMessage(activeSessionId ?? activeAgentId, msg.id, editText.trim());
		setEditingMsgId(null);
		setEditText("");
	};

	const handleDeleteMsg = async (msg: typeof messages[number]) => {
		if (!activeAgentId) return;
		if (!confirm("Delete this message?")) return;
		const seq = parseMsgSeq(msg.id);
		await api().messagesDelete(activeAgentId, seq);
		deleteMessage(activeSessionId ?? activeAgentId, msg.id);
	};

	const renderMessageContent = (msg: typeof messages[number]) => {
		if (msg.role === "user") {
			return msg.text;
		}

		const blocks = msg.blocks;
		if (!blocks || blocks.length === 0) {
			if (msg.streaming) return <><span className="thinking-dots">Thinking</span><span className="cursor-blink">|</span></>;
			return msg.text || "";
		}

		return (
			<>
				{renderBlocks(blocks, !!msg.streaming)}
				{msg.streaming && <span className="cursor-blink">|</span>}
			</>
		);
	};

	return (
		<main className="chat-panel" data-session-id={activeSessionId ?? ""}>
			<div className="chat-header">
				<select
					className="chat-agent-select"
					aria-label="Select Agent"
					value={activeAgentId ?? ""}
					onChange={(e) => setActiveAgent(e.target.value || null)}
				>
					<option value="">-- Select Agent --</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>{a.name}</option>
					))}
				</select>

				{activeAgentId && (
					<div className="session-controls">
						<button type="button" className="btn-new-session" onClick={handleNewSession} title="New Chat">
							+
						</button>
						<button
							type="button"
							className="btn-sessions"
							onClick={() => setShowSessions(!showSessions)}
						>
							{sessions.length} session{sessions.length !== 1 ? "s" : ""}
						</button>
						{showSessions && (
							<div className="session-dropdown">
								{sessions.map((s) => (
									<div key={s.id} className={`session-item ${s.id === activeSessionId ? "active" : ""}`}>
										<button
											type="button"
											className="session-item-label"
											onClick={() => handleSwitchSession(s.id)}
										>
											{s.title ?? new Date(s.createdAt).toLocaleString()}
											{s.isMain && <span className="session-main"> *</span>}
										</button>
										<button
											type="button"
											className="session-item-delete"
											onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
											title="Delete session"
										>
											x
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				)}
			</div>

			<ErrorBanner />

			<div className="chat-messages" ref={messagesContainerRef}>
				{messages.length === 0 && (
					<div className="chat-empty">
						<h2>Welcome to Zero-Core</h2>
						<p>Select an agent from the sidebar and start chatting.</p>
					</div>
				)}
				{messages.map((msg) => (
					<div key={msg.id} className={`message message-${msg.role}`}>
						<div className="message-avatar">{msg.role === "user" ? "U" : activeAgent?.name?.[0] ?? "Z"}</div>
						<div className="message-content-wrapper">
							<div className="message-content">
								{editingMsgId === msg.id ? (
									<div className="msg-edit-container">
										<textarea className="msg-edit-area" value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} />
										<div className="msg-edit-actions">
											<button type="button" className="msg-edit-save" onClick={() => saveEdit(msg)}>Save</button>
											<button type="button" className="msg-edit-cancel" onClick={cancelEdit}>Cancel</button>
										</div>
									</div>
								) : renderMessageContent(msg)}
							</div>
							{!msg.streaming && editingMsgId !== msg.id && (
								<div className="message-actions">
									<button className="msg-action-btn" onClick={() => startEdit(msg)} title="Edit">Edit</button>
									<button className="msg-action-btn" onClick={() => handleDeleteMsg(msg)} title="Delete">Delete</button>
								</div>
							)}
						</div>
					</div>
				))}
				<div ref={messagesEndRef} />
			</div>

			{todos.length > 0 && <TodosList todos={todos} />}

			<div className="chat-input-bar">
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={activeAgentId ? "Type a message..." : "Select an agent first..."}
					disabled={!activeAgentId || isStreaming}
					rows={1}
				/>
				{isStreaming ? (
					<button type="button" onClick={abort} className="btn-abort">Stop</button>
				) : (
					<button type="button" onClick={send} disabled={!activeAgentId || !input.trim()}>Send</button>
				)}
			</div>
		</main>
	);
}
