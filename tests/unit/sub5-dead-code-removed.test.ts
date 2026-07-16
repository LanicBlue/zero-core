// compression-archive-simplify sub-5 acceptance test (independent verifier).
//
// Spec: docs/plan/compression-archive-simplify/acceptance-5.md (7 items).
// Design: docs/plan/compression-archive-simplify/design.md 「四、死代码 / 假配置清理」.
//
// This file is a PURE-SUBTRACTION gate: it asserts that the dead code / fake
// config surfaces enumerated in acceptance-5 are GONE from production code,
// while the live compression control surface (compression.provider/model/
// summarySystemPrompt) and the preserved ExtractorB class file are intact.
//
// It ALSO encodes the 4 adversarial-verifier checks:
//   A1. ExtractorB instantiation status — the implementer removed the only
//       factory (`buildExtractorB`) wiring in server/index.ts. Is ExtractorB
//       now an orphan (never `new`'d in production)? This test pins the
//       answer so a future change is flagged.
//   A2. (sub4-archive-flow baseline isolation — covered separately by running
//        that file standalone; not asserted here.)
//   A3. safeDropColumn idempotency — covered in the "fresh DB boots" group.
//   A4. Net subtraction sanity — covered by a `git diff --shortstat` check
//       (deletions >> insertions).

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { ZeroCoreConfigSchema, DEFAULT_CONFIG } from "../../src/core/config.js";
import { CoreDatabase } from "../../src/server/core-database.js";

// ---------------------------------------------------------------------------
// Paths + helpers
// ---------------------------------------------------------------------------

// tests/unit/ → worktree root is two levels up.
const REPO_ROOT = resolve(__dirname, "../..");
const SRC_DIR = join(REPO_ROOT, "src");

/** Recursively collect file paths under `dir` matching one of `exts`. */
function walk(dir: string, exts: string[]): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir)) {
		const p = join(dir, ent);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...walk(p, exts));
		else if (exts.some((e) => p.endsWith(e))) out.push(p);
	}
	return out;
}

/**
 * Strip // line comments and /* block *\/ comments from TS source so we can
 * assert a symbol has ZERO live references (only comment mentions are allowed,
 * which the implementer used to document the removal).
 *
 * Conservative: also strips lines whose first non-whitespace chars are `*`
 * (middle-of-block-comment lines) or `/*`. Anything that survives this pass is
 * treated as live code for the purposes of the subtraction gate.
 */
function stripComments(src: string): string {
	// Drop block comments (non-greedy, multiline).
	const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, "");
	// Drop full-line // comments and tail comments. We keep the newline so
	// line structure survives (helps debugging if a test fires).
	return noBlocks
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
				return "";
			}
			// Strip tail comment (best-effort — doesn't respect string literals,
			// but a `//` inside a string literal in this codebase is extremely
			// rare and would only over-strip, never under-strip).
			const idx = line.indexOf("//");
			return idx >= 0 ? line.slice(0, idx) : line;
		})
		.join("\n");
}

/** Read all production source as one stripped blob, plus a path→blob map. */
function readSrcCode(): { map: Map<string, string>; all: string } {
	const map = new Map<string, string>();
	const files = walk(SRC_DIR, [".ts", ".tsx"]);
	const parts: string[] = [];
	for (const f of files) {
		const stripped = stripComments(readFileSync(f, "utf8"));
		map.set(f, stripped);
		parts.push(stripped);
	}
	return { map, all: parts.join("\n") };
}

const SRC = readSrcCode();

/** Assert `sym` has zero live token occurrences across stripped src. */
function expectNoLiveCode(symbol: string): void {
	// Match the symbol as a word-boundaried token so `ExtractorA` doesn't
	// match `ExtractorAService`. Caller passes the exact symbol.
	const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
	const hits: string[] = [];
	for (const [path, blob] of SRC.map) {
		const m = blob.match(re);
		if (m && m.length > 0) {
			const rel = path.replace(SRC_DIR + sep, "");
			hits.push(`${rel}: ${m.length} hit(s)`);
		}
	}
	expect(hits, `live code references to "${symbol}" must be zero (comments allowed); found:\n${hits.join("\n")}`).toEqual([]);
}

