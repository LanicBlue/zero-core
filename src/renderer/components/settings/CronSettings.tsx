// Cron 编辑器 UI (v0.8 M1)
//
// # 文件说明书
//
// ## 核心功能
// 列出全部 cron 条目,并提供「新建 / 编辑 / 删除 / 手动触发」入口。
// 表单字段:agent(下拉) + scope(projectId 可选 + workspaceDir + wikiRootNodeId)
// + schedule(off/hourly/daily/weekly/自定义) + prompt(可选) + enabled toggle。
//
// 选了 projectId 时,workspaceDir 与 wikiRootNodeId 自动从 project 派生
// (项目 cron);不选 projectId 时是全局观察 cron,workspaceDir 留空填、
// wikiRootNodeId 默认 global-root。
//
// ## 输入
// - useCronStore / useAgentStore / useProjectStore
//
// ## 输出
// - Cron 编辑器 JSX
//
// ## 定位
// src/renderer/components/settings/ — Settings 页面的 Cron 分区
//
// ## 依赖
// - react
// - ../../store/cron-store / agent-store / project-store
// - ../../../shared/types
//

import { useEffect, useMemo, useState } from "react";
import { useCronStore } from "../../store/cron-store.js";
import { useAgentStore } from "../../store/agent-store.js";
import { useProjectStore } from "../../store/project-store.js";
import type { CronRecord, CronSchedule } from "../../../shared/types.js";

const GLOBAL_WIKI_ROOT = "wiki-root:global";
const SCHEDULE_OPTIONS: { value: CronSchedule; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "hourly", label: "Hourly" },
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
];

interface FormState {
	id?: string;
	agentId: string;
	projectId: string;        // "" = global observation cron
	workspaceDir: string;     // editable for global; auto from project for project cron
	wikiRootNodeId: string;   // editable; auto-filled from project default
	schedule: CronSchedule;
	prompt: string;
	enabled: boolean;
}

const EMPTY_FORM: FormState = {
	agentId: "",
	projectId: "",
	workspaceDir: "",
	wikiRootNodeId: GLOBAL_WIKI_ROOT,
	schedule: "daily",
	prompt: "",
	enabled: true,
};

