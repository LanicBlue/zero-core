// P0 单元测试:migration 双路径(契约 §1.2)
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P0 (acceptance-P0.md 「migration 双路径」节):
//   - 旧 schema 库 → runMigrations → 新列/新表齐全
//   - 旧 agents 行数据保留(role_tag 物理列还在,store 不再 round-trip)
//   - 旧 crons 行 schedule 字符串已转 JSON(off/hourly/daily/weekly/数字串)
//   - 各 *_COLUMNS 数组与表一致(无 fresh 缺列)
//   - trigger_mode 回填与 schedule.mode 一致
//
// ## 输入
// 临时 CoreDatabase (mkdtempSync) + 用 helpers/p0-test-helpers 构造的旧 schema 库。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/db-migration.ts (runMigrations / migrateCronScheduleToJson)
//   - tests/unit/helpers/p0-test-helpers.ts (createLegacySchemaDb 等)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	createLegacySchemaDb,
	buildLegacyAgentRow,
	buildLegacyCronRow,
} from "./helpers/p0-test-helpers.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p0-migration-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Open a DB at the given path with the legacy (pre-P0) schema. */
function openLegacyDb(path: string): Database.Database {
	const db = new Database(path);
	createLegacySchemaDb(db);
	return db;
}

/** Column names of a table, as a Set. */
function columnsOf(db: Database.Database, table: string): Set<string> {
	const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

/** Index names of a table, as a Set. */
function indexesOf(db: Database.Database, table: string): Set<string> {
	const rows = db.pragma(`index_list(${table})`) as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

// ─── Fresh DB path ────────────────────────────────────────────

describe("P0 migration — fresh DB path", () => {
	test("runMigrations on an empty DB creates all P0 new tables", () => {
		const dbPath = join(tmpDir, "fresh.db");
		const sessionDB = new CoreDatabase(dbPath);
		runMigrations(sessionDB);
		const db = sessionDB.getDb();

		// New tables exist.
		const tables = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
				.map((r) => r.name),
		);
		expect(tables.has("cron_runs")).toBe(true);
		expect(tables.has("tool_configs")).toBe(true);
		expect(tables.has("tool_usage")).toBe(true);
		expect(tables.has("crons")).toBe(true);

		sessionDB.close();
	});

	test("fresh DB has all P0 columns on agents/crons (no fresh-missing column)", () => {
		const dbPath = join(tmpDir, "fresh-cols.db");
		const sessionDB = new CoreDatabase(dbPath);
		runMigrations(sessionDB);
		const db = sessionDB.getDb();

		// agents: subagents added; role_tag retained (legacy).
		// plan-08 §1: wiki_anchors column was REMOVED (legacy wikiAnchors field
		// deleted from AgentRecord). Fresh DB must NOT create it.
		const agentCols = columnsOf(db, "agents");
		expect(agentCols.has("subagents")).toBe(true);
		expect(agentCols.has("wiki_anchors"), "wiki_anchors must NOT exist on fresh DB post-sub-08").toBe(false);
		expect(agentCols.has("role_tag")).toBe(true); // legacy retained (P0 §1.4)

		// crons: schedule JSON + 5 telemetry columns.
		const cronCols = columnsOf(db, "crons");
		expect(cronCols.has("schedule")).toBe(true);
		expect(cronCols.has("trigger_mode")).toBe(true);
		expect(cronCols.has("last_run_at")).toBe(true);
		expect(cronCols.has("last_status")).toBe(true);
		expect(cronCols.has("last_error")).toBe(true);
		expect(cronCols.has("next_run_at")).toBe(true);

		// plan-08 §1: project_wiki table is NO LONGER CREATED on fresh DB
		// (legacy WikiStore cutover). Existing DBs keep their stale table.
		const hasProjectWiki = db.prepare(
			`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='project_wiki'`,
		).get() as { n: number };
		expect(hasProjectWiki.n, "fresh core.db must NOT create project_wiki").toBe(0);

		// cron_runs columns.
		const crCols = columnsOf(db, "cron_runs");
		for (const c of ["id", "cron_id", "fired_at", "agent_id", "session_id", "success", "error", "duration_ms", "tokens", "cost", "created_at", "updated_at"]) {
			expect(crCols.has(c), `cron_runs.${c}`).toBe(true);
		}

		// tool_configs columns.
		const tcCols = columnsOf(db, "tool_configs");
		for (const c of ["tool_name", "config", "updated_at"]) {
			expect(tcCols.has(c), `tool_configs.${c}`).toBe(true);
		}

		// tool_usage columns.
		const tuCols = columnsOf(db, "tool_usage");
		for (const c of ["id", "tool_name", "agent_id", "session_id", "called_at", "params", "success", "duration_ms"]) {
			expect(tuCols.has(c), `tool_usage.${c}`).toBe(true);
		}

		sessionDB.close();
	});

	test("fresh DB has all P0 indexes", () => {
		const dbPath = join(tmpDir, "fresh-idx.db");
		const sessionDB = new CoreDatabase(dbPath);
		runMigrations(sessionDB);
		const db = sessionDB.getDb();

		expect(indexesOf(db, "cron_runs").has("idx_cron_runs_cron")).toBe(true);
		expect(indexesOf(db, "tool_usage").has("idx_tool_usage_tool")).toBe(true);
		expect(indexesOf(db, "tool_usage").has("idx_tool_usage_session")).toBe(true);

		sessionDB.close();
	});

	test("fresh DB is idempotent — running runMigrations twice does not throw", () => {
		const dbPath = join(tmpDir, "fresh-idempotent.db");
		const sessionDB = new CoreDatabase(dbPath);
		runMigrations(sessionDB);
		expect(() => runMigrations(sessionDB)).not.toThrow();
		sessionDB.close();
	});
});

// ─── Upgraded-DB (legacy schema) path ─────────────────────────

describe("P0 migration — legacy schema upgrade path", () => {
	test("runMigrations ALTERs new columns onto legacy tables without data loss", () => {
		const dbPath = join(tmpDir, "legacy.db");
		// Build a legacy-shape DB with real data.
		const legacy = openLegacyDb(dbPath);
		buildLegacyAgentRow(legacy, { id: "agent-pm-1", name: "PM", roleTag: "pm", systemPrompt: "old" });
		buildLegacyCronRow(legacy, { id: "cron-1", agentId: "agent-pm-1", schedule: "hourly", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "cron-2", agentId: "agent-pm-1", schedule: "daily", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "cron-3", agentId: "agent-pm-1", schedule: "weekly", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "cron-4", agentId: "agent-pm-1", schedule: "off", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "cron-5", agentId: "agent-pm-1", schedule: "60000", enabled: 1 });
		legacy.close();

		// Open via CoreDatabase + migrate.
		const sessionDB = new CoreDatabase(dbPath);
		expect(() => runMigrations(sessionDB)).not.toThrow();
		const db = sessionDB.getDb();

		// New columns now present.
		// plan-08 §1: wiki_anchors ALTER was REMOVED — legacy DBs that lacked
		// it will not get it added; existing DBs that already have it keep it
		// (no destructive drop). subagents + role_tag are still added.
		const agentCols = columnsOf(db, "agents");
		expect(agentCols.has("subagents")).toBe(true);
		expect(agentCols.has("wiki_anchors"), "wiki_anchors ALTER removed in plan-08 §1").toBe(false);
		expect(agentCols.has("role_tag")).toBe(true);

		const cronCols = columnsOf(db, "crons");
		for (const c of ["trigger_mode", "last_run_at", "last_status", "last_error", "next_run_at"]) {
			expect(cronCols.has(c), `crons.${c}`).toBe(true);
		}
		// plan-08 §1: project_wiki.links ALTER was REMOVED. If the seeded
		// legacy schema didn't have links, migrations no longer add it.
		expect(columnsOf(db, "project_wiki").has("links"), "project_wiki.links ALTER removed in plan-08 §1").toBe(false);

		// Agents row preserved.
		const agentRow = db.prepare("SELECT name, role_tag FROM agents WHERE id = ?").get("agent-pm-1") as any;
		expect(agentRow.name).toBe("PM");
		expect(agentRow.role_tag).toBe("pm");

		sessionDB.close();
	});

	test("legacy cron schedule strings are converted to structured JSON", () => {
		const dbPath = join(tmpDir, "legacy-cron.db");
		const legacy = openLegacyDb(dbPath);
		buildLegacyCronRow(legacy, { id: "c-hourly", agentId: "a", schedule: "hourly", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "c-daily", agentId: "a", schedule: "daily", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "c-weekly", agentId: "a", schedule: "weekly", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "c-off", agentId: "a", schedule: "off", enabled: 1 });
		buildLegacyCronRow(legacy, { id: "c-ms", agentId: "a", schedule: "120000", enabled: 1 });
		legacy.close();

		const sessionDB = new CoreDatabase(dbPath);
		runMigrations(sessionDB);
		const db = sessionDB.getDb();

		const read = (id: string) => db.prepare("SELECT schedule, trigger_mode, enabled FROM crons WHERE id = ?").get(id) as {
			schedule: string; trigger_mode: string | null; enabled: number;
		};

		const hourly = read("c-hourly");
		expect(JSON.parse(hourly.schedule)).toEqual({ mode: "interval", everyMs: 3_600_000 });
		expect(hourly.trigger_mode).toBe("interval");

		const daily = read("c-daily");
		const dailyParsed = JSON.parse(daily.schedule);
		expect(dailyParsed.mode).toBe("alarm");
		expect(dailyParsed.time).toBe("09:00");
		expect(dailyParsed.days).toEqual([]);
		expect(typeof dailyParsed.tz).toBe("string"); // local zone
		expect(daily.trigger_mode).toBe("alarm");

		const weekly = read("c-weekly");
		const weeklyParsed = JSON.parse(weekly.schedule);
		expect(weeklyParsed.mode).toBe("alarm");
		expect(weeklyParsed.time).toBe("09:00");
		expect(weeklyParsed.days).toEqual([expect.any(Number)]); // today's weekday
		expect(weekly.trigger_mode).toBe("alarm");

		const off = read("c-off");
		expect(JSON.parse(off.schedule)).toEqual({ mode: "interval", everyMs: 0 });
		expect(off.enabled).toBe(0); // "off" sentinel forced disabled
		expect(off.trigger_mode).toBe("interval");

		const ms = read("c-ms");
		expect(JSON.parse(ms.schedule)).toEqual({ mode: "interval", everyMs: 120000 });
		expect(ms.trigger_mode).toBe("interval");

		sessionDB.close();
	});

	test("migration is idempotent — JSON schedules survive a second run unchanged", () => {
		const dbPath = join(tmpDir, "legacy-idempotent.db");
		const legacy = openLegacyDb(dbPath);
		buildLegacyCronRow(legacy, { id: "c-1", agentId: "a", schedule: "hourly", enabled: 1 });
		legacy.close();

		const sessionDB = new CoreDatabase(dbPath);
		runMigrations(sessionDB);
		const after1 = (sessionDB.getDb().prepare("SELECT schedule FROM crons WHERE id = 'c-1'").get() as { schedule: string }).schedule;

		// Second migration pass.
		expect(() => runMigrations(sessionDB)).not.toThrow();
		const after2 = (sessionDB.getDb().prepare("SELECT schedule FROM crons WHERE id = 'c-1'").get() as { schedule: string }).schedule;

		expect(after2).toBe(after1); // no further mutation

		sessionDB.close();
	});

	test("legacy agents role_tag data preserved and readable via listByRoleTag", async () => {
		const dbPath = join(tmpDir, "legacy-role.db");
		const legacy = openLegacyDb(dbPath);
		buildLegacyAgentRow(legacy, { id: "a1", name: "PM1", roleTag: "pm" });
		buildLegacyAgentRow(legacy, { id: "a2", name: "Lead", roleTag: "lead" });
		legacy.close();

		const sessionDB = new CoreDatabase(dbPath);
		runMigrations(sessionDB);
		const { AgentStore } = await import("../../src/server/agent-store.js");
		const store = new AgentStore(sessionDB);

		expect(store.listByRoleTag("pm").map((a) => a.name)).toEqual(["PM1"]);
		expect(store.listByRoleTag("lead").map((a) => a.name)).toEqual(["Lead"]);
		// AgentRecord type no longer exposes roleTag; it should be undefined.
		expect((store.get("a1") as any).roleTag).toBeUndefined();

		sessionDB.close();
	});
});
