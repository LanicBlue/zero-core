// 会话管理器
//
// # 文件说明书
//
// ## 核心功能
// 管理会话的生命周期状态转换、指标收集和超时处理
//
// ## 输入
// SessionDB、SessionLifecycleState 转换请求
//
// ## 输出
// 会话状态管理、聚合指标、超时清理
//
// ## 定位
// src/server/ — 服务层，为 AgentService 提供会话状态管理
//
// ## 依赖
// session-lifecycle.ts、session-metrics.ts、session-db.ts、core/logger.ts
//
// ## 维护规则
// 状态转换规则变更需确保 isValidTransition 同步
//
import type { SessionLifecycleState } from "./session-lifecycle.js";
import { isValidTransition } from "./session-lifecycle.js";
import type { SessionMetrics, AggregateMetrics } from "./session-metrics.js";
import { SessionMetricsHolder } from "./session-metrics.js";
import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionManagerConfig {
	idleTtlMs: number;
	cleanupIntervalMs: number;
	maxMemorySessions: number;
}

const DEFAULT_CONFIG: SessionManagerConfig = {
	idleTtlMs: 30 * 60 * 1000,     // 30 min
	cleanupIntervalMs: 60 * 1000,  // 1 min
	maxMemorySessions: 100,
};

// ---------------------------------------------------------------------------
// Minimal interface to AgentService — avoids circular import
// ---------------------------------------------------------------------------

export interface AgentServiceAccess {
	evictSessionFromMemory(sessionId: string): void;
	getActiveSessionsMap(): ReadonlyMap<string, string>;
	getConcurrencySnapshot?(): Record<string, { active: number; waiting: number }>;
}

// ---------------------------------------------------------------------------
// Active states — used for counting
// ---------------------------------------------------------------------------

