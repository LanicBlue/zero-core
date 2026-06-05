// 会话指标收集与聚合
//
// # 文件说明书
//
// ## 核心功能
// 使用 Welford 在线算法收集和聚合会话运行指标（token 用量、延迟等）
//
// ## 输入
// 会话指标数据（token 数、耗时、工具调用次数等）
//
// ## 输出
// RunningStats 统计对象、SessionMetrics、AggregateMetrics
//
// ## 定位
// src/server/ — 服务层，为 session-manager 和 Dashboard 提供指标数据
//
// ## 依赖
// session-lifecycle.ts
//
// ## 维护规则
// 新增指标维度需同步更新 SessionMetrics 接口
//
import type { SessionLifecycleState } from "./session-lifecycle.js";

// ---------------------------------------------------------------------------
// Running statistics — Welford's online algorithm
// ---------------------------------------------------------------------------

export class RunningStats {
	private count = 0;
	private mean = 0;
	private m2 = 0;

	add(value: number): void {
		this.count++;
		const delta = value - this.mean;
		this.mean += delta / this.count;
		const delta2 = value - this.mean;
		this.m2 += delta * delta2;
	}

	getMean(): number {
		return this.count > 0 ? this.mean : 0;
	}

	getVariance(): number {
		return this.count > 1 ? this.m2 / (this.count - 1) : 0;
	}

	getCount(): number {
		return this.count;
	}
}

// ---------------------------------------------------------------------------
// Per-session metrics
// ---------------------------------------------------------------------------

export interface SessionMetrics {
	sessionId: string;
	agentId: string;
	createdAt: number;
	lastActivityAt: number;
	lifecycleState: SessionLifecycleState;

	parentSessionId?: string;
	spawnDepth: number;

	// Turn counts
	totalTurns: number;
	totalUserTurns: number;

	// Latency (running averages)
	avgTurnLatencyMs: number;
	avgFirstTokenMs: number;
	avgToolCallDurationMs: number;

	// Token usage (precise from AI SDK)
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;

	// Token estimation (fallback)
	estimatedInputTokens: number;
	estimatedOutputTokens: number;

	// Tool call tracking
	toolCallCounts: Map<string, number>;
	toolCallErrors: Map<string, number>;

	// Error tracking
	errorCount: number;
	retryCount: number;
}

// ---------------------------------------------------------------------------
// Aggregate metrics across all sessions
// ---------------------------------------------------------------------------

export interface AggregateMetrics {
	totalSessions: number;
	activeSessions: number;
	busySessions: number;
	idleSessions: number;

	totalTurns: number;
	totalErrors: number;
	totalToolCalls: number;

	globalAvgTurnLatencyMs: number;
	globalAvgToolCallDurationMs: number;

	concurrencySnapshot: Record<string, { active: number; waiting: number }>;
	lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Internal mutable metrics holder (not exported)
// ---------------------------------------------------------------------------

export class SessionMetricsHolder {
	readonly sessionId: string;
	readonly agentId: string;
	readonly createdAt: number;
	lastActivityAt: number;
	lifecycleState: SessionLifecycleState;
	parentSessionId?: string;
	spawnDepth = 0;

	totalTurns = 0;
	totalUserTurns = 0;

	readonly turnLatencyStats = new RunningStats();
	readonly firstTokenStats = new RunningStats();
	readonly toolCallDurationStats = new RunningStats();

	estimatedInputTokens = 0;
	estimatedOutputTokens = 0;

	// Precise token counts from AI SDK
	inputTokens = 0;
	outputTokens = 0;
	cacheReadTokens = 0;
	cacheWriteTokens = 0;
	reasoningTokens = 0;

	readonly toolCallCounts = new Map<string, number>();
	readonly toolCallErrors = new Map<string, number>();

	errorCount = 0;
	retryCount = 0;

	constructor(sessionId: string, agentId: string, opts?: { parentSessionId?: string; spawnDepth?: number }) {
		this.sessionId = sessionId;
		this.agentId = agentId;
		this.createdAt = Date.now();
		this.lastActivityAt = this.createdAt;
		this.lifecycleState = "created";
		if (opts?.parentSessionId) this.parentSessionId = opts.parentSessionId;
		if (opts?.spawnDepth !== undefined) this.spawnDepth = opts.spawnDepth;
	}

	recordTokenUsage(usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }): void {
		this.inputTokens += usage.inputTokens;
		this.outputTokens += usage.outputTokens;
		if (usage.cacheReadTokens) this.cacheReadTokens += usage.cacheReadTokens;
		if (usage.cacheWriteTokens) this.cacheWriteTokens += usage.cacheWriteTokens;
		if (usage.reasoningTokens) this.reasoningTokens += usage.reasoningTokens;
	}

	toSessionMetrics(): SessionMetrics {
		return {
			sessionId: this.sessionId,
			agentId: this.agentId,
			createdAt: this.createdAt,
			lastActivityAt: this.lastActivityAt,
			lifecycleState: this.lifecycleState,
			parentSessionId: this.parentSessionId,
			spawnDepth: this.spawnDepth,
			totalTurns: this.totalTurns,
			totalUserTurns: this.totalUserTurns,
			avgTurnLatencyMs: this.turnLatencyStats.getMean(),
			avgFirstTokenMs: this.firstTokenStats.getMean(),
			avgToolCallDurationMs: this.toolCallDurationStats.getMean(),
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cacheReadTokens: this.cacheReadTokens,
			cacheWriteTokens: this.cacheWriteTokens,
			reasoningTokens: this.reasoningTokens,
			estimatedInputTokens: this.estimatedInputTokens,
			estimatedOutputTokens: this.estimatedOutputTokens,
			toolCallCounts: new Map(this.toolCallCounts),
			toolCallErrors: new Map(this.toolCallErrors),
			errorCount: this.errorCount,
			retryCount: this.retryCount,
		};
	}
}
