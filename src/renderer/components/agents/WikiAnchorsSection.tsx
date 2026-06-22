// Wiki 锚点配置段 (v0.8 P8 §11.10 / §11.3)
//
// # 文件说明书
//
// ## 核心功能
// 编辑 AgentRecord.wikiAnchors:此 agent 自由锚定的 wiki 节点。每锚点 = nodeId
// + inject(system/context/off) + 可选 depth。
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
import React, { useState } from "react";
import type { AgentRecord, WikiNode } from "../../../shared/types.js";

type WikiAnchor = NonNullable<AgentRecord["wikiAnchors"]>[number];
type Inject = WikiAnchor["inject"];

interface Props {
	form: FormStateLike;
	wikiNodes: WikiNode[];
	onChange: (next: AgentRecord["wikiAnchors"]) => void;
}

interface FormStateLike {
	wikiAnchors?: AgentRecord["wikiAnchors"];
}

const INJECT_OPTIONS: Inject[] = ["system", "context", "off"];

export function WikiAnchorsSection({ form, wikiNodes, onChange }: Props) {
	const list: WikiAnchor[] = form.wikiAnchors ?? [];
	const [newNodeId, setNewNodeId] = useState("");
	const [newInject, setNewInject] = useState<Inject>("context");
	const [newDepth, setNewDepth] = useState<string>("");
	const [manualNodeId, setManualNodeId] = useState("");
	const [useManual, setUseManual] = useState(false);

	const handleAdd = () => {
		const id = (useManual ? manualNodeId : newNodeId).trim();
		if (!id) return;
		if (list.some((a) => a.nodeId === id)) return; // dedupe
		const entry: WikiAnchor = {
			nodeId: id,
			inject: newInject,
			...(newDepth.trim() ? { depth: Math.max(0, parseInt(newDepth, 10) || 0) } : {}),
		};
		onChange([...list, entry]);
		setNewNodeId("");
		setManualNodeId("");
		setNewDepth("");
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
					(title+summary, no body) is injected by <code>inject</code>: <code>system</code>{" "}
					(cached system-prompt section), <code>context</code> (per-turn context),{" "}
					<code>off</code> (stored, not injected). <code>depth</code> = child levels to pull.
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
							<th style={thStyle}>Depth</th>
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
									<input
										type="number"
										min={0}
										value={a.depth ?? ""}
										onChange={(e) => {
											const v = e.target.value;
											handleUpdate(a.nodeId, v === "" ? { depth: undefined } : { depth: Math.max(0, parseInt(v, 10) || 0) });
										}}
										placeholder="∞"
										aria-label={`Depth for ${a.nodeId}`}
										style={{ ...inputStyle, width: 60 }}
									/>
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

			{/* Add new anchor */}
			<div className="anchor-add" style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
				<div style={{ minWidth: 240, flex: 2 }}>
					<label style={labelStyle}>
						<input
							type="checkbox"
							checked={useManual}
							onChange={(e) => setUseManual(e.target.checked)}
							style={{ marginRight: 6 }}
						/>
						Enter node id manually
					</label>
					{useManual ? (
						<input
							type="text"
							value={manualNodeId}
							onChange={(e) => setManualNodeId(e.target.value)}
							placeholder="wiki-root:global / wiki-root:<projectId> / <nodeId>"
							aria-label="Manual wiki node id"
							style={inputStyle}
						/>
					) : (
						<select
							value={newNodeId}
							onChange={(e) => setNewNodeId(e.target.value)}
							aria-label="Pick wiki node to anchor"
							style={inputStyle}
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
				</div>
				<div>
					<label style={labelStyle}>Inject</label>
					<select
						value={newInject}
						onChange={(e) => setNewInject(e.target.value as Inject)}
						aria-label="Inject for new anchor"
						style={inputStyle}
					>
						{INJECT_OPTIONS.map((v) => (
							<option key={v} value={v}>{v}</option>
						))}
					</select>
				</div>
				<div>
					<label style={labelStyle}>Depth</label>
					<input
						type="number"
						min={0}
						value={newDepth}
						onChange={(e) => setNewDepth(e.target.value)}
						placeholder="∞"
						aria-label="Depth for new anchor"
						style={{ ...inputStyle, width: 60 }}
					/>
				</div>
				<button
					type="button"
					className="btn-primary btn-sm"
					onClick={handleAdd}
					disabled={!(useManual ? manualNodeId.trim() : newNodeId.trim())}
				>
					Add
				</button>
			</div>
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
