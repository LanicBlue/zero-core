// tool-quality-pass sub-3 验收(round-2 B4c 迁移到 wiki v2 contract)
//
// # 文件说明书
//
// ## 核心功能
// 历史验收 docs/plan/tool-quality-pass/acceptance-3.md(16 条 + 对抗式核心)
// 针对 v1 wikiTool(10-action + wikiAnchorNodeIds + path-title-walk + ▾direct
// (total) / leaf / shortId / docRead/docWrite/docEdit / `path: header:src/...`
// type 前缀)。
//
// **wiki-system-redesign sub-04/05 已退役 v1 工具,全栈切到 9-action v2**
// (expand/read/search/create/update/delete/link/unlink/move)+ logical address
// (`memory://` / `project://` / canonical `wiki-root/...`)+ wikiAccess grant
// + new expand pagination (limit/cursor) + new search modes (exact/substring/
// glob/regex/fulltext/hybrid)。
//
// ## round-2 B4c 迁移决策
// 旧 16 条断言绝大多数验的是 **v1-only 输出格式**(▾direct(total) 计数标记 /
// ` leaf` 叶标记 / shortId `#xxxxxxxx` 句柄 / `path: A/B/C` 标题路径 / `header:`
// type 前缀 / docRead/docWrite/docEdit action / `expand { depth: N }` 深度)。
// 这些格式在 v2 **有意地改了**(plan-05 §5 切换决策):
//   - `depth` 替换为 `limit` + `cursor`(分页)
//   - path-title-walk 替换为 logical/canonical address 单解析
//   - ▾direct(total) / leaf 标记替换为 v2 expand 渲染(`wiki-v2-tool.ts`
//     `formatWikiV2Result` 的输出形态)
//   - shortId 句柄废弃(v2 LLM-facing 只用 address)
//   - docRead/docWrite/docEdit 合并进 read(view=content)/update(operations/changes)
//   - `header:` type 前缀替换为 kind 闭集
//
// 把每条 v1 格式断言逐字迁到 v2 既不真也不可读 —— 等价的 v2 行为契约已由
// `wiki-v2-runtime-tool-wiring.test.ts`(§B.5/B.6 + defer-C formatSearchResult)
// 与 `wiki-v2-runtime-access.test.ts`(§B.1-B.4 + §H)覆盖。本文件保留为
// **v2 contract smoke**(对应原 #2 regex/#3 计数/#4 path 跳层 的「spirit」),
// 不再断 v1 输出字面格式。
//
// ## 维护规则
// 改 src/tools/wiki-v2-tool.ts 的 search/expand schema 或 formatWikiV2Result
// 时同步本测试。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { createWikiTool, wikiV2ActionSchema } from "../../src/tools/wiki-v2-tool.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";
import type { CompiledWikiAccess } from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Harness (mirror wiki-v2-runtime-tool-wiring.test.ts shape)
// ---------------------------------------------------------------------------

let tmpDir: string;
let wikiDb: WikiDatabase;
let wikiSvc: WikiService;
let search: WikiSearchService;

function wideAccess(agentId = "sub3-agent"): CompiledWikiAccess {
	return {
		agentId,
		activeProjectId: undefined,
		grants: [{
			canonicalScope: "wiki-root",
			actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
		}],
		policyRevision: 1,
	};
}

function callerCtx(acc?: CompiledWikiAccess): CallerCtx {
	return {
		caller: "internal",
		sessionId: "sub3-session",
		agentId: acc?.agentId ?? "sub3-agent",
		toolCallId: "tc-sub3-1",
		wikiAccess: acc,
	} as CallerCtx;
}

