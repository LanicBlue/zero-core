// wiki-system-redesign sub-04 acceptance — 架构 (host injection + structural §H +
// caller inventory + prompt) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级 + 结构级编码 acceptance-04 §A「Schema 与边界」+ §H「拒绝条件」中
// **架构/host 注入**视角的条目。本 lens 关心的是"身份从哪里来"和"结构是否
// 给 LLM 留了后门",而不是规约细节:
//
//   §A/§H host injection(核心):
//     - schema 不暴露 agentId/projectId/grants/canonicalScope/cwd/overwrite
//       (zod 把未知 key strip 掉 → execute 永远看不到)。
//     - 工具读身份/grants **只**从 callerCtx.wikiAccess —— 证:input 里塞
//       mismatched agentId/projectId/grants 不扩权;callerCtx.agentId 与
//       wikiAccess.agentId 不一致时也以 wikiAccess 为准。
//     - wikiAccess 缺失 → ACCESS_DENIED,**不**退回 wikiAnchorNodeIds(也不
//       退回 callerCtx.scope)。
//     - 无 mgmt action / 无旧 doc-memory action / 无 nodeId 短 id compat 入口。
//
//   §A registry 结构:
//     - ToolRegistry 只注册旧 wikiTool(name "Wiki");createWikiTool factory
//       已 export 但未注册(无第二个 WikiV2 用户可见工具名)。
//
//   §H leak prevention:
//     - search() 在任何 DB / source 查询之前先调 prepareSearchScopes
//       (grants → canonical scopes;**不**fetch-all-then-filter)。
//     - 行为:无 search grant 的 caller 拿不到任何 secret path/snippet/count;
//       有 visible-only grant 的 caller 搜 secret 关键词返 0 命中。
//
//   §G caller inventory:覆盖旧 10 action × 迁移阶段。
//   §7 tool prompt:描述 logical address + canonical path + search→expand→read
//     + expected_revision + SOURCE_MANAGED;**不**解释内部 ID/db/anchor/旧 doc action。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + 每 test 独立 wiki.db(vi.hoisted + mkdtemp)。
//   - CallerCtx.wikiAccess 由测试 host 构造(compiled grants)。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding(在 StructuredOutput 中)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson: UNIQUE ZERO_CORE_DIR).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-tool-auth-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1"; // 绕开 Windows WAL checkpoint 卡死。
	return { UNIQUE_DIR: d };
});

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { wikiV2ActionSchema, createWikiTool } from "../../src/tools/wiki-v2-tool.js";
import {
	getToolExecute,
	getToolName,
	getToolPrompt,
} from "../../src/tools/tool-factory.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
	WikiReadResult,
	WikiSearchResult,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Access helpers (mirror proven contract-test pattern).
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

