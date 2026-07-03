// 单元测试:AgentService.abort 的 session 隔离
//
// # 文件说明书
//
// ## 核心功能
// 锁死:abort(sessionId) 只停该 session 的 loop,绝不波及同 agent 的其他 session
// (或全部 busy session)。这是"session state 独立"的核心不变量 —— Stop 一个
// session 不能串停别的。注入 stub loop(abort 只动 this.loops)直接验证。
//
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../../src/server/agent-service.js";

describe("AgentService.abort — session-scoped (no cross-session cascade)", () => {
	let dir: string;
	let svc: AgentService;
	let loopA: { abort: ReturnType<typeof vi.fn> };
	let loopB: { abort: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "zc-abort-"));
		svc = new AgentService(dir);
		loopA = { abort: vi.fn() };
		loopB = { abort: vi.fn() };
		// abort() only touches this.loops / runStates / activeSessions.
		(svc as any).loops.set("sess-A", loopA);
		(svc as any).loops.set("sess-B", loopB);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("abort(undefined, sessionId) stops ONLY that session", async () => {
		await svc.abort(undefined, "sess-A");
		expect(loopA.abort).toHaveBeenCalledTimes(1);
		expect(loopB.abort).not.toHaveBeenCalled();
	});

	test("explicit sessionId does not cascade even when sibling sessions are busy", async () => {
		// Both sessions of the same agent busy — stopping one must leave the other.
		(svc as any).runStates.set("sess-A", { agentId: "agent-1", isBusy: true, streamingText: "", toolCalls: [] });
		(svc as any).runStates.set("sess-B", { agentId: "agent-1", isBusy: true, streamingText: "", toolCalls: [] });
		await svc.abort(undefined, "sess-B");
		expect(loopB.abort).toHaveBeenCalledTimes(1);
		expect(loopA.abort).not.toHaveBeenCalled();
	});
});
