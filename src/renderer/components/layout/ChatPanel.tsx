// 聊天面板组件
//
// # 文件说明书
//
// ## 核心功能
// 聊天界面主组件，显示消息流、工具调用和思考过程。
//
// ## 输入
// - useChatStore - 聊天状态
// - useAgentStore - Agent 状态
//
// ## 输出
// - 渲染的消息列表
// - 工具调用卡片
// - 用户输入区域
//
// ## 定位
// 渲染进程组件，被 AppLayout 使用。
//
// ## 依赖
// - react - React 框架
// - ../../store - 状态管理
//
// ## 维护规则
// - 新增消息类型时需更新
// - 保持 UI 响应性
//
import React, { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useChatStore, selectActiveMessages, selectIsStreaming, selectLastError, selectContextInfo, selectActiveAgentId, nextMsgId, type MessageBlock, type ToolCallBlock, type ThinkingBlock } from "../../store/chat-store.js";
import { useAgentStore } from "../../store/agent-store.js";
import { useProjectStore } from "../../store/project-store.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";
import { ConfirmModal } from "../common/ConfirmModal.js";
import AskUserCard from "../chat/AskUserCard.js";
import TodosList from "../chat/TodosList.js";
import { TOOL_DISPLAY_NAMES, TOOL_SUMMARY_KEY } from "../chat/message-blocks.js";
import { useInteractionStore } from "../../store/interaction-store.js";
import { useInputQueueStore } from "../../store/input-queue-store.js";
import InputQueueStrip from "../chat/InputQueueStrip.js";
import { usePageStore } from "../../store/page-store.js";
import { useRequirementStore } from "../../store/requirement-store.js";
import RequirementHeader from "../requirements/RequirementHeader.js";
import type { RequirementStatus, SessionRecord, AttachmentMeta } from "../../../shared/types.js";

const api = () => (window as any).api;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse 3+ consecutive newlines to 2, then trim. Preserves markdown paragraph breaks and tables. */
function collapseNewlines(s: string): string {
	return s.replace(/\n{3,}/g, "\n\n").trim();
}

function formatTokenCount(n: number): string {
	return n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1) + "M" : n >= 1000 ? Math.round(n / 1000) + "K" : String(n);
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
// Multimodal helpers (effort: multimodal-input sub-5)
// ---------------------------------------------------------------------------

/** Human-readable byte size, e.g. 1536 → "1.5 KB". */
function formatFileSize(bytes: number): string {
	if (!bytes || bytes < 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** File → base64 (without the data: URL prefix) via FileReader.readAsDataURL. */
function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const r = reader.result;
			if (typeof r !== "string") { reject(new Error("read failed")); return; }
			const comma = r.indexOf(",");
			resolve(comma >= 0 ? r.slice(comma + 1) : r);
		};
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsDataURL(file);
	});
}

/** Build a data: URL from base64 bytes + mime, for `<img src>`. */
function dataUrl(base64: string, mimeType: string): string {
	return `data:${mimeType};base64,${base64}`;
}

/**
 * Resolve a File → AttachmentMeta by uploading it (sub-1 endpoint). On error
 * returns null (caller surfaces a banner). This is the SINGLE bytes-into-main
 * path — after this the renderer only carries meta (principle A).
 */
async function uploadFile(file: File, sessionId: string): Promise<AttachmentMeta | null> {
	try {
		const data = await fileToBase64(file);
		const result = await api().attachmentsUpload({
			sessionId,
			fileName: file.name || "attachment",
			mimeType: file.type || "application/octet-stream",
			data,
		});
		if (result && typeof result === "object" && "error" in result) return null;
		return result as AttachmentMeta;
	} catch (err) {
		console.error("attachment upload failed:", err);
		return null;
	}
}

/**
 * Pending-attachment chip for the input area. Image → local object-URL
 * thumbnail (no round-trip; the bytes are already in the renderer); pdf/file →
 * icon + name + size. A remove button drops it from the pending list.
 */