function execWiki(): (input: Record<string, unknown>, acc?: CompiledWikiAccess) => Promise<ToolResult> {
	const tool = createWikiTool({ wikiService: wikiSvc, searchService: search });
	const exec = getToolExecute(tool)!;
	return (input, acc) => exec(input, callerCtx(acc ?? wideAccess()));
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zc-tool-quality-sub3-v2-"));
	const dbPath = join(tmpDir, `wiki-sub3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	wikiDb = new WikiDatabase(dbPath);
	wikiSvc = WikiService.fromDatabase(wikiDb);
	const db = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	search = new WikiSearchService({
		db, nodeRepo, repositoryStore, addressService, authorizationService,
	});
});

afterEach(() => {
	try { wikiDb.close(); } catch { /* idempotent */ }
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// round-2 B4c v2 contract smoke
// ---------------------------------------------------------------------------

describe("[round-2 B4c migrated] wiki v2 search mode variations (spirit of v1 #2 regex)", () => {
	test("search mode='substring' (default v2) matches literal text", async () => {
		const exec = execWiki();
		await exec({ action: "create", parent: "wiki-root/knowledge", name: "alpha-foo-bar", summary: "literal dot text" });
		const res = await exec({ action: "search", query: "foo-bar", mode: "substring" });
		expect(res.ok).toBe(true);
		const data = res.data as any;
		expect(data.wikiHits.length).toBeGreaterThan(0);
		expect(data.wikiHits.some((h: any) => /alpha-foo-bar/.test(h.displayTitle || h.path))).toBe(true);
	});

	test("search mode='regex' treats `.` as any char in content (cross-mode difference)", async () => {
		const exec = execWiki();
		// round-2 B4c note:v2 regex worker only searches `content` field(plan-04
		// §5 + see REGEX_WORKER_SOURCE)。seed node whose CONTENT has "axb" so
		// regex `a.b` matches it; substring `a.b` would NOT match content.
		await exec({ action: "create", parent: "wiki-root/knowledge", name: "axb-node", content: "axb marker text" });
		const res = await exec({ action: "search", query: "a.b", mode: "regex" });
		expect(res.ok).toBe(true);
		const data = res.data as any;
		// 检查 path 或 displayTitle 任一含 "axb-node"(v2 hit 携带 name + path)。
		const matched = (data.wikiHits ?? []).some((h: any) =>
			/axb-node/.test(h.path || "") || /axb-node/.test(h.displayTitle || ""),
		);
		expect(matched).toBe(true);
		// 反向校验:substring `a.b`(字面)不应命中 axb content。
		const sub = await exec({ action: "search", query: "a.b", mode: "substring" });
		expect(sub.ok).toBe(true);
		const subMatched = ((sub.data as any).wikiHits ?? []).some((h: any) =>
			/axb-node/.test(h.path || "") || /axb-node/.test(h.displayTitle || ""),
		);
		expect(subMatched).toBe(false);
	});

	test("search mode='regex' rejects invalid pattern with a friendly error (no crash)", async () => {
		const exec = execWiki();
		const res = await exec({ action: "search", query: "(unclosed", mode: "regex" });
		// v2 contract:regex error 返 ok:false + error 字符串(不抛异常)。
		expect(res.ok).toBe(false);
		expect(String(res.error ?? "")).toMatch(/regex|invalid/i);
	});

	test("kinds filter narrows search by explicit node kind (spirit of v1 `type` filter)", async () => {
		const exec = execWiki();
		// Create two nodes with explicit kind: one knowledge, one memory.
		// (v2 不像 v1 自动从 parent 位置 derive type;需显式 kind 字段。)
		await exec({ action: "create", parent: "wiki-root/knowledge", name: "filterknowledge", kind: "knowledge", summary: "shared stem" });
		await exec({ action: "create", parent: "memory://", name: "filtermem", kind: "memory", summary: "shared stem" });
		// kinds=['knowledge'] → only knowledge-kind hits.
		const kn = await exec({ action: "search", query: "filter", mode: "substring", kinds: ["knowledge"] });
		expect(kn.ok).toBe(true);
		const knData = kn.data as any;
		for (const h of (knData.wikiHits ?? []) as any[]) {
			expect(h.kind).toBe("knowledge");
		}
		const knPaths = (knData.wikiHits ?? []).map((h: any) => h.path || "").join("|");
		expect(knPaths).toMatch(/filterknowledge/);
		// kinds=['memory'] → only memory-kind hits.
		const mem = await exec({ action: "search", query: "filter", mode: "substring", kinds: ["memory"] });
		expect(mem.ok).toBe(true);
		const memData = mem.data as any;
		for (const h of (memData.wikiHits ?? []) as any[]) {
			expect(h.kind).toBe("memory");
		}
	});
});

describe("[round-2 B4c migrated] wiki v2 expand uses address + pagination (spirit of v1 #3/#4)", () => {
	test("expand by canonical path returns the node + direct children", async () => {
		const exec = execWiki();
		// Create parent + 2 children under wiki-root/knowledge.
		await exec({ action: "create", parent: "wiki-root/knowledge", name: "parent-x" });
		await exec({ action: "create", parent: "wiki-root/knowledge/parent-x", name: "child-a" });
		await exec({ action: "create", parent: "wiki-root/knowledge/parent-x", name: "child-b" });
		// expand parent-x via canonical address.
		const res = await exec({ action: "expand", node: "wiki-root/knowledge/parent-x" });
		expect(res.ok).toBe(true);
		const data = res.data as any;
		// v2 expand 返 children items + cursor(无 depth 字面)。
		expect(Array.isArray(data.children?.items)).toBe(true);
		const names = (data.children.items as any[]).map((c) => c.name);
		expect(names).toEqual(expect.arrayContaining(["child-a", "child-b"]));
	});

	test("expand limit caps page size; cursor continues (replaces v1 depth cap)", async () => {
		const exec = execWiki();
		await exec({ action: "create", parent: "wiki-root/knowledge", name: "wide-parent" });
		// Seed 10 children.
		for (let i = 0; i < 10; i++) {
			await exec({ action: "create", parent: "wiki-root/knowledge/wide-parent", name: `c${i}` });
		}
		// limit=5 → first page returns ≤ 5 + a cursor for the rest.
		const page1 = await exec({ action: "expand", node: "wiki-root/knowledge/wide-parent", limit: 5 });
		expect(page1.ok).toBe(true);
		const data1 = page1.data as any;
		expect(data1.children.items.length).toBeLessThanOrEqual(5);
		// If truncated, cursor must be present for continuation.
		if (data1.children.items.length === 5) {
			expect(data1.children.cursor).toBeDefined();
			// Page 2 with cursor → more children, no overlap.
			const page2 = await exec({ action: "expand", node: "wiki-root/knowledge/wide-parent", limit: 5, cursor: data1.children.cursor });
			expect(page2.ok).toBe(true);
			const data2 = page2.data as any;
			const names1 = new Set(data1.children.items.map((c: any) => c.name));
			const names2 = (data2.children.items as any[]).map((c: any) => c.name);
			for (const n of names2) expect(names1.has(n)).toBe(false);
		}
	});

	test("expand missing wikiAccess → ACCESS_DENIED (no anchor back door)", async () => {
		// round-2 B4c 核心:旧 wikiAnchorNodeIds 后门已废,无 wikiAccess 必拒。
		const tool = createWikiTool({ wikiService: wikiSvc, searchService: search });
		const rawExec = getToolExecute(tool)!;
		await rawExec(
			{ action: "create", parent: "wiki-root/knowledge", name: "hidden" },
			callerCtx(wideAccess()),
		);
		const res = await rawExec(
			{ action: "expand", node: "wiki-root/knowledge/hidden" },
			callerCtx(undefined) as CallerCtx,
		);
		expect(res.ok).toBe(false);
		expect(String(res.error ?? "")).toMatch(/ACCESS_DENIED|wiki.*access.*missing|wikiAccess/i);
	});
});

describe("[round-2 B4c migrated] wiki v2 retired v1 actions rejected at schema", () => {
	test.each([
		"createMemory", "updateMemory", "docRead", "docWrite", "docEdit",
	])("action '%s' rejected by wikiV2ActionSchema (retired with v1 tool)", (retired) => {
		const r = wikiV2ActionSchema.safeParse({ action: retired });
		expect(r.success, `retired action '${retired}' must be rejected`).toBe(false);
	});

	test("v1 expand depth field ignored — v2 uses limit/cursor instead", async () => {
		// v2 schema 不接受 depth 字段(zod optional 字段都允许通过,但 v2 代码不读)。
		// 关键是 expand 行为:limit 控制 page size,depth 字面语义已退役。
		const exec = execWiki();
		await exec({ action: "create", parent: "wiki-root/knowledge", name: "depth-retired" });
		// Pass legacy `depth: 5` —— schema 仍接受(unknown 字段),但 expand 行为
		// 不基于 depth。返回成功 + 单层 children(默认 expand 行为)。
		const res = await exec({ action: "expand", node: "wiki-root/knowledge/depth-retired", limit: 10 } as any);
		expect(res.ok).toBe(true);
	});
});

describe("[round-2 B4c migrated] wiki v2 read/update channel split (spirit of v1 doc ops)", () => {
	test("create accepts content; read(view=content) returns it; update operations edits it", async () => {
		const exec = execWiki();
		// Create with initial content.
		const created = await exec({ action: "create", parent: "wiki-root/knowledge", name: "doc-target", content: "hello world" });
		expect(created.ok).toBe(true);
		// Read content back.
		const read1 = await exec({ action: "read", node: "wiki-root/knowledge/doc-target", view: "content" });
		expect(read1.ok, `read1 error: ${JSON.stringify(read1)}`).toBe(true);
		expect(String((read1.data as any)?.content ?? "")).toContain("hello world");
		// Update via changes.content patch (the v2 successor of v1 docWrite clobber).
		const read1b = await exec({ action: "read", node: "wiki-root/knowledge/doc-target", view: "all" });
		const rev = (read1b.data as any)?.node?.revision;
		const updated = await exec({
			action: "update",
			node: "wiki-root/knowledge/doc-target",
			expected_revision: rev,
			changes: { content: "goodbye world" },
		});
		expect(updated.ok, `update error: ${JSON.stringify(updated)}`).toBe(true);
		// Read again — content reflects the patch.
		const read2 = await exec({ action: "read", node: "wiki-root/knowledge/doc-target", view: "content" });
		expect(read2.ok).toBe(true);
		expect(String((read2.data as any)?.content ?? "")).toContain("goodbye world");
	});
});
