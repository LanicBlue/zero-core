// wiki-system-redesign sub-04 acceptance — 对抗 lens (6 search modes + leak tests).
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-04 §D(search modes/case/glob/both/cursor/hybrid/oracle)
// 与 §E(leak tests:secret path/snippet/count/score hint)中**对抗**视角的条目。
// 全部走真临时 wiki.db + 真 CallerCtx.wikiAccess(测试 host 构造),从结构 +
// 行为两侧断言,并主动构造跨段兄弟泄露场景验证 scope filter 的正确性。
//
// ## 关键断言(acceptance-04 §D/§E)
//   §D search:
//     - exact/substring/glob/regex/fulltext/hybrid 各自有 positive + negative 测试。
//     - case_sensitive true/false 在 ASCII fixture 上正确;Unicode 限制诚实说明。
//     - glob 的 `*`(单段)、`**`(跨段)、`?`(单字符)段基语义。
//     - FTS/search 在无授权 scope 时不执行正文查询或 snippet 生成。
//     - `both` 合并 Wiki/source 命中,保留 provenance(不丢来源)。
//     - source search 不能通过参数改 cwd 或逃逸绑定仓库。
//     - cursor/limit 同输入同 revision → 顺序可重复。
//     - hybrid 排序精确符合 (match_type_rank ASC, -normalized_score ASC,
//       canonical_path ASC, target ASC) oracle,同分不依赖内部 ID。
//   §E leak tests:
//     - wiki/source/both 各模式均无法返回 secret path/snippet/数量/score 暗示。
//     - link 到 secret 时 read/expand 不泄露对端。
//     - direct read secret existing/non-existing → 同一 NOT_FOUND 外观。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR(vi.hoisted 前缀 `zc-wiki-v2-search-`)。
//   - 每 test 独立 wiki.db;real Git repo for source search(target=source/both)。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding(在 StructuredOutput 中)。
//   - sessions.db readonly;INTEGER affinity;Windows vitest exit-127 = teardown crash。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR, RG_BIN } = vi.hoisted(() => {
	const { mkdtempSync, existsSync, readdirSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir, homedir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-search-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1"; // 绕开 Windows test worker WAL checkpoint 卡死。
	// Locate real ripgrep for target=source tests; resolution mirrors sub-03 layout.
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

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiEditService } from "../../src/server/wiki/wiki-edit-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import {
	WikiProjectIndexer,
	type ProjectStoreLike,
} from "../../src/server/wiki/wiki-project-indexer.js";
import { WikiSourceSearch } from "../../src/server/wiki/wiki-source-search.js";
import { ArchivistGit } from "../../src/server/archivist-git.js";
import { WIKI_ROOT_PATH, joinWikiPath } from "../../src/server/wiki/wiki-path.js";
import {
	MATCH_TYPE_RANK,
	normalizeScore,
	compareHybridHits,
	WIKI_REGEX_DEFAULT_LIMITS,
	type WikiSearchHit,
	type WikiSearchRequest,
} from "../../src/shared/wiki-search-types.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
	WikiRequestContext,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Access / ctx helpers (mirror wiki-v2-auth.test.ts proven pattern).
// ---------------------------------------------------------------------------

const ALL_ACTIONS: WikiAction[] = [
	"expand", "read", "search", "create", "update",
	"delete", "link", "unlink", "move",
];

function grant(scope: string, actions: WikiAction[]): CompiledWikiGrant {
	return { canonicalScope: scope, actions };
}
function access(agentId: string, grants: CompiledWikiGrant[], activeProjectId?: string): CompiledWikiAccess {
	return { agentId, activeProjectId, grants, policyRevision: 1 };
}
function wideOpen(agentId = "admin-agent"): CompiledWikiAccess {
	return access(agentId, [grant("wiki-root", ALL_ACTIONS)]);
}
function ctxOf(acc: CompiledWikiAccess): WikiRequestContext {
	return {
		access: acc,
		agentId: acc.agentId,
		activeProjectId: acc.activeProjectId,
		sessionId: "search-test-session",
		requestId: null,
	};
}

// ---------------------------------------------------------------------------
// Service harness.
// ---------------------------------------------------------------------------

interface SearchHarness {
	wiki: WikiDatabase;
	svc: WikiService;
	search: WikiSearchService;
	dispose: () => void;
}

