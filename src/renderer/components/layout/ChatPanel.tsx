import React, { useState, useRef, useEffect, useCallback } from "react";
import { useChatStore, nextMsgId, type MessageBlock } from "../../store/chat-store.js";
import { useAgentStore } from "../../store/agent-store.js";

function renderBlock(block: MessageBlock, key: number): React.ReactNode {
	if (block.type === "text") {
		if (!block.text) return null;
		return <span key={key} className="block-text">{block.text}</span>;
	}
	const statusIcon = block.status === "done" ? " ✓" : block.status === "error" ? " ✗" : " …";
	return (
		<span key={key} className={`block-tool block-tool-${block.status}`}>
			{"› "}{block.name}{statusIcon}
		</span>
	);
}

export default function ChatPanel() {
	const {
		messages, activeAgentId, isStreaming,
		addMessage, updateAssistantText, addToolCall, updateToolCall,
		finishStreaming, loadMessages, setIsStreaming, setActiveAgent,
	} = useChatStore();
	const { agents } = useAgentStore();
	const [input, setInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const loadedAgentRef = useRef<string | null>(null);

	// Load message history when agent changes
	useEffect(() => {
		if (!activeAgentId) return;
		if (loadedAgentRef.current === activeAgentId) return;
		loadedAgentRef.current = activeAgentId;

		fetch(`/api/messages/${activeAgentId}`)
			.then((r) => r.json())
			.then((msgs) => {
				loadMessages(msgs);
			})
			.catch(() => {
				loadMessages([]);
			});
	}, [activeAgentId, loadMessages]);

	// Connect WebSocket
	const connectWs = useCallback(() => {
		if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;

		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${proto}//${window.location.host}/ws`);

		ws.onmessage = (event) => {
			const data = JSON.parse(event.data);

			switch (data.type) {
				case "reconnect": {
					if (data.isBusy) {
						const blocks: MessageBlock[] = [];
						if (data.toolCalls) {
							for (const tc of data.toolCalls as { name: string; status: string }[]) {
								blocks.push({ type: "tool", name: tc.name, status: tc.status as "running" | "done" | "error" });
							}
						}
						if (data.streamingText) {
							blocks.push({ type: "text", text: data.streamingText });
						}
						addMessage({
							id: nextMsgId(),
							role: "assistant",
							text: data.streamingText ?? "",
							timestamp: Date.now(),
							streaming: true,
							blocks,
						});
						setIsStreaming(true);
					}
					break;
				}
				case "text_delta": {
					updateAssistantText(data.text);
					break;
				}
				case "message_end": {
					if (data.text) {
						updateAssistantText(data.text);
					}
					break;
				}
				case "tool_start": {
					addToolCall(data.toolName);
					break;
				}
				case "tool_end": {
					updateToolCall(data.toolName, data.isError ? "error" : "done");
					break;
				}
				case "agent_end": {
					finishStreaming();
					break;
				}
				case "error": {
					updateAssistantText(`\nError: ${data.error}`);
					finishStreaming();
					break;
				}
			}
		};

		ws.onclose = () => {
			wsRef.current = null;
		};

		wsRef.current = ws;
		return ws;
	}, [updateAssistantText, addToolCall, updateToolCall, finishStreaming, addMessage, setIsStreaming]);

	// Auto-connect on mount
	useEffect(() => {
		connectWs();
	}, [connectWs]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	useEffect(() => {
		return () => {
			// Don't close WS on unmount — agent keeps running
		};
	}, []);

	const send = async () => {
		const text = input.trim();
		if (!text || isStreaming) return;

		addMessage({ id: nextMsgId(), role: "user", text, timestamp: Date.now() });
		setInput("");

		addMessage({
			id: nextMsgId(),
			role: "assistant",
			text: "",
			timestamp: Date.now(),
			streaming: true,
			blocks: [],
		});

		const ws = connectWs();

		if (ws.readyState !== WebSocket.OPEN) {
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(new Error("WebSocket connection failed"));
				setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
			});
		}

		ws.send(JSON.stringify({
			type: "send",
			text,
			agentId: activeAgentId,
		}));
	};

	const abort = () => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "abort" }));
		}
		finishStreaming();
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	const activeAgent = agents.find((a) => a.id === activeAgentId);

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
				{blocks.map((block, i) => renderBlock(block, i))}
				{msg.streaming && <span className="cursor-blink">|</span>}
			</>
		);
	};

	return (
		<main className="chat-panel">
			<div className="chat-header">
				<select
					className="chat-agent-select"
					value={activeAgentId ?? ""}
					onChange={(e) => setActiveAgent(e.target.value || null)}
				>
					<option value="">-- Select Agent --</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>{a.name} — {a.role}</option>
					))}
				</select>
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
