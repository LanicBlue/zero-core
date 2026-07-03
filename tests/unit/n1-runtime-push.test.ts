// N1 (runtime-push-ui-sync) 单元测试 — 统一状态流基建
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-N1.md 第 1-7 条:
//   1. 桥转发:emitDataChange → hub flush → 携带 changes(非 undefined)。
//   2. TaskRegistry coalesce:create/complete/acknowledge 触发回调;同 tick
//      连续 updateProgress N 次只触发 1 次。
//   3. TaskRegistry 不感知 sessionId:回调无 sessionId 入参(AgentLoop 转译)。
//   4. SessionDB emit:createSession/deleteSession/archiveSession 触发对应 op;
//      updateSessionUsage(高频 UPDATE)不触发。
//   5. InputQueueStore 适配:enqueue → emitDataChange("runtime:input-queue", ...)。
//   6. MCPManager / SessionManager.metrics / ConfirmRegistry emit:各自变更点
//      触发对应 subscribe 回调。
//   7. 白名单:新 collection 生效;非白名单不发。
//
// ## 输入
// 直接构造各 store / manager(纯单元,SessionDB 走临时目录)。
//
// ## 输出
// Vitest 用例。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emitDataChange,
	onDataChange,
	_resetDataChangeHubForTest,
} from "../../src/server/data-change-hub.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import { SessionDB } from "../../src/server/session-db.js";
import { InputQueueStore } from "../../src/server/input-queue-store.js";
import { MCPManager } from "../../src/server/mcp-manager.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { SessionManager } from "../../src/server/session-manager.js";
import { ConfirmRegistry } from "../../src/server/orchestrate-store.js";

// ConfirmRegistry is a process-wide singleton — reset between tests so the
// subscribe-count and pending-set don't leak across cases. There is no public
// reset, so we reach for the private instance slot.
function resetConfirmRegistrySingleton(): void {
	(ConfirmRegistry as any).instance = null;
}

// Coalesce drains: the hub / TaskRegistry / SessionManager all use setTimeout(0).
function flushMicrotask(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

// ─── 1. 桥转发(hub flush 携带 changes)──────────────────────────────

describe("N1 · bridge forward (hub carries changes)", () => {
	beforeEach(() => _resetDataChangeHubForTest());

	test("flush delivers {collection, changes:[{id,op,record?}]} (changes non-undefined)", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const rec = { id: "a1", name: "zero" };
		emitDataChange("agents", "a1", "create", rec);
		await flushMicrotask();

		expect(cb).toHaveBeenCalledTimes(1);
		const evt = cb.mock.calls[0][0];
		expect(evt.collection).toBe("agents");
		expect(evt.changes).toEqual([{ id: "a1", op: "create", record: rec }]);
		// Explicit guard against the original bug (changes dropped to undefined).
		expect(evt.changes).not.toBeUndefined();
	});
});

// ─── 2 & 3. TaskRegistry coalesce + sessionId-agnostic ────────────────

describe("N1 · TaskRegistry coalesced change ping", () => {
	test("create / complete / acknowledge each fire the subscriber", () => {
		const reg = new TaskRegistry();
		const cb = vi.fn();
		reg.subscribe(cb);

		reg.create("t1", "bash", "work");
		reg._flushChangeForTest();
		expect(cb).toHaveBeenCalledTimes(1);

		reg.complete("t1", "done");
		reg._flushChangeForTest();
		expect(cb).toHaveBeenCalledTimes(2);

		reg.acknowledge("t1");
		reg._flushChangeForTest();
		expect(cb).toHaveBeenCalledTimes(3);
	});

	test("coalesce: N updateProgress in one tick → exactly one flush", () => {
		const reg = new TaskRegistry();
		const cb = vi.fn();
		reg.subscribe(cb);

		reg.create("t1", "subagent", "task");
		reg._flushChangeForTest();
		expect(cb).toHaveBeenCalledTimes(1);

		// Burst of progress updates without draining — all coalesce into one.
		for (let i = 0; i < 10; i++) reg.updateProgress("t1", i);
		reg._flushChangeForTest();
		expect(cb).toHaveBeenCalledTimes(2);
	});

	test("addUsage also schedules a change ping", () => {
		const reg = new TaskRegistry();
		const cb = vi.fn();
		reg.subscribe(cb);

		reg.create("t1", "subagent", "task");
		reg._flushChangeForTest();
		reg.addUsage("t1", 100, true);
		reg._flushChangeForTest();
		expect(cb).toHaveBeenCalledTimes(2);
	});

	test("subscribe callback receives NO sessionId (registry is session-agnostic)", () => {
		const reg = new TaskRegistry();
		let receivedArgs: unknown[] = [];
		reg.subscribe((...args: unknown[]) => { receivedArgs = args; });

		reg.create("t1", "bash", "work");
		reg._flushChangeForTest();

		// The callback is invoked with zero arguments — the AgentLoop layer is
		// responsible for stamping sessionId when it translates to agent:event.
		expect(receivedArgs).toEqual([]);
	});

	test("unsubscribe stops delivery", () => {
		const reg = new TaskRegistry();
		const cb = vi.fn();
		const unsub = reg.subscribe(cb);

		unsub();
		reg.create("t1", "bash", "work");
		reg._flushChangeForTest();
		expect(cb).not.toHaveBeenCalled();
	});
});