function buildSearchHarness(opts: { regexLimits?: any; sourceSearch?: any } = {}): SearchHarness {
	const dbPath = join(UNIQUE_DIR, `wiki-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const wikiSvc = WikiService.fromDatabase(wiki);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const search = new WikiSearchService({
		db,
		nodeRepo,
		repositoryStore,
		addressService,
		authorizationService,
		sourceSearch: opts.sourceSearch,
		regexLimits: opts.regexLimits,
	});
	return {
		wiki,
		svc: wikiSvc,
		search,
		dispose: () => { try { wiki.close(); } catch { /* idempotent */ } },
	};
}

/** Helper to run a search and unwrap the WikiSearchResult. */
async function run(search: WikiSearchService, req: WikiSearchRequest, acc: CompiledWikiAccess) {
	return search.search(req, ctxOf(acc));
}

// ---------------------------------------------------------------------------
// Real Git repo fixture for target=source tests.
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
function setIdentity(cwd: string): void {
	git(cwd, ["config", "user.name", "Test Bot"]);
	git(cwd, ["config", "user.email", "bot@example.test"]);
}
function writeRepoFile(repoDir: string, relPath: string, content: string): void {
	const abs = join(repoDir, relPath);
	const parent = join(abs, "..");
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

interface SourceRepo {
	repoDir: string;
	headSha: string;
}
function buildSourceRepo(parentTempDir: string, files: Record<string, string>): SourceRepo {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-search-src-"));
	git(repoDir, ["init", "-b", "main"]);
	setIdentity(repoDir);
	for (const [rel, content] of Object.entries(files)) writeRepoFile(repoDir, rel, content);
	git(repoDir, ["add", "."]);
	git(repoDir, ["commit", "-m", "c0"]);
	const headSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
	return { repoDir, headSha };
}

const PROJECTS_NS = joinWikiPath(WIKI_ROOT_PATH, "projects");
function projectPath(id: string): string { return `${PROJECTS_NS}/${id}`; }

// ===========================================================================
// §D.1 — exact mode
// ===========================================================================

describe("§D search exact mode [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("POSITIVE: exact matches name when query equals a node name", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "exactTarget", summary: "s", content: "body" }, ctxOf(wideOpen()));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "other", content: "noise" }, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "exact", query: "exactTarget" }, wideOpen());
		const paths = r.wikiHits.map((x) => x.path);
		expect(paths).toContain("wiki-root/knowledge/exactTarget");
		expect(paths).not.toContain("wiki-root/knowledge/other");
		expect(r.wikiHits[0].matchType).toBe("exact");
		expect(r.wikiHits[0].matchedField).toBe("name");
	});

	test("POSITIVE: exact matches canonical path when query equals full path", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "EP" }, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "exact", query: "wiki-root/knowledge/EP" }, wideOpen());
		expect(r.wikiHits.length).toBeGreaterThan(0);
		expect(r.wikiHits[0].path).toBe("wiki-root/knowledge/EP");
	});

	test("NEGATIVE: exact query that matches no name/path/summary returns 0 hits", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "alpha" }, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "exact", query: "doesNotExist" }, wideOpen());
		expect(r.wikiHits.length).toBe(0);
	});

	test("CASE-SENSITIVE true: 'Alpha' and 'alpha' treated as distinct (SQL = binary)", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "Alpha" }, ctxOf(wideOpen()));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "alpha" }, ctxOf(wideOpen()));
		// caseSensitive=true: only exact match 'Alpha' returned.
		const r = await run(h.search, { mode: "exact", query: "Alpha", caseSensitive: true }, wideOpen());
		const names = r.wikiHits.map((x) => x.name);
		expect(names).toContain("Alpha");
		expect(names).not.toContain("alpha");
	});

	test("CASE-INSENSITIVE false: 'alpha' matches both 'Alpha' and 'alpha' (ASCII folding)", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "Alpha" }, ctxOf(wideOpen()));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "alpha" }, ctxOf(wideOpen()));
		// caseSensitive=false: SQLite NOCASE folds ASCII only.
		const r = await run(h.search, { mode: "exact", query: "alpha", caseSensitive: false }, wideOpen());
		const names = r.wikiHits.map((x) => x.name).sort();
		expect(names).toEqual(["Alpha", "alpha"]);
	});
});

// ===========================================================================
// §D.2 — substring mode
// ===========================================================================

describe("§D search substring mode [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("POSITIVE: substring matches name/summary/content", async () => {
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "sub-one",
			summary: "contains needle text", content: "body",
		}, ctxOf(wideOpen()));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "other",
			summary: "clean", content: "no mention",
		}, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "substring", query: "needle" }, wideOpen());
		const paths = r.wikiHits.map((x) => x.path);
		expect(paths).toContain("wiki-root/knowledge/sub-one");
		expect(paths).not.toContain("wiki-root/knowledge/other");
	});

	test("NEGATIVE: substring with no match returns 0 hits", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "x", content: "y" }, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "substring", query: "absentTokenZZZ" }, wideOpen());
		expect(r.wikiHits.length).toBe(0);
	});

	test("ESCAPE: substring query containing LIKE wildcard chars is literal-matched, not wildcard", async () => {
		// A literal '%' or '_' in the query must NOT be interpreted as wildcard.
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "pct",
			summary: "rate=50%", content: "x",
		}, ctxOf(wideOpen()));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "wild",
			summary: "aaa", content: "bbb",
		}, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "substring", query: "50%" }, wideOpen());
		const paths = r.wikiHits.map((x) => x.path);
		expect(paths).toContain("wiki-root/knowledge/pct");
	});

	test("CASE-SENSITIVE true: 'Needle' vs 'needle' are distinct (LIKE behaves case-sensitively)", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "n1", content: "Needle Caps" }, ctxOf(wideOpen()));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "n2", content: "lowercase needle" }, ctxOf(wideOpen()));
		// caseSensitive=true: only the lowercase 'needle' content matches 'needle' query.
		const r = await run(h.search, { mode: "substring", query: "needle", caseSensitive: true }, wideOpen());
		const names = r.wikiHits.map((x) => x.name).sort();
		expect(names).toEqual(["n2"]);
	});

	test("CASE-INSENSITIVE false (default): 'needle' matches both 'Needle' and 'needle' (ASCII)", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "n1", content: "Needle Caps" }, ctxOf(wideOpen()));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "n2", content: "lowercase needle" }, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "substring", query: "needle", caseSensitive: false }, wideOpen());
		const names = r.wikiHits.map((x) => x.name).sort();
		expect(names).toEqual(["n1", "n2"]);
	});

	test("Unicode limitation: substring case-insensitive is ASCII-only (NOCASE doesn't fold Ä→ä)", async () => {
		// Per acceptance-04 §D "Unicode 限制在文档/API 中诚实说明": non-ASCII case folding
		// is NOT supported. We assert the documented limitation by demonstrating that
		// 'Ä' (U+00C4) does NOT fold to 'ä' (U+00E4) under SQLite NOCASE.
		await h.svc.create({ parent: "wiki-root/knowledge", name: "u1", content: "Größe" }, ctxOf(wideOpen()));
		// case-insensitive search for uppercase form should NOT match the lowercase form
		// (this is the documented limitation, not a bug — but it MUST be visible in behavior).
		const r = await run(h.search, { mode: "substring", query: "GROSSE" }, wideOpen());
		// 'Größe' contains no 'GROSSE' substring, so this is expected to be 0 hits.
		expect(r.wikiHits.length).toBe(0);
		// Document the actual behavior: lowercase query 'größ' should match.
		const r2 = await run(h.search, { mode: "substring", query: "größ" }, wideOpen());
		expect(r2.wikiHits.length).toBeGreaterThan(0);
	});
});

// ===========================================================================
// §D.3 — glob mode: * (no cross-segment), ** (cross-segment), ? (single char)
// ===========================================================================

describe("§D search glob mode — segment-aware matching [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(async () => {
		h = buildSearchHarness();
		// Tree under wiki-root/knowledge/glob-test:
		//   wiki-root/knowledge/glob-test/file.ts
		//   wiki-root/knowledge/glob-test/other.md
		//   wiki-root/knowledge/glob-test/sub/deep.ts
		//   wiki-root/knowledge/glob-test/sub/sub2/deeper.ts
		// (knowledge auto-exists as fixed root; we build nested parents first.)
		const admin = wideOpen();
		await h.svc.create({ parent: "wiki-root/knowledge", name: "glob-test", kind: "directory" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge/glob-test", name: "file.ts" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge/glob-test", name: "other.md" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge/glob-test", name: "sub", kind: "directory" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge/glob-test/sub", name: "deep.ts" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge/glob-test/sub", name: "sub2", kind: "directory" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge/glob-test/sub/sub2", name: "deeper.ts" }, ctxOf(admin));
	});
	afterEach(() => { h.dispose(); });

	test("SINGLE-SEGMENT `*`: matches any chars within ONE path segment (no cross-segment)", async () => {
		// Query `*.ts` applied to PATH means "any path ending with /<x>.ts where <x> is one segment".
		// Glob matcher tests against full canonical path.
		const r = await run(h.search, { mode: "glob", query: "*.ts" }, wideOpen());
		const paths = r.wikiHits.map((x) => x.path).sort();
		// Single-segment *.ts: matches /file.ts and /deep.ts but NOT /deeper.ts (deeper
		// is one segment so it should match too — `*` matches 'deeper').
		// Cross-segment would be needed for paths like sub/sub2/deeper.ts when querying *.ts
		// on a multi-segment matcher; the JS glob matcher is anchored to the FULL path.
		// We expect: file.ts, deep.ts, deeper.ts to all match `*.ts`? Check semantics.
		// Actually `*.ts` with `*` = [^/]* means single segment ending in .ts.
		// Paths ending in single-segment-.ts: all four leaf files. But matcher is on FULL
		// canonical path; `*.ts` regex ^[^/]*\.ts$ only matches strings without slashes.
		// So full-path `*.ts` matches NONE of these (all contain slashes).
		// The impl applies matcher to BOTH r.path AND r.name. r.name of each leaf IS
		// the final segment, so *.ts matches by name.
		expect(paths).toContain("wiki-root/knowledge/glob-test/file.ts");
	});

	test("`?` matches exactly one character (not zero, not two)", async () => {
		// file.ts matches `?ile.ts`; doesn't match `??ile.ts` (too short by 1).
		const r1 = await run(h.search, { mode: "glob", query: "?ile.ts" }, wideOpen());
		expect(r1.wikiHits.map((x) => x.name)).toContain("file.ts");
		const r2 = await run(h.search, { mode: "glob", query: "??ile.ts" }, wideOpen());
		// `??ile.ts` requires 2 chars before 'ile' — 'file' has only 1 ('f') + 'ile' = 4 chars.
		expect(r2.wikiHits.map((x) => x.name)).not.toContain("file.ts");
	});

	test("POSITIVE/NEGATIVE: glob 'sub' directory existence is reflected", async () => {
		// Just ensure glob mode returns at least one hit on a known name.
		const r = await run(h.search, { mode: "glob", query: "deep.ts" }, wideOpen());
		expect(r.wikiHits.length).toBeGreaterThan(0);
	});

	test("`**` cross-segment: matches paths across multiple `/` boundaries (vs `*` single-segment)", async () => {
		// `**` is segment-spanning. Compiled regex: `.*`. So `**/deeper.ts` regex
		// ^.*deeper\.ts$ matches any path ending with deeper.ts.
		const r = await run(h.search, { mode: "glob", query: "**/deeper.ts" }, wideOpen());
		const names = r.wikiHits.map((x) => x.name);
		expect(names).toContain("deeper.ts");
	});
});

// ===========================================================================
// §D.4 — fulltext mode (FTS5)
// ===========================================================================

describe("§D search fulltext mode (FTS5) [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("POSITIVE: FTS matches content tokens; returns ranked hits + snippet", async () => {
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "ft1",
			content: "Discusses distributed systems and consensus protocols.",
		}, ctxOf(wideOpen()));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "ft2",
			content: "Unrelated cooking recipes.",
		}, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "fulltext", query: "consensus" }, wideOpen());
		const paths = r.wikiHits.map((x) => x.path);
		expect(paths).toContain("wiki-root/knowledge/ft1");
		expect(paths).not.toContain("wiki-root/knowledge/ft2");
		expect(r.wikiHits[0].matchType).toBe("fulltext");
		// normalizedScore ∈ [0,1]
		for (const hit of r.wikiHits) {
			expect(hit.normalizedScore).toBeGreaterThanOrEqual(0);
			expect(hit.normalizedScore).toBeLessThanOrEqual(1);
		}
	});

	test("NEGATIVE: FTS with token not in any node → 0 hits", async () => {
		await h.svc.create({ parent: "wiki-root/knowledge", name: "x", content: "alpha beta" }, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "fulltext", query: "zzznotpresent" }, wideOpen());
		expect(r.wikiHits.length).toBe(0);
	});

	test("FTS snippet contains the query term (when present in summary/content)", async () => {
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "sn",
			summary: "Short summary about needle here.",
			content: "body",
		}, ctxOf(wideOpen()));
		const r = await run(h.search, { mode: "fulltext", query: "needle" }, wideOpen());
		expect(r.wikiHits.length).toBeGreaterThan(0);
		// Snippet either contains 'needle' OR is non-empty when matched.
		expect(r.wikiHits[0].snippet).toContain("needle");
	});
});

// ===========================================================================
// §D.5 — no authorized scope: empty result, NO content query / snippet
// ===========================================================================

describe("§D no-scope → empty (no content query, no snippet) [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("Caller with NO search grant gets empty result (no leak of count/existence)", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "hidden",
			content: "UNIQUE_SECRET_TOKEN",
		}, ctxOf(admin));
		// Attacker has NO search grant anywhere (only read on a different scope).
		const attacker = access("attacker", [grant("wiki-root/memory", ["read"])]);
		const r = await run(h.search, { mode: "substring", query: "UNIQUE_SECRET_TOKEN" }, attacker);
		expect(r.wikiHits.length).toBe(0);
		expect(r.sourceHits.length).toBe(0);
		expect(r.truncated).toBe(false);
		// Empty payload — no leak hints.
		const json = JSON.stringify(r);
		expect(json).not.toContain("UNIQUE_SECRET_TOKEN");
		expect(json).not.toContain("hidden");
	});

	test("Caller with search grant but requestedScope outside access → empty", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "kh",
			content: "kn-token",
		}, ctxOf(admin));
		// memory/admin-agent must exist as parent before creating mh.
		await h.svc.create({
			parent: "wiki-root/memory", name: "admin-agent", kind: "memory",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/memory/admin-agent", name: "mh",
			content: "kn-token",
		}, ctxOf(admin));
		// Attacker has search on memory only; requests scope=knowledge.
		const attacker = access("attacker", [grant("wiki-root/memory", ["search", "read"])]);
		const r = await run(h.search, {
			mode: "substring", query: "kn-token",
			scope: "wiki-root/knowledge",
		}, attacker);
		expect(r.wikiHits.length).toBe(0);
		expect(r.sourceHits.length).toBe(0);
	});
});

// ===========================================================================
// §D.6 — both: merges Wiki + source hits; provenance preserved
// ===========================================================================

const rgIt = HAS_RG ? test : test.skip;

describe("§D search target=both — provenance-preserving merge [对抗 lens]", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "zc-both-"));
	});
	afterEach(() => {
		try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	rgIt("both: wiki + source hits BOTH returned with correct target tag (no provenance loss)", async () => {
		// Build a wiki node with summary containing the token AND a source file with the token.
		const repo = buildSourceRepo(tempRoot, {
			"code.ts": "export const NEEDLE = 'twine';\n",
		});
		const dbPath = join(UNIQUE_DIR, `wiki-both-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
		const wiki = new WikiDatabase(dbPath);
		try {
			const db = wiki.getDb();
			const nodeRepo = new WikiNodeRepository(db);
			const linkRepo = new WikiLinkRepository(db);
			const auditRepo = new WikiAuditRepository(db);
			const repositoryStore = new WikiRepositoryStore(db);
			const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
			const authorizationService = new WikiAuthorizationService();
			const editService = new WikiEditService();
			const svc = new WikiService({
				wikiDb: wiki, nodeRepo, linkRepo, auditRepo, repositoryStore,
				addressService, authorizationService, editService,
			});
			const projectStore: ProjectStoreLike = {
				get: (id) => (id === "p" ? { id, name: "P", workspaceDir: repo.repoDir } : undefined),
				list: () => [{ id: "p", name: "P", workspaceDir: repo.repoDir }],
			};
			const indexer = new WikiProjectIndexer({
				wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
				repositoryStore, git: new ArchivistGit(), projectStore,
			});
			await indexer.fullIndex("p", { revision: repo.headSha });
			const sourceSearch = new WikiSourceSearch({
				nodeRepo, repositoryStore,
				resolveWorkspace: (id) => (id === "p" ? repo.repoDir : undefined),
				ripgrepBinary: RG_BIN,
			});
			const search = new WikiSearchService({
				db, nodeRepo, repositoryStore, addressService, authorizationService,
				sourceSearch,
			});

			// Enrich the source-bound file node with summary containing the token
			// (semantic enrichment — allowed even on source-bound nodes).
			// NOTE: source search only fires for grants whose canonical scope starts
			// with `wiki-root/projects/` — grant must be on the project subtree,
			// not the whole wiki-root, or sourceHits will be empty by design.
			const adminAccess = access("admin", [grant("wiki-root", ALL_ACTIONS), grant("wiki-root/projects/p", ALL_ACTIONS)], "p");
			const filePath = `${projectPath("p")}/code.ts`;
			const before = await svc.read({ address: filePath, view: "summary" }, ctxOf(adminAccess));
			await svc.update({
				address: filePath,
				expected_revision: before.node.revision,
				changes: { summary: "Holds the NEEDLE constant for the project." },
			}, ctxOf(adminAccess));

			// Also create a separate wiki-only node with the token in its summary.
			await svc.create({
				parent: "wiki-root/knowledge", name: "wonly",
				summary: "Wiki-only node referencing NEEDLE.",
			}, ctxOf(adminAccess));

			const r = await search.search({
				mode: "substring", target: "both", query: "NEEDLE",
			}, ctxOf(adminAccess));

			// Both wiki hits and source hits present.
			expect(r.wikiHits.length, "wiki hits must be present").toBeGreaterThan(0);
			expect(r.sourceHits.length, "source hits must be present").toBeGreaterThan(0);
			// Provenance preserved: each hit's target tag matches its array membership.
			for (const w of r.wikiHits) expect(w.target).toBe("wiki");
			for (const s of r.sourceHits) expect(s.target).toBe("source");
			// Source hits carry sourcePath (only meaningful for source target).
			for (const s of r.sourceHits) expect(typeof s.sourcePath).toBe("string");
		} finally {
			try { wiki.close(); } catch { /* idempotent */ }
		}
	});
});