const ACTIVE_STATES: ReadonlySet<SessionLifecycleState> = new Set([
	"streaming", "executing_tools", "queued",
]);

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
	private readonly sessionStates = new Map<string, SessionLifecycleState>();
	private readonly lastActivityAt = new Map<string, number>();
	private readonly metrics = new Map<string, SessionMetricsHolder>();
	private readonly config: SessionManagerConfig;
	private readonly agentService: AgentServiceAccess;
	private readonly onStateChange?: (sessionId: string, from: SessionLifecycleState, to: SessionLifecycleState) => void;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	// Per-session turn timing
	private readonly turnStartAt = new Map<string, number>();
	private readonly firstTokenRecorded = new Map<string, boolean>();

	private db: SessionDB | null = null;

	constructor(agentService: AgentServiceAccess, config?: Partial<SessionManagerConfig> & { onStateChange?: (sessionId: string, from: SessionLifecycleState, to: SessionLifecycleState) => void }) {
		this.agentService = agentService;
		this.onStateChange = config?.onStateChange;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	setSessionDb(db: SessionDB): void { this.db = db; }

	// ─── Lifecycle tracking ─────────────────────────────────────

	trackSessionCreated(sessionId: string, agentId: string, opts?: { parentSessionId?: string; spawnDepth?: number }): void {
		if (this.sessionStates.has(sessionId)) return;
		this.transition(sessionId, "created");
		this.metrics.set(sessionId, new SessionMetricsHolder(sessionId, agentId, opts));
		this.touchActivity(sessionId);
		log.debug("session-mgr", `Created: ${sessionId} (agent: ${agentId})`);
	}

	trackSessionActivated(sessionId: string): void {
		this.transition(sessionId, "idle");
		this.touchActivity(sessionId);
	}

	/** Session is waiting for provider concurrency slot */
	trackSessionQueued(sessionId: string): void {
		this.transition(sessionId, "queued");
		this.touchActivity(sessionId);
	}

	/** Session is receiving streaming API response */
	trackSessionStreaming(sessionId: string): void {
		const prev = this.sessionStates.get(sessionId);
		// First streaming in a turn — start timing
		if (prev === "queued" || prev === "idle") {
			this.turnStartAt.set(sessionId, Date.now());
			this.firstTokenRecorded.delete(sessionId);
			const m = this.metrics.get(sessionId);
			if (m) m.totalUserTurns++;
		}
		this.transition(sessionId, "streaming");
		this.touchActivity(sessionId);
	}

	/** Session is executing tool calls */
	trackSessionExecutingTools(sessionId: string): void {
		this.transition(sessionId, "executing_tools");
		this.touchActivity(sessionId);
	}

	/** Session turn completed — back to idle */
	trackSessionIdle(sessionId: string): void {
		this.transition(sessionId, "idle");
		this.touchActivity(sessionId);

		// Record turn latency
		const startedAt = this.turnStartAt.get(sessionId);
		if (startedAt) {
			const elapsed = Date.now() - startedAt;
			const m = this.metrics.get(sessionId);
			if (m) {
				m.turnLatencyStats.add(elapsed);
				m.totalTurns++;
			}
			this.turnStartAt.delete(sessionId);
		}
	}

	/** Session encountered a recoverable error — transitions to idle */
	trackSessionError(sessionId: string, errorClass: string): void {
		const m = this.metrics.get(sessionId);
		if (m) m.errorCount++;

		// Record turn latency up to error point
		const startedAt = this.turnStartAt.get(sessionId);
		if (startedAt) {
			const elapsed = Date.now() - startedAt;
			if (m) {
				m.turnLatencyStats.add(elapsed);
				m.totalTurns++;
			}
			this.turnStartAt.delete(sessionId);
		}

		// Ensure session is in idle state (recoverable error)
		const current = this.sessionStates.get(sessionId);
		if (current !== "idle" && current !== "disposed") {
			this.transition(sessionId, "idle");
		}
		this.touchActivity(sessionId);
		log.debug("session-mgr", "Error in " + sessionId + ": " + errorClass + " → idle");
	}

	trackSessionDisposed(sessionId: string): void {
		this.transition(sessionId, "disposed");
		this.touchActivity(sessionId);
		this.turnStartAt.delete(sessionId);
		this.firstTokenRecorded.delete(sessionId);
		log.debug("session-mgr", `Disposed: ${sessionId}`);
	}

	// ─── State queries ──────────────────────────────────────────

	getSessionState(sessionId: string): SessionLifecycleState | undefined {
		return this.sessionStates.get(sessionId);
	}

	isSessionActive(sessionId: string): boolean {
		const state = this.sessionStates.get(sessionId);
		return state !== undefined && state !== "disposed";
	}

	getActiveSessionCount(): number {
		let count = 0;
		for (const state of this.sessionStates.values()) {
			if (state !== "disposed") count++;
		}
		return count;
	}

	getBusySessionCount(): number {
		let count = 0;
		for (const state of this.sessionStates.values()) {
			if (ACTIVE_STATES.has(state)) count++;
		}
		return count;
	}

	// ─── Metrics recording ──────────────────────────────────────

	recordFirstTokenLatency(sessionId: string): void {
		if (this.firstTokenRecorded.get(sessionId)) return;
		this.firstTokenRecorded.set(sessionId, true);

		const startedAt = this.turnStartAt.get(sessionId);
		if (!startedAt) return;

		const elapsed = Date.now() - startedAt;
		const m = this.metrics.get(sessionId);
		if (m) m.firstTokenStats.add(elapsed);
	}

	recordToolCall(sessionId: string, toolName: string, success: boolean, durationMs: number): void {
		const m = this.metrics.get(sessionId);
		if (!m) return;

		m.toolCallDurationStats.add(durationMs);
		m.toolCallCounts.set(toolName, (m.toolCallCounts.get(toolName) ?? 0) + 1);
		if (!success) {
			m.toolCallErrors.set(toolName, (m.toolCallErrors.get(toolName) ?? 0) + 1);
		}
	}

	recordRetry(sessionId: string): void {
		const m = this.metrics.get(sessionId);
		if (m) m.retryCount++;
	}

	recordTokenEstimate(sessionId: string, input: number, output: number): void {
		const m = this.metrics.get(sessionId);
		if (!m) return;
		m.estimatedInputTokens += input;
		m.estimatedOutputTokens += output;
	}

	recordTokenUsage(sessionId: string, usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }): void {
		const m = this.metrics.get(sessionId);
		if (m) {
			m.recordTokenUsage(usage);
			// Persist to DB on every API call, not just at turn end
			if (this.db) {
				try {
					this.db.updateSessionUsage(sessionId, {
						inputTokens: m.inputTokens,
						outputTokens: m.outputTokens,
						totalTokens: m.inputTokens + m.outputTokens,
						cacheReadTokens: m.cacheReadTokens,
						cacheWriteTokens: m.cacheWriteTokens,
						reasoningTokens: m.reasoningTokens,
						estimatedCostUsd: 0,
					});
				} catch (err) { log.warn("session", "persist usage failed:", (err as Error).message); }
			}
		}
	}

	// ─── Metrics queries ────────────────────────────────────────

	getSessionMetrics(sessionId: string): SessionMetrics | undefined {
		return this.metrics.get(sessionId)?.toSessionMetrics();
	}

	getAllSessionMetrics(): Map<string, SessionMetrics> {
		const result = new Map<string, SessionMetrics>();
		for (const [id, holder] of this.metrics) {
			result.set(id, holder.toSessionMetrics());
		}
		return result;
	}

	getAggregateMetrics(): AggregateMetrics {
		let totalTurns = 0;
		let totalErrors = 0;
		let totalToolCalls = 0;
		let busySessions = 0;
		let idleSessions = 0;
		let activeSessions = 0;

		let latencySum = 0;
		let latencyCount = 0;
		let toolDurationSum = 0;
		let toolDurationCount = 0;

		for (const holder of this.metrics.values()) {
			totalTurns += holder.totalTurns;
			totalErrors += holder.errorCount;
			totalToolCalls += holder.toolCallDurationStats.getCount();

			const state = holder.lifecycleState;
			if (state !== "disposed") activeSessions++;
			if (ACTIVE_STATES.has(state)) busySessions++;
			if (state === "idle") idleSessions++;

			latencySum += holder.turnLatencyStats.getMean() * holder.turnLatencyStats.getCount();
			latencyCount += holder.turnLatencyStats.getCount();
			toolDurationSum += holder.toolCallDurationStats.getMean() * holder.toolCallDurationStats.getCount();
			toolDurationCount += holder.toolCallDurationStats.getCount();
		}

		const concurrencySnapshot = this.agentService.getConcurrencySnapshot?.() ?? {};

		return {
			totalSessions: this.metrics.size,
			activeSessions,
			busySessions,
			idleSessions,
			totalTurns,
			totalErrors,
			totalToolCalls,
			globalAvgTurnLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
			globalAvgToolCallDurationMs: toolDurationCount > 0 ? toolDurationSum / toolDurationCount : 0,
			concurrencySnapshot,
			lastUpdatedAt: Date.now(),
		};
	}

	// ─── TTL cleanup ────────────────────────────────────────────

	startTtlCleanup(): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setInterval(() => this.runCleanup(), this.config.cleanupIntervalMs);
		log.debug("session-mgr", `TTL cleanup started (interval: ${this.config.cleanupIntervalMs}ms, ttl: ${this.config.idleTtlMs}ms)`);
	}

	stopTtlCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	private runCleanup(): void {
		const now = Date.now();
		const activeSessions = this.agentService.getActiveSessionsMap();
		const activeSessionIds = new Set(activeSessions.values());

		let evicted = 0;

		for (const [sessionId, state] of this.sessionStates) {
			if (state !== "idle" && state !== "error") continue;
			if (activeSessionIds.has(sessionId)) {
				this.lastActivityAt.set(sessionId, now);
				continue;
			}

			const lastActivity = this.lastActivityAt.get(sessionId) ?? 0;
			if (now - lastActivity > this.config.idleTtlMs) {
				this.evictSession(sessionId);
				evicted++;
			}
		}

		// Trim metrics for disposed sessions older than 1 hour
		for (const [sessionId, holder] of this.metrics) {
			if (holder.lifecycleState === "disposed" && now - holder.lastActivityAt > 3600_000) {
				this.metrics.delete(sessionId);
			}
		}

		if (evicted > 0) {
			log.debug("session-mgr", `TTL cleanup: evicted ${evicted} idle session(s)`);
		}
	}

	private evictSession(sessionId: string): void {
		const state = this.sessionStates.get(sessionId);
		if (state !== "idle" && state !== "error") return;

		this.agentService.evictSessionFromMemory(sessionId);
		this.transition(sessionId, "disposed");
		this.touchActivity(sessionId);
		this.turnStartAt.delete(sessionId);
		this.firstTokenRecorded.delete(sessionId);
	}

	// ─── Lifecycle ──────────────────────────────────────────────

	dispose(): void {
		this.stopTtlCleanup();
		this.sessionStates.clear();
		this.lastActivityAt.clear();
		this.metrics.clear();
		this.turnStartAt.clear();
		this.firstTokenRecorded.clear();
	}

	// ─── Internal ───────────────────────────────────────────────

	private transition(sessionId: string, to: SessionLifecycleState): void {
		const from = this.sessionStates.get(sessionId);
		if (from === to) return;
		if (from !== undefined && !isValidTransition(from, to)) {
			log.warn("session-mgr", `Invalid transition: ${from} → ${to} for ${sessionId}`);
			return;
		}
		this.sessionStates.set(sessionId, to);
		const m = this.metrics.get(sessionId);
		if (m) m.lifecycleState = to;
		this.onStateChange?.(sessionId, from ?? "created", to);
	}

	private touchActivity(sessionId: string): void {
		const now = Date.now();
		this.lastActivityAt.set(sessionId, now);
		const m = this.metrics.get(sessionId);
		if (m) m.lastActivityAt = now;
	}
}
