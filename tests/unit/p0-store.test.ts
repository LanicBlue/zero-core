// P0 单元测试:store CRUD round-trip(acceptance-P0.md「store CRUD 测试」节)
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P0 落地的 store 层 round-trip:
//   - AgentStore: subagents / wikiAnchors JSON 单列 round-trip
//   - CronStore: 三模式 schedule (once/alarm/interval) + 5 个新列 round-trip
//   - WikiNodeStore (WikiStore): links JSON round-trip + NULL → [] 兜底
//   - CronRunStore: 基本 CRUD + listByCron
//   - ToolConfigStore: upsert / get / list / delete
//   - ToolUsageStore: record / get / listByTool / listBySession
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + runMigrations。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/agent-store.ts
//   - src/server/cron-store.ts (CronStore + CronRunStore)
//   - src/server/wiki-node-store.ts (WikiStore)
//   - src/server/tool-usage-store.ts (ToolConfigStore + ToolUsageStore)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { CronStore, CronRunStore } from "../../src/server/cron-store.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { ToolConfigStore, ToolUsageStore } from "../../src/server/tool-usage-store.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import type { CronSchedule } from "../../src/shared/types.js";

let tmpDir: string;
let sessionDB: SessionDB;
let agentStore: AgentStore;
let cronStore: CronStore;
let cronRunStore: CronRunStore;
let wikiStore: WikiStore;
let toolConfigStore: ToolConfigStore;
let toolUsageStore: ToolUsageStore;
let projectStore: ProjectStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p0-store-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	agentStore = new AgentStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	cronRunStore = new CronRunStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
	toolConfigStore = new ToolConfigStore(sessionDB);
	toolUsageStore = new ToolUsageStore(sessionDB);
	projectStore = new ProjectStore(sessionDB);
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── AgentStore: subagents / wikiAnchors round-trip ──────────

describe("AgentStore subagents / wikiAnchors round-trip (P0 §2.2)", () => {
	test("subagents array persists and round-trips through JSON column", () => {
		const agent = agentStore.create({
			name: "Lead",
			subagents: [
				{ agentId: "child-1", name: "Dev", description: "writes code" },
				{ agentId: "child-2" },
			],
		} as any);

		const fetched = agentStore.get(agent.id)!;
		expect(fetched.subagents).toEqual([
			{ agentId: "child-1", name: "Dev", description: "writes code" },
			{ agentId: "child-2" },
		]);
	});

	test("wikiAnchors array persists and round-trips through JSON column", () => {
		const agent = agentStore.create({
			name: "PM",
			wikiAnchors: [
				{ nodeId: "wiki-root:proj-1", inject: "system" },
				{ nodeId: "header:src/a.ts", inject: "context", depth: 2 },
				{ nodeId: "intent:docs/r1", inject: "off" },
			],
		} as any);

		const fetched = agentStore.get(agent.id)!;
		expect(fetched.wikiAnchors).toEqual([
			{ nodeId: "wiki-root:proj-1", inject: "system" },
			{ nodeId: "header:src/a.ts", inject: "context", depth: 2 },
			{ nodeId: "intent:docs/r1", inject: "off" },
		]);
	});

	test("update merges subagents / wikiAnchors", () => {
		const agent = agentStore.create({ name: "A", subagents: [{ agentId: "c1" }] } as any);
		const updated = agentStore.update(agent.id, {
			wikiAnchors: [{ nodeId: "n1", inject: "system" }],
		} as any);
		expect(updated.subagents).toEqual([{ agentId: "c1" }]);
		expect(updated.wikiAnchors).toEqual([{ nodeId: "n1", inject: "system" }]);
	});

	test("missing subagents / wikiAnchors read back as null/undefined (no crash)", () => {
		// SqliteStore returns null when the JSON column is empty; both null
		// and undefined are acceptable — the contract is "doesn't crash and
		// isn't a corrupt string".
		const agent = agentStore.create({ name: "Bare" } as any);
		const fetched = agentStore.get(agent.id)!;
		expect(fetched.subagents == null).toBe(true);
		expect(fetched.wikiAnchors == null).toBe(true);
	});

	test("roleTag is NOT round-tripped (type removed, physical column retained)", () => {
		// Pass roleTag via cast — store must drop it (it's not in AGENT_COLUMNS).
		const agent = agentStore.create({ name: "X", roleTag: "pm" } as any);
		const fetched = agentStore.get(agent.id)!;
		expect((fetched as any).roleTag).toBeUndefined();
	});
});