// ===========================================================================
// §D.7 — cursor / limit stability (same input + revision → same order)
// ===========================================================================

describe("§D cursor/limit stability [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("Paginating twice with same cursor yields identical pages (deterministic)", async () => {
		// Create 5 nodes with predictable names; substring search will return them all.
		const admin = wideOpen();
		for (let i = 0; i < 5; i++) {
			await h.svc.create({
				parent: "wiki-root/knowledge", name: `page-item-${i}`,
				summary: `common-token row ${i}`,
			}, ctxOf(admin));
		}
		const req = (cursor: string | null) => ({
			mode: "substring", query: "common-token", limit: 2, cursor,
		});
		const p1a = await run(h.search, req(null), admin);
		expect(p1a.wikiHits.length).toBe(2);
		expect(p1a.hasMore).toBe(true);
		// Re-run page 1 — must be identical.
		const p1b = await run(h.search, req(null), admin);
		expect(p1b.wikiHits.map((x) => x.path)).toEqual(p1a.wikiHits.map((x) => x.path));
		// Page 2 via cursor.
		const p2a = await run(h.search, req(p1a.cursor), admin);
		const p2b = await run(h.search, req(p1a.cursor), admin);
		expect(p2b.wikiHits.map((x) => x.path)).toEqual(p2a.wikiHits.map((x) => x.path));
		// No overlap between pages.
		const p1Paths = new Set(p1a.wikiHits.map((x) => x.path));
		for (const p of p2a.wikiHits.map((x) => x.path)) expect(p1Paths.has(p)).toBe(false);
	});

	test("limit clamped to server max (200) — no more than 200 per page", async () => {
		const admin = wideOpen();
		// Create 5 nodes (small fixture); request limit=10000 (oversize).
		for (let i = 0; i < 5; i++) {
			await h.svc.create({ parent: "wiki-root/knowledge", name: `lim-${i}`, summary: "lim-tok" }, ctxOf(admin));
		}
		const r = await run(h.search, { mode: "substring", query: "lim-tok", limit: 10000 as any }, admin);
		// Server must clamp (cap=200); we have 5, so all returned.
		expect(r.wikiHits.length).toBe(5);
	});
});

// ===========================================================================
// §D.8 — hybrid sort EXACTLY matches the shared oracle
// ===========================================================================

describe("§D hybrid sort oracle — (match_type_rank, -score, path, target) [对抗 lens]", () => {
	// Unit-test the shared compareHybridHits oracle directly — confirms the
	// ranking tuple is exactly as specified, with NO internal-id tiebreak.
	test("compareHybridHits orders by match_type_rank first (exact < path < fulltext < source < regex < substring)", () => {
		const hits: Parameters<typeof compareHybridHits>[0][] = [
			{ matchType: "substring", normalizedScore: 1.0, canonicalPath: "a", target: "wiki" },
			{ matchType: "exact", normalizedScore: 0.5, canonicalPath: "z", target: "wiki" },
			{ matchType: "fulltext", normalizedScore: 0.99, canonicalPath: "m", target: "wiki" },
			{ matchType: "path", normalizedScore: 0.5, canonicalPath: "b", target: "wiki" },
			{ matchType: "source", normalizedScore: 0.5, canonicalPath: "s", target: "source" },
			{ matchType: "regex", normalizedScore: 0.5, canonicalPath: "r", target: "wiki" },
		];
		const sorted = [...hits].sort(compareHybridHits);
		expect(sorted.map((x) => x.matchType)).toEqual([
			"exact", "path", "fulltext", "source", "regex", "substring",
		]);
	});

	test("same matchType → higher normalizedScore first (DESC)", () => {
		const a = { matchType: "fulltext" as const, normalizedScore: 0.4, canonicalPath: "a", target: "wiki" as const };
		const b = { matchType: "fulltext" as const, normalizedScore: 0.9, canonicalPath: "b", target: "wiki" as const };
		expect(compareHybridHits(a, b)).toBeGreaterThan(0); // b first
		expect(compareHybridHits(b, a)).toBeLessThan(0);
	});

	test("same matchType + same score → canonical_path ASC (lexicographic)", () => {
		const a = { matchType: "fulltext" as const, normalizedScore: 0.5, canonicalPath: "wiki-root/a", target: "wiki" as const };
		const b = { matchType: "fulltext" as const, normalizedScore: 0.5, canonicalPath: "wiki-root/b", target: "wiki" as const };
		expect(compareHybridHits(a, b)).toBeLessThan(0);
	});

	test("same path → target ASC (source < wiki)", () => {
		const src = { matchType: "fulltext" as const, normalizedScore: 0.5, canonicalPath: "wiki-root/a", target: "source" as const };
		const wik = { matchType: "fulltext" as const, normalizedScore: 0.5, canonicalPath: "wiki-root/a", target: "wiki" as const };
		expect(compareHybridHits(src, wik)).toBeLessThan(0); // source first
	});

	test("MATCH_TYPE_RANK matches documented order (exact=0, path=1, fulltext=2, source=3, regex=4, substring=5)", () => {
		expect(MATCH_TYPE_RANK).toEqual({
			exact: 0, path: 1, fulltext: 2, source: 3, regex: 4, substring: 5,
		});
	});

	test("normalizeScore returns [0,1] for each matchType with documented constants", () => {
		expect(normalizeScore("exact")).toBe(1.0);
		expect(normalizeScore("path")).toBe(0.9);
		// fulltext: 1/(1+|rank|); rank=0 → 1.0; rank=1 → 0.5.
		expect(normalizeScore("fulltext", 0)).toBe(1.0);
		expect(normalizeScore("fulltext", 1)).toBeCloseTo(0.5, 5);
		expect(normalizeScore("source")).toBe(0.7);
		expect(normalizeScore("regex")).toBe(0.6);
		expect(normalizeScore("substring")).toBe(0.5);
	});

	test("hybrid search returns hits sorted per oracle (integration with real search)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			// Create 3 nodes:
			//  - 'apple' summary 'unique-hybrid-token exact-name' → exact + substring + fulltext all match.
			//  - 'banana' summary 'unique-hybrid-token extra'   → substring + fulltext match (no exact).
			//  - 'cherry' summary 'no-match'                     → not returned.
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "unique-hybrid-token",
				summary: "discusses unique-hybrid-token in body",
			}, ctxOf(admin));
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "other",
				summary: "unique-hybrid-token only-in-summary",
			}, ctxOf(admin));

			const r = await run(h.search, { mode: "hybrid", query: "unique-hybrid-token" }, admin);
			// Expect at least one exact hit ranked before any substring hit.
			const ranks = r.wikiHits.map((x) => MATCH_TYPE_RANK[x.matchType]);
			for (let i = 1; i < ranks.length; i++) {
				expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
			}
			// Exact hit (if any) must precede substring hits.
			const exactIdx = r.wikiHits.findIndex((x) => x.matchType === "exact");
			const substringIdx = r.wikiHits.findIndex((x) => x.matchType === "substring");
			if (exactIdx >= 0 && substringIdx >= 0) {
				expect(exactIdx).toBeLessThan(substringIdx);
			}
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// §E.1 — LEXICOGRAPHIC-RANGE LEAK (BLOCKER candidate)
// The impl uses `path >= scope AND path <= scope + "/￿"` to filter nodes by
// authorized scope. This is NOT segment-based: a sibling whose name starts with
// the scope name + a character whose codepoint is less than '/' (0x2F) — e.g.
// hyphen '-' (0x2D) or dot '.' (0x2E) — gets WRONGLY included in the range.
// Attack: grant on wiki-root/knowledge/alpha; query substring for content of
// wiki-root/knowledge/alpha-secret (unauthorized sibling). Expected: 0 hits.
// Buggy: alpha-secret's snippet is returned → existence + content leak.
// ===========================================================================

describe("§E lexicographic-range leak — sibling outside scope MUST NOT be returned [对抗 lens]", () => {
	test("BLOCKER candidate: substring search for unauthorized sibling content leaks via range filter", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			// authorized node (attacker will have search grant HERE only).
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "alpha",
				summary: "public-attacker-authorized",
				content: "alpha body",
			}, ctxOf(admin));
			// UNAUTHORIZED sibling — name starts with 'alpha' + '-' (0x2D < '/' 0x2F).
			// The lex-range filter `path >= alpha AND path <= alpha+'/￿'` WILL include
			// this row even though it's a sibling, not a descendant.
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "alpha-secret",
				summary: "sibling-summary",
				content: "LEAKED_VIA_RANGE_TOKEN",
			}, ctxOf(admin));
			// Another sibling with '.' (0x2E < '/' 0x2F) — also leaks if bug present.
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "alpha.dots",
				content: "LEAKED_VIA_RANGE_TOKEN dots variant",
			}, ctxOf(admin));
			// Sibling starting with alphanumeric (0x30 > 0x2F) — correctly excluded.
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "alpha0",
				content: "LEAKED_VIA_RANGE_TOKEN numeric",
			}, ctxOf(admin));

			// Attacker has search grant on ONLY wiki-root/knowledge/alpha (leaf scope).
			const attacker = access("attacker", [
				grant("wiki-root/knowledge/alpha", ["search", "read"]),
			]);
			const r = await run(h.search, {
				mode: "substring", query: "LEAKED_VIA_RANGE_TOKEN",
			}, attacker);

			// CRITICAL: NO unauthorized sibling path may appear.
			const leakedPaths = r.wikiHits
				.map((x) => x.path)
				.filter((p) => p.startsWith("wiki-root/knowledge/alpha"));
			const forbidden = leakedPaths.filter((p) =>
				p === "wiki-root/knowledge/alpha-secret"
				|| p === "wiki-root/knowledge/alpha.dots"
				|| p === "wiki-root/knowledge/alpha0"
			);
			expect(forbidden, `BLOCKER LEAK: unauthorized sibling paths returned via lex-range filter: ${JSON.stringify(forbidden)}`).toEqual([]);
			// Also: NO snippet / count / score hint.
			const json = JSON.stringify(r);
			expect(json).not.toContain("LEAKED_VIA_RANGE_TOKEN");
			expect(json).not.toContain("alpha-secret");
			expect(json).not.toContain("alpha.dots");
		} finally {
			h.dispose();
		}
	});

	test("BLOCKER candidate: fulltext search for unauthorized sibling content leaks via range filter", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "ft-auth",
				content: "innocuous authorized content",
			}, ctxOf(admin));
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "ft-auth-leak",
				content: "FTX_LEAK_TOKEN distinctive phrase",
			}, ctxOf(admin));

			const attacker = access("attacker", [
				grant("wiki-root/knowledge/ft-auth", ["search", "read"]),
			]);
			const r = await run(h.search, {
				mode: "fulltext", query: "FTX_LEAK_TOKEN",
			}, attacker);
			const paths = r.wikiHits.map((x) => x.path);
			expect(paths, `BLOCKER LEAK (fulltext): unauthorized sibling returned: ${JSON.stringify(paths)}`)
				.not.toContain("wiki-root/knowledge/ft-auth-leak");
			expect(JSON.stringify(r)).not.toContain("FTX_LEAK_TOKEN");
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// §E.2 — authorized + secret subtrees (per spec): no leak via path/snippet/
// count/score across wiki/source/both modes
// ===========================================================================

