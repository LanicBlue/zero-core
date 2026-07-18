// Cron 调度台 (v0.8 P4 §9.5)
//
// # 文件说明书
//
// ## 核心功能
// Cron 的顶级页面 (调度台),从 settings 移出 (§9.5)。三块:
//   1. 顶部 24h 时间轴 —— 今天各 cron 的触发时刻按 (HH:MM)/(interval 比例)
//      标在时间轴上,颜色按 agent,当前时刻游标。
//   2. 主体闹钟卡片网格 —— 卡片含: agent / scope / 下次时间 / 重复标签 /
//      启用 toggle / 状态点 / 倒计时 / 立即运行 / 展开 history (cron_runs)。
//   3. 分组切换 (by agent / by project) + 闹钟式新建表单
//      (mode → agent+scope → time/repeat → prompt)。
//
// 三模式 (§9.1): once / alarm / interval。alarm 用 (time, days, tz) 在卡片显示;
// interval 显示每 Xh/Ym; once 显示绝对时间 + 「一次性」标签。
//
// ## 输入
// - useCronStore / useAgentStore / useProjectStore
//
// ## 输出
// - 调度台页面 JSX
//
// ## 定位
// src/renderer/components/cron/ — 顶级页面,被 AppLayout 按 activePage==="cron" 渲染。
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
import type {
	CronRecord,
	CronSchedule,
	CronScheduleAlarm,
	CronScheduleInterval,
	CronScheduleOnce,
} from "../../../shared/types.js";

const GLOBAL_WIKI_ROOT = "wiki-root:global";
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type GroupBy = "agent" | "project";
type Mode = "once" | "alarm" | "interval";

interface FormState {
	id?: string;
	agentId: string;
	projectId: string;
	workspaceDir: string;
	wikiRootNodeId: string;
	mode: Mode;
	// once
	onceDate: string; // YYYY-MM-DD
	onceTime: string; // HH:MM
	// alarm
	alarmTime: string; // HH:MM
	alarmDays: number[]; // ISO 1..7
	// interval
	intervalMinutes: number; // user-facing minutes (≥1)
	prompt: string;
	enabled: boolean;
}

const EMPTY_FORM: FormState = {
	agentId: "",
	projectId: "",
	workspaceDir: "",
	wikiRootNodeId: GLOBAL_WIKI_ROOT,
	mode: "interval",
	onceDate: today(),
	onceTime: "09:00",
	alarmTime: "09:00",
	alarmDays: [],
	intervalMinutes: 60,
	prompt: "",
	enabled: true,
};

