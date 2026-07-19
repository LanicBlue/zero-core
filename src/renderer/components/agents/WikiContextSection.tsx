// WikiContextSection —— Agent Editor:Wiki context 编辑段
// (wiki-system-redesign plan-07 §4)
//
// # 文件说明书
//
// ## 核心功能
// 编辑 AgentRecord.wikiContext:每条 = address + profile + channel + budget。
// Preview 调真实 WikiContextCompiler(server-side,plan-07 §4 D2:preview ==
// runtime)。Context 不自动授予权限;address 无 read grant 时阻止 publish
// (§4 D3/H)。
//
// ## 关键不变量
//   - **preview 无副作用**:不写 audit / revision。
//   - **preview 调真实 compiler**:同 AgentService session build 路径。
//   - **publish 阻止 unauthorized**:context entry address 无 read grant →
//     返 unauthorizedAddresses,UI 显示配置错误,publish 按钮禁用。**不自动
//     新增 grant**(§4 D3/H)。
//
// ## 不做
//   - 不在本组件里渲染 system section(只调 server preview)。
//   - 不暴露内部 DB ID。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-07-management-ui.md §4
//   - src/server/wiki-admin-router.ts(context/validate|preview|publish)
//   - src/server/wiki/wiki-context-compiler.ts(真实 compiler)

import React, { useEffect, useState } from "react";
import type { WikiContextEntry, WikiGrant } from "../../../shared/types.js";
import type { ContextPreviewResult } from "../../../shared/wiki-admin-types.js";

const PROFILES = ["compact", "standard", "deep"] as const;
const CHANNELS = ["system", "off"] as const;

interface Props {
	form: FormStateLike;
	onChange: (next: WikiContextEntry[]) => void;
	agentId?: string;
	currentRevision?: number;
}

interface FormStateLike {
	wikiContext?: WikiContextEntry[];
	wikiGrants?: WikiGrant[];
}