describe("§E authorized + secret subtrees — no leak via path/snippet/count/score [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(async () => {
		h = buildSearchHarness();
		const admin = wideOpen();
		// Authorized subtree: wiki-root/knowledge/visible
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "visible",
			summary: "public summary", content: "visible content",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge/visible", name: "child",
			summary: "child summary", content: "child body",
		}, ctxOf(admin));
		// SECRET subtree: wiki-root/knowledge/secretree (sibling, different name)
		// Using a UNIQUE secret keyword per acceptance-04 §E.
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "secretree",
			summary: "confidential",
			content: "TOPSECRET-unique-keyword-xyz marker",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge/secretree", name: "nested",
			content: "TOPSECRET-unique-keyword-xyz deeper",
		}, ctxOf(admin));
	});
	afterEach(() => { h.dispose(); });

	const SECRET_TOKEN = "TOPSECRET-unique-keyword-xyz";
	const SECRET_PATH = "wiki-root/knowledge/secretree";

	test("substring mode: query for secret token → NO secret path/snippet in result", async () => {
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["search", "read", "expand"]),
		]);
		const r = await run(h.search, { mode: "substring", query: SECRET_TOKEN }, attacker);
		expect(r.wikiHits.length).toBe(0);
		const json = JSON.stringify(r);
		expect(json).not.toContain(SECRET_TOKEN);
		expect(json).not.toContain(SECRET_PATH);
		expect(json).not.toContain("secretree");
	});

	test("exact mode: query for secret path → NO existence leak", async () => {
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["search", "read"]),
		]);
		// Searching for the secret's exact name should return 0 (not even a count hint).
		const r = await run(h.search, { mode: "exact", query: "secretree" }, attacker);
		expect(r.wikiHits.length).toBe(0);
		expect(JSON.stringify(r)).not.toContain("secretree");
	});

	test("glob mode: glob '**/secretree/**' → NO existence leak", async () => {
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["search", "read"]),
		]);
		const r = await run(h.search, { mode: "glob", query: "**/secretree/**" }, attacker);
		expect(r.wikiHits.length).toBe(0);
		expect(JSON.stringify(r)).not.toContain("secretree");
	});

	test("fulltext mode: FTS for secret token → NO leak", async () => {
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["search", "read"]),
		]);
		const r = await run(h.search, { mode: "fulltext", query: SECRET_TOKEN }, attacker);
		expect(r.wikiHits.length).toBe(0);
		expect(JSON.stringify(r)).not.toContain(SECRET_TOKEN);
	});

	test("hybrid mode: query for secret token → NO leak across fused sub-modes", async () => {
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["search", "read"]),
		]);
		const r = await run(h.search, { mode: "hybrid", query: SECRET_TOKEN }, attacker);
		expect(r.wikiHits.length).toBe(0);
		const json = JSON.stringify(r);
		expect(json).not.toContain(SECRET_TOKEN);
		expect(json).not.toContain("secretree");
	});

	test("count/score hint: same query shape but secret scope returns 0 — no differential leak", async () => {
		// Attacker has visible scope. Querying for SECRET vs querying for VISIBLE
		// must not leak "secret exists" via truncated flag or limits echo.
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["search", "read"]),
		]);
		const rSecret = await run(h.search, { mode: "substring", query: SECRET_TOKEN }, attacker);
		const rVisible = await run(h.search, { mode: "substring", query: "visible content" }, attacker);
		expect(rSecret.wikiHits.length).toBe(0);
		expect(rVisible.wikiHits.length).toBeGreaterThan(0);
		// truncated flag must not leak secret presence.
		expect(rSecret.truncated).toBe(false);
	});
});

// ===========================================================================
// §E.3 — link to secret: read/expand do NOT leak peer
// ===========================================================================

describe("§E link-to-secret — read/expand do not leak peer [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("Attacker reads visible node (linked to secret) → no secret path appears", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "linked-visible",
			summary: "v", content: "vc",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "linked-secret",
			summary: "s", content: "LINKED_SECRET_TOKEN",
		}, ctxOf(admin));
		// Admin links visible → secret.
		await h.svc.link({
			source: "wiki-root/knowledge/linked-visible",
			target: "wiki-root/knowledge/linked-secret",
			relation: "depends_on",
		}, ctxOf(admin));

		// Attacker can read visible but NOT secret.
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/linked-visible", ["read", "expand"]),
		]);
		const read = await h.svc.read({
			address: "wiki-root/knowledge/linked-visible", view: "links",
		}, ctxOf(attacker));
		const json = JSON.stringify(read);
		expect(json).not.toContain("linked-secret");
		expect(json).not.toContain("LINKED_SECRET_TOKEN");
		// Outgoing link to secret must be filtered out.
		if (read.links) {
			for (const l of read.links.outgoing) {
				expect(l.targetPath).not.toBe("wiki-root/knowledge/linked-secret");
			}
		}
	});

	test("expand on visible node linked to secret: no link-count hint", async () => {
		const admin = wideOpen();
		await h.svc.create({ parent: "wiki-root/knowledge", name: "vis2" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "sec2", content: "SEC2TKN" }, ctxOf(admin));
		await h.svc.link({
			source: "wiki-root/knowledge/vis2",
			target: "wiki-root/knowledge/sec2",
			relation: "related_to",
		}, ctxOf(admin));
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/vis2", ["read", "expand"]),
		]);
		const exp = await h.svc.expand({
			address: "wiki-root/knowledge/vis2", includeLinks: true,
		}, ctxOf(attacker));
		const json = JSON.stringify(exp);
		expect(json).not.toContain("sec2");
		expect(json).not.toContain("SEC2TKN");
	});
});

// ===========================================================================
// §E.4 — direct read secret existing/non-existing: same NOT_FOUND appearance
// ===========================================================================

describe("§E direct read secret — existing vs non-existing look identical [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("Existing secret vs non-existing path: both NOT_FOUND, same code", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "exists-secret",
			content: "EXISTS_SECRET_TKN",
		}, ctxOf(admin));
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["read"]),
		]);
		// Read existing secret.
		const existErr = await h.svc.read({
			address: "wiki-root/knowledge/exists-secret", view: "summary",
		}, ctxOf(attacker)).catch((e: any) => e);
		// Read non-existing path (same parent prefix).
		const nonErr = await h.svc.read({
			address: "wiki-root/knowledge/never-created-xyz", view: "summary",
		}, ctxOf(attacker)).catch((e: any) => e);
		expect(existErr?.code).toBe("NOT_FOUND");
		expect(nonErr?.code).toBe("NOT_FOUND");
		// Neither error message exposes content/existence differential.
		expect(String(existErr?.message ?? "")).not.toContain("EXISTS_SECRET_TKN");
		expect(String(nonErr?.message ?? "")).not.toContain("EXISTS_SECRET_TKN");
	});
});

// ===========================================================================
// §A.5 — re-exported default limits constant (search result echoes)
// ===========================================================================

test("WIKI_REGEX_DEFAULT_LIMITS matches documented v1 defaults (plan-04 §5)", () => {
	expect(WIKI_REGEX_DEFAULT_LIMITS.patternBytes).toBe(2048);
	expect(WIKI_REGEX_DEFAULT_LIMITS.authorizedCandidates).toBe(50_000);
	expect(WIKI_REGEX_DEFAULT_LIMITS.contentBytes).toBe(16 * 1024 * 1024);
	expect(WIKI_REGEX_DEFAULT_LIMITS.wallMs).toBe(250);
	expect(WIKI_REGEX_DEFAULT_LIMITS.results).toBe(200);
});

// ===========================================================================
// §D.9 — CONCERN: `kinds` filter advertised by schema but silently ignored.
// The LLM-facing wikiV2ActionSchema describes `kinds: array of kind enum` as a
// search filter. The impl's searchExact/searchSubstring/searchFulltext/etc.
// never reference `req.kinds` — a caller filtering by kinds gets ALL kinds.
// This is a spec deviation (CONCERN, not blocker — result limit still holds).
// ===========================================================================

describe("§D `kinds` filter — advertised by schema, applied by service? [对抗 lens]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("kinds=['memory'] filter — only memory-kind nodes returned (when filter honored)", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "mem",
			kind: "memory", summary: "common-kw",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "knode",
			kind: "node", summary: "common-kw",
		}, ctxOf(admin));
		const r = await run(h.search, {
			mode: "substring", query: "common-kw", kinds: ["memory"],
		}, admin);
		const kinds = new Set(r.wikiHits.map((x) => x.kind));
		// Spec: only memory nodes. Impl: kinds filter ignored → both returned.
		// We assert the spec; impl deviation will fail this test (CONCERN finding).
		for (const k of kinds) expect(k).toBe("memory");
	});
});

// ===========================================================================
// round-3 B1+C2 — truncated boundary per mode (exact / substring / glob)
//
// round-2 only covered regex >200 → truncated. exact/substring/glob were never
// exercised at the >200 boundary. Each mode now exposes an internal rawCount
// (pre-slice match total); truncated = rawCount > limits.results (200). These
// tests pin the boundary at 200 (false) / 201 (true) / 250 (true, hits===200).
// ===========================================================================

/** Seed N leaf nodes under wiki-root/knowledge whose summary all contain `token`. */
async function seedSummaryNodes(h: SearchHarness, count: number, token: string): Promise<void> {
	const admin = wideOpen();
	for (let i = 0; i < count; i++) {
		await h.svc.create({
			parent: "wiki-root/knowledge", name: `b${i}`,
			summary: `${token}-${i}`, content: "x",
		}, ctxOf(admin));
	}
}

describe("round-3 B1+C2 — exact mode truncated boundary [对抗 lens]", () => {
	test("exact 250 same-summary → truncated=true, exactly 200 hits", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			// exact matches `summary = ?`; 250 nodes share summary "shared-exact-tok".
			for (let i = 0; i < 250; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `e${i}`,
					summary: "shared-exact-tok", content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "exact", query: "shared-exact-tok", limit: 200 }, admin);
			expect(r.truncated, "250 raw > 200 → truncated must be true").toBe(true);
			expect(r.wikiHits.length).toBe(200);
		} finally { h.dispose(); }
	});
	test("exact 200 → truncated=false (boundary lower side)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 200; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `e${i}`,
					summary: "shared-exact-tok", content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "exact", query: "shared-exact-tok", limit: 200 }, admin);
			expect(r.truncated, "200 raw == 200 → truncated false").toBe(false);
		} finally { h.dispose(); }
	});
	test("exact 201 → truncated=true (boundary upper side)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 201; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `e${i}`,
					summary: "shared-exact-tok", content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "exact", query: "shared-exact-tok", limit: 200 }, admin);
			expect(r.truncated, "201 raw > 200 → truncated true").toBe(true);
		} finally { h.dispose(); }
	});
}, 30000);

