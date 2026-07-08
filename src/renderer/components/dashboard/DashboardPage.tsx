// 仪表盘页面 —— platform-observability ③ (sub-6) 横向重设计
//
// # 文件说明书
//
// ## 核心功能
// 平台管理看板,横向布局(窗口宽>高)。四区:
//   1. 顶 KPI 条(全宽):会话数 / 运行 / 等待 / 今日 token / 错误(聚合)。
//   2. 左 agent 栏(~35%):消费 sessions:parents。每行
//      `状态点 · agentId · status · 相对时间 · turns`(不显 sessionId)。
//      点行 → 展开 sessions:detail(task tree + 最近 3 step)。
//   3. 右 今日任务(~65%):消费新 IPC crons:today。每条
//      `触发时间(today) · agent · 类型[work|cron|git-aware] · 标签 · 上次结果`。
//   4. 底 Provider(全宽):combobox 单选 provider → in-flight/queue +
//      tokens/calls/err/latency + 排队列表(provider:stats/queue)+ 堆叠
//      柱状图(provider:usage,日视图小时柱 / 过去30天视图天柱,切换)。
//
// ## 输入
// - window.api(IPC):sessionsParents / sessionsDetail / providerStats /
//   providerUsage / providerQueue / cronsToday.
// - window.api.onAgentEvent(runtime:metrics:changed 触发刷新)。
//
// ## 输出
// - 横向四区看板。
//
// ## 定位
// 渲染进程页面,被 AppLayout 使用。
//
// ## 刷新策略
// - 主数据(sessions:parents / crons:today / provider:stats)on-mount 拉 +
//   runtime:metrics:changed 事件触发拉 + 8s 轮询兜底(实时性 vs 开销折中)。
// - detail(点行展开)按需拉(pull-on-display),不参与轮询。
// - provider usage 图随选中 provider + 视图切换重拉。
//
import React, { useEffect, useState, useCallback, useMemo } from "react";
import StackedBarChart from "./StackedBarChart.js";
import type {
	PlatformSessionSummary,
	PlatformSessionDetail,
	PlatformProviderStat,
	PlatformProviderSeries,
	PlatformProviderQueueEntry,
	PlatformCronTodayItem,
	RuntimeTaskInfo,
} from "../../../shared/types.js";

const api = () => (window as any).api;

const POLL_MS = 8000;

// ─── tool-decoupling sub-6: data fetch via the unified dispatcher ──────────
//
// 6 endpoints (sessions:parents / sessions:detail / provider:stats /
// provider:usage / provider:queue / crons:today) now go through
// api().toolRun({tool, input}) → /api/tool-run → dispatchTool → the tool's
// raw execute() → JSON. The old REST/IPC handlers are gone.
//
// toolRun returns { ok, result?, error?, elapsedMs } where `result` is a
// ToolResult { ok, data?, error? }. Each helper unwraps `result.data.<field>`
// to feed the existing useState/render (rendering is unchanged). On
// {ok:false} / thrown, the helper resolves `null`/`[]` so the kanban degrades
// to an empty state instead of crashing — same posture as the old
// `.catch(() => null)` REST path.
async function runPlatform<T>(input: Record<string, unknown>, pick: (data: any) => T, fallback: T): Promise<T> {
	try {
		const r = await api().toolRun({ tool: "Platform", input });
		if (!r.ok || !r.result || !(r.result as any).ok) return fallback;
		const data = (r.result as any).data;
		return pick(data) ?? fallback;
	} catch {
		return fallback;
	}
}
async function runCronToday(): Promise<PlatformCronTodayItem[] | null> {
	try {
		const r = await api().toolRun({ tool: "Cron", input: { action: "today" } });
		if (!r.ok || !r.result || !(r.result as any).ok) return null;
		const items = (r.result as any).data?.items;
		return Array.isArray(items) ? items : null;
	} catch {
		return null;
	}
}