function today(): string {
	const d = new Date();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

function localTz(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** Build a CronSchedule from the form state. */
function scheduleFromForm(f: FormState): CronSchedule {
	if (f.mode === "once") {
		const iso = `${f.onceDate}T${f.onceTime}:00`;
		const sched: CronScheduleOnce = { mode: "once", at: new Date(iso).toISOString() };
		return sched;
	}
	if (f.mode === "alarm") {
		const sched: CronScheduleAlarm = {
			mode: "alarm",
			time: f.alarmTime,
			days: f.alarmDays.slice().sort((a, b) => a - b),
			tz: localTz(),
		};
		return sched;
	}
	const sched: CronScheduleInterval = {
		mode: "interval",
		everyMs: Math.max(1, f.intervalMinutes) * 60 * 1000,
	};
	return sched;
}

export default function CronDashboard() {
	const { crons, runsByCron, fetchCrons, fetchRuns, createCron, updateCron, removeCron, triggerCron } = useCronStore();
	const { agents, fetchAgents } = useAgentStore();
	const { projects, fetchProjects } = useProjectStore();
	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [editing, setEditing] = useState(false);
	const [groupBy, setGroupBy] = useState<GroupBy>("agent");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [, forceTick] = useState(0);

	// N3 (runtime-push-ui-sync): 1s local-clock tick so countdowns / now-cursor
	// move smoothly. This is the DECLARED exception to "zero setInterval" — it
	// performs NO fetch (forceTick only re-renders; cron records arrive via
	// cron-store's data:changed subscription, mounted pull-on-display below).
	useEffect(() => {
		const t = setInterval(() => forceTick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, []);

	useEffect(() => {
		fetchCrons();
		fetchAgents();
		fetchProjects();
	}, [fetchCrons, fetchAgents, fetchProjects]);

	const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
	const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

	// Stable color per agent for the timeline markers.
	const agentColor = useMemo(() => {
		const palette = [
			"#4f8cff", "#22b8a6", "#f59e0b", "#ec4899",
			"#8b5cf6", "#10b981", "#ef4444", "#06b6d4",
		];
		const m = new Map<string, string>();
		agents.forEach((a, i) => m.set(a.id, palette[i % palette.length]));
		return m;
	}, [agents]);

	const agentName = (id: string) => agentsById.get(id)?.name ?? id;
	const projectName = (id?: string) => (id ? (projectsById.get(id)?.name ?? id) : "(global)");

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
		const s = cron.schedule;
		const base: FormState = {
			id: cron.id,
			agentId: cron.agentId,
			projectId: cron.workingScope.projectId ?? "",
			workspaceDir: cron.workingScope.workspaceDir,
			wikiRootNodeId: cron.workingScope.wikiRootNodeId,
			mode: s.mode,
			onceDate: today(),
			onceTime: "09:00",
			alarmTime: "09:00",
			alarmDays: [],
			intervalMinutes: 60,
			prompt: cron.prompt ?? "",
			enabled: cron.enabled,
		};
		if (s.mode === "once") {
			const d = new Date(s.at);
			base.onceDate = d.toISOString().slice(0, 10);
			base.onceTime = d.toISOString().slice(11, 16);
		} else if (s.mode === "alarm") {
			base.alarmTime = s.time;
			base.alarmDays = s.days.slice();
		} else {
			base.intervalMinutes = Math.max(1, Math.round(s.everyMs / 60000));
		}
		setEditing(true);
		setForm(base);
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
		(form.mode !== "interval" || form.intervalMinutes >= 1);

	const save = async () => {
		if (!canSave) return;
		const payload = {
			agentId: form.agentId,
			workingScope: {
				projectId: form.projectId || undefined,
				workspaceDir: form.workspaceDir,
				wikiRootNodeId: form.wikiRootNodeId,
			},
			schedule: scheduleFromForm(form),
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

	const toggleExpanded = (cronId: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(cronId)) {
				next.delete(cronId);
			} else {
				next.add(cronId);
				if (!runsByCron[cronId]) void fetchRuns(cronId);
			}
			return next;
		});
	};

	// Group crons for display.
	const grouped = useMemo(() => {
		const m = new Map<string, { key: string; label: string; crons: CronRecord[] }>();
		for (const c of crons) {
			const key = groupBy === "agent" ? c.agentId : (c.workingScope.projectId ?? "__global__");
			const label = groupBy === "agent" ? agentName(c.agentId) : projectName(c.workingScope.projectId);
			if (!m.has(key)) m.set(key, { key, label, crons: [] });
			m.get(key)!.crons.push(c);
		}
		return Array.from(m.values());
	}, [crons, groupBy, agentName, projectName]);

	return (
		<div className="cron-dashboard">
			<div className="cron-dashboard-header">
				<h2>Cron Scheduling Console</h2>
				<div className="cron-dashboard-actions">
					<div className="cron-group-toggle">
						<button
							type="button"
							className={`btn-ghost btn-sm ${groupBy === "agent" ? "active" : ""}`}
							onClick={() => setGroupBy("agent")}
						>By Agent</button>
						<button
							type="button"
							className={`btn-ghost btn-sm ${groupBy === "project" ? "active" : ""}`}
							onClick={() => setGroupBy("project")}
						>By Project</button>
					</div>
					{!editing && (
						<button type="button" className="btn-primary btn-sm" onClick={startCreate}>+ New Cron</button>
					)}
				</div>
			</div>

			<CronTimeline crons={crons} agentColor={agentColor} agentName={agentName} />

			{crons.length === 0 && !editing && (
				<p className="settings-empty">No cron entries yet. Create one to schedule a global agent on a recurring cadence.</p>
			)}

			<div className="cron-dashboard-body">
				<div className="cron-groups">
					{grouped.map((g) => (
						<div key={g.key} className="cron-group">
							<div className="cron-group-header">{g.label} <span className="cron-group-count">{g.crons.length}</span></div>
							<div className="cron-cards">
								{g.crons.map((cron) => (
									<CronCard
										key={cron.id}
										cron={cron}
										agentName={agentName(cron.agentId)}
										projectName={projectName(cron.workingScope.projectId)}
										color={agentColor.get(cron.agentId) ?? "#6b7280"}
										expanded={expanded.has(cron.id)}
										runs={runsByCron[cron.id]}
										onToggleExpand={() => toggleExpanded(cron.id)}
										onEdit={() => startEdit(cron)}
										onTrigger={() => { void triggerCron(cron.id); }}
										onDelete={() => { void removeCron(cron.id); }}
										onToggleEnabled={() => {
											void updateCron(cron.id, { enabled: !cron.enabled });
										}}
									/>
								))}
							</div>
						</div>
					))}
				</div>

				{editing && (
					<CronAlarmForm
						form={form}
						setForm={setForm}
						agents={agents}
						projects={projects}
						onProjectChange={onProjectChange}
						onCancel={cancel}
						onSave={save}
						canSave={!!canSave}
					/>
				)}
			</div>
		</div>
	);
}

// ─── 24h timeline ──────────────────────────────────────────────────

function CronTimeline({
	crons, agentColor, agentName,
}: {
	crons: CronRecord[];
	agentColor: Map<string, string>;
	agentName: (id: string) => string;
}) {
	const now = new Date();
	const nowMinutes = now.getHours() * 60 + now.getMinutes();

	// For each enabled cron, compute today's trigger minutes that fall in [0,1440).
	const marks = useMemo(() => {
		const out: { minutes: number; cronId: string; label: string; color: string; title: string }[] = [];
		for (const c of crons) {
			if (!c.enabled) continue;
			const s = c.schedule;
			if (s.mode === "alarm") {
				const [h, m] = s.time.split(":").map((n) => parseInt(n, 10));
				const mins = h * 60 + m;
				const isoToday = now.getDay() === 0 ? 7 : now.getDay();
				if (s.days.length === 0 || s.days.includes(isoToday)) {
					out.push({ minutes: mins, cronId: c.id, label: "A", color: agentColor.get(c.agentId) ?? "#6b7280", title: `${agentName(c.agentId)} @ ${s.time}` });
				}
			} else if (s.mode === "interval") {
				const periodMin = Math.max(1, Math.round(s.everyMs / 60000));
				// Drop a mark every period, capped to keep the axis readable.
				const step = Math.max(periodMin, 60);
				for (let mm = step; mm < 1440; mm += step) {
					out.push({ minutes: mm, cronId: c.id, label: "I", color: agentColor.get(c.agentId) ?? "#6b7280", title: `${agentName(c.agentId)} every ${Math.round(s.everyMs / 60000)}m` });
				}
			} else if (s.mode === "once") {
				const d = new Date(s.at);
				if (d.toDateString() === now.toDateString()) {
					out.push({ minutes: d.getHours() * 60 + d.getMinutes(), cronId: c.id, label: "1", color: agentColor.get(c.agentId) ?? "#6b7280", title: `${agentName(c.agentId)} once @ ${d.toLocaleTimeString()}` });
				}
			}
		}
		return out;
	}, [crons, agentColor, agentName, now]);

	return (
		<div className="cron-timeline">
			<div className="cron-timeline-axis">
				{[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
					<div key={h} className="cron-timeline-tick" style={{ left: `${(h / 24) * 100}%` }}>
						<span className="cron-timeline-tick-label">{String(h).padStart(2, "0")}:00</span>
					</div>
				))}
				{marks.map((mk, i) => (
					<div
						key={`${mk.cronId}-${i}`}
						className="cron-timeline-mark"
						style={{ left: `${(mk.minutes / 1440) * 100}%`, background: mk.color }}
						title={mk.title}
					>{mk.label}</div>
				))}
				<div className="cron-timeline-now" style={{ left: `${(nowMinutes / 1440) * 100}%` }} title={`now ${now.toLocaleTimeString()}`} />
			</div>
		</div>
	);
}

// ─── Alarm card ────────────────────────────────────────────────────

function CronCard({
	cron, agentName, projectName, color, expanded, runs,
	onToggleExpand, onEdit, onTrigger, onDelete, onToggleEnabled,
}: {
	cron: CronRecord;
	agentName: string;
	projectName: string;
	color: string;
	expanded: boolean;
	runs?: import("../../../shared/types.js").CronRunRecord[];
	onToggleExpand: () => void;
	onEdit: () => void;
	onTrigger: () => void;
	onDelete: () => void;
	onToggleEnabled: () => void;
}) {
	const repeatLabel = repeatLabelFor(cron.schedule);
	const statusDot = statusDotClass(cron);
	const countdown = countdownFor(cron);

	return (
		<div className={`cron-card ${cron.enabled ? "" : "disabled"}`}>
			<div className="cron-card-top">
				<span className="cron-card-agent" style={{ color }}>{agentName}</span>
				<span className={`cron-card-status-dot ${statusDot}`} title={cron.lastStatus ?? "—"} />
				<label className="cron-card-toggle">
					<input type="checkbox" checked={cron.enabled} onChange={onToggleEnabled} />
					<span>{cron.enabled ? "on" : "off"}</span>
				</label>
			</div>
			<div className="cron-card-scope">scope: {projectName}</div>
			<div className="cron-card-schedule">
				<span className="cron-card-repeat">{repeatLabel}</span>
				{cron.nextRunAt && (
					<span className="cron-card-next" title={cron.nextRunAt}>
						next: {new Date(cron.nextRunAt).toLocaleString()} {countdown && `(${countdown})`}
					</span>
				)}
			</div>
			{cron.lastError && <div className="cron-card-error" title={cron.lastError}>{cron.lastError}</div>}
			{cron.prompt && <div className="cron-card-prompt">{cron.prompt}</div>}
			<div className="cron-card-actions">
				<button type="button" className="btn-ghost btn-sm" onClick={onTrigger}>Run now</button>
				<button type="button" className="btn-ghost btn-sm" onClick={onEdit}>Edit</button>
				<button type="button" className="btn-ghost btn-sm" onClick={onToggleExpand}>{expanded ? "Hide history" : "History"}</button>
				<button type="button" className="btn-ghost btn-sm" onClick={onDelete}>Delete</button>
			</div>
			{expanded && (
				<CronRunsList runs={runs} />
			)}
		</div>
	);
}

function CronRunsList({ runs }: { runs?: import("../../../shared/types.js").CronRunRecord[] }) {
	if (!runs || runs.length === 0) {
		return <div className="cron-runs-empty">No runs recorded yet.</div>;
	}
	return (
		<div className="cron-runs">
			{runs.map((r) => (
				<div key={r.id} className={`cron-run-row ${r.success ? "ok" : "fail"}`}>
					<span className="cron-run-time">{new Date(r.firedAt).toLocaleString()}</span>
					<span className="cron-run-status">{r.success ? "ok" : "failed"}</span>
					{r.durationMs !== undefined && <span className="cron-run-duration">{Math.round(r.durationMs / 1000)}s</span>}
					{r.error && <span className="cron-run-error" title={r.error}>{r.error}</span>}
				</div>
			))}
		</div>
	);
}

function repeatLabelFor(s: CronSchedule): string {
	if (s.mode === "once") return "once";
	if (s.mode === "interval") {
		const mins = Math.round(s.everyMs / 60000);
		if (mins >= 60 && mins % 60 === 0) return `every ${mins / 60}h`;
		return `every ${mins}m`;
	}
	// alarm
	if (s.days.length === 0) return `daily @ ${s.time}`;
	if (s.days.length === 7) return `daily @ ${s.time}`;
	const labels = s.days.slice().sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d - 1]);
	return `${labels.join(",")} @ ${s.time}`;
}