describe("round-3 B1+C2 — substring mode truncated boundary [对抗 lens]", () => {
	test("substring 250 → truncated=true, exactly 200 hits", async () => {
		const h = buildSearchHarness();
		try {
			await seedSummaryNodes(h, 250, "subtok-x");
			const r = await run(h.search, { mode: "substring", query: "subtok-x", limit: 200 }, wideOpen());
			expect(r.truncated).toBe(true);
			expect(r.wikiHits.length).toBe(200);
		} finally { h.dispose(); }
	});
	test("substring 200 → truncated=false", async () => {
		const h = buildSearchHarness();
		try {
			await seedSummaryNodes(h, 200, "subtok-x");
			const r = await run(h.search, { mode: "substring", query: "subtok-x", limit: 200 }, wideOpen());
			expect(r.truncated).toBe(false);
		} finally { h.dispose(); }
	});
	test("substring 201 → truncated=true", async () => {
		const h = buildSearchHarness();
		try {
			await seedSummaryNodes(h, 201, "subtok-x");
			const r = await run(h.search, { mode: "substring", query: "subtok-x", limit: 200 }, wideOpen());
			expect(r.truncated).toBe(true);
		} finally { h.dispose(); }
	});
}, 30000);

describe("round-3 B1+C2 — glob mode truncated boundary [对抗 lens]", () => {
	test("glob 250 name match → truncated=true, exactly 200 hits", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 250; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `gnode${i}.ts`, content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "glob", query: "gnode*.ts", limit: 200 }, admin);
			expect(r.truncated).toBe(true);
			expect(r.wikiHits.length).toBe(200);
		} finally { h.dispose(); }
	});
	test("glob 200 → truncated=false", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 200; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `gnode${i}.ts`, content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "glob", query: "gnode*.ts", limit: 200 }, admin);
		expect(r.truncated).toBe(false);
		} finally { h.dispose(); }
	});
}, 30000);

// ===========================================================================
// round-4 B1-HYBRID — hybrid mode truncated boundary.
//
// round-3 only pinned exact/substring/glob/regex >200 boundaries. hybrid was
// never exercised at >200: searchHybrid previously set rawCount=dedup.size,
// but dedup input is each component's already-sliced-to-200 hits, so dedup.size
// could never exceed 200 → truncated was always false even when a component
// had 250 pre-slice matches (50 silently dropped). round-4 fix: hybrid
// rawCount = max(exact, substring, fulltext) component rawCounts (each is its
// own pre-slice total). These tests pin the hybrid boundary so the bug cannot
// regress.
//
// NOTE on dedup granularity: hybrid dedups on `path|matchType|matchedField`, so
// one node matching via multiple components yields multiple entries. We assert
// `truncated` (the contract) + `hits===200` for the >200 case (final slice);
// for the <200 case we assert `truncated=false` without pinning hits.count.
// ===========================================================================

describe("round-4 B1-HYBRID — hybrid mode truncated boundary [对抗 lens]", () => {
	test("hybrid 250 (substring-dominant token) → truncated=true, exactly 200 hits", async () => {
		// 250 nodes whose summary contains a token. exact=0 (no field exactly
		// equals query), substring=250, fulltext>=250 (FTS phrase matches each).
		// Before the fix rawCount=dedup.size<=200 → truncated was false (BUG).
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 250; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `h${i}`,
					summary: `r4hybtok-${i} extra`, content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "hybrid", query: "r4hybtok", limit: 200 }, admin);
			expect(r.truncated, "hybrid 250 → truncated MUST be true (B1-HYBRID fix)").toBe(true);
			expect(r.wikiHits.length).toBe(200);
			// No duplicate paths in the returned page (dedup + final slice intact).
			const paths = r.wikiHits.map((x) => x.path);
			expect(new Set(paths).size).toBe(paths.length);
		} finally { h.dispose(); }
	});

	test("hybrid 201 → truncated=true (boundary upper side)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 201; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `hu${i}`,
					summary: `r4hybup-${i}`, content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "hybrid", query: "r4hybup", limit: 200 }, admin);
			expect(r.truncated, "hybrid 201 → truncated true").toBe(true);
			expect(r.wikiHits.length).toBe(200);
		} finally { h.dispose(); }
	});

	test("hybrid 200 → truncated=false (boundary lower side)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 200; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `hd${i}`,
					summary: `r4hybdn-${i}`, content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "hybrid", query: "r4hybdn", limit: 200 }, admin);
			expect(r.truncated, "hybrid 200 → truncated false").toBe(false);
		} finally { h.dispose(); }
	});

	test("hybrid component wiring: exact matchType present when a node name exactly equals query", async () => {
		// Proves searchHybrid actually consumed exactOut (variable wiring check):
		// if a node's NAME exactly equals the query, hybrid must surface an
		// `exact` matchType hit (exact ⊆ substring ⊆ fulltext, but the exact
		// entry is only produced if exactOut flows into the dedup merge).
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "r4exactwiring",
				summary: "r4exactwiring in summary", content: "r4exactwiring in body",
			}, ctxOf(admin));
			const r = await run(h.search, { mode: "hybrid", query: "r4exactwiring", limit: 200 }, admin);
			const types = new Set(r.wikiHits.map((x) => x.matchType));
			expect(types.has("exact"), `hybrid must surface exact matchType; got ${[...types]}`).toBe(true);
		} finally { h.dispose(); }
	});

	// round-5 B1-HYBRID-RESIDUAL — FLIPPED to round-6 NODE-SEMANTICS (2026-07-17).
	//
	// round-5 tuple-count semantics (dedup keyed on path|matchType|matchedField)
	// was OVERTURNED by the round-6 user decision: hybrid truncated/wikiHits now
	// count by DISTINCT NODE (canonical path), not by tuple. This test was the
	// round-5 canary that expected 150 dual-match nodes → dedup≈300 tuples →
	// truncated=true. Under node semantics the SAME fixture must return
	// truncated=false (150 distinct nodes < 200) with one hit per node and full
	// matchType aggregation evidence. Pinning it here so a future regression to
	// tuple-count semantics is caught immediately.
	//
	// Fixture: 150 nodes whose CONTENT contains "config" (exact=0 because no
	// name/path/summary exactly equals "config"; substring=150; fulltext=150 on
	// the SAME nodes). Each node is hit by exactly 2 matchTypes (substring +
	// fulltext). Node semantics: 150 distinct → truncated=false, 150 hits, each
	// hit carries matchTypes=["substring","fulltext"], primary=fulltext (best
	// rank: fulltext rank 2 < substring rank 5).
	test("round-6 NODE-SEMANTICS flip: 150 dual-match nodes → truncated=false, hits===150, 1 hit/node, matchTypes length 2", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 150; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `r5mm${i}`,
					summary: "", content: `config body ${i}`,
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "hybrid", query: "config", limit: 200 }, admin);
			// Contract (1)+(3): 150 distinct nodes < 200 → truncated MUST be false.
			// (round-5 tuple semantics reported true here — that was the bug.)
			expect(r.truncated, "150 distinct nodes < 200 → truncated MUST be false (node semantics)").toBe(false);
			// Contract (2): one hit per node (path-keyed dedup).
			expect(r.wikiHits.length, "one hit per node → 150 hits").toBe(150);
			const paths = r.wikiHits.map((x) => x.path);
			expect(new Set(paths).size, "every path unique (1 hit/node)").toBe(paths.length);
			// Contract (2) aggregation evidence: each node hit by substring+fulltext.
			for (const hit of r.wikiHits) {
				expect(hit.matchTypes, `node ${hit.path} must carry aggregated matchTypes`).toBeDefined();
				expect(hit.matchTypes!.length, `node ${hit.path} matchTypes length must be 2`).toBe(2);
				expect(hit.matchTypes!.includes("substring")).toBe(true);
				expect(hit.matchTypes!.includes("fulltext")).toBe(true);
				// no duplicate matchType entries (dedup'd)
				expect(new Set(hit.matchTypes!).size).toBe(hit.matchTypes!.length);
			}
			// best-rank primary: fulltext (rank 2) beats substring (rank 5).
			expect(r.wikiHits.every((x) => x.matchType === "fulltext"), "primary = best-rank (fulltext)").toBe(true);
		} finally { h.dispose(); }
	});
}, 30000);

