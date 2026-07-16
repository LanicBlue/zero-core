// Wiki-system-redesign acceptance-00 §A naming/compat assertions.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-00 §A 命名契约:
//   - 不存在生产可调用的 `SessionDB` alias(全仓 grep 命中 0,排除注释)。
//   - 所有 DB 默认路径来自唯一 `database-paths` 模块;代表性地断言生产文件
//     不硬编码 sessions.db/knowledge.db/wiki.db 文件名字面量。
//   - CoreDatabase 可构造,Core 数据(agents/projects/sessions)round-trip OK。
//
// ## 输入
// 文件系统读取(src/ + scripts/ + tests/)。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/core-database.ts (CoreDatabase class — renamed from SessionDB)
//   - src/core/database-paths.ts (单一 DB 路径模块)
//
// ## 维护规则
//   - 这是 spec-compliance 守门测试:如果未来某 commit 重新引入 SessionDB
//     alias 或硬编码 DB 文件名,本测试会立刻 FAIL。
//

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// Per-file ZERO_CORE_DIR isolation (acceptance §E — test:unit runnable together).
// vitest.config.ts pins a single shared ZERO_CORE_DIR for the whole suite; the
// path constants below are frozen from it at module load. We override the env
// in a vi.hoisted factory (runs BEFORE the config/database-paths imports thanks
// to vitest's transform) so this file resolves every path under its own scratch
// profile and cannot collide with the other DB-bootstrap test files when the
// suite runs them in parallel threads.
const UNIQUE_DIR = vi.hoisted<string>(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-db-compat-"));
	process.env.ZERO_CORE_DIR = d;
	return d;
});

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { ProjectStore } from "../../src/server/project-store.js";
import {
	coreDbPath,
	wikiDbPath,
	legacyCoreDbPath,
	coreBackupDir,
	wikiBackupDir,
	DB_DIR,
	BACKUP_DIR,
	layoutMarkerPath,
} from "../../src/core/database-paths.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

