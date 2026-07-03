// 仪表盘页面
//
// # 文件说明书
//
// ## 核心功能
// 仪表盘页面，展示会话指标和统计信息。
//
// ## 输入
// - IPC API 调用（sessionsMetrics）
//
// ## 输出
// - 会话统计卡片
// - 资源使用概览
//
// ## 定位
// 渲染进程页面，被 AppLayout 使用。
//
// ## 依赖
// - react - React 框架
// - window.api - IPC API
//
// ## 维护规则
// - 新增指标时需更新
// - 保持数据刷新逻辑正确
//
import React, { useEffect, useState, useCallback } from "react";

const api = () => (window as any).api;

interface SessionMetrics {
	sessionId: string;
	agentId: string;
	lifecycleState: string;
	lastActivityAt: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	totalTurns: number;
	errorCount: number;
}

interface ConcurrencyInfo {
	providerName: string;
	active: number;
	waiting: number;
}

interface MetricsData {
	sessions: Record<string, SessionMetrics>;
	totalSessions: number;
	activeSessions: number;
	busySessions: number;
	idleSessions: number;
	concurrencySnapshot: Record<string, { active: number; waiting: number }>;
	lastUpdatedAt: number;
}

export default function DashboardPage() {
	const [metrics, setMetrics] = useState<MetricsData | null>(null);
	const [error, setError] = useState<string | null>(null);

	const fetchMetrics = useCallback(async () => {
		try {
			const data = await api().sessionsMetrics();
			setMetrics(data);
			setError(null);
		} catch (e) {
			setError((e as Error).message);
		}
	}, []);

	// Push-driven (N2): SessionManager re-broadcasts its metrics change as an
	// agent:event of type `runtime:metrics:changed`. We pull once on mount, then
	// again whenever that ping arrives. No setInterval fallback.
	useEffect(() => {
		fetchMetrics();
		const unsub = (window as any).api?.onAgentEvent((e: { type?: string }) => {
			if (e?.type === "runtime:metrics:changed") void fetchMetrics();
		});
		return () => { if (typeof unsub === "function") unsub(); };
	}, [fetchMetrics]);

	if (error) {
		return (
			<div className="dashboard-page">
				<header className="dashboard-header">
					<h2>Dashboard</h2>
				</header>
				<div className="dashboard-error">Error loading metrics: {error}</div>
			</div>
		);
	}

	if (!metrics) {
		return (
			<div className="dashboard-page">
				<header className="dashboard-header">
					<h2>Dashboard</h2>
				</header>
				<div className="dashboard-loading">Loading...</div>
			</div>
		);
	}

	const sessions = Object.values(metrics.sessions);
	const activeSessions = sessions.filter(s => s.lifecycleState !== "disposed");

	const concurrencyList = Object.entries(metrics.concurrencySnapshot).map(([name, data]) => ({
		providerName: name,
		active: data.active,
		waiting: data.waiting,
	}));

	return (
		<div className="dashboard-page">
			<header className="dashboard-header">
				<h2>Dashboard</h2>
				<p className="dashboard-subtitle">
					{activeSessions.length} active sessions · Updated {new Date(metrics.lastUpdatedAt).toLocaleTimeString()}
				</p>
			</header>

			{/* Provider Status */}
			<section className="dashboard-section">
				<h2 className="dashboard-section-title">Provider Usage</h2>
				<div className="provider-status-list">
					{concurrencyList.length === 0 ? (
						<div className="dashboard-empty">No active providers</div>
					) : (
						concurrencyList.map(({ providerName, active, waiting }) => (
							<div key={providerName} className="provider-status-item">
								<div className="provider-status-name">{providerName}</div>
								<div className="provider-status-metrics">
									<span className="provider-status-active">{active} active</span>
									{waiting > 0 && <span className="provider-status-waiting">{waiting} waiting</span>}
								</div>
							</div>
						))
					)}
				</div>
			</section>

			{/* Active Sessions */}
			<section className="dashboard-section">
				<h2 className="dashboard-section-title">Active Sessions</h2>
				<div className="session-list">
					{activeSessions.length === 0 ? (
						<div className="dashboard-empty">No active sessions</div>
					) : (
						activeSessions.map((session) => (
							<div key={session.sessionId} className="session-list-item">
								<div className="session-info">
									<div className="session-name">{session.agentId}</div>
									<div className="session-id">{session.sessionId.slice(0, 8)}...</div>
								</div>
								<div className="session-status">
									<span className={`session-status-badge session-status-${session.lifecycleState}`}>
										{session.lifecycleState}
									</span>
								</div>
								<div className="session-metrics">
									<span className="session-metric">{session.totalTokens} tokens</span>
									<span className="session-metric">{session.totalTurns} turns</span>
								</div>
							</div>
						))
					)}
				</div>
			</section>
		</div>
	);
}
