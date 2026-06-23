// 单测:AgentStore 变更通知(onChange)
//
// Bug:AgentRegistry 工具建/改 agent 后 UI 不刷新,要重启才出现。根因是
// mutation 后没通知 renderer。修复在 AgentStore.create/update/delete 后
// fire onChange 监听器 → 经 WS 广播 agents:changed → renderer refetch。
// 本测试锁定 create/update/delete 都会触发通知。
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";

let tmpDir: string;
let sessionDB: SessionDB;
let store: AgentStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-agent-notify-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	store = new AgentStore(sessionDB);
});

afterEach(() => {
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentStore onChange — mutation notifies listeners", () => {
	test("create fires change listeners", () => {
		const calls: number[] = [];
		const unsub = store.onChange(() => calls.push(1));
		store.create({ name: "A" } as any);
		expect(calls.length).toBe(1);
		unsub();
		store.create({ name: "B" } as any);
		expect(calls.length).toBe(1); // unsubscribed → no more
	});

	test("update fires change listeners", () => {
		const a = store.create({ name: "A" } as any);
		let calls = 0;
		store.onChange(() => calls++);
		store.update(a.id, { name: "A2" });
		expect(calls).toBe(1);
	});

	test("delete fires change listeners", () => {
		const a = store.create({ name: "A" } as any);
		let calls = 0;
		store.onChange(() => calls++);
		store.delete(a.id);
		expect(calls).toBe(1);
	});

	test("multiple listeners all fire; a throwing listener doesn't block others", () => {
		const a: number[] = [];
		const b: number[] = [];
		store.onChange(() => a.push(1));
		store.onChange(() => { throw new Error("boom"); });
		store.onChange(() => b.push(1));
		expect(() => store.create({ name: "A" } as any)).not.toThrow();
		expect(a.length).toBe(1);
		expect(b.length).toBe(1);
	});

	test("no listeners → notify is a no-op (no throw)", () => {
		expect(() => store.create({ name: "A" } as any)).not.toThrow();
	});
});
