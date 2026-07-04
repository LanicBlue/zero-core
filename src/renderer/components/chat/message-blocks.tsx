// Shared chat message-block rendering.
//
// # 文件说明书
//
// ## 核心功能
// 把一条 ChatMessage 的内容(user 文本 / assistant blocks:text · thinking · tool)
// 渲染成与主聊天一致的视觉。从 ChatPanel 抽出,使 DocViewerPanel 的子代理对话
// 视图(TaskDetailView)能复用同一套渲染,保证"右下渲染成 chat 对话样式"。
//
// ## 定位
// src/renderer/components/chat/ — 被 ChatPanel 与 TaskDetailView/MessageRow 共用。
//
// ## 维护规则
// 工具块显示名/摘要键新增工具时,同步扩 TOOL_DISPLAY_NAMES / TOOL_SUMMARY_KEY。
//
import React, { useState, useMemo } from "react";
import MarkdownRenderer from "../common/MarkdownRenderer.js";
import type { MessageBlock, ToolCallBlock, ThinkingBlock } from "../../store/chat-store.js";

/** Collapse 3+ consecutive newlines to 2, then trim. Preserves markdown paragraph breaks and tables. */
export function collapseNewlines(s: string): string {
	return s.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripLeadingNL(s: string): string {
	return s.charCodeAt(0) === 10 ? s.substring(1) : s;
}

export function stripTrailingNL(s: string): string {
	return s.charCodeAt(s.length - 1) === 10 ? s.substring(0, s.length - 1) : s;
}

/**
 * Parse <think...>...</think...> tags from text into structured segments.
 * Collapses consecutive blank lines in text segments.
 */
export function parseThinkingSegments(text: string): { type: "thinking" | "text"; text: string }[] {
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
			const t = stripLeadingNL(remaining.substring(tagEnd + 1));
			if (t) segs.push({ type: "thinking", text: t });
			break;
		}
		const t = stripTrailingNL(stripLeadingNL(remaining.substring(tagEnd + 1, closeIdx)));
		if (t) segs.push({ type: "thinking", text: t });
		const closeEnd = remaining.indexOf(">", closeIdx);
		let after = closeEnd !== -1 ? remaining.substring(closeEnd + 1) : "";
		after = stripLeadingNL(after);
		remaining = after;
	}
	return segs;
}

// Tool display names and summary key maps
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
	bash: "Shell", shell: "Shell", read: "Read", write: "Write", edit: "Edit",
	grep: "Grep", glob: "Glob",
	webSearch: "Web Search", web_search: "Web Search",
	webFetch: "Web Fetch", web_fetch: "Web Fetch",
	agent: "Subagent", subagent: "Subagent", wait: "Wait",
	taskStatus: "Task Status", taskList: "Task List", taskStop: "Task Stop",
	askUser: "Ask User", todoWrite: "Todo Write",
	memoryRead: "Memory Read", memoryWrite: "Memory Write",
};
export const TOOL_SUMMARY_KEY: Record<string, string[]> = {
	bash: ["command", "description"],
	read: ["file_path", "path"], write: ["file_path", "path"], edit: ["file_path", "path"],
	grep: ["pattern"], glob: ["pattern"],
	webSearch: ["query"], web_search: ["query"],
	webFetch: ["url"], web_fetch: ["url"],
	agent: ["task"], subagent: ["task"], wait: ["timeout"],
	taskStatus: ["task_id"], taskList: [], taskStop: ["task_id"], askUser: [],
};

export function ThinkingBlockComponent({ text, streaming }: { text: string; streaming: boolean }) {
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

export function ToolBlock({ block, streaming }: { block: ToolCallBlock; streaming: boolean }) {
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

/**
 * Group of consecutive tool calls from one assistant turn, collapsed into a
 * single foldable card so a batch of N parallel calls doesn't produce N
 * separate collapsed rows cluttering the chat. The group header summarizes
 * the batch (count + aggregate status); expanding reveals the individual
 * ToolBlocks, each still independently expandable for args/result.
 */
export function ToolCallGroup({ blocks, streaming }: { blocks: ToolCallBlock[]; streaming: boolean }) {
	const [expanded, setExpanded] = useState(false);

	// Aggregate status: running beats error beats done.
	const aggregate = useMemo(() => {
		const statuses = blocks.map((b) => b.status);
		if (statuses.includes("running")) return "running";
		if (statuses.includes("error")) return "error";
		return "done";
	}, [blocks]);

	const statusClass = aggregate === "running" ? "tool-running"
		: aggregate === "error" ? "tool-error" : "tool-done";
	const statusLabel = aggregate === "running" ? "Running…"
		: aggregate === "error" ? "Error" : "Done";

	// Distinct tool-name count for the collapsed preview (e.g. "Read × 3, Write").
	const nameSummary = useMemo(() => {
		const counts = new Map<string, number>();
		for (const b of blocks) counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
		return Array.from(counts.entries())
			.map(([n, c]) => `${TOOL_DISPLAY_NAMES[n] ?? n}${c > 1 ? ` × ${c}` : ""}`)
			.join(", ");
	}, [blocks]);

	return (
		<div className={`tool-call-group ${statusClass}`}>
			<div className="tool-call-group-header" onClick={() => setExpanded(!expanded)}>
				<span className="tool-block-chevron">{expanded ? "▾" : "▸"}</span>
				<span className="tool-call-group-title">
					{blocks.length} tool call{blocks.length !== 1 ? "s" : ""}
				</span>
				{!expanded && <span className="tool-call-group-summary">{nameSummary}</span>}
				<span className={`tool-block-status ${statusClass}`}>{statusLabel}</span>
			</div>
			{expanded && (
				<div className="tool-call-group-body">
					{blocks.map((b, i) => (
						<ToolBlock key={i} block={b} streaming={streaming} />
					))}
				</div>
			)}
		</div>
	);
}

export function renderBlocks(blocks: MessageBlock[], streaming: boolean) {
	const elements: React.ReactNode[] = [];
	let ti = 0, ki = 0, xi = 0;

	// Collect runs of consecutive tool blocks so a batch of parallel tool calls
	// from one assistant turn renders as ONE collapsible group (see
	// ToolCallGroup) instead of N separate collapsed cards.
	let toolRun: ToolCallBlock[] = [];
	const flushToolRun = (keyPrefix: string) => {
		if (toolRun.length === 0) return;
		if (toolRun.length === 1) {
			elements.push(<ToolBlock key={keyPrefix + (ki++)} block={toolRun[0]} streaming={streaming} />);
		} else {
			elements.push(<ToolCallGroup key={keyPrefix + (ki++)} blocks={toolRun} streaming={streaming} />);
		}
		toolRun = [];
	};

	for (const block of blocks) {
		if (block.type === "tool") {
			toolRun.push(block as ToolCallBlock);
			continue;
		}
		flushToolRun("k");
		if (block.type === "thinking") {
			elements.push(<ThinkingBlockComponent key={"t" + (ti++)} text={(block as ThinkingBlock).text} streaming={streaming} />);
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
	flushToolRun("k");

	return elements;
}
