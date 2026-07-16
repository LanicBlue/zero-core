// tool-quality-pass follow-up (#1 root fix): delegator.cleanup() must delete
// the delegated_tasks DB rows for terminal tasks it ages out of the in-memory
// registry. Without this, cleanup only clears memory → DB row lingers →
// restoreDelegatedTasks re-seeds it on next loop rebuild → terminal tasks
// accumulate (the 264-row flood the user hit).
//
// Harness mirrors sub4-tool-quality-pass.test.ts: real CoreDatabase on temp file +
// real SubagentDelegator with `db` wired into config.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase } from "../../src/server/core-database.js";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import type { SessionConfig } from "../../src/runtime/types.js";

let tmpDir: string;
let sessionDB: CoreDatabase;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-task-cleanup-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
});
afterEach(() => {
	sessionDB?.close();
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function makeDelegator(db?: CoreDatabase): SubagentDelegator {
	const cfg = {
		agentId: "parent-agent",
		sessionId: "parent-session",
		workspaceDir: tmpDir,
		db: db as any,
	} as SessionConfig;
	return new SubagentDelegator({
		config: cfg,
		providers: [],
		emit: () => {},
		createSubLoop: () => ({} as any),
		getToolConfig: () => ({}),
	});
}

/** Seed a delegated_tasks row so we can assert cleanup deletes it. */
function seedRow(db: CoreDatabase, id: string): void {
	db.createDelegatedTask({
		id,
		rootTaskId: id,
		ownerAgentId: "parent-agent",
		targetAgentId: "dev",
		parentSessionId: "parent-session",
		sessionId: undefined,
		task: "do thing",
		status: "completed",
	});
	db.updateDelegatedTask(id, { completedAt: new Date(Date.now() - 7200_000).toISOString() } as any);
}

describe("[#1 root fix] delegator.cleanup() deletes DB rows for aged-out terminal tasks", () => {
	test("aged terminal task: registry memory cleared AND DB row deleted", () => {
		const delegator = makeDelegator(sessionDB);
		seedRow(sessionDB, "t-aged");
		// Mirror into the in-memory registry with an OLD completedAt (>1h).
		delegator.taskRegistry.create("t-aged", "subagent", "work");
		delegator.taskRegistry.complete("t-aged", "done");
		// Force completedAt into the past (complete() sets Date.now()).
		(delegator.taskRegistry as any).tasks.get("t-aged").completedAt = Date.now() - 7200_000;

		expect(sessionDB.getDelegatedTask("t-aged")).toBeDefined();
		delegator.cleanup(); // default maxAge 1h → t-aged (2h old) removed
		expect(delegator.taskRegistry.get("t-aged")).toBeUndefined();
		expect(sessionDB.getDelegatedTask("t-aged")).toBeUndefined();
	});

	test("recent terminal task (within maxAge): kept in registry AND DB row kept", () => {
		const delegator = makeDelegator(sessionDB);
		seedRow(sessionDB, "t-fresh");
		delegator.taskRegistry.create("t-fresh", "subagent", "work");
		delegator.taskRegistry.complete("t-fresh", "done"); // completedAt = now

		delegator.cleanup(); // default maxAge 1h → t-fresh (just now) NOT removed
		expect(delegator.taskRegistry.get("t-fresh")).toBeDefined();
		expect(sessionDB.getDelegatedTask("t-fresh")).toBeDefined();
	});

	test("running task: never removed (no completedAt)", () => {
		const delegator = makeDelegator(sessionDB);
		delegator.taskRegistry.create("t-run", "subagent", "work"); // running, no completedAt
		delegator.cleanup();
		expect(delegator.taskRegistry.get("t-run")).toBeDefined();
	});

	test("cleanup returns the removed ids (registry unit)", () => {
		const reg = new TaskRegistry();
		reg.create("t1", "bash", "a");
		reg.create("t2", "bash", "b");
		reg.complete("t1", "done");
		(reg as any).tasks.get("t1").completedAt = Date.now() - 7200_000;
		const removed = reg.cleanup();
		expect(removed).toEqual(["t1"]);
		expect(reg.get("t1")).toBeUndefined();
		expect(reg.get("t2")).toBeDefined();
	});

	test("delegator.cleanup() fault-tolerant when db undefined (test stub)", () => {
		const delegator = makeDelegator(undefined); // no db
		delegator.taskRegistry.create("t", "bash", "a");
		delegator.taskRegistry.complete("t", "done");
		(delegator.taskRegistry as any).tasks.get("t").completedAt = Date.now() - 7200_000;
		expect(() => delegator.cleanup()).not.toThrow(); // ?. short-circuits deleteDelegatedTask
		expect(delegator.taskRegistry.get("t")).toBeUndefined(); // memory still cleared
	});
});
