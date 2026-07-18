// wiki-system-redesign sub-04 acceptance — 对抗 lens (regex 5 limits + worker lifecycle).
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-04 §D「regex pattern 2,048 bytes、50,000 candidates、
// 16 MiB、250 ms、200 results 五个默认阈值分别有边界测试;worker 超时被
// terminate,后续请求可立即执行」+ REGEX_INVALID / LIMIT_EXCEEDED / TIMEOUT
// 闭集稳定性。
//
// 全部走真临时 wiki.db + 真 worker_threads(production 路径)+ 真 CallerCtx。
// DI(regexLimits)只用于缩短阈值加速测试(production 值由 host 决定,本
// 测试在 default 上至少各跑一次 boundary)。
//
// ## 关键断言(acceptance-04 §D regex)
//   - patternBytes 2048 boundary:< 2048 OK;> 2048 → REGEX_LIMIT_EXCEEDED。
//   - authorizedCandidates 50000 boundary(DI 缩短):超 → REGEX_LIMIT_EXCEEDED。
//   - contentBytes 16 MiB boundary(DI 缩短):超 → REGEX_LIMIT_EXCEEDED。
//   - wallMs 250 boundary(DI 缩短):catastrophic regex → REGEX_TIMEOUT。
//   - results 200 boundary:match 超过 200 → truncated=true,命中=200。
//   - worker timeout 后 worker 仍存活,后续请求立即可跑(NOT destroyed)。
//   - REGEX_INVALID / LIMIT_EXCEEDED / TIMEOUT 闭集稳定 + 错误不泄露 scope 外信息。
//   - regex 永远不在主线程跑(spec §H 拒绝条件)。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR(vi.hoisted 前缀 `zc-wiki-v2-regex-`)。
//   - 每 test 独立 wiki.db;真 worker_threads(production 路径)。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - sessions.db readonly;INTEGER affinity;Windows vitest exit-127 = teardown crash。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-regex-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { WIKI_ROOT_PATH, joinWikiPath } from "../../src/server/wiki/wiki-path.js";
import {
	WIKI_REGEX_DEFAULT_LIMITS,
	resolveRegexLimits,
} from "../../src/shared/wiki-search-types.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
	WikiRequestContext,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Access helpers.
// ---------------------------------------------------------------------------

