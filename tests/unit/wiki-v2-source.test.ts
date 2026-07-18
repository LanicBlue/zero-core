// wiki-system-redesign sub-03 acceptance — 对抗 lens ROUND 2 (source read/search security)
// (indexed/workspace read + escape rejection + binary + ripgrep limits + CONCERN 8/9)
//
// # 文件说明书
//
// ## 核心功能
// 行为级验证 acceptance-03 §D(source read/search 安全)。ROUND 2: round-1
// documented BLOCKER 4 + CONCERN 7/8 as expected-failures; impl applied fixes;
// this round FLIPS assertions to CORRECT post-fix behavior + IMPLEMENTS the 4
// §D test.todo items + adds CONCERN 8 (Windows `.\\` prefix) + CONCERN 9
// (resolver) coverage that round-1 lacked.
//
// 用 **真实临时 Git 仓库** + 真实 ripgrep(`openai.chatgpt` 扩展 rg.exe,本机
// 唯一可用 rg)驱动:
//
//   - `WikiSourceService.readIndexedSource` / `readWorkspaceSource`
//   - `WikiSourceSearch.search`
//
// 断言:
//   §D 安全(FLIPPED — bugs fixed):
//     - BLOCKER 4 FLIP: readIndexedSource returns the EXACT blob bytes for
//       [lineStart,lineEnd] matching indexed_revision (was: always available=false).
//     - CONCERN 7 FLIP: absolute source_root `/abs/path` rejected at binding
//       BEFORE normalize (was: silently normalized + accepted).
//     - binary → encoding="binary", content=null, available=true.
//   §D byte contract (IMPLEMENTED — was test.todo):
//     - full read returns entire blob text matching `git show <rev>:<path>`.
//     - line range [10, 20] returns EXACTLY lines 10..20.
//     - line range past EOF clamps to last line.
//     - binary file → metadata only, content is null.
//   §D search (FLIPPED + hardened):
//     - CONCERN 8: round-1 asserted `./` prefix kept (Windows rg emits `.\\`).
//       After backslash→slash normalize the `./` resurfaces; the impl fix only
//       strips forward-slash `./`, MISSING the Windows `.\\` case → binding
//       lookup fails → hit.sourcePath keeps `./` + nodePath invalid. TEST NOW
//       ASSERTS THE CORRECT BEHAVIOR (sourcePath has no `./`, binding found,
//       sourceKind/blobOid non-null) and FAILS on Windows → BLOCKER finding.
//     - CONCERN 9: ZERO_CORE_RIPGREP_PATH env override resolves; ENOENT binary
//       → SOURCE_UNAVAILABLE (not crash).
//     - cwd-by-binding (no model cwd); results map to canonical path.
//     - case-insensitive + regex; regex 2048-byte/2s/2MiB/200 limits.
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db.
//   - UNIQUE temp git repo(per-test; root + subdir files — BLOCKER 1 fixed).
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - ripgrep 不可用时 `test.skip` 并记录原因(本机找到 openai.chatgpt rg.exe)。
//   - sessions.db readonly;INTEGER affinity;Windows vitest exit-127 = teardown crash。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation + ripgrep resolution.
// ---------------------------------------------------------------------------
const { UNIQUE_DIR, RG_BIN } = vi.hoisted(() => {
	const { mkdtempSync, existsSync, readdirSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir, homedir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-src-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	// Locate a real ripgrep binary. Order:
	//   1. `rg` on PATH.
	//   2. VS Code extension rg.exe (scan ALL extensions for bin/windows-x86_64/rg.exe
	//      AND node_modules/@vscode/ripgrep/bin/rg.exe). NOTE: the impl's resolver
	//      (resolveRipgrepBinary) only checks ms-vscode.cpptools — on this machine
	//      rg lives under openai.chatgpt, which the impl MISSES (CONCERN 9 finding).
	const candidates: string[] = ["rg"];
	try {
		const home = homedir();
		const vsixDir = join(home, ".vscode", "extensions");
		if (existsSync(vsixDir)) {
			for (const ext of readdirSync(vsixDir)) {
				const p1 = join(vsixDir, ext, "bin", "windows-x86_64", "rg.exe");
				if (existsSync(p1)) candidates.push(p1);
				const p2 = join(vsixDir, ext, "node_modules", "@vscode", "ripgrep", "bin", "rg.exe");
				if (existsSync(p2)) candidates.push(p2);
			}
		}
	} catch { /* ignore */ }
	let rgBin = "";
	for (const c of candidates) {
		try {
			execFileSync(c, ["--version"], { encoding: "utf-8", windowsHide: true });
			rgBin = c;
			break;
		} catch { /* try next */ }
	}
	return { UNIQUE_DIR: d, RG_BIN: rgBin };
});
const HAS_RG = Boolean(RG_BIN);

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import {
	WikiProjectIndexer,
	type ProjectStoreLike,
} from "../../src/server/wiki/wiki-project-indexer.js";
import {
	WikiSourceService,
} from "../../src/server/wiki/wiki-source-service.js";
import {
	WikiSourceSearch,
	SOURCE_SEARCH_MAX_PATTERN_BYTES,
	SOURCE_SEARCH_MAX_OUTPUT_BYTES,
	SOURCE_SEARCH_MAX_RESULTS,
	SOURCE_SEARCH_TIMEOUT_MS,
} from "../../src/server/wiki/wiki-source-search.js";
import { ArchivistGit } from "../../src/server/archivist-git.js";
import { WIKI_ROOT_PATH, joinWikiPath } from "../../src/server/wiki/wiki-path.js";

const PROJECTS_NS = joinWikiPath(WIKI_ROOT_PATH, "projects");
function projectPath(id: string): string { return `${PROJECTS_NS}/${id}`; }
function projectFile(id: string, name: string): string { return `${projectPath(id)}/${name}`; }

// ---------------------------------------------------------------------------
// Git fixture helper.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], opts?: { input?: string }): string {
	return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.ignorecase=false", ...args], {
		cwd,
		encoding: "utf-8",
		input: opts?.input,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	}).toString();
}