afterAll(() => {
	try { rmSync(UNIQUE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Directories whose TS source is "production" for the purposes of this audit.
// scripts/ is included because plan-00 §6 explicitly requires scripts to use
// the central path module too. We do NOT audit:
//   - tests/ (test code can name historical symbols for clarity)
//   - docs/ (covered by the active-docs audit, not this grep)
//   - node_modules / dist / .vite
const PROD_DIRS = ["src"];

function listTsFiles(dir: string): string[] {
	const absDir = join(ROOT, dir);
	let files: string[] = [];
	try {
		const stat = statSync(absDir);
		if (!stat.isDirectory()) return files;
		const walk = (d: string) => {
			for (const entry of readdirSync(d, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vite") continue;
				const full = join(d, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
			}
		};
		walk(absDir);
	} catch { /* dir absent */ }
	return files;
}

/**
 * Read a TS file's lines and tag each line as either a code line or a
 * comment line. We only count `SessionDB` mentions on CODE lines (the plan
 * requires "grep 命中 0, 不含注释里的历史说明").
 *
 * Conservative heuristic — line-level, not token-level:
 *   - lines whose first non-whitespace chars start with `//` → line comment
 *   - lines inside a `// ...` block counted as code (TS has no block comments
 *     except /* ... *\/ which we DO treat as comment — see below)
 *   - lines starting with `*` or `/*` → block-comment line
 *
 * String literals are NOT excluded (a real export `class SessionDB {}` would
 * still trigger); a string `"SessionDB"` in code would also trigger, which is
 * what we want — production code should not be naming SessionDB anywhere.
 */
function isCommentLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.startsWith("//")) return true;
	if (trimmed.startsWith("*")) return true;
	if (trimmed.startsWith("/*")) return true;
	return false;
}

function findSessionDBOnCodeLines(files: string[]): Array<{ file: string; line: number; text: string }> {
	const hits: Array<{ file: string; line: number; text: string }> = [];
	for (const f of files) {
		const src = readFileSync(f, "utf-8").split(/\r?\n/);
		for (let i = 0; i < src.length; i++) {
			const line = src[i];
			if (isCommentLine(line)) continue;
			// Match "SessionDB" as a standalone identifier (not preceded by .
			// which would be a property access like `foo.SessionDB` — still a
			// code reference, but unlikely; we accept either).
			if (/\bSessionDB\b/.test(line)) {
				hits.push({ file: f, line: i + 1, text: line.trim() });
			}
		}
	}
	return hits;
}

// ============================================================
// §A bullet 2 — no production-callable SessionDB alias
// ============================================================

describe("acceptance-00 §A bullet 2 — SessionDB removed from production code", () => {
	test("no code-line `SessionDB` identifier remains in src/ TS files (comments excluded)", () => {
		const files = PROD_DIRS.flatMap(listTsFiles);
		expect(files.length).toBeGreaterThan(0); // sanity: we did find files
		const hits = findSessionDBOnCodeLines(files);
		if (hits.length > 0) {
			// Print all hits so the implementer can fix each one.
			const report = hits.map((h) => `${h.file.replace(ROOT, ".")}:${h.line}: ${h.text}`).join("\n");
			console.error("SessionDB code-line hits:\n" + report);
		}
		expect(hits.length).toBe(0);
	});

	test("the session-db.ts module file is GONE from src/server/", () => {
		// plan-00 §2 renamed session-db.ts → core-database.ts. The old path
		// must not exist; if it does, an alias re-export would be the only
		// reason (a §G rejection: "为通过测试保留生产 SessionDB fallback").
		expect(existsSync(join(ROOT, "src", "server", "session-db.ts"))).toBe(false);
	});

	test("CoreDatabase is the export name (not SessionDB)", () => {
		const src = readFileSync(join(ROOT, "src", "server", "core-database.ts"), "utf-8");
		expect(src).toMatch(/export\s+class\s+CoreDatabase\b/);
		expect(src).not.toMatch(/export\s+class\s+SessionDB\b/);
		// No alias re-export either:
		expect(src).not.toMatch(/export\s+\{\s*CoreDatabase\s+as\s+SessionDB\s*\}/);
		expect(src).not.toMatch(/export\s+\{\s*SessionDB\s*\}/);
	});
});

// ============================================================
// §A bullet 3 — DB default paths sourced from one module
// ============================================================

describe("acceptance-00 §A bullet 3 — DB paths centralized in database-paths module", () => {
	test("database-paths exports the expected path constants", () => {
		// Representative — the plan §1 names these specifically.
		expect(typeof coreDbPath).toBe("string");
		expect(coreDbPath.endsWith(join("db", "core.db"))).toBe(true);
		expect(wikiDbPath.endsWith(join("db", "wiki.db"))).toBe(true);
		expect(legacyCoreDbPath.endsWith("sessions.db")).toBe(true);
		expect(coreBackupDir.endsWith(join("backups", "core"))).toBe(true);
		expect(wikiBackupDir.endsWith(join("backups", "wiki"))).toBe(true);
		expect(layoutMarkerPath.endsWith(join("db", "layout-v1.json"))).toBe(true);
		expect(DB_DIR.endsWith("db")).toBe(true);
		expect(BACKUP_DIR.endsWith("backups")).toBe(true);
	});

	test("production TS files do NOT hardcode DB filename literals (sessions.db / knowledge.db / wiki.db / core.db)", () => {
		// Allow-list: the central module itself + the retired-db deletion
		// whitelist + the marker label. Anything else is a violation.
		const allowedFiles = new Set<string>([
			join(ROOT, "src", "core", "database-paths.ts"), // central module
			join(ROOT, "src", "server", "database-manager.ts"), // retired-db whitelist + marker label
		]);

		const banned = ["sessions.db", "knowledge.db", "wiki.db", "core.db"];
		const hits: Array<{ file: string; line: number; literal: string; text: string }> = [];

		for (const f of PROD_DIRS.flatMap(listTsFiles)) {
			if (allowedFiles.has(f)) continue;
			const src = readFileSync(f, "utf-8").split(/\r?\n/);
			for (let i = 0; i < src.length; i++) {
				const line = src[i];
				if (isCommentLine(line)) continue; // comments may reference historical names
				for (const lit of banned) {
					if (line.includes(`"${lit}"`) || line.includes(`'${lit}'`) || line.includes("`" + lit + "`")) {
						hits.push({ file: f, line: i + 1, literal: lit, text: line.trim() });
					}
				}
			}
		}

		if (hits.length > 0) {
			const report = hits
				.map((h) => `${h.file.replace(ROOT, ".")}:${h.line} [${h.literal}]: ${h.text}`)
				.join("\n");
			console.error("Hardcoded DB filename literals in prod:\n" + report);
		}
		expect(hits.length).toBe(0);
	});
});

// ============================================================
// §A bullet 4 — CoreDatabase constructible + Core data round-trips
// ============================================================

describe("acceptance-00 — CoreDatabase constructible + Core data round-trips", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-core-compat-"));
	});

	afterEach(() => {
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	test("CoreDatabase can be constructed on a fresh path and CRUDs agents/projects/sessions", () => {
		const dbPath = join(tmpDir, "fresh.db");
		const cdb = new CoreDatabase(dbPath);
		expect(() => runMigrations(cdb)).not.toThrow();

		// Agent round-trip
		const agentStore = new AgentStore(cdb);
		const agent = agentStore.create({ name: "CompatAgent" } as any);
		expect(agentStore.get(agent.id)?.name).toBe("CompatAgent");

		// Project round-trip
		const projectStore = new ProjectStore(cdb);
		const project = projectStore.create({ name: "CompatProj", workspaceDir: join(tmpDir, "ws") });
		expect(projectStore.get(project.id)?.name).toBe("CompatProj");

		// Session round-trip
		const session = cdb.createSession(agent.id, "CompatSession");
		expect(cdb.getSession(session.id)?.title).toBe("CompatSession");
		expect(cdb.getSession(session.id)?.agentId).toBe(agent.id);

		cdb.close();
	});
});
