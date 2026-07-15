// Wiki 锚点配置段 (v0.8 P8 §11.10 / §11.3)
//
// # 文件说明书
//
// ## 核心功能
// 编辑 AgentRecord.wikiAnchors:此 agent 自由锚定的 wiki 节点。每锚点 = nodeId
// + inject(system/context/off).
//
// §11.3 多锚点模型:
//   - 自动锚点(memory by agentId + project by projectId)在运行时派生,不存
//     在 AgentRecord 上 —— 默认 inject:project→system、memory→context。
//   - 自由锚点 = AgentRecord.wikiAnchors,本段编辑的就是这部分。
//   - 「自动锚点 inject 覆盖」需要 AgentRecord 上额外的 override 字段
//     (P0/P2 schema 范围),P8 不在 AgentRecord 增字段,故本段只编辑自由锚点,
//     自动锚点以只读说明呈现(覆盖能力随 P0/P2 schema 扩展后接入)。
//
// ## 输入
// - form(持有 wikiAnchors)
// - wikiNodes(wiki 树当前可见节点,供锚点 nodeId 下拉)
// - onChange:新 wikiAnchors 数组回写 form
//
// ## 输出
// - 渲染的锚点编辑面板
//
// ## 定位
// 渲染进程组件,被 AgentEditor 使用。
//
// ## 依赖
// - react
// - ../../../shared/types (AgentRecord, WikiNode)
//
// ## 维护规则
// - wikiAnchors 结构变更同步此组件 + agent-editor-types
// - 自动锚点 override 落地后(P0/P2 schema),在此段补 override 行
//
import React, { useState, useEffect } from "react";
import type { AgentRecord, WikiNode } from "../../../shared/types.js";

type WikiAnchor = NonNullable<AgentRecord["wikiAnchors"]>[number];
type Inject = WikiAnchor["inject"];

interface Props {
	form: FormStateLike;
	/** Saved agent id (undefined while editing a brand-new, unsaved agent). */
	agentId?: string;
	wikiNodes: WikiNode[];
	onChange: (next: AgentRecord["wikiAnchors"]) => void;
}

interface FormStateLike {
	wikiAnchors?: AgentRecord["wikiAnchors"];
}

const INJECT_OPTIONS: Inject[] = ["system", "context", "off"];

// N2 render hygiene: module-level stable empty-array reference. `form.wikiAnchors
// ?? []` would create a new [] identity each render, busting the preview-effect
// deps and re-running the debounced preview fetch on every unrelated re-render.
// A shared constant keeps the identity stable when there are no anchors.
const EMPTY_ANCHORS: WikiAnchor[] = [];