// ─── 4. SessionDB structural emit (create/delete/archive; high-freq UPDATE silent) ──

describe("N1 · SessionDB structural emit", () => {
	let tmpDir: string;
	let db: SessionDB;

	beforeEach(async () => {
		_resetDataChangeHubForTest();
		tmpDir = mkdtempSync(join(tmpdir(), "n1-session-"));
		db = new SessionDB(join(tmpDir, "sessions.db"));
		// runMigrations adds the token-counter columns updateSessionUsage
		// references (input_tokens / output_tokens / total_tokens / ...).
		const { runMigrations } = await import("../../src/server/db-migration.js");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("createSession emits create with the record", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const rec = db.createSession("agent-1", "hello");
		await flushMicrotask();

		expect(cb).toHaveBeenCalledTimes(1);
		const evt = cb.mock.calls[0][0];
		expect(evt.collection).toBe("sessions");
		expect(evt.changes).toEqual([{ id: rec.id, op: "create", record: rec }]);
	});

	test("deleteSession emits delete (no record)", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const rec = db.createSession("agent-1", "hello");
		await flushMicrotask();
		cb.mockClear();

		db.deleteSession(rec.id);
		await flushMicrotask();

		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb.mock.calls[0][0].changes).toEqual([{ id: rec.id, op: "delete" }]);
	});

	test("archiveSession emits update with archived=true", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const rec = db.createSession("agent-1", "hello");
		await flushMicrotask();
		cb.mockClear();

		db.archiveSession(rec.id);
		await flushMicrotask();

		expect(cb).toHaveBeenCalledTimes(1);
		const evt = cb.mock.calls[0][0];
		expect(evt.collection).toBe("sessions");
		expect(evt.changes).toEqual([{ id: rec.id, op: "update", record: { id: rec.id, archived: true } }]);
	});

	test("high-frequency UPDATE (updateSessionUsage) does NOT emit", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const rec = db.createSession("agent-1", "hello");
		await flushMicrotask();
		cb.mockClear();

		// Token-counter UPDATE — must stay silent (would flood the channel).
		db.updateSessionUsage(rec.id, {
			inputTokens: 10, outputTokens: 5, totalTokens: 15,
			cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
			estimatedCostUsd: 0,
		});
		await flushMicrotask();

		expect(cb).not.toHaveBeenCalled();
	});

	test("setMainSession (high-freq) does NOT emit", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		db.createSession("agent-1", "a");
		db.createSession("agent-1", "b");
		await flushMicrotask();
		cb.mockClear();

		// setMainSession flips is_main — a routing flag, not a structural change.
		// It must stay silent to avoid flooding on every session switch.
		const sessions = db.listSessions("agent-1");
		db.setMainSession("agent-1", sessions[0].id);
		await flushMicrotask();

		expect(cb).not.toHaveBeenCalled();
	});
});

// ─── 5. InputQueueStore adaptation ────────────────────────────────────

describe("N1 · InputQueueStore → emitDataChange(runtime:input-queue)", () => {
	beforeEach(() => _resetDataChangeHubForTest());

	test("enqueue feeds the hub with the session-scoped snapshot", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const store = new InputQueueStore();
		store.enqueue("sess-1", "hello", "queued");
		await flushMicrotask();

		expect(cb).toHaveBeenCalledTimes(1);
		const evt = cb.mock.calls[0][0];
		expect(evt.collection).toBe("runtime:input-queue");
		expect(evt.changes.length).toBe(1);
		expect(evt.changes[0].id).toBe("sess-1");
		expect(evt.changes[0].op).toBe("update");
		// record is the {sessionId, items} snapshot.
		const record = evt.changes[0].record as { sessionId: string; items: { content: string; mode: string }[] };
		expect(record.sessionId).toBe("sess-1");
		expect(record.items.length).toBe(1);
		expect(record.items[0].content).toBe("hello");
		expect(record.items[0].mode).toBe("queued");
	});

	test("remove / promote also feed the hub", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const store = new InputQueueStore();
		const item = store.enqueue("sess-1", "hello", "queued");
		await flushMicrotask();
		cb.mockClear();

		store.promoteInsertNow(item.id);
		await flushMicrotask();
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb.mock.calls[0][0].collection).toBe("runtime:input-queue");
	});
});

// ─── 6. MCPManager / SessionManager.metrics / ConfirmRegistry emit ────

describe("N1 · MCPManager subscribe/emit", () => {
	test("connect failure (bad stdio command) pings subscribers", async () => {
		const mgr = new MCPManager(new ToolRegistry());
		const cb = vi.fn();
		mgr.subscribe(cb);

		// A stdio command that cannot spawn throws inside client.connect → the
		// catch branch pings subscribers (state changed: nothing got connected).
		const res = await mgr.connect({
			id: "x", name: "x", transport: "stdio", enabled: true,
			command: "__definitely_not_a_real_binary__", args: [],
		} as any);
		expect(res.error).toBeTruthy();
		expect(cb).toHaveBeenCalled();
	});
});