export function WikiContextSection({ form, onChange, agentId, currentRevision }: Props) {
	const entries: WikiContextEntry[] = form.wikiContext ?? [];
	const grants: WikiGrant[] = form.wikiGrants ?? [];

	const [draft, setDraft] = useState<WikiContextEntry[]>(entries);
	const [preview, setPreview] = useState<ContextPreviewResult | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const [publishError, setPublishError] = useState<string>("");
	const [publishResult, setPublishResult] = useState<{ newRevision: number; affectedSessions: Array<{ sessionId: string; applied: boolean }> } | null>(null);

	useEffect(() => {
		setDraft(entries);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [JSON.stringify(entries)]);

	// Draft 变更 → debounce 调 preview。preview 传当前 grants(让 compiler 知
	// 道 read 授权 + 让 server 检测 unauthorized addresses)。
	useEffect(() => {
		if (!agentId) return;
		setPreviewLoading(true);
		const handle = setTimeout(() => {
			void (async () => {
				try {
					const api = (window as any).api;
					const r = await api.wikiAdminContextPreview(agentId, { entries: draft, grants });
					if (r?.ok) {
						setPreview(r.result);
						setPublishError("");
					} else {
						setPreview(null);
						setPublishError(r?.error?.message ?? "preview failed");
					}
				} catch (err) {
					setPreview(null);
					setPublishError((err as Error)?.message ?? "preview failed");
				} finally {
					setPreviewLoading(false);
				}
			})();
		}, 300);
		return () => clearTimeout(handle);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentId, JSON.stringify(draft), JSON.stringify(grants)]);

	const updateEntry = (idx: number, patch: Partial<WikiContextEntry>) => {
		const next = draft.map((e, i) => (i === idx ? { ...e, ...patch } : e));
		setDraft(next);
		onChange(next);
	};

	const addEntry = () => {
		const next: WikiContextEntry[] = [
			...draft,
			{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 },
		];
		setDraft(next);
		onChange(next);
	};

	const removeEntry = (idx: number) => {
		const next = draft.filter((_, i) => i !== idx);
		setDraft(next);
		onChange(next);
	};

	const unauthorized = preview?.unauthorizedAddresses ?? [];
	const publishBlocked = unauthorized.length > 0;

	const handlePublish = async () => {
		if (!agentId) return;
		if (publishBlocked) return;
		setPublishing(true);
		setPublishError("");
		setPublishResult(null);
		try {
			const api = (window as any).api;
			const r = await api.wikiAdminContextPublish(agentId, {
				entries: draft,
				expectedRevision: currentRevision ?? 0,
			});
			if (r?.ok) {
				setPublishResult({
					newRevision: r.result.newRevision,
					affectedSessions: r.result.affectedSessions,
				});
			} else {
				const code = r?.error?.code ?? "INTERNAL_ERROR";
				if (code === "WRITE_CONFLICT") {
					setPublishError(`WRITE_CONFLICT:另一端已修改 policy. 请刷新后再 publish.`);
				} else {
					setPublishError(`[${code}] ${r?.error?.message ?? "publish failed"}`);
				}
			}
		} catch (err) {
			setPublishError((err as Error)?.message ?? "publish failed");
		} finally {
			setPublishing(false);
		}
	};

	return (
		<div className="editor-section">
			<div className="section-header">
				<h4>Wiki Context (system section)</h4>
				<p className="section-hint">
					每条 = <code>address</code> + <code>profile</code> + <code>channel</code> +{" "}
					<code>budgetTokens</code>。Preview 调真实 WikiContextCompiler(runtime 与 preview 同函数)。
					<strong> Context 不自动授予权限</strong>:address 无 read grant 时阻止 publish。
				</p>
			</div>

			{draft.length === 0 ? (
				<p className="empty-hint">
					No context entries. Agent will fall back to own-Memory standard profile
					(DEFAULT_WIKI_CONTEXT). Add entries to customize.
				</p>
			) : (
				<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
					<thead>
						<tr>
							<th style={thStyle}>Address</th>
							<th style={thStyle}>Profile</th>
							<th style={thStyle}>Channel</th>
							<th style={thStyle}>Budget (tokens)</th>
							<th style={thStyle}></th>
						</tr>
					</thead>
					<tbody>
						{draft.map((e, idx) => {
							const isUnauthorized = unauthorized.includes(e.address);
							return (
								<tr key={idx}>
									<td style={tdStyle}>
										<input
											type="text"
											value={e.address}
											onChange={(ev) => updateEntry(idx, { address: ev.target.value })}
											style={{ ...inputStyle, ...(isUnauthorized ? { borderColor: "#ff7b72" } : {}) }}
											aria-label={`Address for context entry ${idx + 1}`}
										/>
										{isUnauthorized && (
											<div style={{ fontSize: 10, color: "#ff7b72", marginTop: 2 }}>
												⚠ No read grant for this address — add a matching grant in Wiki Access section.
											</div>
										)}
									</td>
									<td style={tdStyle}>
										<select
											value={e.profile}
											onChange={(ev) => updateEntry(idx, { profile: ev.target.value as WikiContextEntry["profile"] })}
											style={inputStyle}
										>
											{PROFILES.map((p) => (<option key={p} value={p}>{p}</option>))}
										</select>
									</td>
									<td style={tdStyle}>
										<select
											value={e.channel}
											onChange={(ev) => updateEntry(idx, { channel: ev.target.value as WikiContextEntry["channel"] })}
											style={inputStyle}
										>
											{CHANNELS.map((c) => (<option key={c} value={c}>{c}</option>))}
										</select>
									</td>
									<td style={tdStyle}>
										<input
											type="number"
											value={e.budgetTokens ?? 0}
											onChange={(ev) => updateEntry(idx, { budgetTokens: parseInt(ev.target.value, 10) || 0 })}
											style={inputStyle}
											min={100}
											step={100}
										/>
									</td>
									<td style={tdStyle}>
										<button type="button" className="btn-ghost btn-xs" onClick={() => removeEntry(idx)}>
											Remove
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}

			<div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
				<button type="button" className="btn-ghost btn-sm" onClick={addEntry}>+ Add entry</button>
				{agentId && (
					<button
						type="button"
						className="btn-primary btn-sm"
						onClick={handlePublish}
						disabled={publishing || publishBlocked || previewLoading}
						title={publishBlocked ? "Resolve unauthorized addresses first" : "Publish"}
					>
						{publishing ? "Publishing..." : `Publish (rev ${currentRevision ?? 0} → ${(currentRevision ?? 0) + 1})`}
					</button>
				)}
				{!agentId && (
					<span style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>Save agent first to enable publish.</span>
				)}
			</div>

			{/* Preview text */}
			{preview && (
				<div style={{ marginTop: 12, padding: 8, background: "var(--bg-secondary, #1c1c1e)", border: "1px solid var(--border-color, #333)", borderRadius: 4 }}>
					<div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
						Compiled preview {previewLoading ? "(refreshing...)" : ""}{" "}
						<span style={{ color: "var(--text-tertiary, #555)", fontWeight: 400 }}>
							| mem {preview.stats.memoryNodesIncluded}/{preview.stats.memoryNodesTotal} ({preview.stats.memoryTokensUsed} tok)
							| proj {preview.stats.projectNodesIncluded}/{preview.stats.projectNodesTotal} ({preview.stats.projectTokensUsed} tok)
							{preview.stats.truncated ? " | TRUNCATED" : ""}
							{preview.snapshot.policyRevision !== undefined ? ` | rev ${preview.snapshot.policyRevision}` : ""}
						</span>
					</div>
					<pre style={{
						fontSize: 10, fontFamily: "monospace", color: "var(--text-secondary, #888)",
						maxHeight: 240, overflow: "auto", margin: 0, whiteSpace: "pre-wrap",
					}}>
						{preview.text || "(empty preview — root may be empty or unauthorized)"}
					</pre>
				</div>
			)}

			{publishError && (
				<div style={{ marginTop: 8, fontSize: 11, color: "#ff7b72" }}>⚠ {publishError}</div>
			)}
			{publishResult && (
				<div style={{ marginTop: 8, fontSize: 11, color: "#7ee787" }}>
					✓ Published (new revision {publishResult.newRevision}; {publishResult.affectedSessions.length} session(s) notified).
				</div>
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

export type WikiContextSectionProps = Props;
