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
import { useChatStore, selectActiveMessages, selectIsStreaming, selectLastError, selectContextInfo, nextMsgId, type MessageBlock, type ToolCallBlock, type ThinkingBlock } from "../../store/chat-store.js";
import { useAgentStore } from "../../store/agent-store.js";
import { useProjectStore } from "../../store/project-store.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";
import AskUserCard from "../chat/AskUserCard.js";
import TodosList from "../chat/TodosList.js";
import { useInteractionStore } from "../../store/interaction-store.js";
import { usePageStore } from "../../store/page-store.js";
import { useRequirementStore } from "../../store/requirement-store.js";
import RequirementHeader from "../requirements/RequirementHeader.js";
import type { RequirementStatus, ProjectJobRecord, SessionRecord } from "../../../shared/types.js";

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
		bash: "Shell", shell: "Shell", read: "Read", write: "Write", edit: "Edit",
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
				activeAgentId, activeSessionId, activeProjectId, sessionsByAgent,
				addMessage, finishStreaming, setActiveAgent,
				setSessions, setActiveSessionId, setActiveProject, clearMessages,
				editMessage, deleteMessage, setIsStreaming,
				updateContextInfo,
			} = useChatStore();
	const messages = useChatStore(selectActiveMessages);
	const isStreaming = useChatStore(selectIsStreaming);
	const contextInfo = useChatStore(selectContextInfo);
	const { agents } = useAgentStore();
	const { projects, fetchProjects } = useProjectStore();
	const { pendingQuestions, setPendingQuestions, todosByAgent } = useInteractionStore();
	const { activeRequirementId, setActiveRequirementId, setActivePage } = usePageStore();
	const { requirements, transitionStatus, sendMessage: sendReqMessage } = useRequirementStore();
	const activeRequirement = activeRequirementId
		? requirements.find((r) => r.id === activeRequirementId)
		: undefined;
	const todos = activeAgentId ? (todosByAgent[activeAgentId] ?? []) : [];
	const [input, setInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const loadedAgentRef = useRef<string | null>(null);
	const [showSessions, setShowSessions] = useState(false);
	const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	// M5: 当前 project 的后台任务记录(供输入锁:running → 临时锁;sessionId 命中 → worker session 永久只读)。
	const [activeProjectJobs, setActiveProjectJobs] = useState<ProjectJobRecord[]>([]);

	const refreshSessionData = useCallback(async (agentId: string) => {
		const sessions = await api().sessionsList(agentId);
		setSessions(agentId, sessions);
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

	// M5: 拉当前 project 的后台任务记录(输入锁用)。
	const refreshProjectJobs = useCallback(async (projectId: string | null) => {
		if (!projectId) { setActiveProjectJobs([]); return; }
		try {
			const jobs = await api().projectsListJobs(projectId);
			setActiveProjectJobs(jobs);
		} catch { /* project_jobs 端点可能未就绪,静默 */ }
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
			await refreshProjectJobs(null);
			return;
		}
		// 进 project session:ensureForProject find-or-create。
		const { sessionId } = await api().sessionsEnsureForProject(activeAgentId, projectId);
		await api().sessionsSwitch(activeAgentId, sessionId);
		setActiveSessionId(sessionId);
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
		await refreshProjectJobs(projectId);
	}, [activeAgentId, sessionsByAgent, setActiveProject, setActiveSessionId, clearMessages, setSessions, refreshProjectJobs]);

	// 初次挂载拉一次 projects(供 project 选择器)。
	useEffect(() => { fetchProjects(); }, [fetchProjects]);

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
		if (!text || !activeAgentId || isStreaming || isInputLocked) return;

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
		// M5: "+" 现在意味"回到 General 单例"(不再每次新建,违反"非项目只一个")。
		setShowSessions(false);
		await handleSelectProject(null);
	};

	const handleSwitchSession = async (sessionId: string) => {
		if (!activeAgentId) return;
		await api().sessionsSwitch(activeAgentId, sessionId);
		setActiveSessionId(sessionId);
		// M5: 同步 project 选择器 —— 从该 session 的 context 推 activeProjectId。
		const sessions = await api().sessionsList(activeAgentId);
		setSessions(activeAgentId, sessions);
		const target = sessions.find((s: SessionRecord) => s.id === sessionId);
		setActiveProject(target?.context?.projectId ?? null);
		await refreshProjectJobs(target?.context?.projectId ?? null);
		setShowSessions(false);
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

	// M5: 对话保护(工作时的开关,非写死)。
	//   - hasRunningJob: 当前 project 有 running 任务 → 临时锁输入(防干扰运行中的充实)。
	//   - activeSessionIsWorker: 当前 session 关联了 job 记录 → 它是 worker session(充实现场),
	//     永久只读(用户只看不聊)。两条都从 project_jobs 派生,不硬编码角色判断。
	const hasRunningJob = activeProjectJobs.some((j) => j.status === "running");
	const activeSessionIsWorker = activeProjectJobs.some((j) => j.sessionId === activeSessionId);
	const isInputLocked = hasRunningJob || activeSessionIsWorker;

	// M5: session 显示名 = project 名 / "General"。
	const projectNameById = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects) m.set(p.id, p.name);
		return m;
	}, [projects]);
	const sessionLabel = (s: typeof sessions[number]) => {
		const pid = s.context?.projectId;
		return pid ? (projectNameById.get(pid) ?? "Project") : "General";
	};

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
						// M5: 切 agent → setActiveAgent 已重置 activeProjectId=null(→ General)。
						// 这里清掉本组件的 job 视图,并落 General session。
						setActiveAgent(e.target.value || null);
						refreshProjectJobs(null);
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
											{sessionLabel(s)}
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

			{pendingQuestions && pendingQuestions.agentId === activeAgentId && (
				<AskUserCard
					requestId={pendingQuestions.requestId}
					questions={pendingQuestions.questions}
					onDone={() => setPendingQuestions(null)}
				/>
			)}

			<div className="chat-input-bar">
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={
						!activeAgentId ? "Select an agent first..."
						: isInputLocked ? (activeSessionIsWorker ? "只读 session(archivist 工作现场,用户只看不聊)" : "任务运行中,暂停输入...")
						: "Type a message..."
					}
					disabled={!activeAgentId || isStreaming || isInputLocked}
					rows={1}
				/>
				{isStreaming ? (
					<button type="button" onClick={abort} className="btn-abort">Stop</button>
				) : (
					<button type="button" onClick={send} disabled={!activeAgentId || !input.trim() || isInputLocked}>Send</button>
				)}
			</div>
		</main>
	);
}