export function CronSettings() {
	const { crons, loading, fetchCrons, createCron, updateCron, removeCron, triggerCron } = useCronStore();
	const { agents, fetchAgents } = useAgentStore();
	const { projects, fetchProjects } = useProjectStore();
	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [editing, setEditing] = useState(false);

	useEffect(() => {
		fetchCrons();
		fetchAgents();
		fetchProjects();
	}, [fetchCrons, fetchAgents, fetchProjects]);

	const projectsById = useMemo(() => {
		const m = new Map(projects.map((p) => [p.id, p]));
		return m;
	}, [projects]);

	// When projectId changes, derive workspaceDir + wikiRootNodeId from project.
	const onProjectChange = (projectId: string) => {
		if (!projectId) {
			setForm((f) => ({ ...f, projectId: "", wikiRootNodeId: GLOBAL_WIKI_ROOT, workspaceDir: "" }));
			return;
		}
		const project = projectsById.get(projectId);
		setForm((f) => ({
			...f,
			projectId,
			workspaceDir: project?.workspaceDir ?? f.workspaceDir,
			wikiRootNodeId: `wiki-root:${projectId}`,
		}));
	};

	const startEdit = (cron: CronRecord) => {
		setEditing(true);
		setForm({
			id: cron.id,
			agentId: cron.agentId,
			projectId: cron.workingScope.projectId ?? "",
			workspaceDir: cron.workingScope.workspaceDir,
			wikiRootNodeId: cron.workingScope.wikiRootNodeId,
			schedule: cron.schedule as CronSchedule,
			prompt: cron.prompt ?? "",
			enabled: cron.enabled,
		});
	};

	const startCreate = () => {
		setEditing(true);
		setForm(EMPTY_FORM);
	};

	const cancel = () => {
		setEditing(false);
		setForm(EMPTY_FORM);
	};

	const canSave =
		form.agentId &&
		form.workspaceDir &&
		form.wikiRootNodeId &&
		form.schedule;

	const save = async () => {
		if (!canSave) return;
		const payload = {
			agentId: form.agentId,
			workingScope: {
				projectId: form.projectId || undefined,
				workspaceDir: form.workspaceDir,
				wikiRootNodeId: form.wikiRootNodeId,
			},
			schedule: form.schedule,
			prompt: form.prompt || undefined,
			enabled: form.enabled,
		};
		if (editing && form.id) {
			await updateCron(form.id, payload);
		} else {
			await createCron(payload as any);
		}
		cancel();
	};

	const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
	const projectName = (id?: string) => (id ? (projectsById.get(id)?.name ?? id) : "(global)");

	return (
		<div className="cron-settings">
			<div className="section-title-row">
				<h3>Cron Schedules</h3>
				{!editing && (
					<button type="button" className="btn-primary btn-sm" onClick={startCreate}>+ Add Cron</button>
				)}
			</div>

			{loading && <p className="settings-empty">Loading crons...</p>}
			{!loading && crons.length === 0 && !editing && (
				<p className="settings-empty">No cron entries yet. A cron schedules a global agent to run on a recurring cadence against a working scope.</p>
			)}

			{crons.length > 0 && !editing && (
				<div className="cron-list">
					{crons.map((cron) => (
						<div key={cron.id} className="cron-card">
							<div className="cron-card-header">
								<span className="cron-card-agent">{agentName(cron.agentId)}</span>
								<span className={`cron-badge ${cron.enabled && cron.schedule !== "off" ? "on" : "off"}`}>
									{cron.enabled ? cron.schedule : "disabled"}
								</span>
							</div>
							<div className="cron-card-scope">
								project: {projectName(cron.workingScope.projectId)} · ws: {cron.workingScope.workspaceDir}
							</div>
							{cron.prompt && <div className="cron-card-prompt">{cron.prompt}</div>}
							<div className="cron-card-actions">
								<button type="button" className="btn-ghost btn-sm" onClick={() => startEdit(cron)}>Edit</button>
								<button type="button" className="btn-ghost btn-sm" onClick={() => triggerCron(cron.id)}>Trigger</button>
								<button type="button" className="btn-ghost btn-sm" onClick={() => { void removeCron(cron.id); }}>Delete</button>
							</div>
						</div>
					))}
				</div>
			)}

			{editing && (
				<div className="cron-editor">
					<div className="workspace-config-row">
						<label className="config-label">Agent</label>
						<select className="default-model-select" value={form.agentId} onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}>
							<option value="">— Select agent —</option>
							{agents.map((a) => (
								// v0.8 (P0 §1.4): roleTag removed from AgentRecord;
								// legacy tag still carried on the row for display
								// via cast until P2/P7 lands UI migration.
								// @ts-expect-error — P0 §1.4: legacy roleTag field; P2/P7 cleanup.
								<option key={a.id} value={a.id}>{a.name}{a.roleTag ? ` (${a.roleTag})` : ""}</option>
							))}
						</select>
					</div>

					<div className="workspace-config-row">
						<label className="config-label">Project (optional — leave blank for global observation cron)</label>
						<select className="default-model-select" value={form.projectId} onChange={(e) => onProjectChange(e.target.value)}>
							<option value="">(global)</option>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>{p.name}</option>
							))}
						</select>
					</div>

					<div className="workspace-config-row">
						<label className="config-label">Workspace Dir</label>
						<input
							className="workspace-dir-input"
							value={form.workspaceDir}
							placeholder={form.projectId ? "(auto from project)" : "/abs/workspace/dir"}
							onChange={(e) => setForm((f) => ({ ...f, workspaceDir: e.target.value }))}
						/>
					</div>

					<div className="workspace-config-row">
						<label className="config-label">Wiki Root Node Id</label>
						<input
							className="workspace-dir-input"
							value={form.wikiRootNodeId}
							onChange={(e) => setForm((f) => ({ ...f, wikiRootNodeId: e.target.value }))}
						/>
					</div>

					<div className="workspace-config-row">
						<label className="config-label">Schedule</label>
						<select
							className="default-model-select"
							value={SCHEDULE_OPTIONS.some((o) => o.value === form.schedule) ? form.schedule : "custom"}
							onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value as CronSchedule }))}
						>
							{SCHEDULE_OPTIONS.map((o) => (
								<option key={o.value} value={o.value}>{o.label}</option>
							))}
							<option value="custom">Custom…</option>
						</select>
						{!SCHEDULE_OPTIONS.some((o) => o.value === form.schedule) && (
							<input
								className="workspace-dir-input"
								placeholder="ms interval e.g. 3600000"
								value={form.schedule}
								onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))}
							/>
						)}
					</div>

					<div className="workspace-config-row">
						<label className="config-label">Prompt (optional — defaults to a check-in prompt)</label>
						<textarea
							className="cron-prompt-textarea"
							rows={3}
							value={form.prompt}
							placeholder="What should this cron run on each trigger?"
							onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
						/>
					</div>

					<div className="workspace-config-row cron-toggle-row">
						<label className="config-label">Enabled</label>
						<input
							type="checkbox"
							checked={form.enabled}
							onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
						/>
					</div>

					<div className="cron-editor-actions">
						<button type="button" className="btn-primary btn-sm" onClick={save} disabled={!canSave}>
							{form.id ? "Update" : "Create"}
						</button>
						<button type="button" className="btn-ghost btn-sm" onClick={cancel}>Cancel</button>
					</div>
				</div>
			)}
		</div>
	);
}
