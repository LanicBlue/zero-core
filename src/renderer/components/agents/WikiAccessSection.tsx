// WikiAccessSection —— Agent Editor:Wiki grants 编辑段
// (wiki-system-redesign plan-07 §3)
//
// # 文件说明书
//
// ## 核心功能
// 编辑 AgentRecord.wikiGrants:每条 = scope + action chips。提供:
//   - 实时 compile 预览(调 wikiAdminGrantsPreview → server compileWikiAccess;
//     runtime / preview 同函数,字节级一致)。
//   - 重叠 grant 提示 + action union(不随机优先级,§3 C5)。
//   - project:// 无 active project 时显示 inactive(§3 C6,不解析到 projects 根)。
//   - wiki-root 全树写权限二次确认(§3 C4/C7)。
//   - publish 时显式 expectedRevision CAS;冲突返 WRITE_CONFLICT。
//   - 删除最后一条 grant → form 持 [] 而非 undefined(§3 C3/H:
//     JSON.stringify 丢 undefined → backend 不写 → 旧值残留)。
//
// ## 关键不变量
//   - **预览无副作用**:validate/preview 不写 audit/revision。
//   - **publish 走管理 audit**:server 写 `policy.publish.grants` audit 行 +
//     revision +1。
//   - **activeProjectId 来自 chat-store**:本组件不接触 server-side ctx,UI
//     用本地 chat-store 的 activeProjectId 作 hint 传给 preview(compiler 用
//     它决定 project:// 是否 inactive)。publish 不需要它(AgentService 按
//     session 当前 activeProject 实时编译)。
//
// ## 不做
//   - 不在本组件里编译 grants(只调 server preview,与 runtime 同源)。
//   - 不自动授予 wiki-root 全树(必须用户显式加 + 二次确认)。
//   - 不暴露内部 DB ID(target_id / nodeId)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-07-management-ui.md §3
//   - src/server/wiki-admin-router.ts(grants/validate|preview|publish)
//   - src/server/wiki/wiki-access-compiler.ts(真实 compiler)

import React, { useEffect, useState } from "react";
import type { WikiGrant } from "../../../shared/types.js";
import type { GrantsPreviewResult } from "../../../shared/wiki-admin-types.js";

const ALL_ACTIONS = [
	"expand", "read", "search",
	"create", "update", "delete",
	"link", "unlink", "move",
] as const;
type WikiAction = (typeof ALL_ACTIONS)[number];

interface Props {
	form: FormStateLike;
	onChange: (next: WikiGrant[]) => void;
	/** agent.id;publish / preview / validate 用。新建 agent(无 id)时隐藏 publish。 */
	agentId?: string;
	/** 当前 AgentRecord.wikiPolicyRevision;publish CAS 用。 */
	currentRevision?: number;
	/** 可选 active project ID(preview 时传给 compiler 决定 project:// active)。*/
	activeProjectId?: string;
}

interface FormStateLike {
	wikiGrants?: WikiGrant[];
}