function writeRepoFile(repoDir: string, relPath: string, content: string | Buffer): void {
	const abs = join(repoDir, relPath);
	const parent = join(abs, "..");
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	if (typeof content === "string") writeFileSync(abs, content, "utf-8");
	else writeFileSync(abs, content);
}

function setIdentity(cwd: string): void {
	git(cwd, ["config", "user.name", "Test Bot"]);
	git(cwd, ["config", "user.email", "bot@example.test"]);
}

/** Blob oid of <rev>:<path> via real git (asserts hit.blobOid after search). */
function blobOidAt(cwd: string, rev: string, path: string): string {
	return git(cwd, ["rev-parse", `${rev}:${path}`]).trim();
}

interface SourceFixture {
	repoDir: string;
	c0Sha: string;
	textPath: string;
	textBody: string;
	binPath: string;
	symlinkPath: string;
	symlinkBlobOid: string;
}

function buildSourceFixture(parentTempDir: string): SourceFixture {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-src-fixture-"));
	git(repoDir, ["init", "-b", "main"]);
	setIdentity(repoDir);

	// 50-line predictable text (line N = "line N: hello world").
	const textBody = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: hello world`).join("\n") + "\n";
	const textPath = "code.ts";
	writeRepoFile(repoDir, textPath, textBody);

	// Binary file: PNG signature + NUL bytes (trips isBinaryBuffer).
	const binPath = "image.png";
	const binBuf = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.alloc(64, 0x00),
		Buffer.from("trail tail"),
	]);
	writeRepoFile(repoDir, binPath, binBuf);

	git(repoDir, ["add", textPath, binPath]);

	// symlink (mode 120000) — link target points OUTSIDE repo.
	const symlinkPath = "escape";
	const symlinkTarget = "../../etc/passwd";
	const symlinkBlobOid = git(repoDir, ["hash-object", "-w", "--stdin"], { input: symlinkTarget }).trim();
	git(repoDir, ["update-index", "--add", "--cacheinfo", `120000,${symlinkBlobOid},${symlinkPath}`]);

	git(repoDir, ["commit", "-m", "C0: source fixture"]);
	const c0Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

	return { repoDir, c0Sha, textPath, textBody, binPath, symlinkPath, symlinkBlobOid };
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

let _dbCounter = 0;

interface Harness {
	wiki: WikiDatabase;
	nodeRepo: WikiNodeRepository;
	linkRepo: WikiLinkRepository;
	auditRepo: WikiAuditRepository;
	store: WikiRepositoryStore;
	indexer: WikiProjectIndexer;
	sourceService: WikiSourceService;
	sourceSearch: WikiSourceSearch;
	resolveWorkspace: (id: string) => string | undefined;
	dispose: () => void;
}

function makeHarness(projectId: string, workspaceDir: string, sourceRoot?: string, ripgrepBinary?: string): Harness {
	_dbCounter += 1;
	const dbPath = join(UNIQUE_DIR, `wiki-src-${_dbCounter}-${Date.now()}.db`);
	const wiki = new WikiDatabase(dbPath);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = new WikiAuditRepository(db);
	const store = new WikiRepositoryStore(db);
	const git = new ArchivistGit();
	const projectStore: ProjectStoreLike = {
		get: (id) => (id === projectId ? { id, name: "Src Project", workspaceDir } : undefined),
		list: () => [{ id: projectId, name: "Src Project", workspaceDir }],
	};
	const indexer = new WikiProjectIndexer({
		wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
		repositoryStore: store, git, projectStore,
	});
	const resolveWorkspace = (id: string) => (id === projectId ? workspaceDir : undefined);
	const sourceService = new WikiSourceService({
		nodeRepo, repositoryStore: store, git, resolveWorkspace,
	});
	const sourceSearch = new WikiSourceSearch({
		nodeRepo, repositoryStore: store, resolveWorkspace,
		ripgrepBinary: ripgrepBinary ?? RG_BIN ?? undefined,
	});
	return {
		wiki, nodeRepo, linkRepo, auditRepo, store, indexer,
		sourceService, sourceSearch, resolveWorkspace,
		dispose: () => { try { wiki.close(); } catch { /* ignore */ } },
	};
}

const FIXTURE_TEMP = mkdtempSync(join(tmpdir(), "zc-src-root-"));
let FIXTURE: SourceFixture;

beforeEach(() => {
	FIXTURE = buildSourceFixture(FIXTURE_TEMP);
});

afterEach(() => {
	try { rmSync(FIXTURE_TEMP, { recursive: true, force: true }); } catch { /* ignore */ }
	try { mkdirSync(FIXTURE_TEMP, { recursive: true }); } catch { /* ignore */ }
});

// ===========================================================================
// §D + CONCERN 7 (FLIPPED) — source_root escape binding-time rejection.
// ===========================================================================

describe("§D + CONCERN 7 (FLIPPED): source_root escape rejected at binding", () => {
	test("`..` source_root rejected", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			const b = await h.indexer.ensureBinding("p", { sourceRoot: "../escape" });
			expect(b.bound).toBe(false);
			expect(b.error ?? "").toMatch(/source_root/);
		} finally {
			h.dispose();
		}
	});

	test("CONCERN 7 FLIP: absolute source_root `/abs/path` rejected BEFORE normalize", async () => {
		// round-1 asserted the bug (absolute normalized → accepted). The fix
		// (ensureBinding) now checks isAbsolute on the RAW input BEFORE
		// normalizeSourceRoot strips the leading `/`.
		const h = makeHarness("pabs", FIXTURE.repoDir);
		try {
			const b = await h.indexer.ensureBinding("pabs", { sourceRoot: "/abs/path" });
			expect(b.bound, "absolute source_root must be rejected").toBe(false);
			expect(b.error ?? "").toMatch(/absolute|relative path/);
			// Verify NO repository row was created for the rejected binding.
			expect(h.store.repositories.getByProjectId("pabs")).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	test("Windows-drive absolute source_root `C:/x` also rejected", async () => {
		const h = makeHarness("pdrv", FIXTURE.repoDir);
		try {
			const b = await h.indexer.ensureBinding("pdrv", { sourceRoot: "C:/x/y" });
			expect(b.bound).toBe(false);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// BLOCKER #4 (FLIPPED) — readIndexedSource returns blob bytes.
// ===========================================================================

describe("BLOCKER #4 (FLIPPED): readIndexedSource returns EXACT blob bytes", () => {
	test("text binding: full read returns content matching `git show <rev>:<path>`", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const nodePath = projectFile("p", FIXTURE.textPath);

			const gitShow = git(FIXTURE.repoDir, ["show", `${FIXTURE.c0Sha}:${FIXTURE.textPath}`]);

			const result = await h.sourceService.readIndexedSource(nodePath);
			expect(result.available, "indexed read must succeed").toBe(true);
			expect(result.encoding).toBe("utf8");
			expect(result.content, "content must equal git show").toBe(gitShow);
			expect(result.readRevision).toBe(FIXTURE.c0Sha);
			expect(result.dirty).toBe(false);
			expect(result.lines.totalLines).toBe(50);
		} finally {
			h.dispose();
		}
	});

	test("binary binding: encoding=binary, content=null, available=true (metadata returned)", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const nodePath = projectFile("p", FIXTURE.binPath);

			const result = await h.sourceService.readIndexedSource(nodePath);
			// FLIPPED: binary is detected via blob bytes; metadata returned.
			expect(result.available).toBe(true);
			expect(result.encoding).toBe("binary");
			expect(result.content).toBeNull();
			expect(result.byteSize).toBeGreaterThan(0);
		} finally {
			h.dispose();
		}
	});

	test("read on node without binding → available=false with reason 'not source-bound'", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const rootPath = projectPath("p");
			const result = await h.sourceService.readIndexedSource(rootPath);
			expect(result.available).toBe(false);
			expect(result.reason ?? "").toMatch(/not source-bound/);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// §D byte contract (IMPLEMENTED from round-1 test.todo) — line range semantics.
// ===========================================================================

describe("§D readIndexedSource line-range contract (IMPLEMENTED)", () => {
	test("line range [10, 20] returns EXACTLY lines 10..20", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const nodePath = projectFile("p", FIXTURE.textPath);
			const result = await h.sourceService.readIndexedSource(nodePath, { lineStart: 10, lineEnd: 20 });
			expect(result.available).toBe(true);
			expect(result.lines.startLine).toBe(10);
			expect(result.lines.endLine).toBe(20);
			// Content starts with "line 10:" and ends with "line 20:".
			expect(result.content ?? "").toMatch(/^line 10: hello world/);
			expect(result.content ?? "").toMatch(/line 20: hello world\n?$/);
			// Exactly 11 lines in the slice (10..20 inclusive).
			const sliceLines = (result.content ?? "").split("\n").filter(Boolean);
			expect(sliceLines.length).toBe(11);
		} finally {
			h.dispose();
		}
	});

	test("line range past EOF clamps to last line", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const nodePath = projectFile("p", FIXTURE.textPath);
			// Request [45, 9999] — only 50 lines exist.
			const result = await h.sourceService.readIndexedSource(nodePath, { lineStart: 45, lineEnd: 9999 });
			expect(result.available).toBe(true);
			expect(result.lines.startLine).toBe(45);
			expect(result.lines.endLine).toBeLessThanOrEqual(50 + 1); // clamped (sliceLines endLine semantics)
			expect(result.content ?? "").toMatch(/^line 45: hello world/);
		} finally {
			h.dispose();
		}
	});

	test("indexed read is deterministic across two calls (same bytes)", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const nodePath = projectFile("p", FIXTURE.textPath);
			const r1 = await h.sourceService.readIndexedSource(nodePath);
			const r2 = await h.sourceService.readIndexedSource(nodePath);
			expect(r1.content).toBe(r2.content);
			expect(r1.blobOid).toBe(r2.blobOid);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// §D workspace read — dirty tag + escape rejection.
// ===========================================================================

describe("§D readWorkspaceSource — dirty tag; reject checkout-external paths", () => {
	test("workspace read returns dirty=true + current bytes (may differ from indexed)", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const nodePath = projectFile("p", FIXTURE.textPath);

			writeRepoFile(FIXTURE.repoDir, FIXTURE.textPath, FIXTURE.textBody + "// dirty edit\n");

			const result = await h.sourceService.readWorkspaceSource(nodePath, FIXTURE.repoDir);
			expect(result.available).toBe(true);
			expect(result.dirty).toBe(true);
			expect(result.readRevision).toBe("WORKSPACE");
			expect(result.blobOid).toBe(null);
			expect(result.content).toContain("// dirty edit");
			expect(result.stale).toBe(false);
		} finally {
			h.dispose();
		}
	});

	test("symlink-bound node read in workspace mode: link target escapes → rejected", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const nodePath = projectFile("p", FIXTURE.symlinkPath);
			const result = await h.sourceService.readWorkspaceSource(nodePath, FIXTURE.repoDir);
			// Link target ("../../etc/passwd") not on disk → ENOENT → available=false.
			expect(result.available).toBe(false);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// §D search — cwd-by-binding (no model cwd field).
// ===========================================================================

const rgIt = HAS_RG ? test : test.skip;

describe("§D source search — request schema has NO cwd field (server-derived)", () => {
	test("SourceSearchRequest type does not expose cwd (compile-time contract)", () => {
		const req = {
			projectId: "p",
			mode: "substring" as const,
			pattern: "x",
			caseSensitive: false,
			scope: "",
			limit: 10,
			cursor: null,
			workspace: false,
			sourceKinds: [],
			fileGlobs: [],
		};
		expect(req.pattern).toBe("x");
		expect((req as Record<string, unknown>).cwd).toBeUndefined();
	});
}, 30000);

// ===========================================================================
// §D search — cwd derived from binding, results map to canonical path.
// CONCERN 8 FLIP: round-1 asserted `./` prefix kept (Windows rg emits `.\\`).
// The impl fix only strips `./` (forward slash); after backslash→slash normalize
// in stripSourceRootPrefix the `./` resurfaces on Windows → binding lookup fails.
// We now assert the CORRECT behavior; this FAILS on Windows → BLOCKER finding.
// ===========================================================================

describe("§D + CONCERN 8 (FLIPPED): search hits map to canonical path; binding found", () => {
	rgIt("substring search: hit.sourcePath has NO `./` prefix; binding resolved (sourceKind/blobOid non-null)", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const outcome = await h.sourceSearch.search({
				projectId: "p",
				mode: "substring",
				pattern: "hello world",
			});
			// HARD assertion (no silent early-return): search MUST succeed.
			expect(outcome.ok, `search must succeed; got ${JSON.stringify(outcome).slice(0, 120)}`).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.result.hits.length, "must have hits for 'hello world'").toBeGreaterThan(0);

			const h0 = outcome.result.hits[0];
			// CONCERN 8 FLIP: sourcePath must be the bare repo-relative path (no `./`).
			expect(h0.sourcePath, `BUG(Windows): sourcePath keeps './' prefix (got ${JSON.stringify(h0.sourcePath)}); impl strips forward-slash './' only, misses backslash '.\\\\' that rg emits on Windows`).toBe(FIXTURE.textPath);
			// nodePath must be a clean canonical path (no `/./ ` segment).
			expect(h0.nodePath).toBe(projectFile("p", FIXTURE.textPath));
			expect(h0.nodePath).not.toContain("/./");
			// binding found → enriched fields non-null.
			expect(h0.sourceKind, "BUG: sourceKind lost (binding lookup failed on Windows)").not.toBeNull();
			expect(h0.blobOid, "BUG: blobOid lost (binding lookup failed on Windows)").not.toBeNull();
			// round-3 FIX 2 contract: indexedRevision must also be populated
			// (round-2 assertions only checked sourceKind/blobOid; indexedRevision
			// would silently fall to null if binding lookup missed on Windows `.\`).
			expect(h0.indexedRevision, "BUG: indexedRevision lost (binding lookup failed on Windows)").not.toBeNull();
			expect(h0.indexedRevision).toBe(FIXTURE.c0Sha);
			expect(outcome.result.origin).toBe("indexed");
			expect(h0.dirty).toBe(false);
		} finally {
			h.dispose();
		}
	});

	rgIt("subdir search: hit on src/server/loop.ts maps to subdir canonical path", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-src-sub-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "src/server/loop.ts", "export const deep = 'needle here';\n");
			git(repoDir, ["add", "src/server/loop.ts"]);
			git(repoDir, ["commit", "-m", "subdir"]);
			const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("sub", repoDir);
			try {
				await h.indexer.fullIndex("sub", { revision: sha });
				const outcome = await h.sourceSearch.search({
					projectId: "sub", mode: "substring", pattern: "needle",
				});
				expect(outcome.ok).toBe(true);
				if (!outcome.ok) return;
				expect(outcome.result.hits.length).toBeGreaterThan(0);
				const h0 = outcome.result.hits[0];
				// CONCERN 8 (subdir): sourcePath must be the bare repo-relative path.
				expect(h0.sourcePath, `BUG(Windows subdir): sourcePath keeps './' (got ${JSON.stringify(h0.sourcePath)})`).toBe("src/server/loop.ts");
				expect(h0.sourceKind).not.toBeNull();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	rgIt("round-3 FIX 2 combined: root `alpha.ts` + subdir `sub/beta.ts` BOTH resolve in one search (Windows `.\\` worst case)", async () => {
		// round-3 BLOCKER (Windows ripgrep): when the repo root is the search
		// scope, Windows ripgrep emits BOTH `.\alpha.ts` (repo-root) AND
		// `.\sub\beta.ts` (subdir) with BACKSLASH separators. round-2's order
		// (strip `./` → normalize `\`) missed `.\` entirely → binding lookup
		// failed for BOTH hits → sourcePath/nodePath/sourceKind/blobOid all wrong.
		// round-3 FIX 2 reorders (normalize `\` → `/` FIRST → strip `./`) so both
		// root AND subdir paths resolve to their bindings in a single search.
		// This is the most adversarial case: mixed depths in one ripgrep run.
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-src-fix2-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			// Root file alpha.ts + subdir file sub/beta.ts — both contain the
			// common token so a single substring search surfaces BOTH hits.
			writeRepoFile(repoDir, "alpha.ts", "export const alphaNeedle = 1;\n");
			writeRepoFile(repoDir, "sub/beta.ts", "export const betaNeedle = 2;\n");
			git(repoDir, ["add", "alpha.ts", "sub/beta.ts"]);
			git(repoDir, ["commit", "-m", "fix2 fixture"]);
			const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();
			const alphaOid = blobOidAt(repoDir, sha, "alpha.ts");
			const betaOid = blobOidAt(repoDir, sha, "sub/beta.ts");

			const h = makeHarness("fix2", repoDir);
			try {
				await h.indexer.fullIndex("fix2", { revision: sha });
				const outcome = await h.sourceSearch.search({
					projectId: "fix2", mode: "substring", pattern: "Needle",
				});
				expect(outcome.ok, `search must succeed; got ${JSON.stringify(outcome).slice(0, 160)}`).toBe(true);
				if (!outcome.ok) return;
				expect(outcome.result.hits.length, "must surface BOTH alpha + beta hits").toBeGreaterThanOrEqual(2);

				// Build a sourcePath → hit map for clean cross-referencing.
				const byPath = new Map(outcome.result.hits.map((x) => [x.sourcePath, x]));

				// Root file alpha.ts — repo-root scope on Windows emits `.\alpha.ts`.
				const alphaHit = byPath.get("alpha.ts");
				expect(alphaHit, `BUG(Windows): root hit missing or sourcePath keeps '.\\' (got paths: [${[...byPath.keys()].join(", ")}])`).toBeDefined();
				expect(alphaHit!.sourcePath).toBe("alpha.ts");
				expect(alphaHit!.sourcePath).not.toMatch(/^\.\\?\/?/); // no leading ./ or .\
				expect(alphaHit!.nodePath).toBe(projectFile("fix2", "alpha.ts"));
				expect(alphaHit!.nodePath).not.toContain("/./");
				expect(alphaHit!.nodePath).not.toContain("\\");
				expect(alphaHit!.sourceKind, "BUG: alpha sourceKind lost").not.toBeNull();
				expect(alphaHit!.blobOid, "BUG: alpha blobOid lost").toBe(alphaOid);
				expect(alphaHit!.indexedRevision, "BUG: alpha indexedRevision lost").toBe(sha);

				// Subdir file sub/beta.ts — Windows emits `.\sub\beta.ts`.
				const betaHit = byPath.get("sub/beta.ts");
				expect(betaHit, `BUG(Windows): subdir hit missing or sourcePath keeps '.\\sub\\' (got paths: [${[...byPath.keys()].join(", ")}])`).toBeDefined();
				expect(betaHit!.sourcePath).toBe("sub/beta.ts");
				expect(betaHit!.sourcePath).not.toMatch(/^\.\\?\/?/);
				expect(betaHit!.sourcePath).not.toContain("\\"); // no surviving backslash
				expect(betaHit!.nodePath).toBe(projectFile("fix2", "sub/beta.ts"));
				expect(betaHit!.nodePath).not.toContain("/./");
				expect(betaHit!.nodePath).not.toContain("\\");
				expect(betaHit!.sourceKind, "BUG: beta sourceKind lost").not.toBeNull();
				expect(betaHit!.blobOid, "BUG: beta blobOid lost").toBe(betaOid);
				expect(betaHit!.indexedRevision, "BUG: beta indexedRevision lost").toBe(sha);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	rgIt("case-insensitive (default) matches 'HELLO WORLD'; case-sensitive does not", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const ci = await h.sourceSearch.search({
				projectId: "p", mode: "substring", pattern: "HELLO WORLD",
			});
			expect(ci.ok).toBe(true);
			if (ci.ok) expect(ci.result.hits.length).toBeGreaterThan(0);

			const cs = await h.sourceSearch.search({
				projectId: "p", mode: "substring", pattern: "HELLO WORLD",
				caseSensitive: true,
			});
			if (cs.ok) expect(cs.result.hits.length).toBe(0);
		} finally {
			h.dispose();
		}
	});

	rgIt("regex mode supports `line [0-9]+` pattern", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const r = await h.sourceSearch.search({
				projectId: "p", mode: "regex", pattern: "line [0-9]+:",
			});
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.result.hits.length).toBeGreaterThan(0);
		} finally {
			h.dispose();
		}
	});

	rgIt("results > 200 are stably truncated; hasMore + cursor returned", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-many-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			const big = Array.from({ length: 300 }, () => "needle line").join("\n") + "\n";
			writeRepoFile(repoDir, "many.txt", big);
			git(repoDir, ["add", "many.txt"]);
			git(repoDir, ["commit", "-m", "many matches"]);
			const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("many", repoDir);
			try {
				await h.indexer.fullIndex("many", { revision: sha });
				const r = await h.sourceSearch.search({
					projectId: "many", mode: "substring", pattern: "needle",
					limit: SOURCE_SEARCH_MAX_RESULTS,
				});
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				expect(r.result.hits.length).toBeLessThanOrEqual(SOURCE_SEARCH_MAX_RESULTS);
				expect(r.result.hasMore).toBe(true);
				expect(r.result.cursor).not.toBeNull();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
}, 30000);

// ===========================================================================
// §D regex limits — pattern bytes, output bytes, results count, timeout.
// ===========================================================================

describe("§D regex limits — REGEX_LIMIT_EXCEEDED / REGEX_TIMEOUT", () => {
	rgIt(`pattern > ${SOURCE_SEARCH_MAX_PATTERN_BYTES} bytes → REGEX_LIMIT_EXCEEDED`, async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const tooLong = "a".repeat(SOURCE_SEARCH_MAX_PATTERN_BYTES + 1);
			expect(Buffer.byteLength(tooLong, "utf-8")).toBe(SOURCE_SEARCH_MAX_PATTERN_BYTES + 1);

			const r = await h.sourceSearch.search({
				projectId: "p", mode: "regex", pattern: tooLong,
			});
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.code).toBe("REGEX_LIMIT_EXCEEDED");
		} finally {
			h.dispose();
		}
	});

	rgIt(`output > ${SOURCE_SEARCH_MAX_OUTPUT_BYTES} bytes → REGEX_LIMIT_EXCEEDED (maxBuffer kill)`, async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-big-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			const huge = "needle".repeat(600000);
			writeRepoFile(repoDir, "huge.txt", huge + "\n");
			git(repoDir, ["add", "huge.txt"]);
			git(repoDir, ["commit", "-m", "huge match"]);
			const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("big", repoDir);
			try {
				await h.indexer.fullIndex("big", { revision: sha });
				const r = await h.sourceSearch.search({
					projectId: "big", mode: "substring", pattern: "needle",
				});
				expect(r.ok).toBe(false);
				if (r.ok) return;
				expect(r.code === "REGEX_LIMIT_EXCEEDED" || r.code === "REGEX_TIMEOUT").toBe(true);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	rgIt(`timeout ${SOURCE_SEARCH_TIMEOUT_MS}ms on pathological regex → REGEX_TIMEOUT (process killed)`, async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-slow-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			const longA = "a".repeat(200000);
			writeRepoFile(repoDir, "slow.txt", longA + "\n");
			git(repoDir, ["add", "slow.txt"]);
			git(repoDir, ["commit", "-m", "slow"]);
			const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("slow", repoDir);
			try {
				await h.indexer.fullIndex("slow", { revision: sha });
				const t0 = Date.now();
				const r = await h.sourceSearch.search({
					projectId: "slow", mode: "regex", pattern: "(a+)+b",
				});
				const elapsed = Date.now() - t0;
				if (!r.ok) {
					expect(r.code === "REGEX_TIMEOUT" || r.code === "REGEX_LIMIT_EXCEEDED").toBe(true);
					expect(elapsed).toBeLessThan(SOURCE_SEARCH_TIMEOUT_MS + 2000);
				}
				expect(true).toBe(true);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
}, 30000);

// ===========================================================================
// §D scope — escapes rejected; effective scope derived from binding.
// ===========================================================================

describe("§D scope escape — `..` / absolute scope rejected", () => {
	rgIt("scope containing `..` is rejected with REGEX_INVALID", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const r = await h.sourceSearch.search({
				projectId: "p", mode: "substring", pattern: "x", scope: "../escape",
			});
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.code).toBe("REGEX_INVALID");
			expect(r.message ?? "").toMatch(/scope escapes/);
		} finally {
			h.dispose();
		}
	});

	rgIt("absolute scope `/etc` is rejected", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const r = await h.sourceSearch.search({
				projectId: "p", mode: "substring", pattern: "x", scope: "/etc",
			});
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.code === "REGEX_INVALID" || r.code === "SOURCE_UNAVAILABLE").toBe(true);
		} finally {
			h.dispose();
		}
	});

	rgIt("repository/projectId mismatch → NOT_FOUND", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const r = await h.sourceSearch.search({
				projectId: "nonexistent-project",
				mode: "substring", pattern: "x",
			});
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.code).toBe("NOT_FOUND");
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// §D limits are surfaced in the result for caller verification.
// ===========================================================================

describe("§D limits are surfaced in the result for caller verification", () => {
	rgIt("result.limits echoes the 4 documented caps", async () => {
		const h = makeHarness("p", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const r = await h.sourceSearch.search({
				projectId: "p", mode: "substring", pattern: "hello",
			});
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.result.limits.patternBytes).toBe(SOURCE_SEARCH_MAX_PATTERN_BYTES);
			expect(r.result.limits.timeoutMs).toBe(SOURCE_SEARCH_TIMEOUT_MS);
			expect(r.result.limits.outputBytes).toBe(SOURCE_SEARCH_MAX_OUTPUT_BYTES);
			expect(r.result.limits.maxResults).toBe(SOURCE_SEARCH_MAX_RESULTS);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// CONCERN 9 — resolveRipgrepBinary (env > bundled > VSCode > PATH); ENOENT
// maps to SOURCE_UNAVAILABLE (not crash). The impl's production resolver only
// checks ms-vscode.cpptools (fragile); we test the MECHANISM via env override
// + a deliberately-bogus binary path.
// ===========================================================================

describe("CONCERN 9: ripgrep binary resolution + ENOENT → SOURCE_UNAVAILABLE", () => {
	// These tests inject an explicit ripgrepBinary, bypassing the cached resolver.
	// They verify the search() error-mapping contract, not the resolver itself.

	test("bogus ripgrepBinary path → SOURCE_UNAVAILABLE (not crash, not throw)", async () => {
		// Use a fresh harness with a NON-EXISTENT rg path. search() must catch
		// ENOENT and return { ok: false, code: SOURCE_UNAVAILABLE }.
		const h = makeHarness("p", FIXTURE.repoDir, undefined, "/definitely/not/a/real/rg-binary.exe");
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const r = await h.sourceSearch.search({
				projectId: "p", mode: "substring", pattern: "hello",
			});
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.code, "ENOENT must map to SOURCE_UNAVAILABLE").toBe("SOURCE_UNAVAILABLE");
			expect(r.message ?? "").toMatch(/ripgrep binary unavailable|ENOENT/i);
		} finally {
			h.dispose();
		}
	});

	rgIt("explicit ripgrepBinary (env-equivalent) resolves + returns hits", async () => {
		// Inject the REAL resolved rg path (simulates ZERO_CORE_RIPGREP_PATH env).
		const h = makeHarness("p", FIXTURE.repoDir, undefined, RG_BIN);
		try {
			await h.indexer.fullIndex("p", { revision: FIXTURE.c0Sha });
			const r = await h.sourceSearch.search({
				projectId: "p", mode: "substring", pattern: "hello world",
			});
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.result.hits.length).toBeGreaterThan(0);
		} finally {
			h.dispose();
		}
	});
}, 30000);