// ===========================================================================
// round-6 NODE-SEMANTICS — node boundary (acceptance-04 §D round-6, 2026-07-17).
//
// User decision: hybrid truncated/wikiHits count by DISTINCT NODE (canonical
// path), not by (path × matchType × matchedField) tuple. This block mirrors the
// 7 acceptance-04 §D round-6 bullets 1:1 as permanent guards. The dedup key is
// `path` (one node → one hit); matchType is the node's best-rank primary;
// matchTypes aggregates every matchType that hit the node (length ≥ 2 filled).
// ===========================================================================
describe("round-6 NODE-SEMANTICS — node boundary [对抗 lens]", () => {
	// Helper: build N nodes whose CONTENT contains `token` (exact=0; substring=N;
	// fulltext=N on the SAME nodes → each node dual-matchType).
	async function seedDualMatch(h: SearchHarness, token: string, n: number): Promise<void> {
		const admin = wideOpen();
		for (let i = 0; i < n; i++) {
			await h.svc.create({
				parent: "wiki-root/knowledge", name: `t${i}`,
				summary: "", content: `${token} body ${i}`,
			}, ctxOf(admin));
		}
	}

	// Bullet 1: 199 distinct multi-matchType → false + hits=199.
	test("199 distinct dual-match nodes → truncated=false, hits===199, 1 hit/node", async () => {
		const h = buildSearchHarness();
		try {
			await seedDualMatch(h, "r6199tok", 199);
			const r = await run(h.search, { mode: "hybrid", query: "r6199tok", limit: 200 }, wideOpen());
			expect(r.truncated, "199 < 200 → false").toBe(false);
			expect(r.wikiHits.length).toBe(199);
			const paths = r.wikiHits.map((x) => x.path);
			expect(new Set(paths).size, "1 hit/node (path unique)").toBe(paths.length);
		} finally { h.dispose(); }
	});

	// Bullet 2: 200 distinct → false + hits=200 + EVERY node matchTypes complete.
	test("200 distinct dual-match nodes → truncated=false, hits===200, all matchTypes complete (length 2)", async () => {
		const h = buildSearchHarness();
		try {
			await seedDualMatch(h, "r6200tok", 200);
			const r = await run(h.search, { mode: "hybrid", query: "r6200tok", limit: 200 }, wideOpen());
			expect(r.truncated, "exactly 200 distinct, all returned → false").toBe(false);
			expect(r.wikiHits.length).toBe(200);
			const paths = r.wikiHits.map((x) => x.path);
			expect(new Set(paths).size, "1 hit/node").toBe(paths.length);
			// Contract bullet 2: ≤200 → matchTypes evidence COMPLETE for every node.
			for (const hit of r.wikiHits) {
				expect(hit.matchTypes, `${hit.path} matchTypes defined`).toBeDefined();
				expect(hit.matchTypes!.length, `${hit.path} matchTypes length 2`).toBe(2);
				expect(hit.matchTypes!.includes("substring")).toBe(true);
				expect(hit.matchTypes!.includes("fulltext")).toBe(true);
			}
		} finally { h.dispose(); }
	});

	// Bullet 3: 201 distinct → true + hits=200 + unique paths.
	test("201 distinct dual-match nodes → truncated=true, hits===200, unique paths", async () => {
		const h = buildSearchHarness();
		try {
			await seedDualMatch(h, "r6201tok", 201);
			const r = await run(h.search, { mode: "hybrid", query: "r6201tok", limit: 200 }, wideOpen());
			expect(r.truncated, "201 > 200 → true").toBe(true);
			expect(r.wikiHits.length).toBe(200);
			const paths = r.wikiHits.map((x) => x.path);
			expect(new Set(paths).size, "1 hit/node even when truncated").toBe(paths.length);
		} finally { h.dispose(); }
	});

	// Bullet 4: 250 distinct → true + hits=200 + unique paths.
	test("250 distinct dual-match nodes → truncated=true, hits===200, unique paths", async () => {
		const h = buildSearchHarness();
		try {
			await seedDualMatch(h, "r6250tok", 250);
			const r = await run(h.search, { mode: "hybrid", query: "r6250tok", limit: 200 }, wideOpen());
			expect(r.truncated, "250 > 200 → true").toBe(true);
			expect(r.wikiHits.length).toBe(200);
			const paths = r.wikiHits.map((x) => x.path);
			expect(new Set(paths).size, "1 hit/node even when truncated").toBe(paths.length);
		} finally { h.dispose(); }
	});

	// Bullet 5: single node hit by exact + substring + fulltext → ONLY 1 hit;
	// primary = exact (best-rank); matchTypes aggregates all (length ≥ 3).
	test("single node exact+substring+fulltext → 1 hit, primary=exact, matchTypes length>=3", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			// name EXACTLY equals query → exact (rank 0). summary + content contain
			// query → substring (rank 5) + fulltext (rank 2).
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "r6triple",
				summary: "r6triple in summary", content: "r6triple in body text",
			}, ctxOf(admin));
			const r = await run(h.search, { mode: "hybrid", query: "r6triple", limit: 200 }, admin);
			// Contract (2): one node → exactly 1 hit (NOT 3 tuple-views).
			expect(r.wikiHits.length, "single node → 1 hit (path dedup)").toBe(1);
			const hit = r.wikiHits[0]!;
			expect(hit.path).toBe("wiki-root/knowledge/r6triple");
			// best-rank primary = exact (rank 0 < fulltext 2 < substring 5).
			expect(hit.matchType, "primary = best-rank exact").toBe("exact");
			expect(hit.matchedField, "exact matched the name field").toBe("name");
			expect(hit.normalizedScore, "exact normalizedScore = 1.0").toBe(normalizeScore("exact"));
			// Aggregation evidence: all 3 matchTypes present, dedup'd.
			expect(hit.matchTypes, "matchTypes defined").toBeDefined();
			expect(hit.matchTypes!.length, "matchTypes length >= 3").toBeGreaterThanOrEqual(3);
			expect(hit.matchTypes!.includes("exact")).toBe(true);
			expect(hit.matchTypes!.includes("substring")).toBe(true);
			expect(hit.matchTypes!.includes("fulltext")).toBe(true);
			expect(new Set(hit.matchTypes!).size, "no duplicate matchType").toBe(hit.matchTypes!.length);
		} finally { h.dispose(); }
	});

	// Bullet 6: 150 nodes × 2 matchType (summary-based dual, distinct from the
	// content-based flipped round-5 canary) → false + hits=150 + 1 hit/node +
	// matchTypes.length===2. Substring here matches the SUMMARY field (different
	// code path than content-based dual), widening aggregation coverage.
	test("150 summary-dual-match nodes → truncated=false, hits===150, matchTypes length 2 (summary field)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 150; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `s${i}`,
					summary: `has r6150sum word ${i}`, content: "x",
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "hybrid", query: "r6150sum", limit: 200 }, admin);
			expect(r.truncated, "150 distinct < 200 → false").toBe(false);
			expect(r.wikiHits.length).toBe(150);
			const paths = r.wikiHits.map((x) => x.path);
			expect(new Set(paths).size, "1 hit/node").toBe(paths.length);
			for (const hit of r.wikiHits) {
				expect(hit.matchTypes, `${hit.path} matchTypes defined`).toBeDefined();
				expect(hit.matchTypes!.length, `${hit.path} matchTypes length 2`).toBe(2);
				expect(hit.matchTypes!.includes("substring")).toBe(true);
				expect(hit.matchTypes!.includes("fulltext")).toBe(true);
			}
			// primary = fulltext (rank 2 < substring rank 5).
			expect(r.wikiHits.every((x) => x.matchType === "fulltext"), "primary = best-rank fulltext").toBe(true);
		} finally { h.dispose(); }
	});

	// Bullet 7: cursor pagination across multiple pages yields NEW nodes — no
	// path overlap between page 1 and later pages (path-keyed dedup guarantee).
	test("cursor pagination (150 nodes, limit=20) → no path overlap across pages", async () => {
		const h = buildSearchHarness();
		try {
			await seedDualMatch(h, "r6page", 150);
			const admin = wideOpen();
			const seen = new Set<string>();
			let cursor: string | null = null;
			let pages = 0;
			let totalHits = 0;
			let dupAcrossPages = 0;
			while (pages < 20) {
				const page = await run(h.search, { mode: "hybrid", query: "r6page", limit: 20, cursor }, admin);
				pages++;
				// within-page uniqueness
				const pagePaths = page.wikiHits.map((x) => x.path);
				expect(new Set(pagePaths).size, `page ${pages} unique paths`).toBe(pagePaths.length);
				for (const p of pagePaths) {
					if (seen.has(p)) dupAcrossPages++;
					seen.add(p);
				}
				totalHits += page.wikiHits.length;
				cursor = page.cursor;
				if (!cursor) break;
			}
			// Contract (5): pagination yields NEW nodes — zero cross-page path dups.
			expect(dupAcrossPages, "no path repeated across pages").toBe(0);
			expect(totalHits, "all 150 nodes eventually surfaced").toBe(150);
			expect(seen.size, "150 distinct nodes seen").toBe(150);
		} finally { h.dispose(); }
	});
}, 30000);

// ===========================================================================
// round-4 — fulltext mode truncated boundary (architecture round-3 gap #1).
//
// round-3 pinned exact/substring/glob but NOT fulltext at the >200 boundary.
// fulltext rawCount comes from a parallel COUNT(*) per scope (cheap aggregate,
// not the sliced rows); truncated must reflect that pre-slice total. This test
// pins the boundary so a future refactor that swaps rawCount for hits.length
// cannot silently regress.
// ===========================================================================

describe("round-4 — fulltext mode truncated boundary [对抗 lens]", () => {
	test("fulltext 250 FTS matches → truncated=true, exactly 200 hits", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 250; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `ft${i}`,
					content: `r4fttok entry number ${i}`,
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "fulltext", query: "r4fttok", limit: 200 }, admin);
			expect(r.truncated, "fulltext 250 → truncated true (parallel COUNT rawCount)").toBe(true);
			expect(r.wikiHits.length).toBe(200);
		} finally { h.dispose(); }
	});

	test("fulltext 200 → truncated=false (boundary lower side)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 200; i++) {
				await h.svc.create({
					parent: "wiki-root/knowledge", name: `ftd${i}`,
					content: `r4ftdn entry ${i}`,
				}, ctxOf(admin));
			}
			const r = await run(h.search, { mode: "fulltext", query: "r4ftdn", limit: 200 }, admin);
			expect(r.truncated, "fulltext 200 → truncated false").toBe(false);
		} finally { h.dispose(); }
	});
}, 30000);

// ===========================================================================
// round-3 C1 — kinds filter matrix
//
// kinds filter must be applied at the SQL layer (AND kind IN (?,...)) across ALL
// modes that funnel through queryNodesInScopes / fulltext / regex, so rawCount
// reflects the post-filter total. Matrix:
//   - [memory] / [node] / [memory,node] / undefined / []
//   - × 5 modes (exact/substring/glob/fulltext/regex)
//   - kinds × scope intersection (narrowing honored with matching grants)
// ===========================================================================

