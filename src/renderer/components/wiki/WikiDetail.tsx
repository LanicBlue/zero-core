// Wiki 详情组件(wiki-system-redesign plan-06 §6 · 5 tabs)
//
// # 文件说明书
//
// ## 核心功能
// 选中 wiki 节点的详情面板,拆 5 个 tab:
//
//   Overview | Content | Relations | Source | History
//
//   - Overview:summary / kind / revision / attributes / sync 状态
//   - Content:Markdown 渲染(react-markdown + remark-gfm)。**不**加 rehype-raw
//     —— react-markdown v10 默认不执行 raw HTML,script/event handler/javascript:
//     URL 一律 escape(acceptance-06 §D.2/§H「Markdown 原始 HTML 可执行脚本」
//     拒绝条件)。编辑发 expected_revision。
//   - Relations:incoming / outgoing 分组 + link/unlink;局部刷新。
//   - Source:indexed / workspace 选择 + revision / dirty / stale + 范围读取。
//     不能打开仓库外文件(后端沙箱强制 resolve+relative 防 `../`)。
//   - History:audit log(plan-06 §6 §D7;调 wikiV2History = WikiService.listHistory)。
//
// ## 关键不变量(plan-06 §6 / acceptance-06 §D)
//   - **并发 conflict**:WRITE_CONFLICT 错误保留用户编辑,显示 server revision,
//     要求重新加载/合并,不静默覆盖(§D.4)。
//   - **expected_revision**:edit 必带(乐观并发);未携带 → server 拒。
//   - **source-bound 结构按钮禁用**:kind=source_file/source_symlink/source_submodule
//     的 create/move/delete 按钮禁用并解释 Git ownership。
//   - **canonical path 仅显示,不拼 file://**(plan-06 UI 安全)。
//
// ## 输入
//   - path: 选中节点的 canonical path(从 store.selectedPath)
//
import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWikiStore } from "../../store/wiki-store.js";
import { useNotificationStore } from "../../store/notification-store.js";
import type {
	WikiNodeView, WikiLinkView, WikiNodeKind, WikiMutationResult,
} from "../../../shared/wiki-types.js";

type Tab = "overview" | "content" | "relations" | "source" | "history";

const TABS: { key: Tab; label: string }[] = [
	{ key: "overview", label: "Overview" },
	{ key: "content", label: "Content" },
	{ key: "relations", label: "Relations" },
	{ key: "source", label: "Source" },
	{ key: "history", label: "History" },
];

/**
 * Source-bound kinds(plan-06 §D.8 / design.md §5.1)。结构 create/move/delete
 * 由 Git mirror indexer 维护;UI 按钮禁用并解释。
 */
const SOURCE_BOUND_KINDS: ReadonlySet<WikiNodeKind> = new Set([
	"source_file", "source_symlink", "source_submodule",
]);

interface Props {
	path: string | null;
}