// ─── CronStore: three-mode schedule + new telemetry columns ──

describe("CronStore three-mode schedule + new columns (P0 §3.4)", () => {
	function scope(workspaceDir: string, wiki = "wiki-root:global") {
		return { workspaceDir, wikiRootNodeId: wiki };
	}

	test("interval schedule round-trips + triggerMode mirrors mode", () => {
		const cron = cronStore.create({
			agentId: "a1",
			workingScope: scope("/w"),
			schedule: { mode: "interval", everyMs: 5 * 60_000 },
			enabled: true,
		});
		const fetched = cronStore.get(cron.id)!;
		expect(fetched.schedule).toEqual({ mode: "interval", everyMs: 5 * 60_000 });
		expect(fetched.triggerMode).toBe("interval");
	});

	test("alarm schedule round-trips + triggerMode mirrors mode", () => {
		const alarm: CronSchedule = { mode: "alarm", time: "09:30", days: [1, 3, 5], tz: "Asia/Shanghai" };
		const cron = cronStore.create({
			agentId: "a1",
			workingScope: scope("/w"),
			schedule: alarm,
			enabled: true,
		});
		const fetched = cronStore.get(cron.id)!;
		expect(fetched.schedule).toEqual(alarm);
		expect(fetched.triggerMode).toBe("alarm");
	});

	test("once schedule round-trips + triggerMode mirrors mode", () => {
		const once: CronSchedule = { mode: "once", at: "2026-07-01T00:00:00Z" };
		const cron = cronStore.create({
			agentId: "a1",
			workingScope: scope("/w"),
			schedule: once,
			enabled: true,
		});
		const fetched = cronStore.get(cron.id)!;
		expect(fetched.schedule).toEqual(once);
		expect(fetched.triggerMode).toBe("once");
	});

	test("new telemetry columns persist + round-trip", () => {
		const cron = cronStore.create({
			agentId: "a1",
			workingScope: scope("/w"),
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		});
		const updated = cronStore.update(cron.id, {
			lastRunAt: "2026-06-17T10:00:00Z",
			lastStatus: "ok",
			lastError: undefined,
			nextRunAt: "2026-06-17T10:01:00Z",
		});
		expect(updated.lastRunAt).toBe("2026-06-17T10:00:00Z");
		expect(updated.lastStatus).toBe("ok");
		expect(updated.nextRunAt).toBe("2026-06-17T10:01:00Z");

		const fetched = cronStore.get(cron.id)!;
		expect(fetched.lastRunAt).toBe("2026-06-17T10:00:00Z");
		expect(fetched.lastStatus).toBe("ok");
		expect(fetched.nextRunAt).toBe("2026-06-17T10:01:00Z");
	});

	test("failed status + lastError round-trip", () => {
		const cron = cronStore.create({
			agentId: "a1",
			workingScope: scope("/w"),
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		});
		cronStore.update(cron.id, { lastStatus: "failed", lastError: "boom" });
		const fetched = cronStore.get(cron.id)!;
		expect(fetched.lastStatus).toBe("failed");
		expect(fetched.lastError).toBe("boom");
	});

	test("update with new schedule updates triggerMode in sync", () => {
		const cron = cronStore.create({
			agentId: "a1",
			workingScope: scope("/w"),
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		});
		expect(cron.triggerMode).toBe("interval");
		const updated = cronStore.update(cron.id, {
			schedule: { mode: "alarm", time: "08:00", days: [], tz: "UTC" },
		});
		expect(updated.triggerMode).toBe("alarm");
	});

	test("create rejects workingScope missing wikiRootNodeId", () => {
		expect(() => cronStore.create({
			agentId: "a1",
			workingScope: { workspaceDir: "/w" } as any,
			schedule: { mode: "interval", everyMs: 60_000 },
			enabled: true,
		})).toThrow(/workspaceDir and wikiRootNodeId/);
	});
});

// ─── WikiStore: links round-trip + NULL → [] ─────────────────

