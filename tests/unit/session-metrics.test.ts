import { describe, test, expect } from "vitest";
import { RunningStats, SessionMetricsHolder } from "../../src/server/session-metrics.js";

describe("RunningStats", () => {
	test("empty state: count=0, mean=0, variance=0", () => {
		const s = new RunningStats();
		expect(s.getCount()).toBe(0);
		expect(s.getMean()).toBe(0);
		expect(s.getVariance()).toBe(0);
	});

	test("single value: mean=value, variance=0", () => {
		const s = new RunningStats();
		s.add(42);
		expect(s.getCount()).toBe(1);
		expect(s.getMean()).toBe(42);
		expect(s.getVariance()).toBe(0);
	});

	test("multiple values: mean is arithmetic average", () => {
		const s = new RunningStats();
		s.add(10);
		s.add(20);
		s.add(30);
		expect(s.getCount()).toBe(3);
		expect(s.getMean()).toBe(20);
	});

	test("variance uses n-1 denominator (sample variance)", () => {
		const s = new RunningStats();
		// values 2, 4, 4, 4, 5, 5, 7, 9 → mean=5, sample variance=32/7≈4.571
		for (const v of [2, 4, 4, 4, 5, 5, 7, 9]) s.add(v);
		expect(s.getMean()).toBe(5);
		expect(s.getVariance()).toBeCloseTo(32 / 7, 6);
	});

	test("handles negative values", () => {
		const s = new RunningStats();
		s.add(-5);
		s.add(5);
		expect(s.getCount()).toBe(2);
		expect(s.getMean()).toBe(0);
		expect(s.getVariance()).toBe(50); // (−5−0)² + (5−0)² = 50, / (n-1) = 50
	});

	test("with single value, variance is 0 (n-1=0)", () => {
		const s = new RunningStats();
		s.add(100);
		expect(s.getVariance()).toBe(0);
	});

	test("zero values does not affect stats", () => {
		const s = new RunningStats();
		s.add(0);
		s.add(0);
		expect(s.getCount()).toBe(2);
		expect(s.getMean()).toBe(0);
		expect(s.getVariance()).toBe(0);
	});
});

describe("SessionMetricsHolder", () => {
	test("constructor sets sessionId and agentId", () => {
		const h = new SessionMetricsHolder("sess-1", "agent-1");
		expect(h.sessionId).toBe("sess-1");
		expect(h.agentId).toBe("agent-1");
		expect(h.createdAt).toBeGreaterThan(0);
		expect(h.lifecycleState).toBe("created");
	});

	test("constructor accepts optional parentSessionId and spawnDepth", () => {
		const h = new SessionMetricsHolder("child", "agent-1", {
			parentSessionId: "parent",
			spawnDepth: 2,
		});
		expect(h.parentSessionId).toBe("parent");
		expect(h.spawnDepth).toBe(2);
	});

	test("default spawnDepth is 0", () => {
		const h = new SessionMetricsHolder("s", "a");
		expect(h.spawnDepth).toBe(0);
	});

	test("recordTokenUsage accumulates required fields", () => {
		const h = new SessionMetricsHolder("s", "a");
		h.recordTokenUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
		h.recordTokenUsage({ inputTokens: 200, outputTokens: 75, totalTokens: 275 });
		expect(h.inputTokens).toBe(300);
		expect(h.outputTokens).toBe(125);
	});

	test("recordTokenUsage accumulates optional cache/reasoning fields when present", () => {
		const h = new SessionMetricsHolder("s", "a");
		h.recordTokenUsage({
			inputTokens: 10, outputTokens: 5, totalTokens: 15,
			cacheReadTokens: 100, cacheWriteTokens: 50, reasoningTokens: 25,
		});
		expect(h.cacheReadTokens).toBe(100);
		expect(h.cacheWriteTokens).toBe(50);
		expect(h.reasoningTokens).toBe(25);
	});

	test("recordTokenUsage ignores optional fields when absent", () => {
		const h = new SessionMetricsHolder("s", "a");
		h.recordTokenUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
		expect(h.cacheReadTokens).toBe(0);
		expect(h.cacheWriteTokens).toBe(0);
		expect(h.reasoningTokens).toBe(0);
	});

	test("toSessionMetrics snapshots current state", () => {
		const h = new SessionMetricsHolder("s1", "a1");
		h.totalTurns = 5;
		h.totalUserTurns = 3;
		h.errorCount = 1;
		h.retryCount = 2;
		h.turnLatencyStats.add(100);
		h.turnLatencyStats.add(200);
		h.recordTokenUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });

		const snap = h.toSessionMetrics();
		expect(snap.sessionId).toBe("s1");
		expect(snap.agentId).toBe("a1");
		expect(snap.totalTurns).toBe(5);
		expect(snap.totalUserTurns).toBe(3);
		expect(snap.errorCount).toBe(1);
		expect(snap.retryCount).toBe(2);
		expect(snap.avgTurnLatencyMs).toBe(150);
		expect(snap.inputTokens).toBe(1000);
		expect(snap.outputTokens).toBe(500);
	});

	test("toSessionMetrics returns defensive copies of Maps", () => {
		const h = new SessionMetricsHolder("s", "a");
		h.toolCallCounts.set("Bash", 1);
		const snap1 = h.toSessionMetrics();
		snap1.toolCallCounts.set("Edit", 99);  // mutate snapshot
		// Holder should be unaffected
		expect(h.toolCallCounts.get("Edit")).toBeUndefined();
		expect(h.toolCallCounts.get("Bash")).toBe(1);
	});

	test("toSessionMetrics avgFirstTokenMs and avgToolCallDurationMs reflect stats", () => {
		const h = new SessionMetricsHolder("s", "a");
		h.firstTokenStats.add(50);
		h.firstTokenStats.add(150);
		h.toolCallDurationStats.add(1000);

		const snap = h.toSessionMetrics();
		expect(snap.avgFirstTokenMs).toBe(100);
		expect(snap.avgToolCallDurationMs).toBe(1000);
	});
});