// ─── 相对时间(renderer 本地实现;server 的 formatRelativeTime 在 runtime 层,web tsconfig 不含) ──
function formatRelativeTime(atMs: number, nowMs: number = Date.now()): string {
	const diff = Math.max(0, nowMs - atMs);
	const sec = Math.floor(diff / 1000);
	if (sec < 60) return `last ${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `last ${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `last ${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `last ${day}d ago`;
}

function formatClock(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function statusDot(status: PlatformSessionSummary["status"]): string {
	return status === "running" ? "●" : status === "waiting" ? "◐" : "○";
}

type View = "24h" | "30d";

export default function DashboardPage() {
	// ─── 主数据 ──────────────────────────────────────────────
	const [parents, setParents] = useState<PlatformSessionSummary[] | null>(null);
	const [todayCrons, setTodayCrons] = useState<PlatformCronTodayItem[] | null>(null);
	const [providerStats, setProviderStats] = useState<PlatformProviderStat[] | null>(null);
	const [todayTokens, setTodayTokens] = useState<number>(0);
	const [error, setError] = useState<string | null>(null);

	// ─── Provider 区状态 ─────────────────────────────────────
	const [selectedProvider, setSelectedProvider] = useState<string>("");
	const [view, setView] = useState<View>("24h");
	const [usage, setUsage] = useState<PlatformProviderSeries | null>(null);
	const [queue, setQueue] = useState<PlatformProviderQueueEntry[]>([]);
	const [expandedSession, setExpandedSession] = useState<string | null>(null);
	const [detail, setDetail] = useState<PlatformSessionDetail | null>(null);

	const fetchTop = useCallback(async () => {
		try {
			// 3 main fetches go through the dispatcher (sub-6). Each helper
			// degrades to []/null on failure so one broken endpoint doesn't
			// abort the others.
			const [p, t, s] = await Promise.all([
				runPlatform<PlatformSessionSummary[]>(
					{ resource: "sessions" },
					(d) => d.rows,
					[],
				),
				runCronToday(),
				runPlatform<PlatformProviderStat[]>(
					{ resource: "providerStats" },
					(d) => d.stats,
					[],
				),
			]);
			const stats = s;
			setParents(p);
			setTodayCrons(t);
			setProviderStats(stats);
			setError(null);
			// 默认选中第一个 enabled provider(若尚未选)。
			setSelectedProvider((cur) => {
				if (cur && stats.some((x: PlatformProviderStat) => x.name === cur)) return cur;
				const first = stats.find((x: PlatformProviderStat) => x.enabled) ?? stats[0];
				return first?.name ?? "";
			});
			// 今日 token:并发拉每个 enabled provider 的近 24h 小时桶 usage,
			// 汇总本地今日日期的桶 tokens。失败按 0 计,不阻断主数据。
			const enabled = stats.filter((x: PlatformProviderStat) => x.enabled);
			try {
				const todayKey = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD(本地)
				const usages = await Promise.all(
					enabled.map((x: PlatformProviderStat) =>
						runPlatform<PlatformProviderSeries | null>(
							{ resource: "providerUsage", provider: x.name, granularity: "hour", range: "24h" },
							(d) => d as PlatformProviderSeries,
							null,
						),
					),
				);
				let sum = 0;
				for (const u of usages) {
					if (!u) continue;
					for (const m of u.series) {
						for (const pt of m.points) {
							const ptDate = new Date(pt.bucket);
							if (Number.isNaN(ptDate.getTime())) continue;
							if (ptDate.toLocaleDateString("en-CA") === todayKey) {
								sum += pt.tokens ?? 0;
							}
						}
					}
				}
				setTodayTokens(sum);
			} catch {
				setTodayTokens(0);
			}
		} catch (e) {
			setError((e as Error).message);
		}
	}, []);

	// on-mount + 事件 + 轮询兜底。
	useEffect(() => {
		void fetchTop();
		const unsub = api()?.onAgentEvent?.((e: { type?: string }) => {
			if (e?.type === "runtime:metrics:changed") void fetchTop();
		});
		const timer = setInterval(() => { void fetchTop(); }, POLL_MS);
		return () => {
			if (typeof unsub === "function") unsub();
			clearInterval(timer);
		};
	}, [fetchTop]);

	// 选中 provider 变化或视图切换 → 拉 usage + queue。
	const fetchProvider = useCallback(async () => {
		if (!selectedProvider) {
			setUsage(null);
			setQueue([]);
			return;
		}
		try {
			const granularity = view === "24h" ? "hour" : "day";
			const range = view;
			// dispatcher (sub-6): providerUsage returns the full series object
			// (matches PlatformProviderSeries); providerQueue returns the array.
			const [u, q] = await Promise.all([
				runPlatform<PlatformProviderSeries | null>(
					{ resource: "providerUsage", provider: selectedProvider, granularity, range },
					(d) => d as PlatformProviderSeries,
					null,
				),
				runPlatform<PlatformProviderQueueEntry[]>(
					{ resource: "providerQueue", provider: selectedProvider },
					(d) => d.queue,
					[],
				),
			]);
			setUsage(u);
			setQueue(q);
		} catch {
			setUsage(null);
			setQueue([]);
		}
	}, [selectedProvider, view]);

	useEffect(() => { void fetchProvider(); }, [fetchProvider]);

	// 点行展开 detail(pull-on-display)。
	const toggleSession = useCallback(async (sessionId: string) => {
		if (expandedSession === sessionId) {
			setExpandedSession(null);
			setDetail(null);
			return;
		}
		setExpandedSession(sessionId);
		setDetail(null);
		// dispatcher (sub-6): sessions Detail via Platform resource. result.data
		// is { sessionId, taskTree, recentSteps } — already the right shape.
		const d = await runPlatform<PlatformSessionDetail | null>(
			{ resource: "sessions", sessionId },
			(data) => data as PlatformSessionDetail,
			null,
		);
		setDetail(d ?? { sessionId, taskTree: [], recentSteps: [] });
	}, [expandedSession]);

	// ─── KPI 聚合 ────────────────────────────────────────────
	const kpi = useMemo(() => {
		const sessionCount = parents?.length ?? 0;
		const running = parents?.filter((p) => p.status === "running").length ?? 0;
		const waiting = parents?.filter((p) => p.status === "waiting").length ?? 0;
		// 今日 token:fetchTop 中已并发拉取 enabled provider 的 24h 小时桶
		// usage 并汇总本地今日日期桶的 tokens(见 todayTokens state)。
		const errors = providerStats?.reduce((sum, s) => sum + (s.errors ?? 0), 0) ?? 0;
		return { sessionCount, running, waiting, todayTokens, errors };
	}, [parents, providerStats, todayTokens]);

	if (error && !parents) {
		return (
			<div className="dashboard-page">
				<header className="dashboard-header">
					<h2>Dashboard</h2>
				</header>
				<div className="dashboard-error">Error loading metrics: {error}</div>
			</div>
		);
	}

	return (
		<div className="dashboard-page dash-platform">
			<header className="dashboard-header">
				<h2>Dashboard</h2>
				<p className="dashboard-subtitle">平台观测看板</p>
			</header>

			{/* ─── ① 顶 KPI 条(全宽) ─────────────────────────────── */}
			<section className="dash-kpi-bar">
				<KpiCard label="会话数" value={kpi.sessionCount} />
				<KpiCard label="运行" value={kpi.running} accent="running" />
				<KpiCard label="等待" value={kpi.waiting} accent="waiting" />
				<KpiCard label="今日 Token" value={formatTokens(kpi.todayTokens)} hint="本地今日 · 各 enabled provider 小时桶求和" />
				<KpiCard label="错误" value={kpi.errors} accent={kpi.errors > 0 ? "danger" : undefined} />
			</section>

			{/* ─── ② 主区:左 agent 栏 + 右 今日任务 ─────────────── */}
			<section className="dash-main">
				<div className="dash-col dash-col-agents">
					<h3 className="dash-col-title">Agents</h3>
					{parents === null ? (
						<div className="dashboard-loading">Loading...</div>
					) : parents.length === 0 ? (
						<div className="dashboard-empty">No parent sessions</div>
					) : (
						<div className="dash-agent-list">
							{parents.map((p) => (
								<div key={p.sessionId} className="dash-agent-row-wrap">
									<div
										className={`dash-agent-row ${expandedSession === p.sessionId ? "active" : ""}`}
										onClick={() => toggleSession(p.sessionId)}
										role="button"
										tabIndex={0}
									>
										<span className={`dash-status-dot dash-status-${p.status}`} aria-hidden>
											{statusDot(p.status)}
										</span>
										<span className="dash-agent-name">{p.agentName ?? p.agentId}</span>
										<span className={`dash-agent-status dash-agent-status-${p.status}`}>{p.status}</span>
										<span className="dash-agent-reltime">{formatRelativeTime(p.lastActivityAt)}</span>
										<span className="dash-agent-turns">{p.turns} turns</span>
									</div>
									{expandedSession === p.sessionId && (
										<div className="dash-agent-detail">
											{detail === null ? (
												<div className="dashboard-loading">Loading detail...</div>
											) : detail.taskTree.length === 0 && detail.recentSteps.length === 0 ? (
												<div className="dashboard-empty">No live task tree / recent steps</div>
											) : (
												<SessionDetail detail={detail} />
											)}
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</div>

				<div className="dash-col dash-col-today">
					<h3 className="dash-col-title">今日任务</h3>
					{todayCrons === null ? (
						<div className="dashboard-loading">Loading...</div>
					) : todayCrons.length === 0 ? (
						<div className="dashboard-empty">今日无计划触发的 cron</div>
					) : (
						<div className="dash-today-list">
							{todayCrons.map((c) => (
								<div key={c.cronId} className="dash-today-row">
									<span className="dash-today-time">
										{c.fireTime !== null ? formatClock(c.fireTime) : (c.interval ?? "—")}
									</span>
									<span className="dash-today-agent">{c.agentId}</span>
									<span className={`dash-today-type dash-today-type-${c.type}`}>
										{c.type === "work" ? "[work]" : c.type === "git-aware" ? "[git]" : "[cron]"}
									</span>
									<span className="dash-today-label" title={c.label}>{c.label}</span>
									<span className={`dash-today-last dash-today-last-${c.lastResult ?? "none"}`}>
										{c.lastResult === "ok" ? "上次 ✅"
											: c.lastResult === "failed" ? "上次 ❌"
											: c.lastResult === "missed" ? "上次 ⚠"
											: "—"}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			</section>

			{/* ─── ③ 底 Provider(全宽) ──────────────────────────── */}
			<section className="dash-provider">
				<div className="dash-provider-head">
					<h3 className="dash-col-title">Provider</h3>
					<div className="dash-provider-controls">
						<select
							className="dash-provider-combobox"
							value={selectedProvider}
							onChange={(e) => setSelectedProvider(e.target.value)}
							aria-label="选择 provider"
						>
							<option value="">(选择 provider)</option>
							{(providerStats ?? []).map((s) => (
								<option key={s.name} value={s.name} disabled={!s.enabled}>
									{s.name}{s.enabled ? "" : " (disabled)"}
								</option>
							))}
						</select>
						<div className="dash-view-toggle" role="group" aria-label="用量视图">
							<button
								className={view === "24h" ? "active" : ""}
								onClick={() => setView("24h")}
								type="button"
							>日</button>
							<button
								className={view === "30d" ? "active" : ""}
								onClick={() => setView("30d")}
								type="button"
							>30 天</button>
						</div>
					</div>
				</div>

				{selectedProvider === "" ? (
					<div className="dashboard-empty">请选择一个 provider</div>
				) : (
					<>
						<ProviderSummary stats={providerStats ?? []} name={selectedProvider} queue={queue} />
						<div className="dash-chart-block">
							<div className="dash-chart-title">
								用量堆叠柱状图{view === "24h" ? "(近 24 小时,小时柱)" : "(近 30 天,天柱)"}
							</div>
							{usage ? <StackedBarChart series={usage} /> : <div className="dashboard-loading">Loading...</div>}
						</div>
					</>
				)}
			</section>
		</div>
	);
}

// ─── 子组件 ──────────────────────────────────────────────────

function KpiCard({ label, value, hint, accent }: { label: string; value: React.ReactNode; hint?: string; accent?: "running" | "waiting" | "danger" }) {
	return (
		<div className={`dash-kpi-card ${accent ? `dash-kpi-${accent}` : ""}`}>
			<div className="dash-kpi-value">{value}</div>
			<div className="dash-kpi-label">{label}</div>
			{hint && <div className="dash-kpi-hint">{hint}</div>}
		</div>
	);
}

function ProviderSummary({ stats, name, queue }: { stats: PlatformProviderStat[]; name: string; queue: PlatformProviderQueueEntry[] }) {
	const s = stats.find((x) => x.name === name);
	if (!s) return <div className="dashboard-empty">未找到 provider: {name}</div>;
	return (
		<div className="dash-provider-summary">
			<div className="dash-provider-metrics">
				<Metric label="in-flight" value={s.inFlight} />
				<Metric label="queue" value={s.queue} accent={s.queue > 0 ? "waiting" : undefined} />
				<Metric label="max 并发" value={s.maxConcurrency} />
				<Metric label="calls" value={s.calls} />
				<Metric label="tokens" value={formatTokens(s.tokens)} />
				<Metric label="errors" value={s.errors} accent={s.errors > 0 ? "danger" : undefined} />
				<Metric label="errRate" value={`${(s.errRate * 100).toFixed(1)}%`} />
				<Metric label="latency" value={s.latencyMs === null ? "N/A" : `${Math.round(s.latencyMs)}ms`} />
			</div>
			<div className="dash-provider-queue">
				<div className="dash-queue-title">排队列表({queue.length})</div>
				{queue.length === 0 ? (
					<div className="dash-queue-empty">无排队</div>
				) : (
					<div className="dash-queue-list">
						{queue.map((q, i) => (
							<div key={i} className="dash-queue-row">
								<span className="dash-queue-tier">T{q.tier}</span>
								<span className="dash-queue-agent">{q.agentId ?? q.sessionId?.slice(0, 8) ?? "?"}</span>
								<span className="dash-queue-wait">等了 {formatRelativeTime(q.waitedSince)}</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function Metric({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "waiting" | "danger" }) {
	return (
		<div className={`dash-metric ${accent ? `dash-metric-${accent}` : ""}`}>
			<span className="dash-metric-value">{value}</span>
			<span className="dash-metric-label">{label}</span>
		</div>
	);
}

function SessionDetail({ detail }: { detail: PlatformSessionDetail }) {
	return (
		<div className="dash-session-detail">
			{detail.taskTree.length > 0 && (
				<div className="dash-detail-block">
					<div className="dash-detail-h">Task Tree</div>
					<TaskTreeNodes tasks={detail.taskTree} depth={0} />
				</div>
			)}
			{detail.recentSteps.length > 0 && (
				<div className="dash-detail-block">
					<div className="dash-detail-h">最近 3 step</div>
					{detail.recentSteps.map((st) => (
						<div key={st.stepSeq} className="dash-step">
							<span className="dash-step-seq">step {st.stepSeq}</span>
							<span className={`dash-step-status dash-step-status-${st.status}`}>[{st.status}]</span>
							<span className="dash-step-reltime">{formatRelativeTime(st.time)}</span>
							{st.toolCalls.length > 0 && (
								<span className="dash-step-calls">
									{st.toolCalls.map((tc, i) => (
										<span key={i} className="dash-step-call">
											{tc.name}{tc.argsBrief ? `(${tc.argsBrief})` : ""}
										</span>
									))}
								</span>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function TaskTreeNodes({ tasks, depth }: { tasks: RuntimeTaskInfo[]; depth: number }) {
	// 顶层 = roots(parent_task_id 为空);递归按 parentTaskId 嵌套。
	const roots = tasks.filter((t) => !t.parentTaskId || !tasks.some((x) => x.id === t.parentTaskId));
	const childOf = (id: string) => tasks.filter((t) => t.parentTaskId === id);
	const render = (t: RuntimeTaskInfo, d: number): React.ReactElement => {
		const kids = childOf(t.id);
		return (
			<div key={t.id} className="dash-tree-node" style={{ marginLeft: d * 12 }}>
				<span className={`dash-tree-status dash-tree-status-${t.status}`}>●</span>
				<span className="dash-tree-task" title={t.task}>{t.task}</span>
				<span className="dash-tree-meta">{t.targetAgentId ?? t.type} · {t.status} · step {t.step}</span>
				{kids.map((k) => render(k, d + 1))}
			</div>
		);
	};
	return <div className="dash-tree">{roots.map((r) => render(r, 0))}</div>;
}