/** Build a CallerCtx carrying wikiAccess — the SOLE identity source for the tool. */
function callerCtx(acc: CompiledWikiAccess, overrides: Partial<CallerCtx> = {}): CallerCtx {
	return {
		caller: "internal",
		sessionId: "auth-test-session",
		agentId: acc.agentId,
		toolCallId: "tc-auth-1",
		wikiAccess: acc,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Service + tool host
// ---------------------------------------------------------------------------

interface ToolHost {
	execute: (input: Record<string, unknown>, acc: CompiledWikiAccess, ctxOverrides?: Partial<CallerCtx>) => Promise<ToolResult>;
	rawExecute: (input: Record<string, unknown>, ctx: CallerCtx) => Promise<ToolResult>;
	dispose: () => void;
}

function buildHost(): ToolHost {
	const dbPath = join(UNIQUE_DIR, `wiki-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const wikiSvc = WikiService.fromDatabase(wiki);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const search = new WikiSearchService({
		db, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	const tool = createWikiTool({ wikiService: wikiSvc, searchService: search });
	const rawExecute = getToolExecute(tool)!;
	return {
		rawExecute,
		execute: async (input, acc, ctxOverrides) => rawExecute(input, callerCtx(acc, ctxOverrides)),
		dispose: () => { try { wiki.close(); } catch { /* idempotent */ } },
	};
}

// ---------------------------------------------------------------------------
// zod shape helpers (robust across zod v3/v4)
// ---------------------------------------------------------------------------
function schemaShape(schema: any): Record<string, any> {
	const sh = (schema as any)._def.shape;
	return typeof sh === "function" ? sh() : sh;
}

// ===========================================================================
// §A schema — structural boundary (host-injection angle)
// ===========================================================================

describe("wiki-v2 §A/§H host-injection boundary [架构 lens]", () => {
	test("LLM-visible schema exposes NO identity / internal-id / cwd fields", () => {
		const keys = Object.keys(schemaShape(wikiV2ActionSchema));
		// These are the §A/§H banned fields: identity must be host-injected via
		// callerCtx.wikiAccess, never accepted as LLM input.
		for (const banned of [
			"agentId", "projectId", "grants", "canonicalScope", "cwd", "overwrite",
			"nodeId", "shortId", "oldTitlePath", "oldPath", "parentId", "title",
		]) {
			expect(keys, `schema must NOT expose '${banned}' to LLM`).not.toContain(banned);
		}
	});

	test("zod STRIPS unknown identity keys from parsed input (execute never sees them)", () => {
		// zod z.object default behavior strips unknown keys. An attacker (or a
		// confused LLM) cannot smuggle agentId/projectId/grants through input.
		const parsed = wikiV2ActionSchema.safeParse({
			action: "search",
			query: "x",
			// Attempt to smuggle identity — must be stripped, NOT preserved.
			agentId: "admin",
			projectId: "p-secret",
			grants: [{ canonicalScope: "wiki-root", actions: "*" }],
			canonicalScope: "wiki-root",
			cwd: "/etc",
			nodeId: "42",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			const data = parsed.data as Record<string, unknown>;
			expect(data).not.toHaveProperty("agentId");
			expect(data).not.toHaveProperty("projectId");
			expect(data).not.toHaveProperty("grants");
			expect(data).not.toHaveProperty("canonicalScope");
			expect(data).not.toHaveProperty("cwd");
			expect(data).not.toHaveProperty("nodeId");
		}
	});

	test("schema REJECTS retired doc/memory actions (no compat entry)", () => {
		for (const retired of [
			"createMemory", "updateMemory", "docRead", "docWrite", "docEdit",
		]) {
			expect(
				wikiV2ActionSchema.safeParse({ action: retired }).success,
				`retired action '${retired}' must not be accepted`,
			).toBe(false);
		}
	});

	test("schema REJECTS management actions (no admin surface in agent tool)", () => {
		for (const mgmt of [
			"address", "register", "grant", "context", "repository",
			"restore", "hardDelete", "hard_delete", "purge",
		]) {
			expect(
				wikiV2ActionSchema.safeParse({ action: mgmt }).success,
				`mgmt action '${mgmt}' must not be accepted`,
			).toBe(false);
		}
	});

	test("action enum is EXACTLY 9 (no extra admin/compat action snuck in)", () => {
		const shape = schemaShape(wikiV2ActionSchema);
		const d = shape.action._def;
		let values: string[];
		if (d.entries && typeof d.entries === "object") values = Object.keys(d.entries);
		else if (Array.isArray(d.values)) values = d.values as string[];
		else if (Array.isArray(d.options)) values = d.options as string[];
		else if (Array.isArray(shape.action.options)) values = shape.action.options as string[];
		else throw new Error("unable to read action enum values");
		expect(values.length).toBe(9);
		expect([...values].sort()).toEqual([
			"create", "delete", "expand", "link", "move",
			"read", "search", "unlink", "update",
		]);
	});
});

// ===========================================================================
// §A/§H — identity comes ONLY from callerCtx.wikiAccess (behavioral proof)
// ===========================================================================

describe("wiki-v2 §H identity source = callerCtx.wikiAccess ONLY [架构 lens]", () => {
	let h: ToolHost;
	beforeEach(() => { h = buildHost(); });
	afterEach(() => { h.dispose(); });

	test("smuggled input identity does NOT expand grants (narrow wikiAccess stays narrow)", async () => {
		const admin = wideOpen();
		// Admin builds a visible node + a SECRET node with a unique body.
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "visible",
			summary: "visible-summary", content: "visible-body",
		}, admin);
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "secret",
			summary: "SECRETKEY-unique", content: "SECRETKEY-unique body text",
		}, admin);

		// Attacker has a REAL wikiAccess that only allows search on the visible
		// subtree. They try to smuggle wider grants + admin identity through the
		// LLM input AND through callerCtx.agentId.
		const attacker = access("attacker", [
			grant("wiki-root/knowledge/visible", ["read", "expand", "search"]),
		]);
		const smuggledInput = {
			action: "search",
			query: "SECRETKEY",
			mode: "substring",
			// Smuggled identity — zod strips these; execute must not honor them.
			agentId: "admin",
			projectId: "anything",
			grants: [{ canonicalScope: "wiki-root", actions: ALL_ACTIONS }],
		} as Record<string, unknown>;

		const res = await h.rawExecute(smuggledInput, callerCtx(attacker, {
			agentId: "admin", // mismatched with wikiAccess.agentId = "attacker"
		}));
		expect(res.ok).toBe(true);
		const data = res.data as WikiSearchResult;
		// The smuggled grants had NO effect: SECRET hit count must be 0.
		expect(data.wikiHits.length).toBe(0);
		expect(data.sourceHits.length).toBe(0);
		// And nothing in the structured payload mentions the secret.
		expect(JSON.stringify(data)).not.toContain("SECRETKEY");
		expect(JSON.stringify(data)).not.toContain("secret");
	});

	test("narrow wikiAccess denies write even when callerCtx.agentId is 'admin'", async () => {
		const admin = wideOpen();
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "T1", content: "x",
		}, admin);

		// Reader-only wikiAccess. callerCtx.agentId is spoofed to "admin".
		const reader = access("reader", [grant("wiki-root/knowledge/T1", ["read"])]);
		const upd = await h.rawExecute({
			action: "update", node: "wiki-root/knowledge/T1",
			expected_revision: 1, changes: { content: "evil" },
		}, callerCtx(reader, { agentId: "admin" }));
		expect(upd.ok).toBe(false);
		// reader has scope coverage on T1 but no update action → ACCESS_DENIED.
		expect(upd.error ?? "").toMatch(/^ACCESS_DENIED:/);
	});

	test("missing wikiAccess → ACCESS_DENIED (no fallback to wikiAnchorNodeIds)", async () => {
		const admin = wideOpen();
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "F1", content: "x",
		}, admin);

		// callerCtx has wikiAnchorNodeIds + scope (legacy fields) but NO wikiAccess.
		// The new tool must NOT fall back to the anchor model — it must refuse.
		const res = await h.rawExecute(
			{ action: "read", node: "wiki-root/knowledge/F1", view: "summary" },
			{
				caller: "internal",
				sessionId: "s",
				agentId: "admin",
				wikiAnchorNodeIds: ["wiki-root/knowledge/F1"], // legacy — must be IGNORED
				scope: { projectId: "p" }, // legacy — must be IGNORED
				// wikiAccess intentionally OMITTED.
			} as CallerCtx,
		);
		expect(res.ok).toBe(false);
		expect(res.error ?? "").toMatch(/^ACCESS_DENIED:/);
	});

	test("wikiAnchorNodeIds presence does NOT rescue a missing wikiAccess (search too)", async () => {
		const admin = wideOpen();
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "G1",
			summary: "findme", content: "findme",
		}, admin);

		const res = await h.rawExecute(
			{ action: "search", query: "findme", mode: "substring" },
			{
				caller: "internal",
				sessionId: "s",
				agentId: "admin",
				wikiAnchorNodeIds: ["wiki-root"],
				// wikiAccess intentionally OMITTED.
			} as CallerCtx,
		);
		expect(res.ok).toBe(false);
		expect(res.error ?? "").toMatch(/^ACCESS_DENIED:/);
	});

	test("tool never consults ctx.agentId for grants (mismatched agent still bound by wikiAccess)", async () => {
		// Same DB; build a wikiAccess whose agentId is "real-agent" with full
		// rights. Then call with callerCtx.agentId = "someone-else" — behavior
		// must follow wikiAccess, and the call must succeed (proving identity is
		// wikiAccess.agentId, not callerCtx.agentId, and that no grant lookup
		// by callerCtx.agentId took place that would have denied "someone-else").
		const admin = wideOpen();
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "ID1", content: "x",
		}, admin);
		const real = access("real-agent", [grant("wiki-root", ALL_ACTIONS)]);
		const res = await h.rawExecute(
			{ action: "read", node: "wiki-root/knowledge/ID1", view: "summary" },
			callerCtx(real, { agentId: "someone-else" }),
		);
		expect(res.ok).toBe(true);
		expect((res.data as WikiReadResult).node.name).toBe("ID1");
	});
});

// ===========================================================================
// §A — ToolRegistry: no 2nd WikiV2 tool registered (structural audit)
// ===========================================================================

describe("wiki-v2 §A registry — no 2nd agent-visible Wiki tool name [架构 lens]", () => {
	const REPO_ROOT = resolve(__dirname, "../..");
	const TOOLS_INDEX_PATH = join(REPO_ROOT, "src/tools/index.ts");

	test("src/tools/index.ts registers the OLD wikiTool (name 'Wiki'), NOT createWikiTool", () => {
		// Structural source-audit: index.ts is the SINGLE registration site
		// (registerRuntimeTools iterates ALL_TOOLS). If createWikiTool were
		// imported + added to TOOL_DEFS here, a 2nd agent-visible tool would
		// exist (plan-04 forbids that — plan-05 does the swap atomically).
		const src = readFileSync(TOOLS_INDEX_PATH, "utf-8");
		// Old wikiTool is imported and listed.
		expect(src).toMatch(/import\s*\{[^}]*\bwikiTool\b[^}]*\}\s*from\s*["']\.\/wiki-tool\.js["']/);
		// TOOL_DEFS array references wikiTool.
		expect(src).toMatch(/\bwikiTool\b/);
		// createWikiTool / wiki-v2-tool is NOT imported and NOT referenced.
		expect(src).not.toMatch(/createWikiTool/);
		expect(src).not.toMatch(/wiki-v2-tool/);
		expect(src).not.toMatch(/wikiV2Tool/);
		// No "WikiV2" name registered.
		expect(src).not.toMatch(/["']WikiV2["']/);
	});

	test("createWikiTool factory produces a tool named EXACTLY 'Wiki' (not 'WikiV2')", () => {
		const tool = createWikiTool({
			wikiService: {} as any,
			searchService: {} as any,
		});
		const name = getToolName(tool);
		expect(name, "factory tool name must be 'Wiki' (plan-05 replaces old impl in-place)").toBe("Wiki");
	});

	test("wiki-tool.ts delegates to createWikiTool (plan-05 §5 atomic swap)", () => {
		// plan-05 §5: ToolRegistry 中 Wiki 名称仍只有 `Wiki`,指向 plan-04 的新实现。
		// sub-04 时 factory 已 export 但未注册,此断言锁定 "尚未切换" 状态;
		// sub-05 原子切换后,wiki-tool.ts 改为 createWikiTool 的注册包装 — 该断言
		// 必须更新为反映切换后的预期。
		const path = join(REPO_ROOT, "src/tools/wiki-tool.ts");
		const src = readFileSync(path, "utf-8");
		expect(src).toContain("createWikiTool");
		expect(src).toContain("wiki-v2-tool");
		// 注释里会引用历史名字(wikiActionSchema / wikiV2ActionSchema 作为退役
		// 说明),但代码里不能复活 —— 剥离注释后检查。
		const code = src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/\s*\/\/.*$/g, "");
		// Plan-05 §5 拒绝条件:不提供 WikiLegacy / WikiV2 别名(identifier 级别)。
		expect(code, "no WikiLegacy/WikiV2 identifier in live code").not.toMatch(/\bWikiLegacy\b|\bWikiV2\b/);
		// Plan-05 §5:旧 10-action schema 不得 export 复活。
		expect(code, "no revived wikiActionSchema export").not.toMatch(/export\s+const\s+wikiActionSchema/);
		// Plan-05 §8:旧 buildGlobalAnchorWikiCallerCtx 全树捷径不得复活。
		expect(code, "no revived global-anchor caller shortcut").not.toMatch(/\bbuildGlobalAnchorWikiCallerCtx\b/);
	});
});

// ===========================================================================
// §H — leak prevention: prepareSearchScopes BEFORE any query
// ===========================================================================

describe("wiki-v2 §H leak prevention — grants compiled to scopes BEFORE query [架构 lens]", () => {
	const REPO_ROOT = resolve(__dirname, "../..");
	const SEARCH_SVC_PATH = join(REPO_ROOT, "src/server/wiki/wiki-search-service.ts");

	test("search() calls prepareSearchScopes BEFORE any DB / source query (source audit)", () => {
		// Read the file in text mode (file contains 2 NUL bytes used as glob
		// sentinels — readFileSync handles them; we only need the search() region).
		const src = readFileSync(SEARCH_SVC_PATH, "utf-8");
		// Locate the search() method body.
		const searchIdx = src.indexOf("async search(");
		expect(searchIdx).toBeGreaterThan(-1);
		// Limit audit to the search() method (up to the next private method).
		const tail = src.slice(searchIdx);
		const methodBody = tail.slice(0, tail.indexOf("\n\t// ====="));
		expect(methodBody.length).toBeGreaterThan(0);

		const prepareIdx = methodBody.indexOf("prepareSearchScopes");
		expect(prepareIdx, "search() must call prepareSearchScopes").toBeGreaterThan(-1);

		// Everything that reads the DB / delegates to source must come AFTER.
		const dbQueryIdx = methodBody.indexOf("this.deps.db");
		const searchWikiIdx = methodBody.indexOf("this.searchWiki");
		const searchSourceIdx = methodBody.indexOf("this.searchSource");
		// At least one of these query paths must exist and run AFTER prepare.
		const queryIdxs = [dbQueryIdx, searchWikiIdx, searchSourceIdx].filter((i) => i > -1);
		expect(queryIdxs.length, "search() must perform at least one DB/source query").toBeGreaterThan(0);
		for (const qi of queryIdxs) {
			expect(qi, "query must come AFTER prepareSearchScopes (no fetch-all-then-filter)").toBeGreaterThan(prepareIdx);
		}
	});

	test("behavioral: caller with NO search grant gets empty result (no leak via scan)", async () => {
		const h = buildHost();
		try {
			const admin = wideOpen();
			await h.execute({
				action: "create", parent: "wiki-root/knowledge", name: "HID",
				summary: "HIDDENKEY-zz", content: "HIDDENKEY-zz body",
			}, admin);
			// Caller has expand/read on a DIFFERENT subtree but NO search grant.
			const noSearch = access("no-search", [
				grant("wiki-root/knowledge/visible", ["expand", "read"]),
			]);
			const res = await h.execute({
				action: "search", query: "HIDDENKEY", mode: "substring",
			}, noSearch);
			expect(res.ok).toBe(true);
			const data = res.data as WikiSearchResult;
			expect(data.wikiHits.length).toBe(0);
			expect(data.sourceHits.length).toBe(0);
			// No count / path / snippet leak.
			const json = JSON.stringify(data);
			expect(json).not.toContain("HIDDENKEY");
			expect(json).not.toContain("HID");
		} finally {
			h.dispose();
		}
	});

	test("behavioral: caller with search grant on visible-only subtree cannot find secret", async () => {
		const h = buildHost();
		try {
			const admin = wideOpen();
			// visible subtree (caller has search rights) + secret subtree (no rights).
			await h.execute({
				action: "create", parent: "wiki-root/knowledge", name: "visible",
			}, admin);
			await h.execute({
				action: "create", parent: "wiki-root/knowledge/visible", name: "V1",
				summary: "VISIBLEWORD here", content: "VISIBLEWORD body",
			}, admin);
			await h.execute({
				action: "create", parent: "wiki-root/knowledge", name: "vault",
			}, admin);
			await h.execute({
				action: "create", parent: "wiki-root/knowledge/vault", name: "S1",
				summary: "VAULTKEY-unique", content: "VAULTKEY-unique body",
			}, admin);

			const scoped = access("scoped", [
				grant("wiki-root/knowledge/visible", ["search", "read", "expand"]),
			]);
			// Search for the SECRET keyword across the whole tree — must NOT match
			// the vault subtree (prepareSearchScopes restricts to visible only).
			const res = await h.execute({
				action: "search", query: "VAULTKEY", mode: "substring",
			}, scoped);
			expect(res.ok).toBe(true);
			const data = res.data as WikiSearchResult;
			expect(data.wikiHits.length).toBe(0);
			expect(JSON.stringify(data)).not.toContain("VAULTKEY");
			expect(JSON.stringify(data)).not.toContain("vault");

			// Same caller CAN find the visible keyword (proves the empty result is
			// scope filtering, not a broken search).
			const visRes = await h.execute({
				action: "search", query: "VISIBLEWORD", mode: "substring",
			}, scoped);
			expect(visRes.ok).toBe(true);
			expect((visRes.data as WikiSearchResult).wikiHits.length).toBeGreaterThan(0);
		} finally {
			h.dispose();
		}
	});

	test("behavioral: requested scope cannot ESCAPE access grants (no widening)", async () => {
		const h = buildHost();
		try {
			const admin = wideOpen();
			await h.execute({
				action: "create", parent: "wiki-root/knowledge", name: "visible",
			}, admin);
			await h.execute({
				action: "create", parent: "wiki-root/knowledge/visible", name: "V",
				content: "OK-WORD",
			}, admin);
			await h.execute({
				action: "create", parent: "wiki-root/knowledge", name: "vault",
			}, admin);
			await h.execute({
				action: "create", parent: "wiki-root/knowledge/vault", name: "S",
				content: "OK-WORD and SECRET-STUFF",
			}, admin);

			const scoped = access("scoped", [
				grant("wiki-root/knowledge/visible", ["search", "read"]),
			]);
			// Caller tries to request the vault scope directly — must be ignored
			// (intersected with access → empty, since vault is not in access).
			// The shared OK-WORD token exists in BOTH subtrees; the vault hit
			// must NOT come back.
			const res = await h.execute({
				action: "search", query: "OK-WORD", mode: "substring",
				scope: "wiki-root/knowledge/vault", // attempted escape
			}, scoped);
			expect(res.ok).toBe(true);
			const data = res.data as WikiSearchResult;
			// CRITICAL leak vector: no vault NODE PATH may appear in the hits
			// (the access grant does not cover vault, so the intersected scope is
			// empty and zero vault hits are returned).
			for (const hit of data.wikiHits) {
				expect(hit.path, "vault node path must not leak via search hit").not.toContain("vault");
			}
			for (const hit of data.sourceHits) {
				expect(hit.path).not.toContain("vault");
			}
			// SECRET-STUFF is content the caller never supplied — must not appear
			// anywhere in the result (snippet, text, or otherwise).
			expect(JSON.stringify(data)).not.toContain("SECRET-STUFF");
			// NOTE: `effectiveScope` echoes the caller's REQUESTED scope string
			// (impl line: `effectiveScope: req.scope ?? null`), NOT the actually-
			// effective (access-intersected) scope. The string "vault" reappearing
			// there is the caller's own input echoed back — NOT a secret leak —
			// but the field name/doc promise the effective scope. See finding in
			// StructuredOutput (concern, not blocker).
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// round-2 FIX 2 (auth angle) — tool-level search excludes prefix-colliding
// siblings. Drives the full createWikiTool execute path (not the bare service)
// so the host-injection bridge + prepareSearchScopes + segment-aware SQL are
// all exercised together.
// ===========================================================================

describe("round-2 FIX 2 — tool-level search excludes prefix-colliding siblings [架构+对抗]", () => {
	test("tool search: caller scoped to alpha0 cannot find alpha0-secret/alpha0.visible via tool execute", async () => {
		const h = buildHost();
		try {
			const admin = wideOpen();
			// authorized scope leaf + its child.
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "alpha0", content: "auth-body" }, admin);
			await h.execute({ action: "create", parent: "wiki-root/knowledge/alpha0", name: "kid", summary: "ALPHA0-KID-TOKEN" }, admin);
			// siblings with prefix-colliding names (hyphen/dot/tilde/unicode/numeric).
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "alpha0-secret", content: "LEAK-VIA-TOOL hyphen" }, admin);
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "alpha0.visible", content: "LEAK-VIA-TOOL dot" }, admin);
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "alpha0~tilde", content: "LEAK-VIA-TOOL tilde" }, admin);
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "alpha0中文", content: "LEAK-VIA-TOOL unicode" }, admin);

			const scoped = access("scoped", [grant("wiki-root/knowledge/alpha0", ["search", "read", "expand"])]);
			const res = await h.execute({ action: "search", query: "LEAK-VIA-TOOL", mode: "substring" }, scoped);
			expect(res.ok).toBe(true);
			const data = res.data as WikiSearchResult;
			// CRITICAL: no sibling path leaks.
			const paths = data.wikiHits.map((x) => x.path);
			for (const sib of ["alpha0-secret", "alpha0.visible", "alpha0~tilde", "alpha0中文"]) {
				expect(paths, `tool search leaked sibling ${sib}`).not.toContain(`wiki-root/knowledge/${sib}`);
			}
			// And the leak token never appears in the structured payload.
			expect(JSON.stringify(data)).not.toContain("LEAK-VIA-TOOL");
			// Sanity: the caller DOES see their own child (filter is segment-aware).
			const kidRes = await h.execute({ action: "search", query: "ALPHA0-KID-TOKEN", mode: "substring" }, scoped);
			expect((kidRes.data as WikiSearchResult).wikiHits.map((x) => x.path)).toContain("wiki-root/knowledge/alpha0/kid");
		} finally {
			h.dispose();
		}
	});

	test("tool read of unauthorized prefix-colliding sibling → uniform NOT_FOUND (no existence leak)", async () => {
		// Attacker reads wiki-root/knowledge/alpha0-secret directly. They have NO
		// grant there. The tool must NOT distinguish "exists-but-unauthorized"
		// from "doesn't exist" — both return NOT_FOUND.
		const h = buildHost();
		try {
			const admin = wideOpen();
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "alpha0", content: "ok" }, admin);
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "alpha0-secret", content: "TOPSECRET-tool-auth" }, admin);
			const scoped = access("scoped", [grant("wiki-root/knowledge/alpha0", ["read"])]);
			const existRes = await h.execute({ action: "read", node: "wiki-root/knowledge/alpha0-secret", view: "summary" }, scoped);
			expect(existRes.ok).toBe(false);
			expect(existRes.error ?? "").toMatch(/^NOT_FOUND:/);
			expect(JSON.stringify(existRes)).not.toContain("TOPSECRET-tool-auth");
			// And a truly non-existing sibling looks identical.
			const noExistRes = await h.execute({ action: "read", node: "wiki-root/knowledge/alpha0-nope", view: "summary" }, scoped);
			expect(noExistRes.error ?? "").toMatch(/^NOT_FOUND:/);
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// §G — caller inventory covers all 10 old actions × migration stage
// ===========================================================================

describe("wiki-v2 §G caller inventory — 10 old actions × migration stage [架构 lens]", () => {
	const REPO_ROOT = resolve(__dirname, "../..");
	const INVENTORY_PATH = join(REPO_ROOT, "docs/plan/wiki-system-redesign/caller-inventory.md");

	test("inventory file exists and names all 10 old actions", () => {
		const src = readFileSync(INVENTORY_PATH, "utf-8");
		const oldActions = [
			"expand", "search", "create", "update", "delete",
			"createMemory", "updateMemory", "docRead", "docWrite", "docEdit",
		];
		for (const a of oldActions) {
			// Each action appears as a numbered section heading (## N. `action`).
			expect(src, `inventory must cover old action '${a}'`).toMatch(new RegExp(a));
		}
		// Sections 1..10 exist (one per old action).
		for (let i = 1; i <= 10; i++) {
			expect(src, `inventory section ${i} must exist`).toMatch(new RegExp(`## ${i}\\.\\s`));
		}
	});

	test("inventory records a migration stage for every caller row", () => {
		const src = readFileSync(INVENTORY_PATH, "utf-8");
		// Every row must carry a stage marker (Plan-04 / Plan-05 / Plan-06 / Plan-08).
		// We assert the stage vocabulary is present + that the retire stages exist.
		expect(src).toMatch(/Plan-04/);
		expect(src).toMatch(/Plan-05/);
		expect(src).toMatch(/Plan-08/);
		// Retired actions explicitly marked RETIRED.
		expect(src).toMatch(/createMemory[\s\S]*?RETIRED/);
		expect(src).toMatch(/docRead[\s\S]*?RETIRED/);
	});
});

