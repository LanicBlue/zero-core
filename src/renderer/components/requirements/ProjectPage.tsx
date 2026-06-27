// 项目页 (v0.8 P5 §8.5 — 替换看板页)
//
// # 文件说明书
//
// ## 核心功能
// 项目容器视图 + 仪表盘 + 看板。原看板页升级为「项目页」,布局:
//   左栏  项目列表 + 新建项目按钮
//   右栏  三 tab:
//     1. 仪表盘 + 动态  — wiki 扫描进度 / git main HEAD 概要 / 资源消耗
//                          (sessions token SUM by projectId) + 活动时间线
//                          (requirement status_history + messages)
//     2. 项目视图       — §8.4 容器视图可视化(requirements/crons/wiki/
//                          activeSessions)
//     3. 看板           — 现有 kanban 按 status 的 requirement 列(内嵌)
//
// ## 输入
// - useProjectStore / useRequirementStore (Zustand)
// - preload api:projectsGet(id, includeContext) + projectsGetResourceUsage(id)
//   + projectsCreate / projectsDelete
//
// ## 输出
// - 渲染的项目页(被 AppLayout 当 activePage==="requirements" 渲染)
//
// ## 定位
// 渲染进程组件,由 AppLayout 替换 KanbanPage 直接挂载。
// 看板 tab 内嵌 <KanbanBoard /> 子组件(从原 KanbanPage 抽出的纯看板部分)。
//
// ## 依赖
// - react
// - ../../store/* (project / requirement / page)
// - ../../../shared/types.js
// - ./KanbanBoard.js(原 KanbanPage 抽出的纯看板)
//
// ## 维护规则
// - 新增项目级指标 → 进仪表盘 tab
// - 看 board 分列逻辑变更 → KanbanBoard(不在本文件)
// - 资源消耗字段变更 → shared/types.ts ProjectResourceUsage + management-service
//
import React, { useEffect, useState, useCallback, useMemo } from "react";
import type {
	ProjectRecord,
	ProjectContainerView,
	ProjectResourceUsage,
	RequirementStatus,
	WikiOperationId,
	CronSchedule,
	ProjectArchivistBinding,
	AgentRecord,
} from "../../../shared/types.js";
import { useProjectStore } from "../../store/project-store.js";
import { useRequirementStore } from "../../store/requirement-store.js";
import { useAgentStore } from "../../store/agent-store.js";
import KanbanBoard from "./KanbanBoard.js";

const api = () => (window as any).api;

const STATUSES: { status: RequirementStatus; label: string; color: string }[] = [
	{ status: "found", label: "Found", color: "#8B8B8B" },
	{ status: "discuss", label: "Discuss", color: "#2196F3" },
	{ status: "ready", label: "Ready", color: "#4CAF50" },
	{ status: "plan", label: "Plan", color: "#9C27B0" },
	{ status: "build", label: "Build", color: "#FF9800" },
	{ status: "verify", label: "Verify", color: "#00BCD4" },
	{ status: "closed", label: "Closed", color: "#666" },
	{ status: "cancelled", label: "Cancelled", color: "#444" },
];

type Tab = "dashboard" | "view" | "kanban";