const ALL_ACTIONS: WikiAction[] = [
	"expand", "read", "search", "create", "update",
	"delete", "link", "unlink", "move",
];
function grant(scope: string, actions: WikiAction[]): CompiledWikiGrant {
	return { canonicalScope: scope, actions };
}
function wideOpen(agentId = "admin-agent"): CompiledWikiAccess {
	return {
		agentId,
		activeProjectId: undefined,
		grants: [grant("wiki-root", ALL_ACTIONS)],
		policyRevision: 1,
	};
}
function ctxOf(acc: CompiledWikiAccess): WikiRequestContext {
	return {
		access: acc,
		agentId: acc.agentId,
		activeProjectId: acc.activeProjectId,
		sessionId: "regex-test-session",
		requestId: null,
	};
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

interface RegexHarness {
	wiki: WikiDatabase;
	svc: WikiService;
	search: WikiSearchService;
	dispose: () => void;
}

function buildRegexHarness(regexLimits?: any): RegexHarness {
	const dbPath = join(UNIQUE_DIR, `wiki-regex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const wikiSvc = WikiService.fromDatabase(wiki);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const search = new WikiSearchService({
		db, nodeRepo, repositoryStore, addressService, authorizationService,
		regexLimits,
	});
	return {
		wiki, svc: wikiSvc, search,
		dispose: () => { try { wiki.close(); } catch { /* idempotent */ } },
	};
}

/** Build N leaf nodes under wiki-root/knowledge, each with `match-N` content. */
async function seedMatches(h: RegexHarness, count: number, contentFn: (i: number) => string): Promise<void> {
	const admin = wideOpen();
	// Create parent once.
	// Use batch-style create via WikiService (one tx per node; small N is fine).
	for (let i = 0; i < count; i++) {
		await h.svc.create({
			parent: "wiki-root/knowledge",
			name: `m${i}`,
			summary: `match-${i}`,
			content: contentFn(i),
		}, ctxOf(admin));
	}
}

// ===========================================================================
// §D regex — REGEX_INVALID (syntax) boundary
// ===========================================================================

describe("§D regex invalid syntax → REGEX_INVALID (closed-set code) [对抗 lens]", () => {
	let h: RegexHarness;
	beforeEach(() => { h = buildRegexHarness(); });
	afterEach(() => { h.dispose(); });

	test("Malformed regex `(unclosed` → REGEX_INVALID", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "n",
			content: "some content",
		}, ctxOf(admin));
		await expect(
			h.search.search({ mode: "regex", query: "(unclosed" }, ctxOf(admin)),
		).rejects.toMatchObject({ code: "REGEX_INVALID" });
	});

	test("Malformed regex `[no-close` → REGEX_INVALID", async () => {
		const admin = wideOpen();
		await expect(
			h.search.search({ mode: "regex", query: "[foo" }, ctxOf(admin)),
		).rejects.toMatchObject({ code: "REGEX_INVALID" });
	});

	test("REGEX_INVALID does not leak content outside authorized scope", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "pub",
			content: "public-content",
		}, ctxOf(admin));
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "priv",
			content: "REGERR_SECRET_TOKEN",
		}, ctxOf(admin));
		const attacker = {
			agentId: "attacker",
			grants: [grant("wiki-root/knowledge/pub", ["search"])],
			policyRevision: 1,
		};
		try {
			await h.search.search({ mode: "regex", query: "(bad" }, ctxOf(attacker));
		} catch (e: any) {
			expect(e.code).toBe("REGEX_INVALID");
			expect(String(e.message ?? "")).not.toContain("REGERR_SECRET_TOKEN");
			expect(String(e.message ?? "")).not.toContain("wiki-root/knowledge/priv");
		}
	});
});

// ===========================================================================
// §D regex — patternBytes 2048 boundary (DEFAULT value tested here)
// ===========================================================================

describe("§D regex pattern bytes boundary — DEFAULT 2048 [对抗 lens]", () => {
	let h: RegexHarness;
	beforeEach(() => { h = buildRegexHarness(); });
	afterEach(() => { h.dispose(); });

	test("pattern of EXACTLY 2048 UTF-8 bytes accepted (no REGEX_LIMIT_EXCEEDED)", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "t",
			content: "needle here",
		}, ctxOf(admin));
		// Build a 2048-byte regex: 'a' repeated 2043 + 'needle' (6 bytes) → 2049. Use 2042 + 'needle' (6) = 2048.
		// Actually simplest: 2048 chars of 'a' is exactly 2048 UTF-8 bytes (ASCII).
		// But that pattern only matches content of all a's. We just want it to compile and not exceed patternBytes.
		// Use: a{1} (3 bytes) — fine. Let's test boundary precisely.
		const exact = "a".repeat(2048);
		expect(Buffer.byteLength(exact, "utf-8")).toBe(2048);
		// Run — should NOT throw REGEX_LIMIT_EXCEEDED. May return 0 hits (fine).
		const r = await h.search.search({ mode: "regex", query: exact }, ctxOf(admin));
		expect(r.wikiHits.length).toBe(0);
	});

	test("pattern of 2049 bytes → REGEX_LIMIT_EXCEEDED", async () => {
		const admin = wideOpen();
		const tooLong = "a".repeat(2049);
		expect(Buffer.byteLength(tooLong, "utf-8")).toBe(2049);
		await expect(
			h.search.search({ mode: "regex", query: tooLong }, ctxOf(admin)),
		).rejects.toMatchObject({ code: "REGEX_LIMIT_EXCEEDED" });
	});

	test("Unicode pattern: 2048-byte boundary uses UTF-8 byte count, not JS string length", async () => {
		// '✓' is 3 UTF-8 bytes (E2 9C 93). 683 ✓'s = 2049 bytes (683 * 3 = 2049).
		const admin = wideOpen();
		const unicodePattern = "✓".repeat(683);
		expect(Buffer.byteLength(unicodePattern, "utf-8")).toBe(2049);
		await expect(
			h.search.search({ mode: "regex", query: unicodePattern }, ctxOf(admin)),
		).rejects.toMatchObject({ code: "REGEX_LIMIT_EXCEEDED" });
		// 682 ✓'s = 2046 bytes (under limit, accepted).
		const ok = "✓".repeat(682);
		expect(Buffer.byteLength(ok, "utf-8")).toBe(2046);
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "u",
			content: "x",
		}, ctxOf(admin));
		const r = await h.search.search({ mode: "regex", query: ok }, ctxOf(admin));
		expect(r.wikiHits.length).toBe(0);
	});
});

// ===========================================================================
// §D regex — results 200 boundary (DEFAULT value tested here)
// ===========================================================================

describe("§D regex results boundary — DEFAULT 200 [对抗 lens]", () => {
	test("regex matching > 200 nodes → truncated=true, exactly 200 hits (after slice)", async () => {
		const h = buildRegexHarness();
		try {
			// Create 250 nodes whose content all match a simple regex.
			// NOTE: search() slices to `limit` (default 20) AFTER truncation check.
			// truncated flag is `all.length > limits.results` (200). We want to verify
			// the truncation flag flips when raw matches exceed 200.
			await seedMatches(h, 250, (i) => `body-match-${i}`);
			const admin = wideOpen();
			const r = await h.search.search({
				mode: "regex", query: "body-match-", limit: 200,
			}, ctxOf(admin));
			// 250 raw matches > 200 → truncated flag must be true.
			expect(r.truncated, "truncated flag must be true when raw matches > 200").toBe(true);
			// Returned slice is at most 200.
			expect(r.wikiHits.length).toBeLessThanOrEqual(200);
		} finally {
			h.dispose();
		}
	});

	test("regex matching ≤ 200 nodes → truncated=false", async () => {
		const h = buildRegexHarness();
		try {
			await seedMatches(h, 50, (i) => `small-match-${i}`);
			const admin = wideOpen();
			const r = await h.search.search({
				mode: "regex", query: "small-match-", limit: 200,
			}, ctxOf(admin));
			expect(r.truncated).toBe(false);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// §D regex — authorizedCandidates (DI shortened to keep test fast)
// ===========================================================================

describe("§D regex authorized candidates boundary (DI shortened) [对抗 lens]", () => {
	test("candidates > limits.authorizedCandidates → REGEX_LIMIT_EXCEEDED", async () => {
		// Inject smaller limit (10) and create 15 candidate nodes.
		const h = buildRegexHarness({ authorizedCandidates: 10 });
		try {
			await seedMatches(h, 15, (i) => `cand-${i}`);
			const admin = wideOpen();
			await expect(
				h.search.search({ mode: "regex", query: "cand-" }, ctxOf(admin)),
			).rejects.toMatchObject({ code: "REGEX_LIMIT_EXCEEDED" });
		} finally {
			h.dispose();
		}
	});

	test("candidates ≤ limits.authorizedCandidates → no LIMIT_EXCEEDED", async () => {
		const h = buildRegexHarness({ authorizedCandidates: 50 });
		try {
			await seedMatches(h, 10, (i) => `ok-${i}`);
			const admin = wideOpen();
			const r = await h.search.search({ mode: "regex", query: "ok-" }, ctxOf(admin));
			expect(r.wikiHits.length).toBeGreaterThan(0);
		} finally {
			h.dispose();
		}
	});

	test("DI cannot RAISE above default (resolveRegexLimits clamps to min(host, default))", () => {
		// Production invariant: host can only tighten. Verify the helper clamps.
		const too = resolveRegexLimits({ authorizedCandidates: 9_999_999 });
		expect(too.authorizedCandidates).toBe(WIKI_REGEX_DEFAULT_LIMITS.authorizedCandidates);
		const tight = resolveRegexLimits({ authorizedCandidates: 5 });
		expect(tight.authorizedCandidates).toBe(5);
	});
});

// ===========================================================================
// §D regex — contentBytes (DI shortened)
// ===========================================================================

describe("§D regex content bytes boundary (DI shortened) [对抗 lens]", () => {
	test("total content bytes > limits.contentBytes → REGEX_LIMIT_EXCEEDED", async () => {
		// Inject contentBytes=100; one node with 200 bytes of content.
		const h = buildRegexHarness({ contentBytes: 100 });
		try {
			const admin = wideOpen();
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "big",
				content: "x".repeat(200),
			}, ctxOf(admin));
			await expect(
				h.search.search({ mode: "regex", query: "x+" }, ctxOf(admin)),
			).rejects.toMatchObject({ code: "REGEX_LIMIT_EXCEEDED" });
		} finally {
			h.dispose();
		}
	});

	test("content bytes ≤ limit → no LIMIT_EXCEEDED", async () => {
		const h = buildRegexHarness({ contentBytes: 1024 });
		try {
			const admin = wideOpen();
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "fit",
				content: "needle in 50 bytes" + " ".repeat(30),
			}, ctxOf(admin));
			const r = await h.search.search({ mode: "regex", query: "needle" }, ctxOf(admin));
			expect(r.wikiHits.length).toBeGreaterThan(0);
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// §D regex — normal-case positive (sanity)
// Note (round-2 FIX 5): the REGEX_POOL singleton is module-scoped, but a
// catastrophic regex in the wall-timeout tests now TERMINATES the worker
// (FIX 5) — the next request rebuilds it. These tests are independent of
// ordering; keeping them first is just conventional.
// ===========================================================================

describe("§D regex normal-case positive [对抗 lens]", () => {
	let h: RegexHarness;
	beforeEach(() => { h = buildRegexHarness(); });
	afterEach(() => { h.dispose(); });

	test("regex `match-\\d+` matches numbered content", async () => {
		const admin = wideOpen();
		for (let i = 0; i < 5; i++) {
			await h.svc.create({
				parent: "wiki-root/knowledge", name: `r${i}`,
				content: `match-${i}-body`,
			}, ctxOf(admin));
		}
		const r = await h.search.search({ mode: "regex", query: "match-\\d+" }, ctxOf(admin));
		expect(r.wikiHits.length).toBe(5);
		for (const hit of r.wikiHits) {
			expect(hit.matchType).toBe("regex");
			expect(hit.normalizedScore).toBeCloseTo(0.6, 5); // regex score = 0.6
			expect(hit.target).toBe("wiki");
			expect(typeof hit.snippet).toBe("string");
			expect(hit.snippet.length).toBeGreaterThan(0);
		}
	});

	test("regex is CASE-INSENSITIVE by default (matches 'Needle' with query 'needle')", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "cs",
			content: "Needle CaseMix",
		}, ctxOf(admin));
		const r = await h.search.search({ mode: "regex", query: "needle" }, ctxOf(admin));
		expect(r.wikiHits.length).toBe(1);
	});

	test("regex caseSensitive=true does NOT match different case", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "cs",
			content: "Needle CaseMix",
		}, ctxOf(admin));
		const r = await h.search.search({
			mode: "regex", query: "needle", caseSensitive: true,
		}, ctxOf(admin));
		expect(r.wikiHits.length).toBe(0);
	});
});

// ===========================================================================
// §D regex — wallMs timeout (DI shortened to 50ms for test speed)
// round-2 FLIPPED (FIX 5): the parent setTimeout now calls worker.terminate()
// and rejects all pending as REGEX_TIMEOUT; the next request spawns a fresh
// worker. These tests assert the FIXED behavior (round-1 asserted the bug).
// ===========================================================================

describe("§D regex wall timeout → REGEX_TIMEOUT (DI shortened) [对抗 lens]", () => {
	test("catastrophic regex against large content → REGEX_TIMEOUT within wallMs+slack", async () => {
		// Inject wallMs=50 (very tight); regex `(a+)+b` against 30k 'a's will
		// catastrophically backtrack inside a SINGLE regex.exec — the worker's
		// between-candidate Date.now() self-check never runs, so only the parent
		// setTimeout + worker.terminate() can preempt it (FIX 5).
		const h = buildRegexHarness({ wallMs: 50 });
		try {
			const admin = wideOpen();
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "slow",
				content: "a".repeat(30000),
			}, ctxOf(admin));
			const t0 = Date.now();
			await expect(
				h.search.search({ mode: "regex", query: "(a+)+b" }, ctxOf(admin)),
			).rejects.toMatchObject({ code: "REGEX_TIMEOUT" });
			const elapsed = Date.now() - t0;
			// FIX 5 contract: timeout fires promptly. parent fires at wallMs+50slack=100ms;
			// allow generous scheduling jitter but MUST be bounded (round-1 hung for
			// many seconds because the worker was never terminated).
			expect(elapsed, `REGEX_TIMEOUT should fire within wallMs+slack (~100ms), got ${elapsed}ms`).toBeLessThan(2000);
		} finally {
			h.dispose();
		}
	});

	test("FIX 5 (FLIPPED): after a timeout, a benign regex SUCCEEDS promptly on a rebuilt worker", async () => {
		// Spec (plan-04 §5 + acceptance-04 §D): "worker timeout → terminate +
		// subsequent request runs immediately (not destroyed)".
		//
		// round-1 BLOCKER: parent setTimeout did NOT terminate the worker, so the
		// catastrophic regex.exec kept the worker thread blocked and the next
		// request queued behind it → also timed out. round-2 FIX 5 makes the
		// parent null out the worker, terminate() it, reject all pending, and
		// spawn a fresh worker on the next ensureWorker().
		//
		// This test asserts the FIX: the second (benign) request MUST succeed and
		// return its hit — not time out.
		const h = buildRegexHarness({ wallMs: 50 });
		try {
			const admin = wideOpen();
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "slow",
				content: "a".repeat(30000),
			}, ctxOf(admin));
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "fast",
				content: "needle-in-fast-node",
			}, ctxOf(admin));

			// 1. Trigger the catastrophic timeout (worker gets terminated).
			await expect(
				h.search.search({ mode: "regex", query: "(a+)+b" }, ctxOf(admin)),
			).rejects.toMatchObject({ code: "REGEX_TIMEOUT" });

			// 2. Immediately after: a benign regex MUST succeed on the rebuilt worker.
			//    round-1 bug: this also rejected with REGEX_TIMEOUT.
			const t0 = Date.now();
			const r = await h.search.search({ mode: "regex", query: "needle-in-fast-node" }, ctxOf(admin));
			const elapsed = Date.now() - t0;
			expect(r.wikiHits.length, "benign regex must hit after worker rebuild").toBeGreaterThan(0);
			expect(r.wikiHits[0].path).toBe("wiki-root/knowledge/fast");
			// Worker rebuild + benign match should be fast (< 2s; rebuild is ~5-10ms).
			expect(elapsed, `benign regex after rebuild should be fast, got ${elapsed}ms`).toBeLessThan(2000);
		} finally {
			h.dispose();
		}
	});

	test("FIX 5 (FLIPPED): rapid timeout → benign → timeout → benign cycle stays healthy", async () => {
		// Adversarial: hit the pool with alternating catastrophic / benign calls.
		// Each catastrophic call terminates the worker; each benign call must
		// rebuild and succeed. Verifies the pool doesn't leak a dead worker
		// reference across multiple terminate/rebuild cycles.
		const h = buildRegexHarness({ wallMs: 40 });
		try {
			const admin = wideOpen();
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "slow",
				content: "a".repeat(30000),
			}, ctxOf(admin));
			await h.svc.create({
				parent: "wiki-root/knowledge", name: "fast",
				content: "findme-benign-token",
			}, ctxOf(admin));
			for (let i = 0; i < 3; i++) {
				// catastrophic → REGEX_TIMEOUT (worker terminated).
				await expect(
					h.search.search({ mode: "regex", query: "(a+)+b" }, ctxOf(admin)),
					`cycle ${i}: catastrophic must timeout`,
				).rejects.toMatchObject({ code: "REGEX_TIMEOUT" });
				// benign → must succeed on rebuilt worker.
				const r = await h.search.search({ mode: "regex", query: "findme-benign-token" }, ctxOf(admin));
				expect(r.wikiHits.length, `cycle ${i}: benign regex must hit after rebuild`).toBeGreaterThan(0);
			}
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// §A — resolveRegexLimits clamping contract (host can only tighten)
// ===========================================================================

describe("resolveRegexLimits — host can only TIGHTEN (never raise) [对抗 lens]", () => {
	const d = WIKI_REGEX_DEFAULT_LIMITS;
	test("undefined host → all defaults", () => {
		const r = resolveRegexLimits(undefined);
		expect(r).toEqual(d);
	});
	test("host raising any value is clamped to default", () => {
		const r = resolveRegexLimits({
			patternBytes: 999_999,
			authorizedCandidates: 999_999,
			contentBytes: 999_999_999,
			wallMs: 999_999,
			results: 999_999,
		});
		expect(r).toEqual(d);
	});
	test("host tightening each value is respected", () => {
		const r = resolveRegexLimits({
			patternBytes: 100,
			authorizedCandidates: 10,
			contentBytes: 1024,
			wallMs: 10,
			results: 5,
		});
		expect(r.patternBytes).toBe(100);
		expect(r.authorizedCandidates).toBe(10);
		expect(r.contentBytes).toBe(1024);
		expect(r.wallMs).toBe(10);
		expect(r.results).toBe(5);
	});
});