describe("WikiStore links round-trip (P0 §3.3)", () => {
	test("links array round-trips through JSON column", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		wikiStore.ensureProjectSubtree(proj.id, "P");
		const subtreeRoot = wikiStore.listByProject(proj.id)[0];

		const header = wikiStore.create({
			parentId: subtreeRoot.id,
			type: "header",
			path: "header:src/a.ts",
			title: "a.ts",
			links: ["wiki-root:proj-X", "intent:docs/r1"],
			projectId: proj.id,
		} as any);

		const fetched = wikiStore.get(header.id)!;
		expect(fetched.links).toEqual(["wiki-root:proj-X", "intent:docs/r1"]);
	});

	test("NULL / empty links coalesce to [] on read (no crash)", () => {
		const proj = projectStore.create({ name: "P2", workspaceDir: join(tmpDir, "ws2") });
		wikiStore.ensureProjectSubtree(proj.id, "P2");
		const subtreeRoot = wikiStore.listByProject(proj.id)[0];

		const header = wikiStore.create({
			parentId: subtreeRoot.id,
			type: "header",
			path: "header:src/b.ts",
			title: "b.ts",
			// links omitted
			projectId: proj.id,
		} as any);

		const fetched = wikiStore.get(header.id)!;
		expect(Array.isArray(fetched.links)).toBe(true);
		expect(fetched.links).toEqual([]);
	});

	test("update writes links", () => {
		const proj = projectStore.create({ name: "P3", workspaceDir: join(tmpDir, "ws3") });
		wikiStore.ensureProjectSubtree(proj.id, "P3");
		const subtreeRoot = wikiStore.listByProject(proj.id)[0];

		const header = wikiStore.create({
			parentId: subtreeRoot.id,
			type: "header",
			path: "header:src/c.ts",
			title: "c.ts",
			projectId: proj.id,
		} as any);
		wikiStore.update(header.id, { links: ["n1", "n2"] } as any);
		const fetched = wikiStore.get(header.id)!;
		expect(fetched.links).toEqual(["n1", "n2"]);
	});
});

// ─── CronRunStore CRUD ───────────────────────────────────────

describe("CronRunStore CRUD (P0 §3.4 / §9.3)", () => {
	test("create + get round-trips a run record", () => {
		const run = cronRunStore.create({
			cronId: "cron-1",
			firedAt: "2026-06-17T10:00:00Z",
			agentId: "agent-1",
			sessionId: "sess-1",
			success: true,
			durationMs: 1500,
			tokens: 1234,
			cost: 0.012,
		});
		expect(run.id).toBeTruthy();
		const fetched = cronRunStore.get(run.id)!;
		expect(fetched.cronId).toBe("cron-1");
		expect(fetched.success).toBe(true);
		expect(fetched.tokens).toBe(1234);
		expect(fetched.cost).toBe(0.012);
	});

	test("failed run with error round-trips", () => {
		const run = cronRunStore.create({
			cronId: "cron-1",
			firedAt: "2026-06-17T11:00:00Z",
			success: false,
			error: "agent crashed",
			durationMs: 200,
		});
		const fetched = cronRunStore.get(run.id)!;
		expect(fetched.success).toBe(false);
		expect(fetched.error).toBe("agent crashed");
	});

	test("listByCron filters by cronId, newest-first", () => {
		cronRunStore.create({ cronId: "c-A", firedAt: "2026-06-17T10:00:00Z", success: true });
		cronRunStore.create({ cronId: "c-A", firedAt: "2026-06-17T12:00:00Z", success: true });
		cronRunStore.create({ cronId: "c-A", firedAt: "2026-06-17T11:00:00Z", success: true });
		cronRunStore.create({ cronId: "c-B", firedAt: "2026-06-17T10:00:00Z", success: true });

		const list = cronRunStore.listByCron("c-A");
		expect(list.length).toBe(3);
		expect(list.map((r) => r.firedAt)).toEqual([
			"2026-06-17T12:00:00Z",
			"2026-06-17T11:00:00Z",
			"2026-06-17T10:00:00Z",
		]);
	});

	test("deleteByCron removes all runs for a cron", () => {
		cronRunStore.create({ cronId: "c-X", firedAt: "t1", success: true });
		cronRunStore.create({ cronId: "c-X", firedAt: "t2", success: true });
		cronRunStore.create({ cronId: "c-Y", firedAt: "t3", success: true });
		cronRunStore.deleteByCron("c-X");
		expect(cronRunStore.listByCron("c-X")).toEqual([]);
		expect(cronRunStore.listByCron("c-Y").length).toBe(1);
	});
});

// ─── ToolConfigStore CRUD ────────────────────────────────────

