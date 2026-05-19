import React, { useState, useRef, useEffect, useCallback } from "react";
import { useChatStore, nextMsgId, type MessageBlock, type ToolCallBlock, type ThinkingBlock } from "../../store/chat-store.js";
import { useAgentStore } from "../../store/agent-store.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";

const api = () => (window as any).api;

// ---------------------------------------------------------------------------
// Parse <think ...>...</think > tags from text into structured blocks
// ---------------------------------------------------------------------------

interface ParsedSegment {
	type: "thinking" | "text";
	text: string;
}

function parseThinkingFromText(text: string): ParsedSegment[] {
	if (!text) return [];
	const segments: ParsedSegment[] = [];
	let remaining = text;

	while (remaining) {
		const openIdx = remaining.indexOf("<think");
		if (openIdx === -1) {
			if (remaining) segments.push({ type: "text", text: remaining });
			break;
		}

		if (openIdx > 0) {
			segments.push({ type: "text", text: remaining.substring(0, openIdx) });
		}

		const tagEnd = remaining.indexOf(">", openIdx);
		if (tagEnd === -1) {
			segments.push({ type: "text", text: remaining });
			break;
		}

		const closeIdx = remaining.indexOf("</think", tagEnd);
		if (closeIdx === -1) {
			const thinkText = remaining.substring(tagEnd + 1).replace(/^\n/, "");
			segments.push({ type: "thinking", text: thinkText });
			break;
		}

		const thinkText = remaining.substring(tagEnd + 1, closeIdx).replace(/^\n/, "").replace(/\n$/, "");
		segments.push({ type: "thinking", text: thinkText });

		const closeEnd = remaining.indexOf(">", closeIdx);
		remaining = closeEnd !== -1 ? remaining.substring(closeEnd + 1).replace(/^\n/, "") : "";
	}

	return segments;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ThinkingBlockComponent({ text, streaming }: { text: string; streaming: boolean }) {
	const [expanded, setExpanded] = useState(false);

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

function ToolBlock({ block, streaming }: { block: ToolCallBlock; streaming: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const statusClass = block.status === "running" ? "tool-running" : block.status === "error" ? "tool-error" : "tool-done";

	return (
		<div className={`tool-block ${statusClass}`}>
			<div className="tool-block-header" onClick={() => setExpanded(!expanded)}>
				<span className="tool-block-chevron">{expanded ? "▾" : "▸"}</span>
				<span className="tool-block-name">{block.name}</span>
				<span className={`tool-block-status ${statusClass}`}>
					{block.status === "running" ? "Running…" : block.status === "error" ? "Error" : "Done"}
				</span>
			</div>
			{expanded && (
				<div className="tool-block-details">
					{block.args && <pre className="tool-block-code">Args: {block.args}</pre>}
					{block.result && <pre className="tool-block-code">Result: {block.result}</pre>}
				</div>
			)}
		</div>
	);
}

function renderBlocks(blocks: MessageBlock[], streaming: boolean) {
	const elements: React.ReactNode[] = [];

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.type === "thinking") {
			elements.push(<ThinkingBlockComponent key={i} text={(block as ThinkingBlock).text} streaming={streaming} />);
		} else if (block.type === "tool") {
			elements.push(<ToolBlock key={i} block={block as ToolCallBlock} streaming={streaming} />);
		} else if (block.type === "text") {
			const segments = parseThinkingFromText((block as { text: string }).text);
			for (const seg of segments) {
				if (seg.type === "thinking") {
					elements.push(<ThinkingBlockComponent key={`${i}-t-${elements.length}`} text={seg.text} streaming={streaming} />);
				} else if (seg.text) {
					elements.push(<MarkdownRenderer key={`${i}-s-${elements.length}`} content={seg.text} streaming={streaming} />);
				}
			}
		}
	}

	return elements;
}

function storedToBlocks(msgs: any[]): any[] {
	return msgs.map((m) => {
		const blocks: MessageBlock[] = [];
		// Restore tool call blocks from persisted data
		if (m.toolCalls && Array.isArray(m.toolCalls)) {
			for (const tc of m.toolCalls) {
				blocks.push({
					type: "tool",
					name: tc.name,
					status: tc.status || "done",
					args: tc.args,
					result: tc.result,
				} as ToolCallBlock);
			}
		}
		if (m.text) {
			blocks.push({ type: "text", text: m.text });
		}
		return {
			id: m.id || String(Date.now() + Math.random()),
			role: m.role,
			text: m.text || "",
			timestamp: m.timestamp || Date.now(),
			streaming: false,
			blocks,
		};
	});
}

// ---------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------

export default function ChatPanel() {
	const {
			messages, activeAgentId, isStreaming, sessionsByAgent, currentSessionId,
			addMessage, finishStreaming, loadMessages, setActiveAgent,
			setSessions, setCurrentSessionId, clearMessages,
		} = useChatStore();
	const { agents } = useAgentStore();
	const [input, setInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const loadedAgentRef = useRef<string | null>(null);
	const [showSessions, setShowSessions] = useState(false);

	const refreshSessionData = useCallback(async (agentId: string) => {
		const [sessions, msgs] = await Promise.all([
			api().sessionsList(agentId),
			api().messagesList(agentId),
		]);
		setSessions(agentId, sessions);
		loadMessages(agentId, storedToBlocks(msgs));
		const current = await api().sessionsCurrent(agentId);
		setCurrentSessionId(current?.id ?? null);
	}, []);

	// Load message history + sessions when agent changes
	useEffect(() => {
		if (!activeAgentId) return;
		if (loadedAgentRef.current === activeAgentId) return;
		loadedAgentRef.current = activeAgentId;

		refreshSessionData(activeAgentId).catch(() => {
			loadMessages(activeAgentId, []);
		});
	}, [activeAgentId, loadMessages]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	const send = async () => {
		const text = input.trim();
		if (!text || !activeAgentId || isStreaming) return;

		addMessage(activeAgentId, { id: nextMsgId(), role: "user", text, timestamp: Date.now() });
		setInput("");

		addMessage(activeAgentId, {
			id: nextMsgId(),
			role: "assistant",
			text: "",
			timestamp: Date.now(),
			streaming: true,
			blocks: [],
		});

		await api().chatSend(text, activeAgentId);
	};

	const abort = () => {
		if (activeAgentId) finishStreaming(activeAgentId);
		api().chatAbort();
	};

	const handleNewSession = async () => {
		if (!activeAgentId) return;
		const session = await api().sessionsNew(activeAgentId);
		setCurrentSessionId(session.id);
		clearMessages(activeAgentId);
		setShowSessions(false);
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
	};

	const handleSwitchSession = async (sessionId: string) => {
		if (!activeAgentId) return;
		await api().sessionsSwitch(activeAgentId, sessionId);
		setCurrentSessionId(sessionId);
		setShowSessions(false);
		const msgs = await api().messagesList(activeAgentId);
		loadMessages(activeAgentId, storedToBlocks(msgs));
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
	};

	const handleDeleteSession = async (sessionId: string) => {
		if (!activeAgentId) return;
		const result = await api().sessionsDelete(activeAgentId, sessionId);
		if (result.newSessionId) {
			setCurrentSessionId(result.newSessionId);
			clearMessages(activeAgentId);
		}
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	const activeAgent = agents.find((a) => a.id === activeAgentId);
	const sessions = activeAgentId ? (sessionsByAgent[activeAgentId] ?? []) : [];

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
		<main className="chat-panel">
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
									<div key={s.id} className={`session-item ${s.id === currentSessionId ? "active" : ""}`}>
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

			<div className="chat-messages">
				{messages.length === 0 && (
					<div className="chat-empty">
						<h2>Welcome to Zero-Core</h2>
						<p>Select an agent from the sidebar and start chatting.</p>
					</div>
				)}
				{messages.map((msg) => (
					<div key={msg.id} className={`message message-${msg.role}`}>
						<div className="message-avatar">{msg.role === "user" ? "You" : activeAgent?.name?.[0] ?? "Z"}</div>
						<div className="message-content">
							{renderMessageContent(msg)}
						</div>
					</div>
				))}
				<div ref={messagesEndRef} />
			</div>

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
