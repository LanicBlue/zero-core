// Wiki-system-redesign plan-00 §C + acceptance-00 §C.
//
// Adversarial-edge lens: ATTACK the retired knowledge.db deletion.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-00 §C 全部 5 条要点,从对抗视角攻击删除逻辑:
//   - 精确白名单: 只删 knowledge.db / -wal / -shm 三个字面量,任何"长得像"
//     的诱饵文件 (knowledge.db.bak / knowledge.dbx / knowledge.db-wal.old /
//     knowledge.db-shm.bak / knowledge.db.d/ 子树等) 必须原样存活。
//   - 邻居不误伤: knowledge.db.keep / unrelated.db / 任意 .db / 目录 intact。
//   - 幂等: 不存在时 no-op,不抛。
//   - 结构化日志: 删除时发 retired_database_deleted;无删除时不发。
//   - 无 glob/递归: 即便布下大量 knowledge* 文件和子目录,也只有 3 个字面量
//     被触碰 —— 证明白名单是编译期常量,不接受运行时输入。
//
// ## 关键文件
//   - src/server/database-manager.ts (deleteRetiredKnowledgeDb,
//     RETIRED_KNOWLEDGE_DB_PATHS)
//   - src/core/database-paths.ts (路径常量)
//   - src/core/config.ts (ZERO_CORE_DIR — vitest.config.ts 注入 per-worker temp)
//
// ## 维护规则
//   - 每个用例 beforeEach/afterOnly 清掉本测试触碰的固定路径,绝不
//     rmSync(ZERO_CORE_DIR) 整个目录(其他单测共用)。
//   - 测试在 vitest.config.ts 注入的 OS temp ZERO_CORE_DIR 下运行,绝不读
//     活跃 ~/.zero-core。
//

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (acceptance §E — test:unit runnable together).
// ---------------------------------------------------------------------------
// ZERO_CORE_DIR is captured at module-load by src/core/config.ts and frozen
// into every database-paths constant. vitest.config.ts sets ONE shared
// ZERO_CORE_DIR for the whole suite, so when the 5 DB-bootstrap test files run
// in parallel threads they ALL stamp the same knowledge.db / db/core.db /
// sessions.db → ~35 false cross-file failures. vi.hoisted runs this factory
// BEFORE any other import in this file (vitest transform guarantee), so when
// config.ts is evaluated it picks up OUR unique temp dir and every path
// constant resolves under it. Each file thus gets its own scratch profile;
// cleanKnowledgeArtifacts() handles within-file cleanup.
const UNIQUE_DIR = vi.hoisted<string>(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-retired-kb-"));
	process.env.ZERO_CORE_DIR = d;
	return d;
});