function statusDotClass(cron: CronRecord): string {
	if (!cron.enabled) return "off";
	if (cron.lastStatus === "failed") return "failed";
	if (cron.lastStatus === "missed") return "missed";
	if (cron.lastStatus === "ok") return "ok";
	return "idle";
}

function countdownFor(cron: CronRecord): string | null {
	if (!cron.nextRunAt) return null;
	const next = Date.parse(cron.nextRunAt);
	if (!Number.isFinite(next)) return null;
	const delta = next - Date.now();
	if (delta <= 0) return "due";
	const s = Math.floor(delta / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `in ${h}h ${m}m`;
	if (m > 0) return `in ${m}m ${sec}s`;
	return `in ${sec}s`;
}

// ─── New-alarm form ────────────────────────────────────────────────

function CronAlarmForm({
	form, setForm, agents, projects, onProjectChange, onCancel, onSave, canSave,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
	agents: import("../../../shared/types.js").AgentRecord[];
	projects: import("../../../shared/types.js").ProjectRecord[];
	onProjectChange: (projectId: string) => void;
	onCancel: () => void;
	onSave: () => void;
	canSave: boolean;
}) {
	const toggleDay = (d: number) => {
		setForm((f) => ({
			...f,
			alarmDays: f.alarmDays.includes(d) ? f.alarmDays.filter((x) => x !== d) : [...f.alarmDays, d],
		}));
	};
	return (
		<div className="cron-alarm-form">
			<div className="cron-alarm-form-title">{form.id ? "Edit Cron" : "New Cron"}</div>

			<div className="workspace-config-row">
				<label className="config-label">Mode</label>
				<div className="cron-mode-row">
					{(["interval", "alarm", "once"] as Mode[]).map((m) => (
						<button
							key={m}
							type="button"
							className={`btn-ghost btn-sm ${form.mode === m ? "active" : ""}`}
							onClick={() => setForm((f) => ({ ...f, mode: m }))}
						>{m}</button>
					))}
				</div>
			</div>

			<div className="workspace-config-row">
				<label className="config-label">Agent</label>
				<select className="default-model-select" value={form.agentId} onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}>
					<option value="">— Select agent —</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>{a.name}</option>
					))}
				</select>
			</div>

			<div className="workspace-config-row">
				<label className="config-label">Project (optional — blank = global observation)</label>
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
				<label className="config-label">
					Wiki Root Node Id
					<span className="config-label-hint" title="plan-08 §E7: wiki scope is now driven by the bound agent's wikiGrants (configured in Agent Editor → Wiki Access), not by this field. The cron's workingScope.wikiRootNodeId is preserved for back-compat but ignored at runtime.">
						(disabled — see Agent Editor → Wiki Access)
					</span>
				</label>
				<input
					className="workspace-dir-input"
					value={form.wikiRootNodeId}
					onChange={(e) => setForm((f) => ({ ...f, wikiRootNodeId: e.target.value }))}
					disabled
					title="plan-08 §E7: Wiki scope is driven by the bound agent's wikiGrants (Agent Editor → Wiki Access). This field is preserved for back-compat but ignored at runtime."
				/>
			</div>

			{form.mode === "interval" && (
				<div className="workspace-config-row">
					<label className="config-label">Every (minutes, min 1)</label>
					<input
						type="number"
						min={1}
						className="workspace-dir-input"
						value={form.intervalMinutes}
						onChange={(e) => setForm((f) => ({ ...f, intervalMinutes: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
					/>
				</div>
			)}

			{form.mode === "alarm" && (
				<>
					<div className="workspace-config-row">
						<label className="config-label">Time (HH:MM, local {localTz()})</label>
						<input
							type="time"
							className="workspace-dir-input"
							value={form.alarmTime}
							onChange={(e) => setForm((f) => ({ ...f, alarmTime: e.target.value }))}
						/>
					</div>
					<div className="workspace-config-row">
						<label className="config-label">Repeat on (empty = every day)</label>
						<div className="cron-weekday-row">
							{WEEKDAY_LABELS.map((lbl, i) => {
								const d = i + 1;
								const on = form.alarmDays.includes(d);
								return (
									<button
										key={d}
										type="button"
										className={`btn-ghost btn-sm ${on ? "active" : ""}`}
										onClick={() => toggleDay(d)}
									>{lbl}</button>
								);
							})}
						</div>
					</div>
				</>
			)}

			{form.mode === "once" && (
				<>
					<div className="workspace-config-row">
						<label className="config-label">Date</label>
						<input
							type="date"
							className="workspace-dir-input"
							value={form.onceDate}
							onChange={(e) => setForm((f) => ({ ...f, onceDate: e.target.value }))}
						/>
					</div>
					<div className="workspace-config-row">
						<label className="config-label">Time (HH:MM, local)</label>
						<input
							type="time"
							className="workspace-dir-input"
							value={form.onceTime}
							onChange={(e) => setForm((f) => ({ ...f, onceTime: e.target.value }))}
						/>
					</div>
				</>
			)}

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
				<button type="button" className="btn-primary btn-sm" onClick={onSave} disabled={!canSave}>
					{form.id ? "Update" : "Create"}
				</button>
				<button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
			</div>
		</div>
	);
}