describe("ToolConfigStore CRUD (P0 §7.7)", () => {
	test("upsert + get round-trips config blob", () => {
		const rec = toolConfigStore.upsert("Shell", { timeout: 30, shell: "bash" });
		expect(rec.toolName).toBe("Shell");
		expect(rec.config).toEqual({ timeout: 30, shell: "bash" });
		expect(rec.updatedAt).toBeTruthy();

		const fetched = toolConfigStore.get("Shell")!;
		expect(fetched.config).toEqual({ timeout: 30, shell: "bash" });
	});

	test("upsert is idempotent — same tool_name overwrites", () => {
		toolConfigStore.upsert("Read", { maxBytes: 1000 });
		const v2 = toolConfigStore.upsert("Read", { maxBytes: 2000 });
		expect(v2.config).toEqual({ maxBytes: 2000 });
		expect(toolConfigStore.list().length).toBe(1);
	});

	test("list returns all configs alphabetical by tool_name", () => {
		toolConfigStore.upsert("Zeta", {});
		toolConfigStore.upsert("Alpha", { x: 1 });
		toolConfigStore.upsert("Mid", null as any);
		const list = toolConfigStore.list();
		expect(list.map((r) => r.toolName)).toEqual(["Alpha", "Mid", "Zeta"]);
	});

	test("get on missing tool returns undefined", () => {
		expect(toolConfigStore.get("Nope")).toBeUndefined();
	});

	test("delete removes the row", () => {
		toolConfigStore.upsert("Temp", { a: 1 });
		toolConfigStore.delete("Temp");
		expect(toolConfigStore.get("Temp")).toBeUndefined();
	});
});

// ─── ToolUsageStore CRUD ─────────────────────────────────────

describe("ToolUsageStore CRUD (P0 §7.7)", () => {
	test("record + get round-trips a call", () => {
		const rec = toolUsageStore.record({
			toolName: "Shell",
			agentId: "agent-1",
			sessionId: "sess-1",
			calledAt: "2026-06-17T10:00:00Z",
			params: { cmd: "ls" },
			success: true,
			durationMs: 42,
		});
		expect(rec.id).toBeTruthy();
		const fetched = toolUsageStore.get(rec.id)!;
		expect(fetched.toolName).toBe("Shell");
		expect(fetched.success).toBe(true);
		expect(fetched.params).toEqual({ cmd: "ls" });
		expect(fetched.durationMs).toBe(42);
	});

	test("failed call with no agent/session round-trips", () => {
		const rec = toolUsageStore.record({
			toolName: "Read",
			calledAt: "2026-06-17T10:00:00Z",
			success: false,
		});
		const fetched = toolUsageStore.get(rec.id)!;
		expect(fetched.agentId).toBeUndefined();
		expect(fetched.sessionId).toBeUndefined();
		expect(fetched.success).toBe(false);
	});

	test("listByTool filters + newest-first", () => {
		toolUsageStore.record({ toolName: "Shell", calledAt: "2026-06-17T10:00:00Z", success: true });
		toolUsageStore.record({ toolName: "Shell", calledAt: "2026-06-17T12:00:00Z", success: true });
		toolUsageStore.record({ toolName: "Shell", calledAt: "2026-06-17T11:00:00Z", success: true });
		toolUsageStore.record({ toolName: "Read", calledAt: "2026-06-17T10:00:00Z", success: true });

		const list = toolUsageStore.listByTool("Shell");
		expect(list.length).toBe(3);
		expect(list.map((r) => r.calledAt)).toEqual([
			"2026-06-17T12:00:00Z",
			"2026-06-17T11:00:00Z",
			"2026-06-17T10:00:00Z",
		]);
	});

	test("listBySession filters", () => {
		toolUsageStore.record({ toolName: "Shell", sessionId: "s-A", calledAt: "t1", success: true });
		toolUsageStore.record({ toolName: "Shell", sessionId: "s-B", calledAt: "t2", success: true });
		expect(toolUsageStore.listBySession("s-A").length).toBe(1);
		expect(toolUsageStore.listBySession("s-B").length).toBe(1);
	});

	test("delete removes one call", () => {
		const rec = toolUsageStore.record({ toolName: "X", calledAt: "t", success: true });
		toolUsageStore.delete(rec.id);
		expect(toolUsageStore.get(rec.id)).toBeUndefined();
	});
});
