import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { CoreDatabase } from "../../src/server/core-database.js";

describe("delegated task persistence", () => {
	let tmp: string | undefined;
	let db: CoreDatabase | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	function makeDb(): CoreDatabase {
		tmp = mkdtempSync(join(tmpdir(), "zero-delegated-"));
		db = new CoreDatabase(join(tmp, "core.db"));
		return db;
	}

	test("delegated sessions are hidden from normal session lists", () => {
		const sdb = makeDb();
		const chat = sdb.createSession("agent-1", "chat");
		const delegated = sdb.createSession("agent-1", "delegated", undefined, {
			sessionKind: "delegated",
			parentSessionId: chat.id,
			parentTaskId: "task-1",
			visibility: "hidden",
		});

		expect(sdb.getSession(delegated.id)?.sessionKind).toBe("delegated");
		expect(sdb.listSessions("agent-1").map((s) => s.id)).toEqual([chat.id]);
		expect(sdb.listAllSessions().map((s) => s.id)).toEqual([chat.id]);
	});

	test("delegated task lifecycle, telemetry, and startup interruption marker", () => {
		const sdb = makeDb();
		sdb.createDelegatedTask({
			id: "task-1",
			rootTaskId: "task-1",
			ownerAgentId: "lead",
			targetAgentId: "dev",
			parentSessionId: "parent-session",
			task: "implement feature",
		});
		sdb.createDelegatedTask({
			id: "task-2",
			parentTaskId: "task-1",
			rootTaskId: "task-1",
			ownerAgentId: "dev",
			targetAgentId: "reviewer",
			task: "review feature",
			status: "finishing",
			depth: 2,
		});

		// Telemetry patches: step/currentTool and turns/tokens accumulate.
		sdb.updateDelegatedTask("task-1", { step: 3, currentTool: "Read" });
		sdb.updateDelegatedTask("task-1", { turns: 5, tokens: 1234 });
		const t1 = sdb.getDelegatedTask("task-1")!;
		expect(t1.step).toBe(3);
		expect(t1.currentTool).toBe("Read");
		expect(t1.turns).toBe(5);
		expect(t1.tokens).toBe(1234);
		expect(sdb.listDelegatedTasks({ rootTaskId: "task-1" })).toHaveLength(2);

		// Crash recovery: running + finishing → interrupted on startup.
		expect(sdb.markRunningDelegatedTasksInterrupted()).toBe(2);
		expect(sdb.getDelegatedTask("task-1")?.status).toBe("interrupted");
		expect(sdb.getDelegatedTask("task-2")?.status).toBe("interrupted");
		// Idempotent: a second sweep marks nothing new.
		expect(sdb.markRunningDelegatedTasksInterrupted()).toBe(0);
	});

	test("updateDelegatedTask status transition persists completedAt on terminal states", () => {
		const sdb = makeDb();
		sdb.createDelegatedTask({
			id: "task-x",
			rootTaskId: "task-x",
			ownerAgentId: "lead",
			targetAgentId: "dev",
			task: "do thing",
		});
		const done = sdb.updateDelegatedTask("task-x", { status: "completed", result: "ok", completedAt: "2026-07-01T00:00:00.000Z" });
		expect(done?.status).toBe("completed");
		expect(done?.result).toBe("ok");
		expect(done?.completedAt).toBe("2026-07-01T00:00:00.000Z");
	});
});
