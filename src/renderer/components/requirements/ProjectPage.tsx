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
	ProjectWorkView,
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


	const selectedProject = useMemo(
		() => projects.find((p) => p.id === selectedProjectId) ?? null,
		[projects, selectedProjectId],
	);

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
								<ProjectWorkCard
									projectId={selectedProject.id}
									works={container?.projectWorks}
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


// ─── v0.8 project-work 卡片(取代工作流角色的"工位/工作"系统)──────────
// 列出 project 全部工位(默认 5 个空岗 + 自定义),每行:name / agent(空岗显
// "未分配"+分配按钮)/ 触发源(cron·hook·手动)/ 状态 / 操作(触发·暂停·删除)。
// 分配 agent 时校验 requiredTools(无该工具则禁用+提醒,无 fallback)。
function ProjectWorkCard({ projectId, works, agents, onRefresh }: {
	projectId: string;
	works: ProjectWorkView[] | undefined;
	agents: AgentRecord[];
	onRefresh: () => void;
}) {
	const [creating, setCreating] = useState(false);
	const [nName, setNName] = useState("");
	const [nPrompt, setNPrompt] = useState("");
	const [nAgent, setNAgent] = useState("");
	const [nCron, setNCron] = useState(false);
	const [nTime, setNTime] = useState("09:00");

	const list = works ?? [];

	const agentMeets = (agent: AgentRecord, tools: string[]) =>
		!tools.some((t) => agent.toolPolicy?.blockedTools?.includes(t));

	const doAssign = async (workId: string, requiredTools: string[]) => {
		const name = prompt("分配哪个 agent?(输入 agent 名)");
		if (!name) return;
		const target = agents.find((a) => a.name === name);
		if (!target) { alert(`未找到 agent: ${name}`); return; }
		if (!agentMeets(target, requiredTools)) { alert(`Agent "${name}" 缺少必需工具 ${requiredTools.join("/")}(被 blocked),无法分配`); return; }
		try { await api().projectsAssignWorkAgent(projectId, workId, target.id); onRefresh(); }
		catch (e) { alert(`Assign failed: ${(e as Error).message}`); }
	};
	const doTrigger = async (workId: string) => {
		try {
			const { result } = await api().projectsTriggerWork(projectId, workId);
			if (result.status === "ok") alert("已触发,后台运行");
			else if (result.status === "skipped") alert(`未触发:${result.reason}`);
			else alert(`触发失败:${result.error}`);
		} catch (e) { alert(`Trigger failed: ${(e as Error).message}`); }
	};
	const doToggle = async (workId: string, enabled: boolean) => {
		try { await api().projectsSetWorkEnabled(projectId, workId, !enabled); onRefresh(); }
		catch (e) { alert(`Toggle failed: ${(e as Error).message}`); }
	};
	const doDelete = async (workId: string, name: string) => {
		if (!confirm(`删除工位「${name}」?(含其 cron 触发器)`)) return;
		try { await api().projectsDeleteWork(projectId, workId); onRefresh(); }
		catch (e) { alert(`Delete failed: ${(e as Error).message}`); }
	};
	const doCreate = async () => {
		if (!nName.trim()) return;
		try {
			await api().projectsCreateWork(projectId, {
				name: nName.trim(),
				actionPrompt: nPrompt.trim() || undefined,
				agentId: nAgent || null,
				requiredTools: ["Wiki"],
				cronTriggers: nCron ? [{ schedule: { mode: "alarm", time: nTime, days: [], tz: "Asia/Shanghai" } as CronSchedule }] : undefined,
				runOnce: true,
			});
			setCreating(false); setNName(""); setNPrompt(""); setNAgent(""); setNCron(false);
			onRefresh();
		} catch (e) { alert(`Create failed: ${(e as Error).message}`); }
	};

	const cardStyle: React.CSSProperties = { border: "1px solid var(--border-color, #333)", borderRadius: 8, padding: 12, marginBottom: 12, background: "var(--bg-secondary, #1c1c1e)" };
	const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-secondary, #888)" };
	const wikiAgents = agents.filter((a) => !a.toolPolicy?.blockedTools?.includes("Wiki"));

	const triggerLabel = (w: ProjectWorkView): string => {
		const parts: string[] = [];
		if (w.cronTriggers.length > 0) parts.push(`cron·${w.cronTriggers.length}`);
		if (w.hasHookTrigger) parts.push("hook");
		parts.push("手动");
		return parts.join("/");
	};
	const scheduleLabel = (c: ProjectWorkView["cronTriggers"][number]): string => {
		const s = c.schedule;
		if (s.mode === "alarm") return `alarm ${s.time}`;
		if (s.mode === "interval") return `interval ${((s.everyMs ?? 0) / 60000)}min`;
		if (s.mode === "once") return `once ${s.at}`;
		return "schedule";
	};

	return (
		<div style={cardStyle}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
				<span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>{"\u{1F9F0}"} 工位(project-work)</span>
				<div style={{ flex: 1 }} />
				<button type="button" onClick={() => setCreating(true)} style={primaryBtnStyle}>+ 新建工位</button>
			</div>
			<div style={{ ...labelStyle, marginBottom: 6 }}>身份在 agent,行为在工位。默认 5 个空岗工位(需求管理/技术调研/文档充实/文档重建/git 同步),分配 agent 后即可触发。</div>
			{list.length === 0 ? (
				<div style={labelStyle}>暂无工位(新 project 会自动 seed 默认工位)。</div>
			) : list.map((w) => (
				<div key={w.id} style={{ border: "1px solid var(--border-color, #2a2a2a)", borderRadius: 6, padding: 8, marginBottom: 6 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<strong style={{ fontSize: 12, color: "var(--text-primary, #e0e0e0)" }}>{w.name}</strong>
						{!w.enabled && <span style={{ color: "var(--warning, #d29922)", fontSize: 11 }}>(已暂停)</span>}
						<div style={{ flex: 1 }} />
						<button type="button" onClick={() => doTrigger(w.id)} style={ghostBtnStyle}>立即触发</button>
						<button type="button" onClick={() => doToggle(w.id, w.enabled)} style={ghostBtnStyle}>{w.enabled ? "暂停" : "恢复"}</button>
						<button type="button" onClick={() => doDelete(w.id, w.name)} style={{ ...ghostBtnStyle, color: "#f44336", borderColor: "#f44336" }}>删除</button>
					</div>
					<div style={{ fontSize: 11, color: "var(--text-secondary, #888)", marginTop: 4 }}>
						负责 agent:{" "}
						{w.agentName ? (
							<strong>{w.agentName}</strong>
						) : (
							<>
								<span style={{ color: "var(--warning, #d29922)" }}>未分配</span>
								<button type="button" onClick={() => doAssign(w.id, w.requiredTools)} style={{ ...ghostBtnStyle, marginLeft: 6, fontSize: 10 }}>分配</button>
							</>
						)}
						{" · 触发:" + triggerLabel(w)}
						{" · 需 " + (w.requiredTools.join("/") || "—")}
						{w.lastRunAt && " · 上次 " + w.lastRunAt}
					</div>
					{w.cronTriggers.length > 0 && (
						<div style={{ fontSize: 10, color: "var(--text-tertiary, #666)", marginTop: 2 }}>
							{w.cronTriggers.map((c) => (
								<span key={c.cronId} style={{ marginRight: 12 }}>
									{c.gitAware ? "git-aware " : ""}{scheduleLabel(c)}{!c.enabled ? " (暂停)" : ""}{c.lastStatus ? ` · ${c.lastStatus}` : ""}
								</span>
							))}
						</div>
					)}
				</div>
			))}

			{creating && (
				<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setCreating(false)}>
					<div onClick={(e) => e.stopPropagation()} style={{ width: 440, background: "var(--bg-secondary, #1c1c1e)", border: "1px solid var(--border-color, #333)", borderRadius: 8, padding: 20 }}>
						<div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary, #e0e0e0)", marginBottom: 12 }}>新建工位</div>
						<label style={labelStyle}>工位名(具体职责)</label>
						<input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="如:接口评审 / 依赖升级" style={{ ...inputStyle, marginBottom: 12 }} />
						<label style={labelStyle}>动作 prompt(做什么;留空则后续编辑)</label>
						<textarea value={nPrompt} onChange={(e) => setNPrompt(e.target.value)} rows={4} placeholder="描述这项工作要做什么、按什么顺序..." style={{ ...inputStyle, marginBottom: 12, fontFamily: "monospace" }} />
						<label style={labelStyle}>分配 agent(可选,需有 Wiki 工具;留空=空岗)</label>
						<select value={nAgent} onChange={(e) => setNAgent(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }}>
							<option value="">(空岗 — 暂不分配)</option>
							{wikiAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
						</select>
						<label style={{ fontSize: 12, color: "var(--text-primary, #e0e0e0)", display: "block", marginBottom: 4 }}>
							<input type="checkbox" checked={nCron} onChange={(e) => setNCron(e.target.checked)} /> 加 cron 触发器(每日 alarm)
						</label>
						{nCron && (
							<input type="time" value={nTime} onChange={(e) => setNTime(e.target.value)} style={{ ...inputStyle, marginBottom: 12 }} />
						)}
						<label style={{ fontSize: 12, color: "var(--text-secondary, #888)", display: "block", marginBottom: 12 }}>
							<input type="checkbox" checked readOnly /> 创建后立刻执行一次
						</label>
						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
							<button type="button" onClick={() => setCreating(false)} style={cancelBtnStyle}>Cancel</button>
							<button type="button" disabled={!nName.trim()} onClick={doCreate} style={{ ...primaryBtnStyle, opacity: nName.trim() ? 1 : 0.5 }}>创建</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
