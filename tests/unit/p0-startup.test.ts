// P0 集成测试:fresh DB 启动 + 旧库启动(acceptance-P0.md「migration 双路径」节)
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P0 (契约 §1.2 双路径):
//   - **fresh DB**:空库 → CoreDatabase 构造 + runMigrations + 实例化所有 store
//     全程不崩,所有 P0 表/列可读写。
//   - **旧库**:用 helpers 构造 pre-P0 schema 库(带数据) → runMigrations →
//     实例化所有 store + CRUD 一轮不崩。
//
// 这是 acceptance-P0「两条路径都要过」的集成层验证(e2e 走 Electron 端到端
// 的等价路径在此处用 unit/集成测试覆盖 —— 见 impl-plan「若无对应 e2e」)。
//
// ## 输入
// 临时 CoreDatabase (mkdtempSync) + helpers 构造的旧 schema 库。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/db-migration.ts (runMigrations)
//   - src/server/core-database.ts
//   - 全部 P0 store (AgentStore / CronStore / CronRunStore /
//     ToolConfigStore / ToolUsageStore)
//
// round-2 E4 (opportunistic restore): this file was deleted in round-1
// because it imported the deleted `wiki-node-store` module. Restored here
// with the wiki-specific bits stripped (WikiStore import + the 3-line
// `wiki.ensureProjectSubtree` block in exerciseAllStores). All non-wiki
// boot/upgrade/store CRUD coverage preserved. Pure-wiki coverage lives in
// the wiki-v2 suite.
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { CronStore, CronRunStore } from "../../src/server/cron-store.js";
import { ToolConfigStore, ToolUsageStore } from "../../src/server/tool-usage-store.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	createLegacySchemaDb,
	buildLegacyAgentRow,
	buildLegacyCronRow,
} from "./helpers/p0-test-helpers.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p0-startup-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Instantiate every P0 store and run a one-row CRUD pass on each. */
function exerciseAllStores(sessionDB: CoreDatabase) {
	const agent = new AgentStore(sessionDB).create({ name: "Startup", subagents: [{ agentId: "x" }] } as any);
	expect(agent.subagents).toEqual([{ agentId: "x" }]);

	const proj = new ProjectStore(sessionDB).create({ name: "P", workspaceDir: join(tmpDir, "ws") });

	const cron = new CronStore(sessionDB).create({
		agentId: agent.id,
		workingScope: { workspaceDir: proj.workspaceDir, wikiRootNodeId: "wiki-root:global" },
		schedule: { mode: "interval", everyMs: 60_000 },
		enabled: true,
	});
	expect(cron.triggerMode).toBe("interval");

	const runStore = new CronRunStore(sessionDB);
	const run = runStore.create({ cronId: cron.id, firedAt: "2026-06-17T10:00:00Z", success: true });
	expect(runStore.get(run.id)).toBeDefined();

	// round-2 E4: WikiStore block removed (wiki-node-store module deleted in
	// plan-08 §1; wiki subtree CRUD covered by wiki-v2 suite).

	const cfg = new ToolConfigStore(sessionDB).upsert("Shell", { x: 1 });
	expect(cfg.config).toEqual({ x: 1 });

	const usage = new ToolUsageStore(sessionDB).record({
		toolName: "Shell", calledAt: "2026-06-17T10:00:00Z", success: true,
	});
	expect(usage.id).toBeTruthy();
}

// ─── Fresh DB startup ────────────────────────────────────────

describe("P0 startup — fresh DB", () => {
	test("CoreDatabase + runMigrations + every P0 store instantiates and CRUDs without crashing", () => {
		const dbPath = join(tmpDir, "fresh.db");
		const sessionDB = new CoreDatabase(dbPath);
		expect(() => runMigrations(sessionDB)).not.toThrow();
		expect(() => exerciseAllStores(sessionDB)).not.toThrow();
		sessionDB.close();
	});

	test("fresh DB can open, close, reopen and runMigrations stays healthy", () => {
		const dbPath = join(tmpDir, "fresh-reopen.db");
		const s1 = new CoreDatabase(dbPath);
		runMigrations(s1);
		new AgentStore(s1).create({ name: "A" } as any);
		s1.close();

		const s2 = new CoreDatabase(dbPath);
		expect(() => runMigrations(s2)).not.toThrow();
		const agents = new AgentStore(s2).list();
		expect(agents.length).toBeGreaterThanOrEqual(1);
		s2.close();
	});
});

// ─── Legacy DB startup ───────────────────────────────────────

describe("P0 startup — legacy (upgraded) DB", () => {
	test("legacy schema DB upgrades cleanly and stores CRUD without crashing", () => {
		const dbPath = join(tmpDir, "legacy.db");

		// Build a legacy DB with rows that must survive migration.
		const db = new (require("better-sqlite3"))(dbPath);
		createLegacySchemaDb(db);
		buildLegacyAgentRow(db, { id: "legacy-pm", name: "LegacyPM", roleTag: "pm", systemPrompt: "old prompt" });
		buildLegacyCronRow(db, { id: "legacy-cron", agentId: "legacy-pm", schedule: "hourly", enabled: 1 });
		db.close();

		// Upgrade via CoreDatabase + runMigrations.
		const sessionDB = new CoreDatabase(dbPath);
		expect(() => runMigrations(sessionDB)).not.toThrow();

		// Legacy data preserved.
		const agentStore = new AgentStore(sessionDB);
		const pm = agentStore.listByRoleTag("pm")[0];
		expect(pm).toBeDefined();
		expect(pm.name).toBe("LegacyPM");
		expect(pm.systemPrompt).toBe("old prompt");

		const cronStore = new CronStore(sessionDB);
		const cron = cronStore.listByAgent("legacy-pm")[0];
		expect(cron.schedule).toEqual({ mode: "interval", everyMs: 3_600_000 });
		expect(cron.triggerMode).toBe("interval");

		// And new CRUD still works post-upgrade.
		expect(() => exerciseAllStores(sessionDB)).not.toThrow();

		sessionDB.close();
	});

	test("legacy DB with no rows upgrades cleanly (empty-but-old)", () => {
		const dbPath = join(tmpDir, "legacy-empty.db");
		const db = new (require("better-sqlite3"))(dbPath);
		createLegacySchemaDb(db);
		db.close();

		const sessionDB = new CoreDatabase(dbPath);
		expect(() => runMigrations(sessionDB)).not.toThrow();
		expect(() => exerciseAllStores(sessionDB)).not.toThrow();
		sessionDB.close();
	});
});