import {
	existsSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";

import { deleteRetiredKnowledgeDb } from "../../src/server/database-manager.js";
import { ZERO_CORE_DIR } from "../../src/core/config.js";

afterAll(() => {
	// Best-effort scratch-dir teardown; never throws.
	try { rmSync(UNIQUE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

// The exact 3 whitelist literals the implementation must touch — derived from
// the same source the impl uses (join(ZERO_CORE_DIR, "...")) so the test stays
// in sync if ZERO_CORE_DIR moves. RETIRED_KNOWLEDGE_DB_PATHS in database-manager.ts
// is a `as const` array of these exact three joins; we mirror them here to assert
// the observable consequence (only these 3 files ever vanish).
const WHITELIST = [
	join(ZERO_CORE_DIR, "knowledge.db"),
	join(ZERO_CORE_DIR, "knowledge.db-wal"),
	join(ZERO_CORE_DIR, "knowledge.db-shm"),
] as const;

/**
 * Surgical cleanup of every file this test file might create. Never rmSync the
 * ZERO_CORE_DIR root itself — sibling unit tests share it within the worker.
 * `force: true` so missing entries don't throw; `recursive: true` for dirs.
 */
function cleanKnowledgeArtifacts(): void {
	// The 3 whitelist targets.
	for (const p of WHITELIST) {
		try { rmSync(p, { force: true }); } catch { /* best effort */ }
	}
	// Decoy / neighbor files we seed to attack the whitelist.
	const decoys = [
		"knowledge.db.keep",
		"knowledge.db.bak",
		"knowledge.dbx",
		"knowledge.db.old",
		"knowledge.db.tmp",
		"knowledge.db-wal.bak",
		"knowledge.db-wal.old",
		"knowledge.db-shm.bak",
		"knowledge.db-shm.old",
		"unrelated.db",
		"other.db",
		"knowledge.db-BAK",
	];
	for (const d of decoys) {
		try { rmSync(join(ZERO_CORE_DIR, d), { force: true }); } catch { /* */ }
	}
	// Directories.
	for (const d of ["knowledge.db.d", "knowledge.dir"]) {
		try { rmSync(join(ZERO_CORE_DIR, d), { recursive: true, force: true }); } catch { /* */ }
	}
}

beforeEach(() => {
	cleanKnowledgeArtifacts();
});

afterEach(() => {
	cleanKnowledgeArtifacts();
});

// ============================================================
// §C bullet 1 — direct delete, no backup / no import
// ============================================================

describe("plan-00 §C.1 — knowledge.db{-wal,-shm} deleted directly (no backup, no import)", () => {
	test("all 3 whitelisted files present → all 3 deleted; return value lists them", () => {
		// Seed real content (the impl must NOT read it — delete-only).
		writeFileSync(WHITELIST[0], "main-db-bytes");
		writeFileSync(WHITELIST[1], "wal-bytes");
		writeFileSync(WHITELIST[2], "shm-bytes");

		const result = deleteRetiredKnowledgeDb();

		expect(result.deleted.length).toBe(3);
		// deleted array contains the exact 3 absolute paths (order = whitelist order).
		expect(new Set(result.deleted)).toEqual(new Set(WHITELIST));
		for (const p of WHITELIST) {
			expect(existsSync(p)).toBe(false);
		}
	});

	test("deletion is direct (no .bak / .tmp / .migrated leftover is created in ZERO_CORE_DIR)", () => {
		// Seed only the 3 whitelist files.
		for (const p of WHITELIST) writeFileSync(p, "x");
		const beforeEntries = new Set(readdirSync(ZERO_CORE_DIR));

		deleteRetiredKnowledgeDb();

		const afterEntries = readdirSync(ZERO_CORE_DIR);
		// Every entry after must have existed before (no new backup/import artifact).
		for (const e of afterEntries) {
			expect(beforeEntries.has(e)).toBe(true);
		}
		// And the 3 base names are gone.
		expect(afterEntries).not.toContain("knowledge.db");
		expect(afterEntries).not.toContain("knowledge.db-wal");
		expect(afterEntries).not.toContain("knowledge.db-shm");
	});
});

// ============================================================
// §C bullet 4 — precise whitelist (NO glob / NO recursive / NO shell concat)
// ============================================================
//
// This is the CRITICAL adversarial attack: seed MANY files that look like
// knowledge.db under glob patterns (`knowledge.db*`, `knowledge*`, `*.db`,
// `knowledge.db-*`) and prove ONLY the exact 3 literals vanish. Any glob-based
// deletion (`rm knowledge.db*` / `rm knowledge*` / `rm *.db`) would sweep up
// the decoys. A recursive deletion would descend into the subdir.

describe("plan-00 §C.4 — precise absolute-path whitelist (attack: decoy files survive)", () => {
	test("decoys that glob `knowledge.db*` would catch are NOT deleted", () => {
		// Real targets.
		for (const p of WHITELIST) writeFileSync(p, "x");
		// Decoys that `knowledge.db*` / `knowledge.db-*` globs would catch.
		const decoys = [
			"knowledge.db.bak",
			"knowledge.dbx", // would match `knowledge.db*`
			"knowledge.db.old",
			"knowledge.db.tmp",
			"knowledge.db-wal.bak", // would match `knowledge.db-wal*`
			"knowledge.db-wal.old",
			"knowledge.db-shm.bak",
			"knowledge.db-shm.old",
			"knowledge.db-BAK",
		];
		for (const d of decoys) writeFileSync(join(ZERO_CORE_DIR, d), "decoy");

		deleteRetiredKnowledgeDb();

		// Whitelist targets gone.
		for (const p of WHITELIST) expect(existsSync(p)).toBe(false);
		// EVERY decoy intact.
		for (const d of decoys) {
			expect(existsSync(join(ZERO_CORE_DIR, d))).toBe(true);
			expect(readFileSync(join(ZERO_CORE_DIR, d), "utf-8")).toBe("decoy");
		}
	});

	test("decoys that glob `knowledge*` / `*.db` would catch are NOT deleted", () => {
		for (const p of WHITELIST) writeFileSync(p, "x");
		// Decoys that broader globs would catch.
		const decoys = [
			"knowledge.db.keep", // explicit acceptance-00 §C.3 neighbor
			"knowledge.txt", // `knowledge*`
			"unrelated.db", // `*.db`
			"other.db", // `*.db`
			"knowledge.dbx", // `knowledge*`
		];
		for (const d of decoys) writeFileSync(join(ZERO_CORE_DIR, d), "decoy");

		deleteRetiredKnowledgeDb();

		for (const p of WHITELIST) expect(existsSync(p)).toBe(false);
		for (const d of decoys) {
			expect(existsSync(join(ZERO_CORE_DIR, d))).toBe(true);
		}
	});

	test("a subdirectory named knowledge.db.d is NOT recursively deleted", () => {
		for (const p of WHITELIST) writeFileSync(p, "x");
		// A directory whose name a recursive `rm -r knowledge.db*` would descend into.
		const sub = join(ZERO_CORE_DIR, "knowledge.db.d");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, "nested1.dat"), "nested");
		mkdirSync(join(sub, "deep"), { recursive: true });
		writeFileSync(join(sub, "deep", "nested2.dat"), "deeply-nested");

		deleteRetiredKnowledgeDb();

		// Whitelist files gone; directory tree fully intact (recursion proof).
		for (const p of WHITELIST) expect(existsSync(p)).toBe(false);
		expect(existsSync(sub)).toBe(true);
		expect(existsSync(join(sub, "nested1.dat"))).toBe(true);
		expect(readFileSync(join(sub, "nested1.dat"), "utf-8")).toBe("nested");
		expect(existsSync(join(sub, "deep", "nested2.dat"))).toBe(true);
		expect(readFileSync(join(sub, "deep", "nested2.dat"), "utf-8")).toBe("deeply-nested");
	});

	test("a directory PLUS the 3 files: only files touched, directory structure untouched", () => {
		for (const p of WHITELIST) writeFileSync(p, "x");
		// A plain directory named similarly.
		const dir = join(ZERO_CORE_DIR, "knowledge.dir");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "preserve.txt"), "keep-me");

		deleteRetiredKnowledgeDb();

		for (const p of WHITELIST) expect(existsSync(p)).toBe(false);
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(join(dir, "preserve.txt"))).toBe(true);
	});

	test("return value NEVER lists a non-whitelist path even when many decoys exist", () => {
		// This is the strongest whitelist invariant: the deleted[] returned list
		// must be a subset of the 3 whitelist literals, regardless of how many
		// look-alike files are present. If any glob leaked in, this fails.
		for (const p of WHITELIST) writeFileSync(p, "x");
		const decoys = [
			"knowledge.db.bak", "knowledge.dbx", "knowledge.db.old",
			"knowledge.db-wal.bak", "knowledge.db-shm.bak",
			"knowledge.db.keep", "unrelated.db",
		];
		for (const d of decoys) writeFileSync(join(ZERO_CORE_DIR, d), "x");

		const result = deleteRetiredKnowledgeDb();
		const whitelistSet = new Set<string>(WHITELIST);

		// Every reported deletion must be one of the 3 exact whitelist paths.
		for (const reported of result.deleted) {
			expect(whitelistSet.has(reported)).toBe(true);
		}
		// And exactly 3 (no duplicates, no extras).
		expect(result.deleted.length).toBe(3);
	});
});

