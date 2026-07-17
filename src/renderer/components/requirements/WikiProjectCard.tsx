// WikiProjectCard —— Project 页 Wiki Git 绑定卡片
// (wiki-system-redesign plan-07 §5)
//
// # 文件说明书
//
// ## 核心功能
// 显示 project 的 wiki 仓库绑定状态:
//   - Wiki project root canonical path(wiki-root/projects/<projectId>)
//   - repository / project binding(workspaceDir 只读展示,不入 Wiki DB)
//   - source_root + default branch
//   - indexed revision + 当前 HEAD
//   - sync status(pending / indexing / synced / stale / failed)+ last error
//   - last indexed time
//   - Validate / Full reindex / Open Wiki 按钮
//
// ## 关键不变量(plan-07 §5 / acceptance-07 §E)
//   - **workspaceDir 不入 Wiki DB**:仅从 ProjectStore 读取展示(§E1/H)。
//   - **bind / reindex 显示进度**:bind 后立即 emit indexing;reindex 完成后
//     emit synced/failed。任务可重试;页面关闭不取消 server job(server sync)。
//   - **unbind 默认 soft**:只删 binding + 停 sync,不硬删 project Wiki 子树;
//     hard unbind 走显式 toggle(§E4)。
//   - **改名只更新显示,不移动 Wiki path**(§E6):ProjectStore.name 改不影响
//     wiki-root/projects/<projectId> canonical path。
//   - **Open Wiki 定位项目 canonical root**(§E5):路由到 wiki page scope=
//     project://<projectId>。
//
// ## 不做
//   - 不在本组件里写 wiki.db;只调 wikiAdminRepositories* endpoint。
//   - 不暴露 repository 本地绝对路径以外的字段。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-07-management-ui.md §5
//   - src/server/wiki-admin-router.ts(repositories/* endpoints)

import React, { useEffect, useState, useCallback } from "react";
import type { ProjectRecord } from "../../../shared/types.js";
import type { WikiAdminRepositoryView, RepositoryValidateResult } from "../../../shared/wiki-admin-types.js";

interface Props {
	project: ProjectRecord;
	onOpenWiki?: (projectId: string) => void;
}

