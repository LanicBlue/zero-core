// wiki-system-redesign sub-04 acceptance — 规约 (format round-trip + payload no-leak) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-04 §B「format 输出中的每个 canonical path/address 回灌
// 对应 expand/read schema 都能解析成功」+ §A「format/payload 不含内部整数 ID」。
// 把 createWikiTool 的 execute + getToolFormat 配对驱动,断言:
//   - 每条 canonical path / 逻辑地址出现在 format 文本中时,可被 wikiV2ActionSchema
//     解析为合法 expand/read 输入(round-trip)。
//   - mutation format 含 revision + auditId;error format 以 code 前缀开头。
//   - format 文本 + payload JSON 不含 DB 内部整数 id / 合成短 id / 旧 path prefix。
//   - search/expand/read/mutation 4 种 ToolResult 形态的 format 都不抛错。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + 每 test 独立 wiki.db。
//   - CallerCtx.wikiAccess 由测试 host 构造。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation.
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-tool-format-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { join } from "node:path";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { wikiV2ActionSchema, createWikiTool, formatWikiV2Result } from "../../src/tools/wiki-v2-tool.js";
import { getToolExecute, getToolFormat } from "../../src/tools/tool-factory.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
	WikiReadResult,
	WikiMutationResult,
	WikiExpandResult,
} from "../../src/shared/wiki-types.js";
import type { WikiSearchResult } from "../../src/shared/wiki-search-types.js";

const ALL_ACTIONS: WikiAction[] = [
	"expand", "read", "search", "create", "update",
	"delete", "link", "unlink", "move",
];
function grant(scope: string, actions: WikiAction[]): CompiledWikiGrant {
	return { canonicalScope: scope, actions };
}
function wideOpen(agentId = "admin-agent"): CompiledWikiAccess {
	return { agentId, grants: [grant("wiki-root", ALL_ACTIONS)], policyRevision: 1 };
}
function callerCtx(acc: CompiledWikiAccess): CallerCtx {
	return {
		caller: "internal",
		sessionId: "format-test-session",
		agentId: acc.agentId,
		toolCallId: "tc-format-1",
		wikiAccess: acc,
	};
}