export function WikiAnchorsSection({ form, agentId, wikiNodes, onChange }: Props) {
	const list: WikiAnchor[] = form.wikiAnchors ?? EMPTY_ANCHORS;
	const [newNodeId, setNewNodeId] = useState("");
	const [newInject, setNewInject] = useState<Inject>("context");
	const [manualNodeId, setManualNodeId] = useState("");
	const [useManual, setUseManual] = useState(false);

	// Live injection preview: re-renders the wiki text this (agent, project) +
	// the editor's current free anchors would inject, plus token estimates.
	// Debounced so rapid anchor edits don't spam the backend. Requires a saved
	// agentId (the auto memory anchor keys off it); for a brand-new unsaved
	// agent we show a hint instead.
	const [preview, setPreview] = useState<{
		systemText: string; contextText: string;
		systemTokens: number; contextTokens: number;
	} | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);

	useEffect(() => {
		const api = (window as any).api;
		if (!api?.wikiPreviewInjection || !agentId) return;
		setPreviewLoading(true);
		setPreviewError(null);
		const handle = setTimeout(() => {
			api.wikiPreviewInjection({ agentId, wikiAnchors: list })
				.then((r: any) => {
					if (!r) { setPreview(null); return; }
					setPreview({
						systemText: r.systemText ?? "",
						contextText: r.contextText ?? "",
						systemTokens: r.systemTokens ?? 0,
						contextTokens: r.contextTokens ?? 0,
					});
				})
				.catch((e: any) => setPreviewError((e as Error)?.message ?? "preview failed"))
				.finally(() => setPreviewLoading(false));
		}, 300);
		return () => clearTimeout(handle);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentId, list]);

	const handleAdd = () => {
		const id = (useManual ? manualNodeId : newNodeId).trim();
		if (!id) return;
		if (list.some((a) => a.nodeId === id)) return; // dedupe
		const entry: WikiAnchor = {
			nodeId: id,
			inject: newInject,
		};
		onChange([...list, entry]);
		setNewNodeId("");
		setManualNodeId("");
	};

	const handleRemove = (nodeId: string) => {
		onChange(list.filter((a) => a.nodeId !== nodeId));
	};

	const handleUpdate = (nodeId: string, patch: Partial<WikiAnchor>) => {
		onChange(list.map((a) => (a.nodeId === nodeId ? { ...a, ...patch } : a)));
	};

	const titleFor = (id: string): string => {
		const n = wikiNodes.find((x) => x.id === id);
		return n ? (n.title || n.path) : "(not in current view)";
	};

	return (
		<div className="editor-section">
			<div className="section-header">
				<h4>Wiki anchors</h4>
				<p className="section-hint">
					Free wiki anchors this agent pins into its context. Each anchor&apos;s subtree
					(root doc + one level of children) is injected by <code>inject</code>: <code>system</code>{" "}
					(cached system-prompt section), <code>context</code> (per-turn context),{" "}
					<code>off</code> (stored, not injected). Injection = root doc + one level of children (fixed).
					<br />
					<em>Auto anchors</em> (per-agent <code>memory/&lt;agentId&gt;/</code> + session project
					subtree) are derived at runtime with defaults project→system, memory→context;
					overriding their inject needs an AgentRecord schema extension (P0/P2) and lands later.
				</p>
			</div>

			{/* Auto-anchor info (read-only) */}
			<div className="auto-anchors" style={{ marginBottom: 16, padding: 10, background: "var(--bg-secondary, #1c1c1e)", borderRadius: 6, fontSize: 11, color: "var(--text-secondary, #888)" }}>
				<strong>Auto anchors (runtime-derived, default inject):</strong>
				<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
					<li><code>memory/&lt;this agent&gt;/</code> → context</li>
					<li><code>project:&lt;session project&gt;</code> → system</li>
				</ul>
			</div>

			{/* Free anchors */}
			{list.length === 0 ? (
				<p className="empty-hint">No free anchors. Only auto anchors will be injected.</p>
			) : (
				<table className="anchors-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
					<thead>
						<tr>
							<th style={thStyle}>Node</th>
							<th style={thStyle}>Inject</th>
							<th style={thStyle}></th>
						</tr>
					</thead>
					<tbody>
						{list.map((a) => (
							<tr key={a.nodeId}>
								<td style={tdStyle}>
									<code>{a.nodeId}</code>
									<div style={{ fontSize: 10, color: "var(--text-tertiary, #555)" }}>
										{titleFor(a.nodeId)}
									</div>
								</td>
								<td style={tdStyle}>
									<select
										value={a.inject}
										onChange={(e) => handleUpdate(a.nodeId, { inject: e.target.value as Inject })}
										aria-label={`Inject for ${a.nodeId}`}
										style={inputStyle}
									>
										{INJECT_OPTIONS.map((v) => (
											<option key={v} value={v}>{v}</option>
										))}
									</select>
								</td>
								<td style={tdStyle}>
									<button type="button" className="btn-ghost btn-xs" onClick={() => handleRemove(a.nodeId)}>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			{/* Add new anchor — 2-row × 3-column grid: labels on top, controls
			    aligned below (node select + manual checkbox | inject | Add button).
			    Replaces the old uneven flex (node flex:2 / inject no-flex / inline
			    checkbox marginRight) that left the button + checkbox misaligned. */}
			<div
				className="anchor-add"
				style={{
					marginTop: 16,
					display: "grid",
					gridTemplateColumns: "minmax(220px, 1fr) 150px auto",
					gap: "4px 10px",
					alignItems: "center",
				}}
			>
				<label style={labelStyle}>Node</label>
				<label style={labelStyle}>Inject</label>
				<span aria-hidden="true" />

				<div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
					{useManual ? (
						<input
							type="text"
							value={manualNodeId}
							onChange={(e) => setManualNodeId(e.target.value)}
							placeholder="wiki-root:global / wiki-root:<projectId> / <nodeId>"
							aria-label="Manual wiki node id"
							style={{ ...inputStyle, flex: 1, minWidth: 0 }}
						/>
					) : (
						<select
							value={newNodeId}
							onChange={(e) => setNewNodeId(e.target.value)}
							aria-label="Pick wiki node to anchor"
							style={{ ...inputStyle, flex: 1, minWidth: 0 }}
						>
							<option value="">-- pick node --</option>
							{/* Offer the synthetic roots + global-root explicitly so users can
							    anchor at the whole tree (zero pattern) even when that root isn't
							    in the current visible set. */}
							<option value="wiki-root:global">wiki-root:global (whole tree)</option>
							{wikiNodes
								// The global root is already offered explicitly above; the global-scope
								// refresh returns the whole tree (root included), so skip it here to
								// avoid a duplicate "wiki-root:global" entry in the dropdown.
								.filter((n) => n.id !== "wiki-root:global")
								.map((n) => (
									<option key={n.id} value={n.id}>
										{n.title || n.path} ({n.id})
									</option>
								))}
						</select>
					)}
					<label
						className="checkbox-label"
						title="Enter node id manually"
						style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", fontSize: 11, color: "var(--text-secondary, #888)" }}
					>
						<input
							type="checkbox"
							checked={useManual}
							onChange={(e) => setUseManual(e.target.checked)}
						/>
						manual
					</label>
				</div>

				<select
					value={newInject}
					onChange={(e) => setNewInject(e.target.value as Inject)}
					aria-label="Inject for new anchor"
					style={{ ...inputStyle, width: "100%" }}
				>
					{INJECT_OPTIONS.map((v) => (
						<option key={v} value={v}>{v}</option>
					))}
				</select>

				<button
					type="button"
					className="btn-primary btn-sm"
					onClick={handleAdd}
					disabled={!(useManual ? manualNodeId.trim() : newNodeId.trim())}
				>
					Add
				</button>
			</div>

			{/* Live injection preview + token estimate (debounced). */}
			<div className="anchor-preview" style={{ marginTop: 16, padding: 10, background: "var(--bg-secondary, #1c1c1e)", borderRadius: 6, fontSize: 11 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
					<strong style={{ color: "var(--text-secondary, #888)" }}>Injection preview</strong>
					{previewLoading && <span title="refreshing preview" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-tertiary, #666)", display: "inline-block", opacity: 0.6 }} />}
					{preview && (
						<span style={{ color: "var(--text-tertiary, #666)" }}>
							system ~{preview.systemTokens} tok · context ~{preview.contextTokens} tok
							{preview.systemTokens + preview.contextTokens === 0 && " · (nothing injected at these settings)"}
						</span>
					)}
				</div>
				{!agentId ? (
					<p style={{ margin: 0, color: "var(--text-tertiary, #555)" }}>
						Save the agent first to preview its auto memory anchor + free-anchor injection.
					</p>
				) : previewError ? (
					<p style={{ margin: 0, color: "#f44336" }}>preview error: {previewError}</p>
				) : preview ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						{preview.systemText && (
							<PreviewBlock label={`system (~${preview.systemTokens} tok)`} text={preview.systemText} />
						)}
						{preview.contextText && (
							<PreviewBlock label={`context (~${preview.contextTokens} tok)`} text={preview.contextText} />
						)}
						{!preview.systemText && !preview.contextText && (
							<p style={{ margin: 0, color: "var(--text-tertiary, #555)" }}>
								No anchors injected (auto anchors resolve empty + no free anchors).
							</p>
						)}
					</div>
				) : (
					<p style={{ margin: 0, color: "var(--text-tertiary, #555)" }}>Loading preview…</p>
				)}
			</div>
		</div>
	);
}

/** Collapsible text block for one injection channel of the preview. */
function PreviewBlock({ label, text }: { label: string; text: string }) {
	const [open, setOpen] = useState(false);
	const capped = text.length > 2000 ? text.slice(0, 2000) + "\n…(truncated)" : text;
	return (
		<div>
			<button
				type="button"
				className="btn-ghost btn-xs"
				onClick={() => setOpen((o) => !o)}
				style={{ padding: "2px 6px" }}
			>
				{open ? "▾" : "▸"} {label}
			</button>
			{open && (
				<pre style={{
					margin: "4px 0 0", padding: 8, maxHeight: 240, overflow: "auto",
					background: "var(--bg-primary, #1a1a1c)", borderRadius: 4,
					color: "var(--text-secondary, #888)", whiteSpace: "pre-wrap", fontSize: 10,
				}}>
					{capped}
				</pre>
			)}
		</div>
	);
}

const thStyle: React.CSSProperties = {
	textAlign: "left",
	padding: "6px 8px",
	borderBottom: "1px solid var(--border-color, #333)",
	fontWeight: 600,
	color: "var(--text-secondary, #888)",
	fontSize: 11,
};

const tdStyle: React.CSSProperties = {
	padding: "6px 8px",
	borderBottom: "1px solid var(--border-color, #333)",
	verticalAlign: "top",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "4px 6px",
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)",
	fontSize: 12,
	boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
	display: "block",
	fontSize: 11,
	color: "var(--text-secondary, #888)",
	marginBottom: 4,
};
