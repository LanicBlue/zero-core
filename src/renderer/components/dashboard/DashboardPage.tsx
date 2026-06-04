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

	useEffect(() => {
		fetchMetrics();
		const interval = setInterval(fetchMetrics, 2000); // Update every 2 seconds
		return () => clearInterval(interval);
	}, [fetchMetrics]);

	if (error) {
		return (
			<div className="dashboard-page">
				<header className="dashboard-header">
					<h1>Dashboard</h1>
				</header>
				<div className="dashboard-error">Error loading metrics: {error}</div>
			</div>
		);
	}

	if (!metrics) {
		return (
			<div className="dashboard-page">
				<header className="dashboard-header">
					<h1>Dashboard</h1>
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
				<h1>Dashboard</h1>
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