export function WikiAccessSection({ form, onChange, agentId, currentRevision, activeProjectId }: Props) {
	const grants: WikiGrant[] = form.wikiGrants ?? [];

	// Local edit draft(在 publish 之前不立即写回 form;只有 user 点 Save Draft /
	// autoSave 时才回写)。实际上 plan-06 的 SubagentsSection 走直接回写;这里
	// 为支持 publish(显式 CAS),用 draft + Publish 模式更安全。
	const [draft, setDraft] = useState<WikiGrant[]>(grants);
	const [preview, setPreview] = useState<GrantsPreviewResult | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const [publishError, setPublishError] = useState<string>("");
	const [publishResult, setPublishResult] = useState<{ newRevision: number; affectedSessions: Array<{ sessionId: string; applied: boolean }> } | null>(null);
	const [showRootConfirm, setShowRootConfirm] = useState(false);
	const [rootConfirmAccepted, setRootConfirmAccepted] = useState(false);

	// form.wikiGrants 外部变更 → 同步到 draft。
	useEffect(() => {
		setDraft(grants);
		setRootConfirmAccepted(false);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [JSON.stringify(grants)]);

	// Draft 变更 → debounce 调 preview(无副作用)。
	useEffect(() => {
		if (!agentId) return;
		setPreviewLoading(true);
		const handle = setTimeout(() => {
			void (async () => {
				try {
					const api = (window as any).api;
					const result = await api.wikiAdminGrantsPreview(agentId, { grants: draft });
					if (result?.ok) {
						setPreview(result.result);
						setPublishError("");
					} else {
						setPreview(null);
						setPublishError(result?.error?.message ?? "preview failed");
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
	}, [agentId, JSON.stringify(draft)]);

	const updateGrant = (idx: number, patch: Partial<WikiGrant>) => {
		const next = draft.map((g, i) => (i === idx ? { ...g, ...patch } : g));
		setDraft(next);
		onChange(next);
	};

	const addGrant = () => {
		const next: WikiGrant[] = [
			...draft,
			{ scope: "memory://", actions: ["expand", "read", "search"] },
		];
		setDraft(next);
		onChange(next);
	};

	const removeGrant = (idx: number) => {
		// §3 C3/H:删到空时持久化 [],不能 undefined。这里 next.length===0 也保
		// 留空数组(不调 setDraft([]) 之外再做 undefined 替换)。
		const next = draft.filter((_, i) => i !== idx);
		setDraft(next);
		// 关键:onChange 显式传 [] 而不是 undefined。父组件 autosave 会
		// JSON.stringify({wikiGrants: []}),[] 在 IPC 序列化中存活。
		onChange(next);
	};

	const toggleAction = (idx: number, action: WikiAction) => {
		const current = draft[idx];
		const has = current.actions.includes(action);
		const actions = has
			? current.actions.filter((a) => a !== action)
			: [...current.actions, action];
		// 空 actions 也允许暂存(UI 显示 warning);publish 时 compiler 跳过空 grant。
		updateGrant(idx, { actions });
	};

	const handlePublish = async () => {
		if (!agentId) return;
		// 检查 root write grant(§3 C4)。draft 含 wiki-root + 任一写 action → 必须
		// 二次确认。preview.hasRootWriteGrant 是 compiler 真实结果,信它。
		if (preview?.hasRootWriteGrant && !rootConfirmAccepted) {
			setShowRootConfirm(true);
			return;
		}
		setPublishing(true);
		setPublishError("");
		setPublishResult(null);
		try {
			const api = (window as any).api;
			const expectedRev = currentRevision ?? 0;
			const r = await api.wikiAdminGrantsPublish(agentId, {
				grants: draft,
				expectedRevision: expectedRev,
				confirmRootWriteGrant: preview?.hasRootWriteGrant ? true : undefined,
			});
			if (r?.ok) {
				setPublishResult({
					newRevision: r.result.newRevision,
					affectedSessions: r.result.affectedSessions,
				});
				setRootConfirmAccepted(false);
			} else {
				const code = r?.error?.code ?? "INTERNAL_ERROR";
				const msg = r?.error?.message ?? "publish failed";
				if (code === "WRITE_CONFLICT") {
					setPublishError(
						`WRITE_CONFLICT:另一端已修改 policy(rev ${(r.error as any).currentRevision}). 请刷新后再 publish.`,
					);
				} else {
					setPublishError(`[${code}] ${msg}`);
				}
			}
		} catch (err) {
			setPublishError((err as Error)?.message ?? "publish failed");
		} finally {
			setPublishing(false);
		}
	};

	const overlaps = preview?.overlaps ?? [];
	const hasRootWriteGrant = preview?.hasRootWriteGrant ?? false;
	const mergedGrants = preview?.mergedGrants ?? [];

	return (
		<div className="editor-section">
			<div className="section-header">
				<h4>Wiki Access (grants)</h4>
				<p className="section-hint">
					每条 grant = <code>scope</code> + <code>actions</code>。scope 接受 <code>memory://</code> /{" "}
					<code>project://</code> / <code>wiki-root/...</code> / <code>runtime://...</code>。
					多条 grant 取 actions 并集;<code>project://</code> 无 active project 时 inactive。
				</p>
			</div>

			{/* Draft list */}
			{draft.length === 0 ? (
				<p className="empty-hint">
					No grants configured. Agent will fall back to own-Memory + Knowledge read default
					(see AgentService.pickDefaultGrants). Add a grant to override.
				</p>
			) : (
				<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
					<thead>
						<tr>
							<th style={thStyle}>Scope</th>
							<th style={thStyle}>Actions</th>
							<th style={thStyle}></th>
						</tr>
					</thead>
					<tbody>
						{draft.map((g, idx) => {
							const overlap = overlaps.find((o) => o.canonicalScope === g.scope);
							return (
								<tr key={idx}>
									<td style={tdStyle}>
										<input
											type="text"
											value={g.scope}
											onChange={(e) => updateGrant(idx, { scope: e.target.value })}
											aria-label={`Scope for grant ${idx + 1}`}
											style={inputStyle}
										/>
										{overlap && (
											<div style={{ fontSize: 10, color: "#f0b429", marginTop: 2 }}>
												⚠ {overlap.count} grants share this scope — actions unioned (no random priority)
											</div>
										)}
									</td>
									<td style={tdStyle}>
										<div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
											{ALL_ACTIONS.map((a) => {
												const on = g.actions.includes(a);
												return (
													<button
														key={a}
														type="button"
														onClick={() => toggleAction(idx, a)}
														style={{
															padding: "2px 6px",
															fontSize: 10,
															borderRadius: 3,
															cursor: "pointer",
															border: on ? "1px solid #58a6ff" : "1px solid var(--border-color, #333)",
															background: on ? "#58a6ff22" : "transparent",
															color: on ? "#58a6ff" : "var(--text-secondary, #888)",
														}}
														aria-pressed={on}
													>
														{a}
													</button>
												);
											})}
										</div>
									</td>
									<td style={tdStyle}>
										<button
											type="button"
											className="btn-ghost btn-xs"
											onClick={() => removeGrant(idx)}
										>
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
				<button type="button" className="btn-ghost btn-sm" onClick={addGrant}>
					+ Add grant
				</button>
				{agentId && (
					<button
						type="button"
						className="btn-primary btn-sm"
						onClick={handlePublish}
						disabled={publishing || previewLoading}
					>
						{publishing ? "Publishing..." : `Publish (rev ${currentRevision ?? 0} → ${(currentRevision ?? 0) + 1})`}
					</button>
				)}
				{!agentId && (
					<span style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>
						Save agent first to enable publish.
					</span>
				)}
			</div>

			{/* Preview:compiled merged grants */}
			{preview && mergedGrants.length > 0 && (
				<div style={{ marginTop: 12, padding: 8, background: "var(--bg-secondary, #1c1c1e)", border: "1px solid var(--border-color, #333)", borderRadius: 4 }}>
					<div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
						Compiled preview {previewLoading ? "(refreshing...)" : ""}
					</div>
					{mergedGrants.map((g, i) => (
						<div key={i} style={{ fontSize: 11, fontFamily: "monospace", marginBottom: 2 }}>
							<code style={{ color: "#7ee787" }}>{g.canonicalScope}</code>
							{" → "}
							<span style={{ color: "var(--text-secondary, #888)" }}>{g.actions.join(", ")}</span>
						</div>
					))}
					{preview.warnings.length > 0 && (
						<div style={{ marginTop: 6, fontSize: 10, color: "#f0b429" }}>
							{preview.warnings.map((w, i) => (<div key={i}>⚠ {w}</div>))}
						</div>
					)}
					{hasRootWriteGrant && (
						<div style={{ marginTop: 6, fontSize: 11, color: "#ff7b72", fontWeight: 600 }}>
							⚠ wiki-root full-tree write grant detected. Publish requires confirmation below.
						</div>
					)}
				</div>
			)}

			{/* Root-write confirmation modal */}
			{showRootConfirm && (
				<div style={{ marginTop: 12, padding: 12, border: "1px solid #ff7b72", borderRadius: 4, background: "#ff7b7222" }}>
					<div style={{ fontSize: 12, fontWeight: 600, color: "#ff7b72", marginBottom: 6 }}>
						Confirm high-risk grant
					</div>
					<p style={{ fontSize: 11, marginBottom: 8 }}>
						You are granting <code>wiki-root</code> full-tree write access. This agent will be able to
						create / update / delete / move ANY node in the entire Wiki tree (all projects + all agents'
						memory + knowledge base). This is recorded in the management audit log.
					</p>
					<label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
						<input
							type="checkbox"
							checked={rootConfirmAccepted}
							onChange={(e) => setRootConfirmAccepted(e.target.checked)}
						/>
						I understand the risk;publish with wiki-root write grant.
					</label>
					<div style={{ marginTop: 8, display: "flex", gap: 8 }}>
						<button
							type="button"
							className="btn-primary btn-sm"
							onClick={handlePublish}
							disabled={!rootConfirmAccepted || publishing}
						>
							{publishing ? "Publishing..." : "Confirm & Publish"}
						</button>
						<button
							type="button"
							className="btn-ghost btn-sm"
							onClick={() => { setShowRootConfirm(false); setRootConfirmAccepted(false); }}
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			{publishError && (
				<div style={{ marginTop: 8, fontSize: 11, color: "#ff7b72" }}>⚠ {publishError}</div>
			)}
			{publishResult && (
				<div style={{ marginTop: 8, fontSize: 11, color: "#7ee787" }}>
					✓ Published (new revision {publishResult.newRevision};{publishResult.affectedSessions.length} session(s) notified:
					{" "}{publishResult.affectedSessions.map((s) => `${s.sessionId.slice(0, 8)}${s.applied ? "" : "(pending)"}`).join(", ")}).
				</div>
			)}
			{!activeProjectId && draft.some((g) => g.scope === "project://" || g.scope.startsWith("project://")) && (
				<div style={{ marginTop: 6, fontSize: 10, color: "#f0b429" }}>
					ℹ No active project in this editor context — <code>project://</code> grant will be inactive
					in sessions without an active project (does NOT expand to projects root).
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
	fontFamily: "monospace",
	boxSizing: "border-box",
};

// 暴露给 AgentEditor 的 prop 重新导出(便于父组件 typeof)。
export type WikiAccessSectionProps = Props;