// ============================================================
// §C bullet 2 — idempotent no-op when absent
// ============================================================

describe("plan-00 §C.2 — idempotent when files absent", () => {
	test("calling on an empty profile is a no-op (no throw, deleted=[])", () => {
		// Pre-state: none of the 3 exist.
		for (const p of WHITELIST) expect(existsSync(p)).toBe(false);

		expect(() => deleteRetiredKnowledgeDb()).not.toThrow();
		const r1 = deleteRetiredKnowledgeDb();
		expect(r1.deleted).toEqual([]);
	});

	test("calling twice in a row: second call is a no-op", () => {
		for (const p of WHITELIST) writeFileSync(p, "x");

		const r1 = deleteRetiredKnowledgeDb();
		expect(r1.deleted.length).toBe(3);

		// Second call sees nothing left → no-op.
		const r2 = deleteRetiredKnowledgeDb();
		expect(r2.deleted).toEqual([]);
		for (const p of WHITELIST) expect(existsSync(p)).toBe(false);
	});

	test("partial presence (only knowledge.db exists, -wal/-shm absent) deletes the one present, no throw", () => {
		writeFileSync(WHITELIST[0], "x");
		expect(existsSync(WHITELIST[1])).toBe(false);
		expect(existsSync(WHITELIST[2])).toBe(false);

		const r = deleteRetiredKnowledgeDb();
		expect(r.deleted).toEqual([WHITELIST[0]]);
		expect(existsSync(WHITELIST[0])).toBe(false);
	});
});