/** Like expectNoLiveCode but also accepts a leading custom regex. */
function expectNoLiveCodeRe(label: string, pattern: RegExp): void {
	const hits: string[] = [];
	for (const [path, blob] of SRC.map) {
		const m = blob.match(pattern);
		if (m) {
			const rel = path.replace(SRC_DIR + sep, "");
			hits.push(`${rel}: ${m[0]}`);
		}
	}
	expect(hits, `${label} — must be zero (comments allowed); found:\n${hits.join("\n")}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// #1 — ExtractorA 全删
// ---------------------------------------------------------------------------

describe("[acceptance-5 #1] ExtractorA 整体删除", () => {
	test("extractor-a-service.ts file does not exist", () => {
		const p = join(SRC_DIR, "server", "extractor-a-service.ts");
		expect(existsSync(p), `${p} must be deleted`).toBe(false);
	});

	test("ExtractorAService — zero live code references", () => {
		expectNoLiveCode("ExtractorAService");
	});

	test("mergeSummaryIntoWiki — zero live code references", () => {
		expectNoLiveCode("mergeSummaryIntoWiki");
	});

	test("buildExtractorA — zero live code references", () => {
		// buildExtractorA was the factory closure handed to extractionDeps.
		// Both the closure and its only caller are gone.
		expectNoLiveCode("buildExtractorA");
	});

	test("no module imports the deleted extractor-a-service path", () => {
		// Path-based check: even if a string literal mentioned the file, a live
		// import/from would re-introduce the dependency.
		expectNoLiveCodeRe(
			"imports of extractor-a-service",
			/(?:from|import\()\s*["'][^"']*extractor-a-service/g,
		);
	});
});

// ---------------------------------------------------------------------------
// #2 — extraction-hooks 清
// ---------------------------------------------------------------------------

describe("[acceptance-5 #2] extraction-hooks stub 删除", () => {
	test("extraction-hooks.ts file does not exist", () => {
		const p = join(SRC_DIR, "runtime", "hooks", "extraction-hooks.ts");
		expect(existsSync(p), `${p} must be deleted`).toBe(false);
	});

	test("registerExtractionHooks — zero live code references", () => {
		expectNoLiveCode("registerExtractionHooks");
	});

	test("ExtractionHooksDeps — zero live code references", () => {
		// The type field on HookWiringDeps must also be gone (or it would be a
		// dangling typed slot).
		expectNoLiveCode("ExtractionHooksDeps");
	});

	test("closeFlushSession — zero live code references", () => {
		// closeFlushSession lived in extraction-hooks; agent-service used to
		// dynamic-import it. Both ends are gone.
		expectNoLiveCode("closeFlushSession");
	});

	test("extractionDeps — zero live code references on HookWiringDeps", () => {
		// The field name itself must not appear (no orphan typed slot, no
		// destructuring). Comments document the removal; stripping hides those.
		expectNoLiveCode("extractionDeps");
	});
});

// ---------------------------------------------------------------------------
// #3 — compaction / context-manager 死模块删
// ---------------------------------------------------------------------------

describe("[acceptance-5 #3] compaction / context-manager 模块删除", () => {
	test("compaction.ts file does not exist", () => {
		expect(existsSync(join(SRC_DIR, "core", "compaction.ts"))).toBe(false);
	});

	test("context-manager.ts file does not exist", () => {
		expect(existsSync(join(SRC_DIR, "core", "context-manager.ts"))).toBe(false);
	});

	test("shouldCompact — zero live code references", () => {
		expectNoLiveCode("shouldCompact");
	});

	test("shouldPrune — zero live code references", () => {
		expectNoLiveCode("shouldPrune");
	});

	test("pruneMessages — zero live code references", () => {
		expectNoLiveCode("pruneMessages");
	});

	test("src/index.ts no longer re-exports compaction / context-manager symbols", () => {
		const idx = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
		const stripped = stripComments(idx);
		expect(stripped, "shouldPrune must be gone from src/index.ts exports").not.toMatch(/\bshouldPrune\b/);
		expect(stripped, "pruneMessages must be gone from src/index.ts exports").not.toMatch(/\bpruneMessages\b/);
		expect(stripped, "shouldCompact must be gone from src/index.ts exports").not.toMatch(/\bshouldCompact\b/);
	});

	test("no live imports of the deleted module paths", () => {
		expectNoLiveCodeRe(
			"imports of compaction.ts",
			/(?:from|import\()\s*["'][^"']*core\/compaction/g,
		);
		expectNoLiveCodeRe(
			"imports of context-manager.ts",
			/(?:from|import\()\s*["'][^"']*core\/context-manager/g,
		);
	});
});

// ---------------------------------------------------------------------------
// #4 — 配置面清(compaction.* / context.* / compression.enabled gone;
//       compression.provider/model/summarySystemPrompt live)
// ---------------------------------------------------------------------------

describe("[acceptance-5 #4] dead config surface gone, live surface intact", () => {
	test("ZeroCoreConfigSchema has no `compaction` top-level key", () => {
		const keys = Object.keys(ZeroCoreConfigSchema.properties);
		expect(keys, "compaction.* schema must be deleted").not.toContain("compaction");
	});

	test("ZeroCoreConfigSchema has no `context` top-level key", () => {
		const keys = Object.keys(ZeroCoreConfigSchema.properties);
		expect(keys, "context.* schema must be deleted").not.toContain("context");
	});

	test("ZeroCoreConfigSchema.compression has no `enabled` key", () => {
		const comp = (ZeroCoreConfigSchema.properties as any).compression;
		expect(comp, "compression schema must still exist (live)").toBeDefined();
		const keys = Object.keys(comp.properties);
		expect(keys, "compression.enabled must be deleted (unread fake)").not.toContain("enabled");
	});

	test("ZeroCoreConfigSchema.compression STILL has provider / model / summarySystemPrompt (sub-3b live)", () => {
		const keys = Object.keys((ZeroCoreConfigSchema.properties as any).compression.properties);
		expect(keys).toContain("provider");
		expect(keys).toContain("model");
		expect(keys).toContain("summarySystemPrompt");
	});

	test("DEFAULT_CONFIG has no compaction / context / compression.enabled", () => {
		expect(DEFAULT_CONFIG as any).not.toHaveProperty("compaction");
		expect(DEFAULT_CONFIG as any).not.toHaveProperty("context");
		expect((DEFAULT_CONFIG as any).compression).not.toHaveProperty("enabled");
	});

	test("DEFAULT_CONFIG.compression still carries the live shape (empty = fall-through)", () => {
		expect(DEFAULT_CONFIG.compression).toBeDefined();
		// Empty object is correct: provider/model fall through to the session's
		// working model; summarySystemPrompt falls through to SUMMARY_SYSTEM.
		expect(Object.keys(DEFAULT_CONFIG.compression)).toEqual([]);
	});

	test("MemorySettings.tsx has no `Enable Compression` toggle string", () => {
		const ui = readFileSync(
			join(SRC_DIR, "renderer", "components", "settings", "MemorySettings.tsx"),
			"utf8",
		);
		const stripped = stripComments(ui);
		expect(stripped, "Enable Compression label must be gone").not.toMatch(/Enable Compression/i);
		// And the renderer-side CompressionConfig interface must not carry enabled.
		expect(stripped, "renderer-side `enabled?: boolean` field on CompressionConfig must be gone")
			.not.toMatch(/enabled\?\s*:\s*boolean/);
	});

	test("MemorySettings.tsx STILL uses compression.provider / model (live)", () => {
		const ui = readFileSync(
			join(SRC_DIR, "renderer", "components", "settings", "MemorySettings.tsx"),
			"utf8",
		);
		const stripped = stripComments(ui);
		expect(stripped).toMatch(/\bprovider\b/);
		expect(stripped).toMatch(/\bmodel\b/);
	});

	test("persona PersonaDefinition has no `compaction` field", () => {
		const personaSrc = readFileSync(join(SRC_DIR, "core", "persona.ts"), "utf8");
		const stripped = stripComments(personaSrc);
		// The type literal — a `compaction?:` slot would be live code.
		expect(stripped, "persona.compaction typed slot must be gone").not.toMatch(/\bcompaction\?\s*:/);
	});

	test("preload-types memoryConfigGet signature has no `enabled`", () => {
		const pt = readFileSync(join(SRC_DIR, "shared", "preload-types.ts"), "utf8");
		const stripped = stripComments(pt);
		// Find the memoryConfigGet line and assert enabled is absent from the
		// returned compression shape.
		const lines = stripped.split("\n");
		const cfgLine = lines.find((l) => l.includes("memoryConfigGet"));
		expect(cfgLine, "memoryConfigGet declaration must exist").toBeDefined();
		expect(cfgLine!, "preload-types must not advertise compression.enabled")
			.not.toMatch(/enabled\?\s*:\s*boolean/);
	});
});

// ---------------------------------------------------------------------------
// #5 — steps.compressed 列删 + migration 同步
// ---------------------------------------------------------------------------

describe("[acceptance-5 #5] steps.compressed column dropped + fresh DB boots", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: CoreDatabase;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-sub5-steps-compressed-"));
		dbPath = join(tmpDir, "core.db");
		db = new CoreDatabase(dbPath);
	});

	afterEach(() => {
		try { db.close(); } catch { /* */ }
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
	});

	test("fresh DB boots without error (initSchema idempotent — feedback-fresh-db-migrations)", () => {
		// Construction ran initSchema; reaching this assertion means no throw.
		expect(db).toBeDefined();
		// A second construction on the same path must also succeed (idempotency
		// on re-open — the safeDropColumn path runs every startup).
		const db2 = new CoreDatabase(dbPath);
		expect(db2).toBeDefined();
		db2.close();
	});

	test("fresh DB steps table has NO `compressed` column", () => {
		const cols = ((db as any).db.pragma("table_info(steps)") as Array<{ name: string }>)
			.map((c) => c.name);
		expect(cols, "fresh steps schema must not declare `compressed`").not.toContain("compressed");
		// And the live columns are intact (sanity).
		expect(cols).toContain("session_id");
		expect(cols).toContain("seq");
		expect(cols).toContain("role");
		expect(cols).toContain("content");
	});

	test("safeDropColumn is idempotent — opening an already-clean DB again is a no-op", () => {
		// After the beforeEach construction, the column is already absent.
		// Re-open → safeDropColumn must NOT throw and the schema must be stable.
		const colsBefore = ((db as any).db.pragma("table_info(steps)") as Array<{ name: string }>)
			.map((c) => c.name);
		const db2 = new CoreDatabase(dbPath);
		const colsAfter = ((db2 as any).db.pragma("table_info(steps)") as Array<{ name: string }>)
			.map((c) => c.name);
		expect(colsAfter.sort()).toEqual(colsBefore.sort());
		db2.close();
	});

	test("upgraded DB (with legacy `compressed` column) is migrated: column dropped, data preserved", () => {
		// 1. Seed a session + step through the CoreDatabase API (so FK + all
		//    required NOT NULL columns are satisfied). This row must SURVIVE
		//    the column drop (proves the migration is non-destructive to live
		//    data, even though `compressed` itself never had writers).
		db.ensureSession("s-survive");
		db.appendStep("s-survive", 1, 1, "user", "keep-me");
		const seeded = (db as any).db.prepare(
			"SELECT content FROM steps WHERE session_id = ?",
		).get("s-survive");
		expect(seeded?.content).toBe("keep-me");

		// 2. Close the CoreDatabase and re-open the file RAW (no migration logic).
		//    Simulate a legacy upgraded DB by re-adding the column the
		//    sub-5 migration is supposed to drop.
		db.close();
		db = null as any; // prevent double-close in afterEach
		const Database = require("better-sqlite3");
		const raw = new Database(dbPath);
		raw.exec("ALTER TABLE steps ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0");
		// Mark the seeded row's compressed flag (legacy column now has data —
		// proves the drop doesn't choke on rows that have values in it).
		raw.prepare("UPDATE steps SET compressed = 1 WHERE session_id = ?").run("s-survive");
		const colsBefore = (raw.pragma("table_info(steps)") as Array<{ name: string }>).map((c) => c.name);
		expect(colsBefore, "pre-migration: legacy column present").toContain("compressed");
		raw.close();

		// 3. Re-open through CoreDatabase — the constructor runs initSchema, which
		//    calls safeDropColumn("steps","compressed").
		const dbMigrated = new CoreDatabase(dbPath);
		const colsAfter = ((dbMigrated as any).db.pragma("table_info(steps)") as Array<{ name: string }>)
			.map((c) => c.name);
		expect(colsAfter, "post-migration: safeDropColumn must remove `compressed`").not.toContain("compressed");

		// 4. The seeded row's content survives (data preserved across DROP).
		const row = (dbMigrated as any).db.prepare(
			"SELECT session_id, seq, role, content FROM steps WHERE session_id = ?",
		).get("s-survive");
		expect(row?.content).toBe("keep-me");
		expect(row?.role).toBe("user");

		// 5. Idempotency: opening AGAIN on the now-clean DB is a no-op.
		dbMigrated.close();
		const dbAgain = new CoreDatabase(dbPath);
		const colsFinal = ((dbAgain as any).db.pragma("table_info(steps)") as Array<{ name: string }>)
			.map((c) => c.name);
		expect(colsFinal).not.toContain("compressed");
		dbAgain.close();
	});
});

// ---------------------------------------------------------------------------
// #6 — compression.enabled gone (explicit); provider/model present
// ---------------------------------------------------------------------------

describe("[acceptance-5 #6] compression.enabled deleted; provider/model present", () => {
	test("no live reads of `compression.enabled` anywhere in src", () => {
		// The fake knob had zero live readers, but a regression could re-add one.
		// Match `.compression.enabled` or `compression?.enabled` accesses.
		expectNoLiveCodeRe(
			"compression.enabled live reads",
			/\.compression\??\.enabled\b/g,
		);
	});

	test("no live writes of `compression.enabled` anywhere in src", () => {
		expectNoLiveCodeRe(
			"compression.enabled live writes (enabled: true/false in object literals)",
			/compression\s*:\s*\{[^}]*\benabled\s*:/g,
		);
	});

	test("compression.provider / .model ARE accessed somewhere in live code (UI live surface)", () => {
		// Match both bare-variable access (`compression.provider`) and chained
		// access (`x.compression.provider`, `cfg?.compression?.provider`).
		// `\b` at the start matches the word boundary before `compression`,
		// regardless of whether the preceding char is `.`, `(`, `=`, whitespace.
		const providerRe = /\bcompression\??\.\s*provider\b/g;
		const modelRe = /\bcompression\??\.\s*model\b/g;
		const providerHits = (SRC.all.match(providerRe) ?? []).length;
		const modelHits = (SRC.all.match(modelRe) ?? []).length;
		// Note: the production compression data path (compressSession via
		// compression-trigger-hooks.buildCompressOpts) actually reads
		// `extractors.A.provider/model`, NOT `compression.provider/model` —
		// `compression.provider/model` are read by MemorySettings.tsx for the
		// dropdown display. That's still a live read; we just don't claim the
		// data path uses them (and never has — pre-existing).
		expect(providerHits, "compression.provider must have at least one live access (UI)").toBeGreaterThan(0);
		expect(modelHits, "compression.model must have at least one live access (UI)").toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// #7 — ExtractorB 不受影响
// ---------------------------------------------------------------------------

describe("[acceptance-7 #7] ExtractorB class preserved", () => {
	test("extractor-b-service.ts file still exists", () => {
		expect(existsSync(join(SRC_DIR, "server", "extractor-b-service.ts"))).toBe(true);
	});

	test("ExtractorBService class compiles (import succeeds, class is exported)", async () => {
		const mod = await import("../../src/server/extractor-b-service.js");
		expect(mod.ExtractorBService, "ExtractorBService must be a named export").toBeDefined();
		expect(typeof mod.ExtractorBService, "must be a class constructor").toBe("function");
	});

	test("ExtractorBService is still constructible (smoke — m5-extractors exercises it fully)", async () => {
		// Mirrors the m5-extractors.test.ts makeExtractorB() smoke shape so this
		// test independently fails if the class signature breaks. The full
		// behavioral test (writes telemetry) lives in m5-extractors; we only
		// assert the constructor still accepts its documented dep bag here.
		const mod = await import("../../src/server/extractor-b-service.js");
		const stub = {
			providers: [],
			providerName: "stub",
			modelId: "stub-model",
			telemetry: { recordToolTelemetry: () => {} },
		};
		let inst: any;
		expect(() => { inst = new mod.ExtractorBService(stub); }).not.toThrow();
		expect(inst).toBeDefined();
		expect(typeof inst.extractDelta).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// Adversarial #1 — ExtractorB instantiation status
// ---------------------------------------------------------------------------

describe("[adversarial #1] ExtractorB instantiation status after buildExtractorB wiring removed", () => {
	test("ZERO `new ExtractorBService` in production src (orphan-by-design, decision 49)", () => {
		// The implementer removed server/index.ts's buildExtractorB factory
		// closure because its only consumer was the deleted registerExtractionHooks.
		// After this subtraction, the ExtractorBService class file is preserved
		// (decision 49 — "future standalone trigger may re-attach") but NOTHING
		// in production src constructs it. This test PINS that status so a
		// future regression (either re-adding an orphan instantiation, or
		// re-wiring the factory without re-adding the consumer) is surfaced.
		const re = /new\s+ExtractorBService\b/g;
		const hits: string[] = [];
		for (const [path, blob] of SRC.map) {
			const m = blob.match(re);
			if (m) {
				const rel = path.replace(SRC_DIR + sep, "");
				hits.push(`${rel}: ${m.length}`);
			}
		}
		// Document the design decision in the failure message so a future
		// maintainer knows whether the orphan status is intentional.
		expect(
			hits,
			"Expected ZERO `new ExtractorBService` in production src — the class " +
			"is preserved for future use (design decision 49) but no production " +
			"caller constructs it after sub-5 deleted the buildExtractorB factory. " +
			"If you're seeing this fail, you've either (a) re-added an orphan " +
			"instantiation, or (b) re-wired a real caller — either way, document " +
			"the decision. Found:\n" + hits.join("\n"),
		).toEqual([]);
	});

	test("ExtractorBService is constructed ONLY in tests (m5-extractors)", () => {
		// Cross-check: the test file m5-extractors.test.ts DOES construct it
		// (so the class isn't dead-dead; it's just unused-in-production).
		const testFile = join(REPO_ROOT, "tests", "unit", "m5-extractors.test.ts");
		const src = readFileSync(testFile, "utf8");
		const stripped = stripComments(src);
		const hits = (stripped.match(/new\s+ExtractorBService\b/g) ?? []).length;
		expect(hits, "m5-extractors.test.ts must still exercise ExtractorB (sub-5 keeps the class)").toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Adversarial #4 — net subtraction sanity (git diff --shortstat)
// ---------------------------------------------------------------------------

describe("[adversarial #4] net subtraction sanity", () => {
	test("deletions >> insertions (pure-subtraction shape)", () => {
		// git diff --shortstat HEAD (uncommitted = sub-5's working changes).
		// Shape: "X files changed, N insertions(+), M deletions(-)".
		const out = execSync("git diff --shortstat", { cwd: REPO_ROOT }).toString().trim();
		expect(out, "git diff --shortstat must produce output").toMatch(/insertions|deletions/);

		// Parse "<n> insertion(s)(+)" and "<m> deletion(s)(-)".
		const insMatch = out.match(/(\d+)\s+insertion/);
		const delMatch = out.match(/(\d+)\s+deletion/);
		const ins = insMatch ? parseInt(insMatch[1], 10) : 0;
		const del = delMatch ? parseInt(delMatch[1], 10) : 0;

		// Sanity floor: the sub touched many files (deletions of 4 source files
		// + ~20 modified). Pure subtraction ⇒ del >> ins.
		expect(del, `deletions must be substantial (>= 1000 for this sub); got: ${out}`).toBeGreaterThanOrEqual(1000);
		// 3x is a lenient floor — the real ratio is ~8x (1853/223 at writing).
		expect(del, `deletions must outnumber insertions ≥ 3x (pure subtraction); got: ${out}`).toBeGreaterThan(ins * 3);
	});
});