export function WikiProjectCard({ project, onOpenWiki }: Props) {
	const [status, setStatus] = useState<WikiAdminRepositoryView | null>(null);
	const [loading, setLoading] = useState(true);
	const [validating, setValidating] = useState(false);
	const [validateResult, setValidateResult] = useState<RepositoryValidateResult | null>(null);
	const [reindexing, setReindexing] = useState(false);
	const [reindexFull, setReindexFull] = useState(false);
	const [error, setError] = useState<string>("");
	const [unbindConfirm, setUnbindConfirm] = useState(false);
	const [unbindHard, setUnbindHard] = useState(false);
	const [binding, setBinding] = useState(false);

	const api = () => (window as any).api;

	const refresh = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const r = await api().wikiAdminRepositoriesStatus({ projectId: project.id });
			if (r?.ok) {
				setStatus(r.result);
			} else if (r?.error?.code === "NOT_FOUND") {
				setStatus(null); // 未绑定
			} else {
				setError(r?.error?.message ?? "status failed");
			}
		} catch (err) {
			// NOT_FOUND 也可能从 ipc-proxy 来(404);降级为「未绑定」。
			const msg = (err as Error)?.message ?? "";
			if (msg.includes("not bound") || msg.includes("NOT_FOUND") || msg.includes("404")) {
				setStatus(null);
			} else {
				setError(msg || "status failed");
			}
		} finally {
			setLoading(false);
		}
	}, [project.id]);

	useEffect(() => { void refresh(); }, [refresh]);

	const handleValidate = async () => {
		setValidating(true);
		setValidateResult(null);
		setError("");
		try {
			const r = await api().wikiAdminRepositoriesValidate({ projectId: project.id });
			if (r?.ok) {
				setValidateResult(r.result);
			} else {
				setValidateResult(r?.error ? { ok: false, code: r.error.code, message: r.error.message } : { ok: false, message: "validate failed" });
			}
		} catch (err) {
			setValidateResult({ ok: false, message: (err as Error)?.message ?? "validate failed" });
		} finally {
			setValidating(false);
		}
	};

	const handleBind = async () => {
		setBinding(true);
		setError("");
		try {
			const r = await api().wikiAdminRepositoriesBind({ projectId: project.id });
			if (!r?.ok) {
				setError(r?.error?.message ?? "bind failed");
			}
			await refresh();
		} catch (err) {
			setError((err as Error)?.message ?? "bind failed");
		} finally {
			setBinding(false);
		}
	};

	const handleReindex = async (full: boolean) => {
		setReindexing(true);
		setReindexFull(full);
		setError("");
		try {
			const r = await api().wikiAdminRepositoriesReindex({ projectId: project.id, full });
			if (!r?.ok) {
				setError(r?.error?.message ?? "reindex failed");
			}
			await refresh();
		} catch (err) {
			setError((err as Error)?.message ?? "reindex failed");
		} finally {
			setReindexing(false);
			setReindexFull(false);
		}
	};

	const handleUnbind = async () => {
		setError("");
		try {
			const r = await api().wikiAdminRepositoriesUnbind({ projectId: project.id, hard: unbindHard });
			if (!r?.ok) {
				setError(r?.error?.message ?? "unbind failed");
			}
			setUnbindConfirm(false);
			setUnbindHard(false);
			await refresh();
		} catch (err) {
			setError((err as Error)?.message ?? "unbind failed");
		}
	};

	const syncColor: Record<string, string> = {
		pending: "#8B8B8B",
		indexing: "#2196F3",
		synced: "#4CAF50",
		stale: "#FF9800",
		failed: "#f07057",
	};

	return (
		<div style={{
			background: "var(--bg-secondary, #1c1c1e)",
			border: "1px solid var(--border-color, #333)",
			borderRadius: 6,
			padding: 12,
		}}>
			<div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
				<h4 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Wiki Git binding</h4>
				<div style={{ flex: 1 }} />
				{status && (
					<span style={{
						fontSize: 10, padding: "2px 6px", borderRadius: 3,
						color: syncColor[status.syncStatus] ?? "#888",
						border: `1px solid ${syncColor[status.syncStatus] ?? "#888"}55`,
					}}>
						{status.syncStatus}
					</span>
				)}
				<button type="button" onClick={() => void refresh()} style={ghostBtnStyle} disabled={loading}>
					{loading ? "..." : "Refresh"}
				</button>
			</div>

			{loading && (
				<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>Loading…</div>
			)}

			{!loading && status && (
				<div style={{ fontSize: 11, lineHeight: 1.6 }}>
					<Row label="Project root" value={<code>{status.projectNodePath}</code>} />
					<Row label="Project name" value={status.projectName} />
					<Row label="Repository ID" value={<code>{status.repositoryId}</code>} />
					<Row label="workspaceDir" value={<span style={{ color: "var(--text-tertiary, #555)" }}>{status.workspaceDir || "(unknown)"} (read-only, not in Wiki DB)</span>} />
					<Row label="source_root" value={status.sourceRoot || "(repo root)"} />
					<Row label="Default branch" value={status.defaultBranch} />
					<Row label="Indexed revision" value={status.indexedRevision ? revShort(status.indexedRevision) : "—"} />
					<Row label="Current HEAD" value={status.headRevision ? revShort(status.headRevision) : "—"} />
					{status.indexedRevision && status.headRevision && status.indexedRevision !== status.headRevision && (
						<div style={{ fontSize: 10, color: "#FF9800", marginTop: 2 }}>
							⚠ HEAD drifted from indexed revision — run reindex to sync.
						</div>
					)}
					<Row label="Last indexed" value={status.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : "—"} />
					{status.lastError && (
						<div style={{ fontSize: 10, color: "#f07057", marginTop: 4, padding: 4, background: "#f0705722", borderRadius: 3 }}>
							<strong>Last error:</strong> {status.lastError}
						</div>
					)}
				</div>
			)}

			{!loading && !status && (
				<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)", marginBottom: 8 }}>
					No wiki repository binding. Click <strong>Bind</strong> to mirror the Git tree into
					<code> wiki-root/projects/{project.id}</code>.
				</div>
			)}

			{/* Actions */}
			<div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
				<button
					type="button"
					style={ghostBtnStyle}
					onClick={handleValidate}
					disabled={validating}
				>
					{validating ? "Validating..." : "Validate"}
				</button>
				{!status ? (
					<button
						type="button"
						style={primaryBtnStyle}
						onClick={handleBind}
						disabled={binding}
					>
						{binding ? "Binding..." : "Bind + initial index"}
					</button>
				) : (
					<>
						<button
							type="button"
							style={primaryBtnStyle}
							onClick={() => void handleReindex(false)}
							disabled={reindexing}
							title="Incremental sync indexed_revision → HEAD"
						>
							{reindexing && !reindexFull ? "Syncing..." : "Sync to HEAD"}
						</button>
						<button
							type="button"
							style={{ ...primaryBtnStyle, borderColor: "#FF9800", color: "#FF9800" }}
							onClick={() => void handleReindex(true)}
							disabled={reindexing}
							title="Drop binding + full rebuild from scratch (curated content lost)"
						>
							{reindexing && reindexFull ? "Rebuilding..." : "Full reindex"}
						</button>
						<button
							type="button"
							style={{ ...ghostBtnStyle, color: "#f07057" }}
							onClick={() => setUnbindConfirm(true)}
						>
							Unbind
						</button>
					</>
				)}
				{onOpenWiki && status && (
					<button
						type="button"
						style={ghostBtnStyle}
						onClick={() => onOpenWiki(project.id)}
					>
						Open Wiki
					</button>
				)}
			</div>

			{/* Validate result */}
			{validateResult && (
				<div style={{
					marginTop: 8, fontSize: 10, padding: 6, borderRadius: 3,
					background: validateResult.ok ? "#4CAF5022" : "#f0705722",
					color: validateResult.ok ? "#4CAF50" : "#f07057",
				}}>
					{validateResult.ok ? (
						<span>
							✓ Valid Git repo. branch={validateResult.defaultBranch ?? "?"}, head={validateResult.headRevision ? revShort(validateResult.headRevision) : "?"}
						</span>
					) : (
						<span>✗ {validateResult.message}</span>
					)}
				</div>
			)}

			{/* Unbind confirm */}
			{unbindConfirm && (
				<div style={{
					marginTop: 8, padding: 8, border: "1px solid #f07057", borderRadius: 4, background: "#f0705722",
				}}>
					<div style={{ fontSize: 11, color: "#f07057", fontWeight: 600, marginBottom: 6 }}>Confirm unbind</div>
					<p style={{ fontSize: 11, marginBottom: 8 }}>
						Default (soft) only removes the binding and stops sync — the project Wiki subtree stays.
						Hard unbind also archives the source-bound subtree (curated summaries on source-bound nodes will be lost).
					</p>
					<label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
						<input type="checkbox" checked={unbindHard} onChange={(e) => setUnbindHard(e.target.checked)} />
						Hard unbind (archive source-bound subtree)
					</label>
					<div style={{ display: "flex", gap: 6 }}>
						<button type="button" style={{ ...primaryBtnStyle, borderColor: "#f07057", color: "#f07057" }} onClick={handleUnbind}>
							Unbind
						</button>
						<button type="button" style={ghostBtnStyle} onClick={() => { setUnbindConfirm(false); setUnbindHard(false); }}>
							Cancel
						</button>
					</div>
				</div>
			)}

			{error && (
				<div style={{ marginTop: 8, fontSize: 10, color: "#f07057" }}>⚠ {error}</div>
			)}
		</div>
	);
}

function revShort(rev: string): string {
	return rev.slice(0, 8);
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div style={{ display: "flex", gap: 8, marginBottom: 2 }}>
			<span style={{ color: "var(--text-tertiary, #555)", minWidth: 120 }}>{label}</span>
			<span style={{ color: "var(--text-primary, #e0e0e0)" }}>{value}</span>
		</div>
	);
}

const ghostBtnStyle: React.CSSProperties = {
	padding: "4px 10px",
	fontSize: 11,
	borderRadius: 4,
	border: "1px solid var(--border-color, #333)",
	background: "transparent",
	color: "var(--text-secondary, #888)",
	cursor: "pointer",
};
const primaryBtnStyle: React.CSSProperties = {
	padding: "4px 10px",
	fontSize: 11,
	borderRadius: 4,
	border: "1px solid #58a6ff",
	background: "#58a6ff22",
	color: "#58a6ff",
	cursor: "pointer",
};

export type WikiProjectCardProps = Props;