// ===========================================================================
// §7 — tool prompt audit (LLM-visible surface)
// ===========================================================================

describe("wiki-v2 §7 tool prompt — logical/canonical address + workflow + limits [架构 lens]", () => {
	function prompt(): string {
		const tool = createWikiTool({
			wikiService: {} as any,
			searchService: {} as any,
		});
		const p = getToolPrompt(tool);
		expect(typeof p).toBe("string");
		return p ?? "";
	}

	test("prompt describes logical address (memory://, project://, runtime://) + canonical path", () => {
		const p = prompt();
		expect(p).toContain("memory://");
		expect(p).toContain("project://");
		expect(p).toContain("runtime://");
		expect(p).toContain("wiki-root/");
	});

	test("prompt recommends search → expand → read workflow", () => {
		const p = prompt();
		// All three verbs appear, and the recommended ordering is stated.
		expect(p).toMatch(/search/);
		expect(p).toMatch(/expand/);
		expect(p).toMatch(/read/);
		expect(p.toLowerCase()).toMatch(/search.*expand.*read|search to locate.*expand.*read/);
	});

	test("prompt notes update expected_revision + SOURCE_MANAGED restriction", () => {
		const p = prompt();
		expect(p).toContain("expected_revision");
		expect(p).toContain("SOURCE_MANAGED");
	});

	test("prompt does NOT explain internal ids / db / anchor / retired doc-memory actions", () => {
		const p = prompt();
		// No internal-implementation vocabulary leaks into the LLM surface.
		for (const banned of [
			"nodeId", "node_id", "parent_id", "anchor node", "anchorNodeId",
			"wikiAnchor", "createMemory", "updateMemory",
			"docRead", "docWrite", "docEdit", "wiki_nodes",
		]) {
			expect(p, `prompt must NOT mention '${banned}'`).not.toContain(banned);
		}
	});

	test("prompt does NOT advertise management/admin actions", () => {
		const p = prompt();
		// The agent surface must not tease restore / hardDelete / grant editing.
		for (const banned of ["hardDelete", "hard_delete", "restore", "register grant", "grant scope"]) {
			expect(p).not.toContain(banned);
		}
	});

	test("prompt documents host-injection of identity (LLM cannot pass identity)", () => {
		const p = prompt();
		// §7 convention line states grants are host-injected.
		expect(p).toMatch(/host-injected|cannot pass.*agentId|cannot pass.*grants/i);
	});
});