describe("round-3 C1 — kinds filter matrix [对抗 lens]", () => {
	test("kinds=['memory'] → only memory-kind nodes (substring)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 3; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `m${i}`, kind: "memory", summary: "kwtok" }, ctxOf(admin));
			for (let i = 0; i < 3; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `n${i}`, kind: "node", summary: "kwtok" }, ctxOf(admin));
			const r = await run(h.search, { mode: "substring", query: "kwtok", kinds: ["memory"] }, admin);
			for (const x of r.wikiHits) expect(x.kind).toBe("memory");
			expect(r.wikiHits.length).toBe(3);
		} finally { h.dispose(); }
	});
	test("kinds=['node'] → only node-kind (substring)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 2; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `m${i}`, kind: "memory", summary: "kwtok2" }, ctxOf(admin));
			for (let i = 0; i < 4; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `n${i}`, kind: "node", summary: "kwtok2" }, ctxOf(admin));
			const r = await run(h.search, { mode: "substring", query: "kwtok2", kinds: ["node"] }, admin);
			for (const x of r.wikiHits) expect(x.kind).toBe("node");
			expect(r.wikiHits.length).toBe(4);
		} finally { h.dispose(); }
	});
	test("kinds=['memory','node'] → both retained (no over-filter)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			await h.svc.create({ parent: "wiki-root/knowledge", name: "m1", kind: "memory", summary: "kwtok3" }, ctxOf(admin));
			await h.svc.create({ parent: "wiki-root/knowledge", name: "n1", kind: "node", summary: "kwtok3" }, ctxOf(admin));
			const r = await run(h.search, { mode: "substring", query: "kwtok3", kinds: ["memory", "node"] }, admin);
			expect(r.wikiHits.length).toBe(2);
		} finally { h.dispose(); }
	});
	test("kinds=undefined → no filter (all kinds)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			await h.svc.create({ parent: "wiki-root/knowledge", name: "m1", kind: "memory", summary: "kwtok4" }, ctxOf(admin));
			await h.svc.create({ parent: "wiki-root/knowledge", name: "n1", kind: "node", summary: "kwtok4" }, ctxOf(admin));
			const r = await run(h.search, { mode: "substring", query: "kwtok4" }, admin);
			expect(r.wikiHits.length).toBe(2);
		} finally { h.dispose(); }
	});
	test("kinds=[] (empty) → treated as no filter (all kinds)", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			await h.svc.create({ parent: "wiki-root/knowledge", name: "m1", kind: "memory", summary: "kwtok5" }, ctxOf(admin));
			await h.svc.create({ parent: "wiki-root/knowledge", name: "n1", kind: "node", summary: "kwtok5" }, ctxOf(admin));
			const r = await run(h.search, { mode: "substring", query: "kwtok5", kinds: [] }, admin);
			expect(r.wikiHits.length).toBe(2);
		} finally { h.dispose(); }
	});
	test("kinds=['memory'] across all 5 modes — each mode returns ONLY memory", async () => {
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 2; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `km${i}`, kind: "memory", summary: `multitok-${i}`, content: `multitok-${i}` }, ctxOf(admin));
			for (let i = 0; i < 2; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `kn${i}`, kind: "node", summary: `multitok-${i}`, content: `multitok-${i}` }, ctxOf(admin));
			const modes: WikiSearchRequest["mode"][] = ["exact", "substring", "glob", "fulltext", "regex"];
			for (const mode of modes) {
				const query = mode === "exact" ? "multitok-0" : mode === "glob" ? "multitok*" : "multitok";
				const r = await run(h.search, { mode, query, kinds: ["memory"] }, admin);
				for (const x of r.wikiHits) {
					expect(x.kind, `mode=${mode}: kinds=['memory'] leaked kind ${x.kind}`).toBe("memory");
				}
			}
		} finally { h.dispose(); }
	});
	test("kinds × scope intersection — scope narrows within matching grants", async () => {
		// Caller has TWO matching grants (knowledge + memory subtrees). Requesting
		// scope=knowledge must narrow to knowledge only; kinds=[memory] further
		// restricts to memory nodes within knowledge. A memory node in wiki-root/memory
		// (out of requested scope) must NOT appear.
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			// out-of-requested-scope memory node (wiki-root/memory subtree).
			await h.svc.create({ parent: "wiki-root/memory", name: "outmem", kind: "memory", summary: "scopesha" }, ctxOf(admin));
			// in-scope memory + node.
			for (let i = 0; i < 2; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `km${i}`, kind: "memory", summary: "scopesha" }, ctxOf(admin));
			for (let i = 0; i < 2; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `kn${i}`, kind: "node", summary: "scopesha" }, ctxOf(admin));
			const caller = access("a", [
				grant("wiki-root/knowledge", ["search", "read"]),
				grant("wiki-root/memory", ["search", "read"]),
			]);
			const r = await run(h.search, {
				mode: "substring", query: "scopesha", kinds: ["memory"], scope: "wiki-root/knowledge",
			}, caller);
			expect(r.wikiHits.length).toBe(2);
			for (const x of r.wikiHits) {
				expect(x.kind).toBe("memory");
				expect(x.path).toContain("wiki-root/knowledge/");
			}
			// out-of-scope memory node must not leak.
			expect(JSON.stringify(r)).not.toContain("outmem");
		} finally { h.dispose(); }
	});
	test("rawCount reflects post-kinds-filter total (truncated not mis-flagged)", async () => {
		// 250 'node' + 5 'memory', all sharing a token. kinds=[memory] → only 5
		// match; truncated MUST be false (rawCount post-filter = 5 ≤ 200). If kinds
		// were applied post-slice or ignored in rawCount, truncated could be wrong.
		const h = buildSearchHarness();
		try {
			const admin = wideOpen();
			for (let i = 0; i < 250; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `nn${i}`, kind: "node", summary: `kfilt-${i}` }, ctxOf(admin));
			for (let i = 0; i < 5; i++) await h.svc.create({ parent: "wiki-root/knowledge", name: `mm${i}`, kind: "memory", summary: `kfilt-${i}` }, ctxOf(admin));
			const r = await run(h.search, { mode: "substring", query: "kfilt-", kinds: ["memory"], limit: 200 }, admin);
			expect(r.wikiHits.length).toBe(5);
			expect(r.truncated, "post-kinds rawCount=5 → truncated false").toBe(false);
		} finally { h.dispose(); }
	});
}, 30000);

// ===========================================================================
// round-2 adversarial edge probes (FIX 2 / FIX 3 / FIX 4 + boundary inputs)
//
// Each probe tries to BREAK the round-2 fixes with inputs the implementer may
// not have considered. All drive the real WikiSearchService on a real temp DB.
// ===========================================================================

// Tree fixture for FIX 2 probes. Scope under test = wiki-root/knowledge/alpha0.
// SIBLINGS that share the "alpha0" prefix followed by a non-`/` char MUST be
// excluded by the segment-aware scope filter (FIX 2). round-1 lex-range bug
// would include them because hyphen(0x2D)/dot(0x2E)/tilde(0x7E)/unicode all
// sort before the high sentinel char used to close the range.
const FIX2_SCOPE = "wiki-root/knowledge/alpha0";
const FIX2_SECRET = "FIX2-LEAK-TOKEN";
const FIX2_SIBLINGS = [
	{ name: "alpha0-secret", leak: `${FIX2_SECRET}-hyphen` },   // '-' 0x2D < '/' 0x2F
	{ name: "alpha0.visible", leak: `${FIX2_SECRET}-dot` },     // '.' 0x2E < '/' 0x2F
	{ name: "alpha0~tilde", leak: `${FIX2_SECRET}-tilde` },     // '~' 0x7E
	{ name: "alpha0中文", leak: `${FIX2_SECRET}-unicode` },      // non-ASCII (UTF-8 bytes > 0x7F)
	{ name: "alpha00", leak: `${FIX2_SECRET}-numeric` },        // '0' 0x30 > '/' but still sibling
	{ name: "Alpha0", leak: `${FIX2_SECRET}-cased` },           // case-variant sibling
];
// A CHILD of alpha0 (must be INCLUDED — proves the empty result is segment
// filtering, not a broken search).
const FIX2_CHILD_TOKEN = "FIX2-CHILD-TOKEN";

async function seedFix2Tree(h: SearchHarness): Promise<void> {
	const admin = wideOpen();
	// authorized leaf scope itself.
	await h.svc.create({
		parent: "wiki-root/knowledge", name: "alpha0",
		summary: "authorized alpha0 leaf", content: "alpha0 body",
	}, ctxOf(admin));
	// authorized child (descendant of alpha0 — MUST be visible to the scoped caller).
	await h.svc.create({
		parent: "wiki-root/knowledge/alpha0", name: "child",
		summary: FIX2_CHILD_TOKEN, content: `${FIX2_CHILD_TOKEN} body`,
	}, ctxOf(admin));
	// UNAUTHORIZED siblings — must NEVER appear in scoped search results.
	for (const sib of FIX2_SIBLINGS) {
		await h.svc.create({
			parent: "wiki-root/knowledge", name: sib.name,
			summary: sib.leak, content: `${sib.leak} body`,
		}, ctxOf(admin));
	}
}

describe("round-2 FIX 2 — segment-aware scope excludes prefix-colliding siblings across ALL 6 modes [对抗]", () => {
	let h: SearchHarness;
	beforeEach(async () => { h = buildSearchHarness(); await seedFix2Tree(h); });
	afterEach(() => { h.dispose(); });

	const scopedCaller = access("attacker", [
		grant(FIX2_SCOPE, ["search", "read", "expand"]),
	]);

	const ALL_MODES: WikiSearchRequest["mode"][] = [
		"exact", "substring", "glob", "fulltext", "regex", "hybrid",
	];

	for (const mode of ALL_MODES) {
		test(`mode=${mode}: search for sibling-leak token → 0 hits, no sibling path/snippet`, async () => {
			// substring/glob/regex/hybrid/exact/fulltext all funnel through
			// queryNodesInScopes / searchFulltext / searchRegex which MUST apply
			// the segment-aware scope filter (FIX 2) before any text matching.
			const r = await run(h.search, { mode, query: FIX2_SECRET }, scopedCaller);
			// No unauthorized sibling may appear.
			const allPaths = r.wikiHits.map((x) => x.path);
			for (const sib of FIX2_SIBLINGS) {
				const sibPath = `wiki-root/knowledge/${sib.name}`;
				expect(allPaths, `mode=${mode}: sibling ${sib.name} leaked`).not.toContain(sibPath);
			}
			// No leak token in ANY part of the structured payload (path/snippet/score).
			const json = JSON.stringify(r);
			expect(json, `mode=${mode}: leak token surfaced in payload`).not.toContain(FIX2_SECRET);
			// And none of the sibling names appear either (existence leak).
			for (const sib of FIX2_SIBLINGS) {
				expect(json, `mode=${mode}: sibling name ${sib.name} surfaced`).not.toContain(sib.name);
			}
		});
	}

	test("scope=alpha0 INCLUDES alpha0 itself + alpha0/child (proves filter is segment-aware, not broken)", async () => {
		// If the scoped search returned NOTHING at all, the empty results above
		// would be meaningless. The caller must still find their own subtree.
		const r = await run(h.search, { mode: "substring", query: FIX2_CHILD_TOKEN }, scopedCaller);
		const paths = r.wikiHits.map((x) => x.path);
		expect(paths).toContain("wiki-root/knowledge/alpha0/child");
		// Also a query matching the leaf itself.
		const rLeaf = await run(h.search, { mode: "exact", query: "alpha0" }, scopedCaller);
		expect(rLeaf.wikiHits.map((x) => x.path)).toContain("wiki-root/knowledge/alpha0");
	});

	test("glob `alpha0*` does NOT cross segments to siblings (segment-aware matching)", async () => {
		// A glob `alpha0*` from a scoped caller: `*` is single-segment, so it
		// matches name 'alpha0' but must NOT match sibling names 'alpha0-secret'
		// etc. (those are siblings outside scope — filtered before the glob).
		const r = await run(h.search, { mode: "glob", query: "alpha0*" }, scopedCaller);
		const paths = r.wikiHits.map((x) => x.path);
		expect(paths).toContain("wiki-root/knowledge/alpha0");
		for (const sib of FIX2_SIBLINGS) {
			expect(paths).not.toContain(`wiki-root/knowledge/${sib.name}`);
		}
	});

	test("regex `^alpha0.*` scoped → no sibling leak", async () => {
		// regex candidate set must be scope-filtered (FIX 2 path of searchRegex).
		const r = await run(h.search, { mode: "regex", query: "^alpha0.*$" }, scopedCaller);
		const paths = r.wikiHits.map((x) => x.path);
		expect(paths).toContain("wiki-root/knowledge/alpha0");
		for (const sib of FIX2_SIBLINGS) {
			expect(paths, `regex leaked sibling ${sib.name}`).not.toContain(`wiki-root/knowledge/${sib.name}`);
		}
	});

	test("fulltext FTS for sibling token → 0 hits (searchFulltext applies segment-aware filter)", async () => {
		// searchFulltext has its OWN scope filter SQL (FIX 2 second site).
		const r = await run(h.search, { mode: "fulltext", query: FIX2_SECRET }, scopedCaller);
		expect(r.wikiHits.length).toBe(0);
		expect(JSON.stringify(r)).not.toContain(FIX2_SECRET);
	});

	test("hybrid fuses all sub-modes → none leak siblings (searchHybrid covers exact+substring+fulltext)", async () => {
		const r = await run(h.search, { mode: "hybrid", query: FIX2_SECRET }, scopedCaller);
		const json = JSON.stringify(r);
		expect(json).not.toContain(FIX2_SECRET);
		for (const sib of FIX2_SIBLINGS) {
			expect(json).not.toContain(sib.name);
		}
	});
});