export default function WikiDetail({ path }: Props) {
	const [tab, setTab] = useState<Tab>("overview");

	// 切节点 → 回到 overview tab。
	useEffect(() => { setTab("overview"); }, [path]);

	const loadDetail = useWikiStore((s) => s.loadDetail);
	const loadRelations = useWikiStore((s) => s.loadRelations);
	const loadSource = useWikiStore((s) => s.loadSource);
	const loadHistory = useWikiStore((s) => s.loadHistory);

	// 切到 Content/Relations/Source/History tab 时懒加载对应数据。
	useEffect(() => {
		if (!path) return;
		if (tab === "content" || tab === "overview") void loadDetail(path, "all");
		if (tab === "relations") void loadRelations(path);
		if (tab === "source") void loadSource(path);
		if (tab === "history") void loadHistory(path);
	}, [path, tab, loadDetail, loadRelations, loadSource, loadHistory]);

	if (!path) {
		return (
			<div style={{
				padding: 40, textAlign: "center",
				color: "var(--text-tertiary, #555)", fontSize: 13,
			}}>
				Select a node from the tree to view details.
			</div>
		);
	}

	return (
		<div data-testid="wiki-detail" style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			<TabHeader path={path} tab={tab} onTab={setTab} />
			<div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
				{tab === "overview" && <OverviewTab path={path} />}
				{tab === "content" && <ContentTab path={path} />}
				{tab === "relations" && <RelationsTab path={path} />}
				{tab === "source" && <SourceTab path={path} />}
				{tab === "history" && <HistoryTab path={path} />}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Tab header
// ---------------------------------------------------------------------------

function TabHeader({ path, tab, onTab }: { path: string; tab: Tab; onTab: (t: Tab) => void }) {
	const summary = useWikiStore((s) => s.summaryByPath[path]);
	return (
		<div style={{
			borderBottom: "1px solid var(--border-color, #333)",
			padding: "0 16px",
			display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
		}}>
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{
					fontSize: 13, fontWeight: 600, fontFamily: "monospace",
					color: "var(--text-primary, #e0e0e0)", wordBreak: "break-all",
				}}>
					{summary?.displayTitle || path}
				</div>
				<div style={{
					fontSize: 11, color: "var(--text-tertiary, #555)",
					fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
				}}>
					{path}
				</div>
			</div>
			{TABS.map((t) => (
				<button
					key={t.key}
					type="button"
					onClick={() => onTab(t.key)}
					data-testid={`wiki-tab-${t.key}`}
					style={tab === t.key ? activeTabStyle : inactiveTabStyle}
				>
					{t.label}
				</button>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({ path }: { path: string }) {
	const detail = useWikiStore((s) => s.detailByPath[path]);
	const summary = useWikiStore((s) => s.summaryByPath[path]);
	const node: WikiNodeView | undefined = detail?.node;

	if (!node) {
		return <div style={{ fontSize: 12, color: "var(--text-tertiary, #555)" }}>Loading…</div>;
	}

	return (
		<div>
			<Field label="Kind" value={node.kind} />
			<Field label="Revision" value={String(node.revision)} />
			<Field label="Display name" value={node.displayTitle} />
			<Field label="Parent" value={node.parentPath ?? "(root)"} />
			<Field label="Source-bound" value={node.sourceBound ? "yes (Git mirror)" : "no"} />
			<Field label="Archived" value={node.archivedAt ? `at ${node.archivedAt}` : "no"} />
			<Field label="Created" value={node.createdAt} />
			<Field label="Updated" value={node.updatedAt} />

			{node.summary && (
				<div style={{ marginTop: 16 }}>
					<div style={fieldLabelStyle}>Summary</div>
					<div style={fieldBoxStyle}>{node.summary}</div>
				</div>
			)}

			{Object.keys(node.attributes).length > 0 && (
				<div style={{ marginTop: 16 }}>
					<div style={fieldLabelStyle}>Attributes</div>
					<pre style={preStyle}>{JSON.stringify(node.attributes, null, 2)}</pre>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Content tab — Markdown GFM;react-markdown v10 默认 escape raw HTML(XSS-safe)
// ---------------------------------------------------------------------------

function ContentTab({ path }: { path: string }) {
	const detail = useWikiStore((s) => s.detailByPath[path]);
	const loadDetail = useWikiStore((s) => s.loadDetail);
	const updateNode = useWikiStore((s) => s.updateNode);
	const addError = useNotificationStore((s) => s.addError);
	const [editing, setEditing] = useState(false);
	const [draftSummary, setDraftSummary] = useState("");
	const [draftContent, setDraftContent] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [conflictInfo, setConflictInfo] = useState<{ serverRevision: number | null } | null>(null);

	// stale-while-editing snapshot —— 进入 edit mode 时拍当前 detail 快照
	// (node + content)。editing 期间即使 store 的 detailByPath[path] 被
	// live-update 失效/重写(plan-06 §7 _applyNodeEvent 删 detail),ContentTab
	// 仍从 snapshot + draft 渲染 edit UI,不进 loading 态、Save 按钮不消失、
	// draft 不丢(acceptance §H.4 race + §E 草稿不丢契约)。
	const [editSnapshot, setEditSnapshot] = useState<{
		node: WikiNodeView;
		content: string;
	} | null>(null);

	// handleEditStart 同步拍快照 + 种 draft(不用 useEffect):editing=true 与
	// editSnapshot 设置在同一事件中完成,React 18 批处理 → 单次重渲染,避免
	// useEffect 异步触发期间出现 editing=true 但 editSnapshot=null 的中间态
	// (那个中间态会落到 Loading 分支,edit UI 一闪即丢)。**不**依赖 detail:
	// 否则 editing 期间 store 失效/重写 detail 会覆盖用户 draft。
	const handleEditStart = () => {
		const node = detail?.node;
		if (!node) return; // Edit 按钮仅在 detail 存在时渲染,这里只是兜底。
		setDraftSummary(node.summary ?? "");
		setDraftContent(detail?.content ?? "");
		setConflictInfo(null);
		setEditSnapshot({ node, content: detail?.content ?? "" });
		setEditing(true);
	};

	const handleSave = async () => {
		// 从 snapshot 读 base revision —— editing 期间 store 的 detail 可能已被
		// live-update 失效,直接读 detail.node.revision 会让 expected_revision
		// 错位(detail 为 undefined 时更会让 Save 早退 —— §H.4 race 暴露的 bug)。
		const base = editSnapshot ?? detail;
		if (!base?.node) return;
		setSubmitting(true);
		setConflictInfo(null);
		const result = await updateNode({
			address: path,
			expected_revision: base.node.revision,
			summary: draftSummary,
			content: draftContent,
		});
		setSubmitting(false);
		if (result === null) {
			// updateNode 已 addError。判断是否 WRITE_CONFLICT — 通过 store 失效
			// 后再次 loadDetail 拉新 revision,UI 提示用户合并。
			// 简化:任何失败都保留 draft,显示 conflict 提示。
			setConflictInfo({ serverRevision: null });
			// 重新拉最新 revision,提示用户。
			await loadDetail(path, "all");
			return;
		}
		setEditing(false);
		setEditSnapshot(null);
	};

	const handleCancel = () => {
		setEditing(false);
		setConflictInfo(null);
		setEditSnapshot(null);
		// 编辑期间 store detail 若已被 live-update 失效,cancel 后 load useEffect
		// 的 deps(path/tab)未变不会自动重拉 → UI 卡 Loading。手动拉一次恢复显示。
		if (!useWikiStore.getState().detailByPath[path]) {
			void loadDetail(path, "all");
		}
	};

	// stale-while-editing:editing 期间从 snapshot 渲染 edit UI,**先于** `!detail`
	// 的 Loading 态。否则 store 失效 detail 后 ContentTab 重渲染进 Loading,edit
	// UI 消失、Save 按钮 timeout(acceptance §H.4 round-2 race 暴露的真实 UX bug)。
	// snapshot 在 handleEditStart 中同步设置(与 setEditing 在同一事件中批处理),
	// 所以 editing=true 时 editSnapshot 必然非空;`&& editSnapshot` 是防御性兜底。
	if (editing && editSnapshot) {
		return (
			<div>
				<div style={{ fontSize: 12, color: "var(--text-tertiary, #555)", marginBottom: 8 }}>
					Editing at revision <code>{editSnapshot.node.revision}</code>.
					Server will reject if the node changed (WRITE_CONFLICT); your draft is preserved.
				</div>
				{conflictInfo && (
					<div data-testid="wiki-conflict-banner" style={{
						padding: 10, marginBottom: 10,
						background: "rgba(244,67,54,0.1)",
						border: "1px solid #f44336", borderRadius: 4,
						fontSize: 12, color: "#f44336",
					}}>
						<strong>Conflict:</strong> the node was modified on the server (revision now{" "}
						<code>{useWikiStore.getState().detailByPath[path]?.node?.revision ?? "?"}</code>).
						Your local draft is preserved. Reload to merge or re-apply.
						<button
							type="button"
							onClick={() => void loadDetail(path, "all")}
							style={{ marginLeft: 8, ...inlineBtnStyle }}
						>
							Reload server version
						</button>
					</div>
				)}
				<label style={fieldLabelStyle}>Summary</label>
				<textarea
					value={draftSummary}
					onChange={(e) => setDraftSummary(e.target.value)}
					style={textareaStyle}
					aria-label="Wiki node summary"
					data-testid="wiki-edit-summary"
				/>
				<label style={{ ...fieldLabelStyle, marginTop: 8 }}>Content (Markdown/GFM; raw HTML will be escaped on render)</label>
				<textarea
					value={draftContent}
					onChange={(e) => setDraftContent(e.target.value)}
					style={{ ...textareaStyle, minHeight: 240 }}
					aria-label="Wiki node content"
					data-testid="wiki-edit-content"
				/>
				<div style={{ marginTop: 8, display: "flex", gap: 8 }}>
					<button
						type="button"
						onClick={handleSave}
						disabled={submitting}
						style={primaryBtnStyle}
						data-testid="wiki-edit-save"
					>
						{submitting ? "Saving…" : "Save"}
					</button>
					<button
						type="button"
						onClick={handleCancel}
						style={ghostBtnStyle}
					>
						Cancel
					</button>
				</div>
			</div>
		);
	}

	if (!detail) {
		return <div style={{ fontSize: 12, color: "var(--text-tertiary, #555)" }}>Loading…</div>;
	}

	if (detail.error) {
		return <div style={{ fontSize: 12, color: "#f44336" }}>{detail.error}</div>;
	}

	return (
		<div>
			{detail.content === undefined ? (
				<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)", fontStyle: "italic" }}>
					No body content for this node.
				</div>
			) : (
				<div data-testid="wiki-content-rendered" style={markdownContainerStyle}>
					{/*
						react-markdown v10 默认 escape raw HTML — 不配 rehype-raw 时,
						script 标签 / inline event handler / javascript-colon URL 等
						都被 escape 而不执行(acceptance-06 §D.2 / plan-06 UI 安全)。
						**不要**为「方便」加 rehype-raw —— 那会让 raw HTML 进入 DOM,
						需 sanitizer 白名单 + XSS 测试覆盖。当前不需要 raw HTML 渲染,
						默认配置足够。
					*/}
					<ReactMarkdown remarkPlugins={[remarkGfm]}>
						{detail.content || ""}
					</ReactMarkdown>
				</div>
			)}
			<div style={{ marginTop: 16 }}>
				<button
					type="button"
					onClick={handleEditStart}
					style={primaryBtnStyle}
					data-testid="wiki-edit-start"
				>
					Edit
				</button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Relations tab — incoming / outgoing + link/unlink
// ---------------------------------------------------------------------------

function RelationsTab({ path }: { path: string }) {
	const relations = useWikiStore((s) => s.relationsByPath[path]);
	const linkNodes = useWikiStore((s) => s.linkNodes);
	const unlinkNodes = useWikiStore((s) => s.unlinkNodes);
	const addError = useNotificationStore((s) => s.addError);

	const [newTarget, setNewTarget] = useState("");
	const [newRelation, setNewRelation] = useState("related_to");

	const handleLink = async () => {
		if (!newTarget.trim()) return;
		const result = await linkNodes({
			source: path,
			target: newTarget.trim(),
			relation: newRelation,
		});
		if (result) {
			setNewTarget("");
		} else {
			addError("link failed");
		}
	};

	const handleUnlink = async (l: WikiLinkView) => {
		await unlinkNodes({
			source: l.sourcePath,
			target: l.targetPath,
			relation: l.relation,
		});
	};

	if (!relations) {
		return <div style={{ fontSize: 12, color: "var(--text-tertiary, #555)" }}>Loading…</div>;
	}
	if (relations.error) {
		return <div style={{ fontSize: 12, color: "#f44336" }}>{relations.error}</div>;
	}

	return (
		<div>
			<RelationsGroup
				title="Outgoing"
				links={relations.outgoing}
				path={path}
				onUnlink={handleUnlink}
			/>
			<RelationsGroup
				title="Incoming"
				links={relations.incoming}
				path={path}
				onUnlink={handleUnlink}
			/>

			<div style={{ marginTop: 16, padding: 10, background: "var(--bg-secondary, #1c1c1e)", borderRadius: 6 }}>
				<div style={fieldLabelStyle}>Add outgoing link</div>
				<div style={{ display: "flex", gap: 6, marginTop: 4 }}>
					<input
						type="text"
						value={newTarget}
						onChange={(e) => setNewTarget(e.target.value)}
						placeholder="target canonical path (wiki-root/...)"
						style={inputStyle}
						aria-label="New link target path"
					/>
					<input
						type="text"
						value={newRelation}
						onChange={(e) => setNewRelation(e.target.value)}
						placeholder="relation"
						style={{ ...inputStyle, flex: "0 0 140px" }}
						aria-label="New link relation"
					/>
					<button type="button" onClick={handleLink} style={primaryBtnStyle}>Link</button>
				</div>
			</div>
		</div>
	);
}

function RelationsGroup({
	title, links, path, onUnlink,
}: {
	title: string;
	links: WikiLinkView[];
	path: string;
	onUnlink: (l: WikiLinkView) => void;
}) {
	return (
		<div style={{ marginBottom: 16 }}>
			<div style={fieldLabelStyle}>{title} ({links.length})</div>
			{links.length === 0 ? (
				<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)", fontStyle: "italic" }}>None.</div>
			) : (
				<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
					<tbody>
						{links.map((l, i) => {
							// Show the OTHER endpoint (incoming → show source;outgoing → show target)。
							const otherPath = l.sourcePath === path ? l.targetPath : l.sourcePath;
							return (
								<tr key={`${l.sourcePath}|${l.targetPath}|${l.relation}|${i}`}>
									<td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-color, #333)" }}>
										<code>{otherPath}</code>
										<div style={{ fontSize: 10, color: "var(--text-tertiary, #555)" }}>{l.relation}</div>
									</td>
									<td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-color, #333)", textAlign: "right" }}>
										<button type="button" onClick={() => onUnlink(l)} style={ghostBtnStyle}>
											Unlink
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Source tab — indexed/workspace source view
// ---------------------------------------------------------------------------

function SourceTab({ path }: { path: string }) {
	const source = useWikiStore((s) => s.sourceByPath[path]);
	const detail = useWikiStore((s) => s.detailByPath[path]);
	const readWorkspaceDoc = useWikiStore((s) => s.readWorkspaceDoc);
	const addError = useNotificationStore((s) => s.addError);
	const [workspaceContent, setWorkspaceContent] = useState<string | null>(null);
	const [loadingWs, setLoadingWs] = useState(false);

	const node = detail?.node;
	const isSourceBound = node ? SOURCE_BOUND_KINDS.has(node.kind) || node.sourceBound : false;

	const handleReadWorkspace = async () => {
		if (!source?.sourcePath) {
			addError("no source path bound to this node");
			return;
		}
		// extract projectId from canonical path: wiki-root/projects/<projectId>/...
		const m = path.match(/^wiki-root\/projects\/([^/]+)\//);
		const projectId = m ? m[1] : null;
		if (!projectId) {
			addError("cannot resolve projectId from path (source tab is for project mirror nodes)");
			return;
		}
		setLoadingWs(true);
		const res = await readWorkspaceDoc(projectId, source.sourcePath);
		setLoadingWs(false);
		if (res.error) {
			addError(res.error);
			setWorkspaceContent(null);
			return;
		}
		setWorkspaceContent(res.content ?? "");
	};

	if (!source) {
		return <div style={{ fontSize: 12, color: "var(--text-tertiary, #555)" }}>Loading…</div>;
	}
	if (source.error) {
		return <div style={{ fontSize: 12, color: "#f44336" }}>{source.error}</div>;
	}

	return (
		<div>
			{!source.repositoryId ? (
				<div style={{ fontSize: 12, color: "var(--text-tertiary, #555)" }}>
					This node is not bound to a source repository. Source view is only available
					for project mirror nodes (kind: source_file / source_symlink / source_submodule).
				</div>
			) : (
				<>
					<Field label="Repository" value={source.repositoryId} />
					<Field label="Source path" value={source.sourcePath ?? "?"} />
					<Field label="Indexed revision" value={source.indexedRevision ?? "(none)"} />
					<Field label="Sync status" value={source.syncStatus ?? "(unknown)"} />

					{isSourceBound && (
						<div style={{
							marginTop: 12, padding: 8, fontSize: 11,
							background: "rgba(244,180,0,0.08)",
							border: "1px solid rgba(244,180,0,0.4)",
							borderRadius: 4, color: "#f4b400",
						}}>
							<strong>Source-bound:</strong> structural operations (create / move / delete)
							are managed by the Git mirror indexer. They are disabled in this UI
							(Git ownership — resync the project to update).
						</div>
					)}

					<div style={{ marginTop: 16 }}>
						<div style={fieldLabelStyle}>Workspace content</div>
						<button
							type="button"
							onClick={handleReadWorkspace}
							disabled={loadingWs || !source.sourcePath}
							style={primaryBtnStyle}
						>
							{loadingWs ? "Reading…" : "Read workspace file"}
						</button>
						{workspaceContent !== null && (
							<pre data-testid="wiki-source-workspace" style={{ ...preStyle, marginTop: 8, maxHeight: 360 }}>
								{workspaceContent || "(empty file)"}
							</pre>
						)}
					</div>
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// History tab — audit log
// ---------------------------------------------------------------------------

function HistoryTab({ path }: { path: string }) {
	const history = useWikiStore((s) => s.historyByPath[path]);
	// plan-06 §6 §D7:History tab 显示节点 audit log(actor / action / revision /
	// audit time)。数据来自 wikiV2History = WikiService.listHistory →
	// auditRepo.listByNodePath(canonical path key,时间倒序,limit 100)。
	//
	// 4 个状态:
	//   - loading(首次拉取中)→ "Loading…"
	//   - error(请求失败)→ 红色错误提示
	//   - 空(已加载但无记录)→ "No audit history yet."
	//   - 有条目 → 4 列表格 actor/action/revision/audit time
	if (!history || history.loading) {
		return <div style={{ fontSize: 12, color: "var(--text-tertiary, #555)" }}>Loading…</div>;
	}
	if (history.error) {
		return <div style={{ fontSize: 12, color: "#f44336" }}>{history.error}</div>;
	}
	if (history.entries.length === 0) {
		return (
			<div style={{ fontSize: 12, color: "var(--text-tertiary, #555)" }}>
				No audit history yet for <code>{path}</code>.
			</div>
		);
	}
	return (
		<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
			<thead>
				<tr>
					<th style={thStyle}>Action</th>
					<th style={thStyle}>Actor</th>
					<th style={thStyle}>Revision</th>
					<th style={thStyle}>Audit time</th>
				</tr>
			</thead>
			<tbody>
				{history.entries.map((h) => (
					<tr key={h.auditId} data-testid="wiki-history-row">
						<td style={tdStyle}><code>{h.action}</code></td>
						<td style={tdStyle}>{h.actorAgentId ?? "—"}</td>
						<td style={tdStyle}>{h.oldRevision ?? "—"} → {h.newRevision ?? "—"}</td>
						<td style={tdStyle}>{h.createdAt}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

// ---------------------------------------------------------------------------
// shared styles
// ---------------------------------------------------------------------------

const fieldLabelStyle: React.CSSProperties = {
	display: "block", fontSize: 11, marginBottom: 4,
	color: "var(--text-secondary, #888)",
};

const fieldBoxStyle: React.CSSProperties = {
	fontSize: 12, color: "var(--text-primary, #e0e0e0)",
	lineHeight: 1.6, whiteSpace: "pre-wrap",
};

const preStyle: React.CSSProperties = {
	margin: 0, padding: 10, fontSize: 11, lineHeight: 1.5,
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)", borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)",
	overflow: "auto", whiteSpace: "pre-wrap",
};

const textareaStyle: React.CSSProperties = {
	width: "100%", minHeight: 80, padding: 8, boxSizing: "border-box",
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)", borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)", fontSize: 12, resize: "vertical",
};

const inputStyle: React.CSSProperties = {
	flex: 1, padding: "4px 8px",
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)", borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)", fontSize: 12, boxSizing: "border-box",
};

const primaryBtnStyle: React.CSSProperties = {
	padding: "4px 12px", background: "#2196F3", border: "none",
	borderRadius: 4, color: "#fff", fontSize: 12, cursor: "pointer",
};

const ghostBtnStyle: React.CSSProperties = {
	padding: "4px 12px", background: "transparent",
	border: "1px solid var(--border-color, #333)", borderRadius: 4,
	color: "var(--text-secondary, #888)", fontSize: 12, cursor: "pointer",
};

const inlineBtnStyle: React.CSSProperties = {
	padding: "2px 8px", background: "transparent",
	border: "1px solid #f44336", borderRadius: 4,
	color: "#f44336", fontSize: 11, cursor: "pointer",
};

const activeTabStyle: React.CSSProperties = {
	padding: "8px 14px", background: "var(--bg-active, #2a2a2e)",
	border: "none", borderBottom: "2px solid #2196F3",
	color: "var(--text-primary, #e0e0e0)", fontSize: 12, cursor: "pointer",
};

const inactiveTabStyle: React.CSSProperties = {
	padding: "8px 14px", background: "transparent",
	border: "none", borderBottom: "2px solid transparent",
	color: "var(--text-secondary, #888)", fontSize: 12, cursor: "pointer",
};

const tdStyle: React.CSSProperties = {
	padding: "6px 8px", borderBottom: "1px solid var(--border-color, #333)",
	verticalAlign: "middle",
};

const thStyle: React.CSSProperties = {
	padding: "6px 8px", borderBottom: "1px solid var(--border-color, #333)",
	textAlign: "left", fontSize: 11, fontWeight: 600,
	color: "var(--text-secondary, #888)",
};

const markdownContainerStyle: React.CSSProperties = {
	fontSize: 13, lineHeight: 1.6,
	color: "var(--text-primary, #e0e0e0)",
};

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", marginBottom: 6, fontSize: 12 }}>
			<div style={{ flex: "0 0 130px", color: "var(--text-tertiary, #555)" }}>{label}:</div>
			<div style={{ flex: 1, color: "var(--text-primary, #e0e0e0)", fontFamily: "monospace", wordBreak: "break-all" }}>
				{value}
			</div>
		</div>
	);
}