function PendingAttachmentChip({
	meta,
	previewUrl,
	onRemove,
}: {
	meta: AttachmentMeta;
	previewUrl?: string;
	onRemove: () => void;
}) {
	return (
		<div className="attach-chip" title={meta.fileName}>
			{meta.kind === "image" && previewUrl ? (
				<img className="attach-chip-thumb" src={previewUrl} alt={meta.fileName} />
			) : (
				<span className="attach-chip-icon">{meta.kind === "pdf" ? "📄" : "📎"}</span>
			)}
			<span className="attach-chip-name">{meta.fileName}</span>
			<span className="attach-chip-size">{formatFileSize(meta.size)}</span>
			<button
				type="button"
				className="attach-chip-remove"
				onClick={onRemove}
				title="Remove attachment"
			>
				×
			</button>
		</div>
	);
}

/**
 * HISTORY attachment renderer. Image thumbnails fetch their bytes via the
 * `attachments:content` endpoint (sub-5 / 组件 8) — they live on disk under the
 * session's attachment dir, not in the renderer. pdf/file render as an icon +
 * name + size chip (no fetch needed). Each image fetch is local to this mount
 * (cached in a ref + state) and revoked on unmount to avoid blob-URL leaks.
 */
function HistoryAttachmentView({
	meta,
	sessionId,
}: {
	meta: AttachmentMeta;
	sessionId: string;
}) {
	const [imgUrl, setImgUrl] = useState<string | null>(null);
	const [err, setErr] = useState(false);

	useEffect(() => {
		if (meta.kind !== "image") return;
		let revoked = false;
		let createdUrl: string | null = null;
		(async () => {
			try {
				const result = await api().attachmentsContent({
					sessionId,
					diskPath: meta.diskPath,
					mimeType: meta.mimeType,
				});
				if (revoked) return;
				if (result && typeof result === "object" && "error" in result) { setErr(true); return; }
				const { data, mimeType } = result as { data: string; mimeType: string };
				createdUrl = dataUrl(data, mimeType);
				setImgUrl(createdUrl);
			} catch (e) {
				if (!revoked) setErr(true);
				console.error("attachment content fetch failed:", e);
			}
		})();
		return () => {
			revoked = true;
			if (createdUrl) URL.revokeObjectURL(createdUrl);
		};
	}, [meta.diskPath, meta.kind, meta.mimeType, sessionId]);

	if (meta.kind === "image") {
		if (err) {
			return (
				<div className="attach-history attach-history-error" title={meta.fileName}>
					<span className="attach-history-icon">🖼</span>
					<span className="attach-history-name">{meta.fileName}</span>
					<span className="attach-history-size">(unavailable)</span>
				</div>
			);
		}
		if (!imgUrl) {
			return (
				<div className="attach-history attach-history-loading" title={meta.fileName}>
					<span className="attach-history-icon">🖼</span>
					<span className="attach-history-name">{meta.fileName}</span>
				</div>
			);
		}
		return (
			<a
				className="attach-history attach-history-image"
				href={imgUrl}
				target="_blank"
				rel="noreferrer"
				title={meta.fileName}
			>
				<img className="attach-history-thumb" src={imgUrl} alt={meta.fileName} />
			</a>
		);
	}

	// pdf / file
	return (
		<div className="attach-history attach-history-file" title={meta.diskPath}>
			<span className="attach-history-icon">{meta.kind === "pdf" ? "📄" : "📎"}</span>
			<span className="attach-history-name">{meta.fileName}</span>
			<span className="attach-history-size">{formatFileSize(meta.size)}</span>
		</div>
	);
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

	// TOOL_DISPLAY_NAMES / TOOL_SUMMARY_KEY live in ../chat/message-blocks.js
	// (single source — shared with the message-list render path).

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

/**
 * Group of consecutive tool calls from one assistant turn, collapsed into a
 * single foldable card so a batch of N parallel calls doesn't produce N
 * separate collapsed rows cluttering the chat. The group header summarizes
 * the batch (count + aggregate status); expanding reveals the individual
 * ToolBlocks, each still independently expandable for args/result.
 */
function ToolCallGroup({ blocks, streaming }: { blocks: ToolCallBlock[]; streaming: boolean }) {
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

function renderBlocks(blocks: MessageBlock[], streaming: boolean) {
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
				activeSessionId, activeProjectId, sessionsByAgent,
				addMessage, finishStreaming,
				setSessions, setActiveSessionId, setActiveProject, clearMessages,
				editMessage, deleteMessage, setIsStreaming,
				updateContextInfo, loadMessages,
			} = useChatStore();
	// activeAgentId is DERIVED from activeSessionId (single source of truth) —
	// see selectActiveAgentId. Kept as a local name so the ~20 read sites are
	// unchanged. pendingAgentId drives the agent-load effect (user picked an
	// agent but no session has landed yet).
	const activeAgentId = useChatStore(selectActiveAgentId);
	const pendingAgentId = useChatStore((s) => s.pendingAgentId);
	const selectAgent = useChatStore((s) => s.selectAgent);
	const messages = useChatStore(selectActiveMessages);
	const isStreaming = useChatStore(selectIsStreaming);
	const contextInfo = useChatStore(selectContextInfo);
	const { agents } = useAgentStore();
	const { projects, fetchProjects } = useProjectStore();
	const { pendingBySession, todosBySession, setPending, setTodos } = useInteractionStore();
	const { activeRequirementId, setActiveRequirementId, setActivePage } = usePageStore();
	// C2 input queue.
	const { enqueue: enqueueInput, startWatching: startQueueWatching, stopWatching: stopQueueWatching } = useInputQueueStore();
	useEffect(() => {
		if (!activeSessionId) return;
		startQueueWatching(activeSessionId);
		return () => { stopQueueWatching(activeSessionId); };
	}, [activeSessionId, startQueueWatching, stopQueueWatching]);
	const { requirements, transitionStatus, sendMessage: sendReqMessage } = useRequirementStore();
	const activeRequirement = activeRequirementId
		? requirements.find((r) => r.id === activeRequirementId)
		: undefined;
	// 按 sessionId 取本 session 的 todos / 未决 AskUser(同 agent 多 session 不串显)。
	const todos = activeSessionId ? (todosBySession[activeSessionId] ?? []) : [];
	const activePending = activeSessionId ? (pendingBySession[activeSessionId] ?? null) : null;
	const [input, setInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const loadedAgentRef = useRef<string | null>(null);
	const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
	const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");

	// ─── multimodal-input sub-5: pending attachments ───────────────
	// Each entry pairs the uploaded AttachmentMeta (carrying diskPath, principle
	// A — bytes already persisted via attachments:upload) with a LOCAL object URL
	// for the image preview (no round-trip; the bytes are still in renderer
	// memory). Non-image entries have no previewUrl. Cleared on send.
	const [pendingAttachments, setPendingAttachments] = useState<Array<{ meta: AttachmentMeta; previewUrl?: string }>>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const previewUrlsRef = useRef<Set<string>>(new Set());

	// Revoke any leftover object URLs on unmount (avoid blob-URL leaks).
	useEffect(() => {
		return () => {
			for (const u of previewUrlsRef.current) URL.revokeObjectURL(u);
			previewUrlsRef.current.clear();
		};
	}, []);

	/**
	 * Ingest one or more Files (from + button / drop / paste). Each file is
	 * uploaded (bytes → main → diskPath) and the returned meta appended to
	 * pendingAttachments. Image previews use a local object URL. Upload
	 * failures are surfaced via uploadError and do NOT block the others.
	 */
	const ingestFiles = useCallback(async (files: FileList | File[]) => {
		if (!activeSessionId) return;
		const arr = Array.from(files);
		if (arr.length === 0) return;
		setUploadError(null);
		const results: Array<{ meta: AttachmentMeta; previewUrl?: string }> = [];
		for (const file of arr) {
			const meta = await uploadFile(file, activeSessionId);
			if (!meta) {
				setUploadError(`Failed to upload: ${file.name || "attachment"}`);
				continue;
			}
			let previewUrl: string | undefined;
			if (meta.kind === "image") {
				previewUrl = URL.createObjectURL(file);
				previewUrlsRef.current.add(previewUrl);
			}
			results.push({ meta, previewUrl });
		}
		if (results.length > 0) {
			setPendingAttachments((prev) => [...prev, ...results]);
		}
	}, [activeSessionId]);

	const removePendingAttachment = useCallback((id: string) => {
		setPendingAttachments((prev) => {
			const entry = prev.find((p) => p.meta.id === id);
			if (entry?.previewUrl) {
				URL.revokeObjectURL(entry.previewUrl);
				previewUrlsRef.current.delete(entry.previewUrl);
			}
			return prev.filter((p) => p.meta.id !== id);
		});
	}, []);

	const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files && e.target.files.length > 0) {
			void ingestFiles(e.target.files);
		}
		// Reset so the same file can be picked again.
		e.target.value = "";
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);
		if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
			void ingestFiles(e.dataTransfer.files);
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		// preventDefault is REQUIRED to allow drop (otherwise the browser opens
		// the file).
		e.preventDefault();
		e.stopPropagation();
		if (!isDragging) setIsDragging(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only clear when leaving the container (not bouncing between children).
		if (e.currentTarget === e.target) setIsDragging(false);
	};

	const handlePaste = (e: React.ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			if (it.kind === "file") {
				const f = it.getAsFile();
				if (f) files.push(f);
			}
		}
		if (files.length > 0) {
			// Prevent the textarea from also inserting the image as text.
			e.preventDefault();
			void ingestFiles(files);
		}
	};

	const refreshSessionData = useCallback(async (agentId: string) => {
		const sessions = await api().sessionsList(agentId);
		setSessions(agentId, sessions);
		// Respect a session already activated externally for this agent
		// (work-trigger jump / project switch set activeSessionId before this
		// effect runs). Forcing General here would clobber the jump target, the
		// pull-on-display response would be discarded by its activeSessionId
		// guard, and the just-sent instruction would stay invisible until the
		// user manually re-switches. Only fall back to General when no valid
		// session is active for this agent (plain dropdown pick).
		const current = useChatStore.getState().activeSessionId;
		if (current && sessions.some((s: SessionRecord) => s.id === current)) {
			return;
		}
		// M5: agent 载入 → 落 General(非项目单例)。找已有的非项目 session,
		// 没有则建一个。与 activeProjectId=null 保持一致(切 agent 默认 General)。
		let general = sessions.find((s: SessionRecord) => !s.context?.projectId);
		if (!general) {
			general = await api().sessionsNew(agentId);
			const sessions2 = await api().sessionsList(agentId);
			setSessions(agentId, sessions2);
		}
		await api().sessionsActivate(agentId, general.id);
		setActiveSessionId(general.id);
	}, []);

	// M5: 跳转到某 project 的 chat —— find-or-create (agentId, projectId) session 并激活。
	const handleSelectProject = useCallback(async (projectId: string | null) => {
		if (!activeAgentId) return;
		setActiveProject(projectId);
		if (!projectId) {
			// 回到 General:找已有的非项目 session,没有则新建一个。
			const existing = (sessionsByAgent[activeAgentId] ?? []).find((s) => !s.context?.projectId);
			if (existing) {
				await api().sessionsSwitch(activeAgentId, existing.id);
				setActiveSessionId(existing.id);
			} else {
				const session = await api().sessionsNew(activeAgentId);
				setActiveSessionId(session.id);
				clearMessages(session.id);
			}
			return;
		}
		// 进 project session:ensureForProject find-or-create。
		const { sessionId } = await api().sessionsEnsureForProject(activeAgentId, projectId);
		await api().sessionsSwitch(activeAgentId, sessionId);
		setActiveSessionId(sessionId);
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
	}, [activeAgentId, sessionsByAgent, setActiveProject, setActiveSessionId, clearMessages, setSessions]);

	// 初次挂载拉一次 projects(供 project 选择器)。
	useEffect(() => { fetchProjects(); }, [fetchProjects]);

	// Load sessions + land one when the USER picks an agent (pendingAgentId).
	// Keyed on pendingAgentId — NOT activeAgentId — because activeAgentId is now
	// derived from activeSessionId, and a programmatic jump (work trigger /
	// discuss) sets activeSessionId directly without going through selectAgent.
	// Keying on the derived value would either not fire (session's agentId
	// unchanged) or fire for the wrong reason and land General, clobbering the
	// jump target. pendingAgentId is set ONLY by selectAgent (the dropdown),
	// which is exactly when we want to load + land General.
	useEffect(() => {
		if (!pendingAgentId) return;
		if (loadedAgentRef.current === pendingAgentId) return;
		loadedAgentRef.current = pendingAgentId;

		refreshSessionData(pendingAgentId).catch(() => {
			// session_init event may still arrive later
		});
	}, [pendingAgentId]);

	// ─── Push-driven session list (N2) ────────────────────────────────
	// Background-created sessions (cron / delegate / project chat) emit a
	// data:changed `sessions` ping. Refetch the ACTIVE agent's session list on
	// each ping so the sidebar shows them immediately — no polling. We only
	// patch the list (setSessions); active-session selection / messages are
	// untouched (no inline-render wiring changes). Filters out the high-
	// frequency sessions UPDATEs at the source (SessionDB only emits
	// create/delete/archive, see N1).
	useEffect(() => {
		const unsub = api().onDataChanged((e: { collection?: string; changes?: Array<{ id?: string; op?: string; record?: { agentId?: string; archived?: boolean } }> }) => {
			if (e?.collection !== "sessions") return;
			const agentId = useChatStore.getState().activeSessionId
				? selectActiveAgentId(useChatStore.getState())
				: null;
			if (!agentId) return;
			// Refetch whenever a session touching this agent changes; the record
			// (when present) carries agentId so we can pre-filter, but a refetch is
			// cheap and keeps the sidebar canonical regardless.
			void api().sessionsList(agentId).then((sessions: SessionRecord[]) => {
				setSessions(agentId, sessions);
			}).catch(() => { /* ignore — next ping/nav refetches */ });
		});
		return () => { if (typeof unsub === "function") unsub(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ─── Pull-on-display ───────────────────────────────────────────
	// 切到某 session 时主动拉完整 init payload(messages + tokens + todos + 未决
	// AskUser)作为基线渲染,然后只对该 active session 收增量 push(AppLayout 已对
	// 非 active session 断 push)。这是"有 session 就一定能看到消息"的根基 ——
	// 服务端触发的 run(work/cron)没经 chat send(),user 消息只能靠这里拉回来。
	// 防回归:响应回来时若用户已切走(activeSessionId 变了)就不覆盖,切回会再 pull。
	useEffect(() => {
		if (!activeSessionId) return;
		const sid = activeSessionId;
		const issuedAt = Date.now();
		let cancelled = false;
		api().sessionsGetInit(sid).then((payload: any) => {
			if (cancelled || !payload) return;
			if (useChatStore.getState().activeSessionId !== sid) return;
			let messages: any[] = payload.messages ?? [];
			// 防回归:pull 发出后若有 live 事件更新过本 session(text_delta/tool_*),
			// 说明 live tail 比 pull 快照新 —— 不能整覆盖(会回退正在流式的内容)。
			// 但 pull 的价值是 user 消息/历史轮次(live 不带),所以合并:用 baseline
			// 的历史(去掉它的最后一条 assistant)+ store 里最新的 assistant 尾消息
			// (它更新)。这样既保住历史/user 消息,又不回退 live 流式内容。
			const lastEventAt = useChatStore.getState().lastEventAt[sid] ?? 0;
			if (lastEventAt > issuedAt) {
				const storeMsgs = useChatStore.getState().messagesBySession[sid] ?? [];
				const liveTail = [...storeMsgs].reverse().find((m) => m.role === "assistant");
				if (liveTail) {
					const baseNoTail = [...messages];
					for (let i = baseNoTail.length - 1; i >= 0; i--) {
						if (baseNoTail[i].role === "assistant") { baseNoTail.splice(i, 1); break; }
					}
					messages = [...baseNoTail, liveTail];
				}
			}
			loadMessages(sid, messages);
			// Mirror server-truth running state both ways. The streaming flag is
			// otherwise only flipped optimistically by send() — server-initiated
			// runs (work trigger / cron) have no path to flip it on the renderer,
			// so after a work-trigger jump the session looked idle. Pull is the
			// single authoritative checkpoint: isRunning reflects runStates.isBusy,
			// which sendProjectPrompt sets synchronously before returning.
			setIsStreaming(sid, !!payload.isRunning);
			updateContextInfo(sid, {
				usedTokens: payload.inputTokens ?? 0,
				contextWindow: payload.contextWindow ?? 128000,
				usage: payload.contextUsage ?? 0,
				inputTokens: payload.inputTokens ?? 0,
				outputTokens: payload.outputTokens ?? 0,
				totalTokens: payload.totalTokens ?? 0,
				model: payload.model,
			});
			setTodos(sid, payload.todos ?? []);
			setPending(
				sid,
				payload.pendingQuestion
					? {
							requestId: payload.pendingQuestion.requestId,
							agentId: activeAgentId ?? "",
							questions: payload.pendingQuestion.questions,
						}
					: null,
			);
		}).catch(() => { /* session 可能刚归档/不存在,静默 */ });
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeSessionId]);

	// Sync scroll to bottom — no animation, before paint
	useLayoutEffect(() => {
		const el = messagesContainerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	const send = async () => {
		const text = input.trim();
		// multimodal-input sub-5: allow attachment-only sends (no text). Either
		// text OR at least one pending attachment must be present.
		const attachments = pendingAttachments.map((p) => p.meta);
		if ((!text && attachments.length === 0) || !activeAgentId) return;

		// C2: if the session is already running, queue the input instead of
		// starting a concurrent run. The user message is not added to the
		// transcript optimistically — it appears as a real turn when the agent
		// drains the queue (or is injected at the next step if promoted).
		//
		// NOTE: the input queue is text-only (enqueueInput carries a string).
		// Attachments are therefore only sent when the session is idle; if the
		// session is running, an attachment-only / text+attachment send is a
		// no-op (the Send button is swapped to Stop, so the user can't reach
		// this path with attachments anyway). Queued-attachment support is out
		// of sub-5 scope.
		if (isStreaming && activeSessionId) {
			if (!text || attachments.length > 0) return;
			setInput("");
			await enqueueInput(activeSessionId, text);
			return;
		}

		// Messages are sessionId-keyed — never fall back to an agentId bucket
		// (would leak into a phantom bucket). send is only reachable after a
		// session is active (UI gating), but guard regardless.
		if (!activeSessionId) return;
		const sid = activeSessionId;
		// Optimistic user message: carry the attachment meta so the renderer
		// shows the chips immediately (principle A — only meta; the image thumb
		// will re-fetch via attachments:content just like a history message).
		addMessage(sid, {
			id: nextMsgId(),
			role: "user",
			text,
			timestamp: Date.now(),
			...(attachments.length > 0 ? { attachments } : {}),
		});
		setInput("");
		// Clear the pending attachments + revoke their local preview URLs (the
		// optimistic message will re-fetch via the content endpoint).
		for (const p of pendingAttachments) {
			if (p.previewUrl) {
				URL.revokeObjectURL(p.previewUrl);
				previewUrlsRef.current.delete(p.previewUrl);
			}
		}
		setPendingAttachments([]);
		// NOTE: isStreaming is NOT set optimistically here. The server is the
		// single source of truth for session running state — agent-service
		// markRunning emits "session_running" when isBusy flips true, which
		// AppLayout routes to setIsStreaming(sid, true). The button/Stop state
		// follows that event so chat / cron / work-trigger / recovery all behave
		// identically. The empty assistant placeholder below is content
		// scaffolding (the "Thinking…" bubble), independent of the running flag.

		addMessage(sid, {
			id: nextMsgId(),
			role: "assistant",
			text: "",
			timestamp: Date.now(),
			streaming: true,
			blocks: [],
		});

		await api().chatSend(text, activeAgentId, activeSessionId ?? undefined, attachments);
	};

	const abort = () => {
		if (activeSessionId) finishStreaming(activeSessionId);
		// Session-scoped: stop ONLY this session's loop. Passing the sessionId
		// is mandatory — the backend no-arg/agent fallback would cascade-stop
		// other sessions of the same agent.
		if (activeSessionId) api().chatAbort(activeSessionId);
	};

	const handleArchiveSession = async () => {
		if (!activeAgentId || !activeSessionId) return;
		setShowArchiveConfirm(false);
		// 运行中先中断(防 runtime loop 残留 + 丢弃未完成输出)——只停本 session。
		if (isStreaming) {
			api().chatAbort(activeSessionId);
			finishStreaming(activeSessionId);
		}
		try {
			const oldSessionId = activeSessionId;
			const result = await api().sessionsArchive(activeAgentId, oldSessionId);
			// 清前端老 session 消息,切到接替的新 session,刷新列表
			clearMessages(oldSessionId);
			const sessions = await api().sessionsList(activeAgentId);
			setSessions(activeAgentId, sessions);
			const activateResult = await api().sessionsActivate(activeAgentId, result.newSessionId);
			const newId = activateResult?.sessionId ?? result.newSessionId;
			setActiveSessionId(newId);
			clearMessages(newId);
		} catch (e) {
			console.error("archive session failed:", e);
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

	// Input is never locked: when the session is running, Enter enqueues the
	// message (send() routes to enqueueInput) rather than dispatching. The
	// running vs idle distinction is expressed only by the Send/Stop button
	// swap and the enqueue-on-Enter behavior — not by disabling the textarea.

	const startEdit = (msg: typeof messages[number]) => {
		setEditingMsgId(msg.id);
		setEditText(msg.text);
	};

	const cancelEdit = () => {
		setEditingMsgId(null);
		setEditText("");
	};

	const saveEdit = async (msg: typeof messages[number]) => {
		if (!activeAgentId || !activeSessionId || !editText.trim()) return;
		const seq = parseMsgSeq(msg.id);
		await api().messagesEdit(activeAgentId, seq, editText.trim());
		editMessage(activeSessionId, msg.id, editText.trim());
		setEditingMsgId(null);
		setEditText("");
	};

	const handleDeleteMsg = async (msg: typeof messages[number]) => {
		if (!activeAgentId || !activeSessionId) return;
		if (!confirm("Delete this message?")) return;
		const seq = parseMsgSeq(msg.id);
		await api().messagesDelete(activeAgentId, seq);
		deleteMessage(activeSessionId, msg.id);
	};

	// Requirement discussion: handle status transitions
	const handleRequirementTransition = async (toStatus: RequirementStatus) => {
		if (!activeRequirementId || !activeRequirement) return;
		try {
			await transitionStatus(activeRequirementId, toStatus, "user");
			// If transitioning away from discussion, record a message
			await sendReqMessage(activeRequirementId, "user", `Status changed to: ${toStatus}`);
		} catch (err) {
			console.error("Failed to transition requirement:", err);
		}
	};

	const handleCloseRequirement = () => {
		setActiveRequirementId(null);
		setActivePage("requirements");
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
			{/* Requirement discussion header */}
			{activeRequirementId && activeRequirement && (
				<RequirementHeader
					requirement={activeRequirement}
					onTransition={handleRequirementTransition}
					onClose={handleCloseRequirement}
				/>
			)}

			<div className="chat-header">
				<select
					className="chat-agent-select"
					aria-label="Select Agent"
					value={activeAgentId ?? ""}
					onChange={(e) => {
						// M5: 切 agent → selectAgent 设 pendingAgentId + 清 activeSessionId/
						// activeProjectId(null = General)。agent-load effect 随后 land 一个
						// 该 agent 的 session。
						selectAgent(e.target.value || null);
					}}
				>
					<option value="">-- Select Agent --</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>{a.name}</option>
					))}
				</select>

				{activeAgentId && (
					<select
						className="chat-agent-select"
						aria-label="Select Project context"
						title="项目语境:General = 非项目单例;选某 project = 进该 project 的 session"
						value={activeProjectId ?? ""}
						onChange={(e) => handleSelectProject(e.target.value || null)}
					>
						<option value="">General</option>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>{p.name}</option>
						))}
					</select>
				)}

				{contextInfo && (
					<div className="context-usage">
						{contextInfo.model && (
							<span
								className="context-usage-model"
								title={contextInfo.model.providerName ? `${contextInfo.model.providerName}/${contextInfo.model.modelId}` : contextInfo.model.modelId}
							>
								{contextInfo.model.modelId}
							</span>
						)}
						<span className="context-usage-text">
							{contextInfo.inputTokens > 0
								? <>{formatTokenCount(contextInfo.inputTokens)} in · {formatTokenCount(contextInfo.outputTokens)} out | {formatTokenCount(contextInfo.contextWindow)}</>
								: <>{formatTokenCount(contextInfo.usedTokens)} / {formatTokenCount(contextInfo.contextWindow)}</>}
						</span>
						<div className="context-usage-bar">
							<div
								className="context-usage-fill"
								style={{
									width: Math.min(contextInfo.usage * 100, 100) + "%",
									background: contextInfo.usage > 0.7 ? "var(--danger, #f85149)" : contextInfo.usage > 0.5 ? "var(--warning, #d29922)" : "var(--success, #7ee787)",
								}}
							/>
						</div>
					</div>
				)}

				{activeAgentId && activeSessionId && (
					<button
						type="button"
						className="btn-archive-session"
						onClick={() => setShowArchiveConfirm(true)}
						title="归档当前会话(移到归档区,新建一个干净的同项目 session 接替)"
					>
						归档
					</button>
				)}
			</div>

			<ErrorBanner />

			{/* C2: todos pinned to the top so they don't overlap the input queue strip. */}
			{todos.length > 0 && <TodosList todos={todos} />}

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
								{/* multimodal-input sub-5: render a user message's attachment META
								    as thumbnails/chips. Image bytes are fetched on demand via the
								    attachments:content endpoint (component 8); pdf/file are static
								    chips. Only meta flows here (principle A). */}
								{msg.role === "user" && msg.attachments && msg.attachments.length > 0 && activeSessionId && (
									<div className="message-attachments">
										{msg.attachments.map((meta) => (
											<HistoryAttachmentView
												key={meta.id}
												meta={meta}
												sessionId={activeSessionId}
											/>
										))}
									</div>
								)}
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

			{activePending && (
				<AskUserCard
					requestId={activePending.requestId}
					questions={activePending.questions}
					onDone={() => activeSessionId && setPending(activeSessionId, null)}
				/>
			)}

			{/* C2: queued inputs (submitted while running) — sits right above the input bar. */}
			<InputQueueStrip />

			<div
				className={`chat-input-bar${isDragging ? " chat-input-bar-dragging" : ""}`}
				onDrop={handleDrop}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
			>
				{/* multimodal-input sub-5: hidden file input driven by the + button.
				    multiple + no accept restriction → images / PDF / any file. The
				    class .sr-only-attach keeps it in the a11y tree (visually hidden)
				    so a screen reader still announces it; the + button relays focus
				    by calling its click() handler. */}
				<input
					ref={fileInputRef}
					type="file"
					multiple
					className="sr-only-attach"
					aria-label="Add attachments"
					title="Add attachments (image / PDF / file)"
					onChange={handleFileInputChange}
				/>
				<button
					type="button"
					className="btn-attach"
					onClick={() => fileInputRef.current?.click()}
					disabled={!activeAgentId || isStreaming}
					title="Add attachments (image / PDF / file)"
				>
					+
				</button>
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					placeholder={
						!activeAgentId ? "Select an agent first..."
						: isStreaming ? "运行中,回车将加入队列(可立即插入)..."
						: "Type a message… (paste / drop / + to attach)"
					}
					/* Input is always available once an agent is selected. While the
					   session is running, Enter enqueues (send() routes to enqueueInput)
					   instead of dispatching immediately. */
					disabled={!activeAgentId}
					rows={1}
				/>
				{isStreaming ? (
					<button type="button" onClick={abort} className="btn-abort">Stop</button>
				) : (
					<button
						type="button"
						onClick={send}
						/* Allow attachment-only sends: enabled when there's text OR a
						   pending attachment (and an agent is selected). */
						disabled={!activeAgentId || (!input.trim() && pendingAttachments.length === 0)}
					>
						Send
					</button>
				)}
			</div>
			{/* multimodal-input sub-5: pending attachments preview strip. Sits above
			    the input bar; image thumbnails use LOCAL object URLs (no round-trip). */}
			{(pendingAttachments.length > 0 || uploadError) && (
				<div className="chat-input-attachments">
					{uploadError && <div className="attach-upload-error">{uploadError}</div>}
					{pendingAttachments.map(({ meta, previewUrl }) => (
						<PendingAttachmentChip
							key={meta.id}
							meta={meta}
							previewUrl={previewUrl}
							onRemove={() => removePendingAttachment(meta.id)}
						/>
					))}
				</div>
			)}

			{showArchiveConfirm && (
				<ConfirmModal
					title="归档当前会话"
					message={
						isStreaming
							? "该会话正在运行,归档将中断当前任务并丢弃未完成输出。会话记录会保留在归档区,系统会新建一个干净的会话接替。确认归档?"
							: "归档后该会话从列表移除(记录保留),系统会新建一个干净的同项目会话接替。确认归档?"
					}
					confirmLabel="归档"
					onConfirm={handleArchiveSession}
					onCancel={() => setShowArchiveConfirm(false)}
				/>
			)}
		</main>
	);
}