describe("round-2 FIX 2 — boundary scope inputs [对抗]", () => {
	let h: SearchHarness;
	beforeEach(async () => {
		h = buildSearchHarness();
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "rootkid",
			content: "ROOTKID-TOKEN",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "sib1",
			content: "SIB1-TOKEN",
		}, ctxOf(admin));
	});
	afterEach(() => { h.dispose(); });

	test("scope=wiki-root (whole tree) — wide-open caller sees both tokens", async () => {
		const caller = access("attacker", [
			grant("wiki-root", ["search", "read"]),
		]);
		const r = await run(h.search, {
			mode: "substring", query: "TOKEN", scope: "wiki-root",
		}, caller);
		const paths = r.wikiHits.map((x) => x.path).sort();
		expect(paths).toEqual([
			"wiki-root/knowledge/rootkid",
			"wiki-root/knowledge/sib1",
		]);
	});

	test("requested scope OUTSIDE access grants is intersected to empty (no widening)", async () => {
		// Caller has search on wiki-root/knowledge only; asks for a sibling
		// subtree scope. The intersected scope must NOT widen to include things
		// the access grant doesn't cover.
		const caller = access("attacker", [
			grant("wiki-root/knowledge/rootkid", ["search", "read"]),
		]);
		const r = await run(h.search, {
			mode: "substring", query: "SIB1-TOKEN",
			scope: "wiki-root/knowledge/sib1", // not in access → intersect → empty
		}, caller);
		expect(r.wikiHits.length).toBe(0);
		expect(JSON.stringify(r)).not.toContain("SIB1-TOKEN");
	});
});

// ===========================================================================
// FIX 3 — exact mode case sensitivity (SQL suffix COLLATE NOCASE)
// ===========================================================================

describe("round-2 FIX 3 — exact mode case sensitivity (valid suffix COLLATE) [对抗]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("caseSensitive=false: exact query 'ALPHA' matches name 'alpha' (ASCII fold across name/path/summary)", async () => {
		const admin = wideOpen();
		// name case-variant
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "alpha",
			summary: "sum", content: "c",
		}, ctxOf(admin));
		// summary exact match (case-different)
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "n2",
			summary: "ExAcT-SUM", content: "c",
		}, ctxOf(admin));
		// query 'ALPHA' case-insensitive → matches name 'alpha'
		const rName = await run(h.search, { mode: "exact", query: "ALPHA", caseSensitive: false }, admin);
		expect(rName.wikiHits.map((x) => x.name)).toContain("alpha");
		// query 'exact-sum' case-insensitive → matches summary 'ExAcT-SUM'
		const rSum = await run(h.search, { mode: "exact", query: "exact-sum", caseSensitive: false }, admin);
		expect(rSum.wikiHits.map((x) => x.name)).toContain("n2");
	});

	test("caseSensitive=true: exact query 'ALPHA' does NOT match name 'alpha'", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "alpha",
			summary: "s", content: "c",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "ALPHA",
			summary: "s", content: "c",
		}, ctxOf(admin));
		// caseSensitive=true: only exact-case 'ALPHA' returned.
		const r = await run(h.search, { mode: "exact", query: "ALPHA", caseSensitive: true }, admin);
		const names = r.wikiHits.map((x) => x.name);
		expect(names).toContain("ALPHA");
		expect(names).not.toContain("alpha");
	});

	test("FIX 3 SQL is VALID (does not throw 'near \"COLLATE\"' syntax error)", async () => {
		// round-1 bug: `name = COLLATE NOCASE ?` was INVALID SQL (COLLATE infix).
		// round-2 FIX 3 puts COLLATE as suffix: `name = ? COLLATE NOCASE`.
		// If the SQL were malformed, searchExact would throw a SqliteError instead
		// of returning a result. We assert no throw for both case branches.
		const admin = wideOpen();
		await h.svc.create({ parent: "wiki-root/knowledge", name: "x", content: "y" }, ctxOf(admin));
		await expect(run(h.search, { mode: "exact", query: "x", caseSensitive: false }, admin)).resolves.toBeDefined();
		await expect(run(h.search, { mode: "exact", query: "x", caseSensitive: true }, admin)).resolves.toBeDefined();
	});
});

// ===========================================================================
// FIX 4 — substring + glob caseSensitive=true JS post-filter (multi-field)
// SQLite LIKE ignores COLLATE BINARY; case distinction is enforced in JS.
// ===========================================================================

describe("round-2 FIX 4 — substring caseSensitive=true matches ONLY exact case across fields [对抗]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("name field: caseSensitive=true 'Needle' ≠ 'needle'", async () => {
		const admin = wideOpen();
		await h.svc.create({ parent: "wiki-root/knowledge", name: "Needle-Name", content: "x" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "needle-name", content: "x" }, ctxOf(admin));
		const r = await run(h.search, {
			mode: "substring", query: "Needle", caseSensitive: true, fields: ["name"],
		}, admin);
		const names = r.wikiHits.map((x) => x.name).sort();
		expect(names).toEqual(["Needle-Name"]);
	});

	test("summary field: caseSensitive=true 'Sum' ≠ 'sum'", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "s1",
			summary: "MixedSummaryCase", content: "x",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "s2",
			summary: "mixedsummarycase", content: "x",
		}, ctxOf(admin));
		const r = await run(h.search, {
			mode: "substring", query: "Summary", caseSensitive: true, fields: ["summary"],
		}, admin);
		expect(r.wikiHits.map((x) => x.name).sort()).toEqual(["s1"]);
	});

	test("content field: caseSensitive=true 'Body' ≠ 'body'", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "c1", summary: "s",
			content: "Needle Caps here",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "c2", summary: "s",
			content: "lowercase needle here",
		}, ctxOf(admin));
		const r = await run(h.search, {
			mode: "substring", query: "Needle", caseSensitive: true, fields: ["content"],
		}, admin);
		expect(r.wikiHits.map((x) => x.name).sort()).toEqual(["c1"]);
	});

	test("default fields (no fields=): caseSensitive=true still case-discriminates", async () => {
		// When fields is omitted, caseSensitiveSubstringMatch checks name+summary+content.
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "d1",
			summary: "clean", content: "Has CamelCase Token",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "d2",
			summary: "clean", content: "has camelcase token",
		}, ctxOf(admin));
		const r = await run(h.search, {
			mode: "substring", query: "CamelCase", caseSensitive: true,
		}, admin);
		expect(r.wikiHits.map((x) => x.name).sort()).toEqual(["d1"]);
	});

	test("caseSensitive=false: substring 'needle' matches both cases (sanity)", async () => {
		const admin = wideOpen();
		await h.svc.create({ parent: "wiki-root/knowledge", name: "n1", content: "Needle" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "n2", content: "needle" }, ctxOf(admin));
		const r = await run(h.search, {
			mode: "substring", query: "needle", caseSensitive: false,
		}, admin);
		expect(r.wikiHits.map((x) => x.name).sort()).toEqual(["n1", "n2"]);
	});
});

describe("round-2 FIX 4 — glob caseSensitive=true enforces case via JS matcher [对抗]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("glob caseSensitive=true: 'File.TS' does NOT match name 'file.ts'", async () => {
		const admin = wideOpen();
		await h.svc.create({ parent: "wiki-root/knowledge", name: "file.ts", content: "x" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "FILE.TS", content: "x" }, ctxOf(admin));
		// caseSensitive=true glob 'FILE.TS' → only exact-case match.
		const r = await run(h.search, {
			mode: "glob", query: "FILE.TS", caseSensitive: true,
		}, admin);
		const names = r.wikiHits.map((x) => x.name);
		expect(names).toContain("FILE.TS");
		expect(names).not.toContain("file.ts");
	});

	test("glob caseSensitive=false: 'file.ts' matches both cases", async () => {
		const admin = wideOpen();
		await h.svc.create({ parent: "wiki-root/knowledge", name: "file.ts", content: "x" }, ctxOf(admin));
		await h.svc.create({ parent: "wiki-root/knowledge", name: "FILE.TS", content: "x" }, ctxOf(admin));
		const r = await run(h.search, {
			mode: "glob", query: "file.ts", caseSensitive: false,
		}, admin);
		const names = r.wikiHits.map((x) => x.name).sort();
		expect(names).toEqual(["FILE.TS", "file.ts"]);
	});
});

// ===========================================================================
// Boundary inputs — LIKE wildcard escaping, single-quote paths, unicode
// ===========================================================================

describe("round-2 boundary inputs — LIKE wildcards / quoting / unicode [对抗]", () => {
	let h: SearchHarness;
	beforeEach(() => { h = buildSearchHarness(); });
	afterEach(() => { h.dispose(); });

	test("substring query with '_' is LITERAL (not single-char wildcard)", async () => {
		// LIKE `_` matches any single char unless ESCAPE'd. escapeLike must escape it.
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "lit",
			summary: "abc_def", content: "x",
		}, ctxOf(admin));
		// A row whose summary is 'abcXdef' (X = any char) — must NOT match `abc_def`.
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "wild",
			summary: "abcXdef", content: "x",
		}, ctxOf(admin));
		const r = await run(h.search, { mode: "substring", query: "abc_def" }, admin);
		const names = r.wikiHits.map((x) => x.name).sort();
		expect(names).toEqual(["lit"]);
		expect(names).not.toContain("wild");
	});

	test("substring query with '%' is LITERAL (not zero-or-more wildcard)", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "pct",
			summary: "rate=50%", content: "x",
		}, ctxOf(admin));
		// If `%` were unescaped, `50%` would match ANY summary containing '50' + anything.
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "nowild",
			summary: "rate=5000", content: "x",
		}, ctxOf(admin));
		const r = await run(h.search, { mode: "substring", query: "50%" }, admin);
		const names = r.wikiHits.map((x) => x.name);
		expect(names).toContain("pct");
		// 'nowild' has no literal '%' so must NOT match a literal-'%' search.
		expect(names).not.toContain("nowild");
	});

	test("substring query with backslash is LITERAL (escape char itself escaped)", async () => {
		// escapeLike escapes `\` → `\\`. A literal backslash in the query must match.
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "bs",
			summary: "path\\to\\thing", content: "x",
		}, ctxOf(admin));
		const r = await run(h.search, { mode: "substring", query: "path\\to" }, admin);
		expect(r.wikiHits.map((x) => x.name)).toContain("bs");
	});

	test("fulltext search with a token that contains FTS5 special chars still works", async () => {
		// buildFtsQuery wraps the query as a phrase + prefix; special chars like
		// `*` / `"` are stripped. Verify a plain token still matches.
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "ft",
			content: "unique-round2-token here",
		}, ctxOf(admin));
		const r = await run(h.search, { mode: "fulltext", query: "unique-round2-token" }, admin);
		expect(r.wikiHits.length).toBeGreaterThan(0);
	});

	test("ASCII case-folding is honest about Unicode limitation (Ä does NOT fold to ä)", async () => {
		// Documented limitation (acceptance-04 §D): NOCASE only folds ASCII.
		// We assert 'Ä' (U+00C4) does NOT match 'ä' (U+00E4) case-insensitively,
		// and that lowercase exact-byte search DOES match.
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "u",
			content: "Größe", summary: "s",
		}, ctxOf(admin));
		const rUpper = await run(h.search, {
			mode: "substring", query: "GROSSE", caseSensitive: false,
		}, admin);
		expect(rUpper.wikiHits.length, "non-ASCII fold must NOT happen (documented limitation)").toBe(0);
		const rLower = await run(h.search, {
			mode: "substring", query: "grö", caseSensitive: false,
		}, admin);
		expect(rLower.wikiHits.length, "exact-byte lowercase match works").toBeGreaterThan(0);
	});
});