interface Host {
	execute: (input: Record<string, unknown>, acc: CompiledWikiAccess) => Promise<ToolResult>;
	format: (r: ToolResult) => string;
	dispose: () => void;
}
function buildHost(): Host {
	const dbPath = join(UNIQUE_DIR, `wiki-fmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const svc = WikiService.fromDatabase(wiki);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const search = new WikiSearchService({
		db, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	const tool = createWikiTool({ wikiService: svc, searchService: search });
	const execute = getToolExecute(tool)!;
	const format = getToolFormat(tool)!;
	return {
		execute: async (input, acc) => execute(input, callerCtx(acc)),
		format,
		dispose: () => { try { wiki.close(); } catch { /* idempotent */ } },
	};
}

/**
 * Pull every backtick-quoted canonical-path-looking token out of format text.
 * Used to assert each one round-trips through expand/read schema.
 */
function extractPathTokens(text: string): string[] {
	const out: string[] = [];
	const re = /`([a-zA-Z][a-zA-Z0-9_:/.-]*?)`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const tok = m[1];
		// Only treat tokens that look like a wiki path / logical address as paths.
		// (Skip pure numeric revision markers like `r1` or relation labels.)
		if (tok.includes("://") || tok.startsWith("wiki-root") || tok.includes("/")) {
			out.push(tok);
		}
	}
	return out;
}

describe("wiki-v2 tool format round-trip [规约 lens]", () => {
	let h: Host;
	beforeEach(() => { h = buildHost(); });
	afterEach(() => { h.dispose(); });

	test("format is a pure function over ToolResult (no execute coupling) for each shape", () => {
		// Construct synthetic ToolResults of each shape and verify format doesn't throw.
		// expand
		const expand: ToolResult = {
			ok: true,
			data: {
				path: "wiki-root/knowledge/A", summary: "s", displayTitle: "A", kind: "node",
				children: { items: [], cursor: null, hasMore: false }, auditId: null,
			} as WikiExpandResult,
		};
		expect(() => formatWikiV2Result(expand)).not.toThrow();
		// read
		const read: ToolResult = {
			ok: true,
			data: {
				path: "wiki-root/knowledge/A", auditId: null,
				node: {
					path: "wiki-root/knowledge/A", name: "A", kind: "node", summary: "s",
					revision: 1, parentPath: "wiki-root/knowledge", createdAt: "", updatedAt: "",
					archivedAt: null, attributes: {}, sourceBound: false, displayTitle: "A",
				},
				content: "hello",
			} as WikiReadResult,
		};
		expect(() => formatWikiV2Result(read)).not.toThrow();
		// search
		const search: ToolResult = {
			ok: true,
			data: {
				wikiHits: [], sourceHits: [], cursor: null, hasMore: false,
				limits: { patternBytes: 2048, authorizedCandidates: 50000, contentBytes: 16777216, wallMs: 250, results: 200 },
				target: "wiki", mode: "fulltext", effectiveScope: null, truncated: false,
			} as WikiSearchResult,
		};
		expect(() => formatWikiV2Result(search)).not.toThrow();
		// mutation
		const mut: ToolResult = {
			ok: true,
			data: { success: true, path: "wiki-root/knowledge/A", revision: 2, auditId: "aud-1", oldRevision: 1 } as WikiMutationResult,
		};
		expect(() => formatWikiV2Result(mut)).not.toThrow();
		// error
		expect(() => formatWikiV2Result({ ok: false, error: "INVALID_REQUEST: bad" })).not.toThrow();
	});

	test("expand format: every path token round-trips through expand/read schema", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "A" }, admin);
		await h.execute({ action: "create", parent: "wiki-root/knowledge/A", name: "child1", summary: "c1" }, admin);
		const res = await h.execute({ action: "expand", node: "wiki-root/knowledge/A" }, admin);
		const text = h.format(res);
		const tokens = extractPathTokens(text);
		expect(tokens.length).toBeGreaterThan(0);
		// Each token must parse as a valid expand/read `node` input.
		for (const tok of tokens) {
			const parsed = wikiV2ActionSchema.safeParse({ action: "expand", node: tok });
			expect(parsed.success, `expand path '${tok}' should round-trip; text was:\n${text}`).toBe(true);
			const parsedRead = wikiV2ActionSchema.safeParse({ action: "read", node: tok });
			expect(parsedRead.success, `read path '${tok}' should round-trip`).toBe(true);
		}
	});

	test("read format: canonical path in output round-trips; section/line markers not mistaken for paths", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "R", content: "# H\nbody" }, admin);
		const res = await h.execute({ action: "read", node: "wiki-root/knowledge/R", view: "all" }, admin);
		const text = h.format(res);
		expect(text).toContain("wiki-root/knowledge/R");
		// node path round-trips.
		const tokens = extractPathTokens(text).filter((t) => t.startsWith("wiki-root"));
		for (const tok of tokens) {
			const parsed = wikiV2ActionSchema.safeParse({ action: "read", node: tok });
			expect(parsed.success, `read path '${tok}' should round-trip; text:\n${text}`).toBe(true);
		}
	});

	test("search format: every wiki-hit path round-trips through read schema", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "searchable", summary: "alpha keyword" }, admin);
		const res = await h.execute({ action: "search", query: "alpha", mode: "substring" }, admin);
		const text = h.format(res);
		const tokens = extractPathTokens(text).filter((t) => t.startsWith("wiki-root"));
		expect(tokens.length).toBeGreaterThan(0);
		for (const tok of tokens) {
			const parsed = wikiV2ActionSchema.safeParse({ action: "read", node: tok });
			expect(parsed.success, `search hit path '${tok}' should round-trip; text:\n${text}`).toBe(true);
		}
	});

	test("mutation format: includes revision + audit receipt; error format begins with code", async () => {
		const admin = wideOpen();
		const created = await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "MF", content: "x" }, admin);
		const text = h.format(created);
		expect(text).toMatch(/revision/i);
		expect(text).toMatch(/audit/i);
		// error
		const err = await h.execute({ action: "read", node: "wiki-root/knowledge/MISSING", view: "summary" }, admin);
		const errText = h.format(err);
		expect(errText).toMatch(/^NOT_FOUND:/);
	});

	test("format text + structured payload contain NO internal integer id / short id / old path prefix", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "NL", content: "no leak" }, admin);
		const read = await h.execute({ action: "read", node: "wiki-root/knowledge/NL", view: "all" }, admin);
		const text = h.format(read);
		const json = JSON.stringify(read.data);
		// No raw integer id, no nodeId, no parent_id, no synthetic short id.
		for (const banned of ['"id"', '"nodeId"', '"parent_id"', '"source_id"', '"target_id"', '"shortId"']) {
			expect(json, `payload must not leak ${banned}`).not.toContain(banned);
		}
		// format text shouldn't leak internal id labels either.
		expect(text).not.toMatch(/\bnodeId\b/);
		expect(text).not.toMatch(/\bparent_id\b/);
	});

	test("format error result preserves opaque error string (UI/agent both see the code prefix)", async () => {
		const admin = wideOpen();
		const err = await h.execute({ action: "expand", node: "wiki-root/knowledge/NOPEN", limit: 5 }, admin);
		expect(err.ok).toBe(false);
		// Both the structured `error` and the formatted text start with the code.
		expect(err.error ?? "").toMatch(/^NOT_FOUND:/);
		expect(h.format(err)).toMatch(/^NOT_FOUND:/);
	});

	test("round-2 FIX 1 — WRITE_CONFLICT / NOT_FOUND format text carries NO integer id", async () => {
		// Adversarial: the formatted error string seen by the LLM must not leak
		// any `id=N` pattern. Covers both stale-revision (WRITE_CONFLICT) and
		// missing-node (NOT_FOUND) paths through the tool.
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "FMTWC", content: "v0" }, admin);
		const staleRes = await h.execute({ action: "read", node: "wiki-root/knowledge/FMTWC", view: "summary" }, admin);
		const observed = (staleRes.data as WikiReadResult).node.revision;
		await h.execute({
			action: "update", node: "wiki-root/knowledge/FMTWC",
			expected_revision: observed, changes: { content: "v1" },
		}, admin);
		// Stale → WRITE_CONFLICT.
		const conflict = await h.execute({
			action: "update", node: "wiki-root/knowledge/FMTWC",
			expected_revision: observed, changes: { content: "v2" },
		}, admin);
		expect(conflict.ok).toBe(false);
		const conflictText = h.format(conflict);
		expect(conflictText).toMatch(/^WRITE_CONFLICT:/);
		expect(conflictText, `format leaked integer id: "${conflictText}"`).not.toMatch(/\bid\s*=\s*\d+/i);
		expect(conflictText).not.toMatch(/\bnode\s+id\s*=\s*\d+/i);
		// Missing → NOT_FOUND.
		const missing = await h.execute({
			action: "read", node: "wiki-root/knowledge/no-such-node", view: "summary",
		}, admin);
		expect(missing.ok).toBe(false);
		const missingText = h.format(missing);
		expect(missingText).toMatch(/^NOT_FOUND:/);
		expect(missingText, `format leaked integer id: "${missingText}"`).not.toMatch(/\bid\s*=\s*\d+/i);
	});
});