export default function ProjectPage() {
	const { projects, fetchProjects, removeProject } = useProjectStore();
	const { fetchRequirements } = useRequirementStore();
	const { agents } = useAgentStore();

	const [selectedProjectId, setSelectedProjectId] = useState<string>("");
	const [tab, setTab] = useState<Tab>("dashboard");
	const [container, setContainer] = useState<ProjectContainerView | null>(null);
	const [usage, setUsage] = useState<ProjectResourceUsage | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	// Run archivist agent picker (v0.8: enrich 可选 agent 实例 + 操作 + 自定义 prompt)
	const [showEnrichPicker, setShowEnrichPicker] = useState(false);
	const [enrichAgentId, setEnrichAgentId] = useState<string>("");
	const [enrichOperationId, setEnrichOperationId] = useState<WikiOperationId>("wiki-enrich");
	const [enrichCustomPrompt, setEnrichCustomPrompt] = useState<string>("");
	// Create form state
	const [newName, setNewName] = useState("");
	const [newDir, setNewDir] = useState("");
	const [newEnrich, setNewEnrich] = useState(false);
	const [creating, setCreating] = useState(false);
	const [createErr, setCreateErr] = useState<string>("");

	// Initial project list load
	useEffect(() => {
		fetchProjects();
	}, [fetchProjects]);

	// Auto-select first project when the list first populates.
	useEffect(() => {
		if (!selectedProjectId && projects.length > 0) {
			setSelectedProjectId(projects[0].id);
		}
		if (selectedProjectId && !projects.find((p) => p.id === selectedProjectId)) {
			// selection deleted — fall back to first or empty
			setSelectedProjectId(projects[0]?.id ?? "");
		}
	}, [projects, selectedProjectId]);

	const refreshContainer = useCallback(async (id: string) => {
		if (!id) { setContainer(null); setUsage(null); return; }
		try {
			const v = await api().projectsGet(id, true);
			setContainer(v as ProjectContainerView);
		} catch {
			setContainer(null);
		}
		try {
			const u = await api().projectsGetResourceUsage(id);
			setUsage(u as ProjectResourceUsage);
		} catch {
			setUsage(null);
		}
	}, []);

	// Reload container + usage when project selection changes. Also drive the
	// requirement store's project filter so the kanban tab matches the
	// selection.
	useEffect(() => {
		refreshContainer(selectedProjectId);
		fetchRequirements(selectedProjectId ? { projectId: selectedProjectId } : undefined);
	}, [selectedProjectId, refreshContainer, fetchRequirements]);

	const handleCreate = useCallback(async () => {
		setCreating(true);
		setCreateErr("");
		try {
			const p = (await api().projectsCreate({
				name: newName.trim() || "Untitled",
				workspaceDir: newDir.trim(),
				enrich: newEnrich,
			})) as ProjectRecord;
			await fetchProjects();
			setSelectedProjectId(p.id);
			setShowCreate(false);
			setNewName("");
			setNewDir("");
			setNewEnrich(false);
		} catch (e) {
			setCreateErr((e as Error).message ?? String(e));
		} finally {
			setCreating(false);
		}
	}, [newName, newDir, newEnrich, fetchProjects]);

	const handleDelete = useCallback(async (id: string) => {
		if (!confirm("Delete this project? Cascade-deletes requirements, wiki subtree, and project-scoped crons. Workspace files are NOT touched.")) return;
		try {
			await removeProject(id);
			await fetchProjects();
		} catch (e) {
			alert(`Delete failed: ${(e as Error).message}`);
		}
	}, [removeProject, fetchProjects]);

	// 手动起 agent 做 wiki 维护(后台、非阻塞)。v0.8 去-role + 无 fallback:
	// agentId 必填(必须选已存在、配了 Wiki 工具的 agent),operationId 选操作,
	// customPrompt 覆盖操作默认 prompt。
	const handleEnrich = useCallback(async (id: string, agentId: string, operationId: WikiOperationId, customPrompt?: string) => {
		setShowEnrichPicker(false);
		try {
			const r = await api().projectsEnrich(id, { via: { agentId }, operationId, prompt: customPrompt || undefined });
			alert(`已起 wiki 维护任务(后台运行)。\njob: ${r.jobId}\nsession: ${r.sessionId}`);
			refreshContainer(id);
		} catch (e) {
			alert(`Enrich failed: ${(e as Error).message}`);
		}
	}, [refreshContainer]);

	const selectedProject = useMemo(
		() => projects.find((p) => p.id === selectedProjectId) ?? null,
		[projects, selectedProjectId],
	);

	// enrich picker:当前选中 agent 的 Wiki 工具校验(无 Wiki 工具 → 禁用 Run + 提醒)。
	const enrichSelectedAgent = agents.find((a) => a.id === enrichAgentId);
	const enrichWikiOk = !!enrichSelectedAgent && !enrichSelectedAgent.toolPolicy?.blockedTools?.includes("Wiki");

	return (
		<div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary, #1a1a1c)" }}>
			{/* Toolbar */}
			<div style={{
				display: "flex", alignItems: "center", gap: 12,
				padding: "10px 16px", borderBottom: "1px solid var(--border-color, #333)",
			}}>
				<span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
					{"\u{1F4C1}"} Projects
				</span>
				<div style={{ flex: 1 }} />
				<button
					type="button"
					onClick={() => setShowCreate(true)}
					style={{
						padding: "4px 12px", background: "#2196F3", border: "none",
						borderRadius: 4, color: "#fff", fontSize: 12, cursor: "pointer",
					}}
				>
					+ New Project
				</button>
			</div>

			{/* Body: left list + right tabs */}
			<div style={{ flex: 1, display: "flex", minHeight: 0 }}>
				{/* Left rail — project list */}
				<div style={{
					flex: "0 0 220px",
					borderRight: "1px solid var(--border-color, #333)",
					overflowY: "auto",
					padding: 8,
				}}>
					{projects.length === 0 && (
						<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)", padding: 16, textAlign: "center" }}>
							No projects yet. Click "New Project" to bind a workspace.
						</div>
					)}
					{projects.map((p) => {
						const active = p.id === selectedProjectId;
						return (
							<div
								key={p.id}
								onClick={() => setSelectedProjectId(p.id)}
								style={{
									padding: "8px 10px",
									marginBottom: 4,
									borderRadius: 4,
									cursor: "pointer",
									background: active ? "rgba(33,150,243,0.18)" : "transparent",
									border: active ? "1px solid rgba(33,150,243,0.4)" : "1px solid transparent",
									fontSize: 12,
									color: active ? "var(--text-primary, #e0e0e0)" : "var(--text-secondary, #888)",
								}}
							>
								<div style={{ fontWeight: 600, marginBottom: 2 }}>{p.name}</div>
								<div style={{ fontSize: 10, color: "var(--text-tertiary, #555)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
									{p.workspaceDir}
								</div>
							</div>
						);
					})}
				</div>

				{/* Right pane — tabs */}
				<div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
					{/* Tab strip */}
					<div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border-color, #333)" }}>
						{([
							["dashboard", "Dashboard + Activity"],
							["view", "Project View"],
							["kanban", "Kanban"],
						] as Array<[Tab, string]>).map(([id, label]) => (
							<button
								key={id}
								type="button"
								onClick={() => setTab(id)}
								style={{
									padding: "8px 16px",
									background: tab === id ? "rgba(33,150,243,0.12)" : "transparent",
									color: tab === id ? "#2196F3" : "var(--text-secondary, #888)",
									border: "none",
									borderBottom: tab === id ? "2px solid #2196F3" : "2px solid transparent",
									fontSize: 12,
									fontWeight: 600,
									cursor: "pointer",
								}}
							>
								{label}
							</button>
						))}
						{selectedProject && (
							<>
								<div style={{ flex: 1 }} />
								<button
									type="button"
									onClick={() => {
									const firstWikiAgent = agents.find((a) => !a.toolPolicy?.blockedTools?.includes("Wiki"));
									setEnrichAgentId(firstWikiAgent?.id ?? agents[0]?.id ?? "");
									setEnrichOperationId("wiki-enrich");
									setEnrichCustomPrompt("");
									setShowEnrichPicker(true);
								}}
									title="起 agent 维护 wiki(后台,可选 agent/操作/自定义 prompt)"
									style={{
										alignSelf: "center", marginRight: 8,
										padding: "3px 10px", background: "transparent",
										border: "1px solid #2196F3", borderRadius: 4,
										color: "#2196F3", fontSize: 11, cursor: "pointer",
									}}
								>
									Run archivist
								</button>
								<button
									type="button"
									onClick={() => handleDelete(selectedProject.id)}
									style={{
										alignSelf: "center", marginRight: 8,
										padding: "3px 10px", background: "transparent",
										border: "1px solid #f44336", borderRadius: 4,
										color: "#f44336", fontSize: 11, cursor: "pointer",
									}}
								>
									Delete
								</button>
							</>
						)}
					</div>

					{/* Tab body */}
					<div style={{ flex: 1, overflow: "auto", padding: 16 }}>
						{!selectedProject ? (
							<EmptyState />
						) : tab === "dashboard" ? (
							<>
								<ArchivistBindingCard
									projectId={selectedProject.id}
									binding={container?.archivistBinding}
									agents={agents}
									onRefresh={() => refreshContainer(selectedProject.id)}
								/>
								<DashboardTab
									project={selectedProject}
									container={container}
									usage={usage}
									onRefresh={() => refreshContainer(selectedProject.id)}
								/>
							</>
						) : tab === "view" ? (
							<ProjectViewTab project={selectedProject} container={container} />
						) : (
							<div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
								<KanbanBoard projectId={selectedProject.id} />
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Create modal */}
			{showCreate && (
				<div style={{
					position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
					display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
				}} onClick={() => setShowCreate(false)}>
					<div
						onClick={(e) => e.stopPropagation()}
						style={{
							width: 420, background: "var(--bg-secondary, #1c1c1e)",
							border: "1px solid var(--border-color, #333)", borderRadius: 8, padding: 20,
						}}
					>
						<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary, #e0e0e0)", marginBottom: 12 }}>
							New Project
						</div>
						<div style={{ marginBottom: 10 }}>
							<label style={{ display: "block", fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 4 }}>
								Name
							</label>
							<input
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								placeholder="my-project"
								style={inputStyle}
							/>
						</div>
						<div style={{ marginBottom: 12 }}>
							<label style={{ display: "block", fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 4 }}>
								Workspace Dir (immutable after creation)
							</label>
							<input
								value={newDir}
								onChange={(e) => setNewDir(e.target.value)}
								placeholder="/path/to/workspace"
								style={inputStyle}
							/>
						</div>
						<label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary, #aaa)", marginBottom: 12, cursor: "pointer" }}>
							<input
								type="checkbox"
								checked={newEnrich}
								onChange={(e) => setNewEnrich(e.target.checked)}
							/>
							创建后立即深度充实 wiki(起 archivist agent,LLM 给每个节点写详 doc)
						</label>
						{createErr && (
							<div style={{ fontSize: 11, color: "#f44336", marginBottom: 8 }}>{createErr}</div>
						)}
						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
							<button type="button" onClick={() => setShowCreate(false)} style={cancelBtnStyle}>Cancel</button>
							<button
								type="button"
								onClick={handleCreate}
								disabled={creating || !newDir.trim()}
								style={primaryBtnStyle}
							>
								{creating ? "Creating…" : "Create"}
							</button>
						</div>
					</div>
				</div>
			)}

			{showEnrichPicker && selectedProject && (
				<div
					style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
					onClick={() => setShowEnrichPicker(false)}
				>
					<div
						onClick={(e) => e.stopPropagation()}
						style={{ width: 380, background: "var(--bg-secondary, #1c1c1e)", border: "1px solid var(--border-color, #333)", borderRadius: 8, padding: 20 }}
					>
						<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary, #e0e0e0)", marginBottom: 8 }}>
							Run archivist — wiki 维护
						</div>
						<div style={{ fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 12 }}>
							选一个配置了 Wiki 工具的 agent + 操作。无 fallback —— 必须选已存在的 agent。
						</div>

						<label style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>Agent</label>
						<select aria-label="Select agent for archivist" value={enrichAgentId} onChange={(e) => setEnrichAgentId(e.target.value)} style={{ ...inputStyle, marginBottom: 4 }}>
							<option value="">-- 选择 agent --</option>
							{agents.map((a) => {
								const ok = !a.toolPolicy?.blockedTools?.includes("Wiki");
								return <option key={a.id} value={a.id}>{a.name}{ok ? "" : " (无 Wiki 工具)"}</option>;
							})}
						</select>
						<div style={{ fontSize: 11, marginBottom: 12, color: enrichWikiOk ? "var(--success, #7ee787)" : "var(--danger, #f85149)" }}>
							{enrichAgentId ? (enrichWikiOk ? "✓ 已配置 Wiki 工具" : "✗ 未配置 Wiki 工具,无法维护 wiki(从 Archivist 模板创建一个)") : "请选择 agent"}
						</div>

						<label style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>操作</label>
						<select aria-label="Select wiki operation" value={enrichOperationId} onChange={(e) => setEnrichOperationId(e.target.value as WikiOperationId)} style={{ ...inputStyle, marginBottom: 12 }}>
							<option value="wiki-enrich">Wiki 充实(给空节点写详 doc)</option>
							<option value="doc-rebuild">Doc 重建(全量重扫 + LLM 写 summary)</option>
							<option value="git-update">Git 增量更新(只更新变化文件)</option>
						</select>

						<label style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>自定义 prompt(可选,覆盖操作默认)</label>
						<textarea
							aria-label="Custom prompt"
							value={enrichCustomPrompt}
							onChange={(e) => setEnrichCustomPrompt(e.target.value)}
							placeholder="留空用所选操作的默认 prompt"
							rows={3}
							style={{ ...inputStyle, width: "100%", marginBottom: 12, resize: "vertical" }}
						/>
						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
							<button type="button" onClick={() => setShowEnrichPicker(false)} style={cancelBtnStyle}>Cancel</button>
							<button
								type="button"
								disabled={!enrichAgentId || !enrichWikiOk}
								onClick={() => handleEnrich(selectedProject.id, enrichAgentId, enrichOperationId, enrichCustomPrompt || undefined)}
								style={{ ...primaryBtnStyle, opacity: (!enrichAgentId || !enrichWikiOk) ? 0.5 : 1, cursor: (!enrichAgentId || !enrichWikiOk) ? "not-allowed" : "pointer" }}
							>
								Run
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

// ─── Tab: Dashboard + Activity (§8.5) ─────────────────────────────────

function DashboardTab({
	project, container, usage, onRefresh,
}: {
	project: ProjectRecord;
	container: ProjectContainerView | null;
	usage: ProjectResourceUsage | null;
	onRefresh: () => void;
}) {
	const wiki = container?.wikiSummary;
	const scanPct = wiki?.scanProgress != null ? Math.round(wiki.scanProgress * 100) : null;
	return (
		<div>
			<div style={{ display: "flex", alignItems: "center", marginBottom: 16, gap: 8 }}>
				<div>
					<div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>{project.name}</div>
					<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>{project.workspaceDir}</div>
				</div>
				<div style={{ flex: 1 }} />
				<button type="button" onClick={onRefresh} style={ghostBtnStyle}>Refresh</button>
			</div>

			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
				{/* Update status */}
				<Card title="Update Status">
					<Row label="Wiki nodes" value={wiki ? String(wiki.nodeCount) : "—"} />
					<Row label="Last wiki update" value={wiki?.lastUpdated ? new Date(wiki.lastUpdated).toLocaleString() : "—"} />
					<Row label="Scan phase" value={wiki?.scanPhase ?? "idle"} />
					<Row label="Scan progress" value={scanPct != null ? `${scanPct}%` : "—"} />
					<Row label="Active sessions" value={String(container?.activeSessions?.length ?? 0)} />
				</Card>

				{/* Resource consumption */}
				<Card title="Resource Consumption">
					{usage ? (
						<>
							<Row label="Sessions" value={String(usage.sessionCount)} />
							<Row label="Input tokens" value={usage.inputTokens.toLocaleString()} />
							<Row label="Output tokens" value={usage.outputTokens.toLocaleString()} />
							<Row label="Total tokens" value={usage.totalTokens.toLocaleString()} />
							<Row label="Cache read" value={usage.cacheReadTokens.toLocaleString()} />
							<Row label="Cache write" value={usage.cacheWriteTokens.toLocaleString()} />
							<Row label="Reasoning" value={usage.reasoningTokens.toLocaleString()} />
							<Row label="Est. cost (USD)" value={`$${usage.estimatedCostUsd.toFixed(4)}`} />
						</>
					) : (
						<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>Loading…</div>
					)}
				</Card>
			</div>

			{/* Activity timeline — derived from requirement status_history + messages.
			    The container view itself doesn't ship status_history rows (those are
			    per-requirement); we render the requirements-by-status summary as the
			    coarsest activity signal. Sub2's e2e verifies the requirements
			    summary, not a fine-grained timeline. */}
			<Card title="Activity (requirements by status)">
				<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
					{container && STATUSES.map((s) => {
						const count = container.requirementsByStatus[s.status]?.length ?? 0;
						return (
							<div key={s.status} style={{
								padding: "4px 10px", borderRadius: 12,
								background: s.color + "22", border: `1px solid ${s.color}55`,
								color: s.color, fontSize: 11,
							}}>
								{s.label}: {count}
							</div>
						);
					})}
					{!container && (
						<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>Loading…</div>
					)}
				</div>
			</Card>
		</div>
	);
}

// ─── Tab: Project View (§8.4 visualization) ───────────────────────────

function ProjectViewTab({
	project, container,
}: {
	project: ProjectRecord;
	container: ProjectContainerView | null;
}) {
	if (!container) {
		return <div style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>Loading container view…</div>;
	}
	return (
		<div>
			<h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary, #e0e0e0)", marginBottom: 8 }}>
				{project.name} <span style={{ color: "var(--text-tertiary, #555)", fontWeight: 400 }}>(container view)</span>
			</h3>

			<Card title={`Requirements by status (${Object.values(container.requirementsByStatus).reduce((n, l) => n + l.length, 0)})`}>
				{STATUSES.map((s) => {
					const items = container.requirementsByStatus[s.status] ?? [];
					if (items.length === 0) return null;
					return (
						<div key={s.status} style={{ marginBottom: 6 }}>
							<div style={{ fontSize: 11, color: s.color, fontWeight: 600, marginBottom: 2 }}>{s.label}</div>
							{items.map((r) => (
								<div key={r.id} style={{ fontSize: 11, color: "var(--text-secondary, #888)", paddingLeft: 8 }}>
									{r.title}
								</div>
							))}
						</div>
					);
				})}
			</Card>

			<Card title={`Project-scoped crons (${container.crons.length})`}>
				{container.crons.length === 0 ? (
					<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>No project-scoped crons.</div>
				) : (
					container.crons.map((c) => (
						<div key={c.id} style={{ fontSize: 11, marginBottom: 4 }}>
							<span style={{ color: "var(--text-primary, #e0e0e0)" }}>{c.agentId}</span>
							{" — "}
							<span style={{ color: "var(--text-secondary, #888)" }}>
								{(c.schedule as any)?.mode} · enabled={String(c.enabled)}
							</span>
						</div>
					))
				)}
			</Card>

			<Card title={`Wiki subtree (${container.wikiSummary.nodeCount} nodes)`}>
				<Row label="Last update" value={container.wikiSummary.lastUpdated ? new Date(container.wikiSummary.lastUpdated).toLocaleString() : "—"} />
				<Row label="Scan phase" value={container.wikiSummary.scanPhase ?? "idle"} />
			</Card>

			<Card title={`Active sessions (${container.activeSessions.length})`}>
				{container.activeSessions.length === 0 ? (
					<div style={{ fontSize: 11, color: "var(--text-tertiary, #555)" }}>No active sessions for this project.</div>
				) : (
					container.activeSessions.map((s) => (
						<div key={s.sessionId} style={{ fontSize: 11, marginBottom: 2 }}>
							<span style={{ color: "var(--text-primary, #e0e0e0)" }}>{s.name}</span>
							{" — "}
							<span style={{ color: "var(--text-tertiary, #555)" }}>{s.sessionId}</span>
						</div>
					))
				)}
				<div style={{ fontSize: 10, color: "var(--text-tertiary, #555)", marginTop: 6 }}>
					Note: agent list is intentionally omitted — agents are global roles, not project members (§8.4).
				</div>
			</Card>
		</div>
	);
}

function EmptyState() {
	return (
		<div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
			<div style={{ fontSize: 13, color: "var(--text-tertiary, #555)", textAlign: "center" }}>
				Select a project on the left, or click "New Project" to bind a workspace.
			</div>
		</div>
	);
}

// ─── Small presentational helpers ─────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div style={{
			background: "var(--bg-secondary, #1c1c1e)",
			border: "1px solid var(--border-color, #333)",
			borderRadius: 6, padding: 12, marginBottom: 12,
		}}>
			<div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary, #888)", marginBottom: 8 }}>
				{title}
			</div>
			{children}
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", fontSize: 11, marginBottom: 3 }}>
			<div style={{ flex: "0 0 130px", color: "var(--text-tertiary, #555)" }}>{label}</div>
			<div style={{ flex: 1, color: "var(--text-primary, #e0e0e0)" }}>{value}</div>
		</div>
	);
}

const inputStyle: React.CSSProperties = {
	width: "100%", padding: "6px 8px", fontSize: 12,
	background: "var(--bg-primary, #1a1a1c)", border: "1px solid var(--border-color, #333)",
	borderRadius: 4, color: "var(--text-primary, #e0e0e0)", boxSizing: "border-box",
};
const primaryBtnStyle: React.CSSProperties = {
	padding: "6px 14px", background: "#2196F3", border: "none",
	borderRadius: 4, color: "#fff", fontSize: 12, cursor: "pointer",
};
const cancelBtnStyle: React.CSSProperties = {
	padding: "6px 14px", background: "transparent",
	border: "1px solid var(--border-color, #333)", borderRadius: 4,
	color: "var(--text-secondary, #888)", fontSize: 12, cursor: "pointer",
};
const ghostBtnStyle: React.CSSProperties = {
	padding: "3px 10px", background: "transparent",
	border: "1px solid var(--border-color, #333)", borderRadius: 4,
	color: "var(--text-secondary, #888)", fontSize: 11, cursor: "pointer",
};

// ─── v0.8 archivist 长期绑定卡片(阶段2) ────────────────────────────
// 未绑定 → "绑定 Archivist" 按钮(弹窗选 agent + 操作 + 每日定时);
// 已绑定 → 显示管理者 + 各操作 cron 状态 + 切换/暂停/解绑。
function ArchivistBindingCard({ projectId, binding, agents, onRefresh }: {
	projectId: string;
	binding: ProjectArchivistBinding | undefined;
	agents: AgentRecord[];
	onRefresh: () => void;
}) {
	const [showBind, setShowBind] = useState(false);
	const [bindAgentId, setBindAgentId] = useState("");
	const [bindOps, setBindOps] = useState<WikiOperationId[]>(["wiki-enrich"]);
	const [bindTime, setBindTime] = useState("09:00");
	const [bindGitAware, setBindGitAware] = useState(false);

	const ops = binding?.operations ?? [];
	const bound = !!binding?.agentId;
	const allEnabled = ops.length > 0 && ops.every((o) => o.enabled);
	const wikiAgents = agents.filter((a) => !a.toolPolicy?.blockedTools?.includes("Wiki"));

	const openBind = () => {
		setBindAgentId(wikiAgents[0]?.id ?? agents[0]?.id ?? "");
		setBindOps(["wiki-enrich"]);
		setBindTime("09:00");
		setBindGitAware(false);
		setShowBind(true);
	};
	const doBind = async () => {
		if (!bindAgentId || bindOps.length === 0) return;
		try {
			await api().projectsArchivistBind(projectId, {
				agentId: bindAgentId,
				operations: bindOps,
				schedule: { mode: "alarm", time: bindTime, days: [], tz: "Asia/Shanghai" } as CronSchedule,
				gitAware: bindGitAware,
			});
			setShowBind(false);
			onRefresh();
		} catch (e) { alert(`Bind failed: ${(e as Error).message}`); }
	};
	const doUnbind = async () => {
		if (!confirm("解绑该 project 的 archivist?将删除其绑定 cron(操作记录保留)。")) return;
		try { await api().projectsArchivistUnbind(projectId); onRefresh(); }
		catch (e) { alert(`Unbind failed: ${(e as Error).message}`); }
	};
	const doSwitch = async () => {
		const name = prompt("切换到哪个 agent?(输入 agent 名)", binding?.agentName ?? "");
		if (!name) return;
		const target = agents.find((a) => a.name === name);
		if (!target) { alert(`未找到 agent: ${name}`); return; }
		if (target.toolPolicy?.blockedTools?.includes("Wiki")) { alert(`Agent "${name}" 无 Wiki 工具,无法绑定`); return; }
		try { await api().projectsArchivistSwitchAgent(projectId, target.id); onRefresh(); }
		catch (e) { alert(`Switch failed: ${(e as Error).message}`); }
	};
	const doToggle = async () => {
		try { await api().projectsArchivistSetEnabled(projectId, !allEnabled); onRefresh(); }
		catch (e) { alert(`Toggle failed: ${(e as Error).message}`); }
	};

	const cardStyle: React.CSSProperties = { border: "1px solid var(--border-color, #333)", borderRadius: 8, padding: 12, marginBottom: 12, background: "var(--bg-secondary, #1c1c1e)" };
	const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-secondary, #888)" };

	return (
		<div style={cardStyle}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
				<span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>📚 Archivist 长期绑定</span>
				<div style={{ flex: 1 }} />
				{bound ? (
					<>
						<button type="button" onClick={doSwitch} style={ghostBtnStyle}>切换 agent</button>
						<button type="button" onClick={doToggle} style={ghostBtnStyle}>{allEnabled ? "暂停" : "恢复"}</button>
						<button type="button" onClick={doUnbind} style={{ ...ghostBtnStyle, color: "#f44336", borderColor: "#f44336" }}>解绑</button>
					</>
				) : (
					<button type="button" onClick={openBind} style={primaryBtnStyle}>绑定 Archivist</button>
				)}
			</div>
			{bound ? (
				<div>
					<div style={{ fontSize: 12, color: "var(--text-primary, #e0e0e0)", marginBottom: 6 }}>
						当前管理者: <strong>{binding!.agentName}</strong>
						{!allEnabled && <span style={{ color: "var(--warning, #d29922)" }}> (已暂停)</span>}
						{binding!.gitAware && <span style={{ color: "var(--success, #7ee787)" }}> (git 变更触发)</span>}
					</div>
					{ops.map((op) => (
						<div key={op.cronId} style={{ fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 2 }}>
							{op.operationId} — {op.enabled ? "启用" : "暂停"} · 上次:{op.lastStatus ?? "—"} {op.lastRunAt ?? ""} · 下次:{op.nextRunAt ?? "—"}
						</div>
					))}
				</div>
			) : (
				<div style={labelStyle}>未绑定。绑定后,所选 agent 按计划定时维护 wiki(去-role,用 agent 自带 Wiki 工具)。</div>
			)}

			{showBind && (
				<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setShowBind(false)}>
					<div onClick={(e) => e.stopPropagation()} style={{ width: 400, background: "var(--bg-secondary, #1c1c1e)", border: "1px solid var(--border-color, #333)", borderRadius: 8, padding: 20 }}>
						<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary, #e0e0e0)", marginBottom: 12 }}>绑定 Archivist — 长期 wiki 维护</div>
						<label style={labelStyle}>Agent(需有 Wiki 工具)</label>
						<select aria-label="Select agent for archivist binding" value={bindAgentId} onChange={(e) => setBindAgentId(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }}>
							{wikiAgents.length === 0 && <option value="">(无带 Wiki 工具的 agent — 先从 Archivist 模板创建)</option>}
							{wikiAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
						</select>
						<label style={labelStyle}>操作(可多选,各建一条 cron)</label>
						<div style={{ marginBottom: 12 }}>
							{(["wiki-enrich", "doc-rebuild", "git-update"] as WikiOperationId[]).map((op) => (
								<label key={op} style={{ fontSize: 12, color: "var(--text-primary, #e0e0e0)", display: "block" }}>
									<input type="checkbox" checked={bindOps.includes(op)} onChange={(e) => setBindOps(e.target.checked ? [...bindOps, op] : bindOps.filter((o) => o !== op))} /> {op}
								</label>
							))}
						</div>
						<label style={labelStyle}>每日定时(alarm)</label>
						<input type="time" aria-label="Schedule time" value={bindTime} onChange={(e) => setBindTime(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />
						<label style={{ fontSize: 12, color: "var(--text-primary, #e0e0e0)", display: "block", marginBottom: 12 }}>
							<input type="checkbox" checked={bindGitAware} onChange={(e) => setBindGitAware(e.target.checked)} /> git 变更触发(额外建高频轮询 cron,git 无变化时自动跳过 —— doc重建/git更新)
						</label>
						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
							<button type="button" onClick={() => setShowBind(false)} style={cancelBtnStyle}>Cancel</button>
							<button type="button" disabled={!bindAgentId || bindOps.length === 0 || wikiAgents.length === 0} onClick={doBind} style={{ ...primaryBtnStyle, opacity: (!bindAgentId || bindOps.length === 0 || wikiAgents.length === 0) ? 0.5 : 1 }}>绑定</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