describe("N1 · SessionManager.subscribeMetrics (coalesced)", () => {
	test("recordToolCall / recordRetry / recordTokenUsage each schedule a ping", () => {
		const sm = new SessionManager({ evictSessionFromMemory: () => {}, getActiveSessionsMap: () => new Map() });
		const cb = vi.fn();
		sm.subscribeMetrics(cb);

		// trackSessionCreated seeds the metrics holder so the recorders resolve.
		sm.trackSessionCreated("s1", "agent-1");

		sm.recordToolCall("s1", "Shell", true, 10);
		sm._flushMetricsForTest();
		expect(cb).toHaveBeenCalledTimes(1);

		sm.recordRetry("s1");
		sm._flushMetricsForTest();
		expect(cb).toHaveBeenCalledTimes(2);

		sm.recordTokenUsage("s1", { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
		sm._flushMetricsForTest();
		expect(cb).toHaveBeenCalledTimes(3);
	});

	test("coalesce: N recordTokenEstimate in one tick → one ping", () => {
		const sm = new SessionManager({ evictSessionFromMemory: () => {}, getActiveSessionsMap: () => new Map() });
		const cb = vi.fn();
		sm.subscribeMetrics(cb);

		sm.trackSessionCreated("s1", "agent-1");
		for (let i = 0; i < 10; i++) sm.recordTokenEstimate("s1", 1, 1);
		sm._flushMetricsForTest();
		expect(cb).toHaveBeenCalledTimes(1);
	});
});

describe("N1 · ConfirmRegistry subscribe/emit", () => {
	beforeEach(() => resetConfirmRegistrySingleton());

	test("register / confirm / drop each ping subscribers", () => {
		const reg = ConfirmRegistry.getInstance();
		const cb = vi.fn();
		reg.subscribe(cb);

		reg.register("plan-1");
		expect(cb).toHaveBeenCalledTimes(1);

		reg.confirm("plan-1");
		expect(cb).toHaveBeenCalledTimes(2);
	});

	test("reject pings subscribers", () => {
		const reg = ConfirmRegistry.getInstance();
		const cb = vi.fn();
		reg.subscribe(cb);

		reg.register("plan-1");
		reg.reject("plan-1");
		expect(cb).toHaveBeenCalledTimes(2);
	});

	test("drop pings subscribers", () => {
		const reg = ConfirmRegistry.getInstance();
		const cb = vi.fn();
		reg.subscribe(cb);

		// Swallow the rejection so the drop path doesn't surface as an
		// unhandled rejection in the test runner (no real awaiter here).
		reg.register("plan-1").catch(() => {});
		reg.drop("plan-1");
		expect(cb).toHaveBeenCalledTimes(2);
	});

	test("duplicate register (existing plan) does NOT re-ping", () => {
		const reg = ConfirmRegistry.getInstance();
		const cb = vi.fn();
		reg.subscribe(cb);

		reg.register("plan-1");
		// Re-registering an already-pending plan reuses the promise and must
		// not fire a second ping (no observable change).
		reg.register("plan-1");
		expect(cb).toHaveBeenCalledTimes(1);
	});

	test("unsubscribe stops delivery", () => {
		const reg = ConfirmRegistry.getInstance();
		const cb = vi.fn();
		const unsub = reg.subscribe(cb);

		unsub();
		reg.register("plan-1");
		expect(cb).not.toHaveBeenCalled();
	});
});

// ─── 7. Whitelist ─────────────────────────────────────────────────────

describe("N1 · UI_COLLECTIONS whitelist", () => {
	beforeEach(() => _resetDataChangeHubForTest());

	test("newly added collections emit", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("sessions", "s1", "create");
		emitDataChange("orchestrate_plans", "p1", "create");
		emitDataChange("task_steps", "ts1", "create");
		emitDataChange("requirement_messages", "rm1", "create");
		emitDataChange("runtime:mcp", "status", "update");
		emitDataChange("runtime:metrics", "aggregate", "update");
		emitDataChange("runtime:input-queue", "sess-1", "update");
		emitDataChange("runtime:orchestrate", "plan-1", "update");
		await flushMicrotask();

		const collections = cb.mock.calls.map((c) => c[0].collection).sort();
		expect(collections).toEqual([
			"orchestrate_plans",
			"requirement_messages",
			"runtime:input-queue",
			"runtime:mcp",
			"runtime:metrics",
			"runtime:orchestrate",
			"sessions",
			"task_steps",
		]);
	});

	test("runtime:tasks is NOT whitelisted (routes via agent:event, not hub)", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("runtime:tasks", "any", "update");
		await flushMicrotask();

		expect(cb).not.toHaveBeenCalled();
	});

	test("non-whitelisted tables still silent", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("messages", "m1", "create");
		emitDataChange("turns", "t1", "create");
		emitDataChange("nonexistent_table", "x1", "create");
		await flushMicrotask();

		expect(cb).not.toHaveBeenCalled();
	});
});