// ============================================================
// §C bullet 3 — neighbor preservation (acceptance-00 §C.3 explicit)
// ============================================================

describe("plan-00 §C.3 — neighbors preserved (knowledge.db.keep / .db / dirs)", () => {
	test("acceptance-00 §C.3 enumerated neighbors all survive", () => {
		// The exact neighbors called out in the acceptance doc.
		for (const p of WHITELIST) writeFileSync(p, "x");
		writeFileSync(join(ZERO_CORE_DIR, "knowledge.db.keep"), "keep");
		writeFileSync(join(ZERO_CORE_DIR, "unrelated.db"), "unrelated");
		writeFileSync(join(ZERO_CORE_DIR, "other.db"), "other");
		mkdirSync(join(ZERO_CORE_DIR, "knowledge.db.d"), { recursive: true });

		deleteRetiredKnowledgeDb();

		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db.keep"))).toBe(true);
		expect(readFileSync(join(ZERO_CORE_DIR, "knowledge.db.keep"), "utf-8")).toBe("keep");
		expect(existsSync(join(ZERO_CORE_DIR, "unrelated.db"))).toBe(true);
		expect(existsSync(join(ZERO_CORE_DIR, "other.db"))).toBe(true);
		expect(existsSync(join(ZERO_CORE_DIR, "knowledge.db.d"))).toBe(true);
	});
});

// ============================================================
// §C bullet 5 — structured log `retired_database_deleted` emitted
// ============================================================

describe("plan-00 §C.5 — structured log retired_database_deleted", () => {
	test("emits retired_database_deleted when files are deleted (console.error spy)", () => {
		// The impl emits via BOTH log.db(...) → console.log AND an explicit
		// console.error("[db] retired_database_deleted: N file(s) removed").
		// Spy on console.error — the explicit, unambiguous signal.
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		for (const p of WHITELIST) writeFileSync(p, "x");
		try {
			deleteRetiredKnowledgeDb();

			const captured = errSpy.mock.calls.filter(
				(c) => typeof c[0] === "string" && c[0].includes("retired_database_deleted"),
			);
			expect(captured.length).toBeGreaterThanOrEqual(1);
			// The message reports the correct count.
			const msg = captured[0][0] as string;
			expect(msg).toMatch(/3 file\(s\)/);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("emits via log.db structured channel (console.log spy captures retired_database_deleted)", () => {
		// log.db("retired_database_deleted", { deleted }) routes through the
		// logger's consoleSink → console.log with prefix "[<ts> db] retired_database_deleted".
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		for (const p of WHITELIST) writeFileSync(p, "x");
		try {
			deleteRetiredKnowledgeDb();

			const captured = logSpy.mock.calls.filter(
				(c) => typeof c[0] === "string" && c[0].includes("retired_database_deleted"),
			);
			expect(captured.length).toBeGreaterThanOrEqual(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	test("does NOT emit retired_database_deleted when nothing was deleted (idempotent no-op)", () => {
		// §C.2 + §C.5 together: a no-op must not emit a spurious delete log.
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			// Nothing seeded → no deletion → no retired_database_deleted log.
			const r = deleteRetiredKnowledgeDb();
			expect(r.deleted).toEqual([]);

			const errHits = errSpy.mock.calls.filter(
				(c) => typeof c[0] === "string" && c[0].includes("retired_database_deleted"),
			);
			expect(errHits.length).toBe(0);
		} finally {
			errSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
